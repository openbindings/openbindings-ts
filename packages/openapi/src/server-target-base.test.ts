import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";
import { ConfigRequired, resolveServer } from "./servers.js";

// The `requirements` half of the shared server target-base case table. The
// resolution and predicate halves are executed by the engine that owns
// resolveServer (openapi-client/typescript, which this package re-exports) and
// by the two Go twins; what only a synthesizing engine can execute is what the
// coverage entry EMITS, which is the field the nhost/nhost and nixopus/nixopus
// corpus mismatch was measured in.
//
// The file is byte-identical to the copies in
// openbindings-go/formats/openapi/testdata, openapi-client/go/testdata and
// openapi-client/typescript/src/testdata.
const serverTargetBaseCasesDigest = "ddb3478b583c694a707a6f1316329809c3ebf560a0d5275a1adf11ff3fb6b1da";

interface ResolutionCase {
  name: string;
  openapi: string;
  rootServers: Record<string, unknown>[] | null;
  operationServers: Record<string, unknown>[] | null;
  expect: { resolvable: boolean; targetBase: string | null };
  outcomeClass: string;
  requirements: string[];
  basis: string;
}

function loadTable(): { resolutionCases: ResolutionCase[] } {
  const path = fileURLToPath(new URL("./testdata/server-target-base-cases.json", import.meta.url));
  const raw = readFileSync(path);
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== serverTargetBaseCasesDigest) {
    throw new Error(
      `case table digest = ${digest}, want ${serverTargetBaseCasesDigest} (the table is shared byte-for-byte with the three twin engines)`,
    );
  }
  return JSON.parse(raw.toString("utf8"));
}

const table = loadTable();

function caseDocument(c: ResolutionCase): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: "listThings",
    responses: { "200": { description: "ok" } },
  };
  if (c.operationServers !== null) operation["servers"] = c.operationServers;
  const document: Record<string, unknown> = {
    openapi: c.openapi,
    info: { title: "server target base case table", version: "1.0.0" },
    paths: { "/things": { get: operation } },
  };
  if (c.rootServers !== null) document["servers"] = c.rootServers;
  return document;
}

// The re-exported half. This package does not own resolveServer -- it
// re-exports openapi-client/typescript's, resolved to that package's BUILT
// `dist` -- so this block proves the outcome class survives the re-export and
// that the dist in use is not stale. openbindings.openapi@1 Section 9.3
// partitions the two unsuccessful classes: a missing selection from a
// multi-entry list is "the retryable context challenge above, never a terminal
// refusal" (ConfigRequired), while an unresolvable server URL "is a
// pre-dispatch refusal" (an ordinary error). OAPI-P-05 restates the second.
describe("server target base: re-exported outcome class", () => {
  for (const c of table.resolutionCases) {
    it(c.name, () => {
      const doc = caseDocument(c);
      const pathItem = (doc as { paths: Record<string, unknown> }).paths["/things"];
      const op = (pathItem as { get: unknown }).get;
      let observed = "resolved";
      try {
        resolveServer(doc as never, pathItem as never, op as never, undefined, undefined);
      } catch (error: unknown) {
        observed = error instanceof ConfigRequired ? "retryable-context" : "refusal";
      }
      expect(observed, `${c.name}\nbasis: ${c.basis}`).toBe(c.outcomeClass);
    });
  }
});

describe("server target base: emitted coverage requirements", () => {
  for (const c of table.resolutionCases) {
    it(c.name, async () => {
      const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
        sources: [{ bindingSpec: BINDING_SPEC, content: caseDocument(c) }],
      });
      const entry = result.coverage.entries.find(
        (e) => e.sourceRef === "#/paths/~1things/get" && e.scope === "target",
      );
      expect(entry, `${c.name}: no target coverage entry`).toBeDefined();
      expect(entry?.requirements ?? [], `${c.name}\nbasis: ${c.basis}`).toEqual(c.requirements);
    });
  }
});
