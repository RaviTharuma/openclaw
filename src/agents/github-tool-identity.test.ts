import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processMocks = vi.hoisted(() => ({ runCommandBuffered: vi.fn() }));

vi.mock("../process/exec.js", () => ({ runCommandBuffered: processMocks.runCommandBuffered }));

import {
  installManagedGitHubProfile,
  prepareGitHubToolEnvironment,
  resolveGitHubToolLocalIdentityEnvironment,
  resolveGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubAgentKey,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

function commandResult(stdout = "", code = 0, stderr = "") {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

describe("GitHub tool identity", () => {
  const roots: string[] = [];

  beforeEach(() => {
    processMocks.runCommandBuffered.mockReset();
    processMocks.runCommandBuffered.mockResolvedValue(commandResult());
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("clears native service tokens and gives an agent override complete precedence", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-state-"));
    roots.push(stateDir);
    const config = {
      tools: {
        github: {
          profileId: "ghp_11111111111111111111111111111111",
          gitAuthor: { name: "System" },
        },
      },
      agents: {
        entries: {
          main: {
            agentDir: path.join(stateDir, "main"),
            tools: {
              github: {
                profileId: "ghp_22222222222222222222222222222222",
                gitAuthor: { email: "agent@example.test" },
              },
            },
          },
        },
      },
    };

    expect(resolveGitHubToolIdentity({ config: {}, agentId: "main" })).toEqual({
      source: "system-detected",
    });
    expect(resolveGitHubToolLocalIdentityEnvironment({ config: {}, agentId: "main" })).toEqual({});

    const env = { OPENCLAW_STATE_DIR: stateDir };
    const expectedProfileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "agent",
      profileId: "ghp_22222222222222222222222222222222",
      env,
    });
    const identity = resolveGitHubToolIdentity({ config, agentId: "main", env });
    expect(identity).toMatchObject({
      source: "agent-override",
      config: { gitAuthor: { email: "agent@example.test" } },
      profileDir: expectedProfileDir,
    });
    expect(resolveGitHubToolLocalIdentityEnvironment({ config, agentId: "main", env })).toEqual({
      GH_CONFIG_DIR: expectedProfileDir,
      GIT_AUTHOR_EMAIL: "agent@example.test",
      GIT_COMMITTER_EMAIL: "agent@example.test",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.email",
      GIT_CONFIG_VALUE_0: "agent@example.test",
    });
    const relocatedConfig = structuredClone(config);
    relocatedConfig.agents.entries.main.agentDir = path.join(stateDir, "relocated");
    expect(
      resolveGitHubToolIdentity({ config: relocatedConfig, agentId: "main", env }),
    ).toMatchObject({
      profileDir: expectedProfileDir,
    });
  });

  it("uses distinct bounded keys for distinct normalized agent ids", () => {
    const first = resolveManagedGitHubAgentKey("Reviewer-One");
    const second = resolveManagedGitHubAgentKey("reviewer-two");

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toBe(second);
    expect(resolveManagedGitHubAgentKey(" reviewer-one ")).toBe(first);
  });

  it.each([
    { identity: "native", managed: false },
    { identity: "managed", managed: true },
  ])("prepares exact preview-credential scrubs for $identity identity", ({ managed }) => {
    const identityConfig = managed
      ? { tools: { github: { profileId: "ghp_99999999999999999999999999999999" } } }
      : {};
    const envScrub = prepareGitHubToolEnvironment({
      config: identityConfig,
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "env", provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
            },
          },
        },
      },
      agentId: "main",
    });
    expect(envScrub.credentialScrubEnv).toEqual({
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      PREVIEW_SERVICE_TOKEN: "",
    });
    expect(Object.keys(envScrub.localIdentityEnv).length).toBe(managed ? 1 : 0);
    expect(envScrub.excludedStoreNames).toEqual([]);

    const storeScrub = prepareGitHubToolEnvironment({
      config: identityConfig,
      sourceConfig: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "PREVIEW_STORE_TOKEN" },
            },
          },
        },
      },
      agentId: "main",
    });
    expect(storeScrub.credentialScrubEnv).toEqual({
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      PREVIEW_STORE_TOKEN: "",
    });
    expect(storeScrub.excludedStoreNames).toEqual(["PREVIEW_STORE_TOKEN"]);
  });

  it("does not derive isolation policy from ambient credential presence", () => {
    const native = prepareGitHubToolEnvironment({
      config: {},
      agentId: "main",
      env: {},
    });
    expect(native.managedLocalIdentity).toBe(false);

    const ambient = prepareGitHubToolEnvironment({
      config: {},
      agentId: "main",
      env: { GH_TOKEN: "test-token" },
    });
    expect(ambient).toEqual(native);

    const previewEnvRef = prepareGitHubToolEnvironment({
      config: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "env", provider: "default", id: "PREVIEW_SERVICE_TOKEN" },
            },
          },
        },
      },
      agentId: "main",
      env: {},
    });
    expect(previewEnvRef.credentialScrubEnv.PREVIEW_SERVICE_TOKEN).toBe("");
  });

  it("fails closed when a configured managed profile is absent", async () => {
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "git") {
        return commandResult();
      }
      throw new Error("managed status must not probe native gh auth");
    });
    const status = await resolveGitHubToolIdentityStatus({
      config: {
        tools: {
          github: {
            profileId: "ghp_44444444444444444444444444444444",
          },
        },
      },
      agentId: "main",
    });
    expect(status).toMatchObject({
      source: "system-configured",
      credentialState: "configured_unavailable",
      account: null,
      evidence: "none",
    });
  });

  it("reports a GitHub rate limit without exposing command diagnostics", async () => {
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) => {
      if (argv[0] === "git") {
        return commandResult();
      }
      return commandResult("", 1, "gh: API rate limit exceeded (HTTP 403); token=private");
    });
    const status = await resolveGitHubToolIdentityStatus({ config: {}, agentId: "main" });
    expect(status).toMatchObject({
      credentialState: "rate_limited",
      evidence: "rate-limited",
      account: null,
    });
    expect(
      processMocks.runCommandBuffered.mock.calls.filter(([argv]) => argv[0] === "git"),
    ).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("private");
    expect(JSON.stringify(status)).not.toContain("stderr");
  });

  it("probes native gh without ambient tokens and reads Git author in the selected workspace", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-workspace-"));
    roots.push(workspace);
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[0] === "gh"
        ? commandResult('{"login":"native-user","avatarUrl":null}\n')
        : commandResult(),
    );

    await resolveGitHubToolIdentityStatus({
      config: { agents: { defaults: { workspace } } },
      agentId: "main",
    });

    const ghCall = processMocks.runCommandBuffered.mock.calls.find(([argv]) => argv[0] === "gh");
    const gitCall = processMocks.runCommandBuffered.mock.calls.find(([argv]) => argv[0] === "git");
    expect(ghCall?.[1]?.env).toMatchObject({ GH_TOKEN: undefined, GITHUB_TOKEN: undefined });
    expect(gitCall?.[1]).toMatchObject({ cwd: workspace });
  });

  it.each([
    {
      label: "invalid credential",
      stderr: "gh: Bad credentials (HTTP 401)",
      credentialState: "configured_unavailable",
    },
    {
      label: "unverified transport failure",
      stderr: "gh: connection reset",
      credentialState: "unverified",
    },
  ])("reports a managed $label honestly", async (testCase) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-status-"));
    roots.push(root);
    const profileId = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const env = { OPENCLAW_STATE_DIR: root };
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "agent",
      profileId,
      env,
    });
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(profileDir, "hosts.yml"), "github.com:\n", { mode: 0o600 });
    processMocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[0] === "git" ? commandResult() : commandResult("", 1, testCase.stderr),
    );

    const status = await resolveGitHubToolIdentityStatus({
      config: {
        agents: {
          entries: {
            main: {
              agentDir: root,
              tools: { github: { profileId } },
            },
          },
        },
      },
      agentId: "main",
      env,
    });

    expect(status.credentialState).toBe(testCase.credentialState);
    expect(JSON.stringify(status)).not.toContain(testCase.stderr);
  });

  it("uses stdin to build a private verified profile and returns only account metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-profile-"));
    roots.push(root);
    const profileDir = path.join(root, "profile");
    const calls: Array<{ argv: string[]; input?: string }> = [];
    processMocks.runCommandBuffered.mockImplementation(
      async (argv: string[], options: { env?: NodeJS.ProcessEnv; input?: string }) => {
        calls.push({ argv, input: options.input });
        if (argv[1] === "auth") {
          await fs.writeFile(
            path.join(String(options.env?.GH_CONFIG_DIR), "hosts.yml"),
            "github.com:\n",
            {
              mode: 0o644,
            },
          );
          return commandResult();
        }
        return commandResult(
          '{"login":"managed-user","avatarUrl":"https://example.test/avatar"}\n',
        );
      },
    );

    const result = await installManagedGitHubProfile({
      profileDir,
      token: "test-managed-token",
      commitConfig: vi.fn(async () => undefined),
    });

    expect(result).toEqual({ login: "managed-user", avatarUrl: "https://example.test/avatar" });
    expect(calls[0]?.argv).not.toContain("test-managed-token");
    expect(calls[0]?.input).toBe("test-managed-token\n");
    expect((await fs.stat(profileDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(profileDir, "hosts.yml"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the previous generation after the new version commits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-rotate-"));
    roots.push(root);
    const previousProfileDir = path.join(root, "profile-old");
    const profileDir = path.join(root, "profile-new");
    await fs.mkdir(previousProfileDir, { mode: 0o700 });
    await fs.writeFile(path.join(previousProfileDir, "hosts.yml"), "old-profile\n", {
      mode: 0o600,
    });
    processMocks.runCommandBuffered.mockImplementation(
      async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
        if (argv[1] === "auth") {
          await fs.writeFile(
            path.join(String(options.env?.GH_CONFIG_DIR), "hosts.yml"),
            "new-profile\n",
            { mode: 0o600 },
          );
          return commandResult();
        }
        return commandResult('{"login":"managed-user","avatarUrl":null}\n');
      },
    );
    const commitConfig = vi.fn(async () => {
      await expect(fs.readFile(path.join(previousProfileDir, "hosts.yml"), "utf8")).resolves.toBe(
        "old-profile\n",
      );
      await expect(fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).resolves.toBe(
        "new-profile\n",
      );
    });

    await installManagedGitHubProfile({
      profileDir,
      token: "replacement-token",
      commitConfig,
    });

    expect(commitConfig).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(previousProfileDir, "hosts.yml"), "utf8")).resolves.toBe(
      "old-profile\n",
    );
    await expect(fs.readFile(path.join(profileDir, "hosts.yml"), "utf8")).resolves.toBe(
      "new-profile\n",
    );
  });

  it("deletes only the new profile when the guarded config write fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-rollback-"));
    roots.push(root);
    const previousProfileDir = path.join(root, "profile-old");
    const profileDir = path.join(root, "profile-new");
    await fs.mkdir(previousProfileDir, { mode: 0o700 });
    await fs.writeFile(path.join(previousProfileDir, "hosts.yml"), "old-profile\n", {
      mode: 0o600,
    });
    processMocks.runCommandBuffered.mockImplementation(
      async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
        if (argv[1] === "auth") {
          await fs.writeFile(
            path.join(String(options.env?.GH_CONFIG_DIR), "hosts.yml"),
            "new-profile\n",
            {
              mode: 0o600,
            },
          );
          return commandResult();
        }
        return commandResult('{"login":"managed-user","avatarUrl":null}\n');
      },
    );

    await expect(
      installManagedGitHubProfile({
        profileDir,
        token: "replacement-token",
        commitConfig: async () => {
          throw new Error("config changed concurrently");
        },
      }),
    ).rejects.toThrow("config changed concurrently");
    expect(await fs.readFile(path.join(previousProfileDir, "hosts.yml"), "utf8")).toBe(
      "old-profile\n",
    );
    await expect(fs.stat(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
