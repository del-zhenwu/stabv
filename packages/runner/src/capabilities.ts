import type { Experiment, Fault } from "./spec.ts";
import { faultLabel } from "./spec.ts";

export type CapabilityStatus = "ok" | "degraded" | "unsupported";

export type RiskPreview = {
  writesWorkspace: boolean;
  killsProcess: boolean;
  pausesProcess: boolean;
  usesProxy: boolean;
  bypassApprovals: boolean;
  status: CapabilityStatus;
  required: string[];
  notes: string[];
};

export function requiredCapabilities(exp: Experiment): string[] {
  const caps = new Set<string>(["cli"]);
  for (const fault of exp.faults) {
    if (fault.kind === "process") caps.add("kill-tree");
    if (fault.kind === "process" && fault.action === "pause") {
      caps.add("pause-tree");
      caps.add("resume-tree");
    }
    if (fault.kind === "file" && fault.action === "lock") caps.add("flock");
    if (fault.kind === "file" && fault.action === "chmod") caps.add("acl");
    if (fault.kind === "resource" && fault.action === "cpu") caps.add("cpu-stress");
    if (fault.kind === "resource" && fault.action === "memory") caps.add("mem-stress");
    if (fault.kind === "network" || fault.kind === "llm") caps.add("proxy");
  }
  if (exp.recovery.resume) caps.add("session-resume");
  if (exp.target.pty) caps.add("pty");
  return [...caps];
}

export function previewRisk(exp: Experiment, helperCaps: string[] = []): RiskPreview {
  const required = requiredCapabilities(exp);
  const notes: string[] = [];
  const helperSet = new Set(helperCaps);
  let status: CapabilityStatus = "ok";
  if (exp.target.pty) {
    if (helperCaps.includes("pty")) {
      /* helper provides Unix PTY / Windows ConPTY */
    } else {
      notes.push("PTY/ConPTY helper capability missing; CLI uses pipes (degraded)");
      status = "degraded";
    }
  }
  if (exp.faults.some((f) => f.kind === "llm") && (exp.target.adapter === "codex" || exp.target.adapter === "zcode")) {
    notes.push(`${exp.target.adapter} may ignore OPENAI_BASE_URL; llm faults can be degraded`);
    status = "degraded";
  }
  if (exp.faults.some((f) => f.kind === "network")) {
    notes.push("network faults need the agent to honor HTTP(S)_PROXY");
    if (status === "ok") status = "degraded";
  }
  for (const cap of required) {
    if (cap === "proxy" || cap === "cli" || cap === "session-resume") continue;
    if (helperCaps.length && !helperSet.has(cap) && !helperSet.has(cap.replace("-tree", ""))) {
      notes.push(`helper may lack ${cap}`);
      status = status === "unsupported" ? status : "degraded";
    }
  }
  return {
    writesWorkspace: exp.faults.some((f) => f.kind === "file" || f.kind === "git"),
    killsProcess: exp.faults.some((f) => f.kind === "process" && (f.action === "kill" || f.action === "restart")),
    pausesProcess: exp.faults.some((f) => f.kind === "process" && f.action === "pause"),
    usesProxy: exp.faults.some((f) => f.kind === "network" || f.kind === "llm"),
    bypassApprovals: Boolean(exp.target.bypassApprovals),
    status,
    required,
    notes,
  };
}

export function faultNames(faults: Fault[]): string[] {
  return faults.map(faultLabel);
}
