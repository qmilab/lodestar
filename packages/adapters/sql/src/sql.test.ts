import { describe, expect, test } from "bun:test"
import { assertPostgresUrl } from "./connection.js"
import { applyRedactions, connectionRedactions, redactionVariants } from "./redact.js"
import {
  assertReadOnly,
  assertSingleStatement,
  isCursorable,
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

  test("a digit-leading $1$ is a parameter, NOT a dollar-quote, so an inner ; separates", () => {
    // Postgres lexes `$1` as a positional parameter, not a dollar-quote opener, so
    // the ; between the two $1$ tokens is a real statement separator. The scanner
    // must agree with Postgres here or it would skip a real ;.
    expect(isMultiStatement("select $1$ ; drop table t $1$")).toBe(true)
    // a genuine (letter-led) dollar-quote still hides its inner ;
    expect(isMultiStatement("select $tag$ a; b $tag$ from t")).toBe(false)
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

describe("statement: cursorability (#101 bounded fetch routing)", () => {
  test("SELECT-family statements are cursorable", () => {
    // The SELECT/WITH-SELECT/VALUES/TABLE statements Postgres can DECLARE a cursor
    // over — the large-result reads whose fetch must be bounded.
    expect(isCursorable("select * from huge")).toBe(true)
    expect(isCursorable("  WITH x as (select 1) select * from x")).toBe(true)
    expect(isCursorable("values (1), (2)")).toBe(true)
    expect(isCursorable("table huge")).toBe(true)
    // comment/whitespace-tolerant via stripLeadingNoise
    expect(isCursorable("/* hi */\n select 1")).toBe(true)
  })

  test("EXPLAIN/SHOW are read-only but NOT cursorable (take the direct path)", () => {
    expect(isCursorable("explain select 1")).toBe(false)
    expect(isCursorable("show statement_timeout")).toBe(false)
  })

  test("a write keyword is not cursorable (it never reaches the read path anyway)", () => {
    expect(isCursorable("delete from t")).toBe(false)
    expect(isCursorable("update t set a = 1")).toBe(false)
  })
})

describe("connection: non-Postgres scheme guard (#101 ride-along)", () => {
  test("accepts the Postgres URL schemes", () => {
    expect(() => assertPostgresUrl("postgres://u:p@h:5432/d")).not.toThrow()
    expect(() => assertPostgresUrl("postgresql://u:p@h/d")).not.toThrow()
    // case-insensitive
    expect(() => assertPostgresUrl("POSTGRES://u:p@h/d")).not.toThrow()
  })

  test("rejects a non-Postgres scheme with a clear, credential-free message", () => {
    expect(() => assertPostgresUrl("mysql://u:p@h/d")).toThrow(/only Postgres/)
    expect(() => assertPostgresUrl("sqlite:///tmp/x.db")).toThrow(/only Postgres/)
    // the message names the offending scheme but NEVER the password
    try {
      assertPostgresUrl("mysql://app:s3cr3t-pw@db.example.com/appdb")
      throw new Error("expected assertPostgresUrl to throw")
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain("mysql")
      expect(msg).not.toContain("s3cr3t-pw")
    }
  })

  test("a schemeless libpq key=value DSN is left to the driver (best-effort)", () => {
    // No `scheme://` to inspect — must not be rejected by the scheme guard.
    expect(() => assertPostgresUrl("host=localhost dbname=app user=app password=x")).not.toThrow()
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

  test("extracts the password from a libpq key=value DSN", () => {
    expect(connectionRedactions("host=localhost dbname=app user=app password=hunter2")).toContain(
      "hunter2",
    )
    // a single-quoted value (may contain spaces / escaped quotes)
    expect(connectionRedactions("host=h password='se cret' dbname=d")).toContain("se cret")
    expect(connectionRedactions("host=h password='a\\'b' dbname=d")).toContain("a'b")
  })

  test("extracts a password carried in a URL query string", () => {
    // libpq accepts `?password=…` in a URI; URL.password (userinfo) is empty here.
    expect(connectionRedactions("postgres://app@db.example.com/appdb?password=qs3cret")).toContain(
      "qs3cret",
    )
  })

  test("a connection string with no recoverable password yields no redactions", () => {
    expect(connectionRedactions("host=localhost dbname=app user=app")).toEqual([])
    expect(connectionRedactions("postgres://app@db.example.com/appdb")).toEqual([])
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
