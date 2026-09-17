import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export type RemotePolicy = {
  action: "pass" | "disconnect" | "heartbeat_timeout" | "lease_expire";
  delayMs?: number;
};

export type RemoteLease = {
  leaseId: string;
  agentId: string;
  token: string;
  expiresAt: number;
  lastHeartbeat: number;
  heartbeats: number;
  checkpoints: { checkpointId: string; state: unknown; ts: number }[];
};

export class RemoteCoordinator {
  private server: Server;
  private port = 0;
  private policy: RemotePolicy = { action: "pass" };
  private leases = new Map<string, RemoteLease>();

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (typeof addr === "object" && addr) {
          this.port = addr.port;
          resolve(this.url);
        }
      });
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  setPolicy(policy: RemotePolicy): void {
    this.policy = policy;
    if (policy.action === "lease_expire") {
      const now = Date.now();
      for (const lease of this.leases.values()) {
        lease.expiresAt = now - 1;
      }
    }
  }

  getLeases(): RemoteLease[] {
    return [...this.leases.values()];
  }

  getHealthyLeases(): RemoteLease[] {
    const now = Date.now();
    return [...this.leases.values()].filter((l) => l.expiresAt > now);
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.policy.action === "disconnect") {
      req.socket.destroy();
      return;
    }

    if (this.policy.action === "heartbeat_timeout" && req.url?.includes("/heartbeat")) {
      const delay = this.policy.delayMs ?? 5000;
      await new Promise((r) => setTimeout(r, delay));
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyStr = Buffer.concat(chunks).toString("utf8");
    let body: any = {};
    try {
      if (bodyStr) body = JSON.parse(bodyStr);
    } catch {
      /* ignore JSON parse errors in body */
    }

    const url = req.url ?? "/";
    res.setHeader("Content-Type", "application/json");

    if (url === "/v1/leases/acquire" && req.method === "POST") {
      const agentId = String(body.agentId ?? `agent-${Date.now()}`);
      const ttlMs = Number(body.ttlMs ?? 5000);
      const leaseId = `lease-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const token = `token-${Math.random().toString(36).slice(2, 10)}`;
      const now = Date.now();
      const lease: RemoteLease = {
        leaseId,
        agentId,
        token,
        expiresAt: now + ttlMs,
        lastHeartbeat: now,
        heartbeats: 0,
        checkpoints: [],
      };
      this.leases.set(leaseId, lease);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, leaseId, token, expiresAt: lease.expiresAt }));
      return;
    }

    if (url === "/v1/leases/heartbeat" && req.method === "POST") {
      const leaseId = String(body.leaseId ?? "");
      const lease = this.leases.get(leaseId);
      if (!lease) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: "lease_not_found" }));
        return;
      }
      const now = Date.now();
      if (now > lease.expiresAt) {
        res.writeHead(410);
        res.end(JSON.stringify({ ok: false, error: "lease_expired" }));
        return;
      }
      lease.lastHeartbeat = now;
      lease.heartbeats++;
      lease.expiresAt = now + Number(body.ttlMs ?? 5000);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, refreshed: true, expiresAt: lease.expiresAt, heartbeats: lease.heartbeats }));
      return;
    }

    if (url === "/v1/checkpoints" && req.method === "POST") {
      const leaseId = String(body.leaseId ?? "");
      const lease = this.leases.get(leaseId);
      const checkpointId = String(body.checkpointId ?? `chk-${Date.now()}`);
      const item = { checkpointId, state: body.state, ts: Date.now() };
      if (lease) lease.checkpoints.push(item);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, checkpointId }));
      return;
    }

    if (url === "/v1/status" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, leases: [...this.leases.values()] }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  }
}
