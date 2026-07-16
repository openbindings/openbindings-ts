import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { Invocation } from "@openbindings/sdk";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// Conformance tests for the openbindings.asyncapi@1 remainder: the server
// and address configuration points (ASYNC-P-04), protocol-bindings honoring
// (ASYNC-P-02), SSE establishment and WHATWG event framing (§8,
// ASYNC-P-06), and the §9.1/§9.3 encode/decode lanes (ASYNC-P-03,
// ASYNC-P-05). Mirrors the Go SDK's conformance_test.go.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface HTTPFixture {
  port: number;
  requests: () => number;
  lastPath: () => string | undefined;
  lastMethod: () => string | undefined;
  lastBody: () => string | undefined;
  lastContentType: () => string | undefined;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Starts a node:http server driven by `handler`, tracking request stats. */
function startHTTP(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<HTTPFixture> {
  return new Promise((resolve) => {
    let requests = 0;
    let lastPath: string | undefined;
    let lastMethod: string | undefined;
    let lastBody: string | undefined;
    let lastContentType: string | undefined;
    const server: Server = createServer((req, res) => {
      requests++;
      lastPath = req.url;
      lastMethod = req.method;
      lastContentType = req.headers["content-type"];
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        lastBody = body;
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      cleanups.push(() => {
        server.closeAllConnections();
        server.close();
      });
      resolve({
        port,
        requests: () => requests,
        lastPath: () => lastPath,
        lastMethod: () => lastMethod,
        lastBody: () => lastBody,
        lastContentType: () => lastContentType,
      });
    });
  });
}

/** Starts a ws server; `onConnection` sees each socket and its upgrade request. */
function startWS(
  onConnection: (ws: import("ws").WebSocket, req: IncomingMessage) => void,
): Promise<{ port: number; upgrades: () => number }> {
  return new Promise((resolve) => {
    let upgrades = 0;
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      cleanups.push(() => wss.close());
      resolve({ port, upgrades: () => upgrades });
    });
    wss.on("connection", (ws, req) => {
      upgrades++;
      onConnection(ws, req);
    });
  });
}

/** Drains an invocation's outputs, capturing the terminal error instead of
 * letting it reject out of the for-await loop — the TS mirror of the Go
 * suite's drainOutputs helper. */
async function drainOutputs(call: Invocation): Promise<{ vals: unknown[]; err?: Error }> {
  const vals: unknown[] = [];
  try {
    for await (const v of call.outputs) vals.push(v);
    await call.closed;
    return { vals };
  } catch (err) {
    return { vals, err: err as Error };
  }
}

function codeOf(err: Error | undefined): string | undefined {
  return (err as { code?: string } | undefined)?.code;
}

/** One publish round-trip: write one value, close input, drain. Writes are
 * tolerant of a pre-dispatch refusal landing first (the refusal is the
 * asserted surface, via the returned terminal). */
async function publish(
  invoker: AsyncAPIInvoker,
  content: unknown,
  ref: string,
  context?: Record<string, unknown>,
  value: unknown = { m: 1 },
): Promise<{ vals: unknown[]; err?: Error }> {
  const call = invoker.invokeBinding({
    source: { bindingSpec: BINDING_SPEC, content },
    ref,
    context,
  });
  await call.write(value).catch(() => {});
  await call.close().catch(() => {});
  return drainOutputs(call);
}

// ---------------------------------------------------------------------------
// Address parameters (ASYNC-P-04)
// ---------------------------------------------------------------------------

/** A parameterized channel address: {roomId} has no default, {lane} declares one. */
function paramDoc(port: number) {
  return {
    asyncapi: "3.0.0",
    info: { title: "t", version: "1" },
    servers: { test: { host: `127.0.0.1:${port}`, protocol: "http" } },
    channels: {
      rooms: {
        address: "/rooms/{roomId}/{lane}",
        parameters: {
          roomId: {},
          lane: { default: "main" },
        },
      },
    },
    operations: {
      post: { action: "receive" as const, channel: { $ref: "#/channels/rooms" } },
    },
  };
}

describe("address parameters (ASYNC-P-04)", () => {
  it("expands {name} from supplied values, else declared defaults; unresolved refuses pre-dispatch", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const invoker = new AsyncAPIInvoker();
    try {
      // Supplied roomId + defaulted lane.
      let r = await publish(invoker, paramDoc(srv.port), "#/operations/post", {
        configuration: { address: { parameters: { roomId: "general" } } },
      });
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/rooms/general/main");

      // A supplied value overrides a declared default.
      r = await publish(invoker, paramDoc(srv.port), "#/operations/post", {
        configuration: { address: { parameters: { roomId: "ops", lane: "audit" } } },
      });
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/rooms/ops/audit");

      // Unresolved after defaults: pre-dispatch refusal, braces never dialed.
      const before = srv.requests();
      r = await publish(invoker, paramDoc(srv.port), "#/operations/post");
      expect(codeOf(r.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      expect(srv.requests()).toBe(before);
    } finally {
      invoker.close();
    }
  });

  it("refuses a supplied parameter value outside the declared enum", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const doc = paramDoc(srv.port);
    doc.channels.rooms.parameters.roomId = { enum: ["general", "ops"] } as never;

    const invoker = new AsyncAPIInvoker();
    try {
      const r = await publish(invoker, doc, "#/operations/post", {
        configuration: { address: { parameters: { roomId: "backstage" } } },
      });
      expect(codeOf(r.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      expect(srv.requests()).toBe(0);
    } finally {
      invoker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Server set, server variables, URL assembly (ASYNC-P-04)
// ---------------------------------------------------------------------------

describe("server variables and pathname assembly (ASYNC-P-04)", () => {
  it("substitutes variables into pathname with exactly one slash at the join; enforces enums; refuses unresolved", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const doc = {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: {
        test: {
          host: `127.0.0.1:${srv.port}`,
          protocol: "http",
          pathname: "/{version}/", // trailing slash: the join still yields exactly one /
          variables: {
            version: { default: "v1", enum: ["v1", "v2"] },
          },
        },
      },
      channels: { events: { address: "/events" } },
      operations: {
        post: { action: "receive" as const, channel: { $ref: "#/channels/events" } },
      },
    };

    const invoker = new AsyncAPIInvoker();
    try {
      // Declared default.
      let r = await publish(invoker, doc, "#/operations/post");
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/v1/events");

      // Consumer-supplied variable value via the server configuration point.
      r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { variables: { version: "v2" } } },
      });
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/v2/events");

      // A supplied value outside the declared enum is refused.
      r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { variables: { version: "v3" } } },
      });
      expect(codeOf(r.err)).toBe("ERR_SOURCE_CONFIG_ERROR");

      // No default and no supplied value: pre-dispatch refusal.
      const noDefault = {
        ...doc,
        servers: {
          test: {
            host: `127.0.0.1:${srv.port}`,
            protocol: "http",
            pathname: "/{version}",
            variables: { version: {} },
          },
        },
      };
      const before = srv.requests();
      r = await publish(invoker, noDefault, "#/operations/post");
      expect(codeOf(r.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      expect(srv.requests()).toBe(before);
    } finally {
      invoker.close();
    }
  });
});

describe("effective server set (ASYNC-P-04)", () => {
  it("honors channel-subset array order, doc-map lexicographic order with unbound protocols skipped, and selection by name", async () => {
    const srvA = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const srvB = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });

    const mkDoc = (channelServers?: Array<{ $ref: string }>) => ({
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: {
        // Lexicographically first, but an out-of-revision protocol: the
        // doc-order default must SKIP it, never refuse on it.
        aKafka: { host: "broker.example.com:9092", protocol: "kafka" },
        bHTTP: { host: `127.0.0.1:${srvA.port}`, protocol: "http" },
        zHTTP: { host: `127.0.0.1:${srvB.port}`, protocol: "http" },
      },
      channels: {
        c: { address: "/c", ...(channelServers ? { servers: channelServers } : {}) },
      },
      operations: {
        post: { action: "receive" as const, channel: { $ref: "#/channels/c" } },
      },
    });

    const invoker = new AsyncAPIInvoker();
    try {
      // Non-empty channel servers subset: array order wins — zHTTP is listed
      // FIRST, so it is the default even though bHTTP sorts before it.
      let r = await publish(
        invoker,
        mkDoc([{ $ref: "#/servers/zHTTP" }, { $ref: "#/servers/bHTTP" }]),
        "#/operations/post",
      );
      expect(r.err).toBeUndefined();
      expect(srvB.requests()).toBe(1);
      expect(srvA.requests()).toBe(0);

      // Absent channel servers = ALL doc servers in lexicographic key order:
      // aKafka (unbound) is skipped, bHTTP selected.
      r = await publish(invoker, mkDoc(), "#/operations/post");
      expect(r.err).toBeUndefined();
      expect(srvA.requests()).toBe(1);

      // Consumer configuration selects another member of the effective set
      // by name.
      r = await publish(invoker, mkDoc(), "#/operations/post", {
        configuration: { server: { name: "zHTTP" } },
      });
      expect(r.err).toBeUndefined();
      expect(srvB.requests()).toBe(2);

      // A name outside the effective set is a refusal.
      r = await publish(
        invoker,
        mkDoc([{ $ref: "#/servers/zHTTP" }]),
        "#/operations/post",
        { configuration: { server: { name: "bHTTP" } } },
      );
      expect(codeOf(r.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      expect(srvA.requests()).toBe(1);
    } finally {
      invoker.close();
    }
  });

  it("refuses pre-dispatch when only out-of-revision protocols are declared", async () => {
    const doc = {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: {
        broker: { host: "broker.example.com:9092", protocol: "kafka" },
      },
      channels: { c: { address: "/c" } },
      operations: { post: { action: "receive" as const, channel: { $ref: "#/channels/c" } } },
    };
    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: doc },
        ref: "#/operations/post",
      });
      const { err } = await drainOutputs(call);
      expect(codeOf(err)).toBe("ERR_SOURCE_CONFIG_ERROR");
    } finally {
      invoker.close();
    }
  });
});

describe("full-URL override (ASYNC-P-04, §9.5)", () => {
  it("refuses out-of-revision schemes; the default-selected server's security still applies; the override URL is dialed", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const doc = {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: {
        prod: {
          host: "unreachable.example.com",
          protocol: "https",
          security: [{ $ref: "#/components/securitySchemes/bearer" }],
        },
      },
      channels: { c: { address: "/c" } },
      operations: { post: { action: "receive" as const, channel: { $ref: "#/channels/c" } } },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    };

    const invoker = new AsyncAPIInvoker();
    try {
      // Out-of-revision scheme: refused pre-dispatch.
      let r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { url: "ftp://files.example.com" } },
      });
      expect(codeOf(r.err)).toBe("ERR_SOURCE_CONFIG_ERROR");

      // The default-selected server's declared security still applies under
      // a full-URL override: the challenge fires before any I/O.
      const before = srv.requests();
      r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { url: `http://127.0.0.1:${srv.port}` } },
      });
      expect(codeOf(r.err)).toBe("CONTEXT_REQUIRED");
      expect(srv.requests()).toBe(before);

      // With the credential supplied, the override URL is dialed.
      r = await publish(invoker, doc, "#/operations/post", {
        bearerToken: "tok",
        configuration: { server: { url: `http://127.0.0.1:${srv.port}` } },
      });
      expect(r.err).toBeUndefined();
      expect(srv.requests()).toBe(before + 1);
    } finally {
      invoker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Protocol bindings (ASYNC-P-02)
// ---------------------------------------------------------------------------

describe("http operation binding method override (ASYNC-P-02)", () => {
  it("uses the binding-declared method in place of POST (publish) and GET (SSE)", async () => {
    let publishMethod: string | undefined;
    let sseMethod: string | undefined;
    const srv = await startHTTP((req, res) => {
      if (req.url === "/in") {
        publishMethod = req.method;
        res.writeHead(202);
        res.end();
      } else if (req.url === "/out") {
        sseMethod = req.method;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('data: {"seq":1}\n\n');
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const doc = {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: { test: { host: `127.0.0.1:${srv.port}`, protocol: "http" } },
      channels: {
        in: { address: "/in" },
        out: { address: "/out" },
      },
      operations: {
        post: {
          action: "receive" as const,
          channel: { $ref: "#/channels/in" },
          bindings: { http: { method: "PUT" } },
        },
        sub: {
          action: "send" as const,
          channel: { $ref: "#/channels/out" },
          bindings: { http: { method: "POST" } },
        },
      },
    };

    const invoker = new AsyncAPIInvoker();
    try {
      const r = await publish(invoker, doc, "#/operations/post");
      expect(r.err).toBeUndefined();
      expect(publishMethod).toBe("PUT");

      const sub = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: doc },
        ref: "#/operations/sub",
      });
      const { vals, err } = await drainOutputs(sub);
      expect(err).toBeUndefined();
      expect(vals).toHaveLength(1);
      expect(sseMethod).toBe("POST");
    } finally {
      invoker.close();
    }
  });
});

/** A ws channel binding with a required query property, a defaulted query
 * property, a defaulted header, and a required header. */
function wsBindingDoc(port: number) {
  return {
    asyncapi: "3.0.0",
    info: { title: "t", version: "1" },
    servers: { test: { host: `127.0.0.1:${port}`, protocol: "ws" } },
    channels: {
      stream: {
        address: "/ws",
        bindings: {
          ws: {
            method: "GET",
            query: {
              type: "object",
              properties: {
                token: { type: "string" },
                lane: { type: "string", default: "live" },
              },
              required: ["token"],
            },
            headers: {
              type: "object",
              properties: {
                "X-Client": { type: "string", default: "ob" },
                "X-Trace": { type: "string" },
              },
              required: ["X-Trace"],
            },
          },
        },
      },
    },
    operations: {
      publish: { action: "receive" as const, channel: { $ref: "#/channels/stream" } },
    },
  };
}

describe("ws channel binding governs the upgrade (ASYNC-P-02, §8)", () => {
  it("resolves declared query/headers from the parameter bag, generic header carriage, and defaults; refuses unsatisfied required declarations pre-dispatch", async () => {
    interface Seen {
      token: string;
      lane: string;
      xClient: string;
      xTrace: string;
    }
    const seen: Seen[] = [];
    let seenResolve: (() => void) | undefined;
    const srv = await startWS((ws, req) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      seen.push({
        token: url.searchParams.get("token") ?? "",
        lane: url.searchParams.get("lane") ?? "",
        xClient: (req.headers["x-client"] as string) ?? "",
        xTrace: (req.headers["x-trace"] as string) ?? "",
      });
      seenResolve?.();
      ws.on("message", () => {
        /* drain */
      });
    });

    const invoker = new AsyncAPIInvoker();
    try {
      // Required query via the parameter bag; required header via the
      // generic header carriage; defaults fill the rest.
      const sawUpgrade = new Promise<void>((r) => {
        seenResolve = r;
      });
      const r = await publish(invoker, wsBindingDoc(srv.port), "#/operations/publish", {
        headers: { "X-Trace": "trace-1" },
        configuration: { address: { parameters: { token: "qtok" } } },
      });
      expect(r.err).toBeUndefined();
      await sawUpgrade;
      expect(seen[0]).toEqual({ token: "qtok", lane: "live", xClient: "ob", xTrace: "trace-1" });

      // Unsatisfied required declarations: pre-dispatch refusals, no upgrade.
      const before = srv.upgrades();
      const missingQuery = await publish(invoker, wsBindingDoc(srv.port), "#/operations/publish", {
        headers: { "X-Trace": "trace-2" },
      });
      expect(codeOf(missingQuery.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      const missingHeader = await publish(invoker, wsBindingDoc(srv.port), "#/operations/publish", {
        configuration: { address: { parameters: { token: "qtok" } } },
      });
      expect(codeOf(missingHeader.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      expect(srv.upgrades()).toBe(before);
    } finally {
      invoker.close();
    }
  });

  it("refuses a declared non-GET upgrade method loudly, pre-dispatch", async () => {
    const srv = await startWS(() => {
      /* never reached */
    });
    const doc = wsBindingDoc(srv.port);
    doc.channels.stream.bindings = { ws: { method: "POST" } } as never;

    const invoker = new AsyncAPIInvoker();
    try {
      const r = await publish(invoker, doc, "#/operations/publish");
      expect(codeOf(r.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      expect(srv.upgrades()).toBe(0);
    } finally {
      invoker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// SSE establishment and WHATWG event framing (§8, ASYNC-P-06)
// ---------------------------------------------------------------------------

function sseDoc(port: number, path: string) {
  return {
    asyncapi: "3.0.0",
    info: { title: "t", version: "1" },
    servers: { test: { host: `127.0.0.1:${port}`, protocol: "http" } },
    channels: { caps: { address: path } },
    operations: {
      receiveCaps: { action: "send" as const, channel: { $ref: "#/channels/caps" } },
    },
  };
}

describe("SSE establishment pin (§8, ASYNC-P-06)", () => {
  it("fails ERR_PROTOCOL on a 2xx response without the text/event-stream content type", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ not: "a stream" }));
    });
    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: sseDoc(srv.port, "/") },
        ref: "#/operations/receiveCaps",
      });
      const { err } = await drainOutputs(call);
      expect(codeOf(err)).toBe("ERR_PROTOCOL");
    } finally {
      invoker.close();
    }
  });
});

describe("SSE WHATWG event framing (§8)", () => {
  it("joins data lines with U+000A, strips one leading space, drops comment-only/empty-data events, keeps framing fields out of values, and discards an incomplete final event", async () => {
    const body = [
      ": stream comment", // comment-only event
      "",
      "event: greeting",
      "id: 41",
      "data: hello",
      "data:  indented", // ONE leading space stripped: " indented"
      "",
      "data:", // empty-data event: emits nothing
      "",
      "retry: 5000", // framing only; never acted on (no reconnect in @1)
      "data: second",
      "",
      "data: never dispatched (EOF before blank line)",
    ].join("\n");
    const srv = await startHTTP((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(body);
    });

    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: sseDoc(srv.port, "/") },
        ref: "#/operations/receiveCaps",
      });
      const { vals, err } = await drainOutputs(call);
      expect(err).toBeUndefined();
      expect(vals).toEqual(["hello\n indented", "second"]);
    } finally {
      invoker.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Encode/decode lanes (ASYNC-P-03, ASYNC-P-05)
// ---------------------------------------------------------------------------

/** A publish+subscribe doc whose channel message declares the given content
 * type (empty string = no declaration anywhere). */
function laneDoc(port: number, proto: string, contentType: string, address = "/c") {
  const msg: Record<string, unknown> = { name: "m" };
  if (contentType !== "") msg.contentType = contentType;
  return {
    asyncapi: "3.0.0",
    info: { title: "t", version: "1" },
    servers: { test: { host: `127.0.0.1:${port}`, protocol: proto } },
    channels: {
      c: { address, messages: { m: msg } },
    },
    operations: {
      post: {
        action: "receive" as const,
        channel: { $ref: "#/channels/c" },
        messages: [{ $ref: "#/channels/c/messages/m" }],
        reply: { messages: [{ $ref: "#/channels/c/messages/m" }] },
      },
      sub: {
        action: "send" as const,
        channel: { $ref: "#/channels/c" },
        messages: [{ $ref: "#/channels/c/messages/m" }],
      },
    },
  };
}

describe("input text lane (§9.1, ASYNC-P-03)", () => {
  it("sends a string raw with the declared type on the wire; refuses a non-string value before dispatch", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const invoker = new AsyncAPIInvoker();
    try {
      const r = await publish(
        invoker,
        laneDoc(srv.port, "http", "text/plain"),
        "#/operations/post",
        undefined,
        "raw payload, not JSON-quoted",
      );
      expect(r.err).toBeUndefined();
      expect(srv.lastBody()).toBe("raw payload, not JSON-quoted");
      expect(srv.lastContentType()).toBe("text/plain");

      const before = srv.requests();
      const refused = await publish(
        invoker,
        laneDoc(srv.port, "http", "text/plain"),
        "#/operations/post",
        undefined,
        { not: "a string" },
      );
      expect(codeOf(refused.err)).toBe("ERR_VALIDATION_FAILED");
      expect(srv.requests()).toBe(before);
    } finally {
      invoker.close();
    }
  });
});

describe("excluded input families (§9.1, ASYNC-P-03)", () => {
  it("refuses a declared non-JSON non-text family before any request or upgrade", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const invoker = new AsyncAPIInvoker();
    try {
      const r = await publish(invoker, laneDoc(srv.port, "http", "avro/binary"), "#/operations/post");
      expect(codeOf(r.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      expect(srv.requests()).toBe(0);

      // WS cell: refused before any socket is dialed.
      const wsSrv = await startWS(() => {
        /* never reached */
      });
      const wsRefused = await publish(
        invoker,
        laneDoc(wsSrv.port, "ws", "application/octet-stream", "/ws"),
        "#/operations/post",
      );
      expect(codeOf(wsRefused.err)).toBe("ERR_SOURCE_CONFIG_ERROR");
      expect(wsSrv.upgrades()).toBe(0);
    } finally {
      invoker.close();
    }
  });
});

describe("decode text lane and reply direction (§9.3, ASYNC-P-05)", () => {
  it("decodes a publish output by the REPLY-side declaration and an ambiguous governing set on the text lane", async () => {
    const srv = await startHTTP((req, res) => {
      if (req.url === "/c") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"looks":"like json"}');
      } else if (req.url === "/mixed") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('data: {"seq":1}\n\n');
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const invoker = new AsyncAPIInvoker();
    try {
      // Reply-side declares text/plain: the response body stays a raw
      // string (the lane is the DECLARATION's, never sniffed from bytes or
      // headers).
      const r = await publish(
        invoker,
        laneDoc(srv.port, "http", "text/plain"),
        "#/operations/post",
        undefined,
        "ping",
      );
      expect(r.err).toBeUndefined();
      expect(r.vals).toEqual(['{"looks":"like json"}']);

      // Two distinct effective types govern the subscription: ambiguous →
      // text lane, events stay strings.
      const mixed = {
        asyncapi: "3.0.0",
        info: { title: "t", version: "1" },
        servers: { test: { host: `127.0.0.1:${srv.port}`, protocol: "http" } },
        channels: {
          mixed: {
            address: "/mixed",
            messages: {
              j: { name: "j", contentType: "application/json" },
              t: { name: "t", contentType: "text/plain" },
            },
          },
        },
        operations: {
          sub: { action: "send" as const, channel: { $ref: "#/channels/mixed" } },
        },
      };
      const sub = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: mixed },
        ref: "#/operations/sub",
      });
      const { vals, err } = await drainOutputs(sub);
      expect(err).toBeUndefined();
      expect(vals).toEqual(['{"seq":1}']);
    } finally {
      invoker.close();
    }
  });
});
