// Resolves cleanup inputs from current OpenClaw config and state paths.
import {
  getRuntimeConfig,
  readSourceConfigBestEffort,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildCleanupPlan } from "./cleanup-utils.js";

function hasSqliteCoordinatorCause(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof SqliteCoordinatorError) {
    return true;
  }
  if (!error || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (error instanceof AggregateError) {
    return error.errors.some((cause) => hasSqliteCoordinatorCause(cause, seen));
  }
  return error instanceof Error && hasSqliteCoordinatorCause(error.cause, seen);
}

function buildCleanupPlanForConfig(cfg: OpenClawConfig) {
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const plan = buildCleanupPlan({ cfg, stateDir, configPath, oauthDir });
  return { cfg, stateDir, configPath, oauthDir, ...plan };
}

/** Build the cleanup plan for the current runtime config/state/credential paths on disk. */
function resolveCleanupPlanFromDisk(): {
  cfg: OpenClawConfig;
  stateDir: string;
  configPath: string;
  oauthDir: string;
  configInsideState: boolean;
  oauthInsideState: boolean;
  workspaceDirs: string[];
} {
  return buildCleanupPlanForConfig(getRuntimeConfig());
}

/** Build a read-only cleanup preview without recording config health state. */
export async function resolveCleanupPlanForDryRun() {
  return buildCleanupPlanForConfig(await readSourceConfigBestEffort());
}

/** Resolve a destructive cleanup plan or report live state ownership consistently. */
export function resolveCleanupPlanForRemoval(runtime: RuntimeEnv) {
  try {
    return resolveCleanupPlanFromDisk();
  } catch (error) {
    if (!hasSqliteCoordinatorCause(error)) {
      throw error;
    }
    runtime.error(
      "Cannot remove OpenClaw state while the Gateway or another state operation owns this state directory. Stop the Gateway and retry.",
    );
    runtime.exit(1);
    return undefined;
  }
}
