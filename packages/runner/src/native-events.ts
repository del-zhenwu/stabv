import type { AdapterName } from "./spec.ts";

export const NATIVE_EVENT_KINDS = [
  "tool_started",
  "tool_finished",
  "approval_requested",
  "compaction_started",
  "compaction_finished",
  "session_checkpoint",
  "subagent_started",
  "subagent_finished",
] as const;

export type NativeEventKind = (typeof NATIVE_EVENT_KINDS)[number];

export type NativeEvent = {
  kind: NativeEventKind;
  toolCallId?: string;
  sessionRevision?: string;
  detail: Record<string, unknown>;
};

const NATIVE_SET = new Set<string>(NATIVE_EVENT_KINDS);

export function isNativeEventKind(value: string): value is NativeEventKind {
  return NATIVE_SET.has(value);
}

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "mcp_tool",
  "function_call",
  "file_change",
  "tool_use",
  "tool_call",
  "bash",
  "shell",
]);

const APPROVAL_TYPES = new Set([
  "approval_requested",
  "approval_required",
  "need_approval",
  "permission_request",
]);

const COMPACT_START_TYPES = new Set([
  "compaction_started",
  "session_compacting",
  "compaction_begin",
]);

const COMPACT_FINISH_TYPES = new Set([
  "compaction_finished",
  "session_compacted",
  "compaction_complete",
  "compaction_ended",
]);

const SUBAGENT_START_TYPES = new Set([
  "subagent_started",
  "subagent_spawned",
  "agent_spawned",
]);

const SUBAGENT_FINISH_TYPES = new Set([
  "subagent_finished",
  "subagent_completed",
  "agent_finished",
]);

const CHECKPOINT_TYPES = new Set([
  "session_checkpoint",
  "session_saved",
  "checkpoint_created",
]);

/**
 * Classifies a raw structured JSON event from an agent into a typed NativeEvent.
 * Uses exact Tagged Union matching per protocol/adapter rather than fuzzy regex searches,
 * avoiding false-positive matches on chat text or message contents.
 */
export function classifyAgentEvent(raw: Record<string, unknown>, _adapter?: AdapterName): NativeEvent | undefined {
  const item = asRecord(raw.item);
  const payload = asRecord(raw.payload) ?? asRecord(raw.message);
  const rawType = str(raw.type ?? raw.event ?? raw.msg ?? payload?.type);
  const id = firstId(raw, item, payload);

  // 1. Control Plane & Governance Events (Exact tagged matching)
  if (APPROVAL_TYPES.has(rawType) || raw.approval != null) {
    return { kind: "approval_requested", toolCallId: id, detail: raw };
  }
  if (COMPACT_START_TYPES.has(rawType)) {
    return { kind: "compaction_started", detail: raw };
  }
  if (COMPACT_FINISH_TYPES.has(rawType)) {
    return { kind: "compaction_finished", detail: raw };
  }
  if (SUBAGENT_START_TYPES.has(rawType)) {
    return { kind: "subagent_started", toolCallId: id, detail: raw };
  }
  if (SUBAGENT_FINISH_TYPES.has(rawType)) {
    return { kind: "subagent_finished", toolCallId: id, detail: raw };
  }
  if (CHECKPOINT_TYPES.has(rawType)) {
    return { kind: "session_checkpoint", sessionRevision: sessionRev(raw, payload), detail: raw };
  }

  // 2. Claude / Anthropic Structured Content Blocks
  const fromContent = classifyContent(payload?.content ?? raw.content, raw);
  if (fromContent) return fromContent;

  // 3. Codex Protocol Tagged Events (item.started / item.completed with structured item.type)
  const itemType = str(item?.type);
  if (rawType === "item.completed" || rawType === "item.finished") {
    if (TOOL_ITEM_TYPES.has(itemType)) {
      return { kind: "tool_finished", toolCallId: id, detail: raw };
    }
  } else if (rawType === "item.started") {
    if (TOOL_ITEM_TYPES.has(itemType)) {
      return { kind: "tool_started", toolCallId: id, detail: raw };
    }
  }

  // 4. Exact Protocol / Tool Lifecycle Types
  if (rawType === "tool_finished" || rawType === "tool.end" || rawType === "function_call_output") {
    return { kind: "tool_finished", toolCallId: id, detail: raw };
  }
  if (rawType === "tool_started" || rawType === "tool.start" || rawType === "function_call") {
    return { kind: "tool_started", toolCallId: id, detail: raw };
  }

  // 5. Anthropic SSE Streaming Events
  if (rawType === "content_block_start") {
    const block = asRecord(raw.content_block);
    if (block && str(block.type) === "tool_use") {
      return { kind: "tool_started", toolCallId: str(block.id), detail: raw };
    }
  }

  return undefined;
}

function classifyContent(content: unknown, raw: Record<string, unknown>): NativeEvent | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec) continue;
    const ptype = str(rec.type);
    if (ptype === "tool_use" || ptype === "tool_call") {
      return { kind: "tool_started", toolCallId: firstId(rec), detail: raw };
    }
    if (ptype === "tool_result" || ptype === "function_call_output") {
      return { kind: "tool_finished", toolCallId: firstId(rec), detail: raw };
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstId(...objs: Array<Record<string, unknown> | undefined>): string | undefined {
  for (const obj of objs) {
    if (!obj) continue;
    for (const key of ["toolCallId", "call_id", "tool_call_id", "tool_use_id", "id"]) {
      const value = obj[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return undefined;
}

function sessionRev(raw: Record<string, unknown>, nested?: Record<string, unknown>): string | undefined {
  for (const obj of [raw, nested]) {
    if (!obj) continue;
    for (const key of ["sessionRevision", "session_revision", "revision", "sessionId", "session_id"]) {
      const value = obj[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return undefined;
}
