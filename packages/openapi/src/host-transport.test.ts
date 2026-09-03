import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ERR_REFUSED, type InvocationError } from "@openbindings/invoke";
import { OpenAPIInvoker } from "./invoker.js";

// The shipped path with NO injected fetch: the adapter's default transport is
// the standalone engine's, which routes the methods the WHATWG fetch API
// forbids (CONNECT, TRACE, TRACK) through the host HTTP client on Node and
// refuses before dispatch a method no available transport sends byte-exactly.
// A fetch double cannot exercise this — the platform refuses these methods
// before any transport is called — so the peer is a real local server.

interface Seen {
  method: string;
  url: string;
  headers: string[];
}

let server: Server;
let base = "";
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.rawHeaders });
      res.writeHead(204);
      res.end();
    });
  });
  server.on("connect", (req, socket) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.rawHeaders });
    socket.end("HTTP/1.1 204 No Content\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  seen.length = 0;
});

const BINDING_SPECS: Record<string, string> = {
  "3.0.3": "openbindings.openapi-3.0@1",
  "3.1.0": "openbindings.openapi-3.1@1",
  "3.2.0": "openbindings.openapi-3.2@1",
};

function document(version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi: version,
    info: { title: "fetch-forbidden methods", version: "1" },
    servers: [{ url: base }],
    paths: {
      "/t": {
        trace: {
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "204": { description: "ok" } },
        },
        ...extra,
      },
    },
  };
}

async function invoke(version: string, selector: string, content: Record<string, unknown>): Promise<InvocationError | null> {
  const call = new OpenAPIInvoker().invokeBinding({
    source: { bindingSpec: BINDING_SPECS[version]!, content },
    selector,
    context: {},
  });
  await call.close();
  try {
    for await (const _ of call.outputs) {
      // drain
    }
    return null;
  } catch (error: unknown) {
    return error as InvocationError;
  }
}

function headerNames(entry: Seen): string[] {
  return entry.headers.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
}

describe("OpenAPIInvoker default transport and the methods fetch cannot carry", () => {
  for (const version of ["3.0.3", "3.1.0", "3.2.0"]) {
    it(`dispatches a body-free trace target on ${version} as TRACE with no body and no Content-Type`, async () => {
      expect(await invoke(version, "#/paths/~1t/trace", document(version))).toBeNull();
      expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(["TRACE /t"]);
      expect(headerNames(seen[0]!)).not.toContain("content-type");
      expect(headerNames(seen[0]!)).not.toContain("content-length");
    });
  }

  it("dispatches an additional CONNECT operation on 3.2 through the host HTTP client", async () => {
    const content = document("3.2.0", {
      additionalOperations: { CONNECT: { responses: { "204": { description: "ok" } } } },
    });
    expect(await invoke("3.2.0", "#/paths/~1t/additionalOperations/CONNECT", content)).toBeNull();
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual(["CONNECT /t"]);
  });

  it("refuses before dispatch, as the family's plain pre-dispatch refusal, a method no host transport sends byte-exactly", async () => {
    const content = document("3.2.0", {
      additionalOperations: { post: { responses: { "204": { description: "ok" } } } },
    });
    const error = await invoke("3.2.0", "#/paths/~1t/additionalOperations/post", content);
    // The portable fact at the SDK boundary is the code and that nothing was
    // dispatched; the engine's own tests pin the message naming the limit.
    expect(error?.code).toBe(ERR_REFUSED);
    expect(seen).toHaveLength(0);
  });
});
