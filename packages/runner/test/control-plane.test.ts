import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applyPerturbations, loadSpecText, validateExperiment } from "../src/spec.ts";
import {
  applyLlmFieldMutation,
  createLlmInjectState,
  decideLlmInject,
  mockAssistantPayload,
  resolveLlmScene,
} from "../src/llm-api.ts";
import { parseDuration } from "../src/duration.ts";
import { runExperiment } from "../src/runner.ts";
import { repoRoot } from "../src/paths.ts";
import { expandSuiteCases, loadComposedExperiment, loadExperimentFile, loadRunnable, loadSuiteFile, loadWorkflowFile } from "../src/compose.ts";
import { parseInject, resolveInjectProfiles } from "../src/inject.ts";
import { previewRisk } from "../src/capabilities.ts";
import { runSuite } from "../src/suite.ts";
import { runWorkflow } from "../src/workflow.ts";
import { applyResumeArgs, discoverAgents, planLaunch, AGENT_REGISTRY, zcodeCliEnv, isZcodeCaptchaEndpoint, zcodeCliCredentialError } from "../src/adapters.ts";
import { runAssertions } from "../src/assertions.ts";
import { parseFlags, writeStarterSpec } from "../src/cli.ts";
import { assertInsideWorkspace, listBundledFixtures, resolveFixture } from "../src/workspace.ts";
import { bundledHelperPath, helperExeName, helperPlatformKey, missingPackagedHelpers } from "../src/helper-bin.ts";
import { existsSync } from "node:fs";
import { startViewer, collectRuns } from "../src/view.ts";
import { classifyAgentEvent } from "../src/native-events.ts";
import { LlmProxy } from "../src/proxy.ts";

const root = repoRoot();

describe("spec", () => {
  it("parses durations", () => {
    assert.equal(parseDuration(0.2), 200);
    assert.equal(parseDuration("250ms"), 250);
    assert.equal(parseDuration("2s"), 2000);
    assert.equal(parseDuration("1m"), 60_000);
  });

  it("normalizes legacy and v1alpha1 faults", async () => {
    const smoke = loadSpecText(await readFile(resolve(root, "examples/probe/codex-smoke.yaml"), "utf8"), "codex-smoke.yaml");
    assert.equal(smoke.target.adapter, "generic-cli");
    assert.equal(smoke.faults[0]?.kind, "file");
    assert.deepEqual(validateExperiment(smoke), []);

    const kill = loadSpecText(await readFile(resolve(root, "examples/probe/codex-kill.json"), "utf8"), "codex-kill.json");
    assert.equal(kill.target.adapter, "generic-cli");
    assert.equal(kill.faults[0]?.kind, "process");
    assert.equal(kill.faults[0]?.action, "kill");
    assert.equal(smoke.mode, "rules");
  });

  it("requires AGENTCHAOS_LLM_API_KEY for mode: auto", async () => {
    const prev = process.env.AGENTCHAOS_LLM_API_KEY;
    delete process.env.AGENTCHAOS_LLM_API_KEY;
    try {
      const exp = await loadExperimentFile(resolve(root, "examples/cases/auto.yaml"));
      assert.equal(exp.mode, "auto");
      assert.ok(validateExperiment(exp).some((e) => e.includes("AGENTCHAOS_LLM_API_KEY")));
    } finally {
      if (prev != null) process.env.AGENTCHAOS_LLM_API_KEY = prev;
    }
  });

  it("omitted assertions use the chaos check set, not just timeout and orphans", () => {
    const auto = loadSpecText(
      [
        "spec:",
        "  mode: auto",
        "  target:",
        "    adapter: zcode",
        "    prompt: fix it",
        "  fixture: broken-sum",
      ].join("\n"),
      "default-auto.yaml",
    );
    assert.equal(auto.assertionsDefaulted, true);
    assert.deepEqual(
      auto.assertions.map((a) => a.type),
      [
        "not_timed_out",
        "no_orphan_process",
        "no_duplicate_tool_side_effect",
        "no_lost_tool_result",
        "git_lock_absent",
        "git_state_consistent",
        "application_eventually_responsive",
        "llm_triggered",
      ],
    );

    const kill = loadSpecText(
      [
        "spec:",
        "  target:",
        "    adapter: generic-cli",
        "    executable: node",
        "    args: ['-e', 'process.exit(1)']",
        "  git: true",
        "  faults:",
        "    - type: process",
        "      action: kill",
        "      at: 1s",
      ].join("\n"),
      "default-kill.yaml",
    );
    assert.deepEqual(
      kill.assertions.map((a) => (a.type === "fault_injected" ? `fault_injected:${a.fault}` : a.type)),
      [
        "not_timed_out",
        "no_orphan_process",
        "no_duplicate_tool_side_effect",
        "no_lost_tool_result",
        "git_lock_absent",
        "git_state_consistent",
        "fault_injected:process.kill",
      ],
    );
  });

  it("parses llm scene, field, and schedule knobs", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/llm-empty.yaml"), "utf8"), "llm-empty.yaml");
    const fault = exp.faults[0];
    assert.equal(fault?.kind, "llm");
    if (fault?.kind !== "llm") throw new Error("expected llm fault");
    assert.equal(fault.action, "empty");
    assert.equal(fault.scene, "content_filter");
    assert.equal(fault.field, "both");
    const burst = loadSpecText(await readFile(resolve(root, "examples/probe/llm-schedule-burst.yaml"), "utf8"), "llm-schedule-burst.yaml");
    const burstFault = burst.faults[0];
    assert.equal(burstFault?.kind, "llm");
    if (burstFault?.kind !== "llm") throw new Error("expected llm fault");
    assert.equal(burstFault.schedule, "burst");
    assert.equal(burstFault.burst, 2);
  });

  it("composes workload and chaos profile", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/cases/compose.yaml"));
    assert.equal(exp.name, "composed-file-edit");
    assert.equal(exp.target.executable, "node");
    assert.equal(exp.faults[0]?.action, "edit");
    assert.deepEqual(validateExperiment(exp), []);
  });

  it("loads suite and workflow documents", async () => {
    const suite = await loadSuiteFile(resolve(root, "examples/suites/smoke.yaml"));
    assert.equal(suite.kind, "Suite");
    assert.ok(suite.experiments.length >= 3);
    const workflow = await loadWorkflowFile(resolve(root, "examples/workflows/workflow.yaml"));
    assert.equal(workflow.tasks[0]?.type, "serial");
    assert.equal(workflow.tasks[1]?.type, "parallel");
    assert.equal(workflow.failFast, true);
    const cont = await loadWorkflowFile(resolve(root, "examples/workflows/workflow-continue.yaml"));
    assert.equal(cont.failFast, false);
  });

  it("expands suite workloads × profiles without per-agent copies", async () => {
    const suite = await loadSuiteFile(resolve(root, "examples/suites/cli-agents.yaml"));
    const cases = await expandSuiteCases(suite);
    assert.equal(cases.length, 8);
    assert.ok(cases.some((c) => c.exp.name === "zcode-process-kill"));
    assert.ok(cases.some((c) => c.exp.name === "codex-llm-429"));
    assert.equal(cases.find((c) => c.exp.name === "zcode-process-kill")?.exp.target.adapter, "zcode");
    assert.equal(cases.find((c) => c.exp.name === "codex-llm-429")?.exp.faults[0]?.action, "429");
  });

  it("expands adapter + inject into the catalog combination", async () => {
    assert.deepEqual(parseInject(["llm", "resource"]), { tokens: ["llm", "resource"], together: false });
    assert.deepEqual(parseInject({ llm: ["429", "500"], resource: "cpu" }), {
      tokens: ["llm/429", "llm/500", "resource/cpu"],
      together: false,
    });
    const llm = resolveInjectProfiles(["llm"]);
    assert.ok(llm.some((p) => p.endsWith("429.yaml")));
    const runnable = await loadRunnable(resolve(root, "examples/zcode.yaml"));
    assert.equal(runnable.kind, "suite");
    if (runnable.kind !== "suite") throw new Error("expected suite");
    const cases = await expandSuiteCases(runnable.suite);
    assert.ok(cases.length >= 15);
    assert.ok(cases.every((c) => c.exp.target.adapter === "zcode"));
    assert.ok(cases.some((c) => c.exp.faults[0]?.kind === "llm"));
    assert.ok(cases.some((c) => c.exp.faults[0]?.kind === "resource"));
    assert.ok(cases.some((c) => c.exp.faults[0]?.kind === "file"));
    assert.ok(cases.some((c) => c.exp.faults[0]?.kind === "git"));
    assert.ok(cases.some((c) => c.exp.faults[0]?.kind === "network"));
    assert.ok(cases.some((c) => c.exp.faults[0]?.kind === "process"));
    assert.deepEqual(runnable.suite.inject, ["llm", "resource", "file", "git", "network", "process"]);
  });

  it("includes YAML line numbers in fault parse errors", () => {
    const text = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: bad-fault",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      "    executable: node",
      "  faults:",
      "    - type: nope",
      "      at: 1s",
    ].join("\n");
    assert.throws(() => loadSpecText(text, "bad.yaml"), /bad.yaml:10: faults\[0] unknown type nope/);
  });

  it("applies reliability-style prompt noise", () => {
    const out = applyPerturbations("fix the bug", [{ type: "prompt_noise", text: "retry the last tool" }]);
    assert.match(out, /retry the last tool/);
    assert.match(out, /fix the bug/);
  });

  it("previews capability risk", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/file-lock.yaml"));
    const risk = previewRisk(exp, ["flock", "kill-tree"]);
    assert.equal(risk.writesWorkspace, true);
    assert.ok(risk.required.includes("flock"));
    assert.notEqual(risk.status, "unsupported");
  });

  it("marks missing mandatory helper capabilities unsupported", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/process-kill.yaml"));
    const risk = previewRisk(exp, []);
    assert.equal(risk.status, "unsupported");
    assert.ok(risk.notes.some((note) => note.includes("kill-tree")));
  });

  it("marks generic-cli resume as unsupported", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/process-kill.yaml"));
    exp.recovery.resume = true;
    const risk = previewRisk(exp, ["kill-tree"]);
    assert.equal(risk.status, "unsupported");
    assert.ok(risk.notes.some((note) => note.includes("session-resume")));
  });

  it("plans zcode headless argv", async () => {
    const exp = await loadComposedExperiment({
      workload: "examples/workloads/zcode.yaml",
      profile: "examples/profiles/process/kill.yaml",
      fromDir: root,
    });
    assert.deepEqual(validateExperiment(exp), []);
    const plan = planLaunch(exp);
    assert.ok(plan.args.includes("--prompt"));
    assert.ok(plan.args.includes("--json"));
    assert.ok(plan.args.includes("--no-color"));
    assert.equal(plan.args[plan.args.indexOf("--mode") + 1], "yolo");
    assert.ok(plan.capabilities.includes("json-events"));
    const found = discoverAgents().find((a) => a.adapter === "zcode");
    assert.ok(found);
    if (found.present) {
      assert.match(found.executable, /zcode/i);
    }
    assert.equal(applyResumeArgs(plan, exp.target, "sess_test"), true);
    assert.ok(plan.args.includes("--resume"));
    assert.ok(plan.args.includes("sess_test"));
  });

  it("plans claude and kimi headless argv", async () => {
    const claude = await loadComposedExperiment({
      workload: "examples/workloads/claude.yaml",
      profile: "examples/profiles/process/kill.yaml",
      fromDir: root,
    });
    assert.deepEqual(validateExperiment(claude), []);
    const claudePlan = planLaunch(claude);
    assert.ok(claudePlan.args.includes("--print"));
    assert.equal(claudePlan.args[claudePlan.args.indexOf("--output-format") + 1], "stream-json");
    assert.ok(claudePlan.args.includes("--dangerously-skip-permissions"));
    assert.ok(claudePlan.capabilities.includes("json-events"));
    assert.equal(applyResumeArgs(claudePlan, claude.target, "sess_claude"), true);
    assert.ok(claudePlan.args.includes("--resume"));
    assert.ok(claudePlan.args.includes("sess_claude"));

    const kimi = await loadComposedExperiment({
      workload: "examples/workloads/kimi.yaml",
      profile: "examples/profiles/process/kill.yaml",
      fromDir: root,
    });
    assert.deepEqual(validateExperiment(kimi), []);
    const kimiPlan = planLaunch(kimi);
    assert.ok(kimiPlan.args.includes("--print"));
    assert.ok(kimiPlan.args.includes("--yolo"));
    assert.equal(applyResumeArgs(kimiPlan, kimi.target, "sess_kimi"), true);
    assert.ok(kimiPlan.args.includes("--resume"));
  });

  it("classifies Codex, Claude, and generic native events", () => {
    const toolStart = classifyAgentEvent({
      type: "item.started",
      item: { id: "call_1", type: "command_execution" },
    });
    assert.equal(toolStart?.kind, "tool_started");
    assert.equal(toolStart?.toolCallId, "call_1");
    const toolEnd = classifyAgentEvent({
      type: "item.completed",
      item: { id: "call_1", type: "command_execution" },
    });
    assert.equal(toolEnd?.kind, "tool_finished");
    const approval = classifyAgentEvent({ type: "approval_requested" });
    assert.equal(approval?.kind, "approval_requested");
    const compact = classifyAgentEvent({ type: "compaction_started" });
    assert.equal(compact?.kind, "compaction_started");
    const claudeTool = classifyAgentEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }] },
    });
    assert.equal(claudeTool?.kind, "tool_started");
    assert.equal(claudeTool?.toolCallId, "toolu_1");
    const chatter = classifyAgentEvent({
      type: "item.started",
      item: { id: "msg_1", type: "agent_message" },
    });
    assert.equal(chatter, undefined);
  });

  it("parses event-triggered and mcp faults", async () => {
    const kill = await loadExperimentFile(resolve(root, "examples/probe/event-tool-kill.yaml"));
    assert.equal(kill.faults[0]?.when, "tool_started");
    const compact = await loadExperimentFile(resolve(root, "examples/probe/compaction-interrupt.yaml"));
    assert.equal(compact.faults[0]?.kind, "compaction");
    assert.equal(compact.faults[0]?.when, "compaction_started");
    const mcp = await loadExperimentFile(resolve(root, "examples/probe/mcp-429.yaml"));
    assert.equal(mcp.faults[0]?.kind, "mcp");
    assert.deepEqual(validateExperiment(kill), []);
    assert.deepEqual(validateExperiment(compact), []);
    assert.deepEqual(validateExperiment(mcp), []);
  });

  it("requires an explicit desktop target for native text input", () => {
    const exp = loadSpecText(
      [
        "kind: Experiment",
        "metadata:",
        "  name: desktop-input",
        "spec:",
        "  target:",
        "    adapter: generic-cli",
        "    executable: node",
        "    args: ['-e', 'setTimeout(() => {}, 100)']",
        "  faults:",
        "    - type: desktop",
        "      action: send_text",
        "      text: hello",
      ].join("\n"),
      "desktop-input.yaml",
    );
    assert.deepEqual(validateExperiment(exp), ["desktop faults require target.desktop: true and a native desktop target"]);
  });
});

describe("control plane chaos", () => {
  it("injects an external file edit", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/codex-smoke.yaml"), "utf8"), "codex-smoke.yaml");
    const result = await runExperiment(exp, "examples/probe/codex-smoke.yaml");
    assert.equal(result.exitCode, 0);
  });

  it("kills the process tree", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/process-kill.yaml"), "utf8"), "process-kill.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.injected.includes("process.kill"));
  });

  it("pauses and resumes the process tree", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/process-pause.yaml"), "utf8"), "process-pause.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("mutates files while the agent runs", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/file-chaos.yaml"), "utf8"), "file-chaos.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("holds an exclusive file lock", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/file-lock.yaml"));
    const result = await runExperiment(exp, resolve(root, "examples/probe/file-lock.yaml"));
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.injected.includes("file.lock"));
  });

  it("injects a git lock and conflict", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/git-lock.yaml"), "utf8"), "git-lock.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("returns 429 from the LLM proxy", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/llm-429.yaml"), "utf8"), "llm-429.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("returns 401 from the LLM proxy", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/llm-401.yaml"), "utf8"), "llm-401.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("truncates an LLM SSE stream", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/llm-truncate.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("drops an LLM stream mid-request", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/llm-timeout.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("writes a large file blob into the workspace", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/file-large.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.metrics && result.report.metrics.shadowSnapshots >= 2);
  });

  it("occupies a TCP port", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/resource-port.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("returns malformed LLM JSON", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/probe/llm-malformed.yaml"), "utf8"), "llm-malformed.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("returns schema-drifted LLM JSON", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/llm-schema-drift.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("injects field-level and scheduled LLM API faults", async () => {
    for (const name of [
      "llm-empty.yaml",
      "llm-corrupt.yaml",
      "llm-html.yaml",
      "llm-stale-cache.yaml",
      "llm-stale-data.yaml",
      "llm-wrong-entity.yaml",
      "llm-degrade.yaml",
      "llm-field-tool-calls.yaml",
      "llm-schedule-burst.yaml",
      "llm-schedule-position.yaml",
    ]) {
      const exp = await loadExperimentFile(resolve(root, "examples/probe", name));
      const result = await runExperiment(exp);
      assert.equal(result.exitCode, 0, name);
      assert.ok((result.report.metrics?.llmTriggered ?? 0) >= 1, `${name} should trigger`);
    }
  });

  it("runs a hidden grader and expected workspace files", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/task-tests.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.checks.some((c) => c.assertion === "task_tests_pass" && c.passed));
    assert.ok(result.report.metrics);
  });

  it("kills and restarts the agent", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/kill-and-resume.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok((result.report.metrics?.restarts ?? 0) >= 1, "expected at least one restart");
    assert.equal(result.report.metrics?.resumeAttempts, 0);
    assert.ok((result.report.metrics?.shadowSnapshots ?? 0) >= 2);
  });

  it("runs a pass^k suite", async () => {
    const suite = await loadSuiteFile(resolve(root, "examples/suites/fast.yaml"));
    const report = await runSuite(suite);
    assert.equal(report.passed, true);
    assert.equal(report.passK["composed-file-edit"]?.passHatK, true);
  });

  it("runs a serial workflow", async () => {
    const workflow = await loadWorkflowFile(resolve(root, "examples/workflows/workflow-fast.yaml"));
    const report = await runWorkflow(workflow);
    assert.equal(report.passed, true);
    assert.equal(report.steps.length, 2);
  });

  it("injects stdin on a pipe", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/input-send.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("relays stdin over a helper PTY", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/pty-echo.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.match(result.report.command.join(" "), /pty-spawn|node/);
  });

  it("dry-runs an experiment without spawning the workload", async () => {
    const { dryRunSpec } = await import("../src/dryrun.ts");
    const { ok, plan } = await dryRunSpec(resolve(root, "examples/probe/input-send.yaml"));
    assert.equal(ok, true);
    assert.equal(plan.dryRun, true);
    assert.ok(plan.faults?.some((f) => f.label === "input.send"));
    assert.ok(plan.command?.includes("node"));
  });

  it("corrupts a real isolated session file without touching the user home", async () => {
    const exp = loadSpecText(
      [
        "apiVersion: agentchaos.dev/v1alpha1",
        "kind: Experiment",
        "metadata:",
        "  name: isolated-session-corruption",
        "spec:",
        "  target:",
        "    adapter: codex",
        "    executable: node",
        "    args:",
        "      - -e",
        "      - |",
        "        const fs = require('node:fs');",
        "        const path = require('node:path');",
        "        const dir = path.join(process.env.CODEX_HOME, 'sessions');",
        "        fs.mkdirSync(dir, { recursive: true });",
        "        fs.writeFileSync(path.join(dir, 'state.jsonl'), '{\"valid\":true}\\n');",
        "        setTimeout(() => process.exit(0), 400);",
        "    sessionHome: codex-home",
        "  timeout: 5s",
        "  faults:",
        "    - type: session",
        "      action: corrupt",
        "      path: sessions/state.jsonl",
        "      at: 100ms",
        "  assertions:",
        "    - exit_zero",
        "    - fault_injected:session.corrupt",
      ].join("\n"),
      "isolated-session-corruption.yaml",
    );
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.checks.every((check) => check.passed));
    assert.match(result.report.workspace, /\.agentchaos-runs/);
  });

  it("injects MCP HTTP JSON-RPC faults", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/probe/mcp-429.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    const oversized = await loadExperimentFile(resolve(root, "examples/probe/mcp-oversized.yaml"));
    const big = await runExperiment(oversized);
    assert.equal(big.exitCode, 0);
  });

  it("kills on tool_started and interrupts compaction", async () => {
    const kill = await runExperiment(await loadExperimentFile(resolve(root, "examples/probe/event-tool-kill.yaml")));
    assert.equal(kill.exitCode, 0);
    assert.ok(kill.report.checks.some((c) => c.assertion === "event_seen:tool_started" && c.passed));
    const compact = await runExperiment(await loadExperimentFile(resolve(root, "examples/probe/compaction-interrupt.yaml")));
    assert.equal(compact.exitCode, 0);
  });

  it("denies an approval over stdin after approval_requested", async () => {
    const result = await runExperiment(await loadExperimentFile(resolve(root, "examples/probe/approval-deny.yaml")));
    assert.equal(result.exitCode, 0);
  });

  it("counts completed tools and lost tool results", async () => {
    const complete = await runExperiment(await loadExperimentFile(resolve(root, "examples/probe/event-tool-complete.yaml")));
    assert.equal(complete.exitCode, 0);
    assert.equal(complete.report.metrics?.lostToolResults, 0);
    const lost = loadSpecText(
      [
        "apiVersion: agentchaos.dev/v1alpha1",
        "kind: Experiment",
        "metadata:",
        "  name: lost-tool",
        "spec:",
        "  target:",
        "    adapter: generic-cli",
        "    executable: node",
        "    args:",
        "      - -e",
        "      - |",
        '        require("fs").writeSync(1, JSON.stringify({ type: "item.started", item: { id: "call_lost", type: "command_execution" } }) + "\\n");',
        "  timeout: 3s",
        "  assertions: [exit_zero]",
      ].join("\n"),
      "lost-tool.yaml",
    );
    const result = await runExperiment(lost);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.metrics?.lostToolResults, 1);
  });

  it("continues a workflow after a failed step when failFast is false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentchaos-wf-"));
    await writeFile(
      join(dir, "fail.yaml"),
      [
        "apiVersion: agentchaos.dev/v1alpha1",
        "kind: Experiment",
        "metadata:",
        "  name: always-fail",
        "spec:",
        "  target:",
        "    adapter: generic-cli",
        "    executable: node",
        "    args: ['-e', 'process.exit(1)']",
        "  timeout: 5s",
        "  assertions: [exit_zero]",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "ok.yaml"),
      [
        "apiVersion: agentchaos.dev/v1alpha1",
        "kind: Experiment",
        "metadata:",
        "  name: always-ok",
        "spec:",
        "  target:",
        "    adapter: generic-cli",
        "    executable: node",
        "    args: ['-e', '']",
        "  timeout: 5s",
        "  assertions: [exit_zero]",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "wf.yaml"),
      [
        "apiVersion: agentchaos.dev/v1alpha1",
        "kind: Workflow",
        "metadata:",
        "  name: keep-going",
        "spec:",
        "  failFast: false",
        "  tasks:",
        "    - serial:",
        "        - fail.yaml",
        "        - ok.yaml",
      ].join("\n"),
    );
    const workflow = await loadWorkflowFile(join(dir, "wf.yaml"));
    const report = await runWorkflow(workflow);
    assert.equal(report.steps.length, 2);
    assert.equal(report.steps[0]?.passed, false);
    assert.equal(report.steps[1]?.passed, true);
    assert.equal(report.passed, false);
  });
});

describe("eval report", () => {
  it("computes recoverability metrics from events", async () => {
    const { computeMetrics } = await import("../src/report.ts");
    const metrics = computeMetrics(
      [
        { ts: 10, run_id: "r", event_id: "1", event: "fault_injected" },
        { ts: 20, run_id: "r", event_id: "2", event: "recovery_started", detail: { action: "resume" } },
        { ts: 30, run_id: "r", event_id: "3", event: "fault_recovered" },
        { ts: 40, run_id: "r", event_id: "4", event: "fault_injected" },
        { ts: 70, run_id: "r", event_id: "5", event: "fault_recovered" },
        { ts: 80, run_id: "r", event_id: "6", event: "shadow_compare", detail: { phase: "end", git: { indexLock: false } } },
      ],
      0,
      100,
      ["tool-1"],
      4,
      { start: "aaa", end: "bbb", tree: { root: 1, alive: false, processes: [{ pid: 1 }, { pid: 2 }] }, resumeVerified: true },
    );
    assert.equal(metrics.recoveryRate, 1);
    assert.equal(metrics.mttrMs, 25); // average of (30-10) and (70-40), not just the first pair
    assert.equal(metrics.resumeSuccess, true);
    assert.equal(metrics.resumeAttempts, 1);
    assert.equal(metrics.restarts, 0);
    assert.equal(metrics.orphanCount, 1);
    assert.equal(metrics.duplicateSideEffectRate, 0.25);
    assert.equal(metrics.stateDivergence, false);
    assert.equal(metrics.shadowSnapshots, 1);
  });

  it("marks resume failed when the restarted agent uses a different session", async () => {
    const { computeMetrics } = await import("../src/report.ts");
    const metrics = computeMetrics(
      [{ ts: 10, run_id: "r", event_id: "1", event: "recovery_started", detail: { action: "resume" } }],
      0,
      50,
      [],
      0,
      { resumeMismatched: "sess-2" },
    );
    assert.equal(metrics.resumeAttempts, 1);
    assert.equal(metrics.resumeSuccess, false);
  });

  it("keeps resumeSuccess undefined when a resume cannot be verified", async () => {
    const { computeMetrics } = await import("../src/report.ts");
    const metrics = computeMetrics(
      [{ ts: 10, run_id: "r", event_id: "1", event: "recovery_started", detail: { action: "restart" } }],
      0,
      50,
      [],
      0,
      {},
    );
    assert.equal(metrics.resumeAttempts, 0);
    assert.equal(metrics.resumeSuccess, undefined);
    assert.equal(metrics.restarts, 1);
  });

  it("renders langfuse-style scores and trace", async () => {
    const { renderHtml, renderIndexHtml } = await import("../src/report.ts");
    const html = renderHtml(
      {
        id: "run-1",
        name: "demo",
        startedAt: 1,
        finishedAt: 1200,
        command: ["node", "-e", "ok"],
        workspace: "/tmp/ws",
        result: { code: 0, signal: null, timedOut: false },
        injected: ["file.edit"],
        checks: [{ assertion: "exit_zero", passed: true }],
        passed: true,
        events: "events.jsonl",
        metrics: {
          durationMs: 1199,
          injected: 1,
          recovered: 0,
          recoveryRate: 0,
          toolCalls: 0,
          duplicateToolIds: [],
          duplicateSideEffectRate: 0,
          orphanCount: 0,
          resumeAttempts: 0,
          userInterventionCount: 0,
          shadowSnapshots: 0,
        },
      },
      [{ ts: 10, run_id: "run-1", event_id: "e1", event: "run_started" }],
    );
    assert.match(html, /AgentChaos evaluation/);
    assert.match(html, /Scores/);
    assert.match(html, /Trace/);
    assert.match(html, /exit_zero/);
    assert.match(html, /<dt>started<\/dt>/);
    assert.match(html, /<dt>finished<\/dt>/);
    const { classifyRun, renderHtml: renderLive } = await import("../src/report.ts");
    const blocked = classifyRun(
      {
        passed: false,
        injected: [],
        result: { code: 1, signal: null, timedOut: false },
        checks: [
          { assertion: "exit_nonzero", passed: true },
          { assertion: "fault_injected:process.kill", passed: false },
        ],
      },
      [{ ts: 1, run_id: "r", event_id: "e", event: "agent_output", detail: { stream: "stderr", line: "ProviderBusinessError: captcha verify failed" } }],
    );
    assert.equal(blocked.verdict, "inconclusive");
    assert.match(String(blocked.blockReason), /captcha/i);
    const blockedHtml = renderLive(
      {
        id: "blocked-1",
        name: "zcode-process-kill",
        startedAt: 10,
        finishedAt: 20,
        command: ["zcode"],
        workspace: "/tmp",
        result: { code: 1, signal: null, timedOut: false },
        injected: [],
        checks: [{ assertion: "fault_injected:process.kill", passed: false }],
        passed: false,
        events: "events.jsonl",
      },
      [{ ts: 11, run_id: "blocked-1", event_id: "e", event: "agent_output", detail: { stream: "stderr", line: "captcha verify failed" } }],
    );
    assert.match(blockedHtml, /inconclusive/);
    assert.doesNotMatch(blockedHtml, /pill xl fail/);
    const index = renderIndexHtml([
      {
        id: "suite-1",
        name: "protocol-faults",
        kind: "suite",
        passed: false,
        href: "/runs/suite-1/report.html",
        cases: 2,
        passedCases: 1,
        children: [{ id: "run-1", name: "demo", kind: "experiment", passed: true, href: "/runs/run-1/report.html", durationMs: 1199 }],
      },
    ]);
    assert.match(index, /Tasks/);
    assert.match(index, /protocol-faults/);
    assert.match(index, />suite</);
    assert.match(index, /1\/2/);
    assert.doesNotMatch(index, />case</);
    assert.doesNotMatch(index, />demo</);
    const grouped = renderIndexHtml([
      { id: "suite-new", name: "protocol-faults", kind: "suite", passed: true, href: "/runs/suite-new/report.html", cases: 2, passedCases: 2, mtime: 20 },
      { id: "suite-old", name: "protocol-faults", kind: "suite", passed: false, href: "/runs/suite-old/report.html", cases: 2, passedCases: 1, mtime: 10 },
    ]);
    assert.match(grouped, /protocol-faults/);
    assert.match(grouped, />2</);
    assert.match(grouped, /suite-new/);
    assert.doesNotMatch(grouped, /suite-old/);
    const mixed = renderIndexHtml([
      { id: "suite-1", name: "protocol-faults", kind: "suite", passed: true, href: "/runs/suite-1/report.html", cases: 1, passedCases: 1 },
      { id: "solo", name: "codex-smoke", kind: "experiment", passed: true, href: "/runs/solo/report.html" },
    ]);
    assert.match(mixed, /standalone experiments/);
    assert.match(mixed, /codex-smoke/);
  });

  it("caps a long HTML trace", async () => {
    const { renderHtml } = await import("../src/report.ts");
    const events = Array.from({ length: 400 }, (_, i) => ({
      ts: i,
      run_id: "run-1",
      event_id: `e${i}`,
      event: i === 0 ? "run_started" : i === 399 ? "run_finished" : "agent_output",
    }));
    const html = renderHtml(
      {
        id: "run-1",
        name: "long",
        startedAt: 0,
        finishedAt: 400,
        command: ["node"],
        workspace: "/tmp/ws",
        result: { code: 0, signal: null, timedOut: false },
        injected: [],
        checks: [],
        passed: true,
        events: "events.jsonl",
      },
      events,
    );
    assert.match(html, /showing last 250 of 400 events/);
    assert.match(html, /run_finished/);
    assert.doesNotMatch(html, />run_started</);
  });
});

describe("cli and viewer robustness", () => {
  it("rejects workspace escapes using platform-aware relative paths", () => {
    const work = join(tmpdir(), "agentchaos-workspace");
    assert.equal(assertInsideWorkspace(work, "src/index.js"), resolve(work, "src/index.js"));
    assert.throws(() => assertInsideWorkspace(work, "../outside.txt"), /escapes workspace/);
    assert.throws(() => assertInsideWorkspace(work, "../../outside.txt"), /escapes workspace/);
  });

  it("rejects unknown flags instead of dropping them", () => {
    const ok = parseFlags(["spec.yaml", "--repeat", "3", "--json", "--dry-run", "--continue"]);
    assert.deepEqual(ok.positional, ["spec.yaml"]);
    assert.equal(ok.flags.repeat, 3);
    assert.equal(ok.flags.json, true);
    assert.equal(ok.flags.dryRun, true);
    assert.equal(ok.flags.continue, true);
    assert.throws(() => parseFlags(["spec.yaml", "--dr-run"]), /unknown flag/);
    assert.throws(() => parseFlags(["--repeat", "abc"]), /invalid value/);
  });

  it("fails application_eventually_responsive when the agent goes silent after fault recovery", async () => {
    const base = {
      code: 1 as number | null,
      signal: null as string | null,
      timedOut: false,
      work: root,
      output: "early output",
      injected: ["file.lock"],
    };
    const silent = await runAssertions([{ type: "application_eventually_responsive" }], {
      ...base,
      lastRecoveryInLoopMs: 500,
      outputAfterRecovery: false,
    });
    assert.equal(silent[0]?.passed, false);
    const active = await runAssertions([{ type: "application_eventually_responsive" }], {
      ...base,
      lastRecoveryInLoopMs: 500,
      outputAfterRecovery: true,
    });
    assert.equal(active[0]?.passed, true);
    const cleanExit = await runAssertions([{ type: "application_eventually_responsive" }], {
      ...base,
      code: 0,
      lastRecoveryInLoopMs: 500,
      outputAfterRecovery: false,
    });
    assert.equal(cleanExit[0]?.passed, true);
  });

  it("suite validation fails fast on a missing experiment file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentchaos-suite-"));
    const suitePath = join(dir, "suite.yaml");
    await writeFile(
      suitePath,
      ["apiVersion: agentchaos.dev/v1alpha1", "kind: Suite", "metadata:", "  name: broken", "spec:", "  experiments:", "    - nope.yaml"].join("\n"),
    );
    const suite = await loadSuiteFile(suitePath);
    await assert.rejects(() => runSuite(suite), /nope\.yaml/);
  });

  it("suite rejects experiments that share metadata.name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentchaos-suite-"));
    const experiment = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: same-name",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      "    executable: node",
      "    args: ['-e', '']",
      "  timeout: 5s",
      "  faults: []",
      "  assertions: [exit_zero]",
    ];
    await writeFile(join(dir, "a.yaml"), experiment.join("\n"));
    await writeFile(join(dir, "b.yaml"), experiment.join("\n"));
    const suitePath = join(dir, "suite.yaml");
    await writeFile(
      suitePath,
      ["apiVersion: agentchaos.dev/v1alpha1", "kind: Suite", "metadata:", "  name: collision", "spec:", "  experiments:", "    - a.yaml", "    - b.yaml"].join("\n"),
    );
    const suite = await loadSuiteFile(suitePath);
    await assert.rejects(() => runSuite(suite), /share metadata\.name/);
  });

  it("validate checks every experiment referenced by a suite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentchaos-validate-"));
    await copyFile(resolve(root, "examples/probe/process-kill.yaml"), join(dir, "composed.yaml"));
    const suitePath = join(dir, "suite.yaml");
    await writeFile(
      suitePath,
      [
        "apiVersion: agentchaos.dev/v1alpha1",
        "kind: Suite",
        "metadata:",
        "  name: one-good-one-missing",
        "spec:",
        "  experiments:",
        "    - composed.yaml",
        "    - missing-experiment.yaml",
      ].join("\n"),
    );
    const cli = resolve(root, "packages/runner/src/cli.ts");
    const good = spawnSync(process.execPath, ["--experimental-strip-types", cli, "validate", "examples/suites/smoke.yaml"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /"ok": true/);
    assert.match(good.stdout, /file-lock\.yaml/);

    const unsupportedPath = join(dir, "generic-resume.yaml");
    await writeFile(
      unsupportedPath,
      [
        "apiVersion: agentchaos.dev/v1alpha1",
        "kind: Experiment",
        "metadata:",
        "  name: generic-resume",
        "spec:",
        "  target:",
        "    adapter: generic-cli",
        "    executable: node",
        "    args: ['-e', '']",
        "  recovery:",
        "    resume: true",
        "  faults: []",
        "  assertions: [exit_zero]",
      ].join("\n"),
    );
    const unsupported = spawnSync(process.execPath, ["--experimental-strip-types", cli, "validate", unsupportedPath], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(unsupported.status, 1, unsupported.stderr);
    assert.match(unsupported.stdout, /"status": "unsupported"/);
    assert.match(unsupported.stderr, /session-resume/);

    // referenced-file-not-found must surface at validate time, not only at run time
    const broken = spawnSync(process.execPath, ["--experimental-strip-types", cli, "validate", suitePath], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(broken.status, 1, broken.stdout);
    assert.match(broken.stderr + broken.stdout, /missing-experiment\.yaml/);
    assert.match(broken.stdout, /"ok": false/);
  });

  it("viewer does not serve files outside .agentchaos-runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentchaos-view-"));
    await mkdir(join(dir, "run-1"), { recursive: true });
    await writeFile(join(dir, "run-1", "report.html"), "<html>ok</html>");
    await writeFile(
      join(dir, "run-1", "report.json"),
      JSON.stringify({
        id: "run-1",
        name: "run-1",
        passed: true,
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_002_000,
        command: ["node"],
        checks: [],
        result: { code: 0, signal: null, timedOut: false },
      }),
    );
    await writeFile(join(dir, "index.jsonl"), "{}\n");
    const viewer = await startViewer({ runsDir: dir, port: 0 });
    try {
      const base = viewer.url;
      const page = await fetch(`${base}/runs/run-1/report.html`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<dt>started<\/dt>/);
      assert.match(html, /<dt>finished<\/dt>/);
      // encoded traversal: /runs/..%2findex.jsonl must not escape the runs dir
      const escape = await fetch(`${base}/runs/..%2findex.jsonl`);
      assert.equal(escape.status, 404);
      const api = await fetch(`${base}/api/runs`);
      assert.equal(api.status, 200);
      assert.equal(JSON.parse(await api.text()).length, 1);
    } finally {
      await viewer.close();
    }
  });

  it("viewer lists suites as jobs and nests their cases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentchaos-jobs-"));
    await mkdir(join(dir, "case-pass"), { recursive: true });
    await mkdir(join(dir, "case-fail"), { recursive: true });
    await mkdir(join(dir, "solo"), { recursive: true });
    await mkdir(join(dir, "suite-task"), { recursive: true });
    await writeFile(
      join(dir, "case-pass", "report.json"),
      JSON.stringify({ id: "case-pass", name: "zcode-rate-limit", passed: true, startedAt: 10, finishedAt: 20 }),
    );
    await writeFile(join(dir, "case-pass", "report.html"), "<html>pass</html>");
    await writeFile(
      join(dir, "case-fail", "report.json"),
      JSON.stringify({ id: "case-fail", name: "zcode-llm-500", passed: false, startedAt: 20, finishedAt: 40 }),
    );
    await writeFile(join(dir, "case-fail", "report.html"), "<html>fail</html>");
    await writeFile(join(dir, "solo", "report.json"), JSON.stringify({ id: "solo", name: "codex-smoke", passed: true, startedAt: 1, finishedAt: 2 }));
    await writeFile(join(dir, "solo", "report.html"), "<html>solo</html>");
    await writeFile(
      join(dir, "suite-task", "suite.json"),
      JSON.stringify({
        id: "task",
        name: "zcode-reliability",
        passed: false,
        status: "done",
        trials: [
          { name: "zcode-rate-limit", trial: 1, runId: "case-pass", passed: true },
          { name: "zcode-llm-500", trial: 1, runId: "case-fail", passed: false },
        ],
      }),
    );
    await writeFile(join(dir, "suite-task", "report.html"), "<html>suite</html>");
    const jobs = collectRuns(dir);
    const suite = jobs.find((j) => j.name === "zcode-reliability");
    const family = jobs.find((j) => j.name === "zcode" && j.href === "/tasks/zcode");
    const solo = jobs.find((j) => j.kind === "experiment");
    assert.ok(suite);
    assert.ok(family);
    assert.ok(solo);
    assert.equal(suite?.cases, 2);
    assert.equal(suite?.passedCases, 1);
    assert.deepEqual((suite?.children ?? []).map((c) => c.name).sort(), ["zcode-llm-500", "zcode-rate-limit"]);
    assert.equal(family?.cases, 2);
    assert.equal(solo?.name, "codex-smoke");
    const viewer = await startViewer({ runsDir: dir, port: 0 });
    try {
      const listed = JSON.parse(await (await fetch(`${viewer.url}/api/runs`)).text());
      assert.ok(listed.some((j: { name: string }) => j.name === "zcode-reliability"));
      assert.ok(listed.some((j: { href: string }) => j.href === "/tasks/zcode"));
      assert.equal(listed.some((j: { id: string }) => j.id === "case-pass"), false);
      const page = await fetch(`${viewer.url}/tasks/zcode`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /zcode-rate-limit/);
      assert.match(html, /zcode-llm-500/);
    } finally {
      await viewer.close();
    }
  });
});

describe("resume session continuity", () => {
  const fixture = () => resolve(root, "packages/runner/test/fixtures/fake-zcode.cjs");
  const spec = () =>
    [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: zcode-resume-continuity",
      "spec:",
      "  target:",
      "    adapter: zcode",
      `    executable: ${fixture()}`,
      '    prompt: "noop"',
      "    ephemeral: false",
      "  timeout: 8s",
      "  recovery:",
      "    restart: true",
      "    resume: true",
      "  faults:",
      "    - type: process",
      "      action: kill",
      "      at: 400ms",
    ].join("\n");

  it("verifies session continuity when the resumed agent re-exports the same session id", async () => {
    const result = await runExperiment(loadSpecText(spec(), "zcode-resume.yaml"));
    assert.equal(result.report.metrics?.resumeAttempts, 1);
    assert.equal(result.report.metrics?.restarts, 0);
    assert.equal(result.report.metrics?.resumeSuccess, true);
  });

  it("flags resume failure when the resumed agent reports a different session id", async () => {
    process.env.FAKE_ZCODE_SESSION_DRIFT = "sess_drift_9";
    try {
      const result = await runExperiment(loadSpecText(spec(), "zcode-resume-drift.yaml"));
      assert.equal(result.report.metrics?.resumeAttempts, 1);
      assert.equal(result.report.metrics?.resumeSuccess, false);
    } finally {
      delete process.env.FAKE_ZCODE_SESSION_DRIFT;
    }
  });
});

describe("storage and git worktree chaos", () => {
  it("resource.disk injects disk pressure and cleans up", async () => {
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: disk-stress-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      "    args: ['-e', 'setTimeout(() => process.exit(0), 400)']",
      "  timeout: 5s",
      "  faults:",
      "    - type: resource",
      "      action: disk",
      "      mb: 4",
      "      path: .agentchaos-disk-test.bin",
      "      at: 50ms",
      "      duration: 150ms",
      "  assertions:",
      "    - exit_zero",
    ].join("\n");
    const result = await runExperiment(loadSpecText(yaml, "disk-stress-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.ok(result.report.injected.includes("resource.disk"));
  });

  it("git.worktree-leak and git_worktree_clean assertion", async () => {
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: git-worktree-test",
      "spec:",
      "  git: true",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      "    args: ['-e', 'setTimeout(() => process.exit(0), 400)']",
      "  timeout: 5s",
      "  faults:",
      "    - type: git",
      "      action: worktree-leak",
      "      at: 50ms",
      "      duration: 150ms",
      "  assertions:",
      "    - exit_zero",
      "    - git_worktree_clean",
    ].join("\n");
    const result = await runExperiment(loadSpecText(yaml, "git-worktree-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.ok(result.report.injected.includes("git.worktree-leak"));
  });
});

describe("llm api taxonomy", () => {
  it("maps paper scenes and applies field mutations", () => {
    assert.equal(resolveLlmScene("api_degradation", undefined), "degrade");
    assert.equal(resolveLlmScene("max_tokens", undefined), "truncate");
    const openai = mockAssistantPayload(false);
    const mutated = applyLlmFieldMutation(openai, false, "wrong_entity", "tool_calls");
    const args = (mutated.choices as { message: { tool_calls: { function: { name: string; arguments: string } }[] } }[])[0]
      .message.tool_calls[0].function;
    assert.equal(args.name, "read_files");
    assert.match(args.arguments, /sum\.ts/);
  });

  it("keeps intermittent schedules deterministic per seed", () => {
    const a = createLlmInjectState(7);
    const b = createLlmInjectState(7);
    const policy = { action: "429" as const, schedule: "intermittent" as const, probability: 0.4, seed: 7 };
    const left = Array.from({ length: 12 }, () => decideLlmInject(policy, a));
    const right = Array.from({ length: 12 }, () => decideLlmInject(policy, b));
    assert.deepEqual(left, right);
    assert.ok(left.some(Boolean));
    assert.ok(left.some((hit) => !hit));
  });

  it("single schedule fires once then passes", async () => {
    const proxy = new LlmProxy();
    const port = await proxy.start();
    try {
      proxy.setPolicy({ action: "429", schedule: "single" });
      const first = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const second = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(first.status, 429);
      assert.equal(second.status, 200);
      assert.equal(proxy.triggered, 1);
    } finally {
      await proxy.stop();
    }
  });
});

describe("anthropic messages proxy", () => {
  it("handles /v1/messages non-streaming and streaming SSE with Anthropic format", async () => {
    const proxy = new LlmProxy();
    const port = await proxy.start();
    try {
      // 1. Normal non-streaming pass
      const resNonStream = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "test", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(resNonStream.status, 200);
      const jsonNonStream = (await resNonStream.json()) as any;
      assert.equal(jsonNonStream.type, "message");
      assert.equal(jsonNonStream.content[0].text, "ok");

      // 2. Normal streaming SSE pass
      const resStream = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "test", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3-5-sonnet", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(resStream.status, 200);
      const textStream = await resStream.text();
      assert.match(textStream, /message_start/);
      assert.match(textStream, /content_block_delta/);
      assert.match(textStream, /message_stop/);

      // 3. 429 rate limit
      proxy.setPolicy({ action: "429" });
      const res429 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "test", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3-5-sonnet", messages: [] }),
      });
      assert.equal(res429.status, 429);
      const json429 = (await res429.json()) as any;
      assert.equal(json429.error?.type, "rate_limit_error");
    } finally {
      await proxy.stop();
    }
  });
});

describe("mcp stdio chaos", () => {
  it("serves stdio JSON-RPC and respects dynamic policy", async () => {
    const stdioBin = resolve(root, "packages/runner/src/mcp-stdio.ts");
    const initPayload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
    const callPayload = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hello" } } }) + "\n";

    // Normal pass
    const proc = spawnSync(process.execPath, ["--experimental-strip-types", stdioBin], {
      input: initPayload + callPayload,
      encoding: "utf8",
    });
    assert.equal(proc.status, 0);
    assert.match(proc.stdout, /agentchaos-mcp-stdio/);
    assert.match(proc.stdout, /"text":"hello"/);

    // 429 policy
    const proc429 = spawnSync(process.execPath, ["--experimental-strip-types", stdioBin, "--policy", "429"], {
      input: callPayload,
      encoding: "utf8",
    });
    assert.match(proc429.stdout, /-32029/);
    assert.match(proc429.stdout, /rate limit/);
  });

  it("journals one request and one response for exactly-once checks", async () => {
    const stdioBin = resolve(root, "packages/runner/src/mcp-stdio.ts");
    const journal = join(await mkdtemp(join(tmpdir(), "agentchaos-mcp-journal-")), "stdio.jsonl");
    const payload = JSON.stringify({ jsonrpc: "2.0", id: "once-1", method: "ping" }) + "\n";
    const proc = spawnSync(process.execPath, ["--experimental-strip-types", stdioBin], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, AGENTCHAOS_MCP_JOURNAL_FILE: journal },
    });
    assert.equal(proc.status, 0);
    const records = (await readFile(journal, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.type === "request").length, 1);
    assert.equal(records.filter((record) => record.type === "response").length, 1);

    const duplicateJournal = join(await mkdtemp(join(tmpdir(), "agentchaos-mcp-duplicate-")), "stdio.jsonl");
    const duplicate = spawnSync(process.execPath, ["--experimental-strip-types", stdioBin, "--policy", "duplicate"], {
      input: payload,
      encoding: "utf8",
      env: { ...process.env, AGENTCHAOS_MCP_JOURNAL_FILE: duplicateJournal },
    });
    assert.equal(duplicate.status, 0);
    const checks = await runAssertions([{ type: "mcp_stdio_exactly_once" }], {
      code: 0,
      signal: null,
      timedOut: false,
      work: root,
      output: duplicate.stdout,
      injected: [],
      mcpJournal: duplicateJournal,
    });
    assert.equal(checks[0]?.passed, false);
  });

  it("replays a committed response after a real stdio wrapper restart", async () => {
    const stdioBin = resolve(root, "packages/runner/src/mcp-stdio.ts");
    const journal = join(await mkdtemp(join(tmpdir(), "agentchaos-mcp-resume-")), "stdio.jsonl");
    const payload = JSON.stringify({ jsonrpc: "2.0", id: "resume-1", method: "ping" }) + "\n";
    const env = { ...process.env, AGENTCHAOS_MCP_JOURNAL_FILE: journal };
    const first = spawnSync(process.execPath, ["--experimental-strip-types", stdioBin], {
      input: payload,
      encoding: "utf8",
      env,
    });
    const second = spawnSync(process.execPath, ["--experimental-strip-types", stdioBin], {
      input: payload,
      encoding: "utf8",
      env,
    });
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(JSON.parse(first.stdout).id, "resume-1");
    assert.equal(JSON.parse(second.stdout).id, "resume-1");
    const checks = await runAssertions([{ type: "mcp_stdio_resume_consistent" }], {
      code: 0,
      signal: null,
      timedOut: false,
      work: root,
      output: first.stdout + second.stdout,
      injected: [],
      mcpJournal: journal,
    });
    assert.equal(checks[0]?.passed, true);
  });
});

describe("subagent chaos", () => {
  it("records a real subagent start and terminal event exactly once", async () => {
    const agentScript = [
      "const { spawn } = require('node:child_process');",
      "console.log(JSON.stringify({ type: 'subagent_started', id: 'sub-real-1' }));",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120)'], { stdio: 'ignore' });",
      "child.on('exit', () => { console.log(JSON.stringify({ type: 'subagent_finished', id: 'sub-real-1' })); });",
      "setTimeout(() => process.exit(0), 220);",
    ].join("\n");
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: subagent-exactly-once",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      "    executable: node",
      "    args:",
      "      - -e",
      "      - |",
      ...agentScript.split("\n").map((line) => `        ${line}`),
      "  timeout: 5s",
      "  faults: []",
      "  assertions:",
      "    - exit_zero",
      "    - subagent_exactly_once",
    ].join("\n");
    const result = await runExperiment(loadSpecText(yaml, "subagent-exactly-once.yaml"));
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.checks.find((check) => check.assertion === "subagent_exactly_once")?.passed);
  });

  it("keeps a real subagent association across a resumed process generation", async () => {
    const fixture = resolve(root, "packages/runner/test/fixtures/fake-zcode.cjs");
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: subagent-resume-consistent",
      "spec:",
      "  target:",
      "    adapter: zcode",
      `    executable: ${JSON.stringify(fixture)}`,
      "    env:",
      "      FAKE_ZCODE_SUBAGENT: '1'",
      "    json: true",
      "  timeout: 5s",
      "  recovery:",
      "    resume: true",
      "  faults:",
      "    - type: process",
      "      action: kill",
      "      at: 100ms",
      "  assertions:",
      "    - subagent_resume_consistent",
    ].join("\n");
    const result = await runExperiment(loadSpecText(yaml, "subagent-resume-consistent.yaml"));
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.checks.find((check) => check.assertion === "subagent_resume_consistent")?.passed);
  });

  it("subagent.kill terminates child process while parent process survives", async () => {
    // Parent spawns a child process and reports subagent item
    const agentScript = [
      "const { spawn } = require('node:child_process');",
      "console.log(JSON.stringify({ type: 'subagent_started', item: { type: 'agent_spawn' } }));",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "child.on('exit', () => {",
      "  console.log('child exited as expected');",
      "  process.exit(0);",
      "});",
      "setTimeout(() => { child.kill('SIGKILL'); process.exit(0); }, 3000);",
    ].join("\n");

    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: subagent-kill-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      `    args: ['-e', ${JSON.stringify(agentScript)}]`,
      "  timeout: 5s",
      "  faults:",
      "    - type: subagent",
      "      action: kill",
      "      when: subagent_started",
      "      at: 100ms",
      "  assertions:",
      "    - exit_zero",
      "    - output_contains: child exited as expected",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "subagent-kill-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.ok(result.report.injected.includes("subagent.kill"));
  });

  it("subagent.conflict mutates conflict file in workspace", async () => {
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: subagent-conflict-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      "    args: ['-e', 'setTimeout(() => process.exit(0), 200)']",
      "  timeout: 5s",
      "  faults:",
      "    - type: subagent",
      "      action: conflict",
      "      path: subagent-conflict.txt",
      "      at: 50ms",
      "  assertions:",
      "    - exit_zero",
      "    - file_exists: subagent-conflict.txt",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "subagent-conflict-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.ok(result.report.injected.includes("subagent.conflict"));
  });

  it("HelperWorker tracks workers and caps report protocol_version 1.1.0", async () => {
    const { HelperClient } = await import("../src/helper.ts");
    const helper = HelperClient.discover();
    const caps = (await helper.caps()) as any;
    assert.equal(caps.ok, true);
    assert.equal(caps.protocol_version, "1.1.0");
    assert.ok(caps.capabilities.includes("handle-stress"));
    assert.ok(caps.capabilities.includes("disk-exhaustion"));

    const worker = helper.startCpuStressWorker(5000, 1);
    assert.ok(worker.id.startsWith("worker-cpu-"));
    assert.equal(worker.kind, "cpu");
    assert.ok(worker.pid && worker.pid > 0);
    await worker.stop();
  });

  it("mcp stdio proxies upstream and isolates side-effects via deduplication", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agentchaos-mcp-upstream-"));
    const upstreamLog = join(tmp, "upstream-invocations.txt");
    const upstreamScript = [
      "const readline = require('readline');",
      "const fs = require('fs');",
      `const logFile = ${JSON.stringify(upstreamLog)};`,
      "const rl = readline.createInterface({ input: process.stdin, terminal: false });",
      "rl.on('line', (line) => {",
      "  const parsed = JSON.parse(line);",
      "  fs.appendFileSync(logFile, line + '\\n');",
      "  if (parsed.method === 'tools/call') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: 'upstream-ok' }] } }) + '\\n');",
      "  }",
      "});",
    ].join("\n");

    const agentScript = [
      "const { spawn } = require('child_process');",
      "const mcpBin = process.env.AGENTCHAOS_MCP_STDIO_BIN;",
      `const upstreamCmd = ${JSON.stringify(process.execPath)};`,
      `const upstreamArgs = ['-e', ${JSON.stringify(upstreamScript)}];`,
      "const child = spawn(process.execPath, [mcpBin, '--upstream', upstreamCmd, ...upstreamArgs], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });",
      "let received = 0;",
      "child.stdout.on('data', (d) => {",
      "  const lines = d.toString().split('\\n').filter(Boolean);",
      "  for (const l of lines) {",
      "    const resp = JSON.parse(l);",
      "    if (resp.result?.content?.[0]?.text === 'upstream-ok') received++;",
      "  }",
      "  if (received === 2) {",
      "    child.kill('SIGKILL');",
      "    process.exit(0);",
      "  }",
      "});",
      "// Send identical tool call twice with id=42 to verify idempotency deduplication",
      "child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'echo' } }) + '\\n');",
      "setTimeout(() => {",
      "  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'echo' } }) + '\\n');",
      "}, 100);",
    ].join("\n");

    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: mcp-upstream-dedupe-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      `    args: ['-e', ${JSON.stringify(agentScript)}]`,
      "  timeout: 5s",
      "  assertions:",
      "    - exit_zero",
      "    - mcp_stdio_upstream_consistent",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "mcp-upstream-dedupe-test.yaml"));
    assert.equal(result.report.passed, true);
    // Verify that upstream tool was invoked exactly ONCE because duplicate was cached and deduplicated
    const upstreamCalls = (await readFile(upstreamLog, "utf8")).split("\n").filter(Boolean);
    assert.equal(upstreamCalls.length, 1);
  });

  it("subagent checkpointing and restoration assertion", async () => {
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: subagent-checkpoint-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      "    args: ['-e', 'console.log(JSON.stringify({ type: \"subagent_started\", toolCallId: \"sub-1\" })); setTimeout(() => { console.log(JSON.stringify({ type: \"subagent_finished\", toolCallId: \"sub-1\" })); process.exit(0); }, 200)']",
      "  timeout: 5s",
      "  faults:",
      "    - type: subagent",
      "      action: checkpoint",
      "      checkpointId: chk-parent-1",
      "      at: 50ms",
      "  assertions:",
      "    - exit_zero",
      "    - subagent_checkpoint_restored",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "subagent-checkpoint-test.yaml"));
    assert.equal(result.report.passed, true);
  });

  it("session schema drift and clean recovery assertion", async () => {
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: session-schema-drift-test",
      "spec:",
      "  target:",
      "    adapter: codex",
      "    sessionHome: .agentchaos-session",
      `    executable: ${JSON.stringify(process.execPath)}`,
      "    args: ['-e', 'console.log(JSON.stringify({ sessionId: \"sess-fixed\" })); setTimeout(() => process.exit(0), 200)']",
      "  timeout: 5s",
      "  faults:",
      "    - type: session",
      "      action: schema_drift",
      "      path: session.db",
      "      at: 50ms",
      "  assertions:",
      "    - exit_zero",
      "    - session_clean_recovery",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "session-schema-drift-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.ok(result.report.injected.includes("session.schema_drift"));
  });

  it("desktop native screenshot captures real file and asserts evidence", async () => {
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: desktop-screenshot-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      "    desktop: true",
      `    executable: ${JSON.stringify(process.execPath)}`,
      "    args: ['-e', 'setTimeout(() => process.exit(0), 300)']",
      "  timeout: 5s",
      "  faults:",
      "    - type: desktop",
      "      action: screenshot",
      "      path: test-shot.png",
      "      at: 50ms",
      "  assertions:",
      "    - exit_zero",
      "    - desktop_screenshot_captured: test-shot.png",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "desktop-screenshot-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.ok(result.report.injected.includes("desktop.screenshot"));
  });

  it("remote coordinator handles lease, heartbeats, and fault injection", async () => {
    const agentScript = [
      "const http = require('http');",
      "const url = new URL(process.env.AGENTCHAOS_REMOTE_URL + '/v1/leases/acquire');",
      "const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {",
      "  let body = '';",
      "  res.on('data', (d) => body += d);",
      "  res.on('end', () => {",
      "    const lease = JSON.parse(body);",
      "    const hbReq = http.request(new URL(process.env.AGENTCHAOS_REMOTE_URL + '/v1/leases/heartbeat'), { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (hRes) => {",
      "      if (hRes.statusCode === 200) process.exit(0);",
      "      else process.exit(1);",
      "    });",
      "    hbReq.write(JSON.stringify({ leaseId: lease.leaseId, token: lease.token }));",
      "    hbReq.end();",
      "  });",
      "});",
      "req.write(JSON.stringify({ agentId: 'test-agent' }));",
      "req.end();",
    ].join("\n");

    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: remote-lifecycle-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      `    args: ['-e', ${JSON.stringify(agentScript)}]`,
      "  timeout: 5s",
      "  faults:",
      "    - type: remote",
      "      action: heartbeat_timeout",
      "      at: 1000ms",
      "  assertions:",
      "    - exit_zero",
      "    - remote_lease_valid",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "remote-lifecycle-test.yaml"));
    assert.equal(result.report.passed, true);
  });

  it("isolated resource handle and disk exhaustion recover cleanly", async () => {
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: resource-exhaustion-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      "    args: ['-e', 'setTimeout(() => process.exit(0), 300)']",
      "  timeout: 5s",
      "  faults:",
      "    - type: resource",
      "      action: handle_exhaustion",
      "      limit: 128",
      "      duration: 100ms",
      "      at: 20ms",
      "    - type: resource",
      "      action: disk_exhaustion",
      "      mb: 2",
      "      duration: 100ms",
      "      at: 50ms",
      "  assertions:",
      "    - exit_zero",
      "    - resource_exhaustion_recovered",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "resource-exhaustion-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.ok(result.report.injected.includes("resource.handle_exhaustion"));
    assert.ok(result.report.injected.includes("resource.disk_exhaustion"));
  });

  it("watchdog detects I/O stalling unresponsive deadlocks and diagnoses invariants", async () => {
    const silentScript = "setTimeout(() => process.exit(0), 700);";

    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: watchdog-stall-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      `    args: ['-e', ${JSON.stringify(silentScript)}]`,
      "  timeout: 5s",
      "  ioStallTimeout: 200ms",
      "  assertions:",
      "    - exit_zero",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "watchdog-stall-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.equal(result.report.ioStalled, true);
    assert.ok(result.report.diagnosis != null);
    // Because ioStalled was detected, check invariant diagnosis
    const hasStallViolation = result.report.diagnosis.invariantsViolated.some(
      (v) => v.invariant === "UNBOUNDED_RETRY_OR_DEADLOCK"
    );
    assert.equal(hasStallViolation, true);
  });

  it("llm proxy transparently forwards upstream responses and intercepts on fault", async () => {
    const http = await import("node:http");
    const mockUpstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ upstreamResponse: "hello from upstream", url: req.url }));
    });
    await new Promise<void>((r) => mockUpstream.listen(0, "127.0.0.1", () => r()));
    const port = (mockUpstream.address() as any).port;
    const upstreamUrl = `http://127.0.0.1:${port}`;

    const proxy = new LlmProxy(upstreamUrl);
    const proxyPort = await proxy.start();

    // 1. Pass mode: transparently forwarded
    const passRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test" },
      body: JSON.stringify({ message: "hi" }),
    });
    const passData = await passRes.json() as any;
    assert.equal(passData.upstreamResponse, "hello from upstream");

    // 2. Fault mode: intercepted and injected 429
    proxy.setPolicy({ action: "429" });
    const faultRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.equal(faultRes.status, 429);
    const faultData = await faultRes.json() as any;
    assert.equal(faultData.type, "error");

    await proxy.stop();
    await new Promise<void>((r) => mockUpstream.close(() => r()));
  });

  it("watchdog detects retry storm churn and marks RETRY_STORM_DEADLOCK", async () => {
    const stormScript = [
      "let count = 0;",
      "const interval = setInterval(() => {",
      "  console.error('APICallError [AI_APICallError]: injected 429: rate limit exceeded');",
      "  count++;",
      "  if (count >= 6) {",
      "    clearInterval(interval);",
      "    process.exit(0);",
      "  }",
      "}, 50);",
    ].join("\n");

    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: watchdog-storm-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      `    args: ['-e', ${JSON.stringify(stormScript)}]`,
      "  timeout: 5s",
      "  retryStormThreshold: 4",
      "  retryStormWindow: 1000ms",
      "  assertions:",
      "    - exit_zero",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "watchdog-storm-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.equal(result.report.retryStormDetected, true);
    assert.ok(result.report.diagnosis != null);
    const hasStormViolation = result.report.diagnosis.invariantsViolated.some(
      (v) => v.invariant === "RETRY_STORM_DEADLOCK"
    );
    assert.equal(hasStormViolation, true);
  });

  it("harbor-style agent descriptors cleanly register adapters and avoid ad-hoc bundle searches", () => {
    assert.ok(AGENT_REGISTRY.codex);
    assert.ok(AGENT_REGISTRY.claude);
    assert.ok(AGENT_REGISTRY.kimi);
    assert.ok(AGENT_REGISTRY.zcode);
    assert.ok(AGENT_REGISTRY["generic-cli"]);

    assert.equal(AGENT_REGISTRY.codex.envVar, "CODEX_BIN");
    assert.equal(AGENT_REGISTRY.zcode.envVar, "ZCODE_BIN");
    assert.equal(AGENT_REGISTRY.claude.envVar, "CLAUDE_BIN");
    assert.equal(AGENT_REGISTRY.kimi.envVar, "KIMI_BIN");

    assert.deepEqual(AGENT_REGISTRY.codex.canonicalBinNames, ["codex"]);
    assert.deepEqual(AGENT_REGISTRY.zcode.canonicalBinNames, ["zcode", "zcode.cjs"]);
  });

  it("uses ZCode API keys and rejects Coding Plan captcha endpoints", async () => {
    assert.equal(isZcodeCaptchaEndpoint("builtin:bigmodel-start-plan", "https://zcode.z.ai/api/v1/zcode-plan/anthropic"), true);
    assert.equal(isZcodeCaptchaEndpoint("builtin:bigmodel", "https://open.bigmodel.cn/api/anthropic"), false);

    const home = await mkdtemp(join(tmpdir(), "ac-zcode-creds-"));
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "v2", "config.json"),
      JSON.stringify({
        provider: {
          "builtin:bigmodel-start-plan": {
            enabled: true,
            options: { apiKey: "plan-token", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            models: { "GLM-5.3": {} },
          },
          "builtin:bigmodel": {
            enabled: false,
            options: { apiKey: "sk-cli", baseURL: "https://open.bigmodel.cn/api/anthropic" },
            models: { "GLM-5.3": {} },
          },
        },
      }),
    );
    const creds = zcodeCliEnv({ home, env: {} });
    assert.equal(creds.ZCODE_API_KEY, "sk-cli");
    assert.equal(creds.ZCODE_BASE_URL, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(zcodeCliCredentialError(creds), undefined);

    const planOnly = zcodeCliEnv({
      home: await mkdtemp(join(tmpdir(), "ac-zcode-plan-")),
      env: {},
    });
    assert.equal(planOnly.ZCODE_API_KEY, undefined);
    assert.match(zcodeCliCredentialError(planOnly) ?? "", /ZCODE_API_KEY/);

    assert.match(
      zcodeCliCredentialError({
        ZCODE_API_KEY: "x",
        ZCODE_BASE_URL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      }) ?? "",
      /验证码接口/,
    );

    const fromOpenAi = zcodeCliEnv({
      home: await mkdtemp(join(tmpdir(), "ac-zcode-openai-")),
      env: {
        OPENAI_API_KEY: "sk-gateway",
        OPENAI_BASE_URL: "https://example.com/v1",
        OPENAI_MODEL: "gpt-4o-mini",
      },
    });
    assert.equal(fromOpenAi.ZCODE_API_KEY, "sk-gateway");
    assert.equal(fromOpenAi.ZCODE_BASE_URL, "https://example.com");
    assert.equal(fromOpenAi.ZCODE_MODEL, "gpt-4o-mini");
    assert.equal(zcodeCliCredentialError(fromOpenAi), undefined);
  });

  it("tagged union native events avoid false positives on message text containing keywords", () => {
    // Message text casually mentioning keywords must NOT falsely trigger events
    const conversationalText = classifyAgentEvent({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "We need user approval for compaction_started and item.completed" }],
      },
    });
    assert.equal(conversationalText, undefined);

    // Exact control event properly triggers
    const actualApproval = classifyAgentEvent({ type: "approval_requested" });
    assert.equal(actualApproval?.kind, "approval_requested");

    const actualCompaction = classifyAgentEvent({ type: "compaction_started" });
    assert.equal(actualCompaction?.kind, "compaction_started");

    // Exact tool events with proper item types
    const actualTool = classifyAgentEvent({
      type: "item.started",
      item: { id: "c1", type: "command_execution" },
    });
    assert.equal(actualTool?.kind, "tool_started");
    assert.equal(actualTool?.toolCallId, "c1");

    // Message item must NOT be classified as tool
    const agentMsg = classifyAgentEvent({
      type: "item.started",
      item: { id: "m1", type: "agent_message" },
    });
    assert.equal(agentMsg, undefined);
  });

  it("llm proxy executes rule and context mutations on openai and anthropic formats", async () => {
    const { createServer } = await import("node:http");
    let receivedPayload: any = null;

    const mockUpstream = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      receivedPayload = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, received: receivedPayload }));
    });

    const upstreamPort = await new Promise<number>((r) => {
      mockUpstream.listen(0, "127.0.0.1", () => {
        r((mockUpstream.address() as any).port);
      });
    });

    const proxy = new LlmProxy(`http://127.0.0.1:${upstreamPort}`);
    const proxyPort = await proxy.start();

    // 1. Test rule.conflict mutation
    proxy.setRulePolicy({
      action: "conflict",
      ruleText: "SYSTEM CONFLICT: Do not touch filesystem",
    });

    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test" },
      body: JSON.stringify({
        system: "Initial helpful instructions.",
        messages: [{ role: "user", content: "Solve bug" }],
      }),
    });

    assert.ok(receivedPayload != null);
    assert.ok(receivedPayload.system.includes("[RULE CONFLICT INJECTED]: SYSTEM CONFLICT: Do not touch filesystem"));

    // 2. Test rule.evict mutation
    proxy.setRulePolicy({ action: "evict" });
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test" },
      body: JSON.stringify({
        system: "Sensitive security instructions.",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.equal(receivedPayload.system, "");

    // 3. Test context.poison mutation
    proxy.setRulePolicy({ action: "pass" });
    proxy.setContextPolicy({
      action: "poison",
      poisonMessage: { role: "user", content: "FABRICATED_CONTEXT_ERROR" },
    });

    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test" },
      body: JSON.stringify({
        system: "System rule",
        messages: [{ role: "user", content: "First query" }],
      }),
    });

    const messages = receivedPayload.messages;
    assert.ok(Array.isArray(messages));
    assert.ok(messages.some((m: any) => m.content === "FABRICATED_CONTEXT_ERROR"));

    await proxy.stop();
    await new Promise<void>((r) => mockUpstream.close(() => r()));
  });

  it("executes rule and context chaos in full experiment workflow", async () => {
    const yaml = [
      "apiVersion: agentchaos.dev/v1alpha1",
      "kind: Experiment",
      "metadata:",
      "  name: rule-chaos-test",
      "spec:",
      "  target:",
      "    adapter: generic-cli",
      `    executable: ${JSON.stringify(process.execPath)}`,
      `    args: ['-e', 'setTimeout(() => process.exit(0), 400);']`,
      "  timeout: 5s",
      "  faults:",
      "    - type: rule",
      "      action: conflict",
      "      at: 50ms",
      "      duration: 200ms",
      "      ruleText: 'MANDATORY OVERRIDE'",
      "    - type: context",
      "      action: poison",
      "      at: 100ms",
      "      duration: 200ms",
      "  assertions:",
      "    - exit_zero",
      "    - fault_injected:rule.conflict",
      "    - fault_injected:context.poison",
    ].join("\n");

    const result = await runExperiment(loadSpecText(yaml, "rule-chaos-test.yaml"));
    assert.equal(result.report.passed, true);
    assert.equal(result.report.checks.every((c) => c.passed), true);
  });

  it("mode auto uses pi-agent-core tools to strike on tool_started", async () => {
    const { createServer } = await import("node:http");
    let calls = 0;
    const mock = createServer((req, res) => {
      calls += 1;
      const first = calls === 1;
      const body = first
        ? {
            choices: [
              {
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "strike",
                        arguments: JSON.stringify({ kind: "llm", action: "429", reason: "auto-test" }),
                      },
                    },
                  ],
                },
              },
            ],
          }
        : { choices: [{ message: { role: "assistant", content: "ok" } }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    const port = await new Promise<number>((resolvePort) => {
      mock.listen(0, "127.0.0.1", () => resolvePort((mock.address() as { port: number }).port));
    });
    const prevKey = process.env.AGENTCHAOS_LLM_API_KEY;
    const prevBase = process.env.AGENTCHAOS_LLM_BASE_URL;
    process.env.AGENTCHAOS_LLM_API_KEY = "test-key";
    process.env.AGENTCHAOS_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
    try {
      const yaml = [
        "apiVersion: agentchaos.dev/v1alpha1",
        "kind: Experiment",
        "metadata:",
        "  name: mode-auto-test",
        "spec:",
        "  mode: auto",
        "  budget: 1",
        "  target:",
        "    adapter: generic-cli",
        `    executable: ${JSON.stringify(process.execPath)}`,
        "    args:",
        "      - -e",
        "      - |",
        "        console.log(JSON.stringify({ type: 'tool_started', toolCallId: 't1' }));",
        "        setTimeout(() => {",
        "          console.log(JSON.stringify({ type: 'tool_finished', toolCallId: 't1' }));",
        "          process.exit(0);",
        "        }, 900);",
        "  timeout: 8s",
        "  assertions:",
        "    - exit_zero",
        "    - not_timed_out",
      ].join("\n");
      const result = await runExperiment(loadSpecText(yaml, "mode-auto-test.yaml"));
      assert.equal(result.report.passed, true);
      assert.ok((result.report.autoDecisions ?? []).some((d) => d.fault.kind === "llm" && d.fault.action === "429"));
      assert.ok(result.report.injected.includes("llm.429"));
    } finally {
      if (prevKey == null) delete process.env.AGENTCHAOS_LLM_API_KEY;
      else process.env.AGENTCHAOS_LLM_API_KEY = prevKey;
      if (prevBase == null) delete process.env.AGENTCHAOS_LLM_BASE_URL;
      else process.env.AGENTCHAOS_LLM_BASE_URL = prevBase;
      await new Promise<void>((r) => mock.close(() => r()));
    }
  });

});

describe("bundled fixture and starter spec", () => {
  it("resolves broken-sum to examples/fixtures/broken-sum/src/sum.js", () => {
    const dir = resolveFixture("broken-sum");
    assert.ok(existsSync(join(dir, "src/sum.js")));
    assert.ok(listBundledFixtures().includes("broken-sum"));
  });

  it("tells the user to write an absolute path when the fixture is missing", () => {
    assert.throws(() => resolveFixture("no-such-fixture-xyz"), /绝对路径/);
  });

  it("writes agentchaos.yaml once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-init-"));
    const first = await writeStarterSpec(dir);
    assert.equal(first.created, true);
    assert.equal(first.adapter, "zcode");
    const text = await readFile(first.path, "utf8");
    assert.match(text, /adapter: zcode/);
    assert.match(text, /fixture: broken-sum/);
    assert.match(text, /src\/sum\.js/);
    assert.match(text, /- file\n/);
    assert.match(text, /- process\n/);
    const second = await writeStarterSpec(dir);
    assert.equal(second.created, false);
  });

  it("names the prebuilt helper per platform", () => {
    assert.equal(helperPlatformKey("darwin", "arm64"), "darwin-arm64");
    assert.equal(helperExeName("win32"), "agentchaos-helper.exe");
    assert.ok(bundledHelperPath(root, "darwin", "arm64").endsWith(join("prebuilt", "darwin-arm64", "agentchaos-helper")));
  });

  it("blocks npm publish when a required helper is missing", () => {
    const result = spawnSync(process.execPath, [resolve(root, "scripts/ensure-helper.mjs"), "--check-pack"], {
      encoding: "utf8",
    });
    const missing = missingPackagedHelpers(root);
    if (missing.length === 0) {
      assert.equal(result.status, 0);
      return;
    }
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /安装包不完整/);
  });
});
