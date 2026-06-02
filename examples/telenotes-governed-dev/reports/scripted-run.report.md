# Lodestar trust report — telenotes-governed-dev (session-e717ef21-7bfe-4fc9-8231-98276200f624)

**Session**: `session-e717ef21-7bfe-4fc9-8231-98276200f624`
**Project**: `telenotes-governed-dev`
**Actors**: `agent:claude-code`
**Time**: 2026-06-02T01:19:01.133Z → 2026-06-02T01:19:01.597Z
**Events**: 145

## Observations

- `mcp.fs.list_directory` — schema `mcp.tool_result@1`, trust `validated`, sensitivity `internal` (`268acfeb`)
- `mcp.fs.read_text_file` — schema `mcp.tool_result@1`, trust `validated`, sensitivity `internal` (`95aac1bd`)
- `mcp.fs.read_text_file` — schema `mcp.tool_result@1`, trust `validated`, sensitivity `internal` (`6c0fd5b4`)
- `mcp.fs.read_text_file` — schema `mcp.tool_result@1`, trust `validated`, sensitivity `internal` (`af40dd39`)
- `mcp.fs.write_file` — schema `mcp.tool_result@1`, trust `validated`, sensitivity `internal` (`710a9a69`)
- `mcp.fs.write_file` — schema `mcp.tool_result@1`, trust `validated`, sensitivity `internal` (`ed9bf453`)
- `mcp.devtools.shell_test` — schema `mcp.tool_result@1`, trust `validated`, sensitivity `internal` (`ed756b5b`)
- `mcp.devtools.git_commit` — schema `mcp.tool_result@1`, trust `validated`, sensitivity `internal` (`5d3202ea`)

## Claims

- _tool_ MCP tool 'mcp.fs.list_directory' (server: fs) returned 1 content block [text]  `(extracted, sensitivity internal)`
- _tool_ External document content via 'mcp.fs.list_directory' content block #0: [DIR] .git
[FILE] README.md
[FILE] note.test.ts
[FILE] note.ts
[FILE] package.json
[FILE] publish.ts  `(extracted, sensitivity internal)`
- _tool_ MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]  `(extracted, sensitivity internal)`
- _tool_ External document content via 'mcp.fs.read_text_file' content block #0: # Telenotes

A tiny [Nostr](https://nostr.com) note-publishing helper. Telenotes turns
short text notes into relay-ready events.

This is the **fixture codebase** for the Lodestar `telenotes-governed-…  `(extracted, sensitivity internal)`
- _tool_ MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]  `(extracted, sensitivity internal)`
- _tool_ External document content via 'mcp.fs.read_text_file' content block #0: /**
 * Telenotes — core Note model.
 *
 * Telenotes is a small Nostr note-publishing helper. A `Note` is the
 * in-app representation of a short text note before it is signed and
 * published to a rel…  `(extracted, sensitivity internal)`
- _tool_ MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]  `(extracted, sensitivity internal)`
- _tool_ External document content via 'mcp.fs.read_text_file' content block #0: /**
 * Telenotes — publish path.
 *
 * Shapes a `Note` into the event payload a Nostr relay would accept and
 * returns a synthetic event id. This is a stub: it does not open a
 * network connection (…  `(extracted, sensitivity internal)`
- _tool_ MCP tool 'mcp.fs.write_file' (server: fs) returned 1 content block [text]  `(extracted, sensitivity internal)`
- _tool_ External document content via 'mcp.fs.write_file' content block #0: Successfully wrote to /private/tmp/claude-501/telenotes-uQzjDP/note.ts  `(extracted, sensitivity internal)`
- _tool_ MCP tool 'mcp.fs.write_file' (server: fs) returned 1 content block [text]  `(extracted, sensitivity internal)`
- _tool_ External document content via 'mcp.fs.write_file' content block #0: Successfully wrote to /private/tmp/claude-501/telenotes-uQzjDP/publish.ts  `(extracted, sensitivity internal)`
- _tool_ MCP tool 'mcp.devtools.shell_test' (server: devtools) returned 1 content block [text]  `(extracted, sensitivity internal)`
- _tool_ External document content via 'mcp.devtools.shell_test' content block #0: $ bun test
bun test v1.3.14 (0d9b296a)

note.test.ts:
(pass) buildNote captures content and defaults to no tags [0.87ms]
(pass) buildNote copies the tags it is given (no shared reference) [0.02ms]
(pa…  `(extracted, sensitivity internal)`
- _tool_ MCP tool 'mcp.devtools.git_commit' (server: devtools) returned 1 content block [text]  `(extracted, sensitivity internal)`
- _tool_ External document content via 'mcp.devtools.git_commit' content block #0: committed 553e2359fd5ed85909da836f0024d56213b8d7d9
[main 553e235] feat(note): add clientTag field
 2 files changed, 14 insertions(+), 3 deletions(-)
  `(extracted, sensitivity internal)`

## Evidence

- **MCP tool 'mcp.fs.list_directory' (server: fs) returned 1 content block [text]**
    - supports · quality `tool_result` · freshness `fresh` · indep `obs:mcp.fs.list_directory` — mcp.tool_invocation from mcp.tool_result@1
- **External document content via 'mcp.fs.list_directory' content block #0: [DIR] .git
[FILE] README.md
[FILE] note.test.ts
[FILE] note.ts
[FILE] package.json
[FILE] publish.ts**
    - supports · quality `external_document` · freshness `fresh` · indep `obs:mcp.fs.list_directory` — mcp.external_document from mcp.tool_result@1
- **MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]**
    - supports · quality `tool_result` · freshness `fresh` · indep `obs:mcp.fs.read_text_file` — mcp.tool_invocation from mcp.tool_result@1
- **External document content via 'mcp.fs.read_text_file' content block #0: # Telenotes

A tiny [Nostr](https://nostr.com) note-publishing helper. Telenotes turns
short text notes into relay-ready events.

This is the **fixture codebase** for the Lodestar `telenotes-governed-…**
    - supports · quality `external_document` · freshness `fresh` · indep `obs:mcp.fs.read_text_file` — mcp.external_document from mcp.tool_result@1
- **MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]**
    - supports · quality `tool_result` · freshness `fresh` · indep `obs:mcp.fs.read_text_file` — mcp.tool_invocation from mcp.tool_result@1
- **External document content via 'mcp.fs.read_text_file' content block #0: /**
 * Telenotes — core Note model.
 *
 * Telenotes is a small Nostr note-publishing helper. A `Note` is the
 * in-app representation of a short text note before it is signed and
 * published to a rel…**
    - supports · quality `external_document` · freshness `fresh` · indep `obs:mcp.fs.read_text_file` — mcp.external_document from mcp.tool_result@1
- **MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]**
    - supports · quality `tool_result` · freshness `fresh` · indep `obs:mcp.fs.read_text_file` — mcp.tool_invocation from mcp.tool_result@1
- **External document content via 'mcp.fs.read_text_file' content block #0: /**
 * Telenotes — publish path.
 *
 * Shapes a `Note` into the event payload a Nostr relay would accept and
 * returns a synthetic event id. This is a stub: it does not open a
 * network connection (…**
    - supports · quality `external_document` · freshness `fresh` · indep `obs:mcp.fs.read_text_file` — mcp.external_document from mcp.tool_result@1
- **MCP tool 'mcp.fs.write_file' (server: fs) returned 1 content block [text]**
    - supports · quality `tool_result` · freshness `fresh` · indep `obs:mcp.fs.write_file` — mcp.tool_invocation from mcp.tool_result@1
- **External document content via 'mcp.fs.write_file' content block #0: Successfully wrote to /private/tmp/claude-501/telenotes-uQzjDP/note.ts**
    - supports · quality `external_document` · freshness `fresh` · indep `obs:mcp.fs.write_file` — mcp.external_document from mcp.tool_result@1
- **MCP tool 'mcp.fs.write_file' (server: fs) returned 1 content block [text]**
    - supports · quality `tool_result` · freshness `fresh` · indep `obs:mcp.fs.write_file` — mcp.tool_invocation from mcp.tool_result@1
- **External document content via 'mcp.fs.write_file' content block #0: Successfully wrote to /private/tmp/claude-501/telenotes-uQzjDP/publish.ts**
    - supports · quality `external_document` · freshness `fresh` · indep `obs:mcp.fs.write_file` — mcp.external_document from mcp.tool_result@1
- **MCP tool 'mcp.devtools.shell_test' (server: devtools) returned 1 content block [text]**
    - supports · quality `tool_result` · freshness `fresh` · indep `obs:mcp.devtools.shell_test` — mcp.tool_invocation from mcp.tool_result@1
- **External document content via 'mcp.devtools.shell_test' content block #0: $ bun test
bun test v1.3.14 (0d9b296a)

note.test.ts:
(pass) buildNote captures content and defaults to no tags [0.87ms]
(pass) buildNote copies the tags it is given (no shared reference) [0.02ms]
(pa…**
    - supports · quality `external_document` · freshness `fresh` · indep `obs:mcp.devtools.shell_test` — mcp.external_document from mcp.tool_result@1
- **MCP tool 'mcp.devtools.git_commit' (server: devtools) returned 1 content block [text]**
    - supports · quality `tool_result` · freshness `fresh` · indep `obs:mcp.devtools.git_commit` — mcp.tool_invocation from mcp.tool_result@1
- **External document content via 'mcp.devtools.git_commit' content block #0: committed 553e2359fd5ed85909da836f0024d56213b8d7d9
[main 553e235] feat(note): add clientTag field
 2 files changed, 14 insertions(+), 3 deletions(-)
**
    - supports · quality `external_document` · freshness `fresh` · indep `obs:mcp.devtools.git_commit` — mcp.external_document from mcp.tool_result@1

## Beliefs

- **MCP tool 'mcp.fs.list_directory' (server: fs) returned 1 content block [text]**
    - confidence 0.95 · truth=`supported` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::tool:mcp.fs.list_directory`
- **External document content via 'mcp.fs.list_directory' content block #0: [DIR] .git
[FILE] README.md
[FILE] note.test.ts
[FILE] note.ts
[FILE] package.json
[FILE] publish.ts**
    - confidence 0.95 · truth=`unverified` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::mcp_content:mcp.fs.list_directory:b578d201-91d6-4981-b3e4-ced3c2d7eb6d:#0`
- **MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]**
    - confidence 0.95 · truth=`supported` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::tool:mcp.fs.read_text_file`
- **External document content via 'mcp.fs.read_text_file' content block #0: # Telenotes

A tiny [Nostr](https://nostr.com) note-publishing helper. Telenotes turns
short text notes into relay-ready events.

This is the **fixture codebase** for the Lodestar `telenotes-governed-…**
    - confidence 0.95 · truth=`unverified` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::mcp_content:mcp.fs.read_text_file:023187f7-72c3-46c2-850a-e2f9f3dfff02:#0`
- **MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]**
    - confidence 0.95 · truth=`supported` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::tool:mcp.fs.read_text_file`
- **External document content via 'mcp.fs.read_text_file' content block #0: /**
 * Telenotes — core Note model.
 *
 * Telenotes is a small Nostr note-publishing helper. A `Note` is the
 * in-app representation of a short text note before it is signed and
 * published to a rel…**
    - confidence 0.95 · truth=`unverified` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::mcp_content:mcp.fs.read_text_file:8f7d518c-c807-4e20-8b3b-b4e872dfa7c7:#0`
- **MCP tool 'mcp.fs.read_text_file' (server: fs) returned 1 content block [text]**
    - confidence 0.95 · truth=`supported` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::tool:mcp.fs.read_text_file`
- **External document content via 'mcp.fs.read_text_file' content block #0: /**
 * Telenotes — publish path.
 *
 * Shapes a `Note` into the event payload a Nostr relay would accept and
 * returns a synthetic event id. This is a stub: it does not open a
 * network connection (…**
    - confidence 0.95 · truth=`unverified` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::mcp_content:mcp.fs.read_text_file:9b0f202e-0314-4572-9929-877378082f8c:#0`
- **MCP tool 'mcp.fs.write_file' (server: fs) returned 1 content block [text]**
    - confidence 0.95 · truth=`supported` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::tool:mcp.fs.write_file`
- **External document content via 'mcp.fs.write_file' content block #0: Successfully wrote to /private/tmp/claude-501/telenotes-uQzjDP/note.ts**
    - confidence 0.95 · truth=`unverified` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::mcp_content:mcp.fs.write_file:f63119f9-3d77-42cf-af21-dab7ae890477:#0`
- **MCP tool 'mcp.fs.write_file' (server: fs) returned 1 content block [text]**
    - confidence 0.95 · truth=`supported` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::tool:mcp.fs.write_file`
- **External document content via 'mcp.fs.write_file' content block #0: Successfully wrote to /private/tmp/claude-501/telenotes-uQzjDP/publish.ts**
    - confidence 0.95 · truth=`unverified` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::mcp_content:mcp.fs.write_file:992d3bcc-3687-46dc-b432-925b29443179:#0`
- **MCP tool 'mcp.devtools.shell_test' (server: devtools) returned 1 content block [text]**
    - confidence 0.95 · truth=`supported` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::tool:mcp.devtools.shell_test`
- **External document content via 'mcp.devtools.shell_test' content block #0: $ bun test
bun test v1.3.14 (0d9b296a)

note.test.ts:
(pass) buildNote captures content and defaults to no tags [0.87ms]
(pass) buildNote copies the tags it is given (no shared reference) [0.02ms]
(pa…**
    - confidence 0.95 · truth=`unverified` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::mcp_content:mcp.devtools.shell_test:0d65a5da-9213-46c2-86a5-d927c07fc539:#0`
- **MCP tool 'mcp.devtools.git_commit' (server: devtools) returned 1 content block [text]**
    - confidence 0.95 · truth=`supported` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::tool:mcp.devtools.git_commit`
- **External document content via 'mcp.devtools.git_commit' content block #0: committed 553e2359fd5ed85909da836f0024d56213b8d7d9
[main 553e235] feat(note): add clientTag field
 2 files changed, 14 insertions(+), 3 deletions(-)
**
    - confidence 0.95 · truth=`unverified` · retrieval=`restricted` · security=`clean` · freshness=`fresh` · authority `observed` · class `mcp.tool_result@1::mcp_content:mcp.devtools.git_commit:ff765ee8-0b3d-4c15-a25f-f0c1b3570230:#0`

## Decisions

- **Add a clientTag field to Note and stamp it on publish** `(0a547db2)`
    - chose: **Add an optional clientTag to Note and PublishResult** — note.ts exposes content/createdAt/tags (observed by reading the file — external_document, unverified). Adding an optional clientTag is additive and keeps the existing tests green.
    - belief dependencies: `21289ff4`
    - made by `agent:claude-code` at 2026-06-02T01:19:01.498Z
- **Push blocked by policy; defer to human approval** `(2b7a3e8a)`
    - chose: **Stop and request approval for the L4 push** — git_push is L4 (irreversible, external blast radius); the auto-approve ceiling is L3. The change is committed locally and awaits human approval to push.
    - made by `agent:claude-code` at 2026-06-02T01:19:01.597Z

## Actions

- `mcp.fs.list_directory` — forward MCP tool call mcp.fs.list_directory via proxy  (L0, self, reversible, final phase `completed`)
    - **approved** by `policy:auto-approve-up-to-3`: auto-approved at L0 (ceiling L3)
- `mcp.fs.read_text_file` — forward MCP tool call mcp.fs.read_text_file via proxy  (L0, self, reversible, final phase `completed`)
    - **approved** by `policy:auto-approve-up-to-3`: auto-approved at L0 (ceiling L3)
- `mcp.fs.read_text_file` — forward MCP tool call mcp.fs.read_text_file via proxy  (L0, self, reversible, final phase `completed`)
    - **approved** by `policy:auto-approve-up-to-3`: auto-approved at L0 (ceiling L3)
- `mcp.fs.read_text_file` — forward MCP tool call mcp.fs.read_text_file via proxy  (L0, self, reversible, final phase `completed`)
    - **approved** by `policy:auto-approve-up-to-3`: auto-approved at L0 (ceiling L3)
- `mcp.fs.write_file` — forward MCP tool call mcp.fs.write_file via proxy  (L3, project, compensable, final phase `completed`)
    - **approved** by `policy:auto-approve-up-to-3`: auto-approved at L3 (ceiling L3)
- `mcp.fs.write_file` — forward MCP tool call mcp.fs.write_file via proxy  (L3, project, compensable, final phase `completed`)
    - **approved** by `policy:auto-approve-up-to-3`: auto-approved at L3 (ceiling L3)
- `mcp.devtools.shell_test` — forward MCP tool call mcp.devtools.shell_test via proxy  (L3, session, reversible, final phase `completed`)
    - **approved** by `policy:auto-approve-up-to-3`: auto-approved at L3 (ceiling L3)
    - outcome: `success` in 0ms
- `mcp.devtools.git_commit` — forward MCP tool call mcp.devtools.git_commit via proxy  (L3, project, compensable, final phase `completed`)
    - **approved** by `policy:auto-approve-up-to-3`: auto-approved at L3 (ceiling L3)
- `mcp.devtools.git_push` — forward MCP tool call mcp.devtools.git_push via proxy  (L4, external, irreversible, final phase `rejected`)
    - **rejected** by `policy:auto-approve-up-to-3`: L4 exceeds auto-approve ceiling L3
    - outcome: `failure` in 0ms
    - failure: L4 exceeds auto-approve ceiling L3

## Firewall activity

Summary: 16 × `claim.accepted`, 16 × `belief.adopted`.

- `claim.accepted` claim=`0be6af39` by `agent:claude-code`
- `claim.accepted` claim=`98ccdcf8` by `agent:claude-code`
- `belief.adopted` belief=`09a82de2` claim=`0be6af39` authority=`auto_observation`
- `belief.adopted` belief=`8e93c395` claim=`98ccdcf8` authority=`reflection`
- `claim.accepted` claim=`85a219aa` by `agent:claude-code`
- `claim.accepted` claim=`ed731d1a` by `agent:claude-code`
- `belief.adopted` belief=`67c587f4` claim=`85a219aa` authority=`auto_observation`
- `belief.adopted` belief=`648acc10` claim=`ed731d1a` authority=`reflection`
- `claim.accepted` claim=`71d6b790` by `agent:claude-code`
- `claim.accepted` claim=`9263e3fd` by `agent:claude-code`
- `belief.adopted` belief=`689c9a0c` claim=`71d6b790` authority=`auto_observation`
- `belief.adopted` belief=`21289ff4` claim=`9263e3fd` authority=`reflection`
- `claim.accepted` claim=`569d37da` by `agent:claude-code`
- `claim.accepted` claim=`4b68e180` by `agent:claude-code`
- `belief.adopted` belief=`e26a92e4` claim=`569d37da` authority=`auto_observation`
- `belief.adopted` belief=`96362fd3` claim=`4b68e180` authority=`reflection`
- `claim.accepted` claim=`de2f0b47` by `agent:claude-code`
- `claim.accepted` claim=`b02342a9` by `agent:claude-code`
- `belief.adopted` belief=`ec2a5f7c` claim=`de2f0b47` authority=`auto_observation`
- `belief.adopted` belief=`8a29458b` claim=`b02342a9` authority=`reflection`
- `claim.accepted` claim=`a850d4a3` by `agent:claude-code`
- `claim.accepted` claim=`1b2937b5` by `agent:claude-code`
- `belief.adopted` belief=`619c678e` claim=`a850d4a3` authority=`auto_observation`
- `belief.adopted` belief=`6bae64d7` claim=`1b2937b5` authority=`reflection`
- `claim.accepted` claim=`d16e8d61` by `agent:claude-code`
- `claim.accepted` claim=`da0cc923` by `agent:claude-code`
- `belief.adopted` belief=`fa0a3889` claim=`d16e8d61` authority=`auto_observation`
- `belief.adopted` belief=`b1540036` claim=`da0cc923` authority=`reflection`
- `claim.accepted` claim=`0e98becb` by `agent:claude-code`
- `claim.accepted` claim=`d29bb1bd` by `agent:claude-code`
- `belief.adopted` belief=`d17029bb` claim=`0e98becb` authority=`auto_observation`
- `belief.adopted` belief=`9eb59ea9` claim=`d29bb1bd` authority=`reflection`

## Cognitive ingestion

- observation `268acfeb`: 2 claim(s), 2 belief(s), world-model keys [tool:mcp.fs.list_directory.mcp.tool_invocation, mcp_content:mcp.fs.list_directory:b578d201-91d6-4981-b3e4-ced3c2d7eb6d:#0.mcp.external_document_content]
- observation `95aac1bd`: 2 claim(s), 2 belief(s), world-model keys [tool:mcp.fs.read_text_file.mcp.tool_invocation, mcp_content:mcp.fs.read_text_file:023187f7-72c3-46c2-850a-e2f9f3dfff02:#0.mcp.external_document_content]
- observation `6c0fd5b4`: 2 claim(s), 2 belief(s), world-model keys [tool:mcp.fs.read_text_file.mcp.tool_invocation, mcp_content:mcp.fs.read_text_file:8f7d518c-c807-4e20-8b3b-b4e872dfa7c7:#0.mcp.external_document_content]
- observation `af40dd39`: 2 claim(s), 2 belief(s), world-model keys [tool:mcp.fs.read_text_file.mcp.tool_invocation, mcp_content:mcp.fs.read_text_file:9b0f202e-0314-4572-9929-877378082f8c:#0.mcp.external_document_content]
- observation `710a9a69`: 2 claim(s), 2 belief(s), world-model keys [tool:mcp.fs.write_file.mcp.tool_invocation, mcp_content:mcp.fs.write_file:f63119f9-3d77-42cf-af21-dab7ae890477:#0.mcp.external_document_content]
- observation `ed9bf453`: 2 claim(s), 2 belief(s), world-model keys [tool:mcp.fs.write_file.mcp.tool_invocation, mcp_content:mcp.fs.write_file:992d3bcc-3687-46dc-b432-925b29443179:#0.mcp.external_document_content]
- observation `ed756b5b`: 2 claim(s), 2 belief(s), world-model keys [tool:mcp.devtools.shell_test.mcp.tool_invocation, mcp_content:mcp.devtools.shell_test:0d65a5da-9213-46c2-86a5-d927c07fc539:#0.mcp.external_document_content]
- observation `5d3202ea`: 2 claim(s), 2 belief(s), world-model keys [tool:mcp.devtools.git_commit.mcp.tool_invocation, mcp_content:mcp.devtools.git_commit:ff765ee8-0b3d-4c15-a25f-f0c1b3570230:#0.mcp.external_document_content]

---

_Generated by `@qmilab/lodestar-trace` from the append-only event log. Every claim, belief, and action above is linked back to an event in the log; the report is a projection, not a summary._
