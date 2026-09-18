import type { ChaosEvent } from "./events.ts";
import type { Fault } from "./spec.ts";

export type TrajectoryPoint = { ts: number; event: string; state?: string; detail?: unknown };

export function extractTrajectory(events: ChaosEvent[]): TrajectoryPoint[] {
  return events
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map(({ ts, event, state, detail }) => ({ ts, event, state, detail }));
}

/** Deterministic, seedable fault perturbation for property/endurance experiments. */
export function fuzzFaults(faults: Fault[], seed = 1, count = 1): Fault[][] {
  let state = seed >>> 0;
  const next = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  return Array.from({ length: Math.max(0, count) }, () =>
    faults.map((fault) => ({
      ...fault,
      atMs: Math.max(0, Math.round(fault.atMs * (0.75 + next() * 0.5))),
      durationMs: fault.durationMs == null ? undefined : Math.max(1, Math.round(fault.durationMs * (0.75 + next() * 0.5))),
    })),
  );
}
