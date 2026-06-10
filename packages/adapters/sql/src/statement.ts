/**
 * Statement guards for the SQL adapter — the *lexical* layer of the
 * injection boundary.
 *
 * The load-bearing injection defence is structural, in `tools.ts`: values are
 * ALWAYS passed as bound parameters (`sql.unsafe(statement, params)` → the
 * extended/prepared protocol), never string-concatenated into the SQL text, and
 * `sql.query` runs inside a `READ ONLY` transaction so even a data-modifying CTE
 * is rejected by the database itself. These guards are the fast-fail layer on top:
 * they reject obvious multi-statement stacking and (for the read tool) obvious
 * writes with a clear error BEFORE the statement reaches the driver, and they make
 * the read/mutation split legible.
 *
 * Honest scope: this is a lightweight scanner, not a full SQL parser. It exists to
 * give clear errors and a second line of defence; correctness of the boundary does
 * not rest on it.
 */

/**
 * Strip leading whitespace and SQL comments (`-- line` and `/* block *​/`, the
 * latter nestable in Postgres) so the read-only check sees the first real keyword
 * even when the statement opens with a comment.
 */
export function stripLeadingNoise(sql: string): string {
  let i = 0
  const n = sql.length
  for (;;) {
    // whitespace
    while (i < n && /\s/.test(sql[i] as string)) i++
    if (i + 1 < n && sql[i] === "-" && sql[i + 1] === "-") {
      i += 2
      while (i < n && sql[i] !== "\n") i++
      continue
    }
    if (i + 1 < n && sql[i] === "/" && sql[i + 1] === "*") {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (i + 1 < n && sql[i] === "/" && sql[i + 1] === "*") {
          depth++
          i += 2
        } else if (i + 1 < n && sql[i] === "*" && sql[i + 1] === "/") {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    break
  }
  return sql.slice(i)
}

/**
 * Does this string contain more than one SQL statement? Scans for a `;` that sits
 * outside string literals, quoted identifiers, dollar-quoted blocks, and comments,
 * and is followed by further non-comment, non-whitespace content. A single
 * trailing `;` is allowed.
 *
 * Handles the lexical contexts a `;` could hide in: single-quoted strings (with
 * `''` escaping), double-quoted identifiers (with `""` escaping), dollar-quoted
 * blocks (`$tag$ … $tag$`), line comments, and block comments.
 */
export function isMultiStatement(sql: string): boolean {
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i] as string
    // line comment
    if (c === "-" && sql[i + 1] === "-") {
      i += 2
      while (i < n && sql[i] !== "\n") i++
      continue
    }
    // block comment (nestable)
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++
          i += 2
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }
    // single-quoted string literal
    if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2
        } else if (sql[i] === "'") {
          i++
          break
        } else {
          i++
        }
      }
      continue
    }
    // double-quoted identifier
    if (c === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2
        } else if (sql[i] === '"') {
          i++
          break
        } else {
          i++
        }
      }
      continue
    }
    // dollar-quoted block: $tag$ … $tag$ (tag may be empty: $$ … $$)
    if (c === "$") {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const end = sql.indexOf(tag, i + tag.length)
        i = end === -1 ? n : end + tag.length
        continue
      }
    }
    if (c === ";") {
      // anything other than trailing whitespace/comments after this `;` means
      // a second statement.
      const rest = stripLeadingNoise(sql.slice(i + 1))
      return rest.length > 0
    }
    i++
  }
  return false
}

/** Throw if the statement is empty (after stripping noise) or contains more than
 * one statement. */
export function assertSingleStatement(sql: string, tool: string): void {
  if (stripLeadingNoise(sql).length === 0) {
    throw new Error(`${tool}: empty statement`)
  }
  if (isMultiStatement(sql)) {
    throw new Error(
      `${tool}: multiple statements are not allowed — submit exactly one statement with $1..$N placeholders`,
    )
  }
}

const READ_ONLY_LEADING = /^(select|with|table|values|explain|show)\b/i

/**
 * Throw unless the statement leads with a read-only keyword. The DEFINITIVE
 * read-only enforcement is the `READ ONLY` transaction in `tools.ts` (which
 * rejects a data-modifying CTE the database executes), but rejecting an obvious
 * write here gives the agent a clear, early error and keeps the L1 read tool's
 * contract honest. `EXPLAIN`/`SHOW` are read-only introspection; `EXPLAIN
 * ANALYZE` of a writing statement is still caught by the read-only transaction.
 */
export function assertReadOnly(sql: string, tool: string): void {
  const head = stripLeadingNoise(sql)
  if (!READ_ONLY_LEADING.test(head)) {
    const keyword = /^\S+/.exec(head)?.[0] ?? "(empty)"
    throw new Error(
      `${tool}: only read-only statements (SELECT/WITH/TABLE/VALUES/EXPLAIN/SHOW) are allowed here — use sql.execute for a mutation (got '${keyword.slice(0, 16)}')`,
    )
  }
}
