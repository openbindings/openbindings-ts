// stringify, equal and plain have no Limits parameter and cap depth at the
// default 512, so nesting alone cannot exhaust the engine's stack inside
// them. Put each walk under genuine stack pressure instead: recurse the
// test's own frames until the engine overflows inside a 512-deep walk, and
// assert the escaping error is the converted ERR_JSON_BUDGET engine-stack.
// Removing `guarded` at any of the three call sites lets the raw RangeError
// escape and fails the named assertion below.
import { expect, it } from "vitest";
import * as json from "@openbindings/json";

function nest(depth: number): unknown { let value: unknown = 0; for (let i = 0; i < depth; i++) value = [value]; return value; }
const deep = nest(512) as json.Value, twin = nest(512) as json.Value;

/** Runs `operation` after `depth` extra frames. Distinguishes an overflow
 * inside the operation (returned) from one in the scaffolding (rethrown). */
function runAtDepth(depth: number, operation: () => unknown): { inside: boolean; error?: unknown } {
  let error: unknown, thrown = false;
  function recurse(remaining: number): void {
    if (remaining === 0) { try { operation(); } catch (caught) { error = caught; thrown = true; } return; }
    recurse(remaining - 1);
  }
  try { recurse(depth); } catch (caught) { return { inside: false, error: caught }; }
  return thrown ? { inside: true, error } : { inside: true };
}

/** The error that escapes `operation` when the engine's stack runs out inside it. */
function underStackPressure(operation: () => unknown): unknown {
  for (let depth = 0; depth < 1_000_000; depth += 200) {
    const result = runAtDepth(depth, operation);
    if (!result.inside) throw new Error("the scaffolding overflowed before the walk did");
    if (result.error !== undefined) return result.error;
  }
  throw new Error("no overflow reached");
}

function expectEngineLimit(escaped: unknown, site: string): void {
  expect(escaped, `${site}: the escaping error`).toBeInstanceOf(json.ValueError);
  const error = escaped as json.ValueError;
  expect(error.code, `${site}: code`).toBe("ERR_JSON_BUDGET");
  expect(error.details?.reason, `${site}: details.reason`).toBe("engine-stack");
  expect(error.cause, `${site}: cause`).toBeInstanceOf(RangeError);
}

it("stringify reports the engine's own stack limit as ERR_JSON_BUDGET engine-stack", () => {
  expectEngineLimit(underStackPressure(() => json.stringify(deep)), "stringify");
});

it("equal reports the engine's own stack limit as ERR_JSON_BUDGET engine-stack", () => {
  expectEngineLimit(underStackPressure(() => json.equal(deep, twin)), "equal");
});

it("plain reports the engine's own stack limit as ERR_JSON_BUDGET engine-stack", () => {
  expectEngineLimit(underStackPressure(() => json.plain(deep)), "plain");
});
