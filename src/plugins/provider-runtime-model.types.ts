// Defines runtime model metadata supplied by provider plugins.
import type { ModelCatalogContextWindowOption } from "@openclaw/model-catalog-core/model-catalog-types";
import type { Model } from "openclaw/plugin-sdk/llm";
import type { ModelCompatConfig, ModelMediaInputConfig } from "../config/types.models.js";

/**
 * Fully-resolved runtime model shape used after provider/plugin-owned
 * discovery, overrides, and compat normalization.
 */
export type ProviderRuntimeModel = Omit<Model, "compat" | "maxTokens"> & {
  compat?: ModelCompatConfig;
  contextWindows?: ModelCatalogContextWindowOption[];
  contextWindowDefault?: string;
  contextTokens?: number;
  /**
   * Wire output cap. Omitted for explicit non-native openai-completions proxy
   * reasoning rows with no authored/catalog cap so the provider applies its own
   * limit. Native Completions still default to 8192.
   */
  maxTokens?: number;
  /** Host-resolved provenance for the top-level wire output cap. */
  maxTokensSource?: "configured" | "discovered";
  params?: Record<string, unknown>;
  requestTimeoutMs?: number;
  mediaInput?: ModelMediaInputConfig;
};
