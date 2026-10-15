# Morons local MVP status

This branch builds on the newer Pi-based `lilfrogdev/morons` repository. The
older `morons.dev` Rust CLI is excluded from reuse. Installed GPUI Mac and
Windows apps are the desktop direction, followed by a separate native iPhone
app. The current local tryout is on Mac.

## Working local path

GPUI can create the first account and sign in within the app. Its password and
first-account setup fields are masked; the device bearer stays in app memory
and can be revoked by Sign out. A loopback account gateway maps the bearer to
an account-private Pi Durable and OptChat owner. Named morons keep rules,
preferences, durable sessions, bounded memory, and scoped `@mention` question
and answer handoffs. Multiple device sessions see the same account history;
other accounts have separate databases.

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

Pi 1.2's ChatGPT OAuth interaction has a human-triggered GPUI lifecycle:
start, inspect the server-returned authorization URL, open the browser, paste
a final redirect URL if needed, cancel, status, and disconnect. The server
requires an owner-private 32-byte unlock key before exposing this path, keeps
provider credentials in an encrypted per-account store, and never returns
them to GPUI. The real Pi model path passed mocked responses through durable
chat; repository tools are gated on a verified container runner in that mode. The default remains offline
even with a provider key; selecting a real model also requires an explicit
catalog model ID from the operator. Account entitlement and remote token
validity have not been verified. No actual OAuth or paid call was made. Local
credential metadata restores provider status after a restart.

## Trust boundary and remaining milestones

The older macOS worker uses `sandbox-exec` to deny network but does not
confine filesystem reads; it remains for the offline fixture only. The new
real-model worker requires a locally preloaded, digest-pinned Docker image.
Startup probes the container's file, symlink, environment, network, subprocess
escape, and approval-write boundary. Its source mount is read-only and its
account-private review output is the only writable host mount. The worker
clones committed source rather than writing Git metadata in the original
checkout. On this Mac both Colima profiles are stopped, so the live container
probe has not run and real-model repository tools are unavailable. The next
platform action is to start the existing Colima profile and provide a reviewed
Node 22+ and Git image digest for the live adversarial test. Two trusted,
dependency-free check profiles now run the candidate's `review-runner` or
`optchat` Node suite as well as `git diff --check`; model edits are confined
to the selected package's source paths. The self-host backend and GPUI need
separate dependency images and build policies. An explicit reviewed apply
workflow remains to be added before any self-update claim.
The container runner rejects source/data directory overlap and linked Git
worktrees. Review intents pin the original base SHA for restart recovery.

The account server binds loopback only. For remote devices, configure and
qualify authenticated TLS ingress, token storage on each client, and session
revocation behavior. The Mac app currently asks for login each launch. Windows
build/UI testing and the separate native iPhone client remain later milestones.
OptChat model-backed compression and recall evaluation remain open.

Tests cover account isolation, two device sessions, restarts, source/review
proposals, pending review reconciliation, mocked Pi provider login and model
responses, and visualization provenance. Native transport tests cover account
setup/sign-in/logout, provider handoff, visualization parsing, review actions,
composer and stream behavior. A live Mac run with a disposable offline server
showed both the in-app login and the signed-in review/chart UI. The local
tryout instructions are in `packages/selfhost/README.md`.

OptChat v0.7.2 and Pitcrew adaptation revision/license details are in
`docs/optchat.md` and `packages/optchat/NOTICE`. The native visualization
adaptation attribution is in `docs/visualizations.md` and
`packages/visualization/NOTICE`.
