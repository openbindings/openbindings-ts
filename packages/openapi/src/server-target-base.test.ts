import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

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
const serverTargetBaseCasesDigest = "808708805f527a21c4e5012640245238637934e22dd177c3b5787f4f3eec7e5b";

interface ResolutionCase {
  name: string;
  openapi: string;
  rootServers: Record<string, unknown>[] | null;
  operationServers: Record<string, unknown>[] | null;
  expect: { resolvable: boolean; targetBase: string | null };
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

describe("server target base: emitted coverage requirements", () => {
  for (const c of table.resolutionCases) {
    it(c.name, async () => {
      const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
        sources: [{ bindingSpec: BINDING_SPEC, content: caseDocument(c) }],
      });
      const entry = result.coverage.entries.find(
        (e) => e.sourceSelector === "#/paths/~1things/get" && e.scope === "target",
      );
      expect(entry, `${c.name}: no target coverage entry`).toBeDefined();
      expect(entry?.requirements ?? [], `${c.name}\nbasis: ${c.basis}`).toEqual(c.requirements);
    });
  }
});
