import { describe, expect, it } from "vitest";
import {
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  representedCoverageEntries,
  synthesisSkeleton,
} from "./synthesizer-types.js";
import type { OBInterface } from "@openbindings/core";

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
      bindings: { "run.default": { operation: "run", source: "default", selector: "run" } },
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

  it("derives durable full-coverage state from dispositions", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { getUser: {} },
      sources: { api: { bindingSpec: "example.spec@1", location: "https://example.com/spec" } },
      bindings: { "getUser.api": { operation: "getUser", source: "api", selector: "#/getUser" } },
    };
    const result = finalizeSynthesisCoverage(iface, [
      {
        sourceIndex: 0,
        sourceSelector: "#/getUser",
        scope: "target",
        status: "represented",
        operationKey: "getUser",
        bindingSelector: "#/getUser",
      },
      {
        sourceIndex: 0,
        sourceSelector: "#/callbacks/onUser",
        scope: "target",
        status: "excluded",
        reasonCode: "example.reverse_direction",
        rule: "EXAMPLE-P-07",
        message: "reverse-direction callbacks are outside revision 1",
      },
    ], true);
    expect(result.coverage).toMatchObject({
      exhaustive: true,
      fullyRepresented: false,
    });
    expect(result.coverage.entries[0]).toMatchObject({
      sourceKey: "api",
      bindingKey: "getUser.api",
    });
  });

  // An invalid entry clears fullyRepresented exactly like every other
  // non-represented status: an upstream-invalid unit is still an inventoried
  // unit the emitted OBI does not represent. Pinned by MC5 seal-1 finding
  // F-V3-1, where a document whose every target was invalid reported
  // fullyRepresented true.
  it("clears fullyRepresented when any entry is invalid", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { getUser: {} },
      sources: { api: { bindingSpec: "example.spec@1", location: "https://example.com/spec" } },
      bindings: { "getUser.api": { operation: "getUser", source: "api", selector: "#/getUser" } },
    };
    const result = finalizeSynthesisCoverage(iface, [
      {
        sourceIndex: 0,
        sourceSelector: "#/getUser",
        scope: "target",
        status: "represented",
        operationKey: "getUser",
        bindingSelector: "#/getUser",
      },
      {
        sourceIndex: 0,
        sourceSelector: "#/operations/broken",
        scope: "target",
        status: "invalid",
        reasonCode: "example.invalid_target",
        rule: "EXAMPLE-D-03",
        message: "the target does not resolve to an operation object",
      },
    ], true);
    expect(result.coverage.exhaustive).toBe(true);
    expect(result.coverage.fullyRepresented).toBe(false);
  });

  it("rejects represented coverage without a matching binding", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { getUser: {} },
      sources: { api: { bindingSpec: "example.spec@1", location: "https://example.com/spec" } },
      bindings: { "getUser.api": { operation: "getUser", source: "api", selector: "#/getUser" } },
    };
    expect(() => finalizeSynthesisCoverage(iface, [{
      sourceIndex: 0,
      sourceSelector: "#/missing",
      scope: "target",
      status: "represented",
      operationKey: "getUser",
      bindingSelector: "#/missing",
    }], true)).toThrow(/no matching binding/);
  });

  it("never describes a non-exhaustive report as fully represented", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { getUser: {} },
      sources: { api: { bindingSpec: "example.spec@1", location: "https://example.com/spec" } },
      bindings: { "getUser.api": { operation: "getUser", source: "api", selector: "#/getUser" } },
    };
    const result = finalizeSynthesisCoverage(iface, representedCoverageEntries(iface, 0), false);
    expect(result.coverage.fullyRepresented).toBe(false);
    expect(result.coverage.limitation).toMatchObject({
      code: "synthesis.inventory_incomplete",
    });
  });

  it("validates custom limitation evidence for a non-exhaustive inventory", () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: { getUser: {} },
      sources: { api: { bindingSpec: "example.spec@1", location: "https://example.com/spec" } },
      bindings: { "getUser.api": { operation: "getUser", source: "api", selector: "#/getUser" } },
    };
    const result = finalizeSynthesisCoverage(
      iface,
      representedCoverageEntries(iface, 0),
      false,
      {
        code: "example.bounded_listing",
        message: "the live listing stopped at its declared page bound",
        details: { pages: 10 },
      },
    );
    expect(result.coverage.limitation).toEqual({
      code: "example.bounded_listing",
      message: "the live listing stopped at its declared page bound",
      details: { pages: 10 },
    });
    expect(() => finalizeSynthesisCoverage(
      iface,
      representedCoverageEntries(iface, 0),
      false,
      { code: "bad", message: "" },
    )).toThrow(/valid code and message/);
  });
});
