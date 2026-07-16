import { WebSocketServer } from "ws";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WSPool } from "./ws-pool.js";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

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
      source: { bindingSpec: BINDING_SPEC, content: spec() },
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
        source: { bindingSpec: BINDING_SPEC, content: spec() },
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
// No in-band auth (§9.5, ASYNC-P-07): no credential ever rides a message
// body or a first frame under this specification — credentials ride the
// UPGRADE REQUEST. In-band auth conventions are consumer configuration
// riding the duplex cell as ordinary input frames, never a built-in.
// (Flipped from the pre-conformance first-frame bearer convention these
// tests used to pin; mirrors the Go SDK's TestWebSocketBearerRidesUpgradeRequest,
// TestWebSocketNoInBandAuthWithoutDeclaredScheme, and
// TestWebSocketNoAuthFrameOnPooledConnections.)
// ---------------------------------------------------------------------------

describe("AsyncAPIInvoker no in-band auth (ASYNC-P-07)", () => {
  function subscribeSpec(port: number, withScheme: boolean) {
    return {
      asyncapi: "3.0.0",
      info: { title: "WS auth test", version: "1.0.0" },
      servers: { test: { host: `127.0.0.1:${port}`, protocol: "ws" } },
      channels: {
        stream: {
          address: "/",
          messages: { Msg: { contentType: "application/json", payload: { type: "object" } } },
        },
      },
      operations: {
        subscribe: {
          action: "send" as const,
          channel: { $ref: "#/channels/stream" },
          messages: [{ $ref: "#/channels/stream/messages/Msg" }],
          ...(withScheme ? { security: [{ type: "http", scheme: "bearer" }] } : {}),
        },
        publish: {
          action: "receive" as const,
          channel: { $ref: "#/channels/stream" },
          messages: [{ $ref: "#/channels/stream/messages/Msg" }],
          ...(withScheme ? { security: [{ type: "http", scheme: "bearer" }] } : {}),
        },
      },
    };
  }

  it("a declared bearer credential rides the upgrade request, never a message frame", async () => {
    // The server echoes every frame back, so the first output proves no
    // auth frame preceded the caller's own control frame.
    const { wss, port } = await startServer();
    let upgradeAuth: string | undefined;
    wss.on("connection", (ws, req) => {
      upgradeAuth = req.headers.authorization;
      ws.on("message", (data) => {
        ws.send(data.toString());
      });
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: subscribeSpec(port, true) },
        ref: "#/operations/subscribe",
        context: { bearerToken: "test-bearer-xyz" },
      });
      await call.write({ hello: true });
      let first: unknown;
      for await (const m of call.outputs) {
        first = m;
        break; // abandoning the sequence cancels the invocation
      }
      expect(first).not.toHaveProperty("bearerToken");
      expect(first).toEqual({ hello: true });
      expect(upgradeAuth).toBe("Bearer test-bearer-xyz");
      await expect(call.closed).rejects.toMatchObject({ code: "ERR_CANCELLED" });
    } finally {
      invoker.close();
      wss.close();
    }
  });

  it("never volunteers the token into the message stream when no bearer-family scheme is declared", async () => {
    const { wss, port } = await startServer();
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        ws.send(data.toString());
      });
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: subscribeSpec(port, false) },
        ref: "#/operations/subscribe",
        context: { bearerToken: "tok" },
      });
      await call.write({ n: 1 });
      let first: unknown;
      for await (const m of call.outputs) {
        first = m;
        break;
      }
      expect(first).toEqual({ n: 1 });
      await expect(call.closed).rejects.toMatchObject({ code: "ERR_CANCELLED" });
    } finally {
      invoker.close();
      wss.close();
    }
  });

  it("sends no auth frame on a fresh dial or a pooled reuse; same-credential subscriptions share one upgrade", async () => {
    const { wss, port } = await startServer();
    let upgrades = 0;
    const frames: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    wss.on("connection", (ws) => {
      upgrades++;
      ws.on("message", (data) => {
        frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
        waiters.splice(0).forEach((w) => w());
      });
    });
    const nextFrame = async (count: number) => {
      while (frames.length < count) {
        await new Promise<void>((r) => waiters.push(r));
      }
    };

    const invoker = new AsyncAPIInvoker();
    try {
      const source = { bindingSpec: BINDING_SPEC, content: subscribeSpec(port, true) };
      const bindCtx = { bearerToken: "tok" };

      const sub1 = invoker.invokeBinding({ source, ref: "#/operations/subscribe", context: bindCtx });
      sub1.closed.catch(() => {});
      await sub1.write({ n: 1 });
      await nextFrame(1);
      expect(frames[0]).not.toHaveProperty("bearerToken");
      expect(frames[0]).toEqual({ n: 1 });
      await sub1.cancel();

      // Second subscription reuses the pooled socket (same credential
      // identity): its first frame is likewise its own control frame.
      const sub2 = invoker.invokeBinding({ source, ref: "#/operations/subscribe", context: bindCtx });
      sub2.closed.catch(() => {});
      await sub2.write({ n: 2 });
      await nextFrame(2);
      expect(frames[1]).not.toHaveProperty("bearerToken");
      expect(frames[1]).toEqual({ n: 2 });
      await sub2.cancel();

      expect(upgrades).toBe(1);
    } finally {
      invoker.close();
      wss.close();
    }
  });

  it("never sends any auth frame ahead of a publish payload (auth never rides publish bodies)", async () => {
    const { wss, port } = await startServer();
    const received: unknown[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
      });
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: subscribeSpec(port, true) },
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
      wss.close();
    }
  });
});
