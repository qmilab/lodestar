# @qmilab/lodestar-memory-firewall-letta — CLAUDE.md

Stub-level adapter for Letta memory blocks. Same shape as the mem0
adapter — see `../mem0/CLAUDE.md` for the invariants. The only
differences are:

- The input format is the Letta `blocks` export (`label` + `value`),
  not mem0's `memories` (`memory` field).
- `freshness_status` defaults to `stale` because Letta blocks don't
  carry a per-record timestamp at the v0 export shape; the import
  records the import time as `observed_at` but cannot vouch for how
  fresh the block contents are.

The shared rules from the mem0 adapter apply here: external_document
evidence, `unverified/restricted` initial state, no silent defaults
for security-relevant options, rejections do not throw.
