import { WebSocketServer } from "ws";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WSPool } from "./ws-pool.js";
import { AsyncAPIInvoker } from "./invoker.js";
import { FORMAT_TOKEN } from "./constants.js";

// ---------------------------------------------------------------------------
// Shared real WebSocket server fixture
// ---------------------------------------------------------------------------

function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ wss, port });
    });
  });
}

// ---------------------------------------------------------------------------
// WSPool: credentialKey partitions the pool key directly
// ---------------------------------------------------------------------------

describe("WSPool credentialKey partitioning", () => {
  let wss: WebSocketServer;
  let port: number;
  let connections: number;

  beforeAll(async () => {
    ({ wss, port } = await startServer());
    connections = 0;
    wss.on("connection", () => {
      connections++;
    });
  });

  afterAll(() => {
    wss.close();
  });

  it("does not share a connection across differing credential keys", async () => {
    const pool = new WSPool();
    const url = `ws://127.0.0.1:${port}`;

    const a = await pool.acquire(url, "/", { credentialKey: "tenant-a" });
    const b = await pool.acquire(url, "/", { credentialKey: "tenant-b" });
    expect(connections).toBe(2);
    expect(a.ws).not.toBe(b.ws);

    // Same credential key as the first acquire: must reuse its connection.
    const aAgain = await pool.acquire(url, "/", { credentialKey: "tenant-a" });
    expect(connections).toBe(2);
    expect(aAgain.ws).toBe(a.ws);

    a.release();
    b.release();
    aAgain.release();
    pool.closeAll();
  });

  it("treats an absent credentialKey as its own stable partition", async () => {
    const pool = new WSPool();
    const url = `ws://127.0.0.1:${port}`;

    const first = await pool.acquire(url, "/anon");
    const second = await pool.acquire(url, "/anon");
    expect(first.ws).toBe(second.ws);

    first.release();
    second.release();
    pool.closeAll();
  });
});

// ---------------------------------------------------------------------------
// AsyncAPIInvoker: end-to-end, mirrors the Go SDK's
// TestWSPool_DifferentCredentialsNeverShareConnection.
// ---------------------------------------------------------------------------

describe("AsyncAPIInvoker WebSocket pool credential isolation (real ws server)", () => {
  let wss: WebSocketServer;
  let port: number;
  let connections: number;

  beforeAll(async () => {
    ({ wss, port } = await startServer());
    connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.on("message", () => {
        /* drain */
      });
    });
  });

  afterAll(() => {
    wss.close();
  });

  function spec() {
    return {
      asyncapi: "3.0.0",
      info: { title: "WS credential pool test", version: "1.0.0" },
      servers: { test: { host: `127.0.0.1:${port}`, protocol: "ws" } },
      channels: {
        stream: { address: "/", messages: { Msg: { payload: { type: "object" } } } },
      },
      operations: {
        publish: {
          action: "receive" as const,
          channel: { $ref: "#/channels/stream" },
          messages: [{ $ref: "#/channels/stream/messages/Msg" }],
        },
      },
    };
  }

  async function publish(invoker: AsyncAPIInvoker, bearerToken: string, seq: number) {
    const call = invoker.invokeBinding({
      source: { format: FORMAT_TOKEN, content: spec() },
      ref: "#/operations/publish",
      context: { bearerToken },
    });
    await call.write({ seq });
    await call.close();
    await call.closed;
  }

  it("never shares a pooled socket across different bearer tokens, but reuses it for a repeat token", async () => {
    const invoker = new AsyncAPIInvoker();
    try {
      await publish(invoker, "tenant-a", 0);
      await publish(invoker, "tenant-b", 1);
      expect(connections).toBe(2);

      // Same token as the first call: must reuse tenant-a's socket, not
      // open a third connection.
      await publish(invoker, "tenant-a", 2);
      expect(connections).toBe(2);
    } finally {
      invoker.close();
    }
  });

  it("fails ERR_MISSING_INPUT when input closes with zero messages (ASYNC-P-03)", async () => {
    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { format: FORMAT_TOKEN, content: spec() },
        ref: "#/operations/publish",
        context: { bearerToken: "tenant-zero" },
      });
      await call.close();
      await expect(call.closed).rejects.toMatchObject({ code: "ERR_MISSING_INPUT" });
    } finally {
      invoker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// First-frame bearer: a subscription-cell convention only. Publish frames
// (`receive` action) must never carry it (auth never rides publish bodies).
// ---------------------------------------------------------------------------

describe("AsyncAPIInvoker first-frame bearer convention on send", () => {
  let wss: WebSocketServer;
  let port: number;
  let received: unknown[];

  beforeAll(async () => {
    ({ wss, port } = await startServer());
    received = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
      });
    });
  });

  afterAll(() => {
    wss.close();
  });

  it("never sends a {bearerToken} frame ahead of the publish payload", async () => {
    const spec = {
      asyncapi: "3.0.0",
      info: { title: "WS send auth test", version: "1.0.0" },
      servers: { test: { host: `127.0.0.1:${port}`, protocol: "ws" } },
      channels: {
        stream: { address: "/", messages: { Msg: { payload: { type: "object" } } } },
      },
      operations: {
        publish: {
          action: "receive" as const,
          channel: { $ref: "#/channels/stream" },
          messages: [{ $ref: "#/channels/stream/messages/Msg" }],
          security: [{ type: "http", scheme: "bearer" }],
        },
      },
    };

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { format: FORMAT_TOKEN, content: spec },
        ref: "#/operations/publish",
        context: { bearerToken: "tok" },
      });
      await call.write({ seq: 0 });
      await call.close();
      await call.closed;

      // Wait a tick for the server's message handler to run.
      await new Promise((r) => setTimeout(r, 20));

      expect(received).toEqual([{ seq: 0 }]);
    } finally {
      invoker.close();
    }
  });
});
