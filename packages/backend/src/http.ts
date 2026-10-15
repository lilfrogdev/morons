import { VERSION, LIMITS, type Submit } from "../../protocol/index";
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function failure(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { version: VERSION, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function authorized(
  request: Request,
  token?: string,
): Promise<boolean> {
  if (!token || token.length < 32 || token.length > 256) return false;
  const supplied = request.headers.get("Authorization");
  if (!supplied || supplied.length > 264) return false;
  // Compare fixed length digests so a matching prefix does not affect timing.
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([
    digest(supplied),
    digest(`Bearer ${token}`),
  ]);
  const x = new Uint8Array(a),
    y = new Uint8Array(b);
  let different = 0;
  for (let i = 0; i < x.length; i++) different |= x[i] ^ y[i];
  return different === 0;
}
export async function readJsonBody(
  request: Request,
  allowEmpty = false,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader && allowEmpty) return undefined;
  if (!reader)
    throw new HttpError(400, "invalid_request", "A JSON body is required.");
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new HttpError(
          408,
          "request_timeout",
          "Request body deadline exceeded.",
        ),
      );
      void reader.cancel();
    }, 10000);
  });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new HttpError(413, "input_limit", "Request body is too large.");
      }
      parts.push(value);
    }
  } finally {
    clearTimeout(timeout!);
    reader.releaseLock();
  }
  let body: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (allowEmpty && !text.trim()) return undefined;
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid JSON.");
  }
  return body;
}
export async function submitBody(request: Request): Promise<Submit> {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new HttpError(415, "content_type", "Expected application/json.");
  const body = await readJsonBody(request);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "invalid_request", "Invalid submission.");
  const data = body as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(",") !== "requestId,text" ||
    typeof data.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      data.requestId,
    ) ||
    typeof data.text !== "string" ||
    !data.text.trim() ||
    new TextDecoder().decode(new TextEncoder().encode(data.text)) !== data.text
  )
    throw new HttpError(
      400,
      "invalid_request",
      "Expected a lowercase UUID requestId and nonempty text.",
    );
  if (new TextEncoder().encode(data.text).byteLength > LIMITS.maxInputBytes)
    throw new HttpError(413, "input_limit", "Input exceeds 8192 UTF-8 bytes.");
  return { requestId: data.requestId, text: data.text };
}

export async function stopBody(request: Request): Promise<void> {
  const body = await readJsonBody(request, true);
  if (
    body !== undefined &&
    (!body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 0)
  )
    throw new HttpError(
      400,
      "invalid_request",
      "Stop accepts an empty body or empty JSON object.",
    );
}
