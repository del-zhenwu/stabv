/** LLM API fault taxonomy adapted from crash/omission/value × content/tool_calls. */

export const LLM_FAULT_ACTIONS = [
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
] as const;

export type LlmFaultAction = (typeof LLM_FAULT_ACTIONS)[number];

export const LLM_FIELDS = ["content", "tool_calls", "both"] as const;
export type LlmField = (typeof LLM_FIELDS)[number];

export const LLM_SCHEDULES = ["single", "persistent", "intermittent", "burst"] as const;
export type LlmSchedule = (typeof LLM_SCHEDULES)[number];

export const LLM_SCENES: Record<string, LlmFaultAction> = {
  api_degradation: "degrade",
  content_filter: "empty",
  max_tokens: "truncate",
  proxy_html: "html",
  stale_cache: "stale_cache",
  stale_data: "stale_data",
  wrong_entity: "wrong_entity",
  slow_response: "delay",
};

export type LlmInjectPolicy = {
  action: "pass" | LlmFaultAction;
  delayMs?: number;
  field?: LlmField;
  schedule?: LlmSchedule;
  probability?: number;
  burst?: number;
  callIndex?: number;
  seed?: number;
};

export type LlmInjectState = {
  policyHits: number;
  singleFired: boolean;
  burstUsed: number;
  rng: () => number;
};

export type LlmTriggerDetail = {
  hit: number;
  action: string;
  field: LlmField;
  schedule: LlmSchedule;
};

export function resolveLlmScene(scene: string | undefined, action: string | undefined): string {
  if (scene) {
    const mapped = LLM_SCENES[scene];
    if (!mapped) throw new Error(`unknown llm scene ${scene}`);
    if (action == null || action === "") return mapped;
    return action;
  }
  return action ?? "429";
}

export function defaultFieldForScene(scene: string | undefined): LlmField | undefined {
  if (scene === "max_tokens" || scene === "content_filter") return scene === "max_tokens" ? "content" : "both";
  if (scene === "stale_data" || scene === "wrong_entity") return "tool_calls";
  return undefined;
}

export function createLlmInjectState(seed = 1): LlmInjectState {
  return {
    policyHits: 0,
    singleFired: false,
    burstUsed: 0,
    rng: mulberry32(seed >>> 0),
  };
}

export function decideLlmInject(policy: LlmInjectPolicy, state: LlmInjectState): boolean {
  if (policy.action === "pass") return false;
  state.policyHits += 1;
  if (policy.callIndex != null && state.policyHits !== policy.callIndex) return false;
  const schedule = policy.schedule ?? "persistent";
  if (schedule === "persistent") return true;
  if (schedule === "single") {
    if (state.singleFired) return false;
    state.singleFired = true;
    return true;
  }
  if (schedule === "burst") {
    const limit = policy.burst ?? 3;
    if (state.burstUsed >= limit) return false;
    state.burstUsed += 1;
    return true;
  }
  if (schedule === "intermittent") {
    return state.rng() < (policy.probability ?? 0.3);
  }
  return true;
}

export function isWireLlmAction(action: string): boolean {
  return (
    action === "401" ||
    action === "429" ||
    action === "500" ||
    action === "timeout" ||
    action === "delay" ||
    action === "degrade" ||
    action === "malformed" ||
    action === "duplicate"
  );
}

export function isFieldLlmAction(action: string): boolean {
  return (
    action === "empty" ||
    action === "corrupt" ||
    action === "html" ||
    action === "stale_data" ||
    action === "wrong_entity" ||
    action === "stale_cache"
  );
}

export function usesFieldAwareBody(action: string, field: LlmField | undefined): boolean {
  if (isFieldLlmAction(action)) return true;
  if (action === "truncate" && field != null && field !== "both") return true;
  if (action === "schema_drift" && field === "tool_calls") return true;
  return false;
}

export function mockAssistantPayload(isAnthropic: boolean): Record<string, unknown> {
  if (isAnthropic) {
    return {
      id: "msg_chaos",
      type: "message",
      role: "assistant",
      model: "claude-3-5-sonnet",
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/sum.js" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 5, output_tokens: 2 },
    };
  }
  return {
    id: "chatcmpl-agentchaos",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "ok",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/sum.js"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

export function cannedStalePayload(isAnthropic: boolean): Record<string, unknown> {
  const payload = mockAssistantPayload(isAnthropic);
  if (isAnthropic) {
    const blocks = payload.content as { type: string; text?: string }[];
    const text = blocks.find((b) => b.type === "text");
    if (text) text.text = "cached-ok";
    return payload;
  }
  const choice = (payload.choices as { message: { content: string } }[])[0];
  if (choice) choice.message.content = "cached-ok";
  return payload;
}

export function applyLlmFieldMutation(
  payload: Record<string, unknown>,
  isAnthropic: boolean,
  action: string,
  field: LlmField,
): Record<string, unknown> {
  const target = field === "both" || field == null ? "both" : field;
  if (action === "empty") {
    if (target === "content" || target === "both") setContent(payload, isAnthropic, "I cannot assist with that request.");
    if (target === "tool_calls" || target === "both") clearTools(payload, isAnthropic);
    return payload;
  }
  if (action === "corrupt") {
    if (target === "content" || target === "both") {
      mapContent(payload, isAnthropic, (text) => `${text}\uFFFD\uFFFD`);
    }
    if (target === "tool_calls" || target === "both") {
      mapToolArgs(payload, isAnthropic, (args) => `${args.slice(0, Math.max(1, Math.floor(args.length / 2)))}\uFFFD`);
    }
    return payload;
  }
  if (action === "html") {
    setContent(payload, isAnthropic, "<html><body>502 Bad Gateway</body></html>");
    clearTools(payload, isAnthropic);
    payload.unexpected_html = true;
    return payload;
  }
  if (action === "truncate") {
    if (target === "content" || target === "both") {
      mapContent(payload, isAnthropic, (text) => text.slice(0, Math.max(1, Math.floor(text.length / 2))));
      setFinishReason(payload, isAnthropic, "length");
    }
    if (target === "tool_calls" || target === "both") {
      mapToolArgs(payload, isAnthropic, (args) => args.slice(0, Math.max(1, Math.floor(args.length / 2))));
    }
    return payload;
  }
  if (action === "schema_drift") {
    payload.unexpected_field = true;
    if (target === "tool_calls" || target === "both") {
      mapToolArgs(payload, isAnthropic, () => "42");
      mapToolName(payload, isAnthropic, (name) => `${name}_drifted`);
    }
    return payload;
  }
  if (action === "stale_data") {
    mapToolArgs(payload, isAnthropic, (args) => args.replace(/src\/sum\.js/g, "src/sum.js.old"));
    mapContent(payload, isAnthropic, (text) => `${text} [stale]`);
    return payload;
  }
  if (action === "wrong_entity") {
    mapToolName(payload, isAnthropic, (name) => (name === "read_file" ? "read_files" : name));
    mapToolArgs(payload, isAnthropic, (args) => args.replace(/src\/sum\.js/g, "src/sum.ts"));
    mapToolId(payload, isAnthropic, (id) => `${id}_x`);
    return payload;
  }
  return payload;
}

function setContent(payload: Record<string, unknown>, isAnthropic: boolean, text: string): void {
  if (isAnthropic && Array.isArray(payload.content)) {
    let found = false;
    for (const block of payload.content as { type?: string; text?: string }[]) {
      if (block?.type === "text") {
        block.text = text;
        found = true;
      }
    }
    if (!found) (payload.content as object[]).unshift({ type: "text", text });
    return;
  }
  const msg = messageOf(payload);
  if (msg) msg.content = text;
}

function mapContent(payload: Record<string, unknown>, isAnthropic: boolean, fn: (text: string) => string): void {
  if (isAnthropic && Array.isArray(payload.content)) {
    for (const block of payload.content as { type?: string; text?: string }[]) {
      if (block?.type === "text" && typeof block.text === "string") block.text = fn(block.text);
    }
    return;
  }
  const msg = messageOf(payload);
  if (msg && typeof msg.content === "string") msg.content = fn(msg.content);
}

function clearTools(payload: Record<string, unknown>, isAnthropic: boolean): void {
  if (isAnthropic && Array.isArray(payload.content)) {
    payload.content = (payload.content as { type?: string }[]).filter((block) => block?.type !== "tool_use");
    payload.stop_reason = "end_turn";
    return;
  }
  const msg = messageOf(payload);
  if (msg) {
    delete msg.tool_calls;
    setFinishReason(payload, false, "stop");
  }
}

function mapToolArgs(payload: Record<string, unknown>, isAnthropic: boolean, fn: (args: string) => string): void {
  if (isAnthropic && Array.isArray(payload.content)) {
    for (const block of payload.content as { type?: string; input?: unknown }[]) {
      if (block?.type === "tool_use") {
        const raw = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
        const next = fn(raw);
        try {
          block.input = JSON.parse(next);
        } catch {
          block.input = next;
        }
      }
    }
    return;
  }
  const msg = messageOf(payload);
  for (const call of msg?.tool_calls ?? []) {
    const fnObj = call.function as { arguments?: string } | undefined;
    if (fnObj && typeof fnObj.arguments === "string") fnObj.arguments = fn(fnObj.arguments);
  }
}

function mapToolName(payload: Record<string, unknown>, isAnthropic: boolean, fn: (name: string) => string): void {
  if (isAnthropic && Array.isArray(payload.content)) {
    for (const block of payload.content as { type?: string; name?: string }[]) {
      if (block?.type === "tool_use" && typeof block.name === "string") block.name = fn(block.name);
    }
    return;
  }
  const msg = messageOf(payload);
  for (const call of msg?.tool_calls ?? []) {
    const fnObj = call.function as { name?: string } | undefined;
    if (fnObj && typeof fnObj.name === "string") fnObj.name = fn(fnObj.name);
  }
}

function mapToolId(payload: Record<string, unknown>, isAnthropic: boolean, fn: (id: string) => string): void {
  if (isAnthropic && Array.isArray(payload.content)) {
    for (const block of payload.content as { type?: string; id?: string }[]) {
      if (block?.type === "tool_use" && typeof block.id === "string") block.id = fn(block.id);
    }
    return;
  }
  const msg = messageOf(payload);
  for (const call of msg?.tool_calls ?? []) {
    if (typeof call.id === "string") call.id = fn(call.id);
  }
}

function setFinishReason(payload: Record<string, unknown>, isAnthropic: boolean, reason: string): void {
  if (isAnthropic) {
    payload.stop_reason = reason === "length" ? "max_tokens" : reason;
    return;
  }
  const choices = payload.choices as { finish_reason?: string }[] | undefined;
  if (choices?.[0]) choices[0].finish_reason = reason;
}

function messageOf(payload: Record<string, unknown>): {
  content?: unknown;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
} | undefined {
  const choices = payload.choices as { message?: { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[] | undefined;
  return choices?.[0]?.message;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
