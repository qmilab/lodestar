import type { SQL } from "bun"

/**
 * Schema (DDL) for the Postgres-backed claim / belief / evidence stores.
 *
 * Storage model: each row keeps the full Zod-validated object as `data jsonb`
 * (the source of truth, re-parsed through its schema on read) plus mirrored
 * scalar columns for exactly the fields the `*Filter` types query. Mirrored
 * columns and `data` are written together and kept in sync inside the same
 * statement / transaction, so the indexed columns never drift from the object.
 *
 * The tables are intentionally additive: they implement the existing
 * `ClaimStore` / `BeliefStore` / `EvidenceStore` interfaces unchanged, so the
 * firewall, retrieval, and sentinels do not know whether they are talking to
 * the in-memory or the Postgres backend.
 */

/**
 * Fixed table names. Not configurable in v0 — multi-tenant / per-pack
 * namespacing is a later concern (see roadmap, "multi-tenant scoping").
 */
export const TABLES = {
  claims: "lodestar_claims",
  claimTransitions: "lodestar_claim_transitions",
  beliefs: "lodestar_beliefs",
  beliefTransitions: "lodestar_belief_transitions",
  evidenceSets: "lodestar_evidence_sets",
} as const

const DDL = `
create table if not exists ${TABLES.claims} (
  id text primary key,
  status text not null,
  scope_level text not null,
  scope_identifier text not null,
  extracted_by text not null,
  created_at timestamptz not null,
  data jsonb not null
);
create index if not exists ${TABLES.claims}_status_idx on ${TABLES.claims} (status);
create index if not exists ${TABLES.claims}_scope_idx on ${TABLES.claims} (scope_level, scope_identifier);
create index if not exists ${TABLES.claims}_extracted_by_idx on ${TABLES.claims} (extracted_by);

create table if not exists ${TABLES.claimTransitions} (
  id text primary key,
  claim_id text not null,
  from_status text not null,
  to_status text not null,
  by_actor_id text not null,
  rationale_id text not null,
  at timestamptz not null
);
create index if not exists ${TABLES.claimTransitions}_claim_idx on ${TABLES.claimTransitions} (claim_id, at);

create table if not exists ${TABLES.beliefs} (
  id text primary key,
  claim_id text not null,
  scope_level text not null,
  scope_identifier text not null,
  authority text not null,
  truth_status text not null,
  retrieval_status text not null,
  security_status text not null,
  freshness_status text not null,
  sensitivity text not null,
  calibration_class text not null,
  superseded_by text,
  data jsonb not null
);
create index if not exists ${TABLES.beliefs}_claim_idx on ${TABLES.beliefs} (claim_id);
create index if not exists ${TABLES.beliefs}_scope_idx on ${TABLES.beliefs} (scope_level, scope_identifier);
create index if not exists ${TABLES.beliefs}_calibration_idx on ${TABLES.beliefs} (calibration_class);

create table if not exists ${TABLES.beliefTransitions} (
  id text primary key,
  belief_id text not null,
  axis text not null,
  from_value text not null,
  to_value text not null,
  by_actor_id text not null,
  rationale_id text not null,
  at timestamptz not null
);
create index if not exists ${TABLES.beliefTransitions}_belief_idx on ${TABLES.beliefTransitions} (belief_id, at);

create table if not exists ${TABLES.evidenceSets} (
  id text primary key,
  claim_id text not null,
  data jsonb not null
);
create index if not exists ${TABLES.evidenceSets}_claim_idx on ${TABLES.evidenceSets} (claim_id);
`

/**
 * Create the tables and indexes if they do not already exist. Idempotent —
 * safe to call on every process start. Uses the simple query protocol
 * (`sql.unsafe`) because the DDL is static and multi-statement; it carries no
 * caller input, so there is no injection surface.
 */
export async function ensureSchema(sql: SQL): Promise<void> {
  await sql.unsafe(DDL)
}

/**
 * Drop all Lodestar store tables. Intended for test teardown; not used in
 * production paths.
 */
export async function dropSchema(sql: SQL): Promise<void> {
  await sql.unsafe(
    `drop table if exists ${TABLES.claims}, ${TABLES.claimTransitions}, ${TABLES.beliefs}, ${TABLES.beliefTransitions}, ${TABLES.evidenceSets} cascade;`,
  )
}

/**
 * Truncate all store tables. Faster than drop+recreate between tests.
 */
export async function truncateAll(sql: SQL): Promise<void> {
  await sql.unsafe(
    `truncate ${TABLES.claims}, ${TABLES.claimTransitions}, ${TABLES.beliefs}, ${TABLES.beliefTransitions}, ${TABLES.evidenceSets};`,
  )
}
