import { describe, it, expect } from "vitest";
import {
  effectiveParameters,
  primitiveString,
  routeInput,
  routeParameter,
  serializeHeaderValue,
  serializeMultipartValue,
  serializePathValue,
  serializeQueryValue,
  validateParameterSerialization,
  type RoutedInput,
} from "./params.js";
import type { BodyPlan } from "./media.js";
import { FAMILY_JSON } from "./media.js";
import { BINDING_SPEC_OPENAPI_31 as BINDING_SPEC, profileForBindingSpec } from "./constants.js";

// The OAS style-examples table (OAPI-P-02: serialization incorporated
// wholesale), exercised cell by cell with the OAS's own example values:
// primitive "blue", array [blue, black, brown], object {R:100, G:200,
// B:150}. One deliberate difference from the table's literal strings: JSON
// object members are unordered, so this implementation expands object
// members in sorted-key order (B, G, R) for determinism. Mirrors Go's
// params_test.go.

const tablePrimitive = "blue";
const tableArray = ["blue", "black", "brown"];
const tableObject = { R: 100, G: 200, B: 150 };

describe("serializePathValue — the OAS style table", () => {
  const cases: Array<[string, boolean, unknown, string]> = [
    ["simple", false, tablePrimitive, "blue"],
    ["simple", true, tablePrimitive, "blue"],
    ["simple", false, tableArray, "blue,black,brown"],
    ["simple", true, tableArray, "blue,black,brown"],
    ["simple", false, tableObject, "B,150,G,200,R,100"],
    ["simple", true, tableObject, "B=150,G=200,R=100"],

    ["label", false, tablePrimitive, ".blue"],
    ["label", true, tablePrimitive, ".blue"],
    ["label", false, tableArray, ".blue,black,brown"],
    ["label", true, tableArray, ".blue.black.brown"],
    ["label", false, tableObject, ".B,150,G,200,R,100"],
    ["label", true, tableObject, ".B=150.G=200.R=100"],

    ["matrix", false, tablePrimitive, ";color=blue"],
    ["matrix", true, tablePrimitive, ";color=blue"],
    ["matrix", false, tableArray, ";color=blue,black,brown"],
    ["matrix", true, tableArray, ";color=blue;color=black;color=brown"],
    ["matrix", false, tableObject, ";color=B,150,G,200,R,100"],
    ["matrix", true, tableObject, ";B=150;G=200;R=100"],

    // Empty-value cells the OAS table defines.
    ["matrix", false, "", ";color"],
    ["label", false, "", "."],
  ];
  for (const [style, explode, value, want] of cases) {
    it(`${style}/explode=${explode} (${Array.isArray(value) ? "array" : typeof value}) → ${want}`, () => {
      expect(serializePathValue("color", value, style, explode)).toBe(want);
    });
  }
});

describe("serializeQueryValue — the OAS style table", () => {
  const cases: Array<[string, boolean, unknown, string[]]> = [
    ["form", false, tablePrimitive, ["color=blue"]],
    ["form", true, tablePrimitive, ["color=blue"]],
    ["form", false, tableArray, ["color=blue,black,brown"]],
    ["form", true, tableArray, ["color=blue", "color=black", "color=brown"]],
    ["form", false, tableObject, ["color=B,150,G,200,R,100"]],
    ["form", true, tableObject, ["B=150", "G=200", "R=100"]],

    ["spaceDelimited", false, tableArray, ["color=blue%20black%20brown"]],
    ["pipeDelimited", false, tableArray, ["color=blue|black|brown"]],

    ["deepObject", true, tableObject, ["color[B]=150", "color[G]=200", "color[R]=100"]],

    // The empty-string cell for form.
    ["form", false, "", ["color="]],
  ];
  for (const [style, explode, value, want] of cases) {
    it(`${style}/explode=${explode} (${Array.isArray(value) ? "array" : typeof value}) → ${want.join(" ")}`, () => {
      expect(serializeQueryValue("color", value, style, explode, false)).toEqual(want);
    });
  }

  // Undefined table cells refuse loudly rather than inventing a serialization.
  it("refuses undefined table cells loudly", () => {
    expect(() => serializeQueryValue("color", "blue", "spaceDelimited", false, false)).toThrow();
    expect(() => serializeQueryValue("color", "blue", "pipeDelimited", false, false)).toThrow();
    expect(() => serializeQueryValue("color", tableArray, "deepObject", true, false)).toThrow();
    expect(() => serializeQueryValue("color", tableObject, "spaceDelimited", false, false)).toThrow();
    expect(() => serializeQueryValue("color", tableObject, "pipeDelimited", false, false)).toThrow();
    expect(() => serializeQueryValue("color", tableArray, "spaceDelimited", true, false)).toThrow();
    expect(() => serializeQueryValue("color", tableObject, "deepObject", false, false)).toThrow();
    expect(() => serializePathValue("id", "x", "form", false)).toThrow();
    // Nested non-primitives inside an expansion have no OAS-defined form.
    expect(() => serializeQueryValue("f", [{ x: 1 }], "form", false, false)).toThrow();
  });

  // allowReserved lets RFC 3986 reserved characters pass unescaped in query
  // values (OAPI-P-02); names stay escaped.
  it("honors allowReserved on values", () => {
    expect(serializeQueryValue("path", "a/b?c=d", "form", true, false)).toEqual([
      "path=a%2Fb%3Fc%3Dd",
    ]);
    expect(serializeQueryValue("path", "a/b?c=d", "form", true, true)).toEqual(["path=a/b?c=d"]);
  });

  it("uses the RFC 3986 unreserved set in revision 3", () => {
    expect(serializeQueryValue("q", "!*'()", "form", true, false, true))
      .toEqual(["q=%21%2A%27%28%29"]);
    expect(serializePathValue("id", "!*'()", "simple", false, true))
      .toBe("%21%2A%27%28%29");
  });
});

describe("serializeMultipartValue", () => {
  it("applies RFC 6570 expansion without URI percent-encoding", () => {
    expect(serializeMultipartValue("tags", ["a/b", "c d"], "form", false))
      .toEqual([["tags", "a/b,c d"]]);
    expect(serializeMultipartValue("filter", { R: 100, G: 200 }, "form", true))
      .toEqual([["G", "200"], ["R", "100"]]);
    expect(serializeMultipartValue("filter", { "a=b": "c=d" }, "form", true))
      .toEqual([["a=b", "c=d"]]);
  });
});

describe("validateParameterSerialization", () => {
  it("refuses undefined OAS style-table cells", () => {
    expect(() => validateParameterSerialization({
      name: "filter",
      in: "query",
      style: "deepObject",
      explode: false,
      schema: { type: "object" },
    })).toThrow(/explode=true/);
    expect(() => validateParameterSerialization({
      name: "filter",
      in: "query",
      style: "pipeDelimited",
      explode: false,
      schema: { type: "object" },
    })).toThrow(/arrays/);
  });
});

describe("serializeHeaderValue", () => {
  it("expands simple arrays and exploded objects", () => {
    expect(serializeHeaderValue([3, 4], "simple", false)).toBe("3,4");
    expect(serializeHeaderValue(tableObject, "simple", true)).toBe("B=150,G=200,R=100");
  });

  it("never percent-encodes header values (they are not URL components)", () => {
    expect(serializeHeaderValue("a b/c", "simple", false)).toBe("a b/c");
  });

  it("refuses non-simple styles", () => {
    expect(() => serializeHeaderValue("x", "form", false)).toThrow();
  });
});

// Primitive wire forms are defined (String() coercion is not
// serialization): numbers render canonically, booleans as true/false, null
// as empty.
describe("primitiveString", () => {
  it("renders JSON primitives in their defined wire forms", () => {
    expect(primitiveString(1)).toBe("1");
    expect(primitiveString(1.5)).toBe("1.5");
    expect(primitiveString(true)).toBe("true");
    expect(primitiveString(false)).toBe("false");
    expect(primitiveString(null)).toBe("");
    expect(primitiveString("s")).toBe("s");
  });

  it("refuses non-primitives", () => {
    expect(() => primitiveString({})).toThrow();
  });
});

function emptyRouted(): RoutedInput {
  return {
    resolvedPath: "/x",
    queryUnits: [],
    headers: [],
    cookieUnits: [],
    bodyFields: {},
    bodyValue: undefined,
    bodySet: false,
    populated: { header: new Set(), query: new Set(), cookie: new Set() },
  };
}

// A content-form parameter serializes per its declared media type and rides
// its location as that string (OAPI-P-02).
describe("routeParameter — content-form parameters", () => {
  it("serializes a JSON content parameter and percent-encodes the unit", () => {
    const r = emptyRouted();
    routeParameter(r, { name: "filter", in: "query", content: { "application/json": {} } }, { a: 1 });
    expect(r.queryUnits).toEqual(["filter=%7B%22a%22%3A1%7D"]);
  });

  it("refuses a content media type with no defined parameter carriage", () => {
    const r = emptyRouted();
    expect(() =>
      routeParameter(r, { name: "blob", in: "query", content: { "application/octet-stream": {} } }, "x"),
    ).toThrow("no parameter carriage");
  });

  it("uses revision-3 semantic media parsing and declared charset bytes before query carriage", () => {
    const r = emptyRouted();
    routeParameter(r, {
      name: "note",
      in: "query",
      content: { "text/plain; charset=iso-8859-1; profile=demo": {} },
    }, "café", profileForBindingSpec(BINDING_SPEC));
    expect(r.queryUnits).toEqual(["note=caf%E9"]);
  });

  it("refuses unsupported revision-3 parameter content charset", () => {
    const r = emptyRouted();
    expect(() => routeParameter(r, {
      name: "note",
      in: "query",
      content: { "text/plain; charset=utf-16": {} },
    }, "hello", profileForBindingSpec(BINDING_SPEC))).toThrow(/unsupported charset/);
  });
});

// The OAS voids header parameter declarations named Accept, Content-Type,
// or Authorization; the effective set drops them.
describe("effectiveParameters", () => {
  it("drops Accept/Content-Type/Authorization header params, keeps the rest", () => {
    const params = effectiveParameters(
      {},
      {
        parameters: [
          { name: "Authorization", in: "header" },
          { name: "accept", in: "header" },
          { name: "X-Custom", in: "header" },
          { name: "Authorization", in: "query" }, // query is not special
        ],
      },
    );
    expect(params).toHaveLength(2);
    expect(params.map((p) => `${p.in}:${p.name}`)).toEqual([
      "header:X-Custom",
      "query:Authorization",
    ]);
  });
});

// Synthetic-body routing: with a non-object body schema, the `body` field
// is the request body; other unmatched fields have nowhere to ride and
// refuse.
describe("routeInput — synthetic body", () => {
  const plan: BodyPlan = {
    declared: true,
    required: false,
    mediaKey: "application/json",
    mediaType: "application/json",
    media: null,
    family: FAMILY_JSON,
    synthetic: true,
  };

  it("captures the synthetic body member", () => {
    const routed = routeInput([], { body: [1, 2] }, "/x", plan);
    expect(routed.bodySet).toBe(true);
    expect(routed.bodyValue).toEqual([1, 2]);
  });

  it("refuses a non-body field on a synthetic-body operation", () => {
    expect(() => routeInput([], { stray: 1 }, "/x", plan)).toThrow("whole-value carriage");
  });
});
