import { Buffer } from "node:buffer";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentPlanStep } from "openclaw/plugin-sdk/channel-outbound";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject } from "./protocol.js";

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];
type StoredPlan = { markdown?: string; steps: AgentPlanStep[] };

const RESTORED_PLAN_PREAMBLE =
  "OpenClaw restored the session progress card after context compaction. " +
  "This is application state, not a new user request. Continue the current task and call " +
  "progress_card whenever the status meaningfully changes.";
const RESTORED_PLAN_MAX_STEPS = 50;
const RESTORED_PLAN_MAX_STEP_BYTES = 512;
const RESTORED_PLAN_MAX_MARKDOWN_BYTES = 2 * 1024;
const RESTORED_PLAN_MAX_PAYLOAD_BYTES = 32 * 1024;
const RESTORED_PLAN_TRUNCATION_SUFFIX = "…";

/** Retains the latest projected plan so Codex compaction cannot discard it. */
export class CodexCompactionPlanState {
  private latestPlan: StoredPlan | undefined;

  record(event: AgentEvent): void {
    if (event.stream !== "plan") {
      return;
    }
    const plan = readBoundedPlan(event.data.explanation, event.data.steps);
    this.latestPlan = plan;
  }

  /** Retains markdown that migration-only plan events intentionally omit. */
  recordProgressCardInput(value: unknown): void {
    if (!isJsonObject(value)) {
      return;
    }
    this.latestPlan = readBoundedPlan(value.markdown, value.plan);
  }

  async restore(params: {
    client: CodexAppServerClient;
    threadId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<void> {
    if (!this.latestPlan) {
      return;
    }
    await params.client.request(
      "thread/inject_items",
      {
        threadId: params.threadId,
        items: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `${RESTORED_PLAN_PREAMBLE}\n${serializePlan(this.latestPlan)}`,
              },
            ],
          },
        ],
      },
      { timeoutMs: params.timeoutMs, signal: params.signal },
    );
  }
}

function readBoundedPlan(markdownValue: unknown, stepsValue: unknown): StoredPlan | undefined {
  const markdown =
    typeof markdownValue === "string"
      ? truncateUtf8(markdownValue, RESTORED_PLAN_MAX_MARKDOWN_BYTES)
      : undefined;
  const steps: AgentPlanStep[] = [];
  for (const step of readPlanSteps(stepsValue)) {
    if (steps.length >= RESTORED_PLAN_MAX_STEPS) {
      break;
    }
    const boundedStep = {
      ...step,
      step: truncateUtf8(step.step, RESTORED_PLAN_MAX_STEP_BYTES),
    };
    const candidate = {
      ...(markdown?.trim() ? { markdown } : {}),
      steps: [...steps, boundedStep],
    };
    if (Buffer.byteLength(serializePlan(candidate), "utf8") > RESTORED_PLAN_MAX_PAYLOAD_BYTES) {
      break;
    }
    steps.push(boundedStep);
  }
  return markdown?.trim() || steps.length > 0
    ? { ...(markdown?.trim() ? { markdown } : {}), steps }
    : undefined;
}

function serializePlan(plan: StoredPlan): string {
  return JSON.stringify({ markdown: plan.markdown, plan: plan.steps });
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  const suffixBytes = Buffer.byteLength(RESTORED_PLAN_TRUNCATION_SUFFIX, "utf8");
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) {
    end -= 1;
  }
  return `${bytes.subarray(0, end).toString("utf8")}${RESTORED_PLAN_TRUNCATION_SUFFIX}`;
}

function readPlanSteps(value: unknown): AgentPlanStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const { step, status } = entry as { step?: unknown; status?: unknown };
    if (typeof step !== "string" || !isPlanStatus(status)) {
      return [];
    }
    return [{ step, status }];
  });
}

function isPlanStatus(value: unknown): value is AgentPlanStep["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}
