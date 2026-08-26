import { describe, expect, it } from "vitest";
import jsonata from "jsonata";

import { BINDING_SPEC_OPENAPI_31, profileForBindingSpec } from "./constants.js";
import {
  engineInputForCallerEnvelope,
  parseCallerEnvelope,
  planAbstractInputRoutes,
} from "./input-routes-v2.js";
import { FAMILY_JSON, type BodyPlan } from "./media.js";

function objectPlan(names: string[], required = false): BodyPlan {
  return {
    declared: true,
    required,
    mediaKey: "application/json",
    mediaType: "application/json",
    media: { schema: { type: "object" } },
    family: FAMILY_JSON,
    synthetic: false,
    props: new Set(names),
  };
}

describe("OpenAPI caller envelope", () => {
  it("closes the top level and parameters member", () => {
    expect(() => parseCallerEnvelope({ extra: true })).toThrow(/unknown top-level key/);
    expect(() => parseCallerEnvelope({ parameters: [] })).toThrow(/must be an object/);
    expect(() => parseCallerEnvelope(null)).toThrow(/envelope object/);
  });

  it("qualifies every parameter key and RFC 6901-escapes names on cross-location collision", () => {
    const params = [
      { name: "a/b~c", in: "path", required: true },
      { name: "a/b~c", in: "query" },
      { name: "plain", in: "header" },
    ];
    const routes = planAbstractInputRoutes(params, []);
    expect(routes.transformExpression()).toContain(
      '{"header/plain":$lookup($,"plain"),"path/a~1b~0c":$lookup($,"a/b~c"),"query/a~1b~0c":$lookup($,"a/b~c_2")}',
    );
  });

  it("constructs the same public parameter/body envelope as the Go twin", async () => {
    const routes = planAbstractInputRoutes(
      [{ name: "q", in: "query" }],
      [objectPlan(["name"], true)],
    );
    await expect(jsonata(routes.transformExpression()).evaluate({
      q: "term",
      name: "Ada",
    })).resolves.toEqual({
      parameters: { q: "term" },
      body: { name: "Ada" },
    });
  });

  it("gives authored names priority and skips authored suffix reservations", () => {
    const routes = planAbstractInputRoutes(
      [{ name: "id", in: "path" }, { name: "id_2", in: "query" }],
      [objectPlan(["id"])],
    );
    expect(routes.parameters).toEqual([
      { in: "path", name: "id", field: "id" },
      { in: "query", name: "id_2", field: "id_2" },
    ]);
    expect(routes.bodyFields).toEqual({ id: "id_3" });
  });

  it("names a protocol-neutral whole JSON body payload and an ordinary synthetic body body", () => {
    const whole = planAbstractInputRoutes([], [{ ...objectPlan([]), wholeObject: true }]);
    const synthetic = planAbstractInputRoutes([], [{ ...objectPlan([]), synthetic: true }]);
    expect(whole.wholeBodyField).toBe("payload");
    expect(synthetic.wholeBodyField).toBe("body");
  });

  it("omits a transform for zero input and omits absent envelope members in JSONata", () => {
    expect(planAbstractInputRoutes([], []).needsTransform).toBe(false);
    const routes = planAbstractInputRoutes([{ name: "q", in: "query" }], []);
    expect(routes.transformExpression()).toContain('$lookup({},"__openbindings_absent")');
  });

  it("refuses unknown caller parameter keys before lowering to the private engine route", () => {
    const params = [{ name: "id", in: "path", required: true }];
    const routes = planAbstractInputRoutes(params, []);
    expect(() => engineInputForCallerEnvelope(
      { parameters: { other: "x" } },
      params,
      [],
      routes,
      profileForBindingSpec(BINDING_SPEC_OPENAPI_31),
    )).toThrow(/unknown parameter key/);
  });
});
