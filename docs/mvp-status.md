# Morons MVP checkpoint

This branch is an incremental local development checkpoint. It does not yet
provide the complete repository-agent flow or a production self-hosted service.

## Working slices

- The existing Cloudflare-backed Pi root chat and GPUI Mac client remain usable
  with their existing configuration. No provider call is made by tests here.
- The backend now persists named moron definitions (rules and preferences),
  device-independent session metadata, and explicit, bounded handoff
  question/answer records. These records are not yet separate Pi conversations.
- The GPUI composer adopts Pitcrew's compact prompt layout. Its model panel is
  read-only; the attachment button says that backend support is pending.
- The visualization package validates data-only charts and tables and checks
  provenance and revocation at a future server read boundary. There is no
  visualization route or chart drawing yet.
- The review runner can create a branch worktree, apply a proposed patch, run
  trusted checks, and return a diff. No app route invokes it yet; it needs a
  restricted process boundary before agent access.

## Next connected slice

1. Upgrade and pin compatible Pi AI/Durable versions, then give each named
   moron its own durable conversation and OptChat coordination path. Keep
   temporary implementation agents on regular compaction.
2. Add Morons owner login and multi-device sessions independently of model
   provider login. For ChatGPT model access, use Pi's supported OpenAI OAuth
   integration with an encrypted, single-owner credential store. A human must
   initiate login; never import browser cookies or existing app credentials.
3. Expose a source-reading repository agent, then connect approved patch plans
   to the restricted review runner. Human review remains required for changes
   to the running application or default branch.
4. Connect visualization storage and native GPUI rendering only after account,
   thread, source-message, and revocation lookups exist on every read.

Windows GPUI support exists in the pinned upstream source, but this branch has
only been checked on Apple Silicon macOS. The native iPhone app will consume
the same authenticated backend contract later; GPUI desktop code is not an
iOS implementation.
