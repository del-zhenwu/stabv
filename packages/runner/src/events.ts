import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type ChaosEvent = {
  ts: number;
  run_id: string;
  event_id: string;
  event: string;
  state?: string;
  detail?: unknown;
};

export class EventStore {
  readonly path: string;
  readonly events: ChaosEvent[] = [];
  private runId: string;
  constructor(runId: string, path: string) {
    this.runId = runId;
    this.path = path;
  }

  async emit(event: string, detail?: unknown, state?: string): Promise<ChaosEvent> {
    const rec: ChaosEvent = {
      ts: Date.now(),
      run_id: this.runId,
      event_id: randomUUID(),
      event,
      state,
      detail,
    };
    this.events.push(rec);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(rec) + "\n");
    const summary = detail === undefined ? "" : ` ${safeSummary(detail)}`;
    console.log(`[${event}]${summary}`);
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
