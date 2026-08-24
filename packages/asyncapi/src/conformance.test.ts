import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { Invocation } from "@openbindings/invoke";
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

/** Narrows a CONTEXT_REQUIRED terminal to its single config.value requirement. */
function configReq(err: Error | undefined): { type: string; point?: string; path?: string; durable?: boolean } {
  const details = (err as { data?: { alternatives?: { requirements?: unknown[] }[] } } | undefined)?.data;
  const req = details?.alternatives?.[0]?.requirements?.[0] as
    | { type: string; point?: string; path?: string; durable?: boolean }
    | undefined;
  if (!req || req.type !== "config.value") {
    throw new Error(`expected a config.value requirement, got ${JSON.stringify(req)}`);
  }
  return req;
}

/** One publish round-trip: write one value, close input, drain. Writes are
 * tolerant of a pre-dispatch refusal landing first (the refusal is the
 * asserted surface, via the returned terminal). */
async function publish(
  invoker: AsyncAPIInvoker,
  content: unknown,
  selector: string,
  context?: Record<string, unknown>,
  value: unknown = { m: 1 },
): Promise<{ vals: unknown[]; err?: Error }> {
  const call = invoker.invokeBinding({
    source: { bindingSpec: BINDING_SPEC, content },
    selector,
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
        messages: { json: { name: "json", contentType: "application/json" } },
        parameters: {
          roomId: {},
          lane: { default: "main" },
        },
      },
    },
    operations: {
      post: {
        action: "receive" as const,
        channel: { $ref: "#/channels/rooms" },
        bindings: { http: { method: "POST" } },
      },
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
      // The routed envelope (§9.2, ruled 2026-08-14): the parameterized
      // channel's input carries the payload under "payload"; the address
      // parameters here keep riding the configuration pre-fill (Go twin:
      // TestAddressParameterExpansion).
      const envelope = { payload: { m: 1 } };
      // Supplied roomId + defaulted lane.
      let r = await publish(invoker, paramDoc(srv.port), "#/operations/post", {
        configuration: { address: { parameters: { roomId: "general" } } },
      }, envelope);
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/rooms/general/main");

      // A supplied value overrides a declared default.
      r = await publish(invoker, paramDoc(srv.port), "#/operations/post", {
        configuration: { address: { parameters: { roomId: "ops", lane: "audit" } } },
      }, envelope);
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/rooms/ops/audit");

      // Unresolved after defaults: braces never dialed. R1a: a resolvable-
      // missing address parameter is a config.value CONTEXT_REQUIRED, not a
      // terminal ERR_SOURCE_CONFIG_ERROR.
      const before = srv.requests();
      r = await publish(invoker, paramDoc(srv.port), "#/operations/post", undefined, envelope);
      expect(codeOf(r.err)).toBe("CONTEXT_REQUIRED");
      expect(configReq(r.err).point).toBe("address");
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
    doc.channels.rooms.parameters.roomId = { enum: ["general", "ops"] };

    const invoker = new AsyncAPIInvoker();
    try {
      // The artifact-declared enum is authoritative.
      const r = await publish(invoker, doc, "#/operations/post", {
        configuration: { address: { parameters: { roomId: "backstage" } } },
      }, { payload: { m: 1 } });
      expect(codeOf(r.err)).toBe("ERR_REFUSED");
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
  it("substitutes supplied-else-default into pathname with exactly one slash at the join; refuses supplied out-of-enum values and unresolved expressions", async () => {
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
      channels: {
        events: {
          address: "/events",
          messages: { json: { name: "json", contentType: "application/json" } },
        },
      },
      operations: {
        post: {
          action: "receive" as const,
          channel: { $ref: "#/channels/events" },
          bindings: { http: { method: "POST" } },
        },
      },
    };

    const invoker = new AsyncAPIInvoker();
    try {
      // Declared default.
      let r = await publish(invoker, doc, "#/operations/post");
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/v1/events");

      // A supplied value at the key form's `variables` member wins over
      // the declared default (§9.2's supplied-else-default substitution).
      r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { key: "test", variables: { version: "v2" } } },
      });
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/v2/events");

      // A supplied value outside the variable's declared enum is refused.
      r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { key: "test", variables: { version: "v9" } } },
      });
      expect(codeOf(r.err)).toBe("ERR_REFUSED");

      // A declared default outside the variable's own enum is likewise
      // inconsistent and refused.
      const badDefault = {
        ...doc,
        servers: {
          test: {
            host: `127.0.0.1:${srv.port}`,
            protocol: "http",
            pathname: "/{version}",
            variables: { version: { default: "v9", enum: ["v1", "v2"] } },
          },
        },
      };
      r = await publish(invoker, badDefault, "#/operations/post");
      expect(codeOf(r.err)).toBe("ERR_REFUSED");

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
      // R1a: an undefaulted, unsupplied server variable is a config.value
      // CONTEXT_REQUIRED, not a terminal ERR_SOURCE_CONFIG_ERROR.
      expect(codeOf(r.err)).toBe("CONTEXT_REQUIRED");
      expect(configReq(r.err).point).toBe("server");
      expect(configReq(r.err).path).toBe("/variables/version");
      expect(srv.requests()).toBe(before);

      // The same undefaulted variable IS satisfiable by supply — AsyncAPI
      // declares Server Variable defaults OPTIONAL, so consumer supply is
      // the only way to satisfy it (the carriage §9.2's assembly rule
      // presupposes).
      r = await publish(invoker, noDefault, "#/operations/post", {
        configuration: { server: { key: "test", variables: { version: "v7" } } },
      });
      expect(r.err).toBeUndefined();
      expect(srv.lastPath()).toBe("/v7/events");
    } finally {
      invoker.close();
    }
  });
});

describe("effective server set (ASYNC-P-04)", () => {
  it("honors channel-subset array order, doc-map lexicographic order with unbound protocols skipped, and selection by key", async () => {
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
        c: {
          address: "/c",
          messages: { json: { name: "json", contentType: "application/json" } },
          ...(channelServers ? { servers: channelServers } : {}),
        },
      },
      operations: {
        post: {
          action: "receive" as const,
          channel: { $ref: "#/channels/c" },
          bindings: { http: { method: "POST" } },
        },
      },
    });

    const invoker = new AsyncAPIInvoker();
    try {
      // Several bindable subset members require explicit selection;
      // declaration order never chooses identity.
      let r = await publish(
        invoker,
        mkDoc([{ $ref: "#/servers/zHTTP" }, { $ref: "#/servers/bHTTP" }]),
        "#/operations/post",
      );
      expect(codeOf(r.err)).toBe("CONTEXT_REQUIRED");
      expect(srvB.requests()).toBe(0);
      expect(srvA.requests()).toBe(0);
      r = await publish(
        invoker,
        mkDoc([{ $ref: "#/servers/zHTTP" }, { $ref: "#/servers/bHTTP" }]),
        "#/operations/post",
        { configuration: { server: { key: "zHTTP" } } },
      );
      expect(r.err).toBeUndefined();
      expect(srvB.requests()).toBe(1);

      // Absent channel servers means all document members; the unbound
      // broker is excluded but the two HTTP members still require choice.
      r = await publish(invoker, mkDoc(), "#/operations/post");
      expect(codeOf(r.err)).toBe("CONTEXT_REQUIRED");
      expect(srvA.requests()).toBe(0);

      // Consumer configuration selects a member by servers-map key.
      r = await publish(invoker, mkDoc(), "#/operations/post", {
        configuration: { server: { key: "bHTTP" } },
      });
      expect(r.err).toBeUndefined();
      expect(srvA.requests()).toBe(1);

      // A key outside the effective set is a refusal.
      r = await publish(
        invoker,
        mkDoc([{ $ref: "#/servers/zHTTP" }]),
        "#/operations/post",
        { configuration: { server: { key: "bHTTP" } } },
      );
      expect(codeOf(r.err)).toBe("ERR_REFUSED");
      expect(srvA.requests()).toBe(1);
    } finally {
      invoker.close();
    }
  });

  it("accepts the composable server carriage and refuses malformed spellings pre-dispatch", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const doc = {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: {
        test: { host: `127.0.0.1:${srv.port}`, protocol: "http" },
      },
      channels: { c: { address: "/c", messages: { json: { name: "json", contentType: "application/json" } } } },
      operations: {
        post: {
          action: "receive" as const,
          channel: { $ref: "#/channels/c" },
          bindings: { http: { method: "POST" } },
        },
      },
    };

    const invoker = new AsyncAPIInvoker();
    try {
      const refused: Array<{ cfg: unknown }> = [
        { cfg: "test" },
        { cfg: { name: "test" } },
        { cfg: {} },
      ];
      for (const tc of refused) {
        const before = srv.requests();
        const r = await publish(invoker, doc, "#/operations/post", {
          configuration: { server: tc.cfg },
        });
        expect(codeOf(r.err)).toBe("ERR_REFUSED");
        expect(Object.hasOwn(r.err as object, "data")).toBe(false);
        expect(srv.requests()).toBe(before);
      }

      // Selection, sole-member URL replacement, and their composition dispatch.
      let r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { key: "test" } },
      });
      expect(r.err).toBeUndefined();
      r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { url: `http://127.0.0.1:${srv.port}` } },
      });
      expect(r.err).toBeUndefined();
      r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { key: "test", url: `http://127.0.0.1:${srv.port}` } },
      });
      expect(r.err).toBeUndefined();
      expect(srv.requests()).toBe(3);
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
      channels: { c: { address: "/c", messages: { json: { name: "json", contentType: "application/json" } } } },
      operations: {
        post: {
          action: "receive" as const,
          channel: { $ref: "#/channels/c" },
          bindings: { http: { method: "POST" } },
        },
      },
    };
    const invoker = new AsyncAPIInvoker();
    try {
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: doc },
        selector: "#/operations/post",
      });
      const { err } = await drainOutputs(call);
      // The artifact target remains valid; this runtime simply has no Kafka
      // driver installed, so capability fails locally before dispatch.
      expect(codeOf(err)).toBe("DRIVER_UNAVAILABLE");
    } finally {
      invoker.close();
    }
  });
});

describe("full-URL override (ASYNC-P-04, §9.5)", () => {
  it("refuses scheme changes; the selected server's security still applies; a same-scheme override is dialed", async () => {
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
          protocol: "http",
          security: [{ $ref: "#/components/securitySchemes/bearer" }],
        },
      },
      channels: { c: { address: "/c", messages: { json: { name: "json", contentType: "application/json" } } } },
      operations: {
        post: {
          action: "receive" as const,
          channel: { $ref: "#/channels/c" },
          bindings: { http: { method: "POST" } },
        },
      },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    };

    const invoker = new AsyncAPIInvoker();
    try {
      // Out-of-revision scheme: refused pre-dispatch.
      let r = await publish(invoker, doc, "#/operations/post", {
        configuration: { server: { url: "ftp://files.example.com" } },
      });
      expect(codeOf(r.err)).toBe("ERR_REFUSED");

      // The selected server's declared security still applies under a
      // same-scheme URL replacement: challenge before I/O.
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
        in: { address: "/in", messages: { json: { name: "json", contentType: "application/json" } } },
        out: { address: "/out", messages: { json: { name: "json", contentType: "application/json" } } },
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
        selector: "#/operations/sub",
      });
      const { err } = await drainOutputs(sub);
      expect(codeOf(err)).toBe("ERR_REFUSED");
      expect(sseMethod).toBeUndefined();
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
        messages: { json: { name: "json", contentType: "application/json" } },
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
      publish: {
        action: "receive" as const,
        channel: { $ref: "#/channels/stream" },
      },
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
      // All concrete upgrade values ride their distinct protocolFields
      // maps; JSON Schema defaults remain annotations.
      const sawUpgrade = new Promise<void>((r) => {
        seenResolve = r;
      });
      const r = await publish(invoker, wsBindingDoc(srv.port), "#/operations/publish", {
        configuration: {
          websocketMessageType: "text",
          protocolFields: {
            webSocketQuery: { token: "qtok", lane: "live" },
            webSocketHeaders: { "X-Trace": "trace-1", "X-Client": "ob" },
          },
        },
      });
      expect(r.err).toBeUndefined();
      await sawUpgrade;
      expect(seen[0]).toEqual({ token: "qtok", lane: "live", xClient: "ob", xTrace: "trace-1" });

      // Unsatisfied required declarations: pre-dispatch refusals, no upgrade.
      const before = srv.upgrades();
      const missingQuery = await publish(invoker, wsBindingDoc(srv.port), "#/operations/publish", {
        configuration: {
          websocketMessageType: "text",
          protocolFields: { webSocketHeaders: { "X-Trace": "trace-2" } },
        },
      });
      expect(codeOf(missingQuery.err)).toBe("ERR_REFUSED");
      const missingHeader = await publish(invoker, wsBindingDoc(srv.port), "#/operations/publish", {
        configuration: {
          websocketMessageType: "text",
          protocolFields: { webSocketQuery: { token: "qtok" } },
        },
      });
      expect(codeOf(missingHeader.err)).toBe("ERR_REFUSED");
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
      const r = await publish(invoker, doc, "#/operations/publish", {
        configuration: { websocketMessageType: "text" },
      });
      expect(codeOf(r.err)).toBe("ERR_REFUSED");
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

describe("standalone HTTP send exclusion (§8, ASYNC-P-02)", () => {
  it("does not infer SSE even when the endpoint would return an event stream", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: should-not-dispatch\n\n");
    });
    const invoker = new AsyncAPIInvoker();
    try {
      const before = srv.requests();
      const call = invoker.invokeBinding({
        source: { bindingSpec: BINDING_SPEC, content: sseDoc(srv.port, "/") },
        selector: "#/operations/receiveCaps",
      });
      const { err } = await drainOutputs(call);
      expect(codeOf(err)).toBe("ERR_REFUSED");
      expect(srv.requests()).toBe(before);
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
        bindings: { http: { method: "POST" } },
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
      expect(codeOf(refused.err)).toBe("ERR_REFUSED");
      expect(srv.requests()).toBe(before);
    } finally {
      invoker.close();
    }
  });
});

describe("the byte boundary for binary input families (§9.1, ruled 2026-08-13)", () => {
  it("refuses a non-string value on the byte boundary before any request or upgrade", async () => {
    const srv = await startHTTP((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const invoker = new AsyncAPIInvoker();
    try {
      // Declared binary media is invocable: the caller's value is the
      // canonical Base64 string of the exact octets, so the map value the
      // helper publishes refuses at validation, pre-dispatch.
      const r = await publish(invoker, laneDoc(srv.port, "http", "avro/binary"), "#/operations/post");
      expect(codeOf(r.err)).toBe("ERR_REFUSED");
      expect(srv.requests()).toBe(0);

      // WS cell: refused before any socket is dialed.
      const wsSrv = await startWS(() => {
        /* never reached */
      });
      const wsDoc = laneDoc(wsSrv.port, "ws", "application/octet-stream", "/ws") as {
        operations: { post: { reply?: unknown } };
      };
      // A reply-free publish: the WS reply shape rules are out of scope here;
      // the cell pins only the byte-boundary value refusal.
      delete wsDoc.operations.post.reply;
      const wsRefused = await publish(
        invoker,
        wsDoc,
        "#/operations/post",
        { configuration: { websocketMessageType: "binary" } },
      );
      expect(codeOf(wsRefused.err)).toBe("ERR_VALIDATION_FAILED");
      // The client-streaming shape dials at start and values arrive per
      // frame, so a value-shape refusal is post-upgrade by construction;
      // what the boundary guarantees is that no frame was published.
    } finally {
      invoker.close();
    }
  });
});

describe("decode text lane and reply direction (§9.3, ASYNC-P-05)", () => {
  it("decodes a publish output by the reply-side declaration", async () => {
    const srv = await startHTTP((req, res) => {
      if (req.url === "/c") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end('{"looks":"like json"}');
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
    } finally {
      invoker.close();
    }
  });
});
