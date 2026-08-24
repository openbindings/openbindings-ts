import { WebSocket as ServerWebSocket, WebSocketServer } from "ws";
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

describe("WSPool UTF-8 frame preservation", () => {
  it("decodes a UTF-8 binary frame without JavaScript object stringification", async () => {
    const { wss, port } = await startServer();
    const connected = new Promise<ServerWebSocket>((resolve) => wss.once("connection", resolve));
    const pool = new WSPool();
    try {
      const pooled = await pool.acquire(`ws://127.0.0.1:${port}`, "/binary");
      const peer = await connected;
      const received = new Promise<{ data: string; error?: Error }>((resolve) => {
        pooled.onMessage((data, error) => resolve({ data, error }));
      });
      peer.send(Buffer.from('{"ok":true}', "utf8"), { binary: true });
      await expect(received).resolves.toEqual({ data: '{"ok":true}', error: undefined });
      pooled.release();
    } finally {
      pool.closeAll();
      wss.close();
    }
  });

  it("surfaces an invalid UTF-8 binary frame instead of replacement-decoding it", async () => {
    const { wss, port } = await startServer();
    const connected = new Promise<ServerWebSocket>((resolve) => wss.once("connection", resolve));
    const pool = new WSPool();
    try {
      const pooled = await pool.acquire(`ws://127.0.0.1:${port}`, "/invalid");
      const peer = await connected;
      const received = new Promise<Error | undefined>((resolve) => {
        pooled.onMessage((_data, error) => resolve(error));
      });
      peer.send(Buffer.from([0xc3, 0x28]), { binary: true });
      await expect(received).resolves.toEqual(
        expect.objectContaining({ message: "WebSocket message payload is not valid UTF-8" }),
      );
      pooled.release();
    } finally {
      pool.closeAll();
      wss.close();
    }
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
        stream: {
          address: "/",
          messages: { Msg: { contentType: "application/json", payload: { type: "object" } } },
        },
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
  }

  async function publish(invoker: AsyncAPIInvoker, bearerToken: string, seq: number) {
    const call = invoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec() },
      selector: "#/operations/publish",
      context: { bearerToken, configuration: { websocketMessageType: "text" } },
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
        selector: "#/operations/publish",
        context: {
          bearerToken: "tenant-zero",
          configuration: { websocketMessageType: "text" },
        },
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
    const { wss, port } = await startServer();
    let upgradeAuth: string | undefined;
    wss.on("connection", (ws, req) => {
      upgradeAuth = req.headers.authorization;
      ws.send(JSON.stringify({ hello: true }));
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: subscribeSpec(port, true) },
        selector: "#/operations/subscribe",
        context: { bearerToken: "test-bearer-xyz" },
      });
      let first: unknown;
      for await (const m of call.outputs) {
        first = m;
        break; // abandoning the sequence cancels the invocation
      }
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
    let upgradeAuth: string | undefined;
    wss.on("connection", (ws, req) => {
      upgradeAuth = req.headers.authorization;
      ws.send(JSON.stringify({ n: 1 }));
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: subscribeSpec(port, false) },
        selector: "#/operations/subscribe",
        context: { bearerToken: "tok" },
      });
      let first: unknown;
      for await (const m of call.outputs) {
        first = m;
        break;
      }
      expect(first).toEqual({ n: 1 });
      expect(upgradeAuth).toBeUndefined();
      await expect(call.closed).rejects.toMatchObject({ code: "ERR_CANCELLED" });
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
        selector: "#/operations/publish",
        context: {
          bearerToken: "tok",
          configuration: { websocketMessageType: "text" },
        },
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
