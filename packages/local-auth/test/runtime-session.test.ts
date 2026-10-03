import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeSession,
  type ProtectedRepository,
  type Registration,
  type RuntimeState,
} from "../src/runtime-session";
const hostId = "urn:uuid:00000000-0000-4000-8000-000000000001";
const identity = {
  issuer: "https://auth.openai.com",
  subject: "fixture-subject",
  clientId: "fixture_client",
};
function registration(material = "synthetic-old"): Registration<string> {
  return {
    identity: { ...identity },
    material,
    expiresAt: Date.now() + 1000,
    refreshExpiresAt: Date.now() + 30 * 86400000,
    earliestRefreshAt: Date.now() - 1000,
  };
}
class Repository implements ProtectedRepository<string> {
  state: RuntimeState<string> = {
    hostId,
    revision: 0,
    phase: "ready",
    registration: registration(),
  };
  failAt = 0;
  writes = 0;
  async transaction<T>(work: (draft: RuntimeState<string>) => T): Promise<T> {
    const draft = structuredClone(this.state);
    const result = work(draft);
    this.writes++;
    if (this.writes === this.failAt)
      throw new Error("synthetic-storage-secret");
    this.state = structuredClone(draft);
    return structuredClone(result);
  }
}
function replacement() {
  return { ...registration("synthetic-new"), expiresAt: Date.now() + 3600000 };
}
describe("portable runtime refresh ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("commits intent first and replaces material atomically, preserving host", async () => {
    const repo = new Repository();
    const owner = new RuntimeSession(repo, async (previous) => {
      expect(repo.state.phase).toBe("refreshing");
      expect(repo.state.registration?.material).toBe("synthetic-old");
      expect(previous.identity).toEqual(identity);
      return replacement();
    });
    expect(await owner.refresh()).toEqual({ phase: "ready", revision: 2 });
    expect(repo.state.registration).toEqual(replacement());
    expect(repo.state.hostId).toBe(hostId);
    expect(repo.state.intent).toBeUndefined();
  });
  it("a new owner continues after restart without desktop", async () => {
    const repo = new Repository();
    await new RuntimeSession(repo, async () => replacement()).refresh();
    vi.advanceTimersByTime(3600000);
    const rotate = vi.fn(async (previous: Registration<string>) => {
      expect(previous.material).toBe("synthetic-new");
      return replacement();
    });
    await new RuntimeSession(repo, rotate).refresh();
    expect(rotate).toHaveBeenCalledOnce();
  });
  it("two owners cannot dispatch the same refresh", async () => {
    const repo = new Repository();
    let complete!: (value: Registration<string>) => void;
    const rotate = vi.fn(
      () =>
        new Promise<Registration<string>>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = new RuntimeSession(repo, rotate).refresh();
    await Promise.resolve();
    await expect(
      new RuntimeSession(repo, rotate).refresh(),
    ).rejects.toMatchObject({ code: "busy" });
    complete(replacement());
    await pending;
    expect(rotate).toHaveBeenCalledOnce();
  });
  it("uncertain rotation blocks retries across owners", async () => {
    const repo = new Repository();
    const rotate = vi.fn(async () => {
      throw new Error("synthetic-provider-secret");
    });
    const owner = new RuntimeSession(repo, rotate);
    await expect(owner.refresh()).rejects.toMatchObject({
      code: "reauth_required",
    });
    await expect(owner.refresh()).rejects.toMatchObject({
      code: "reauth_required",
    });
    await expect(
      new RuntimeSession(repo, rotate).refresh(),
    ).rejects.toMatchObject({ code: "reauth_required" });
    expect(rotate).toHaveBeenCalledOnce();
  });
  it("lost commit leaves intent that expires into reauthorization", async () => {
    const repo = new Repository();
    const original = repo.transaction.bind(repo);
    repo.transaction = async (work) => {
      if (repo.writes >= 1) throw new Error("synthetic-storage-secret");
      return original(work);
    };
    await expect(
      new RuntimeSession(repo, async () => replacement()).refresh(),
    ).rejects.toMatchObject({ code: "reauth_required" });
    expect(repo.state.phase).toBe("refreshing");
    repo.transaction = original;
    const rotate = vi.fn(async () => replacement());
    const restarted = new RuntimeSession(repo, rotate);
    expect((await restarted.recover()).phase).toBe("refreshing");
    vi.advanceTimersByTime(60001);
    expect((await restarted.recover()).phase).toBe("reauth_required");
    await expect(restarted.refresh()).rejects.toMatchObject({
      code: "reauth_required",
    });
    expect(rotate).not.toHaveBeenCalled();
  });
  it("failed intent persistence dispatches nothing", async () => {
    const repo = new Repository();
    repo.failAt = 1;
    const rotate = vi.fn(async () => replacement());
    await expect(
      new RuntimeSession(repo, rotate).refresh(),
    ).rejects.toMatchObject({ code: "storage_failed" });
    expect(rotate).not.toHaveBeenCalled();
  });
  it("account switches and invalid lifetimes cannot replace registration", async () => {
    for (const change of [
      { identity: { ...identity, subject: "other" } },
      { identity: { ...identity, clientId: "other" } },
      { expiresAt: Date.now() - 1 },
      { refreshExpiresAt: Date.now() + 31 * 86400000 },
    ]) {
      const repo = new Repository();
      await expect(
        new RuntimeSession(repo, async () => ({
          ...replacement(),
          ...change,
        })).refresh(),
      ).rejects.toMatchObject({ code: "reauth_required" });
      expect(repo.state.registration?.material).toBe("synthetic-old");
    }
  });
  it("cancellation before intent leaves registration reusable", async () => {
    const repo = new Repository();
    const rotate = vi.fn(async () => replacement());
    await expect(
      new RuntimeSession(repo, rotate).refresh(AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(repo.writes).toBe(0);
    expect(rotate).not.toHaveBeenCalled();
  });
  it("cancellation after dispatch requires reauthorization", async () => {
    const repo = new Repository();
    const abort = new AbortController();
    await expect(
      new RuntimeSession(repo, async () => {
        abort.abort();
        return replacement();
      }).refresh(abort.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(repo.state.phase).toBe("reauth_required");
  });
  it("public output does not expose material or provider errors", async () => {
    const repo = new Repository();
    const owner = new RuntimeSession(repo, async () => {
      throw new Error("synthetic-provider-secret");
    });
    const error = await owner.refresh().catch((error) => error);
    const output = JSON.stringify({
      status: await owner.status(),
      owner,
      error: { message: error.message, code: error.code },
    });
    expect(output).not.toContain("synthetic");
    expect(output).not.toContain("fixture-subject");
    expect(output).toContain("reauth_required");
  });
  it("fresh access and issuer earliest refresh suppress rotation", async () => {
    for (const change of [
      { expiresAt: Date.now() + 3600000 },
      { earliestRefreshAt: Date.now() + 500 },
    ]) {
      const repo = new Repository();
      Object.assign(repo.state.registration!, change);
      const rotate = vi.fn(async () => replacement());
      expect((await new RuntimeSession(repo, rotate).refresh()).phase).toBe(
        "ready",
      );
      expect(rotate).not.toHaveBeenCalled();
    }
  });
});

it("rotation cannot mutate the captured expected identity", async () => {
  const repo = new Repository();
  await expect(
    new RuntimeSession(repo, async (previous) => {
      previous.identity.subject = "other";
      return { ...replacement(), identity: previous.identity };
    }).refresh(),
  ).rejects.toMatchObject({ code: "reauth_required" });
  expect(repo.state.registration?.identity).toEqual(identity);
});
