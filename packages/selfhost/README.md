# Self-hosted Morons, local Mac tryout

The local Mac app uses Pi Durable 1.2, OptChat, and a deterministic offline
model. It makes no provider login or inference calls by itself. Build from this
checkout, then open the desktop app without backend environment variables:

```sh
cd packages/selfhost
npm ci
cd ../../apps/desktop
cargo run --locked
```

The app opens to **Sign in**, with **Sign up** for a new local account. Enter a
username and a password of at least 12 characters, then select **Sign up**.
This action starts a loopback-only local account server, establishes a private
owner secret, creates the account and its Personal workspace, and signs in.
No setup code needs to be copied. The app does not create local credentials or
start the server before Sign up or Sign in is selected. The password is masked.
For a returning account, select **Sign in**. The 30-day device token stays in
app memory and is revoked by **Sign out**; sign in again after an app restart.
The server stores only a hash of each device token. Each account has separate
Pi Durable and OptChat SQLite files.

After sign-in, **Enable provider storage** explicitly creates a private
encryption key and restarts the local server. It does not start ChatGPT sign-in.
The model menu offers **Set up provider** for a separate human-triggered
connection. The offline model remains available throughout. No real OAuth or
paid model call was made while building this branch.

## Separate account server

Operators who run the account server separately must supply an owner-private
bootstrap token file. This path retains the setup-code boundary for remote or
separately managed enrollment.

```sh
umask 077
mkdir -p "$HOME/.local/share/morons" "$HOME/.config/morons"
openssl rand -base64 48 > "$HOME/.config/morons/bootstrap"
MORONS_DATA_DIR="$HOME/.local/share/morons" \
MORONS_BOOTSTRAP_TOKEN_FILE="$HOME/.config/morons/bootstrap" \
npm run start:account
```

Launch GPUI with `MORONS_BACKEND_MODE=named` and the account server's HTTPS
origin, or its loopback HTTP origin. This separate-server first enrollment
still requires the operator's setup code in GPUI.

The repository moron is enabled only when an operator supplies
`MORONS_REPOSITORY` and a comma-separated exact `MORONS_SOURCE_PATHS` allowlist
to the server. `/source PATH` reads an approved committed blob. `/review`
followed by a unified diff commits a proposal on an isolated branch, runs
fixed `git diff --check`, and displays the diff for human review. Approval and
rejection are records only; neither applies, merges, pushes, or deploys.
The runner is credential-free and macOS network-denied, but its filesystem
access is not sufficiently confined for untrusted code. It is unavailable on
other server platforms pending a comparable boundary.

`/viz` displays a deterministic, server-sealed chart. Real model output can
supply the same bounded `morons.visualization.v1` data format. Every read
checks account, session, source message, and source revision before issuing a
five-second display lease. GPUI drops the display on logout or refresh failure.

## Optional ChatGPT provider setup

The account server can use Pi 1.2's current **Sign in with ChatGPT** OAuth
provider. This is opt-in and was tested with mock responses only; no real
login or paid inference was used while building this branch. Before enabling
it, create a separate 32-byte key in an owner-private location and set
`MORONS_PROVIDER_KEY_FILE` to that absolute path when starting the server. The
server checks file ownership and permissions, derives a separate key per
account, and stores Pi credentials encrypted in each account directory. The
key's bytes do not appear in argv, logs, or the GPUI client.

For a human Mac tryout of the login handoff while keeping chat offline, stop
the first server, then start it with a new private key file:

```sh
umask 077
openssl rand 32 > "$HOME/.config/morons/provider-key"
MORONS_DATA_DIR="$HOME/.local/share/morons" \
MORONS_BOOTSTRAP_TOKEN_FILE="$HOME/.config/morons/bootstrap" \
MORONS_PROVIDER_KEY_FILE="$HOME/.config/morons/provider-key" \
npm run start:account
```

Launch GPUI with the same `MORONS_BACKEND_URL` command above. Connect in the
app only when ready to complete the provider's browser flow. The app does not
place the account password, bootstrap code, provider key, callback code, or
device token in command-line arguments. It does not persist the device token;
the app asks for account sign-in on restart. The account database stores
scrypt password hashes and SHA-256 device-token hashes. If login is completed,
Pi's provider credential is stored in the account-private
`accounts/<account-id>/provider.credentials` file, encrypted with AES-256-GCM
using a key derived from the external provider-key file; the latter is never
copied into the account directory.

Adding the key exposes login controls but keeps chat on the offline fixture.
After signing in, choose an available model from the GPUI composer. The server
checks Pi's authenticated catalog and stores each durable session's choice.
`MORONS_PROVIDER_MODEL_ID` can still set a server default, but is not required
for interactive selection. Pi's catalog does not remotely verify each model's
account entitlement, so a chosen real model may fail on the first call. No
actual provider login or paid model call was made during development.

GPUI starts OAuth only when a person selects **Set up provider** and starts
ChatGPT sign-in. It opens the
Pi-generated `auth.openai.com` URL in a browser only when the person presses
the browser button. Pi runs its loopback callback on port 1455 on the server
Mac. If the browser cannot reach it, the person can paste the final redirect
URL into GPUI. Callback codes and provider tokens are never returned by the
status route. The provider can be cancelled or disconnected from GPUI.
Provider status is reconciled from local credential metadata on restart; it
does not verify remote token validity. With a real provider selected,
repository tools require the container runner described below; ordinary chat
can use the selected model after sign-in. A hard
crash can leave the encrypted credential-store owner lock. Verify the former
process is stopped before manually clearing that lock.

## Real-model repository runner

The model receives repository read and proposal tools only when the operator
sets `MORONS_REPOSITORY`, `MORONS_SOURCE_PATHS`, `MORONS_RUNNER_IMAGE`, and
`MORONS_REVIEW_CHECK_PROFILE`. The supported profiles are `review-runner` and
`optchat`. Each accepts exact allowlisted files only under its package's
`src/` directory, keeps its check script outside the edit allowlist,
and runs `git diff --check` plus that package's fixed syntax check on the
candidate checkout. The same checks rerun after intent recovery. Other paths
or an absent/mismatched profile fail closed. The dependency-heavy self-host
backend and GPUI need separately provisioned dependencies and check policies.
The image must already be installed locally, be named by an immutable
`@sha256:` digest, and contain Node 22+ and Git. The server never pulls an
image or starts a container engine. At startup it probes the engine and image,
then checks file, symlink, environment, network, subprocess escape, and
approval-write boundaries in a disposable container. Startup fails if a probe
fails. A real model without this verified runner has no repository tools.

The Docker Desktop workspace is provisioned once per administrator account and
reconnected across source reads. Each proposal has a separate persistent
container, home, and review directory, stopped after its review operation and
reconnected for recovery. Server shutdown stops the account container while
the private files remain on disk. A proposal cannot mount another proposal's
home or review directory. The worker container mounts the source repository
read-only and its own code read-only. It has no provider
credentials, account database, or Docker socket; network is disabled. It
clones committed source into the review directory, creates a proposal branch
there, applies only allowlisted paths, runs the fixed checks, and
returns a diff for human review. It cannot merge, push, apply to the running
app, or change review decisions. The operator must review the image and the
source-path allowlist; an approved path may itself contain private source.
The server rejects a private data directory nested inside the source (or the
reverse), including symlink aliases. The CLI also rejects bootstrap and
provider-key files located in the source. For now the source must have an embedded
`.git` directory; linked worktrees are rejected because their Git metadata
points outside the read-only source mount. Review intents pin the source base
commit so recovery still works if the source branch advances.

The CLI explicitly targets Docker Desktop's `desktop-linux` context and does
not change the operator's current Docker context. On this Mac the official
`node:22.23.3-bookworm` arm64 image is installed at
`docker.io/library/node@sha256:80503c2cadca910dfe16f1516025a2133cdfb0e839f02e79191f83548f2ec729`.
Its local runtime has Node 22.23.3 and Git 2.39.5. The boundary probe and a
two-proposal lifecycle smoke passed with disposable source and worker copies
under `/tmp`. Docker Desktop timed out after 20 seconds when mounting the
checkout's worker path under Documents, so direct checkout access still needs
file-sharing diagnosis. No Docker Desktop sharing setting was changed. The
image used about 402 MB of compressed layers; no custom image
build was needed.
The persistent computer lifecycle follows Rakazo's provider model; this
implementation currently supports repository read and isolated proposals,
not Rakazo's browser, desktop, or file-transfer actions. See
https://github.com/elie222/rakazo/blob/main/docs/computer-runtime.md and
https://github.com/elie222/rakazo/blob/main/LICENSE.
For another checkout, confirm Docker Desktop can mount both the source and
worker paths before starting the server with this digest, an approved check
profile, and an exact source-path list. No real login or paid inference is
needed for the boundary check.

A separate authenticated TLS ingress and remote-device testing are required
before use from other devices. The native Windows and iPhone clients remain
later platform milestones. `node --experimental-strip-types scripts/demo-server.mjs`
starts a disposable offline account, review, and chart for local visual QA;
it prints only the URL and temporary directory, and removes them on Ctrl-C.
