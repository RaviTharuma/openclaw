import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { GitHubIdentityController } from "./github-identity-controller.js";

const availableStatus = {
  agentId: "main",
  source: "agent-override",
  credentialState: "available",
  account: { login: "managed-user", avatarUrl: null },
  gitAuthor: { name: "Agent Author", email: null },
  evidence: "github-api",
} as const;

afterEach(() => vi.unstubAllGlobals());

function createController() {
  const host = { requestUpdate: vi.fn() };
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "secrets.store.set" || method === "secrets.store.delete") {
        return { ok: true };
      }
      if (method === "tools.github.configure" || method === "tools.github.status") {
        return availableStatus;
      }
      throw new Error(`unexpected method ${method}`);
    }),
  } as unknown as GatewayBrowserClient;
  return { controller: new GitHubIdentityController(host), client, requests };
}

function sync(
  controller: GitHubIdentityController,
  client: GatewayBrowserClient,
  config: Record<string, unknown> = {},
  overrides: Partial<Parameters<GitHubIdentityController["sync"]>[0]> = {},
) {
  controller.sync({
    client,
    connected: true,
    agentId: "main",
    config,
    supported: true,
    configurable: true,
    clientRevision: 1,
    ...overrides,
  });
}

describe("GitHubIdentityController", () => {
  it("keeps scope drafts isolated and clears only the inherited scope", async () => {
    const { controller, client } = createController();
    sync(controller, client, {
      tools: {
        github: {
          profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          gitAuthor: { name: "System Author" },
        },
      },
      agents: {
        entries: {
          main: {
            tools: {
              github: {
                profileId: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                gitAuthor: { name: "Agent Author" },
              },
            },
          },
        },
      },
    });
    controller.setDraft("token", "agent-token");
    controller.selectScope("system");
    controller.setDraft("token", "system-token");
    controller.selectScope("agent");

    expect(controller.draft.token).toBe("agent-token");
    await controller.inherit();
    expect(controller.scope).toBe("system");
    expect(controller.draft).toMatchObject({ name: "System Author", token: "system-token" });
    controller.selectScope("agent");
    expect(controller.draft).toEqual({ token: "", name: "", email: "" });
  });

  it("hands off the token directly and adopts configure status without verifying again", async () => {
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.selectScope("agent");
    controller.setDraft("token", "one-use-token");
    controller.setDraft("name", "Agent Author");

    await controller.configure();

    expect(requests.map((entry) => entry.method)).toEqual([
      "secrets.store.set",
      "tools.github.configure",
    ]);
    expect(requests[0]?.params).toMatchObject({
      value: "one-use-token",
      kind: "secret",
      allowedHosts: [],
    });
    expect(requests[1]?.params).toMatchObject({
      scope: "agent",
      agentId: "main",
      mode: "managed",
      gitAuthor: { name: "Agent Author" },
    });
    expect(requests[1]?.params).not.toHaveProperty("token");
    expect(requests[1]?.params.secretName).toBe(requests[0]?.params.name);
    expect(controller.status).toEqual(availableStatus);
    expect(controller.draft.token).toBe("");
  });

  it("configures in an insecure context with getRandomValues but no randomUUID", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends Uint8Array>(array: T): T => {
        array.fill(0xab);
        return array;
      },
    });
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.setDraft("token", "one-use-token");

    await controller.configure();

    expect(requests[0]?.params.name).toMatch(/^github-setup-[a-f0-9]{32}$/u);
    expect(requests[1]?.params.secretName).toBe(requests[0]?.params.name);
    expect(controller.error).toBeNull();
  });

  it("keeps UUID generation failures inside configure handling", async () => {
    vi.stubGlobal("crypto", {});
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.setDraft("token", "one-use-token");

    await expect(controller.configure()).resolves.toBeUndefined();

    expect(requests).toEqual([]);
    expect(controller.busy).toBe(false);
    expect(controller.error).toContain("Web Crypto is required");
  });

  it("sends the selected agentId for system configure actions", async () => {
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.setDraft("token", "one-use-token");
    await controller.configure();
    expect(requests[1]?.params).toMatchObject({ agentId: "main" });
  });

  it("does not call methods hidden by an older Gateway", async () => {
    const { controller, client, requests } = createController();
    sync(controller, client, {}, { supported: false, configurable: false });
    controller.setDraft("token", "unused-token");
    await controller.verify();
    await controller.configure();
    await controller.inherit();
    expect(requests).toEqual([]);
  });

  it.each([{ clientRevision: 2 }, { agentId: "reviewer" }])(
    "drops status from a stale client/agent revision %#",
    async (revisions) => {
      const host = { requestUpdate: vi.fn() };
      let resolveStatus: ((value: unknown) => void) | undefined;
      const client = {
        request: vi.fn(
          async () =>
            await new Promise((resolve) => {
              resolveStatus = resolve;
            }),
        ),
      } as unknown as GatewayBrowserClient;
      const controller = new GitHubIdentityController(host);
      sync(controller, client);
      const pending = controller.verify();
      sync(controller, client, {}, revisions);
      resolveStatus?.(availableStatus);
      await pending;
      expect(controller.status).toBeNull();
      expect(controller.loading).toBe(false);
    },
  );

  it("refreshes clean drafts without overwriting active edits", () => {
    const { controller, client } = createController();
    const config = (systemName: string, agentName: string) => ({
      tools: {
        github: {
          profileId: "ghp_cccccccccccccccccccccccccccccccc",
          gitAuthor: { name: systemName },
        },
      },
      agents: {
        entries: {
          main: {
            tools: {
              github: {
                profileId: "ghp_dddddddddddddddddddddddddddddddd",
                gitAuthor: { name: agentName },
              },
            },
          },
        },
      },
    });
    sync(controller, client, config("System One", "Agent One"));
    controller.setDraft("name", "Active Agent Edit");
    sync(controller, client, config("System Two", "Agent Two"));
    expect(controller.draft.name).toBe("Active Agent Edit");
    controller.selectScope("system");
    expect(controller.draft.name).toBe("System Two");
  });

  it("invalidates an in-flight status on effective identity change and verifies once", async () => {
    const host = { requestUpdate: vi.fn() };
    const resolvers: Array<(value: typeof availableStatus) => void> = [];
    const request = vi.fn(
      async () =>
        await new Promise<typeof availableStatus>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new GitHubIdentityController(host);
    const config = (profileId: string) => ({ tools: { github: { profileId } } });
    sync(controller, client, config("ghp_11111111111111111111111111111111"));
    const initial = controller.verify();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    controller.setDraft("name", "dirty author");
    sync(controller, client, config("ghp_22222222222222222222222222222222"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.draft.name).toBe("dirty author");

    resolvers[0]?.(availableStatus);
    resolvers[1]?.(availableStatus);
    await initial;
    await Promise.resolve();
    expect(controller.status).toEqual(availableStatus);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects status returned for a different agent", async () => {
    const host = { requestUpdate: vi.fn() };
    const client = {
      request: vi.fn(async () => ({ ...availableStatus, agentId: "reviewer" })),
    } as unknown as GatewayBrowserClient;
    const controller = new GitHubIdentityController(host);
    sync(controller, client);
    await controller.verify();
    expect(controller.status).toBeNull();
    expect(controller.error).toContain("different agent");
  });
});
