import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChaosEvent } from "./events.ts";

export type EventQuery = {
  runId?: string;
  event?: string | string[];
  since?: number;
  until?: number;
  limit?: number;
};

export type EventIndexSummary = {
  runId: string;
  count: number;
  firstTs?: number;
  lastTs?: number;
  events: Record<string, number>;
};

/** Small dependency-free event index. It is JSON and therefore portable/queryable without sqlite. */
export class EventIndex {
  readonly path: string;
  private readonly summaries = new Map<string, EventIndexSummary>();

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        const rows = JSON.parse(readFileSync(path, "utf8")) as EventIndexSummary[];
        for (const row of rows) this.summaries.set(row.runId, row);
      } catch {
        /* rebuild lazily from event logs */
      }
    }
  }

  record(event: ChaosEvent): void {
    const row = this.summaries.get(event.run_id) ?? { runId: event.run_id, count: 0, events: {} };
    row.count += 1;
    row.firstTs = row.firstTs == null ? event.ts : Math.min(row.firstTs, event.ts);
    row.lastTs = row.lastTs == null ? event.ts : Math.max(row.lastTs, event.ts);
    row.events[event.event] = (row.events[event.event] ?? 0) + 1;
    this.summaries.set(event.run_id, row);
  }

  async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify([...this.summaries.values()], null, 2) + "\n");
  }

  summary(runId?: string): EventIndexSummary[] {
    return [...this.summaries.values()].filter((row) => !runId || row.runId === runId);
  }

  clear(): void {
    this.summaries.clear();
  }

  static async query(eventsPath: string, query: EventQuery = {}): Promise<ChaosEvent[]> {
    if (!existsSync(eventsPath)) return [];
    const wanted = query.event ? new Set(Array.isArray(query.event) ? query.event : [query.event]) : undefined;
    const out: ChaosEvent[] = [];
    const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as ChaosEvent;
        if (query.runId && event.run_id !== query.runId) continue;
        if (wanted && !wanted.has(event.event)) continue;
        if (query.since != null && event.ts < query.since) continue;
        if (query.until != null && event.ts > query.until) continue;
        out.push(event);
        if (query.limit != null && out.length >= query.limit) break;
      } catch {
        /* tolerate a partially written event */
      }
    }
    return out;
  }

  static pathFor(eventsPath: string): string {
    return join(dirname(eventsPath), "events.index.json");
  }
}

export async function indexEventLog(eventsPath: string, indexPath = EventIndex.pathFor(eventsPath)): Promise<EventIndex> {
  const index = new EventIndex(indexPath);
  index.clear();
  const events = await EventIndex.query(eventsPath);
  for (const event of events) index.record(event);
  await index.flush();
  return index;
}
