import type { Experiment, Fault } from "./spec.ts";
import { faultLabel } from "./spec.ts";
import { planLaunch, usesDiscoveredZcodeCli, zcodeCliCredentialError } from "./adapters.ts";

export type CapabilityStatus = "ok" | "degraded" | "unsupported";

export type RiskPreview = {
  writesWorkspace: boolean;
  killsProcess: boolean;
  pausesProcess: boolean;
  usesProxy: boolean;
  bypassApprovals: boolean;
  status: CapabilityStatus;
  required: string[];
  capabilities: Record<string, CapabilityStatus>;
  notes: string[];
};

export function requiredCapabilities(exp: Experiment): string[] {
  const caps = new Set<string>(["cli"]);
  for (const fault of exp.faults) {
    if (fault.kind === "process") caps.add("kill-tree");
    if (fault.kind === "compaction") caps.add("kill-tree");
    if (fault.kind === "process" && fault.action === "pause") {
      caps.add("pause-tree");
      caps.add("resume-tree");
    }
    if (fault.kind === "file" && fault.action === "lock") caps.add("flock");
    if (fault.kind === "file" && fault.action === "chmod") caps.add("acl");
    if (fault.kind === "resource" && fault.action === "cpu") caps.add("cpu-stress");
    if (fault.kind === "resource" && fault.action === "memory") caps.add("mem-stress");
    if (fault.kind === "resource" && fault.action === "disk") caps.add("disk-stress");
    if (fault.kind === "resource" && fault.action === "handle_exhaustion") caps.add("handle-stress");
    if (fault.kind === "resource" && fault.action === "disk_exhaustion") caps.add("disk-exhaustion");
    if (fault.kind === "subagent") {
      if (fault.action === "kill" || fault.action === "fail") caps.add("kill-process");
      if (fault.action === "timeout") {
        caps.add("pause-tree");
        caps.add("resume-tree");
      }
    }
    if (fault.kind === "session") caps.add("session-isolation");
    if (fault.kind === "desktop") {
      caps.add("desktop-ui");
      if (fault.action === "screenshot") caps.add("desktop-screenshot");
    }
    if (fault.kind === "remote") caps.add("remote-lifecycle");
    if (fault.kind === "network" || fault.kind === "llm" || fault.kind === "mcp" || fault.kind === "rule" || fault.kind === "context") caps.add("proxy");
  }
  if (exp.mode === "auto") {
    caps.add("proxy");
    caps.add("auto-llm");
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
  const targetCaps = new Set(planLaunch(exp).capabilities);
  if (exp.target.pty) {
    if (helperCaps.includes("pty")) {
      /* helper provides Unix PTY / Windows ConPTY */
    } else {
      notes.push("PTY/ConPTY helper capability missing; CLI uses pipes (degraded)");
      status = "degraded";
    }
  }
  if (exp.mode === "auto" && !process.env.AGENTCHAOS_LLM_API_KEY) {
    notes.push("mode: auto needs AGENTCHAOS_LLM_API_KEY");
    status = "unsupported";
  }
  if (usesDiscoveredZcodeCli(exp.target)) {
    const credErr = zcodeCliCredentialError();
    if (credErr) {
      notes.push(credErr);
      status = "unsupported";
    }
  }
  if (exp.faults.some((f) => f.kind === "llm") && (exp.target.adapter === "codex" || exp.target.adapter === "zcode" || exp.target.adapter === "claude" || exp.target.adapter === "kimi")) {
    notes.push(`${exp.target.adapter} may ignore OPENAI_BASE_URL; llm faults can be degraded`);
    if (status !== "unsupported") status = "degraded";
  }
  if (exp.faults.some((f) => f.kind === "mcp")) {
    notes.push("mcp faults need the agent to call AGENTCHAOS_MCP_URL (HTTP JSON-RPC)");
    if (exp.target.adapter === "codex" || exp.target.adapter === "zcode" || exp.target.adapter === "claude" || exp.target.adapter === "kimi") {
      notes.push(`${exp.target.adapter} may not use AGENTCHAOS_MCP_URL unless an MCP server is pointed at the proxy`);
      if (status !== "unsupported") status = "degraded";
    }
  }
  if (exp.faults.some((f) => f.kind === "network")) {
    notes.push("network faults need the agent to honor HTTP(S)_PROXY");
    if (status === "ok") status = "degraded";
  }
  if (required.includes("session-resume") && !targetCaps.has("session-resume")) {
    notes.push(`${exp.target.adapter} adapter does not provide session-resume for this target configuration`);
    status = "unsupported";
  }
  if (exp.faults.some((fault) => fault.kind === "session")) {
    if (!exp.target.sessionHome) {
      notes.push("session faults require target.sessionHome so the real agent store stays isolated");
      status = "unsupported";
    }
    if (exp.target.adapter !== "codex" && exp.target.adapter !== "claude") {
      notes.push(`${exp.target.adapter} has no implemented isolated session-home contract`);
      status = "unsupported";
    }
  }
  if (exp.faults.some((fault) => fault.kind === "desktop")) {
    if (!exp.target.desktop) {
      notes.push("desktop faults require target.desktop: true");
      status = "unsupported";
    }
  }
  for (const cap of required) {
    if (cap === "proxy" || cap === "cli" || cap === "auto-llm" || cap === "session-resume" || cap === "session-isolation" || cap === "remote-lifecycle") continue;
    if (!helperSet.has(cap) && !helperSet.has(cap.replace("-tree", ""))) {
      notes.push(`helper lacks ${cap}`);
      if (cap === "pty") {
        status = status === "unsupported" ? status : "degraded";
      } else {
        status = "unsupported";
      }
    }
  }
  const capabilities: Record<string, CapabilityStatus> = {};
  for (const cap of required) {
    if (cap === "pty" && !helperSet.has("pty")) capabilities[cap] = "degraded";
    else if (
      cap === "proxy" ||
      cap === "cli" ||
      cap === "auto-llm" ||
      cap === "session-resume" ||
      cap === "session-isolation" ||
      cap === "remote-lifecycle" ||
      helperSet.has(cap) ||
      helperSet.has(cap.replace("-tree", ""))
    ) {
      capabilities[cap] = "ok";
    } else {
      capabilities[cap] = "unsupported";
    }
  }
  return {
    writesWorkspace: exp.faults.some((f) => f.kind === "file" || f.kind === "git" || (f.kind === "resource" && (f.action === "disk" || f.action === "disk_exhaustion"))),
    killsProcess: exp.faults.some(
      (f) =>
        (f.kind === "process" && (f.action === "kill" || f.action === "restart")) ||
        f.kind === "compaction" ||
        (f.kind === "subagent" && (f.action === "kill" || f.action === "fail")),
    ),
    pausesProcess: exp.faults.some(
      (f) => (f.kind === "process" && f.action === "pause") || (f.kind === "subagent" && f.action === "timeout"),
    ),
    usesProxy: exp.mode === "auto" || exp.faults.some((f) => f.kind === "network" || f.kind === "llm" || f.kind === "mcp"),
    bypassApprovals: Boolean(exp.target.bypassApprovals),
    status,
    required,
    capabilities,
    notes,
  };
}

export function faultNames(faults: Fault[]): string[] {
  return faults.map(faultLabel);
}
