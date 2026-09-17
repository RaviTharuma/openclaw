// Last-used runtime cache is not a pin: inherit current primary when it is stale.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createModelSelectionState } from "./model-selection.js";

type PersistReplySessionEntry =
  (typeof import("./session-entry-persistence.js"))["persistReplySessionEntry"];

const DEFAULT_MOCK_CATALOG_ENTRIES = vi.hoisted(() => [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
]);

const sessionPersistenceMocks = vi.hoisted(() => ({
  persistReplySessionEntry: vi.fn<PersistReplySessionEntry>(),
}));

const catalogRuntimeMocks = vi.hoisted(() => {
  const loadModelCatalog = vi.fn(
    async (_params?: unknown): Promise<unknown[]> => DEFAULT_MOCK_CATALOG_ENTRIES,
  );
  return {
    loadModelCatalog,
    loadModelCatalogSnapshot: vi.fn(async (params?: unknown) => {
      const entries = await loadModelCatalog(params as never);
      return { entries, routeVariants: entries, authoritative: true };
    }),
  };
});

const authProfileStoreMock = vi.hoisted(() => {
  let store = { version: 1, profiles: {} } as {
    version: 1;
    profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
  };
  const ensureAuthProfileStore = vi.fn(() => store);
  return {
    get store() {
      return store;
    },
    set store(next) {
      store = next;
    },
    ensureAuthProfileStore,
    reset() {
      store = { version: 1, profiles: {} };
      ensureAuthProfileStore.mockClear();
    },
  };
});

vi.mock("../../agents/cli-backends.js", () => ({
  resolveCliRuntimeCanonicalProvider: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "claude-cli" ? "anthropic" : undefined,
  ),
}));

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadManifestModelCatalog: vi.fn(() => []),
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: catalogRuntimeMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: catalogRuntimeMocks.loadModelCatalogSnapshot,
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionParentSessionKey: (sessionKey?: string) =>
    sessionKey?.replace(/:thread:[^:]+$/, "").replace(/:topic:[^:]+$/, "") ?? null,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => createPluginMetadataSnapshotFixture(),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: sessionPersistenceMocks.persistReplySessionEntry,
}));

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: authProfileStoreMock.ensureAuthProfileStore,
}));

// Alias-aware stub: mirrors the real isStoredCredentialCompatibleWithAuthProvider
// but inlines the claude-cli->anthropic alias so tests don't need live plugin metadata.
vi.mock("../../agents/auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: ({
    provider,
    credential,
  }: {
    provider: string;
    credential: { type: string; provider: string };
  }) => {
    const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const resolveAuthKey = (v: string) => {
      const n = normalize(v);
      if (n === "claudecli") {
        return "anthropic";
      }
      return n;
    };
    const providerKey = resolveAuthKey(provider);
    const credentialKey = resolveAuthKey(credential.provider);
    if (credentialKey === providerKey) {
      return true;
    }
    if (providerKey === "openaiapicodex" || providerKey === "openaicodex") {
      return credentialKey === "openai" && credential.type === "api_key";
    }
    return false;
  },
}));

afterEach(() => {
  sessionPersistenceMocks.persistReplySessionEntry.mockReset();
  authProfileStoreMock.reset();
});

const makeEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "session-id",
  updatedAt: Date.now(),
  delivery: { kind: "none" },
  ...overrides,
});

describe("createModelSelectionState inherits primary from stale last-used", () => {
  it.each([
    { name: "same-provider", credentialProvider: "anthropic", profileExists: true, keep: true },
    { name: "provider-alias", credentialProvider: "claude-cli", profileExists: true, keep: true },
    { name: "incompatible", credentialProvider: "openai", profileExists: true, keep: false },
    { name: "missing shared", credentialProvider: "anthropic", profileExists: false, keep: false },
    { name: "missing personal", credentialProvider: "anthropic", profileExists: false, keep: true },
  ])("validates the $name auth pin after clearing last-used", async (testCase) => {
    const sessionKey = "agent:main:telegram:direct:1";
    const profileId =
      testCase.name === "missing personal"
        ? "personal:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222"
        : "anthropic:work";
    if (testCase.profileExists) {
      authProfileStoreMock.store.profiles[profileId] = {
        type: "api_key",
        provider: testCase.credentialProvider,
        key: "test-key",
      };
    }
    const authPin = {
      authProfileOverride: profileId,
      authProfileOverrideSource: "user" as const,
      authProfileOverrideCompactionCount: 3,
    };
    const sessionEntry = makeEntry({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      contextTokens: 200_000,
      ...authPin,
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      provider: "anthropic",
      model: "claude-opus-4-6",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("anthropic");
    expect(state.model).toBe("claude-opus-4-6");
    expect(sessionEntry.modelProvider).toBeUndefined();
    expect(sessionEntry.model).toBeUndefined();
    expect(sessionEntry.contextTokens).toBeUndefined();
    expect(authProfileStoreMock.ensureAuthProfileStore).toHaveBeenCalled();
    if (testCase.keep) {
      expect(sessionEntry).toMatchObject(authPin);
    } else {
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
      expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
    }
    expect(sessionStore[sessionKey]).toEqual(sessionEntry);
  });

  it("persists a compatible auth pin while clearing stale last-used", async () => {
    const sessionKey = "agent:main:telegram:direct:1";
    const authPin = {
      authProfileOverride: "anthropic:work",
      authProfileOverrideSource: "user" as const,
      authProfileOverrideCompactionCount: 3,
    };
    authProfileStoreMock.store.profiles[authPin.authProfileOverride] = {
      type: "api_key",
      provider: "anthropic",
      key: "test-key",
    };
    const sessionEntry = makeEntry({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      contextTokens: 200_000,
      ...authPin,
    });
    const initialEntry = { ...sessionEntry };
    const sessionStore = { [sessionKey]: sessionEntry };
    sessionPersistenceMocks.persistReplySessionEntry.mockImplementationOnce(async ({ entry }) => ({
      status: "current",
      entry: { ...entry },
    }));

    await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath: "sessions.json",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      provider: "anthropic",
      model: "claude-opus-4-6",
      hasModelDirective: false,
    });

    expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledExactlyOnceWith({
      storePath: "sessions.json",
      sessionKey,
      initialEntry,
      entry: expect.objectContaining(authPin),
    });
    const persisted = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0].entry;
    expect(persisted?.modelProvider).toBeUndefined();
    expect(persisted?.model).toBeUndefined();
    expect(persisted?.contextTokens).toBeUndefined();
    expect(sessionEntry).toMatchObject(authPin);
    expect(sessionStore[sessionKey]).toEqual(sessionEntry);
  });

  it("clears last-used when it differs from the current primary", async () => {
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      modelProvider: "openai",
      model: "gpt-4o-mini",
      contextTokens: 128_000,
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      primaryProvider: "openai",
      primaryModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
    expect(sessionEntry.modelProvider).toBeUndefined();
    expect(sessionEntry.model).toBeUndefined();
    expect(sessionEntry.contextTokens).toBeUndefined();
    expect(sessionStore[sessionKey]).toEqual(sessionEntry);
    expect(sessionPersistenceMocks.persistReplySessionEntry).not.toHaveBeenCalled();
  });

  it("persists last-used inherit when a store path is provided", async () => {
    const storePath = "sessions.json";
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      modelProvider: "retired-provider",
      model: "retired-model",
    });
    const persistedEntry = makeEntry({
      updatedAt: sessionEntry.updatedAt + 1,
    });
    sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
      status: "current",
      entry: persistedEntry,
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    const state = await createModelSelectionState({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4o" },
            models: {
              "openai/gpt-4o": {},
            },
          },
        },
      } as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      primaryProvider: "openai",
      primaryModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
    expect(sessionPersistenceMocks.persistReplySessionEntry).toHaveBeenCalledOnce();
    const persistenceRequest = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0];
    expect(persistenceRequest).toMatchObject({
      storePath,
      sessionKey,
      initialEntry: expect.objectContaining({
        modelProvider: "retired-provider",
        model: "retired-model",
      }),
    });
    expect(persistenceRequest?.entry.modelProvider).toBeUndefined();
    expect(persistenceRequest?.entry.model).toBeUndefined();
    expect(sessionEntry).toEqual(persistedEntry);
    expect(sessionStore[sessionKey]).toEqual(sessionEntry);
  });

  it("keeps explicit Default provenance so a child does not inherit a parent pin", async () => {
    const parentKey = "agent:main:telegram:group:123";
    const sessionKey = "agent:main:telegram:group:123:topic:99";
    const parentEntry = makeEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const sessionEntry = makeEntry({
      modelOverrideSource: "default",
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      contextTokens: 200_000,
    });
    const sessionStore = { [parentKey]: parentEntry, [sessionKey]: sessionEntry };
    sessionPersistenceMocks.persistReplySessionEntry.mockImplementationOnce(async ({ entry }) => ({
      status: "current",
      entry: { ...entry },
    }));

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey: parentKey,
      storePath: "sessions.json",
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      primaryProvider: "openai",
      primaryModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
    expect(sessionEntry.modelOverrideSource).toBe("default");
    expect(sessionEntry.modelProvider).toBeUndefined();
    expect(sessionEntry.model).toBeUndefined();
    expect(sessionEntry.contextTokens).toBeUndefined();
    const persisted = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0].entry;
    expect(persisted?.modelOverrideSource).toBe("default");
    expect(persisted?.modelProvider).toBeUndefined();
    expect(sessionStore[sessionKey]).toEqual(sessionEntry);
  });

  it("keeps an active fallbackNotice while clearing stale last-used", async () => {
    const sessionKey = "agent:main:telegram:direct:1";
    const fallbackNotice = {
      kind: "active" as const,
      selectedModel: "openai/gpt-4o",
      activeModel: "openai/gpt-4o-mini",
      reason: "rate-limit",
    };
    const sessionEntry = makeEntry({
      modelProvider: "openai",
      model: "gpt-4o-mini",
      contextTokens: 128_000,
      fallbackNotice,
    });
    const sessionStore = { [sessionKey]: sessionEntry };
    sessionPersistenceMocks.persistReplySessionEntry.mockImplementationOnce(async ({ entry }) => ({
      status: "current",
      entry: { ...entry },
    }));

    const state = await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath: "sessions.json",
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      primaryProvider: "openai",
      primaryModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });

    expect(state.provider).toBe("openai");
    expect(state.model).toBe("gpt-4o");
    expect(sessionEntry.fallbackNotice).toEqual(fallbackNotice);
    expect(sessionEntry.modelProvider).toBeUndefined();
    expect(sessionEntry.model).toBeUndefined();
    expect(sessionEntry.contextTokens).toBeUndefined();
    const persisted = sessionPersistenceMocks.persistReplySessionEntry.mock.calls[0]?.[0].entry;
    expect(persisted?.fallbackNotice).toEqual(fallbackNotice);
    expect(persisted?.modelProvider).toBeUndefined();
    expect(sessionStore[sessionKey]).toEqual(sessionEntry);
  });

  it("keeps last-used when it already matches the current primary", async () => {
    const sessionKey = "agent:main:telegram:direct:1";
    const sessionEntry = makeEntry({
      modelProvider: "openai",
      model: "gpt-4o",
    });
    const sessionStore = { [sessionKey]: sessionEntry };

    await createModelSelectionState({
      cfg: {} as OpenClawConfig,
      agentCfg: undefined,
      sessionEntry,
      sessionStore,
      sessionKey,
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      primaryProvider: "openai",
      primaryModel: "gpt-4o",
      provider: "openai",
      model: "gpt-4o",
      hasModelDirective: false,
    });

    expect(sessionEntry.modelProvider).toBe("openai");
    expect(sessionEntry.model).toBe("gpt-4o");
    expect(sessionPersistenceMocks.persistReplySessionEntry).not.toHaveBeenCalled();
  });
});
