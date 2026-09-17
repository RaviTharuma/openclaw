/** Applies model-selection session mutations through the reply persist owner. */
import { SessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import {
  adoptPersistedSessionSnapshot,
  sessionModelOverrideChangesApplied,
} from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

const sessionPersistenceRuntimeLoader = createLazyImportLoader(
  () => import("./session-entry-persistence.js"),
);

async function loadSessionPersistenceRuntime() {
  return sessionPersistenceRuntimeLoader.load();
}

/** Writes a planned session mutation, then adopts the persisted snapshot. */
export async function persistSessionEntryMutation(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  initialSessionEntry: SessionEntry;
  nextSessionEntry: SessionEntry;
}): Promise<SessionEntry> {
  let applied = params.nextSessionEntry;
  if (params.storePath) {
    const { persistReplySessionEntry } = await loadSessionPersistenceRuntime();
    const persistence = await persistReplySessionEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      initialEntry: params.initialSessionEntry,
      entry: params.nextSessionEntry,
    });
    if (persistence.status === "lifecycle-invalidated") {
      throw new SessionWorkStartInvalidatedError(persistence.error);
    }
    applied = persistence.entry;
  }
  adoptPersistedSessionSnapshot(params.sessionEntry, applied);
  params.sessionStore[params.sessionKey] = params.sessionEntry;
  return applied;
}

/** Persists a default-primary inherit onto a session entry (clears stored overrides). */
export async function persistSessionPrimaryModelInherit(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  primaryProvider: string;
  primaryModel: string;
  preserveAuthProfileOverride?: boolean;
}): Promise<boolean> {
  const initialSessionEntry = { ...params.sessionEntry };
  const nextSessionEntry = { ...params.sessionEntry };
  const { updated } = applyModelOverrideToSessionEntry({
    entry: nextSessionEntry,
    selection: {
      provider: params.primaryProvider,
      model: params.primaryModel,
      isDefault: true,
    },
    preserveAuthProfileOverride: params.preserveAuthProfileOverride,
  });
  if (!updated) {
    return false;
  }
  const persisted = await persistSessionEntryMutation({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    initialSessionEntry,
    nextSessionEntry,
  });
  if (!params.storePath) {
    return true;
  }
  return sessionModelOverrideChangesApplied({
    initial: initialSessionEntry,
    next: nextSessionEntry,
    current: persisted,
  });
}
