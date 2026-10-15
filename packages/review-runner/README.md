# Isolated review runner

`prepareReview` accepts a patch against a repository's committed `HEAD` from a
trusted caller. It checks exact approved paths, creates a `morons-review/<id>`
branch in a separate worktree, runs the caller's fixed checks, and commits the
proposal on that branch. The source checkout, including its uncommitted work,
is left intact. The runner does not push, merge, deploy, or apply an approved
proposal to the running application.

The self-hosted server gives the runner an account-private `reviewRoot`, saves
an intent before invoking it, and retries unfinished intents after restart.
The runner can reuse the same branch and patch after a retry. Failed or
unexpected worktree states remain for operator inspection.

`readSourceAtHead` returns one bounded committed text file from an exact
operator allowlist. Review the list before use: committed files can still
contain private material. The model supplies only a patch or one allowed path;
the repository, branch, storage root, and check commands are trusted inputs.

The macOS worker runs separately without provider credentials and under a
no-network `sandbox-exec` profile. This profile does not confine filesystem
reads; only the offline fixture uses it. A real-model repository session
requires the separately verified container runner described in
`packages/selfhost/README.md`. In that mode the worker clones committed source
under the account's review directory so the source checkout and its Git
metadata remain read-only. The connected server uses only a fixed
`git diff --check` check.
