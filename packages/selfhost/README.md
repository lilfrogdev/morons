# Self-hosted Node fixture

This is an offline Pi Durable integration slice, not the production Morons backend. It opens one SQLite database with one Node process, exposes authenticated named-moron chat, and persists each Pi transcript across restart. Its only model is a deterministic local fixture. It cannot contact an inference provider.

Node 22.19+ is required. Pi AI and Durable are pinned at 1.2.0. Install local dependencies, then test:

```sh
cd packages/selfhost
npm ci
npm test
```

To preview locally, use a private database path and a fresh random owner token of at least 32 characters:

```sh
MORONS_FIXTURE_DB=/private/path/morons.sqlite MORONS_OWNER_TOKEN='replace-with-random-32-plus-character-token' npm start
```

The server binds `127.0.0.1:8787` by default. `PORT` changes the port. All routes require `Authorization: Bearer <owner token>`:

In another local shell, the GPUI client can use the named fixture contract:

```sh
cd apps/desktop
MORONS_BACKEND_MODE=named MORONS_BACKEND_URL=http://127.0.0.1:8787 MORONS_BACKEND_TOKEN='same-owner-token' cargo run
```

The first connection creates a `repo` moron and its first durable session if
the catalog is empty. The client can select other named morons created through
the API. This local bearer is not a multi-device account session.

* `GET /v1/fixture/status`
* `GET /v1/fixture/history`
* `POST /v1/fixture/chat` with JSON `{ "requestId": "UUID", "text": "Hello" }`
* `GET /v1/models` with fixture model metadata
* `GET /v1/morons`; `POST /v1/morons` with `{ "id": "repo", "name": "Repo", "rules": "...", "preferences": "..." }`
* `POST /v1/morons/:id/memory` with `{ "id": "decision-one", "text": "Use isolated branches." }` to record an immutable named-moron decision visible in that moron's sessions
* `GET /v1/morons/:id/sessions`; `POST /v1/morons/:id/sessions` with `{ "id": "repo-main" }`
* `GET /v1/sessions/:id/history`; `POST /v1/sessions/:id/chat` with `{ "requestId": "UUID", "text": "Hello" }`

The named session routes use the local OptChat SQLite tree: assistant entries are ingested with stable Pi entry references, retrieved only within the same session, and supplied as bounded context on the next turn. Explicit named-moron decisions are visible across that moron's sessions while staying isolated from other morons. A deterministic fixture model echoes that context in its response; real provider integration still needs a full prompt and tool review. A leading `@moron-id question` creates a durable, isolated target session, sends only the bounded question, and records an attributed answer in the owning session. There is no general multi-agent planner or automatic sharing beyond this explicit syntax.

This fixture does not implement Morons account login, real model credentials, or a trusted code runner. Exposing it to other devices requires a separate authenticated TLS ingress and account/session design. Do not copy model credentials into this process or the runner.

The server creates an exclusive `.owner.lock` file before opening Pi storage and removes it on clean shutdown. If a process crashes, the stale lock blocks restart; an operator must verify no process owns the database before manually removing that lock. Harness checkpoints can replay work on restart; side effects outside the harness need their own idempotency and reconciliation boundary. Chat request IDs and persisted text reservations reconcile the fixture's own crash window.
