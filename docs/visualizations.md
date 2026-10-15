# Visualization boundary

`packages/visualization` is the first portable contract for visual answers. The only accepted model payloads are bounded bar charts, line charts, and tables. Labels and cells are plain text. A client renders them with trusted native GPUI components; it must never execute model-provided JavaScript, HTML, CSS, SVG, URLs, or callbacks. A source response without a valid document remains ordinary text.

The backend must call `parseDraft` on untrusted output, verify the source assistant message belongs to the active thread/account, then call `sealDocument` with **server-derived** identity, message revision, ID, and timestamp. Do not accept the origin fields from the model or client. Persist the sealed document and its revocation status in the single storage-owner process.

Every list, fetch, stream replay, and export needs a fresh authorization check. Load the current authenticated account, thread owner, source message and revision, and revocation status from storage. Pass those values to `canReadDocument`; deny on false. On source deletion, replacement, thread transfer, logout, or explicit document revocation, the next read must fail. Do not treat a previously issued URL or client cache as authority. Responses should use `Cache-Control: no-store`.

The desktop's `apps/desktop/src/visualization.rs` parses the same closed shapes and rejects a mismatched current account or thread. A GPUI renderer can map them to native bars/lines/table cells. Numeric axes must be computed by trusted code with bounded finite values. All strings must enter GPUI as text, not markup. The desktop should discard displayed documents when account/thread context changes and refetch after reconnect.

## Source and attribution

The inspected Pitcrew checkout at `/Users/lilfrogdev/Repositories/pitcrew` has an Apache-2.0 license. Its current tracked source includes server-assigned event provenance in `apps/worker/src/coordinator.ts` and source references in `packages/protocol/src/knowledge.ts`; this informs the provenance boundary here. No visualization renderer, structured visualization protocol, or t3codes attribution was present in the inspected Pitcrew branches, so this package is original code rather than a copied or ported renderer. If that implementation is found, review its license and compare its safeguards before reuse.

## Integration status

This package has no backend route or GPUI rendering yet; the Rust module only parses a verified response into native data. It does not provide Morons account login or model-provider login. The existing backend bearer credential is not sufficient to represent multiple account/thread permissions; route integration must provide the trusted storage lookups described above. No browser cookies or existing ChatGPT credentials should be imported.
