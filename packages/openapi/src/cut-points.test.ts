import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OpenAPISynthesizer } from "./test-helpers.js";

/**
 * The cut-point case table is SHARED with the Go engine:
 * `testdata/cut-point-cases.json` is byte-identical to
 * `openbindings-go/formats/openapi/testdata/cut-point-cases.json`, and each case
 * pins the emission BOTH engines must produce. A divergence in either engine
 * therefore fails the other engine's suite, which is the only way this
 * obligation can be checked by execution rather than by reading two
 * implementations.
 *
 * WHICH nodes become cut points is the implementations' convention, stated in
 * full in `openbindings-go/formats/openapi/cut_points.go` and twinned in
 * `openapi-client/typescript/src/util.ts` (decycleSchema): the question is asked
 * about the graph a direction is about to emit, a cut point is a node the
 * artifact addressed that participates in a cycle there, and every participant
 * is hoisted.
 *
 * Both parameter cases declare `content` rather than `schema`. A cycle through
 * an object parameter requires a composite member, and a style-lane parameter
 * declaring one is excluded at synthesis
 * (styleLaneUndefinedExpansionMember in the client's `media.ts`), so the style
 * lane cannot carry a cyclic parameter at all. The content lane keeps the
 * cut-point question the cases exist to ask.
 */

interface CutPointCase {
  readonly name: string;
  readonly document: unknown;
  readonly expect: {
    readonly strict: string;
    readonly operations: Record<string, { input: unknown; output: unknown }>;
  };
}

const table = JSON.parse(
  readFileSync(new URL("./testdata/cut-point-cases.json", import.meta.url), "utf8"),
) as { cases: readonly CutPointCase[] };

/** Key order is not emission: compare the values, not the object literal. */
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(canonical);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

describe("cut-point case table (shared with the Go engine)", () => {
  it("covers every case the table declares", () => {
    expect(table.cases.length).toBe(16);
  });

  for (const testCase of table.cases) {
    it(testCase.name, async () => {
      const source = () => ({
        sources: [{
          bindingSpec: "openbindings.openapi-3.1@1",
          content: JSON.stringify(testCase.document),
        }],
      });

      const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage(source());
      const expected = testCase.expect.operations;
      expect(Object.keys(result.interface.operations).sort())
        .toEqual(Object.keys(expected).sort());
      for (const [key, sides] of Object.entries(expected)) {
        const op = result.interface.operations[key]!;
        expect(canonical(op.input ?? null)).toEqual(canonical(sides.input));
        expect(canonical(op.output ?? null)).toEqual(canonical(sides.output));
      }

      // The strict surface is where an unresolvable emitted `$ref` shows up: it
      // refuses the whole source at OBI-D-16.
      let strict = "accepted";
      try {
        await new OpenAPISynthesizer().synthesizeInterface(source());
      } catch {
        strict = "refused";
      }
      expect(strict).toBe(testCase.expect.strict === "accepted" ? "accepted" : "refused");
    });
  }
});
