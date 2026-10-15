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

Adding the key exposes login controls but keeps chat on the offline fixture.
To select a real Pi model, also set `MORONS_PROVIDER_MODEL_ID` to a model ID in
Pi's installed OpenAI catalog. This operator choice may still fail if the
signed-in account lacks model access. No actual provider login or model call
was made during development.

GPUI starts OAuth only when a person presses **Connect ChatGPT**. It opens the
Pi-generated `auth.openai.com` URL in a browser only when the person presses
the browser button. Pi runs its loopback callback on port 1455 on the server
Mac. If the browser cannot reach it, the person can paste the final redirect
URL into GPUI. Callback codes and provider tokens are never returned by the
status route. The provider can be cancelled or disconnected from GPUI.
Provider status is reconciled from local credential metadata on restart; it
does not verify remote token validity. With a real provider selected,
repository tools are disabled until a stronger filesystem/process boundary
exists; ordinary chat can use the selected model after sign-in. A hard
crash can leave the encrypted credential-store owner lock. Verify the former
process is stopped before manually clearing that lock.

A separate authenticated TLS ingress and remote-device testing are required
before use from other devices. The native Windows and iPhone clients remain
later platform milestones. `node --experimental-strip-types scripts/demo-server.mjs`
starts a disposable offline account, review, and chart for local visual QA;
it prints only the URL and temporary directory, and removes them on Ctrl-C.
