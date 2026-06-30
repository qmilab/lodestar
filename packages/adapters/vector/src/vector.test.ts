import { describe, expect, test } from "bun:test"
import { SqlConnection } from "@qmilab/lodestar-adapter-sql"
import type { SQL } from "bun"
import { type VectorQueryToolOptions, makeVectorQueryTool } from "./tools.js"

/**
 * Unit tests for the DB-free layers of the vector adapter: build-time identifier
 * validation, the pre-query guards (dimension / namespace pinning), and the
 * parameterized query construction + result shaping. The structural boundary
 * (real pgvector similarity, the READ ONLY transaction) needs a database and is
 * the `vector-adapter-enforces-invariants` probe's job.
 */

/** A fake `Bun.SQL` handle: `begin(mode, fn)` runs the callback against a tx
 * whose `unsafe` records the real query (ignoring the `set local` preamble) and
 * returns the configured rows. Lets us assert the generated SQL + bound params
 * without a database. */
function fakeHandle(rows: Array<Record<string, unknown>>): {
  handle: SQL
  captured: () => { statement: string; params: unknown[] }
} {
  let statement = ""
  let params: unknown[] = []
  const tx = {
    unsafe(query: string, p?: unknown[]) {
      if (/^\s*set\s+local/i.test(query)) return Promise.resolve([])
      statement = query
      params = p ?? []
      return Promise.resolve(rows)
    },
  }
  const handle = {
    begin(_mode: string, fn: (tx: unknown) => unknown) {
      return Promise.resolve(fn(tx))
    },
  }
  return {
    handle: handle as unknown as SQL,
    captured: () => ({ statement, params }),
  }
}

function connFor(handle: SQL): SqlConnection {
  return new SqlConnection({ sql: handle })
}

/** A SqlConnection whose handle would never open — used for guard tests that
 * throw BEFORE `conn.handle()` is reached. */
function deadConn(): SqlConnection {
  return new SqlConnection({ url: "postgres://u:p@127.0.0.1:1/none" })
}

const baseOpts = (over: Partial<VectorQueryToolOptions>): VectorQueryToolOptions => ({
  connection: deadConn(),
  table: "embeddings",
  dimensions: 3,
  ...over,
})

describe("identifier validation (build time)", () => {
  test("rejects an injection-shaped table name", () => {
    expect(() => makeVectorQueryTool(baseOpts({ table: "embeddings; drop table x" }))).toThrow(
      /not a valid SQL identifier/,
    )
  })

  test("rejects a column with a quote", () => {
    expect(() => makeVectorQueryTool(baseOpts({ contentColumn: 'content"' }))).toThrow(
      /not a valid SQL identifier/,
    )
  })

  test("rejects a triple-qualified identifier", () => {
    expect(() => makeVectorQueryTool(baseOpts({ table: "a.b.c" }))).toThrow(/too many qualifiers/)
  })

  test("accepts a schema-qualified table", () => {
    expect(() => makeVectorQueryTool(baseOpts({ table: "public.embeddings" }))).not.toThrow()
  })

  test("rejects a namespaceColumn without a namespace allowlist", () => {
    expect(() => makeVectorQueryTool(baseOpts({ namespaceColumn: "ns", namespaces: [] }))).toThrow(
      /allowlist.*empty/,
    )
  })

  test("rejects a namespace allowlist without a namespaceColumn (no silent widening)", () => {
    // An allowlist with no column to filter on would be SILENTLY IGNORED — a
    // query that omits `namespace` would search the whole index. Fail closed.
    expect(() => makeVectorQueryTool(baseOpts({ namespaces: ["docs"] }))).toThrow(
      /no `namespaceColumn`/,
    )
  })
})

describe("pre-query guards", () => {
  test("rejects a wrong-dimension embedding", async () => {
    const tool = makeVectorQueryTool(baseOpts({ dimensions: 4 }))
    await expect(tool.execute({ embedding: [1, 2, 3] }, {} as never)).rejects.toThrow(
      /3 dimensions, index expects 4/,
    )
  })

  test("rejects an un-allowlisted namespace", async () => {
    const tool = makeVectorQueryTool(
      baseOpts({ namespaceColumn: "ns", namespaces: ["docs", "wiki"] }),
    )
    await expect(
      tool.execute({ embedding: [1, 2, 3], namespace: "secrets" }, {} as never),
    ).rejects.toThrow(/namespace 'secrets' is not allowlisted/)
  })

  test("requires a namespace when the index is namespaced with several", async () => {
    const tool = makeVectorQueryTool(baseOpts({ namespaceColumn: "ns", namespaces: ["a", "b"] }))
    await expect(tool.execute({ embedding: [1, 2, 3] }, {} as never)).rejects.toThrow(
      /this index is namespaced/,
    )
  })

  test("rejects a namespace on an un-namespaced index", async () => {
    const tool = makeVectorQueryTool(baseOpts({}))
    await expect(
      tool.execute({ embedding: [1, 2, 3], namespace: "x" }, {} as never),
    ).rejects.toThrow(/not namespaced/)
  })
})

describe("parameterized query construction", () => {
  test("binds the embedding, namespace, and limit; interpolates only quoted identifiers", async () => {
    const fake = fakeHandle([
      { id: "c1", content: "hello", distance: 0.1 },
      { id: "c2", content: "world", distance: 0.2 },
    ])
    const tool = makeVectorQueryTool({
      connection: connFor(fake.handle),
      table: "public.embeddings",
      embeddingColumn: "vec",
      idColumn: "chunk_id",
      contentColumn: "body",
      namespaceColumn: "ns",
      namespaces: ["docs"],
      metric: "cosine",
      dimensions: 3,
      defaultTopK: 5,
    })
    const out = await tool.execute({ embedding: [1, 2, 3], namespace: "docs" }, {} as never)
    const { statement, params } = fake.captured()

    // Values are bound, not concatenated.
    expect(params[0]).toBe("[1,2,3]")
    expect(params[1]).toBe("docs")
    expect(params[2]).toBe(6) // top_k (5) + 1
    expect(statement).toContain("$1::vector")
    expect(statement).toContain('"ns" = $2')
    expect(statement).toContain("limit $3")
    // The cosine operator and the quoted operator identifiers are present.
    expect(statement).toContain("<=>")
    expect(statement).toContain('"public"."embeddings"')
    expect(statement).toContain('"vec"')
    // The raw embedding never appears un-bound in the SQL text.
    expect(statement).not.toContain("[1,2,3]")

    expect(out.namespace).toBe("docs")
    expect(out.metric).toBe("cosine")
    expect(out.match_count).toBe(2)
    expect(out.truncated).toBe(false)
    expect(out.matches.map((m) => m.id)).toEqual(["c1", "c2"])
  })

  test("flags truncated and trims to the cap when more than top_k rows return", async () => {
    const fake = fakeHandle([
      { id: "a", content: "1", distance: 0.1 },
      { id: "b", content: "2", distance: 0.2 },
      { id: "c", content: "3", distance: 0.3 },
    ])
    const tool = makeVectorQueryTool({
      connection: connFor(fake.handle),
      table: "embeddings",
      dimensions: 3,
      maxTopK: 2,
    })
    const out = await tool.execute({ embedding: [0, 0, 1], top_k: 2 }, {} as never)
    const { params } = fake.captured()
    expect(params[1]).toBe(3) // top_k (2) + 1 — fetch one past the cap
    expect(out.truncated).toBe(true)
    expect(out.match_count).toBe(2)
  })

  test("surfaces configured metadata columns per chunk", async () => {
    const fake = fakeHandle([{ id: "c1", content: "hi", distance: 0.1, source: "a.md", page: 3 }])
    const tool = makeVectorQueryTool({
      connection: connFor(fake.handle),
      table: "embeddings",
      metadataColumns: ["source", "page"],
      dimensions: 3,
    })
    const out = await tool.execute({ embedding: [1, 0, 0] }, {} as never)
    const { statement } = fake.captured()
    expect(statement).toContain('"source"')
    expect(statement).toContain('"page"')
    expect(out.matches[0]?.metadata).toEqual({ source: "a.md", page: 3 })
  })
})
