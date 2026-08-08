import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OperationInvoker,
  operationSignature,
  type InvocationError,
  type ProcessorScenario,
  type ProcessorScenarioFile,
} from "@openbindings/sdk";
import { openAPIFailureEvidence } from "./failure.js";
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
        const call = new OperationInvoker([new OpenAPIInvoker()]).invoke(
          iface,
          operationSignature(fidelityOperationId(content)),
        );
        await call.close().catch(() => {});
        const outputs: unknown[] = [];
        let terminal: InvocationError | undefined;
        try {
          for await (const output of call.outputs) outputs.push(output);
        } catch (error: unknown) {
          terminal = error as InvocationError;
        }

        const nativeSucceeded = nativeResponse.status >= 200 && nativeResponse.status < 300;
        if (nativeSucceeded) {
          expect(terminal).toBeUndefined();
          const nativeValue = JSON.parse(new TextDecoder().decode(nativeBody)) as unknown;
          expect(outputs).toEqual([nativeValue]);
          return;
        }

        expect(terminal).toBeDefined();
        expect(outputs).toEqual([]);
        const evidence = openAPIFailureEvidence(terminal);
        expect(evidence).not.toBeNull();
        expect(evidence?.httpResponse.status).toBe(nativeResponse.status);
        expect(Array.from(evidence?.httpResponse.body ?? [])).toEqual(Array.from(nativeBody));
        for (const name of Object.keys(peerHeaders(peer))) {
          expect(evidence?.httpResponse.headers[name.toLowerCase()]).toEqual([
            nativeResponse.headers.get(name),
          ]);
        }
      } finally {
        await close(server);
      }
    });
  }
});

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
