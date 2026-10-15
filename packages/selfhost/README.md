# Self-hosted Morons, local Mac tryout

The default account server uses Pi Durable 1.2, the OptChat port, and a
**deterministic offline model**. It makes no provider login or inference calls.
The server binds `127.0.0.1` only. Build from this checkout:

```sh
cd packages/selfhost
npm ci
npm test
```

Create a private data directory and first-account setup code. The code is read
from a file, not a command-line argument or log. Keep the file private and
paste its contents into the GPUI setup field when asked.

```sh
umask 077
mkdir -p "$HOME/.local/share/morons" "$HOME/.config/morons"
openssl rand -base64 48 > "$HOME/.config/morons/bootstrap"
MORONS_DATA_DIR="$HOME/.local/share/morons" \
MORONS_BOOTSTRAP_TOKEN_FILE="$HOME/.config/morons/bootstrap" \
npm run start:account
```

In another terminal, launch the Mac app without a bearer or password on its
command line:

```sh
cd apps/desktop
MORONS_BACKEND_MODE=named MORONS_BACKEND_URL=http://127.0.0.1:8787 cargo run
```

Choose an account name and a password of at least 12 characters in GPUI. For
the first account, enter the setup code and select **Create first account**,
then **Sign in**. The password field is masked. The 30-day device token stays
in app memory and is revoked by **Sign out**; sign in again after an app restart.
The server stores only a hash of each device token. Each account has separate
Pi Durable and OptChat SQLite files.

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
`src/` directory, keeps its test script and tests outside the edit allowlist,
and runs `git diff --check` plus that package's Node test suite on the
candidate checkout. The same checks rerun after intent recovery. Other paths
or an absent/mismatched profile fail closed. The dependency-heavy self-host
backend and GPUI need separately provisioned dependencies and check policies.
The image must already be installed locally, be named by an immutable
`@sha256:` digest, and contain Node 22+ and Git. The server never pulls an
image or starts a container engine. At startup it probes the engine and image,
then checks file, symlink, environment, network, subprocess escape, and
approval-write boundaries in a disposable container. Startup fails if a probe
fails. A real model without this verified runner has no repository tools.

The worker container mounts the source repository read-only, its own code
read-only, and the account's review directory writable. It has no provider
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

On this Mac, Docker and Colima are installed but the Colima profiles are
stopped, so no local runner image or digest could be inspected. A proposed
upstream is the official `docker.io/library/node:22.23.3-bookworm` arm64 tag,
whose buildpack-deps base includes Git. After permission to start Colima and
pull the image, inspect its local `RepoDigests` and select its immutable
`docker.io/library/node@sha256:...` reference; never substitute a guessed
digest. The proposed commands are `colima start default`,
`docker pull --platform linux/arm64 docker.io/library/node:22.23.3-bookworm`,
and `docker image inspect docker.io/library/node:22.23.3-bookworm --format '{{json .RepoDigests}}'`.
Starting Colima uses its configured four CPUs, 8 GiB RAM limit, and 30 GiB
virtual disk; the image pull consumes network bandwidth and space in that
disk. No custom image build is needed for the two dependency-free profiles.
Then run `npm test` with `MORONS_TEST_RUNNER_IMAGE` set to that digest and
inspect the live boundary test result. Only after it passes should
`MORONS_RUNNER_IMAGE` be added to the server launch environment together with
an approved check profile and exact source-path list. No real login or paid
inference is needed for this boundary test.

A separate authenticated TLS ingress and remote-device testing are required
before use from other devices. The native Windows and iPhone clients remain
later platform milestones. `node --experimental-strip-types scripts/demo-server.mjs`
starts a disposable offline account, review, and chart for local visual QA;
it prints only the URL and temporary directory, and removes them on Ctrl-C.
