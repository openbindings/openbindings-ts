import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AsyncAPIInvoker } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

// The address configuration point's refusal (ASYNC-P-04): an absent or null
// channel `address` with no consumer-supplied address is a PRE-DISPATCH
// refusal — this specification does not assume the channel key is an
// address, never a guess. (Flipped from the pre-conformance channel-name
// fallback this test used to pin.) A consumer-supplied concrete address at
// the configuration point proceeds. Mirrors the Go SDK's
// TestChannelWithoutAddressIsRefusedPreDispatch.
describe("channel without address", () => {
  let server: Server;
  let port: number;
  let requests = 0;
  let gotPath: string | undefined;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        requests++;
        gotPath = req.url;
        res.writeHead(202);
        res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
  });

  function spec() {
    return {
      asyncapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      servers: { test: { host: `127.0.0.1:${port}`, protocol: "http" } },
      // Deliberately no `address` on the channel.
      channels: { notify: { messages: { Msg: { contentType: "application/json" } } } },
      operations: {
        notifyOp: {
          action: "receive" as const,
          channel: { $ref: "#/channels/notify" },
          bindings: { http: { method: "POST" } },
        },
      },
    };
  }

  it("is refused pre-dispatch: an absent address is never guessed from the channel name", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec() },
      ref: "#/operations/notifyOp",
    });
    await call.write({}).catch(() => {});
    await call.close().catch(() => {});
    // R1a: AsyncAPI's absent (runtime-generated) address is resolvable by
    // consumer supply — a config.value CONTEXT_REQUIRED (address point,
    // non-durable), not a terminal ERR_SOURCE_CONFIG_ERROR.
    await expect(call.closed).rejects.toMatchObject({
      code: "CONTEXT_REQUIRED",
      data: {
        alternatives: [{ requirements: [{ type: "config.value", point: "address", path: "", durable: false }] }],
      },
    });
    expect(requests).toBe(0);
  });

  it("proceeds when the consumer supplies the concrete address at the configuration point", async () => {
    const invoker = new AsyncAPIInvoker();
    const call = invoker.invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: spec() },
      ref: "#/operations/notifyOp",
      context: { configuration: { address: "/inbox" } },
    });
    await call.write({});
    await call.close();
    await call.closed;

    expect(gotPath).toBe("/inbox");
  });
});
