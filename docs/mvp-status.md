# Morons local MVP status

This branch builds on the newer Pi-based `lilfrogdev/morons` repository. The
older `morons.dev` Rust CLI is excluded from reuse. Installed GPUI Mac and
Windows apps are the desktop direction, followed by a separate native iPhone
app. The current local tryout is on Mac.

## Working local path

GPUI can create the first local account and sign in within the app. The local
server starts only after Create account or Sign in is selected. The owner secret
is established internally on Create account, so local enrollment needs no
terminal setup code. Separate-server enrollment retains its private setup
code. The password field is masked; the device bearer stays in app memory
and can be revoked by Sign out. A loopback account gateway maps the bearer to
an account-private Pi Durable and OptChat owner. Named morons keep rules,
preferences, durable sessions, bounded memory, and scoped `@mention` question
and answer handoffs. Multiple device sessions see the same account history;
other accounts have separate databases. New and existing accounts receive a
Personal workspace record; additional workspace management is pending.

The offline fixture model can call `/source PATH` for one exact allowlisted
committed file and `/review` followed by a unified diff. The latter commits a
proposal on an isolated branch, checks approved paths and `git diff --check`,
then presents the diff and Approve/Reject record controls in GPUI. Review
intents reconcile after restart. The source checkout and its uncommitted work
stay intact. Decisions do not merge, apply, push, deploy, or update Morons.

A bounded data-only visualization from `/viz` is sealed to the server's
account, session, assistant message, and revision. Authorized reads issue a
five-second lease; GPUI renders the chart with native primitives in the
conversation scroll area and clears it on logout or refresh failure. Invalid
model-supplied visualization data remains ordinary text.

Local provider storage now has an explicit enable button after sign-in; it
creates the private encryption key and restarts the local server without
starting OAuth. Pi 1.2's ChatGPT OAuth interaction has a human-triggered GPUI lifecycle:
start, inspect the server-returned authorization URL, open the browser, paste
a final redirect URL if needed, cancel, status, and disconnect. The server
requires an owner-private 32-byte unlock key before exposing this path, keeps
provider credentials in an encrypted per-account store, and never returns
them to GPUI. The real Pi model path passed mocked responses through durable
chat; repository tools are gated on a verified container runner in that mode.
The default remains offline even with a provider key. The server now presents Pi's authenticated
catalog per account, checks availability again when a model is selected,
persists that choice per durable session, and blocks changes while a turn is
active. GPUI exposes search, provider filtering, and account-private model
favorites. Pi's OpenAI catalog does not provide a remote entitlement probe;
actual remote model access remains unverified until a human signs in and uses
it. No actual OAuth or paid call was made. Local
credential metadata restores provider status after a restart.

## Trust boundary and remaining milestones

The older macOS worker uses `sandbox-exec` to deny network but does not
confine filesystem reads; it remains for the offline fixture only. The new
real-model worker requires a locally preloaded, digest-pinned Docker image.
Startup probes the container's file, symlink, environment, network, subprocess
escape, and approval-write boundary. Its source and trusted worker mounts are
read-only. The account container can write only its `computer-home`; each
proposal can write only its own home and review directory. The worker
clones committed source rather than writing Git metadata in the original
checkout. The Docker Desktop account workspace persists across source reads and
stops at server shutdown. Each proposal uses a separate persistent container,
home, and review directory; it stops after the operation and reconnects for
recovery. This adopts Rakazo's computer lifecycle boundary for repository
operations; browser, desktop, and file-transfer actions are not implemented.
Docker mounts private app-owned runtime copies under `/tmp`; completed
operations checkpoint review and home data to the account directory. A fresh
runtime restores those directories from that copy. Source and worker files
are staged from the checkout into verified, read-only snapshots before
mounting, so Docker Desktop does not need access to the Documents checkout or
the account directory.
On this Mac I started Docker Desktop and installed the official
`node:22.23.3-bookworm` arm64 digest
`sha256:80503c2cadca910dfe16f1516025a2133cdfb0e839f02e79191f83548f2ec729`.
The boundary and two-proposal lifecycle smoke passed with disposable source
and worker copies under `/tmp`. A live offline account-server smoke from this
checkout passed login, committed source read, isolated review checks, and
account-directory checkpointing under `~/.local/share`. Direct Docker binds of
both the Documents checkout and account directory timed out after 20 seconds;
the private runtime stages avoid those mounts. Two trusted,
dependency-free check profiles now run the candidate's `review-runner` or
`optchat` syntax check as well as `git diff --check`; model edits are confined
to the selected package's source paths. The self-host backend and GPUI need
separate dependency images and build policies. An explicit reviewed apply
workflow remains to be added before any self-update claim.
The container runner rejects source/data directory overlap and linked Git
worktrees. Review intents pin the original base SHA for restart recovery.

The account server binds loopback only. For remote devices, configure and
qualify authenticated TLS ingress, token storage on each client, and session
revocation behavior. The Mac app currently asks for login each launch. Windows
build/UI testing and the separate native iPhone client remain later milestones.
OptChat now captures both sides of named turns and uses the selected available
Pi model for bounded native summary claims. It retains the raw source if a
compression call fails. Offline fixture sessions keep raw recall without
claiming model compression. A named Moron can use Pi's `ask_moron` tool only
when the current user explicitly names a target; a one-call ledger saves the
target's isolated answer across restart. GPUI shows that scoped handoff in
history. Recall quality and real provider behavior still need human testing.

Automated test files were removed at the owner's request. The repository keeps
syntax checks, type checks, dry-run builds, and manual app verification. A
previous live Mac run with a disposable offline server showed both the in-app
login and the signed-in review/chart UI. The local
tryout instructions are in `packages/selfhost/README.md`.

OptChat v0.7.2 and Pitcrew adaptation revision/license details are in
`docs/optchat.md` and `packages/optchat/NOTICE`. The native visualization
adaptation attribution is in `docs/visualizations.md` and
`packages/visualization/NOTICE`.
