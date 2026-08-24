// Binding-specification conformance corpus adapter. GrpcInvoker owns selector and
// dial-address parsing; the injected runtime owns the same embedded-schema
// load and byte-exact method-resolution lane as a real runtime. A sentinel
// resolution error marks accepted material without dialing a server.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BINDING_SPEC,
  GrpcInvoker,
  loadProtobufSchema,
  type GrpcRuntime,
} from "./index.js";

interface CorpusFixture {
  rule: string;
  bindingSpec: string;
  tests: Array<{ description: string; document: CorpusDocument; valid: boolean }>;
}

interface CorpusDocument {
  sources?: Record<string, CorpusSource>;
  bindings?: Record<string, CorpusBinding>;
}

interface CorpusSource {
  bindingSpec?: string;
  location?: string;
  content?: unknown;
}

interface CorpusBinding {
  operation?: string;
  source?: string;
  selector?: string;
}

const accepted = "OPENBINDINGS_CORPUS_ACCEPTED";
const root = process.env.OB_SPEC_CORPUS
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../spec/conformance");
const dir = join(root, "binding-specs/grpc");
const available = existsSync(dir);

if (!available && process.env.OB_CORPUS_REQUIRED) {
  throw new Error("gRPC binding-spec corpus is required but unavailable; set OB_SPEC_CORPUS");
}

async function judge(document: CorpusDocument): Promise<string | undefined> {
  for (const [sourceName, source] of Object.entries(document.sources ?? {})) {
    if (source.bindingSpec !== BINDING_SPEC) continue;
    for (const binding of Object.values(document.bindings ?? {})) {
      if (binding.source !== sourceName) continue;
      const location = source.location;
      const explicitTransport = typeof location === "string" && /^(?:grpc|grpcs):\/\//u.test(location);
      let resolved = false;
      const runtime: GrpcRuntime = {
        async resolveMethod(args) {
          if (args.content !== undefined) {
            const schema = loadProtobufSchema(args.content);
            const service = schema.lookupService(args.service);
            if (!service.methods[args.method]) {
              throw new Error(`method ${args.service}/${args.method} not found in embedded schema`);
            }
          }
          resolved = true;
          throw new Error(accepted);
        },
        openCall() {
          throw new Error("corpus adapter must never open a gRPC call");
        },
      };
      const call = new GrpcInvoker({ runtime }).invokeBinding({
        source: {
          bindingSpec: BINDING_SPEC,
          ...(Object.hasOwn(source, "location") ? { location } : {}),
          ...(Object.hasOwn(source, "content") ? { content: source.content } : {}),
        },
        selector: binding.selector ?? "",
        binding: {
          operation: binding.operation ?? "fixture",
          source: sourceName,
          ...(Object.hasOwn(binding, "selector") ? { selector: binding.selector } : {}),
        },
        // A bare host:port intentionally leaves transport to consumer
        // configuration (GRPC-P-02). Supply one so this D-rule adapter can
        // judge the address itself without inventing a family default.
        ...(!explicitTransport ? { context: { configuration: { transport: "plaintext" } } } : {}),
      });
      await call.close().catch(() => {});
      try {
        for await (const _ of call.outputs) {
          // Resolution always terminates at the sentinel.
        }
        return "gRPC invocation completed without reaching sentinel resolution";
      } catch (error: unknown) {
        if (!resolved) return String(error);
      }
    }
  }
  return undefined;
}

describe.skipIf(!available)("binding-spec conformance corpus (grpc)", () => {
  if (!available) return;
  const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as CorpusFixture;
    expect(fixture.bindingSpec).toBe(BINDING_SPEC);
    describe(fixture.rule, () => {
      for (const test of fixture.tests) {
        it(test.description, async () => {
          const refusal = await judge(test.document);
          if (test.valid && refusal !== undefined) {
            expect.fail(`valid fixture refused: ${refusal}`);
          }
          if (!test.valid && refusal === undefined) {
            expect.fail("invalid fixture accepted");
          }
        });
      }
    });
  }
});
