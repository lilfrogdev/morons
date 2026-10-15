# OptChat memory in Morons

`packages/optchat` ports Pitcrew's SQLite adaptation of the OptChat v0.7.2
binary summary tree. The source of that adaptation is Pitcrew commit
`4d605585ec5a3e8016cbb5d2872ff03f438bd581` in the PR 60 integration
line. The inspected original is Jonas Silva's
[`pi-optchat` v0.7.2 at `d692f03d863af7f0244643b4015f721c68784170`](https://github.com/jonaslsaa/pi-optchat/tree/d692f03d863af7f0244643b4015f721c68784170).
Pitcrew is Apache-2.0; the original OptChat implementation is MIT. See
[`packages/optchat/NOTICE`](../packages/optchat/NOTICE). No attributed author
recipe or upstream prompt text is copied.

This is actual OptChat-derived storage and retrieval, not a key-value memory
substitute. It keeps an immutable raw source journal, a persistent binary
summary tree, bounded view/search/zoom, compression claims, source references,
turn cutoffs, and rechecked authorization. A generated summary must be
nonempty, short, one line, and smaller than its source. If compression fails,
the original source remains available. This package does not invoke a model;
the caller supplies its compressor and owns the cost/admission policy.

The schema's `repository` field is an opaque namespace. `moronMemoryAccess`
maps it to the **named moron ID**, so the same storage works for repository,
fitness, finance, or another long-running moron. `projectId` maps to the Morons
account ID and `threadId` to a session ID. Source IDs must be stable across
retries. The caller supplies the current list of authorized session IDs and an
authorizer that checks every referenced source against current account/session
membership. The SQLite database must have one storage owner. A single-owner
Node adapter is provided; Durable Object SQLite can use the `MemorySql`
interface directly.

The self-host runtime checkpoints the last scanned Pi entry after committing
each bounded page to OptChat. A restart replays an unfinished page through
idempotent source append. For an existing session, it inventories authorized
legacy sources once and leaves those immutable records in their original
scope while backfilling missing user entries. Session sources roll to the next authorized scope
after 4,096 entries; the 32-scope access bound permits up to 131,072 stored
session sources, with separate scan room for moron-level decisions. The model
prompt remains capped at 2,048 characters.

For named-moron turns, the runtime freezes a history view before the
current message, appends the current user message and assistant result with
stable receipts, and disables ordinary Pi compaction for that named moron.
Temporary implementation subagents keep regular Pi compaction and receive only
a bounded brief. `@mention` requests are separate durable, scoped handoffs;
this memory package does not coordinate agents or grant access across morons.
Never treat remembered text as authority over current rules, preferences,
user instructions, or tool approvals. Revalidate frozen source references
after membership changes and before delegation.

`packages/selfhost` appends named Pi user and assistant entries with stable
IDs, freezes a bounded view of that session plus explicit moron-level
decisions before each turn, and supplies its text to Pi. The original user
text is retained for history. With an available selected real model, it
claims and compresses up to four native OptChat nodes per turn using a short
factual summarization request. Unavailable and offline fixture models leave
the raw sources intact.
`npm test` in `packages/optchat` covers restart, immutable idempotent append,
scope isolation, revocation of cached reads, compression claim replay, and raw
source preservation. The self-host tests cover selected-model compression,
restart, failed compression, and source retention. Recall evaluation with a
signed-in real provider remains open.
