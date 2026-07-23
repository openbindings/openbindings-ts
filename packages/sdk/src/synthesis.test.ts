import { describe, expect, it } from "vitest";
import { finalizeSynthesis, synthesisSkeleton } from "./invoker-types.js";
import type { OBInterface } from "./types.js";

describe("shared synthesis behavior", () => {
  it("returns a deterministic source-less scaffold", () => {
    expect(synthesisSkeleton({ name: "contract" })).toEqual({
      openbindings: "0.2.0",
      name: "contract",
      operations: {},
    });
  });

  it("refuses an invalid source-less target version", () => {
    expect(() => synthesisSkeleton({ openbindingsVersion: "not-semver" })).toThrow(/OBI-D-12/);
  });

  it("applies source directives, rewires bindings, and validates", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { run: {} },
      sources: { default: { bindingSpec: "example.spec@1", location: "https://old.example/spec" } },
      bindings: { "run.default": { operation: "run", source: "default", ref: "run" } },
    };
    expect(finalizeSynthesis(iface, {
      name: "contract",
      version: "v1",
      description: "interface description",
      sources: [{
        bindingSpec: "example.spec@1",
        name: "artifact",
        outputLocation: "https://published.example/spec",
        description: "source description",
      }],
    }, "default", "example.spec@1")).toMatchObject({
      name: "contract",
      version: "v1",
      description: "interface description",
      sources: { artifact: { location: "https://published.example/spec", description: "source description" } },
      bindings: { "run.default": { source: "artifact" } },
    });
  });

  it("rejects a different exact binding-specification identifier", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: {},
      sources: { default: { bindingSpec: "example.spec@1" } },
    };
    expect(() => finalizeSynthesis(iface, {
      sources: [{ bindingSpec: "example.spec@2" }],
    }, "default", "example.spec@1")).toThrow(/exact binding specification/);
  });
});
