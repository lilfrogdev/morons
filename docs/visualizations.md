# Visualization boundary

`packages/visualization` is a portable contract for visual answers. Accepted model payloads are bounded bar charts, line charts, tables, and a small structured document tree. Document nodes use a fixed text/tag vocabulary; no arbitrary attributes, JavaScript, HTML, CSS, SVG, URLs, or callbacks are accepted. A source response without a valid document remains ordinary text.

The backend must call `parseDraft` on untrusted output, verify the source assistant message belongs to the active thread/account, then call `sealDocument` with **server-derived** identity, message revision, ID, and timestamp. Do not accept the origin fields from the model or client. Persist the sealed document and its revocation status in the single storage-owner process.

Every list, fetch, stream replay, and export needs a fresh authorization check. Load the current authenticated account, thread owner, source message and revision, and revocation status from storage. Pass those values to `canReadDocument`; deny on false. On source deletion, replacement, thread transfer, logout, or explicit document revocation, the next read must fail. Do not treat a previously issued URL or client cache as authority. Responses should use `Cache-Control: no-store`.

The server must send a bounded envelope with account, thread, access epoch, and a lease of at most five seconds. `parseEnvelope` rejects cross-scope documents. `VisualizationLease` holds only an ephemeral display copy and clears it on account/thread/epoch mismatch, expiry, or failed refresh. The desktop has the same lease and closed-shape checks in `apps/desktop/src/visualization.rs`, plus a `render_native` helper using GPUI primitives. The chat view must still request authorized envelopes and clear its lease on logout, context change, reconnect failure, and authority errors. All strings enter GPUI as text, not markup. Numeric axes come from trusted code using finite values.

## Source and attribution

The relevant Pitcrew implementation is in `/Users/lilfrogdev/Documents/Codex/2026-10-06/task-6/pitcrew-visualization-poc`, HEAD `ed4f955`, with initial signed commit `2ccd63e`. Pitcrew is Apache-2.0. Its `packages/protocol/src/visualizations.ts`, worker visualization store/API/authority gate, and web controller informed the closed node vocabulary, complexity limits, provenance checks, and short-lived revocable display lease here. The native Morons schema and lease code are adaptations, not copied React or iframe code. Pitcrew's source states its implementation was original and that T3 source was studied, not copied. Preserve Pitcrew's Apache-2.0 attribution when distributing adapted source.

## Integration status

This package has no backend route or chat-view hookup yet; the Rust module parses a verified response, enforces a short display lease, and can render the data with GPUI primitives. It does not provide Morons account login or model-provider login. The existing backend bearer credential is insufficient for multiple account/thread permissions. Route integration must check current session, thread membership, source revision, and revocation both before and after async reads, and serialize authority changes with publication. A model may only submit content through an admitted turn; public creation must remain disabled. No browser cookies or existing ChatGPT credentials should be imported.
