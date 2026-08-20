/**
 * TS side of the JSONata transform differential-conformance gate
 * (spec/conformance/transforms). The `agree/` corpus pins the NORMATIVE
 * jsonata-js output every conformant engine must reproduce; this runs each
 * agree case through jsonata-js (the engine the TS SDK uses) and asserts it
 * matches. It pins the TS side of the cross-SDK parity contract — a Go(gnata)
 * regression is caught by ob's Go gate, a TS regression (a jsonata upgrade or
 * config change) is caught here.
 *
 * The corpus ROOT is located via OB_SPEC_CORPUS, appending the `transforms`
 * subpath internally, matching the operationgraph corpus test. Skips when unset.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import jsonata from "jsonata";
import { describe, expect, it } from "vitest";

interface Outcome {
  status: "value" | "undefined" | "error";
  value?: unknown;
}
interface Case {
  id: string;
  expr: string;
  input: unknown;
  expected: Outcome;
}

function corpusDir(): string | null {
  const root = process.env.OB_SPEC_CORPUS;
  if (!root) return null;
  const base = basename(root) === "transforms" ? root : join(root, "transforms");
  const agree = join(base, "agree");
  return existsSync(agree) ? agree : null;
}

async function evalOutcome(expr: string, input: unknown): Promise<Outcome> {
  try {
    const result = await jsonata(expr).evaluate(input);
    if (result === undefined) return { status: "undefined" };
    return { status: "value", value: result };
  } catch {
    return { status: "error" };
  }
}

const dir = corpusDir();

// OB_CORPUS_REQUIRED (set in CI) turns a missing corpus into a hard failure
// so a mis-wired path or missing checkout turns CI red instead of silently
// green; unset (local dev) the suite still skips.
if (dir === null && process.env.OB_CORPUS_REQUIRED) {
  throw new Error(
    "transforms conformance corpus required (OB_CORPUS_REQUIRED is set) but not located; " +
      "set OB_SPEC_CORPUS to the spec repo's conformance dir",
  );
}

describe.skipIf(dir === null)("transform differential-conformance gate (agree)", () => {
  // skipIf marks the tests skipped, but this callback still RUNS at
  // collection time — without the corpus checkout the filesystem reads
  // below would crash the suite instead of skipping it.
  if (dir === null) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const cases: Case[] = files.flatMap(
    (f) => (JSON.parse(readFileSync(join(dir, f), "utf8")).cases ?? []) as Case[],
  );

  it("loaded agree cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`${c.id}: ${c.expr}`, async () => {
      const got = await evalOutcome(c.expr, c.input);
      expect(got.status).toBe(c.expected.status);
      if (c.expected.status === "value") {
        // Structural equality; JSON round-trip normalizes number/key shape.
        expect(JSON.parse(JSON.stringify(got.value))).toEqual(c.expected.value);
      }
    });
  }
});
