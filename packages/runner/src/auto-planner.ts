import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
  Type,
  createAssistantMessageEventStream,
  getModel,
  type AssistantMessage,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";
import type { EventStore } from "./events.ts";
import type { Fault } from "./spec.ts";

export type AutoLlmConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type AutoDecision = {
  atMs: number;
  fault: Fault;
  reason: string;
};

const ALLOWED: Record<string, string[]> = {
  llm: [
    "delay",
    "timeout",
    "401",
    "429",
    "500",
    "malformed",
    "truncate",
    "schema_drift",
    "duplicate",
    "empty",
    "corrupt",
    "html",
    "degrade",
    "stale_cache",
    "stale_data",
    "wrong_entity",
  ],
  mcp: ["delay", "timeout", "429", "500", "malformed", "truncate"],
  rule: ["evict", "conflict", "corrupt"],
  context: ["poison", "truncate", "reorder"],
  process: ["pause"],
  file: ["lock"],
  git: ["lock", "conflict"],
  approval: ["deny", "drop", "delay"],
  subagent: ["timeout", "fail"],
};

const SYSTEM_PROMPT = `You are AgentChaos auto-mode. You only call tools.
Tools: observe (read state), strike (inject one closed-world fault), stop (done).
Strike only with kind/action from the tool schema. Prefer llm/rule/context faults.
One strike per turn unless observe shows you should stop.`;

export function resolveAutoLlmConfig(model?: string): AutoLlmConfig {
  const apiKey = process.env.AGENTCHAOS_LLM_API_KEY;
  if (!apiKey) throw new Error("mode: auto requires AGENTCHAOS_LLM_API_KEY");
  const baseUrl = (process.env.AGENTCHAOS_LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    apiKey,
    baseUrl,
    model: model ?? process.env.AGENTCHAOS_LLM_MODEL ?? "gpt-4o-mini",
  };
}

export class AutoPlanner {
  private budgetRemaining: number;
  private history: AutoDecision[] = [];
  private active = false;
  private busy = false;
  private unsubscribe?: () => void;
  private startTime = 0;
  private abort?: AbortController;
  private readonly config: AutoLlmConfig;

  constructor(opts: { budget?: number; model?: string }) {
    this.budgetRemaining = opts.budget ?? 3;
    this.config = resolveAutoLlmConfig(opts.model);
  }

  getHistory(): AutoDecision[] {
    return [...this.history];
  }

  start(events: EventStore, onInject: (fault: Fault) => Promise<() => Promise<void>>): void {
    if (this.active) return;
    this.active = true;
    this.startTime = Date.now();
    this.unsubscribe = events.on(async (ev) => {
      if (!this.active || this.budgetRemaining <= 0 || this.busy) return;
      if (ev.event !== "tool_started" && ev.event !== "compaction_started" && ev.event !== "approval_requested") {
        return;
      }
      await this.turn(events, onInject, ev.event, ev.toolCallId);
    });
  }

  stop(): void {
    this.active = false;
    this.abort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async turn(
    events: EventStore,
    onInject: (fault: Fault) => Promise<() => Promise<void>>,
    trigger: string,
    toolCallId?: string,
  ): Promise<void> {
    this.busy = true;
    this.abort = new AbortController();
    try {
      const agent = this.createAgent(events, onInject);
      await agent.prompt(
        `Native event: ${trigger}${toolCallId ? ` toolCallId=${toolCallId}` : ""}. Budget left: ${this.budgetRemaining}. Observe then strike or stop.`,
      );
      await agent.waitForIdle();
      if (agent.state.errorMessage) {
        await events.emit("auto_planner_error", { error: agent.state.errorMessage, planner: "llm" });
      }
    } catch (err) {
      await events.emit("auto_planner_error", {
        error: err instanceof Error ? err.message : String(err),
        planner: "llm",
      });
    } finally {
      this.busy = false;
    }
  }

  private createAgent(events: EventStore, onInject: (fault: Fault) => Promise<() => Promise<void>>): Agent {
    const model = buildModel(this.config);
    const planner = this;
    const observe: AgentTool = {
      name: "observe",
      label: "Observe",
      description: "Read recent chaos events, budget, and last native signal.",
      parameters: Type.Object({}),
      prepareArguments: () => ({}),
      execute: async () => {
        const recent = events.events.slice(-12).map((e) => ({ event: e.event, toolCallId: e.toolCallId }));
        const body = JSON.stringify({ budgetRemaining: planner.budgetRemaining, recent });
        return { content: [{ type: "text", text: body }], details: { recent } };
      },
    };
    const strike: AgentTool = {
      name: "strike",
      label: "Strike",
      description: "Inject one allowed fault. kind+action must be in the closed catalog.",
      parameters: Type.Object({
        kind: Type.String(),
        action: Type.String(),
        field: Type.Optional(Type.String()),
        schedule: Type.Optional(Type.String()),
        durationMs: Type.Optional(Type.Number()),
        reason: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => {
        const kind = String(params.kind);
        const action = String(params.action);
        const allowed = ALLOWED[kind];
        if (!allowed || !allowed.includes(action)) {
          throw new Error(`strike not in catalog: ${kind}.${action}`);
        }
        if (planner.budgetRemaining <= 0) throw new Error("budget exhausted");
        const fault = buildStrikeFault(kind, action, params);
        planner.budgetRemaining -= 1;
        const atMs = Date.now() - planner.startTime;
        const reason = String(params.reason ?? "auto strike");
        planner.history.push({ atMs, fault, reason });
        await events.emit("auto_strike", {
          planner: "llm",
          mode: "auto",
          faultKind: fault.kind,
          faultAction: fault.action,
          atMs,
          budgetRemaining: planner.budgetRemaining,
          reason,
        });
        const cleanup = await onInject(fault);
        if (fault.durationMs && fault.durationMs > 0) {
          setTimeout(() => {
            void cleanup();
          }, fault.durationMs);
        }
        return {
          content: [{ type: "text", text: `injected ${fault.kind}.${fault.action}` }],
          details: { fault, reason },
        };
      },
    };
    const stop: AgentTool = {
      name: "stop",
      label: "Stop",
      description: "Stop the auto planner for this event.",
      parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: "stopped" }],
        details: { reason: params.reason },
        terminate: true,
      }),
    };
    return new Agent({
      getApiKey: () => planner.config.apiKey,
      streamFn: (mdl, context, options) => streamOpenAI(planner.config, mdl, context, options?.signal),
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        thinkingLevel: "off",
        tools: [observe, strike, stop],
      },
    });
  }
}

function buildStrikeFault(kind: string, action: string, params: { field?: unknown; schedule?: unknown; durationMs?: unknown }): Fault {
  const durationMs = typeof params.durationMs === "number" ? params.durationMs : 1200;
  const atMs = 0;
  if (kind === "file") return { kind: "file", action: action as "lock", atMs, durationMs, path: "src/sum.js" };
  if (kind === "llm") {
    return {
      kind: "llm",
      action: action as Fault extends { kind: "llm"; action: infer A } ? A : never,
      atMs,
      durationMs,
      field: params.field === "content" || params.field === "tool_calls" || params.field === "both" ? params.field : undefined,
      schedule: params.schedule === "single" || params.schedule === "persistent" || params.schedule === "burst" || params.schedule === "intermittent"
        ? params.schedule
        : undefined,
    };
  }
  return { kind, action, atMs, durationMs } as Fault;
}

function buildModel(config: AutoLlmConfig): Model<"openai-completions"> {
  const base = getModel("openai", "gpt-4o-mini");
  return {
    ...base,
    id: config.model,
    name: config.model,
    baseUrl: config.baseUrl,
    api: "openai-completions",
  };
}

function streamOpenAI(config: AutoLlmConfig, model: Model<any>, context: Context, signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const emptyUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const failed = (message: string): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "openai",
      model: model.id,
      usage: emptyUsage,
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    });
    try {
      const url = `${config.baseUrl}/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          messages: toOpenAIMessages(context),
          tools: (context.tools ?? []).map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
        }),
        signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        const msg = failed(`LLM ${res.status}: ${raw.slice(0, 300)}`);
        stream.push({ type: "start", partial: msg });
        stream.push({ type: "error", reason: "error", error: msg });
        stream.end(msg);
        return;
      }
      const data = JSON.parse(raw) as {
        choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      };
      const message = data.choices?.[0]?.message;
      const content: AssistantMessage["content"] = [];
      if (message?.content) content.push({ type: "text", text: message.content });
      for (const call of message?.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: args });
      }
      const done: AssistantMessage = {
        role: "assistant",
        content,
        api: "openai-completions",
        provider: "openai",
        model: model.id,
        usage: emptyUsage,
        stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: done });
      stream.push({ type: "done", message: done, reason: done.stopReason });
      stream.end(done);
    } catch (err) {
      const msg = failed(err instanceof Error ? err.message : String(err));
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "error", reason: "error", error: msg });
      stream.end(msg);
    }
  })();
  return stream;
}

function toOpenAIMessages(context: Context): { role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }[] {
  const out: { role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }[] = [];
  if (context.systemPrompt) out.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: typeof message.content === "string" ? message.content : JSON.stringify(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      const toolCalls = message.content
        .filter((part) => part.type === "toolCall")
        .map((part) =>
          part.type === "toolCall"
            ? {
                id: part.id,
                type: "function",
                function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
              }
            : undefined,
        )
        .filter(Boolean);
      out.push({
        role: "assistant",
        content: text || undefined,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });
      continue;
    }
    if (message.role === "toolResult") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: text });
    }
  }
  return out;
}
