import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { EventIndex } from "./event-index.ts";

export type ChaosEvent = {
  ts: number;
  run_id: string;
  event_id: string;
  event: string;
  state?: string;
  detail?: unknown;
  toolCallId?: string;
  sessionRevision?: string;
};

export type EventListener = (ev: ChaosEvent) => void | Promise<void>;

export class EventStore {
  readonly path: string;
  readonly events: ChaosEvent[] = [];
  private runId: string;
  private listeners: EventListener[] = [];
  private readonly index: EventIndex;

  constructor(runId: string, path: string) {
    this.runId = runId;
    this.path = path;
    this.index = new EventIndex(EventIndex.pathFor(path));
  }

  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async emit(
    event: string,
    detail?: unknown,
    state?: string,
    extra?: { toolCallId?: string; sessionRevision?: string },
  ): Promise<ChaosEvent> {
    const rec: ChaosEvent = {
      ts: Date.now(),
      run_id: this.runId,
      event_id: randomUUID(),
      event,
      state,
      detail,
    };
    if (extra?.toolCallId) rec.toolCallId = extra.toolCallId;
    if (extra?.sessionRevision) rec.sessionRevision = extra.sessionRevision;
    this.events.push(rec);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(rec) + "\n");
    this.index.record(rec);
    await this.index.flush();
    const summary = detail === undefined ? "" : ` ${safeSummary(detail)}`;
    console.log(`[${event}]${summary}`);

    for (const listener of this.listeners) {
      try {
        await listener(rec);
      } catch {
        /* listener error swallowed */
      }
    }
    return rec;
  }

  async flushSnapshot(path: string): Promise<void> {
    await writeFile(path, this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : ""));
  }
}

function safeSummary(detail: unknown): string {
  try {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    return text.length > 240 ? text.slice(0, 237) + "..." : text;
  } catch {
    return "";
  }
}
