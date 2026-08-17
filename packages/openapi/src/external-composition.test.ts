import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { OpenAPISynthesizer } from "./invoker.js";
import { BINDING_SPEC } from "./constants.js";

/**
 * The external-composition case table is SHARED, byte for byte, with both Go
 * engines: `testdata/external-composition-cases.json` is identical to
 * `openbindings-go/formats/openapi/testdata/external-composition-cases.json`
 * and to `openapi-client/go/testdata/external-composition-cases.json`. Each
 * case is a multi-document artifact plus the one verdict every engine must
 * reach, so a divergence in either language fails the other's suite — the only
 * way this obligation can be checked by execution rather than by reading three
 * implementations.
 *
 * The rule under test is `openbindings.openapi@1` §6 ("Reference scope"): a
 * reference that leaves the current document composes the value at the
 * referenced JSON Pointer together with that value's transitive closure of
 * references, and nothing else.
 */
const CASES_DIGEST = "c0a90a4e410dccc0d456b6113387cf82989a9324f7c4ac4ba80b0bd58e5a8a2e";

interface CompositionDocument {
  readonly text?: string;
  readonly json?: unknown;
}

interface CompositionCase {
  readonly name: string;
  readonly why: string;
  readonly entry: string;
  readonly documents: Record<string, CompositionDocument>;
  readonly expect: {
    readonly outcome: "accepted" | "refused";
    readonly operations?: readonly string[];
    readonly values?: Record<string, unknown>;
    readonly defsAt?: string;
    readonly defs?: readonly string[];
    readonly unretrieved?: readonly string[];
    readonly messageContains?: readonly string[];
  };
}

const raw = readFileSync(
  new URL("./testdata/external-composition-cases.json", import.meta.url),
  "utf8",
);
const table = JSON.parse(raw) as { cases: readonly CompositionCase[] };

function evaluatePointer(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const token of pointer.replace(/^\//, "").split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe("external reference composition is pointer-scoped", () => {
  it("executes the same table the Go engines execute", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(CASES_DIGEST);
    expect(table.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of table.cases) {
    it(testCase.name, async () => {
      const retrieved = new Set<string>();
      const fetchFn: typeof globalThis.fetch = async (input) => {
        const address = input instanceof Request ? input.url : String(input);
        retrieved.add(address);
        const document = testCase.documents[address];
        if (document === undefined) {
          return new Response("no such document", { status: 404 });
        }
        const body = document.json !== undefined
          ? JSON.stringify(document.json)
          : document.text ?? "";
        return new Response(body, { status: 200 });
      };

      const synthesize = () =>
        new OpenAPISynthesizer({ fetch: fetchFn }).synthesizeInterface({
          sources: [{ bindingSpec: BINDING_SPEC, location: testCase.entry }],
        });

      if (testCase.expect.outcome === "refused") {
        let message: string | undefined;
        try {
          await synthesize();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message, `${testCase.why}: expected refusal`).toBeDefined();
        for (const fragment of testCase.expect.messageContains ?? []) {
          expect(message).toContain(fragment);
        }
        return;
      }

      const iface = await synthesize();

      if (testCase.expect.operations !== undefined) {
        expect(Object.keys(iface.operations ?? {}).sort())
          .toEqual([...testCase.expect.operations].sort());
      }
      for (const [pointer, expected] of Object.entries(testCase.expect.values ?? {})) {
        expect(evaluatePointer(iface, pointer), pointer).toEqual(expected);
      }
      if (testCase.expect.defsAt !== undefined) {
        const defs = evaluatePointer(iface, `${testCase.expect.defsAt}/$defs`);
        expect(defs, `no $defs at ${testCase.expect.defsAt}`).toBeTypeOf("object");
        expect(Object.keys(defs as Record<string, unknown>).sort())
          .toEqual([...(testCase.expect.defs ?? [])].sort());
      }
      for (const address of testCase.expect.unretrieved ?? []) {
        expect(retrieved.has(address), `${address} was retrieved`).toBe(false);
      }
    });
  }
});
