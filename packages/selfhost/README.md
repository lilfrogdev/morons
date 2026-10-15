# Self-hosted Node fixture

This is an offline Pi Durable integration slice, not the production Morons backend. It opens one SQLite database with one Node process, exposes authenticated fixture chat, and persists the Pi transcript across restart. Its only model is a deterministic local fixture. It cannot contact an inference provider.

Node 22.19+ is required. The package declares its own dependencies for a later install. In this repository's current checkout, the same versions are already present under `packages/backend/node_modules`; the test command reuses them through a test-only resolver without installing anything:

```sh
cd packages/selfhost
npm test
```

To preview from this checkout without installing dependencies, start it with the same test-only resolver. Use a private database path and a fresh random owner token of at least 32 characters:

```sh
MORONS_FIXTURE_DB=/private/path/morons.sqlite MORONS_OWNER_TOKEN='replace-with-random-32-plus-character-token' node --import ./test/use-existing-deps.mjs src/server.mjs
```

After dependencies are installed for this package, the ordinary startup command is:

```sh
MORONS_FIXTURE_DB=/private/path/morons.sqlite MORONS_OWNER_TOKEN='replace-with-random-32-plus-character-token' npm start
```

The server binds `127.0.0.1:8787` by default. `PORT` changes the port. All routes require `Authorization: Bearer <owner token>`:

* `GET /v1/fixture/status`
* `GET /v1/fixture/history`
* `POST /v1/fixture/chat` with JSON `{ "requestId": "UUID", "text": "Hello" }`

This fixture does not implement the GPUI root snapshot/events protocol, named morons, OptChat, account login, credentials, or a trusted code runner. Exposing it to other devices requires a separate authenticated TLS ingress and account/session design. Do not copy model credentials into this process or the runner.

Pi Durable's SQLite adapter has no cross-process lock. Operate only one storage-owner process per database file. Harness checkpoints can replay work on restart; side effects outside the harness need their own idempotency and reconciliation boundary.
