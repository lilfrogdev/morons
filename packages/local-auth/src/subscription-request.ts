import type { Identity } from "./index";
export class RequestError extends Error {
  constructor() {
    super("Subscription request validation failed.");
    this.name = "RequestError";
  }
}
export interface VisibleModel {
  slug: string;
  displayName: string;
}
export interface Catalog {
  models: readonly VisibleModel[];
  toJSON(): { type: string };
}
const catalogs = new WeakMap<Catalog, { identity: Identity; at: number }>();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new RequestError();
  return value;
}
function same(a: Identity, b: Identity) {
  return (
    a.issuer === b.issuer &&
    a.subject === b.subject &&
    a.clientId === b.clientId
  );
}
// A future trusted adapter must obtain this body from the official /v1/models
// endpoint under the stated verified registration. No network is performed here.
export function parseCatalog(body: unknown, identity: Identity): Catalog {
  try {
    if (
      identity.issuer !== "https://auth.openai.com" ||
      !identity.subject ||
      !identity.clientId ||
      identity.clientId === "dynamic_agent_client"
    )
      throw new RequestError();
    const source = object(body).models;
    if (!Array.isArray(source) || source.length > 256) throw new RequestError();
    const seen = new Set<string>();
    const models: VisibleModel[] = [];
    for (const item of source) {
      const model = object(item);
      const slug = text(model.slug, 128);
      if (!/^[A-Za-z0-9._:-]+$/.test(slug) || seen.has(slug))
        throw new RequestError();
      seen.add(slug);
      if (model.visibility === "list")
        models.push(
          Object.freeze({ slug, displayName: text(model.display_name, 256) }),
        );
    }
    const catalog = Object.freeze({
      models: Object.freeze(models),
      toJSON: () => ({ type: "subscription_catalog" }),
    });
    catalogs.set(catalog, { identity: { ...identity }, at: Date.now() });
    return catalog;
  } catch {
    throw new RequestError();
  }
}
export interface HistoryMessage {
  role: "developer" | "user" | "assistant";
  content: string;
}
// A narrow payload constructor, not a provider adapter or authorization to call.
// Models are explicitly selected from a fresh account-bound catalog. This first
// contract handles text history only; tool round trips require a later extension.
export function buildSubscriptionRequest(options: {
  catalog: Catalog;
  identity: Identity;
  model: string;
  instructions: string;
  input: readonly HistoryMessage[];
}) {
  try {
    const keys = Object.keys(options).sort().join(",");
    if (keys !== "catalog,identity,input,instructions,model")
      throw new RequestError();
    const binding = catalogs.get(options.catalog);
    if (
      !binding ||
      !same(binding.identity, options.identity) ||
      Date.now() < binding.at ||
      Date.now() - binding.at > 300000 ||
      !options.catalog.models.some((model) => model.slug === options.model)
    )
      throw new RequestError();
    const instructions = text(options.instructions, 65536);
    if (
      !Array.isArray(options.input) ||
      options.input.length < 1 ||
      options.input.length > 256
    )
      throw new RequestError();
    const input = options.input.map((message) => {
      if (
        Object.keys(message).sort().join(",") !== "content,role" ||
        !["developer", "user", "assistant"].includes(message.role)
      )
        throw new RequestError();
      return { role: message.role, content: text(message.content, 65536) };
    });
    const payload = {
      model: options.model,
      instructions,
      input,
      store: false,
      stream: true,
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 262144)
      throw new RequestError();
    return payload;
  } catch {
    throw new RequestError();
  }
}
