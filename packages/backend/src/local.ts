import { RootChat as BaseRoot } from "./root";
import { mockModels } from "./mock-model";
import { worker, type Env } from "./worker";
import { authorized, json, failure } from "./http";
import { publicConfiguration } from "./provider-configuration";
export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname !== "/v1/provider/configuration")
      return worker.fetch(request, env);
    if (!(await authorized(request, env.AUTH_TOKEN)))
      return failure(
        401,
        "unauthorized",
        "Valid bearer authentication is required.",
      );
    if (request.method !== "GET")
      return failure(
        405,
        "method_not_allowed",
        "Use GET for provider configuration.",
      );
    return json(publicConfiguration(env, true));
  },
};
// Separate entry point: production configuration cannot enable the mock provider.
export class RootChat extends BaseRoot {
  protected createModels() {
    return mockModels();
  }
  protected configured() {
    return true;
  }
}
