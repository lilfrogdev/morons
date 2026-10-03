import { RootChat } from "./root";
import { publicConfiguration } from "./provider-configuration";
import { authorized, failure, json } from "./http";
export { RootChat };
export interface Env {
  ROOT: DurableObjectNamespace;
  AUTH_TOKEN?: string;
  OPENAI_API_KEY?: string;
  MODEL_ID?: string;
  PROVIDER_ID?: string;
  AUTH_MODE?: string;
  OPENCODE_API_KEY?: string;
}
export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await authorized(request, env.AUTH_TOKEN)))
      return failure(
        401,
        "unauthorized",
        "Valid bearer authentication is required.",
      );
    if (new URL(request.url).pathname === "/v1/provider/configuration") {
      if (request.method !== "GET")
        return failure(
          405,
          "method_not_allowed",
          "Use GET for provider configuration.",
        );
      return json(publicConfiguration(env));
    }
    if (!new URL(request.url).pathname.startsWith("/v1/root/"))
      return failure(404, "not_found", "Unknown endpoint.");
    const response = await env.ROOT.get(env.ROOT.idFromName("root")).fetch(
      request,
    );
    if (
      response.headers.get("Content-Type") !== "text/event-stream" ||
      !response.body
    )
      return response;
    // Bind the outer HTTP disconnect to cancellation of the DO response stream.
    const body = response.body.pipeThrough(new TransformStream(), {
      signal: request.signal,
    });
    return new Response(body, response);
  },
};
export default worker;
