/** Last-used model/modelProvider is last-run cache, not a user pin. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  findSelectedCatalogEntry,
  normalizeRuntimeRef,
  type RuntimeModelNormalization,
} from "./model-runtime-normalization.js";
import { persistSessionEntryMutation } from "./model-selection-session-persist.js";

const LAST_USED_RUNTIME_FIELDS = [
  "model",
  "modelProvider",
  "contextTokens",
  "contextTokensSource",
  "contextBudgetStatus",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

/** Last-run cache only. Default provenance and fallbackNotice stay put. */
function clearStaleLastUsedRuntimeMetadata(entry: SessionEntry): boolean {
  let updated = false;
  for (const field of LAST_USED_RUNTIME_FIELDS) {
    if (entry[field] !== undefined) {
      delete entry[field];
      updated = true;
    }
  }
  if (updated) {
    entry.updatedAt = Date.now();
  }
  return updated;
}

/** Clears stale last-used cache after defaults.primary changes or catalog miss. */
export async function clearStaleLastUsedSessionRuntime(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  hasDirectStoredModelOverride: boolean;
  hasOneTurnModelOverride: boolean;
  modelSelectionLocked: boolean;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider: string;
  primaryModel: string;
  catalog: readonly ModelCatalogEntry[];
  catalogAuthoritative: boolean;
  runtimeModelNormalization: RuntimeModelNormalization;
}): Promise<void> {
  const { sessionEntry, sessionStore, sessionKey } = params;
  if (
    !sessionEntry ||
    !sessionStore ||
    !sessionKey ||
    params.hasDirectStoredModelOverride ||
    params.hasOneTurnModelOverride ||
    params.modelSelectionLocked
  ) {
    return;
  }
  const runtimeModel = normalizeOptionalString(sessionEntry.model);
  const runtimeProvider = normalizeOptionalString(sessionEntry.modelProvider);
  if (!runtimeModel && !runtimeProvider) {
    return;
  }
  const normalizedLastUsed = normalizeRuntimeRef(
    runtimeProvider ?? params.defaultProvider,
    runtimeModel ?? params.defaultModel,
    params.runtimeModelNormalization,
  );
  const lastUsedKey = buildModelCatalogRef(normalizedLastUsed.provider, normalizedLastUsed.model);
  const primaryKey = buildModelCatalogRef(params.primaryProvider, params.primaryModel);
  const lastUsedCataloged = Boolean(
    findSelectedCatalogEntry({
      catalog: params.catalog,
      provider: normalizedLastUsed.provider,
      model: normalizedLastUsed.model,
    }),
  );
  const lastUsedUnknown =
    params.catalogAuthoritative && params.catalog.length > 0 && !lastUsedCataloged;
  if (lastUsedKey !== primaryKey || lastUsedUnknown) {
    const initialSessionEntry = { ...sessionEntry };
    const nextSessionEntry = { ...sessionEntry };
    if (clearStaleLastUsedRuntimeMetadata(nextSessionEntry)) {
      await persistSessionEntryMutation({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath: params.storePath,
        initialSessionEntry,
        nextSessionEntry,
      });
    }
  }
}
