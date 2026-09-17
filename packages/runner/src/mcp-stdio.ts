import { createInterface } from "node:readline";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

export type StdioMcpPolicy = {
  action:
    | "pass"
    | "delay"
    | "timeout"
    | "429"
    | "500"
    | "malformed"
    | "truncate"
    | "schema_drift"
    | "duplicate"
    | "oversized"
    | "crash"
    | "partial_write"
    | "chunked";
  delayMs?: number;
};

function readCurrentPolicy(cliPolicy: StdioMcpPolicy): StdioMcpPolicy {
  const policyFile = process.env.AGENTCHAOS_MCP_POLICY_FILE;
  if (policyFile && existsSync(policyFile)) {
    try {
      const parsed = JSON.parse(readFileSync(policyFile, "utf8"));
      if (parsed && typeof parsed.action === "string") {
        return parsed as StdioMcpPolicy;
      }
    } catch {
      /* ignore read races */
    }
  }
  const envPolicy = process.env.AGENTCHAOS_MCP_POLICY;
  if (envPolicy) {
    try {
      return JSON.parse(envPolicy) as StdioMcpPolicy;
    } catch {
      return { action: envPolicy as StdioMcpPolicy["action"] };
    }
  }
  return cliPolicy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function journalRecord(record: Record<string, unknown>): void {
  const path = process.env.AGENTCHAOS_MCP_JOURNAL_FILE;
  if (!path) return;
  try {
    appendFileSync(path, JSON.stringify({ ts: Date.now(), ...record }) + "\n");
  } catch {
    /* Evidence collection must not crash the MCP server. */
  }
}

function readResponseCache(): Map<string, Record<string, unknown>> {
  const path = process.env.AGENTCHAOS_MCP_JOURNAL_FILE;
  const cache = new Map<string, Record<string, unknown>>();
  if (!path || !existsSync(path)) return cache;
  try {
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
      const record = JSON.parse(line) as {
        type?: string;
        dedupeKey?: string;
        payload?: Record<string, unknown>;
      };
      if ((record.type === "response" || record.type === "upstream_response") && record.dedupeKey && record.payload) {
        cache.set(record.dedupeKey, record.payload);
      }
    }
  } catch {
    // A partial journal is evidence for a recovery experiment; do not make the
    // wrapper crash before it can expose the protocol failure to the target.
  }
  return cache;
}

export async function runMcpStdio(args = process.argv.slice(2)): Promise<void> {
  let cliAction: StdioMcpPolicy["action"] = "pass";
  let cliDelayMs: number | undefined;
  let upstreamCmd: string | undefined;
  let upstreamArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--policy" && args[i + 1]) {
      cliAction = args[++i] as StdioMcpPolicy["action"];
    } else if (a === "--delay-ms" && args[i + 1]) {
      cliDelayMs = Number(args[++i]);
    } else if (a === "--upstream" && args[i + 1]) {
      upstreamCmd = args[++i];
      upstreamArgs = args.slice(i + 1);
      break;
    }
  }

  const cliPolicy: StdioMcpPolicy = { action: cliAction, delayMs: cliDelayMs };

  // If upstream is configured and we're just proxying:
  let upstream: ReturnType<typeof spawn> | null = null;
  let requestIndex = 0;
  const responseCache = readResponseCache();
  const inflight = new Map<string, Array<(payload: Record<string, unknown>) => void>>();
  if (upstreamCmd) {
    upstream = spawn(upstreamCmd, upstreamArgs, {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    upstream.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    if (upstream.stdout) {
      const upstreamRl = createInterface({
        input: upstream.stdout,
        terminal: false,
      });
      upstreamRl.on("line", (uLine) => {
        const uTrimmed = uLine.trim();
        if (!uTrimmed) return;
        try {
          const uParsed = JSON.parse(uTrimmed);
          const uId = uParsed.id;
          const uKey = uId == null ? undefined : `${typeof uId}:${String(uId)}`;
          if (uKey) {
            responseCache.set(uKey, uParsed);
            journalRecord({ type: "upstream_response", dedupeKey: uKey, id: uId, payload: uParsed });
            const waiting = inflight.get(uKey);
            if (waiting) {
              for (const cb of waiting) cb(uParsed);
              inflight.delete(uKey);
            }
          }
        } catch {}
        process.stdout.write(uLine + "\n");
      });
    }
  }

  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const policy = readCurrentPolicy(cliPolicy);

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const id = parsed.id;
    const method = parsed.method;
    const key = id == null ? undefined : `${typeof id}:${String(id)}`;
    const currentRequest = key == null ? undefined : `${requestIndex++}:${key}`;
    if (currentRequest) journalRecord({ type: "request", key: currentRequest, dedupeKey: key, id, method });

    // A request id is the MCP request's durable idempotency key. If a new
    // wrapper process sees a request already committed in the journal, replay
    // the exact response without recording a second response/side effect.
    const cached = key == null ? undefined : responseCache.get(key);
    if (cached) {
      process.stdout.write(JSON.stringify(cached) + "\n");
      if (currentRequest) journalRecord({ type: "response_replay", key: currentRequest, dedupeKey: key, id, method });
      continue;
    }

    if (key && inflight.has(key)) {
      await new Promise<void>((resolve) => {
        inflight.get(key)?.push((payload) => {
          process.stdout.write(JSON.stringify(payload) + "\n");
          if (currentRequest) journalRecord({ type: "response_replay", key: currentRequest, dedupeKey: key, id, method });
          resolve();
        });
      });
      continue;
    }

    const writeResponse = (payload: Record<string, unknown>, duplicate = false): void => {
      const response = { jsonrpc: "2.0", ...payload };
      const responseLine = JSON.stringify(response) + "\n";
      process.stdout.write(responseLine);
      if (currentRequest) journalRecord({ type: "response", key: currentRequest, dedupeKey: key, id, method, payload: response });
      if (key) responseCache.set(key, response);
      if (duplicate) {
        process.stdout.write(responseLine);
        if (currentRequest) journalRecord({ type: "response", key: currentRequest, dedupeKey: key, id, method, payload: response, duplicate: true });
      }
    };

    if (policy.action === "crash") {
      process.exit(1);
    }
    if (policy.action === "timeout") {
      // Intentionally drop/hang
      continue;
    }
    if (policy.action === "delay") {
      await sleep(policy.delayMs ?? 1000);
    }

    if (policy.action === "malformed") {
      process.stdout.write("{not-valid-json\n");
      continue;
    }
    if (policy.action === "truncate") {
      process.stdout.write('{"jsonrpc":"2.0","id":\n');
      process.exit(0);
    }
    if (policy.action === "429") {
      if (id != null) {
        writeResponse({
            id,
            error: { code: -32029, message: "injected 429: rate limit exceeded" },
          });
      }
      continue;
    }
    if (policy.action === "500") {
      if (id != null) {
        writeResponse({
            id,
            error: { code: -32603, message: "injected 500: internal server error" },
          });
      }
      continue;
    }
    if (policy.action === "schema_drift") {
      if (id != null) {
        writeResponse({
            id,
            result: { unexpected_field: true, broken_capabilities: "drift" },
          });
      }
      continue;
    }
    if (policy.action === "oversized") {
      if (id != null) {
        const big = "X".repeat(256 * 1024);
        writeResponse({
            id,
            result: { content: [{ type: "text", text: big }] },
          });
      }
      continue;
    }
    if (policy.action === "partial_write") {
      process.stdout.write('{"jsonrpc":"2.0","id":' + JSON.stringify(id ?? 1) + ',"result":{"content":[{"type":"text","text":"partia');
      process.exit(0);
    }
    if (policy.action === "chunked") {
      const resp = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "chunked-mcp-response" }] } };
      const raw = JSON.stringify(resp) + "\n";
      for (let i = 0; i < raw.length; i += 5) {
        process.stdout.write(raw.slice(i, i + 5));
        await sleep(10);
      }
      if (currentRequest) journalRecord({ type: "response", key: currentRequest, dedupeKey: key, id, method, payload: resp });
      if (key) responseCache.set(key, resp);
      continue;
    }

    // Normal handling
    if (upstream && upstream.stdin) {
      if (key) inflight.set(key, []);
      if (currentRequest) journalRecord({ type: "upstream_forward", key: currentRequest, dedupeKey: key, id, method });
      upstream.stdin.write(trimmed + "\n");
      continue;
    }

    // Built-in MCP stdio server responses
    let resp: Record<string, unknown> | null = null;
    if (method === "initialize") {
      resp = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agentchaos-mcp-stdio", version: "1.0.0" },
      };
    } else if (method === "notifications/initialized") {
      resp = null;
    } else if (method === "tools/list") {
      resp = {
        tools: [
          {
            name: "echo",
            description: "Echo back input text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
    } else if (method === "tools/call") {
      const text = parsed.params?.arguments?.text ?? "ok";
      resp = {
        content: [{ type: "text", text: String(text) }],
      };
    } else if (method === "ping") {
      resp = {};
    } else if (id != null) {
      resp = {};
    }

    if (resp !== null && id != null) {
      writeResponse({ id, result: resp }, policy.action === "duplicate");
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runMcpStdio();
}
