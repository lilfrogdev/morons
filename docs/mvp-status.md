# Morons MVP status and next boundary

This branch extends the small Pi application shell in `lilfrogdev/morons`.
The older `lilfrogdev/morons.dev` Rust CLI remains a separate, untouched
checkout. This branch is local; no provider inference, login, deployment,
push, or merge was used to verify it.

## Connected local slices

- The existing Cloudflare root chat remains in place. Its backend also stores
  named moron definitions, rules, preferences, session metadata, and scoped
  handoff records.
- `packages/selfhost` runs separate Pi Durable conversations for named morons
  under one SQLite owner. Its only model is deterministic and offline. Request
  IDs and stored text reconcile a reply after restart. A bounded `@freddy`
  question can be answered inside a separate target session and returned to
  the owning fitness session without sharing the target's other transcript.
- The GPUI desktop can select named morons, submit messages, and recover
  server history when `MORONS_BACKEND_MODE=named` points to that local server.
  The existing root transport remains available. The compact composer draws
  from Pitcrew's layout; model information is read-only and attachments are
  pending backend support.
- `packages/review-runner` reads only operator-allowlisted committed source
  paths and can put a proposed patch into an isolated branch worktree, run
  operator-selected checks, and return the diff. Tests preserve uncommitted
  source edits. It has no model-facing route or restricted runner process yet.
- Named fixture turns now ingest assistant replies into persistent OptChat
  memory and read a frozen, bounded view of their own session and explicit
  moron-level decisions before the next turn. The original user text remains
  what history displays.

## Prepared components

- `packages/optchat` contains OptChat-derived, persistent binary summary-tree
  memory with immutable sources and scoped reads. The fixture connects basic
  ingest and retrieval; model-backed summarization and recall evaluation are
  still pending. See `docs/optchat.md` for attribution.
- `packages/auth` delegates a human-initiated OpenAI login through Pi 1.2's
  provider API. `packages/credential-store` supplies an encrypted single-owner
  store. Both have mock tests; neither connects a real login UI or credential.
  Provider authorization is separate from Morons account login.
- Bounded, data-only visualization documents and a native GPUI renderer are
  implemented. No account-authorized visualization API or chat-view hookup is
  active. See `docs/visualizations.md`.

## First useful milestone

The repository moron should read a trusted allowlist of its own committed
source, remember user decisions, propose a patch against a fixed commit in an
isolated branch, run preapproved checks in a restricted process, and present
the diff for human review. The first end-to-end acceptance test should create
an uncommitted source edit, ask the repo moron for a small change, verify that
the agent receives only approved committed files, then inspect the resulting
worktree diff and check results. The source checkout must retain its original
HEAD and uncommitted edit; nothing is merged or deployed by that test.

## Decisions before external use

1. Choose Morons account and device-session authentication, TLS ingress, and
   account-scoped storage. The fixture's shared bearer is suitable only for
   local testing; it does not establish iPhone/Windows/Mac sign-in or sync.
2. Keep one storage owner for Pi Durable and memory, and define recovery for
   side effects outside their transactions. Temporary implementation agents
   use regular compaction; named morons use OptChat context with their rules
   and preferences kept authoritative.
3. Put source access and patch execution behind a restricted runner with a
   trusted plan, fixed allowed paths, bounded output, and human review.
   Autonomous updates of the running application are outside this boundary.
4. Decide whether the first iPhone client is a PWA or native. GPUI supports the
   desktop choice, but is not an iPhone implementation. Windows has source
   support in pinned GPUI; this branch has only compiled on macOS.

The shortest path is to connect these slices in the existing Pi shell, then
exercise the repository-moron acceptance test. A clean shell would rebuild
working root transport and native UI without solving account sync, memory
admission, or the runner boundary.
