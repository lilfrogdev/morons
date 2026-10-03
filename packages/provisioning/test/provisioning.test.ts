import test from "node:test";
import assert from "node:assert/strict";
import { Provisioner, ProvisioningError } from "../src/index.js";
import type {
  BootstrapSource,
  DeploymentPreview,
  WorkerBundle,
} from "../src/index.js";
const accountId = "a".repeat(32);
const otherAccount = "b".repeat(32);
const token = "fixture-scoped-token-".padEnd(40, "x");
const secrets = {
  AUTH_TOKEN: "fixture-bearer-".padEnd(43, "x"),
  OPENAI_API_KEY: "sk-fixture-openai-api-key-xxxx",
};
const bundle: WorkerBundle = {
  mainModule: "worker.js",
  modules: [
    {
      name: "worker.js",
      content: "export class RootChat {}\nexport default {fetch(){}};",
    },
  ],
};
const bootstrap: BootstrapSource = { withSecrets: async (use) => use(secrets) };
const approval = (preview: DeploymentPreview) => ({
  previewId: preview.id,
  accountId,
  workerName: preview.workerName,
  acceptResourceCreation: true as const,
  acknowledgeUsageBilling: true as const,
  approveSecretUpload: true as const,
});
const ok = (result: unknown, extra = {}) =>
  Response.json({ success: true, result, ...extra });
const missing = () =>
  Response.json(
    { success: false, errors: [{ code: 10007, message: "script not found" }] },
    { status: 404 },
  );
function fixture(
  options: {
    existing?: boolean;
    fault?: (path: string, init: RequestInit) => Response | undefined;
  } = {},
) {
  const requests: { path: string; init: RequestInit }[] = [];
  let existing = options.existing ?? false;
  let enabled = false;
  let now = 1_000;
  let accountName = "Fixture account";
  let subdomain = "fixture-owner";
  const transport: typeof fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.cloudflare.com");
    assert.equal(init.redirect, "error");
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      `Bearer ${token}`,
    );
    assert.equal(new Headers(init.headers).has("X-Auth-Key"), false);
    const path = parsed.pathname.replace("/client/v4", "");
    requests.push({ path, init });
    const fault = options.fault?.(path, init);
    if (fault) return fault;
    if (path === "/accounts")
      return ok([{ id: accountId, name: accountName }], {
        result_info: { total_pages: 1 },
      });
    if (path.endsWith("/workers/subdomain")) return ok({ subdomain });
    if (path.endsWith("/settings")) return existing ? ok({}) : missing();
    if (init.method === "PUT") {
      existing = true;
      return ok({ id: "fixture-worker" });
    }
    if (init.method === "POST") {
      enabled = true;
      return ok({ enabled, previews_enabled: false });
    }
    if (path.endsWith("/subdomain"))
      return ok({ enabled, previews_enabled: false });
    throw new Error("Unexpected fixture route");
  };
  const provisioner = new Provisioner(
    {
      kind: "scoped-api-token",
      accountIds: [accountId],
      withToken: async (use) => use(token),
    },
    { fetch: transport, now: () => now },
  );
  return {
    provisioner,
    requests,
    setExisting: () => {
      existing = true;
    },
    setNow: (value: number) => {
      now = value;
    },
    setAccountName: (value: string) => {
      accountName = value;
    },
    setSubdomain: (value: string) => {
      subdomain = value;
    },
  };
}
const prepare = (provisioner: Provisioner, value = bundle) =>
  provisioner.prepareDeployment({
    accountId,
    workerName: "morons-owner",
    bundle: value,
  });
function rejects(code: string, stage?: string, writeState?: string) {
  return (error: unknown) =>
    error instanceof ProvisioningError &&
    error.code === code &&
    (!stage || error.stage === stage) &&
    (!writeState || error.writeState === writeState);
}

test("preview contains exact resources and truthful billing; reads only", async () => {
  const { provisioner, requests } = fixture();
  const preview = await prepare(provisioner);
  assert.equal(preview.account.id, accountId);
  assert.equal(
    preview.endpoint,
    "https://morons-owner.fixture-owner.workers.dev",
  );
  assert.equal(preview.bundleSha256.length, 64);
  assert.deepEqual(preview.secretBindings, ["AUTH_TOKEN", "OPENAI_API_KEY"]);
  assert.equal(preview.limits.budgetCap, "none");
  assert.equal(preview.limits.workerCpuMs, null);
  assert.equal(preview.billing.plan, "unverified");
  assert.equal(preview.billing.changesSubscription, false);
  assert.equal(preview.tokenScopeVerified, false);
  assert.equal(Object.isFrozen(preview.account), true);
  assert.ok(requests.every(({ init }) => !init.method));
  assert.ok(!JSON.stringify(preview).includes(token));
});
test("deployment uploads exact immutable bundle and secrets atomically then publishes with previews off", async () => {
  const { provisioner, requests } = fixture();
  const mutable = structuredClone(bundle) as {
    mainModule: string;
    modules: { name: string; content: string }[];
  };
  const preview = await prepare(provisioner, mutable);
  mutable.modules[0]!.content = "mutated after preview";
  const result = await provisioner.deploy(approval(preview), bootstrap);
  assert.equal(result.state, "deployed");
  const writes = requests.filter(({ init }) => init.method);
  assert.deepEqual(
    writes.map(({ init }) => init.method),
    ["PUT", "POST"],
  );
  const form = writes[0]!.init.body as FormData;
  const metadata = JSON.parse(form.get("metadata") as string);
  assert.deepEqual(metadata.migrations, {
    new_tag: "v1",
    new_sqlite_classes: ["RootChat"],
  });
  assert.equal(
    metadata.bindings.find(
      (binding: { name: string }) => binding.name === "ROOT",
    ).class_name,
    "RootChat",
  );
  for (const name of ["AUTH_TOKEN", "OPENAI_API_KEY"] as const)
    assert.equal(
      metadata.bindings.find(
        (binding: { name: string }) => binding.name === name,
      ).text,
      secrets[name],
    );
  assert.equal(metadata.observability.enabled, false);
  assert.equal(metadata.limits, undefined);
  assert.equal(
    await (form.get("worker.js") as Blob).text(),
    bundle.modules[0]!.content,
  );
  assert.deepEqual(JSON.parse(writes[1]!.init.body as string), {
    enabled: true,
    previews_enabled: false,
  });
  assert.ok(!JSON.stringify(result).includes(secrets.AUTH_TOKEN));
  await assert.rejects(
    provisioner.deploy(approval(preview), bootstrap),
    rejects("approval_required"),
  );
});
test("all approval fields must match and secrets are not accessed beforehand", async () => {
  const { provisioner, requests } = fixture();
  const preview = await prepare(provisioner);
  let accessed = false;
  const source: BootstrapSource = {
    withSecrets: async (use) => {
      accessed = true;
      return use(secrets);
    },
  };
  for (const override of [
    { accountId: otherAccount },
    { workerName: "other" },
    { acknowledgeUsageBilling: false },
    { approveSecretUpload: false },
    { acceptResourceCreation: false },
  ]) {
    await assert.rejects(
      provisioner.deploy(
        { ...approval(preview), ...override } as ReturnType<typeof approval>,
        source,
      ),
      rejects("approval_required"),
    );
  }
  assert.equal(accessed, false);
  assert.ok(requests.every(({ init }) => !init.method));
});
test("expired preview and changed account/subdomain require new approval", async () => {
  for (const change of ["time", "name", "subdomain"] as const) {
    const f = fixture();
    const preview = await prepare(f.provisioner);
    if (change === "time") f.setNow(preview.expiresAt);
    if (change === "name") f.setAccountName("Different owner");
    if (change === "subdomain") f.setSubdomain("different-owner");
    await assert.rejects(
      f.provisioner.deploy(approval(preview), bootstrap),
      rejects(change === "time" ? "preview_expired" : "approval_required"),
    );
    assert.ok(f.requests.every(({ init }) => !init.method));
  }
});
test("existing names refused both at preview and immediately before upload", async () => {
  const existing = fixture({ existing: true });
  await assert.rejects(prepare(existing.provisioner), rejects("worker_exists"));
  const concurrent = fixture();
  const preview = await prepare(concurrent.provisioner);
  concurrent.setExisting();
  await assert.rejects(
    concurrent.provisioner.deploy(approval(preview), bootstrap),
    rejects("worker_exists"),
  );
  assert.ok(concurrent.requests.every(({ init }) => !init.method));
});
test("unknown account, broad visible accounts, permissions and ambiguous 404 all fail closed", async () => {
  const f = fixture();
  await assert.rejects(
    f.provisioner.prepareDeployment({
      accountId: otherAccount,
      workerName: "morons",
      bundle,
    }),
    rejects("credential_scope"),
  );
  assert.equal(f.requests.length, 0);
  for (const response of [
    ok([{ id: otherAccount, name: "Wrong owner" }], {
      result_info: { total_pages: 1 },
    }),
    Response.json({ success: false }, { status: 403 }),
    Response.json({ success: false }, { status: 404 }),
  ]) {
    const f = fixture({ fault: () => response });
    await assert.rejects(
      prepare(f.provisioner),
      (error: unknown) => error instanceof ProvisioningError,
    );
    assert.ok(f.requests.every(({ init }) => !init.method));
  }
  const ambiguous = fixture({
    fault: (path) =>
      path.endsWith("/settings")
        ? Response.json(
            { success: false, errors: [{ code: 1234 }] },
            { status: 404 },
          )
        : undefined,
  });
  await assert.rejects(
    prepare(ambiguous.provisioner),
    rejects("cloudflare_error"),
  );
});
test("API failures return only safe status/codes and do not retry writes", async () => {
  const f = fixture({
    fault: (_path, init) =>
      init.method === "PUT"
        ? Response.json(
            {
              success: false,
              errors: [
                {
                  code: 10000,
                  message: `${token} ${secrets.AUTH_TOKEN} ${secrets.OPENAI_API_KEY}`,
                },
              ],
            },
            { status: 403 },
          )
        : undefined,
  });
  const preview = await prepare(f.provisioner);
  await assert.rejects(
    f.provisioner.deploy(approval(preview), bootstrap),
    (error: unknown) => {
      assert.ok(error instanceof ProvisioningError);
      assert.equal(error.writeState, "unknown");
      assert.equal(error.httpStatus, 403);
      assert.deepEqual(error.providerCodes, [10000]);
      for (const secret of [token, secrets.AUTH_TOKEN, secrets.OPENAI_API_KEY])
        assert.ok(
          !JSON.stringify(error).includes(secret) &&
            !error.stack?.includes(secret),
        );
      return true;
    },
  );
  assert.equal(f.requests.filter(({ init }) => init.method).length, 1);
  await assert.rejects(
    f.provisioner.deploy(approval(preview), bootstrap),
    rejects("approval_required"),
  );
});
test("publish failure reports uploaded state; no rollback/delete or model call", async () => {
  const f = fixture({
    fault: (_path, init) =>
      init.method === "POST"
        ? Response.json(
            { success: false, errors: [{ code: 10000 }] },
            { status: 429 },
          )
        : undefined,
  });
  const preview = await prepare(f.provisioner);
  await assert.rejects(
    f.provisioner.deploy(approval(preview), bootstrap),
    rejects("rate_limited", "publish", "uploaded"),
  );
  assert.equal(
    f.requests.filter(({ init }) => init.method === "DELETE").length,
    0,
  );
});
test("missing/invalid bootstrap cannot publish without an authenticated upload", async () => {
  const f = fixture();
  const preview = await prepare(f.provisioner);
  await assert.rejects(
    f.provisioner.deploy(approval(preview), {
      withSecrets: async () => undefined as never,
    }),
    rejects("invalid_input", "bootstrap"),
  );
  assert.ok(f.requests.every(({ init }) => !init.method));
  const g = fixture();
  const other = await prepare(g.provisioner);
  await assert.rejects(
    g.provisioner.deploy(approval(other), {
      withSecrets: async (use) => use({ ...secrets, AUTH_TOKEN: "short" }),
    }),
    rejects("invalid_input", "bootstrap"),
  );
  assert.ok(g.requests.every(({ init }) => !init.method));
});
test("concurrent attempts consume the approval once", async () => {
  const f = fixture();
  const preview = await prepare(f.provisioner);
  const results = await Promise.allSettled([
    f.provisioner.deploy(approval(preview), bootstrap),
    f.provisioner.deploy(approval(preview), bootstrap),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    f.requests.filter(({ init }) => init.method === "PUT").length,
    1,
  );
});
test("invalid bundle names, sizes, duplicate modules and worker names are refused before reads", async () => {
  for (const invalidBundle of [
    {
      mainModule: "../worker.js",
      modules: [{ name: "../worker.js", content: "x" }],
    },
    {
      mainModule: "worker.js",
      modules: [bundle.modules[0]!, bundle.modules[0]!],
    },
    { mainModule: "other.js", modules: bundle.modules },
    {
      mainModule: "worker.js",
      modules: [{ name: "worker.js", content: "x".repeat(3_000_001) }],
    },
  ]) {
    const f = fixture();
    await assert.rejects(
      prepare(f.provisioner, invalidBundle),
      rejects("invalid_input"),
    );
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  await assert.rejects(
    f.provisioner.prepareDeployment({
      accountId,
      workerName: 123 as unknown as string,
      bundle,
    }),
    rejects("invalid_input"),
  );
  assert.equal(f.requests.length, 0);
});
test("pagination validates every visible account and rejects incomplete response metadata", async () => {
  let count = 0;
  const provisioner = new Provisioner(
    {
      kind: "scoped-api-token",
      accountIds: [accountId, otherAccount],
      withToken: async (use) => use(token),
    },
    {
      fetch: async (url) => {
        count++;
        const page = new URL(String(url)).searchParams.get("page");
        return ok(
          [
            {
              id: page === "1" ? accountId : otherAccount,
              name: `Account ${page}`,
            },
          ],
          { result_info: { total_pages: 2 } },
        );
      },
    },
  );
  assert.equal((await provisioner.listAccounts()).length, 2);
  assert.equal(count, 2);
  const f = fixture({ fault: () => ok([]) });
  await assert.rejects(
    f.provisioner.listAccounts(),
    rejects("invalid_response"),
  );
});
test("network exceptions never leak their raw messages", async () => {
  const provisioner = new Provisioner({
    kind: "scoped-api-token",
    accountIds: [accountId],
    withToken: async () => {
      throw new Error(token);
    },
  });
  await assert.rejects(
    provisioner.listAccounts(),
    (error: unknown) =>
      error instanceof ProvisioningError &&
      error.code === "network_error" &&
      !error.stack?.includes(token),
  );
});
