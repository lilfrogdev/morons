# Isolated review runner

`prepareReview` is a trusted-caller API for proposed repository changes. It
creates `morons-review/<id>` from the repository's committed `HEAD` in a new
temporary Git worktree, applies a bounded patch, runs caller-selected checks,
and returns the diff and check output. It never commits, pushes, merges, or
edits the source checkout. Existing uncommitted source work stays in place and
is explicitly reported as `sourceDirty`.

The repository path, branch name, and check command list must come from a
human-approved plan, not from model text. The model may propose only the patch.
The caller owns review-branch cleanup after the human has inspected it. A
failed patch removes its temporary worktree; a successful review retains it.

This module is not an OS sandbox. A check command can read whatever its process
account can read, and Git hooks or repository content may be hostile. Run it
in a separate, restricted account/container with no Morons server credentials,
provider tokens, or production repository write grants before connecting it to
an agent. External effects need separate operation IDs and reconciliation on
uncertain completion. No application route currently invokes this module.
