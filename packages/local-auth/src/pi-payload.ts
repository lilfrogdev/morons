import { RequestError } from "./subscription-request.js";
const TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "reasoning",
]);
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError();
  return value as Record<string, unknown>;
}
function str(value: unknown, max = 65536): string {
  if (typeof value !== "string" || value.length > max) throw new RequestError();
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RequestError();
}
// Final wire firewall after Pi has assembled/converted the transcript. Native
// web search is an account/model-policy capability, not universally unsupported;
// a bounded follow-on can extend tool/citation events here. tool_search and
// computer use must remain distinct and cannot enter through arbitrary objects.
export function subscriptionPayload(raw: unknown, selectedModelId: string) {
  const source = obj(raw);
  keys(source, [
    "model",
    "input",
    "store",
    "stream",
    "tools",
    "tool_choice",
    "reasoning",
    "include",
  ]);
  if (
    source.model !== selectedModelId ||
    source.store !== false ||
    source.stream !== true ||
    !Array.isArray(source.input) ||
    source.input.length > 256 ||
    !source.input.length
  )
    throw new RequestError();
  const input = source.input.map((rawItem) => {
    const item = obj(rawItem);
    const type = item.type ?? "message";
    if (typeof type !== "string" || !TYPES.has(type)) throw new RequestError();
    if (type === "message") {
      keys(item, ["type", "role", "content", "id", "status"]);
      const role = item.role === "system" ? "developer" : item.role;
      if (!["developer", "user", "assistant"].includes(role as string))
        throw new RequestError();
      const content =
        typeof item.content === "string"
          ? str(item.content)
          : Array.isArray(item.content) && item.content.length <= 128
            ? item.content.map((part) => {
                const p = obj(part);
                keys(p, ["type", "text", "annotations"]);
                if (!["input_text", "output_text"].includes(p.type as string))
                  throw new RequestError();
                // Previously displayed annotations are presentation metadata. A future
                // citation extension preserves them separately, not arbitrary tool input.
                return { type: p.type, text: str(p.text) };
              })
            : (() => {
                throw new RequestError();
              })();
      return { role, content };
    }
    if (type === "function_call") {
      keys(item, ["type", "id", "call_id", "name", "arguments", "status"]);
      const name = str(item.name, 64);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new RequestError();
      return {
        type,
        call_id: str(item.call_id, 256),
        name,
        arguments: str(item.arguments, 16384),
      };
    }
    if (type === "function_call_output") {
      keys(item, ["type", "call_id", "output", "id", "status"]);
      return {
        type,
        call_id: str(item.call_id, 256),
        output: str(item.output),
      };
    }
    keys(item, ["type", "id", "summary", "encrypted_content", "status"]);
    if (!Array.isArray(item.summary) || item.summary.length > 128)
      throw new RequestError();
    const summary = item.summary.map((part) => {
      const p = obj(part);
      keys(p, ["type", "text"]);
      if (p.type !== "summary_text") throw new RequestError();
      return { type: "summary_text", text: str(p.text) };
    });
    return {
      type,
      ...(item.id !== undefined ? { id: str(item.id, 256) } : {}),
      summary,
      ...(item.encrypted_content !== undefined
        ? { encrypted_content: str(item.encrypted_content) }
        : {}),
    };
  });
  const payload: Record<string, unknown> = {
    model: selectedModelId,
    input,
    store: false,
    stream: true,
  };
  if (source.tools !== undefined) {
    if (!Array.isArray(source.tools) || source.tools.length > 64)
      throw new RequestError();
    payload.tools = source.tools.map((rawTool) => {
      const tool = obj(rawTool);
      keys(tool, ["type", "name", "description", "parameters", "strict"]);
      if (
        tool.type !== "function" ||
        !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(str(tool.name, 64))
      )
        throw new RequestError();
      const parameters = obj(tool.parameters);
      if (
        parameters.type !== "object" ||
        Buffer.byteLength(JSON.stringify(parameters)) > 16384 ||
        (tool.strict !== undefined && typeof tool.strict !== "boolean")
      )
        throw new RequestError();
      return {
        type: "function",
        name: tool.name,
        parameters: structuredClone(parameters),
        ...(tool.description !== undefined
          ? { description: str(tool.description, 2048) }
          : {}),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      };
    });
  }
  if (source.tool_choice !== undefined) {
    if (!["auto", "none", "required"].includes(source.tool_choice as string))
      throw new RequestError();
    payload.tool_choice = source.tool_choice;
  }
  if (source.reasoning !== undefined) {
    const reasoning = obj(source.reasoning);
    keys(reasoning, ["effort", "summary"]);
    if (
      reasoning.effort !== undefined &&
      !["none", "minimal", "low", "medium", "high", "xhigh"].includes(
        reasoning.effort as string,
      )
    )
      throw new RequestError();
    if (
      reasoning.summary !== undefined &&
      !["auto", "concise", "detailed"].includes(reasoning.summary as string)
    )
      throw new RequestError();
    payload.reasoning = { ...reasoning };
  }
  if (source.include !== undefined) {
    if (
      !Array.isArray(source.include) ||
      source.include.some((value) => value !== "reasoning.encrypted_content")
    )
      throw new RequestError();
    payload.include = [...source.include];
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > 262144)
    throw new RequestError();
  return payload;
}
