# Self-hosted local Morons server

This Node 22.19+ application runs Pi AI and Pi Durable 1.2.0 with a
**deterministic offline model**. It makes no provider inference calls. Install
the locked dependencies and run the test suite from this isolated checkout:

```sh
cd packages/selfhost
npm ci
npm test
```

`npm run start:account` starts the account gateway on `127.0.0.1:8787`. Set
`MORONS_DATA_DIR` to a private directory and `MORONS_BOOTSTRAP_TOKEN` to a
fresh 32+ character secret. The server refuses a non-loopback bind. The first
account is created through `POST /v1/accounts/bootstrap` with that secret in
`X-Morons-Bootstrap`; bootstrap closes after the first account. That account
can create others through authenticated `POST /v1/accounts`. Device login uses
`POST /v1/session/login` with account name and password, returning a separate
30-day bearer for each device. `GET /v1/session/me` verifies it and
`POST /v1/session/logout` revokes only that device session. Store device
tokens privately on each client. Passwords are scrypt-hashed and bearer hashes,
not bearer values, are persisted. Each account has its own Pi Durable and
OptChat database. A single gateway process owns them; a stale owner lock
is reclaimed only when its recorded process ID is absent. An ambiguous lock
or interrupted lock reclamation requires operator inspection.

For the repository moron, supply the operator-controlled
`MORONS_REPOSITORY` and comma-separated `MORONS_SOURCE_PATHS`. These paths
are exact committed-file read and patch limits. Only the administrator account
receives the repository tools. `/source PATH` reads an approved committed blob.
`/review` followed by a unified diff commits on an isolated proposal branch,
runs fixed `git diff --check`, and records the diff for human review. Pending
review intents are retried after restart. The review decision
endpoint records Approve or Reject; it does not apply or merge the patch.
The worker is a separate process with no provider credentials and a macOS
no-network sandbox. Filesystem confinement for untrusted repositories remains
an operator/deployment requirement; the review operation is unavailable on
other server platforms until a comparable sandbox is configured.

The GPUI client currently receives a device bearer through its environment:

```sh
cd apps/desktop
MORONS_BACKEND_MODE=named MORONS_BACKEND_URL=http://127.0.0.1:8787 MORONS_BACKEND_TOKEN='<device-session-bearer>' cargo run
```

The first connection creates `repo` and its first session if the account's
catalog is empty. GPUI can switch among named morons and shows review diff,
check result, and human decision controls. The app needs its own account login
and private token storage before an installed multi-device release. A separate
TLS ingress and authorization policy are needed before remote access; never
expose the loopback fixture directly to the Internet.

`node --experimental-strip-types scripts/demo-server.mjs` starts a disposable
account, repository, and proposed change for a local UI walkthrough. It prints
a temporary backend URL and bearer and deletes the fixture after Ctrl-C. The
screenshot used for QA came from this synthetic path.

Named sessions ingest assistant entries into the OptChat port and retrieve a
bounded view of their own session plus explicit moron-level decisions. The
`@moron-id question` syntax sends only that bounded question to an isolated
target session, then attributes the answer to the owning session. Temporary
implementation agents and real model-backed summarization are not part of
this offline fixture.

The lower-level `npm start` command still runs the original single-owner
fixture API for regression tests. It uses `MORONS_FIXTURE_DB` and
`MORONS_OWNER_TOKEN` and must remain local. The account gateway is the public
entry point for ongoing self-hosted development.
