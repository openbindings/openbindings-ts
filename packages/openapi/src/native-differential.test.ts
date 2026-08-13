import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import jsonata from "jsonata";
import {
  CONTEXT_REQUIRED,
  OperationInvoker,
  operationSignature,
  type InvocationError,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/sdk";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";

const corpusRoot = process.env.OB_SPEC_CORPUS ?? resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../spec/conformance",
);
const corpus = JSON.parse(
  readFileSync(resolve(corpusRoot, "invocation-fidelity/openapi.json"), "utf8"),
) as ProcessorScenarioFile;

// This is the independent-client gate for the first OpenAPI fidelity slice.
// The native side uses Fetch against a real HTTP server; the OpenBindings side
// synthesizes the same artifact and invokes it through the operation layer.
// The native observation does not reuse the OpenAPI invoker's response decoder
// or failure-evidence builder.
describe("OpenAPI native-client differential", () => {
  for (const scenario of corpus.scenarios) {
    it(scenario.id, async () => {
      const peer = scenario.given.peer ?? {};
      const body = peerBody(peer);
      const server = createServer((_request, response) => {
        for (const [name, value] of Object.entries(peerHeaders(peer))) {
          if (typeof value === "string") response.setHeader(name, value);
        }
        response.statusCode = typeof peer.status === "number" ? peer.status : 599;
        response.end(body);
      });
      const baseURL = await listen(server);

      try {
        const { method, path } = nativeTarget(scenario);
        const nativeResponse = await fetch(`${baseURL}${path}`, { method, redirect: "manual" });
        const nativeBody = new Uint8Array(await nativeResponse.arrayBuffer());

        const content = artifactForServer(scenario, baseURL);
        const iface = await new OpenAPISynthesizer().synthesizeInterface({
          sources: [{ bindingSpec: corpus.bindingSpec, content }],
        });
        const call = new OperationInvoker([new OpenAPIInvoker()], {
          transformEvaluator: {
            evaluate: (expression, data) => jsonata(expression).evaluate(data),
          },
        }).invoke(
          iface,
          operationSignature(fidelityOperationId(content)),
          scenario.given.configuration
            ? { context: { configuration: scenario.given.configuration } }
            : undefined,
        );
        if (scenario.given.invocation.inputPresent === true) {
          await call.write(scenario.given.invocation.input).catch(() => {});
        } else {
          await call.close().catch(() => {});
        }
        const outputs: unknown[] = [];
        let terminal: InvocationError | undefined;
        try {
          for await (const output of call.outputs) outputs.push(output);
        } catch (error: unknown) {
          terminal = error as InvocationError;
        }

        const expectsContext = scenario.expected.some((alternative) => alternative.disposition === "context-required");
        if (expectsContext) {
          expect(terminal?.code).toBe(CONTEXT_REQUIRED);
          expect(outputs).toEqual([]);
          return;
        }

        const nativeSucceeded = nativeResponse.status >= 200 && nativeResponse.status < 300;
        if (nativeSucceeded) {
          expect(terminal).toBeUndefined();
          if (nativeBody.byteLength === 0) {
            expect(outputs).toEqual([]);
          } else {
            const complete = scenario.expected.find((alternative) => alternative.disposition === "complete");
            const outputAssertion = complete?.assertions.find((assertion) => assertion.path === "/outputs");
            expect(outputAssertion && "equals" in outputAssertion).toBe(true);
            expect(outputs).toEqual(outputAssertion && "equals" in outputAssertion
              ? outputAssertion.equals
              : undefined);
          }
          return;
        }

        expect(terminal).toBeDefined();
        expect(outputs).toEqual([]);
        expect(terminal?.code).toBe("ERR_EXECUTION_FAILED");
        expect(Object.hasOwn(terminal as object, "diagnostics")).toBe(false);
      } finally {
        await close(server);
      }
    });
  }

  it("preserves independent same-named path, query, and body values through revision 2", async () => {
    interface Observation {
      method: string;
      pathId: string;
      queryId: string;
      body: unknown;
    }
    const observations: Observation[] = [];
    const server = createServer(async (request, response) => {
      const body = await requestJSON(request);
      const url = new URL(request.url ?? "/", "http://openbindings.test");
      observations.push({
        method: request.method ?? "",
        pathId: url.pathname.replace("/items/", ""),
        queryId: url.searchParams.get("id") ?? "",
        body,
      });
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
    const baseURL = await listen(server);

    try {
      const nativeResponse = await fetch(`${baseURL}/items/path-value?id=query-value`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "body-value", name: "widget" }),
      });
      await nativeResponse.arrayBuffer();
      const want = observations[0];

      const content = {
        openapi: "3.1.0",
        info: { title: "collision", version: "1" },
        servers: [{ url: baseURL }],
        paths: {
          "/items/{id}": {
            post: {
              operationId: "createItem",
              parameters: [
                { name: "id", in: "path", required: true, description: "resource identifier", schema: { type: "string" } },
                { name: "id", in: "query", description: "request correlation identifier", schema: { type: "string" } },
              ],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string", description: "body identifier" },
                        name: { type: "string" },
                      },
                      required: ["id", "name"],
                    },
                  },
                },
              },
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { ok: { type: "boolean" } } },
                    },
                  },
                },
              },
            },
          },
        },
      };
      const iface = await new OpenAPISynthesizer().synthesizeInterface({
        sources: [{ bindingSpec: "openbindings.openapi@1", content }],
      });
      expect(iface.bindings?.["createItem.openapi"]?.inputTransform).toBeTypeOf("string");
      expect(Object.keys(
        (iface.operations.createItem?.input as { properties: Record<string, unknown> }).properties,
      ).sort()).toEqual(["id", "id_2", "id_3", "name"]);

      const invoker = new OperationInvoker([new OpenAPIInvoker()], {
        transformEvaluator: {
          evaluate: (expression, data) => jsonata(expression).evaluate(data),
        },
      });
      const call = invoker.invoke(iface, operationSignature("createItem"));
      await call.write({
        id: "path-value",
        id_2: "query-value",
        id_3: "body-value",
        name: "widget",
      });
      await call.close();
      const outputs: unknown[] = [];
      for await (const output of call.outputs) outputs.push(output);
      expect(outputs).toEqual([{ ok: true }]);
      expect(observations[1]).toEqual(want);
    } finally {
      await close(server);
    }
  });

  it("projects allOf multipart properties without inventing a body part", async () => {
    const content = {
      openapi: "3.0.3",
      info: { title: "multipart allOf", version: "1" },
      servers: [{ url: "https://upload.example.test" }],
      paths: {
        "/upload": {
          post: {
            operationId: "uploadAllOf",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    allOf: [
                      {
                        type: "object",
                        properties: {
                          transaction: { type: "string" },
                          fileName: { type: "string" },
                        },
                        required: ["transaction", "fileName"],
                      },
                      {
                        type: "object",
                        properties: { file: { type: "string", format: "binary" } },
                        required: ["file"],
                      },
                    ],
                  },
                },
              },
            },
            responses: { "204": { description: "done" } },
          },
        },
      },
    };
    const iface = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: "openbindings.openapi@1", content }],
    });
    const input = iface.operations.uploadAllOf?.input as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(input.properties ?? {}).sort()).toEqual(["file", "fileName", "transaction"]);
    expect(input.properties).not.toHaveProperty("body");
    expect(input.required?.sort()).toEqual(["file", "fileName", "transaction"]);

    const observed: Record<string, FormDataEntryValue> = {};
    const fetch = async (requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(requestInput, init);
      expect(request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
      const form = await request.formData();
      form.forEach((value, name) => { observed[name] = value; });
      return new Response(null, { status: 204 });
    };
    const call = new OperationInvoker([new OpenAPIInvoker()], { fetch }).invoke(
      iface,
      operationSignature("uploadAllOf"),
    );
    await call.write({ transaction: "tx-1", fileName: "a.bin", file: "AQID" });
    await call.close();
    const outputs: unknown[] = [];
    for await (const output of call.outputs) outputs.push(output);
    expect(outputs).toEqual([]);
    expect(observed.transaction).toBe("tx-1");
    expect(observed.fileName).toBe("a.bin");
    expect(observed).not.toHaveProperty("body");
    expect(observed.file).toBeInstanceOf(File);
    expect(Array.from(new Uint8Array(await (observed.file as File).arrayBuffer()))).toEqual([1, 2, 3]);
  });
});

async function requestJSON(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function artifactForServer(scenario: ProcessorScenario, baseURL: string): Record<string, unknown> {
  const content = structuredClone(scenario.given.source.content) as Record<string, unknown>;
  content.servers = [{ url: baseURL }];
  return content;
}

function nativeTarget(scenario: ProcessorScenario): { method: string; path: string } {
  const ref = String(scenario.given.binding.ref ?? "");
  const prefix = "#/paths/";
  if (!ref.startsWith(prefix)) throw new Error(`${scenario.id} is outside the bounded paths-operation slice`);
  const parts = ref.slice(prefix.length).split("/");
  if (parts.length !== 2) throw new Error(`${scenario.id} does not identify one paths operation`);
  return {
    method: parts[1]!.toUpperCase(),
    path: parts[0]!.replaceAll("~1", "/").replaceAll("~0", "~"),
  };
}

function fidelityOperationId(content: unknown): string {
  const document = content as { paths?: Record<string, Record<string, { operationId?: unknown }>> };
  for (const path of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(path)) {
      if (typeof operation.operationId === "string") return operation.operationId;
    }
  }
  throw new Error("fidelity artifact omits operationId");
}

function peerHeaders(peer: Record<string, unknown>): Record<string, unknown> {
  const headers = peer.headers;
  return headers !== null && typeof headers === "object" && !Array.isArray(headers)
    ? headers as Record<string, unknown>
    : {};
}

function peerBody(peer: Record<string, unknown>): Uint8Array | string {
  if (typeof peer.bodyBase64 === "string") return Buffer.from(peer.bodyBase64, "base64");
  return typeof peer.body === "string" ? peer.body : "";
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}
