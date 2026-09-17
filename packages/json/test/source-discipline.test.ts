// Properties the brief states about the implementation that no table case
// can distinguish: the forced-string length check counts code points without
// allocating and stops at the declared length. Two checks that a comment
// cannot satisfy: the TypeScript AST of leaves.ts, and the behaviour of a
// force under spies on the allocating primitives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import ts from "typescript";
import * as json from "@openbindings/json";

const file = fileURLToPath(new URL("../src/leaves.ts", import.meta.url));

function walk(node: ts.Node, visit: (node: ts.Node) => void): void { visit(node); ts.forEachChild(node, child => walk(child, visit)); }

it("leaves.ts calls neither Array.from nor a spread over a string, and verifies with the bounded code-point count", () => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const arrayFrom: string[] = [], spreads: string[] = [], countCalls: number[] = [];
  walk(source, node => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (callee === "Array.from") arrayFrom.push(node.getText(source));
      if (callee === "codePointCount") countCalls.push(node.arguments.length);
    }
    if (ts.isSpreadElement(node) && ts.isArrayLiteralExpression(node.parent)) spreads.push(node.parent.getText(source));
  });
  expect(arrayFrom, "Array.from calls").toEqual([]);
  expect(spreads, "array spreads").toEqual([]);
  // The verification inside forceEncoded passes the declared length as the bound.
  expect(countCalls, "codePointCount call arities").toContain(2);
  expect(countCalls.filter(arity => arity < 2), "unbounded codePointCount calls").toEqual([]);
});

it("forcing an astral-heavy custom string allocates no array and never iterates the string", () => {
  const text = "😀".repeat(2000) + "é\ud800";
  const value = json.encoded(Uint8Array.of(1), { length: () => 2002, encode: () => text });
  const stringPrototype = String.prototype as unknown as Record<symbol, (this: string) => Iterator<string>>;
  const from = vi.spyOn(Array, "from"), iterator = vi.spyOn(stringPrototype, Symbol.iterator);
  try {
    expect(String(value)).toBe(text);
    expect(from, "Array.from during a force").not.toHaveBeenCalled();
    expect(iterator, "string iteration during a force").not.toHaveBeenCalled();
  } finally { from.mockRestore(); iterator.mockRestore(); }
});
