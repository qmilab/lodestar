import { describe, expect, test } from "bun:test"
import { applyRedactions, connectionRedactions, redactionVariants } from "./redact.js"
import {
  assertReadOnly,
  assertSingleStatement,
  isMultiStatement,
  stripLeadingNoise,
} from "./statement.js"

// These are the pure, DB-free layers of the adapter (the lexical statement guards
// and the credential redaction). The structural injection boundary — bound
// parameters + the READ ONLY transaction — needs a real database and is exercised
// by the `sql-adapter-enforces-invariants` probe.

describe("statement: single-statement guard", () => {
  test("accepts a single statement (with or without a trailing semicolon)", () => {
    expect(isMultiStatement("select * from t where id = $1")).toBe(false)
    expect(isMultiStatement("select * from t;")).toBe(false)
    expect(isMultiStatement("select * from t;   ")).toBe(false)
    expect(() => assertSingleStatement("select 1", "sql.query")).not.toThrow()
  })

  test("rejects stacked statements", () => {
    expect(isMultiStatement("select 1; drop table students")).toBe(true)
    expect(isMultiStatement("delete from t; delete from u")).toBe(true)
    expect(() => assertSingleStatement("select 1; drop table students", "sql.query")).toThrow(
      /multiple statements/,
    )
  })

  test("a semicolon inside a string literal is not a statement separator", () => {
    expect(isMultiStatement("select * from t where name = 'a; b'")).toBe(false)
    expect(isMultiStatement("insert into t (s) values ('drop; truncate')")).toBe(false)
  })

  test("a semicolon inside a dollar-quoted block is not a separator", () => {
    expect(isMultiStatement("select $$a; b; c$$")).toBe(false)
    expect(isMultiStatement("select $tag$ x; y $tag$ from t")).toBe(false)
  })

  test("a semicolon inside a comment is not a separator", () => {
    expect(isMultiStatement("select 1 -- ; drop table t\n")).toBe(false)
    expect(isMultiStatement("select 1 /* ; drop */ from t")).toBe(false)
  })

  test("rejects an empty statement", () => {
    expect(() => assertSingleStatement("   ", "sql.query")).toThrow(/empty statement/)
    expect(() => assertSingleStatement("-- just a comment\n", "sql.query")).toThrow(
      /empty statement/,
    )
  })
})

describe("statement: read-only guard", () => {
  test("accepts read-only leading keywords (after comments/whitespace)", () => {
    expect(() => assertReadOnly("select * from t", "sql.query")).not.toThrow()
    expect(() =>
      assertReadOnly("  WITH x as (select 1) select * from x", "sql.query"),
    ).not.toThrow()
    expect(() => assertReadOnly("/* hi */ select 1", "sql.query")).not.toThrow()
    expect(() => assertReadOnly("explain select 1", "sql.query")).not.toThrow()
  })

  test("rejects an obvious write through the read tool", () => {
    expect(() => assertReadOnly("delete from t where id = $1", "sql.query")).toThrow(/read-only/)
    expect(() => assertReadOnly("insert into t (a) values ($1)", "sql.query")).toThrow(/read-only/)
    expect(() => assertReadOnly("update t set a = $1", "sql.query")).toThrow(/read-only/)
    expect(() => assertReadOnly("drop table t", "sql.query")).toThrow(/read-only/)
  })

  test("stripLeadingNoise removes leading comments and whitespace", () => {
    expect(stripLeadingNoise("  -- c\n  /* b */ select 1")).toBe("select 1")
  })
})

describe("redact: connection password", () => {
  test("extracts and redacts the password from a connection string", () => {
    const url = "postgres://app:s3cr3t-pw@db.example.com:5432/appdb"
    const reds = connectionRedactions(url)
    expect(reds).toContain("s3cr3t-pw")
    const echoed = `connection failed for url ${url}`
    const scrubbed = applyRedactions(echoed, reds)
    expect(scrubbed).not.toContain("s3cr3t-pw")
    expect(scrubbed).toContain("***")
  })

  test("redacts a percent-encoded password in either escape case", () => {
    // password "p@ss/word" → encodeURIComponent → "p%40ss%2Fword"
    const url = "postgres://u:p%40ss%2Fword@h/d"
    const reds = connectionRedactions(url)
    // the raw (decoded) value redacts
    expect(applyRedactions("p@ss/word leaked", reds)).not.toContain("p@ss/word")
    // a lowercase-escape re-encoding redacts too
    expect(applyRedactions("saw p%40ss%2fword in a log", reds)).not.toContain("p%40ss%2fword")
  })

  test("a non-URL DSN yields no redactions (operator passes explicit ones)", () => {
    expect(connectionRedactions("host=localhost dbname=app user=app password=secret")).toEqual([])
  })

  test("applyRedactions is longest-first so a shorter secret cannot leave a remainder", () => {
    const out = applyRedactions("token=abcdef and abc", ["abc", "abcdef"])
    expect(out).toBe("token=*** and ***")
  })

  test("redactionVariants includes the raw and URL-encoded forms", () => {
    const v = redactionVariants("a/b c")
    expect(v).toContain("a/b c")
    expect(v).toContain(encodeURIComponent("a/b c"))
  })
})
