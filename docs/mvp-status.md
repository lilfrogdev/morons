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
chat; repository tools are absent in that mode. The default remains offline
even with a provider key; selecting a real model also requires an explicit
catalog model ID from the operator. Account entitlement and remote token
validity have not been verified. No actual OAuth or paid call was made. Local
credential metadata restores provider status after a restart.

## Trust boundary and remaining milestones

The review worker is a separate process without provider credentials and with
macOS network access denied. Its current sandbox **does not confine filesystem
reads**. Real-provider sessions therefore have no repository tools. A stronger
filesystem/process runner and explicit trusted check and apply workflow are
required before model-directed code execution.

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
