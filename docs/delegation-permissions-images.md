# Repository implementation, permissions, and images

Repository coordinating Morons expose `delegate_implementation`. Each call pins
the registered repository, workspace, committed base, path allowlist, fixed
check policy, and proposal ID. A separate Pi Durable conversation inherits the
coordinator's model and reasoning setting. It has ordinary Pi compaction and
only isolated proposal read, replace-file, and fixed-check tools. Its tools
operate in the existing digest-pinned Docker runner. Provider credentials stay
outside that container. Implementation sessions are hidden from ordinary
thread APIs and cannot access OptChat, other Morons, or source application.
The coordinating repository Moron retains repository-scoped OptChat.

The implementation result contains the full sealed diff, checks, proposal
commit, and SHA-256. The main Moron must inspect it and call
`review_implementation` with those exact identifiers and an assessment. Only
then is a human review published. Approving that review records the decision.
**Apply reviewed changes** requests a separate exact-action approval. After
that approval, the trusted server checks the same base, clean source/index,
allowlisted paths, and main-review hash, then applies and stages the patch.
It creates no source commit and does not push, deploy, or update a running app.
Changed source HEAD or local edits stop application. Interrupted application
requires inspection and a fresh approval; it is never silently retried.

Stopping a session aborts delegated work and invalidates pending admissions and
tool grants. Steering goes to the active implementation as well as its main
conversation. Terminal child failure is recorded and cannot receive later
steering. Restart recovery reacquires operation grants. Usage includes the
child's persisted assistant calls under `implementation`; compaction summaries
and attempts without assistant entries are not yet attributed in time filters,
so the usage view identifies its totals as partial.

## Permission modes

The reference is official T3 Code revision
`2fbd4318fc5b610c3e7fcfcbd5bbd80b73521d8f`:
[mode defaults](https://github.com/pingdotgg/t3code/blob/2fbd4318fc5b610c3e7fcfcbd5bbd80b73521d8f/packages/contracts/src/providerPolicy.ts#L25-L32),
[Pi tool gate](https://github.com/pingdotgg/t3code/blob/2fbd4318fc5b610c3e7fcfcbd5bbd80b73521d8f/packages/provider-pi/src/server/mcpExtensionSource.ts#L317-L338),
and [mode documentation](https://github.com/pingdotgg/t3code/blob/2fbd4318fc5b610c3e7fcfcbd5bbd80b73521d8f/docs/user/permission-modes.md).

New threads default to **Full access**. Existing threads without a stored mode
retain **Supervised** behavior. The selected mode is stored for that thread.
Trusted reads run without a prompt in every mode. Supervised asks before edits
and commands. Auto-accept edits allows isolated file replacements and asks
before fixed checks. Auto follows Supervised because Pi has no automatic risk
reviewer. Full access allows those configured commands and isolated edits
without prompts. Every source application and separately billed image request
still needs explicit approval. The main repository review is always required.

An operation freezes its mode, policy revision, and canonical action. Approval
binds its session, workspace, repository, proposal/base when applicable, and
complete action fingerprint. More permissive changes do not expand an active
grant. Stricter changes stop privileged work; pending approvals are invalidated
on any mode change, Stop, logout, timeout, or restart. Mode selection cannot
install credentials or grant new Docker mounts, network, OS, or cloud access.
T3's provider-specific host sandbox modes and project-default overrides are
not implemented by this selector; Morons keeps its configured Docker boundary.

## Generated images

Ordinary main Morons expose `generate_image`. Repository coordinators,
implementation agents, and handoff sessions do not receive it. PNG assets and
metadata are stored in an account-private database with account, workspace,
Moron, session, and tool-call binding. GPUI loads scoped previews and offers
Open, Save PNG, and cancellation. Saving uses the native destination picker
and refuses to overwrite an existing file. Switching account/session or a
failed authorization refresh clears client assets.

ChatGPT plan OAuth does not support image generation:
[official preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
The implementation uses the separate OpenAI Images API with model
`gpt-image-2.5-sunburst`. Operators can provide `MORONS_IMAGE_OPENAI_API_KEY` to
the server and set `MORONS_IMAGE_ACCOUNT_ID` to its intended account ID. Both
must be present and match; OAuth credentials are never used as a fallback.
No key has been configured by development. Every request shows its exact
prompt, model, size, and quality for approval before an external call. Images
use separately billed API usage. Cancellation can stop local work but cannot
guarantee that a request already received by the provider will avoid charges;
interrupted outcomes remain uncertain and are not automatically retried.

## Remaining live setup

Disposable validation used synthetic in-process Pi model streams, mocked
image HTTP responses, and the already installed Docker image. No real model
inference, image generation, OAuth, credential setup, image pull, or publishing
was performed. A real coding run still needs a human-selected available model,
an explicit repository registration, the configured local digest-pinned runner,
and the user's permission/review decisions. A real image run additionally needs
the separately configured account-bound API key and provider access to the
image model. Provider entitlement, remote output quality, real compaction, and
real image billing have not been exercised.
