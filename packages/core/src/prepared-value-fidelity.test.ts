import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@openbindings/json";
import { prepareInterface, compareBoundaryContracts } from "./prepared-interface.js";
import type { OBInterface } from "./types.js";

// Official SDK qualification, not a general Core-conformance suite. The
// comparison-profile cases supply authored point witnesses; they do not
// themselves impose snapshot requirements on third-party implementations.
type Case = {
  id: string;
  direction: "input" | "output";
  leftJSON: string;
  rightJSON: string;
  witness?: { instanceJSON: string; targetValid: boolean; candidateValid: boolean };
};
const dir = process.env.OB_INTERFACES_CORPUS ?? resolve(
  dirname(fileURLToPath(import.meta.url)), "../../../../interfaces/conformance",
);
const path = join(dir, "comparison/exact-values.json");
if (!existsSync(path) && process.env.OB_CORPUS_REQUIRED) {
  throw new Error("official SDK exact-snapshot qualification corpus required but absent");
}
const pack = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
if (pack && (pack.scope !== "comparison-profile" || pack.profile !== "OB-2020-12"
  || pack.profileVersion !== "0.1" || !pack.cases.length)) {
  throw new Error("invalid fixture pack");
}
describe.skipIf(!pack)("official SDK qualification — exact snapshots (not Core)", () => {
  for (const c of (pack?.cases ?? []) as Case[]) {
    if (!c.witness) continue;
    const witness = c.witness;
    const sides = [
      ["target", c.leftJSON, witness.targetValid],
      ["candidate", c.rightJSON, witness.candidateValid],
    ] as const;
    for (const [side, raw, want] of sides) it(c.id + "/" + side, async () => {
      const iface = parse(raw) as unknown as OBInterface;
      const sample = parse(witness.instanceJSON);
      const prepared = await prepareInterface(iface);
      const validator = prepared.schemaValidator("test", c.direction);
      expect(validator).toBeDefined();
      expect(validator!.validate(sample).valid).toBe(want);
    });
  }
});

describe.skipIf(!pack)("official SDK qualification — authored identity and local cache (not Core)", () => {
  const identities: Record<string, boolean> = {
    "structural-wide-difference": false,
    "structural-equivalent-spelling": true,
    "union-permutation": false, // authored array order matters, unlike profile identity
    "object-member-order": true,
  };
  for (const c of (pack?.cases ?? []) as Case[]) {
    if (!(c.id in identities)) continue;
    it(c.id, async () => {
      const boundary = async (raw: string) => {
        const prepared = await prepareInterface(parse(raw) as unknown as OBInterface);
        const before = prepared.schemaValidator("test", c.direction);
        const contract = await prepared.boundaryContract("test")!;
        expect(contract.complete).toBe(true);
        expect(prepared.schemaValidator("test", c.direction)).toBe(before);
        return contract;
      };
      const a = await boundary(c.leftJSON), b = await boundary(c.rightJSON);
      expect(compareBoundaryContracts(a, b)).toBe(identities[c.id] ? "equal" : "different");
    });
  }
});
