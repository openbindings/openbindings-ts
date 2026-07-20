import { describe, it, expect } from "vitest";
import { resolveOperation, allOperationIdentifiers } from "./resolve-operation.js";
import type { OBInterface } from "./types.js";

function iface(operations: OBInterface["operations"]): OBInterface {
  return { openbindings: "0.2.0", operations };
}

describe("resolveOperation (OBI-T-12)", () => {
  it("resolves a direct key match to its own key", () => {
    const i = iface({ createTask: { description: "native" } });
    const r = resolveOperation(i, "createTask");
    expect(r?.key).toBe("createTask");
    expect(r?.operation.description).toBe("native");
  });

  it("resolves an alias to the operation's canonical key", () => {
    const i = iface({ createTask: { aliases: ["tasks.create"] } });
    const r = resolveOperation(i, "tasks.create");
    expect(r?.key).toBe("createTask");
  });

  it("returns undefined for an unknown name", () => {
    const i = iface({ createTask: { aliases: ["tasks.create"] } });
    expect(resolveOperation(i, "nope")).toBeUndefined();
  });

  it("treats key and alias matches with equal standing", () => {
    const i = iface({
      nativeThing: { description: "native" },
      otherThing: { aliases: ["sharedContract.do"] },
    });
    expect(resolveOperation(i, "nativeThing")?.key).toBe("nativeThing");
    expect(resolveOperation(i, "sharedContract.do")?.key).toBe("otherThing");
  });

  it("lists all identifiers sorted for diagnostics", () => {
    const i = iface({
      createTask: { aliases: ["tasks.create", "addTask"] },
      listTasks: {},
    });
    expect(allOperationIdentifiers(i)).toEqual([
      "addTask",
      "createTask",
      "listTasks",
      "tasks.create",
    ]);
  });

  // Prototype-chain hardening: a name that collides with a built-in object
  // property must resolve against the document's own operations map only,
  // never a Function inherited from Object.prototype. These names are valid
  // OBI-D-03 identifiers, so they reach the lookup.
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])(
    "returns undefined for the built-in property name %s when no such operation exists",
    (name) => {
      const i = iface({ createTask: {} });
      expect(resolveOperation(i, name)).toBeUndefined();
    },
  );

  it("still resolves an operation genuinely named constructor", () => {
    const i = iface({ constructor: { description: "a real operation" } });
    const r = resolveOperation(i, "constructor");
    expect(r?.key).toBe("constructor");
    expect(r?.operation.description).toBe("a real operation");
  });
});
