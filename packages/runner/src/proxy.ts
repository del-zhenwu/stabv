import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, Socket as NetSocket, type Server as NetServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export type NetworkPolicy = {
  action: "pass" | "delay" | "timeout" | "reset";
  delayMs?: number;
};

export type LlmPolicy = {
  action: "pass" | "delay" | "timeout" | "401" | "429" | "500" | "malformed" | "truncate" | "schema_drift" | "duplicate";
  delayMs?: number;
};

export class ConnectProxy {
  private server: NetServer | null = null;
  policy: NetworkPolicy = { action: "pass" };

  setPolicy(policy: NetworkPolicy): void {
    this.policy = policy;
  }

  async start(port = 0): Promise<number> {
    this.server = createNetServer((socket) => {
      void this.handle(socket);
    });
    return await listen(this.server, port);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    this.server = null;
  }

  private async handle(socket: Socket): Promise<void> {
    try {
      const head = await readHead(socket);
      const policy = this.policy;
      if (policy.action === "reset") {
        socket.destroy();
        return;
      }
      if (policy.action === "timeout") {
        setTimeout(() => socket.destroy(), policy.delayMs ?? 30_000);
        return;
      }
      if (policy.action === "delay") await sleep(policy.delayMs ?? 1000);
      const connect = head.match(/^CONNECT\s+([^:\s]+):(\d+)/i);
      if (connect) {
        const upstream = await connectUpstream(connect[1], Number(connect[2]));
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.pipe(upstream);
        upstream.pipe(socket);
        return;
      }
      const hostHeader = head.match(/Host:\s*([^:\r\n]+)(?::(\d+))?/i);
      const host = hostHeader?.[1] ?? "127.0.0.1";
      const port = Number(hostHeader?.[2] ?? 80);
      const first = head.split("\r\n")[0] ?? "";
      const rewritten = /^GET https?:\/\//i.test(first) ? head.replace(/^GET https?:\/\/[^/\s]+/i, "GET ") : head;
      const upstream = await connectUpstream(host, port);
      upstream.write(rewritten);
      socket.pipe(upstream);
      upstream.pipe(socket);
    } catch {
      socket.destroy();
    }
  }
}

export class LlmProxy {
  private server: ReturnType<typeof createServer> | null = null;
  policy: LlmPolicy = { action: "pass" };
  hits = 0;

  setPolicy(policy: LlmPolicy): void {
    this.policy = policy;
  }

  async start(port = 0): Promise<number> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    return await listen(this.server, port);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.hits += 1;
    const policy = this.policy;
    if (policy.action === "timeout") {
      setTimeout(() => res.destroy(), policy.delayMs ?? 30_000);
      return;
    }
    if (policy.action === "delay") await sleep(policy.delayMs ?? 1000);
    if (policy.action === "401") {
      writeJson(res, 401, { error: { message: "injected 401", type: "invalid_api_key" } });
      return;
    }
    if (policy.action === "429") {
      writeJson(res, 429, { error: { message: "injected 429", type: "rate_limit_error" } });
      return;
    }
    if (policy.action === "500") {
      writeJson(res, 500, { error: { message: "injected 500", type: "server_error" } });
      return;
    }
    if (policy.action === "malformed") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{not-json");
      return;
    }
    if (policy.action === "truncate") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      res.destroy();
      return;
    }
    if (policy.action === "schema_drift") {
      writeJson(res, 200, { id: "chatcmpl-agentchaos", object: "chat.completion", unexpected_field: true });
      return;
    }
    if (policy.action === "duplicate") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      const chunk = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
      res.write(chunk);
      res.write(chunk);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    writeJson(res, 200, {
      id: "chatcmpl-agentchaos",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });
  }
}

function listen(server: { listen: Function; once: Function; address: Function }, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readHead(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (buf: Buffer) => {
      socket.off("error", reject);
      const text = buf.toString("utf8");
      const idx = text.indexOf("\r\n\r\n");
      if (idx >= 0) {
        const rest = text.slice(idx + 4);
        if (rest) socket.unshift(Buffer.from(rest));
      }
      resolve(text);
    };
    socket.once("error", reject);
    socket.once("data", onData);
  });
}

function connectUpstream(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new NetSocket();
    sock.once("error", reject);
    sock.connect(port, host, () => resolve(sock));
  });
}
