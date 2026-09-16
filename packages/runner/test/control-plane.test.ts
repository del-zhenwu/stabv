import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { applyPerturbations, loadSpecText, validateExperiment } from "../src/spec.ts";
import { parseDuration } from "../src/duration.ts";
import { runExperiment } from "../src/runner.ts";
import { repoRoot } from "../src/paths.ts";
import { loadExperimentFile, loadSuiteFile, loadWorkflowFile } from "../src/compose.ts";
import { previewRisk } from "../src/capabilities.ts";
import { runSuite } from "../src/suite.ts";
import { runWorkflow } from "../src/workflow.ts";
import { applyResumeArgs, discoverAgents, planLaunch } from "../src/adapters.ts";
import { runAssertions } from "../src/assertions.ts";
import { parseFlags } from "../src/cli.ts";
import { startViewer } from "../src/view.ts";

const root = repoRoot();

describe("spec", () => {
  it("parses durations", () => {
    assert.equal(parseDuration(0.2), 200);
    assert.equal(parseDuration("250ms"), 250);
    assert.equal(parseDuration("2s"), 2000);
    assert.equal(parseDuration("1m"), 60_000);
  });

  it("normalizes legacy and v1alpha1 faults", async () => {
    const smoke = loadSpecText(await readFile(resolve(root, "examples/codex-smoke.yaml"), "utf8"), "codex-smoke.yaml");
    assert.equal(smoke.target.adapter, "generic-cli");
    assert.equal(smoke.faults[0]?.kind, "file");
    assert.deepEqual(validateExperiment(smoke), []);

    const kill = loadSpecText(await readFile(resolve(root, "examples/codex-kill.json"), "utf8"), "codex-kill.json");
    assert.equal(kill.target.adapter, "generic-cli");
    assert.equal(kill.faults[0]?.kind, "process");
    assert.equal(kill.faults[0]?.action, "kill");
  });

  it("composes workload and chaos profile", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/composed.yaml"));
    assert.equal(exp.name, "composed-file-edit");
    assert.equal(exp.target.executable, "node");
    assert.equal(exp.faults[0]?.action, "edit");
    assert.deepEqual(validateExperiment(exp), []);
  });

  it("loads suite and workflow documents", async () => {
    const suite = await loadSuiteFile(resolve(root, "examples/suite.yaml"));
    assert.equal(suite.kind, "Suite");
    assert.ok(suite.experiments.length >= 3);
    const workflow = await loadWorkflowFile(resolve(root, "examples/workflow.yaml"));
    assert.equal(workflow.tasks[0]?.type, "serial");
    assert.equal(workflow.tasks[1]?.type, "parallel");
    assert.equal(workflow.failFast, true);
    const cont = await loadWorkflowFile(resolve(root, "examples/workflow-continue.yaml"));
    assert.equal(cont.failFast, false);
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
    const exp = await loadExperimentFile(resolve(root, "examples/file-lock.yaml"));
    const risk = previewRisk(exp, ["flock", "kill-tree"]);
    assert.equal(risk.writesWorkspace, true);
    assert.ok(risk.required.includes("flock"));
    assert.notEqual(risk.status, "unsupported");
  });

  it("plans zcode headless argv", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/zcode-process-kill.yaml"));
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
});

describe("control plane chaos", () => {
  it("injects an external file edit", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/codex-smoke.yaml"), "utf8"), "codex-smoke.yaml");
    const result = await runExperiment(exp, "examples/codex-smoke.yaml");
    assert.equal(result.exitCode, 0);
  });

  it("kills the process tree", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/process-kill.yaml"), "utf8"), "process-kill.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.injected.includes("process.kill"));
  });

  it("pauses and resumes the process tree", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/process-pause.yaml"), "utf8"), "process-pause.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("mutates files while the agent runs", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/file-chaos.yaml"), "utf8"), "file-chaos.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("holds an exclusive file lock", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/file-lock.yaml"));
    const result = await runExperiment(exp, resolve(root, "examples/file-lock.yaml"));
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.injected.includes("file.lock"));
  });

  it("injects a git lock and conflict", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/git-lock.yaml"), "utf8"), "git-lock.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("returns 429 from the LLM proxy", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/llm-429.yaml"), "utf8"), "llm-429.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("returns 401 from the LLM proxy", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/llm-401.yaml"), "utf8"), "llm-401.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("truncates an LLM SSE stream", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/llm-truncate.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("drops an LLM stream mid-request", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/llm-timeout.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("writes a large file blob into the workspace", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/file-large.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.metrics && result.report.metrics.shadowSnapshots >= 2);
  });

  it("occupies a TCP port", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/resource-port.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("returns malformed LLM JSON", async () => {
    const exp = loadSpecText(await readFile(resolve(root, "examples/llm-malformed.yaml"), "utf8"), "llm-malformed.yaml");
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("returns schema-drifted LLM JSON", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/llm-schema-drift.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("runs a hidden grader and expected workspace files", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/task-tests.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report.checks.some((c) => c.assertion === "task_tests_pass" && c.passed));
    assert.ok(result.report.metrics);
  });

  it("kills and restarts the agent", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/kill-and-resume.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.ok((result.report.metrics?.restarts ?? 0) >= 1, "expected at least one restart");
    assert.equal(result.report.metrics?.resumeAttempts, 0);
    assert.ok((result.report.metrics?.shadowSnapshots ?? 0) >= 2);
  });

  it("runs a pass^k suite", async () => {
    const suite = await loadSuiteFile(resolve(root, "examples/suite-fast.yaml"));
    const report = await runSuite(suite);
    assert.equal(report.passed, true);
    assert.equal(report.passK["composed-file-edit"]?.passHatK, true);
  });

  it("runs a serial workflow", async () => {
    const workflow = await loadWorkflowFile(resolve(root, "examples/workflow-fast.yaml"));
    const report = await runWorkflow(workflow);
    assert.equal(report.passed, true);
    assert.equal(report.steps.length, 2);
  });

  it("injects stdin on a pipe", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/input-send.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
  });

  it("relays stdin over a helper PTY", async () => {
    const exp = await loadExperimentFile(resolve(root, "examples/pty-echo.yaml"));
    const result = await runExperiment(exp);
    assert.equal(result.exitCode, 0);
    assert.match(result.report.command.join(" "), /pty-spawn|node/);
  });

  it("dry-runs an experiment without spawning the workload", async () => {
    const { dryRunSpec } = await import("../src/dryrun.ts");
    const { ok, plan } = await dryRunSpec(resolve(root, "examples/input-send.yaml"));
    assert.equal(ok, true);
    assert.equal(plan.dryRun, true);
    assert.ok(plan.faults?.some((f) => f.label === "input.send"));
    assert.ok(plan.command?.includes("node"));
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
    const index = renderIndexHtml([{ id: "run-1", name: "demo", kind: "experiment", passed: true, href: "/runs/run-1/report.html", durationMs: 1199 }]);
    assert.match(index, /Evaluations/);
    assert.match(index, /demo/);
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
    await copyFile(resolve(root, "examples/composed.yaml"), join(dir, "composed.yaml"));
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
    const good = spawnSync(process.execPath, ["--experimental-strip-types", cli, "validate", "examples/suite.yaml"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /"ok": true/);
    assert.match(good.stdout, /file-lock\.yaml/);

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
    await writeFile(join(dir, "run-1", "report.json"), JSON.stringify({ id: "run-1", name: "run-1", passed: true }));
    await writeFile(join(dir, "index.jsonl"), "{}\n");
    const viewer = await startViewer({ runsDir: dir, port: 0 });
    try {
      const base = viewer.url;
      const page = await fetch(`${base}/runs/run-1/report.html`);
      assert.equal(page.status, 200);
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
