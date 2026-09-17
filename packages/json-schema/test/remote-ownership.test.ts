import { describe, expect, it } from "vitest";
import * as json from "@openbindings/json";
import { compile, compileSchema } from "@openbindings/json-schema";
import type { CompileOptions } from "@openbindings/json-schema";

describe("raw remote schema ownership", () => {
  it("snapshots a raw remote before an asynchronous consumer resumes", async () => {
    const remote = { $id: "https://ownership.invalid/bound", type: "number", maximum: 1 };
    const schema = compile({ $ref: remote.$id }, { remotes: [remote] });
    expect(schema.validate(2).valid).toBe(false);
    await Promise.resolve();
    remote.maximum = 3;
    expect(schema.validate(2).valid).toBe(false);
  });

  it("owns nested constraints and the remote list, including shared subgraphs", () => {
    const constraint = { type: "number", maximum: 1 };
    const remote = { $id: "https://ownership.invalid/object", properties: { a: constraint, b: constraint } };
    const remotes = [remote];
    const schema = compile({ $ref: remote.$id }, { remotes });
    constraint.maximum = 4;
    remotes.splice(0, 1);
    expect(schema.validate({ a: 2, b: 2 }).valid).toBe(false);
    expect(schema.validate({ a: 1, b: 1 }).valid).toBe(true);
  });

  it("owns a transitive remote and keeps exact constraints", () => {
    const bound = { $id: "https://ownership.invalid/decimal", type: "number", maximum: json.number("0.3"), multipleOf: json.number("0.1") };
    const alias = { $id: "https://ownership.invalid/alias", $ref: bound.$id };
    const schema = compile({ $ref: alias.$id }, { remotes: [alias, bound] as unknown as CompileOptions["remotes"] });
    const inline = compile({ type: "number", maximum: json.number("0.3"), multipleOf: json.number("0.1") });
    bound.maximum = json.number("0.5");
    for (const text of ["0.2", "0.3", "0.4", "0.25"]) {
      expect(schema.validate(json.number(text)).valid).toBe(inline.validate(json.number(text)).valid);
    }
  });

  it("rejects schema accessors before reading an id or constraint", () => {
    for (const key of ["$id", "maximum"]) {
      let calls = 0;
      const remote = Object.defineProperty({ $id: "https://ownership.invalid/accessor" }, key, { enumerable: true, get() { calls++; return 1; } });
      expect(() => compile({}, { remotes: [remote] })).toThrow(json.ValueError);
      expect(calls).toBe(0);
    }
  });

  it("retains explicit precompiled live registry behavior and precedence", () => {
    const live = compileSchema({ $id: "https://ownership.invalid/root" });
    live.addRemoteSchema("https://ownership.invalid/live", { type: "number", maximum: 1 });
    const schema = compile({ $ref: "https://ownership.invalid/live" }, { remote: live, remotes: [{ $id: "https://ownership.invalid/live", maximum: 9 }] });
    expect(schema.validate(2).valid).toBe(false);
    live.addRemoteSchema("https://ownership.invalid/live", { type: "number", maximum: 3 });
    expect(schema.validate(2).valid).toBe(true);
  });

  it("keeps missing id and unresolvable reference errors", () => {
    expect(() => compile({}, { remotes: [{ type: "number" }] })).toThrow("required $id");
    expect(() => compile({ $ref: "https://ownership.invalid/missing" }).validate(1)).toThrow("Could not resolve");
  });
});
