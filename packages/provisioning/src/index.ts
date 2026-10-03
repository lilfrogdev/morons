import crypto, { createHash, randomUUID } from "node:crypto";
import {
  parseSelection,
  validZenKey,
  zenModel,
  type ProviderSelection,
} from "../../backend/src/provider-selection.js";
export type CloudSelection = Extract<ProviderSelection, { host: "cloud" }>;
export function cloudSelection(value: unknown): CloudSelection {
  const selection = parseSelection(value);
  if (!selection || selection.host !== "cloud")
    throw new ProvisioningError("invalid_input", "preview");
  return freeze(selection);
}
export function providerRoute(selection: CloudSelection) {
  return selection.provider === "opencode"
    ? {
        endpoint: zenModel(selection.modelId)!.endpoint,
        secretBinding: "OPENCODE_API_KEY" as const,
      }
    : {
        endpoint: "https://api.openai.com/v1/responses",
        secretBinding: "OPENAI_API_KEY" as const,
      };
}

export type Account = Readonly<{ id: string; name: string }>;
export type Stage =
  | "accounts"
  | "preview"
  | "confirmation"
  | "bootstrap"
  | "upload"
  | "publish"
  | "status";
export type ErrorCode =
  | "invalid_input"
  | "credential_scope"
  | "unauthorized"
  | "permission_denied"
  | "rate_limited"
  | "cloudflare_error"
  | "network_error"
  | "invalid_response"
  | "worker_exists"
  | "subdomain_required"
  | "approval_required"
  | "preview_expired";

// Never attach raw provider messages, responses, requests, or exception causes.
export class ProvisioningError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly stage: Stage,
    public readonly writeState: "none" | "unknown" | "uploaded" = "none",
    public readonly httpStatus?: number,
    public readonly providerCodes: readonly number[] = [],
  ) {
    super(`${stage}: ${code}`);
    this.name = "ProvisioningError";
  }
}

export const tokenRequirements = Object.freeze({
  kind: "scoped-api-token",
  permissions: ["Account Settings Read", "Workers Scripts Write"],
  accountResources:
    "Only the explicitly chosen account(s); no All accounts or zone permissions.",
  scopeVerification:
    "The runtime must obtain user confirmation of token scope. Bearer verification and visible accounts do not prove the full permission policy.",
  credentialEntry:
    "Native masked entry after exact runtime approval; memory only. Persistence requires separate approval.",
});

// The host owns approved credential entry. No environment, filesystem, argv, or
// credential-store lookup occurs in this package. No global-key auth is supported.
export interface ScopedTokenSource {
  readonly kind: "scoped-api-token";
  readonly accountIds: readonly string[];
  withToken<T>(use: (token: string) => Promise<T>): Promise<T>;
}
export interface BootstrapSource {
  withSecrets<T>(
    use: (
      secrets: Readonly<{ AUTH_TOKEN: string; providerKey: string }>,
    ) => Promise<T>,
  ): Promise<T>;
}
export interface WorkerBundle {
  readonly mainModule: string;
  readonly modules: readonly Readonly<{ name: string; content: string }>[];
}
export interface DeploymentPreview {
  readonly id: string;
  readonly expiresAt: number;
  readonly account: Account;
  readonly workerName: string;
  readonly endpoint: string;
  readonly bundleSha256: string;
  readonly resources: readonly string[];
  readonly secretBindings: readonly string[];
  readonly modelId: string;
  readonly selection: CloudSelection;
  readonly providerEndpoint: string;
  readonly providerSecretBinding: "OPENAI_API_KEY" | "OPENCODE_API_KEY";
  readonly configurationSha256: string;
  readonly limits: Readonly<{
    workerCpuMs: null;
    policy: string;
    budgetCap: "none";
    accountUsage: "unknown";
  }>;
  readonly billing: Readonly<{
    plan: "unverified";
    changesSubscription: false;
    notice: string;
    workersPricing: string;
    durableObjectsPricing: string;
  }>;
  readonly tokenScopeVerified: false;
}
export interface DeploymentConfirmation {
  readonly previewId: string;
  readonly configurationSha256: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly acceptResourceCreation: true;
  readonly acknowledgeUsageBilling: true;
  readonly approveSecretUpload: true;
}
export type DeploymentResult = Readonly<{
  state: "deployed";
  accountId: string;
  workerName: string;
  endpoint: string;
  bundleSha256: string;
  configurationSha256: string;
}>;
type Envelope = {
  success: boolean;
  result: unknown;
  result_info?: { total_pages?: number };
  errors?: { code?: unknown }[];
};
type Plan = { preview: DeploymentPreview; bundle: WorkerBundle };
const accountPattern = /^[a-f0-9]{32}$/;
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const modulePattern = /^(?!\.)(?!.*(?:^|\/)\.\.?\/)[a-zA-Z0-9_./-]+\.m?js$/;
function invalid(stage: Stage): never {
  throw new ProvisioningError("invalid_input", stage);
}
function record(
  value: unknown,
  stage: Stage,
  writeState: "none" | "unknown" | "uploaded" = "none",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProvisioningError("invalid_response", stage, writeState);
  return value as Record<string, unknown>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function snapshotBundle(bundle: WorkerBundle): WorkerBundle {
  if (
    !bundle ||
    !Array.isArray(bundle.modules) ||
    bundle.modules.length === 0 ||
    bundle.modules.length > 32
  )
    invalid("preview");
  const names = new Set<string>();
  let bytes = 0;
  const modules = bundle.modules.map((module) => {
    if (
      !module ||
      typeof module.name !== "string" ||
      !modulePattern.test(module.name) ||
      names.has(module.name) ||
      typeof module.content !== "string"
    )
      invalid("preview");
    names.add(module.name);
    bytes += Buffer.byteLength(module.content);
    return { name: module.name, content: module.content };
  });
  if (!names.has(bundle.mainModule) || bytes === 0 || bytes > 3_000_000)
    invalid("preview");
  return freeze({
    mainModule: bundle.mainModule,
    modules: modules.sort((a, b) => a.name.localeCompare(b.name)),
  });
}

export class Provisioner {
  #source: ScopedTokenSource;
  #fetch: typeof fetch;
  #now: () => number;
  #accountIds: readonly string[];
  #plans = new Map<string, Plan>();
  #configurationSha256: string | undefined;
  #configurationGeneration = 0;
  constructor(
    source: ScopedTokenSource,
    options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    if (
      source.kind !== "scoped-api-token" ||
      !Array.isArray(source.accountIds) ||
      source.accountIds.length === 0 ||
      source.accountIds.length > 20 ||
      source.accountIds.some((id) => !accountPattern.test(id)) ||
      new Set(source.accountIds).size !== source.accountIds.length
    )
      throw new ProvisioningError("credential_scope", "accounts");
    this.#source = source;
    this.#accountIds = Object.freeze([...source.accountIds]);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }
  async #request(
    path: string,
    stage: Stage,
    init: RequestInit = {},
    writeState: "none" | "unknown" | "uploaded" = "none",
  ): Promise<Envelope> {
    try {
      return await this.#source.withToken(async (token) => {
        // Validate header safety, not an undocumented fixed token length. The API
        // authenticates Bearer tokens; global key/email authentication is absent.
        if (!/^[A-Za-z0-9_-]{20,256}$/.test(token))
          throw new ProvisioningError("credential_scope", stage, writeState);
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        const response = await this.#fetch(
          `https://api.cloudflare.com/client/v4${path}`,
          {
            ...init,
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          },
        );
        let envelope: Envelope;
        try {
          envelope = (await response.json()) as Envelope;
        } catch {
          throw new ProvisioningError(
            "invalid_response",
            stage,
            writeState,
            response.status,
          );
        }
        if (!envelope || typeof envelope.success !== "boolean")
          throw new ProvisioningError(
            "invalid_response",
            stage,
            writeState,
            response.status,
          );
        if (!response.ok || !envelope.success) {
          const code =
            response.status === 401
              ? "unauthorized"
              : response.status === 403
                ? "permission_denied"
                : response.status === 429
                  ? "rate_limited"
                  : "cloudflare_error";
          const codes = Array.isArray(envelope.errors)
            ? envelope.errors
                .flatMap((error) =>
                  typeof error?.code === "number" &&
                  Number.isSafeInteger(error.code)
                    ? [error.code]
                    : [],
                )
                .slice(0, 8)
            : [];
          throw new ProvisioningError(
            code,
            stage,
            writeState,
            response.status,
            codes,
          );
        }
        return envelope;
      });
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw new ProvisioningError("network_error", stage, writeState);
    }
  }
  async listAccounts(): Promise<readonly Account[]> {
    const accounts: Account[] = [];
    for (let page = 1; page <= 20; page++) {
      const envelope = await this.#request(
        `/accounts?page=${page}&per_page=50`,
        "accounts",
      );
      if (!Array.isArray(envelope.result))
        throw new ProvisioningError("invalid_response", "accounts");
      for (const item of envelope.result) {
        const account = record(item, "accounts");
        if (
          typeof account.id !== "string" ||
          !accountPattern.test(account.id) ||
          typeof account.name !== "string"
        )
          throw new ProvisioningError("invalid_response", "accounts");
        // A token that exposes undeclared accounts is refused, never auto-selected.
        if (!this.#accountIds.includes(account.id))
          throw new ProvisioningError("credential_scope", "accounts");
        accounts.push({ id: account.id, name: account.name.slice(0, 200) });
      }
      const total = envelope.result_info?.total_pages;
      if (!Number.isSafeInteger(total) || total! < 1 || total! > 20)
        throw new ProvisioningError("invalid_response", "accounts");
      if (page >= total!) return freeze(accounts);
    }
    throw new ProvisioningError("invalid_response", "accounts");
  }
  async #inspect(
    accountId: string,
    workerName: string,
    stage: Stage,
  ): Promise<{ account: Account; subdomain: string }> {
    if (
      !accountPattern.test(accountId) ||
      !this.#accountIds.includes(accountId)
    )
      throw new ProvisioningError("credential_scope", stage);
    const account = (await this.listAccounts()).find(
      (account) => account.id === accountId,
    );
    if (!account) throw new ProvisioningError("credential_scope", stage);
    const base = `/accounts/${accountId}/workers`;
    const subdomain = record(
      (await this.#request(`${base}/subdomain`, stage)).result,
      stage,
    ).subdomain;
    if (typeof subdomain !== "string" || !namePattern.test(subdomain))
      throw new ProvisioningError("subdomain_required", stage);
    try {
      await this.#request(`${base}/scripts/${workerName}/settings`, stage);
      throw new ProvisioningError("worker_exists", stage);
    } catch (error) {
      // Only documented script-not-found counts as absence, never generic 404/auth errors.
      if (
        !(
          error instanceof ProvisioningError &&
          error.httpStatus === 404 &&
          error.providerCodes.includes(10007)
        )
      )
        throw error;
    }
    return { account, subdomain };
  }
  async prepareDeployment(input: {
    accountId: string;
    // Friendly stem only. Exact deployable names are generated here, never by
    // callers; 128 random bits make a preflight/upload race unlikely without
    // pretending Cloudflare's unconditional PUT is atomic create-if-absent.
    workerName: string;
    bundle: WorkerBundle;
    selection: unknown;
  }): Promise<DeploymentPreview> {
    if (
      !input ||
      typeof input.workerName !== "string" ||
      input.workerName.length > 30 ||
      !namePattern.test(input.workerName)
    )
      invalid("preview");
    const selection = cloudSelection(input.selection);
    const route = providerRoute(selection);
    const bundle = snapshotBundle(input.bundle);
    const bundleSha256 = createHash("sha256")
      .update(JSON.stringify(bundle))
      .digest("hex");
    const configurationSha256 = createHash("sha256")
      .update(JSON.stringify({ selection, ...route, bundleSha256 }))
      .digest("hex");
    // A changed model/provider/bundle invalidates approvals for the prior choice.
    // Concurrent preparations of the same choice can still have distinct names.
    if (this.#configurationSha256 !== configurationSha256) {
      this.#configurationSha256 = configurationSha256;
      this.#configurationGeneration++;
      this.#plans.clear();
    }
    const generation = this.#configurationGeneration;
    const workerName = `${input.workerName}-${crypto.randomBytes(16).toString("hex")}`;
    const { account, subdomain } = await this.#inspect(
      input.accountId,
      workerName,
      "preview",
    );
    if (generation !== this.#configurationGeneration)
      throw new ProvisioningError("approval_required", "preview");
    const preview: DeploymentPreview = freeze({
      id: randomUUID(),
      expiresAt: this.#now() + 5 * 60_000,
      account,
      workerName,
      endpoint: `https://${workerName}.${subdomain}.workers.dev`,
      bundleSha256,
      configurationSha256,
      selection,
      providerEndpoint: route.endpoint,
      providerSecretBinding: route.secretBinding,
      resources: [
        "New Worker (existing names refused)",
        "ROOT → RootChat SQLite Durable Object namespace; migration v1",
        "Enable Worker on existing account workers.dev subdomain; preview URLs disabled",
      ],
      secretBindings: ["AUTH_TOKEN", route.secretBinding],
      modelId: selection.modelId,
      limits: {
        workerCpuMs: null,
        policy:
          "Existing backend configuration: Cloudflare account plan defaults. Durable Object compute and storage limits are separate.",
        budgetCap: "none",
        accountUsage: "unknown",
      },
      billing: {
        plan: "unverified",
        changesSubscription: false,
        notice:
          "Review the selected account plan and limits before approval. Worker requests, Durable Object compute/storage, and later model calls may incur usage charges. No spending cap is enforced. No plan upgrades, payment changes, DNS, or model calls are performed.",
        workersPricing:
          "https://developers.cloudflare.com/workers/platform/pricing/",
        durableObjectsPricing:
          "https://developers.cloudflare.com/durable-objects/platform/pricing/",
      },
      tokenScopeVerified: false,
    });
    for (const [id, plan] of this.#plans)
      if (plan.preview.expiresAt <= this.#now()) this.#plans.delete(id);
    if (this.#plans.size >= 20) invalid("preview");
    this.#plans.set(preview.id, { preview, bundle });
    return preview;
  }
  async deploy(
    confirmation: DeploymentConfirmation,
    bootstrap: BootstrapSource,
  ): Promise<DeploymentResult> {
    const plan = this.#plans.get(confirmation?.previewId);
    if (!plan) throw new ProvisioningError("approval_required", "confirmation");
    const { preview, bundle } = plan;
    if (preview.expiresAt <= this.#now()) {
      this.#plans.delete(preview.id);
      throw new ProvisioningError("preview_expired", "confirmation");
    }
    if (
      confirmation.configurationSha256 !== preview.configurationSha256 ||
      confirmation.accountId !== preview.account.id ||
      confirmation.workerName !== preview.workerName ||
      confirmation.acceptResourceCreation !== true ||
      confirmation.acknowledgeUsageBilling !== true ||
      confirmation.approveSecretUpload !== true
    )
      throw new ProvisioningError("approval_required", "confirmation");
    const generation = this.#configurationGeneration;
    // Consume before awaits, preventing replay/concurrent writes even on uncertain failures.
    this.#plans.delete(preview.id);
    const current = await this.#inspect(
      preview.account.id,
      preview.workerName,
      "confirmation",
    );
    if (
      generation !== this.#configurationGeneration ||
      current.account.name !== preview.account.name ||
      preview.endpoint !==
        `https://${preview.workerName}.${current.subdomain}.workers.dev`
    )
      throw new ProvisioningError("approval_required", "confirmation");
    if (preview.expiresAt <= this.#now())
      throw new ProvisioningError("preview_expired", "confirmation");
    const base = `/accounts/${preview.account.id}/workers/scripts/${preview.workerName}`;
    let called = false;
    let uploaded = false;
    try {
      await bootstrap.withSecrets(async (secrets) => {
        if (generation !== this.#configurationGeneration)
          throw new ProvisioningError("approval_required", "confirmation");
        if (called)
          throw new ProvisioningError(
            "invalid_input",
            "bootstrap",
            uploaded ? "uploaded" : "none",
          );
        called = true;
        if (
          !secrets ||
          typeof secrets.AUTH_TOKEN !== "string" ||
          !/^[A-Za-z0-9_-]{43,128}$/.test(secrets.AUTH_TOKEN) ||
          typeof secrets.providerKey !== "string" ||
          !(preview.selection.provider === "opencode"
            ? validZenKey(secrets.providerKey)
            : /^sk-[A-Za-z0-9_-]{1,4093}$/.test(secrets.providerKey)) ||
          secrets.AUTH_TOKEN === secrets.providerKey
        )
          invalid("bootstrap");
        const form = new FormData();
        form.set(
          "metadata",
          JSON.stringify({
            main_module: bundle.mainModule,
            compatibility_date: "2026-10-02",
            compatibility_flags: ["nodejs_compat", "enable_request_signal"],
            bindings: [
              {
                type: "durable_object_namespace",
                name: "ROOT",
                class_name: "RootChat",
              },
              { type: "plain_text", name: "MODEL_ID", text: preview.modelId },
              {
                type: "plain_text",
                name: "PROVIDER_ID",
                text: preview.selection.provider,
              },
              {
                type: "plain_text",
                name: "AUTH_MODE",
                text: preview.selection.auth,
              },
              {
                type: "secret_text",
                name: "AUTH_TOKEN",
                text: secrets.AUTH_TOKEN,
              },
              {
                type: "secret_text",
                name: preview.providerSecretBinding,
                text: secrets.providerKey,
              },
            ],
            migrations: { new_tag: "v1", new_sqlite_classes: ["RootChat"] },
            observability: { enabled: false },
          }),
        );
        for (const module of bundle.modules)
          form.set(
            module.name,
            new Blob([module.content], {
              type: "application/javascript+module",
            }),
            module.name,
          );
        // Secret bindings and code are uploaded atomically. No public unauthenticated bootstrap window.
        await this.#request(
          base,
          "upload",
          { method: "PUT", body: form },
          "unknown",
        );
        uploaded = true;
      });
      if (!uploaded) throw new ProvisioningError("invalid_input", "bootstrap");
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw new ProvisioningError(
        "invalid_input",
        "bootstrap",
        uploaded ? "uploaded" : "none",
      );
    }
    const publish = record(
      (
        await this.#request(
          `${base}/subdomain`,
          "publish",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: true, previews_enabled: false }),
          },
          "uploaded",
        )
      ).result,
      "publish",
      "uploaded",
    );
    if (publish.enabled !== true || publish.previews_enabled !== false)
      throw new ProvisioningError("invalid_response", "publish", "uploaded");
    if (
      (await this.getDeploymentStatus(preview.account.id, preview.workerName))
        .state !== "deployed"
    )
      throw new ProvisioningError("invalid_response", "status", "uploaded");
    return freeze({
      state: "deployed",
      accountId: preview.account.id,
      workerName: preview.workerName,
      endpoint: preview.endpoint,
      bundleSha256: preview.bundleSha256,
      configurationSha256: preview.configurationSha256,
    });
  }
  async getDeploymentStatus(
    accountId: string,
    workerName: string,
  ): Promise<Readonly<{ state: "deployed" | "uploaded" }>> {
    if (
      !this.#accountIds.includes(accountId) ||
      typeof workerName !== "string" ||
      !namePattern.test(workerName)
    )
      invalid("status");
    const result = record(
      (
        await this.#request(
          `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
          "status",
          {},
          "uploaded",
        )
      ).result,
      "status",
      "uploaded",
    );
    if (typeof result.enabled !== "boolean")
      throw new ProvisioningError("invalid_response", "status", "uploaded");
    return freeze({ state: result.enabled ? "deployed" : "uploaded" });
  }
}
