# Morons local MVP status

This branch builds on the newer Pi-based `lilfrogdev/morons` application. The
older Rust CLI is excluded from reuse. The chosen clients are installed GPUI
Mac and Windows desktop applications, followed by a separate native iPhone
client. No PWA decision remains.

## Working offline path

A GPUI client with a Morons device-session bearer connects to the loopback
self-hosted server. The server maps that token to an account and opens that
account's own Pi Durable and OptChat SQLite files under one process owner.
Named morons have durable conversations, rules, preferences, same-session
OptChat context, explicit moron-level decisions, and scoped `@mention`
question/answer handoffs. Other account databases and other morons' private
session transcripts are not available through a session bearer.

The repository moron can use two synthetic Pi tool calls:

- `/source PATH` reads only an operator-allowlisted committed file from a
  configured repository, excluding its uncommitted working tree.
- `/review` followed by a unified diff commits on an isolated proposal branch,
  checks exact allowed patch paths, runs fixed `git diff --check`, and records
  the diff and check result. GPUI shows the review and lets a human record
  Approve or Reject. Either decision is a review record only; it never merges,
  deploys, or changes the running app.

The worker is a separate process without provider credentials. Its macOS
`sandbox-exec` profile denies network access. The current profile does **not**
confine all filesystem reads; deployment with untrusted repository content
still needs a stronger platform-specific runner boundary. The self-hosted
account server binds loopback only, for use behind a separately configured
authenticated TLS ingress. No external listener is opened by this branch.
Review intents are saved before branch creation and retried after restart;
unexpected worktree states remain for operator inspection. The review list is
bounded and the selected diff is fetched separately.

The first full backend acceptance test in `packages/selfhost/test/repository.test.mjs`
boots an account, logs in, exercises Pi source and review tools, records a
human decision, restarts, and verifies the decision persists while the source
checkout retains its HEAD and uncommitted edit. Separate tests cover two
account namespaces, two device sessions for one account, OptChat isolation,
request retries, interrupted review reconciliation, process-lock recovery,
concurrent bootstrap, login throttling, and `@mention` coordination. GPUI transport tests cover
review data and decision requests. A live macOS run also showed the chat,
diff, check result, and decision controls with a synthetic model; the captured
screenshot is a disposable QA artifact, not a production design qualification.

## Still required for real use

- Human-initiated ChatGPT login UI and credential handoff to Pi 1.2. The mock
  provider adapter and encrypted single-owner store are ready, but no live
  OAuth or paid inference was invoked.
- A native in-app Morons account login and private device-token storage. The
  account login API and expiring, revocable device sessions work; the current
  GPUI client receives its token through `MORONS_BACKEND_TOKEN`.
- A stronger filesystem sandbox for reviewing untrusted repositories, a
  trusted check plan beyond `git diff --check`, and an explicit reviewed apply
  or merge workflow. Approve currently records intent only.
- Windows build and UI qualification, TLS ingress and remote-device testing,
  and the separate native iPhone client.
- Model-backed OptChat compression and recall evaluation. This code is a port
  of OptChat v0.7.2, not an upstream package; revision and licenses are recorded
  in `docs/optchat.md` and `packages/optchat/NOTICE`.

The local branch is a tested synthetic flow, not an autonomous updater or a
production multi-device release.
