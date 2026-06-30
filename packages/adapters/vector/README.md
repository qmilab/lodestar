# @qmilab/lodestar-adapter-vector

Governed **Vector/RAG retrieval** for the [Lodestar](https://qmilab.com/lodestar)
Action Kernel. Part of Lodestar, the trust layer for AI agents.

A similarity search over a vector index is the dominant agent-memory pattern — and
a **poisoning surface**: the chunks it returns are arbitrary stored text an attacker
may have written into the index, and a crafted query can surface them on demand.
This adapter makes a retrieval governed: the chunks are recorded faithfully as
UNTRUSTED `external_document` content, so the Memory Firewall's auto-observation
gate keeps a retrieved chunk from ever auto-promoting to a trusted (`supported`)
belief.

> A **TS-level governance boundary, not database containment.** The query reaches a
> real pgvector index by design; database-side privileges (a least-privileged role)
> are the operator's defence in depth.

## Tool

| Tool | Trust | What it does |
|------|-------|--------------|
| `vector.query` | **L1** | Retrieve the nearest chunks to a query embedding from a pinned pgvector index. The chunks are untrusted `external_document` content. |

## What it enforces

- **Retrieved chunks cannot auto-promote a belief.** Paired with the
  `VectorAwareEvidenceLinker` (in `@qmilab/lodestar-cognitive-core`), each chunk is
  stamped `external_document`, so the firewall's Round 5 auto-observation gate keeps
  it `unverified` — even at promote-grade aggregate strength and even when several
  chunks corroborate. The record *that a query ran* may promote; the chunk text may
  not.
- **Pinned index + namespace.** The table, columns, and queryable namespaces are
  operator config — never agent input. The agent supplies only a query embedding and
  may pick only from the operator's namespace allowlist.
- **Parameterized values.** The embedding, the namespace, and the `LIMIT` are always
  bound; only validated, double-quoted operator identifiers are interpolated.
- **Top-k cap, bounded server-side.** `LIMIT` bounds the fetch in the database, so a
  huge index cannot inflate an observation or balloon host memory.
- **Read-only, scoped credentials.** A `READ ONLY` transaction with a
  `statement_timeout`; the connection password is operator config and redacted from
  any caught error.

## Usage

```ts
import { registerVectorTools } from "@qmilab/lodestar-adapter-vector"
import {
  registerVectorRetrievalExtractor,
  VectorAwareEvidenceLinker,
} from "@qmilab/lodestar-cognitive-core"

// 1. Register the retrieval tool over an operator-pinned pgvector index.
const adapter = registerVectorTools({
  connection: { url: process.env.VECTOR_DATABASE_URL! }, // operator config; never agent input
  query: {
    table: "kb_embeddings",
    embeddingColumn: "embedding",
    idColumn: "id",
    contentColumn: "content",
    namespaceColumn: "namespace",
    namespaces: ["docs", "wiki"], // the queryable allowlist
    metric: "cosine",
    dimensions: 1536,
    maxTopK: 8,
  },
})

// 2. Register the matching extractor and wire the linker via guard.wrap()'s
//    cognitive seam so retrieved chunks stay external_document.
registerVectorRetrievalExtractor()
// guard.wrap({ cognitive: { evidenceLinkerFactory: ({ evidence, beliefs, claims }) =>
//   new VectorAwareEvidenceLinker(evidence, beliefs, claims) } })

// The consumer embeds the query (Lodestar ships no embedding model) and calls
// vector.query through the Action Kernel with { embedding, namespace, top_k }.
await adapter.close() // when done — the adapter owns its pooled connection
```

The agent never embeds the query, names the index, or supplies a connection string:
it passes a pre-computed embedding and an allowlisted namespace, and gets back
governed, gate-respecting evidence.

## License

Apache-2.0
