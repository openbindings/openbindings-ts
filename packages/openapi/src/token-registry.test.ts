import { describe, expect, it } from "vitest";
import * as publicAPI from "./index.js";
import {
  BINDING_SPEC_OPENAPI_20,
  BINDING_SPEC_OPENAPI_30,
  BINDING_SPEC_OPENAPI_31,
  BINDING_SPEC_OPENAPI_32,
  ERR_UNSUPPORTED_BINDING_SPEC,
  checkAcceptedOpenAPIEdition,
  isImplementedOpenAPIBindingSpec,
} from "./constants.js";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";

const DOC_30 = {
  openapi: "3.0.4",
  info: { title: "token gate", version: "1" },
  paths: {},
};
const DOC_31 = {
  openapi: "3.1.2",
  info: { title: "token gate", version: "1" },
  paths: {},
};

describe("exact OpenAPI family-token registry", () => {
  it("exports and warrants four registered tokens with no legacy alias", () => {
    expect([
      publicAPI.BINDING_SPEC_OPENAPI_20,
      publicAPI.BINDING_SPEC_OPENAPI_30,
      publicAPI.BINDING_SPEC_OPENAPI_31,
      publicAPI.BINDING_SPEC_OPENAPI_32,
    ]).toEqual([
      BINDING_SPEC_OPENAPI_20,
      BINDING_SPEC_OPENAPI_30,
      BINDING_SPEC_OPENAPI_31,
      BINDING_SPEC_OPENAPI_32,
    ]);
    expect(isImplementedOpenAPIBindingSpec(BINDING_SPEC_OPENAPI_20)).toBe(true);
    expect(isImplementedOpenAPIBindingSpec(BINDING_SPEC_OPENAPI_30)).toBe(true);
    expect(isImplementedOpenAPIBindingSpec(BINDING_SPEC_OPENAPI_31)).toBe(true);
    expect(isImplementedOpenAPIBindingSpec(BINDING_SPEC_OPENAPI_32)).toBe(true);
    expect(publicAPI).not.toHaveProperty("BINDING_SPEC");
  });

  it("admits only the exact editions registered to each warranted token", () => {
    expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_20, "2.0")).not.toThrow();
    expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_20, "2.1")).toThrow();
    for (const edition of ["3.0.0", "3.0.1", "3.0.2", "3.0.3", "3.0.4"]) {
      expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_30, edition)).not.toThrow();
      expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_31, edition)).toThrow();
    }
    for (const edition of ["3.1.0", "3.1.1", "3.1.2"]) {
      expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_31, edition)).not.toThrow();
      expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_30, edition)).toThrow();
    }
    expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_32, "3.2.0")).not.toThrow();
    for (const edition of ["3.0.5", "3.1.3", "3.2.0", "3.1"]) {
      expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_30, edition)).toThrow();
      expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_31, edition)).toThrow();
      if (edition !== "3.2.0") {
        expect(() => checkAcceptedOpenAPIEdition(BINDING_SPEC_OPENAPI_32, edition)).toThrow();
      }
    }
  });

  it.each(["", "example.unknown@1"])(
    "refuses token %j before synthesis reads artifact content",
    async (bindingSpec) => {
      let reads = 0;
      const poison = new Proxy({}, { get: () => { reads += 1; throw new Error("artifact was read"); } });
      await expect(new OpenAPISynthesizer().synthesizeInterface({
        sources: [{ bindingSpec, content: poison }],
      })).rejects.toThrow(ERR_UNSUPPORTED_BINDING_SPEC);
      expect(reads).toBe(0);
    },
  );

  it.each(["", "example.unknown@1"])(
    "refuses token %j before invocation reads or fetches the artifact",
    async (bindingSpec) => {
      let reads = 0;
      let fetches = 0;
      const poison = new Proxy({}, { get: () => { reads += 1; throw new Error("artifact was read"); } });
      const call = new OpenAPIInvoker().invokeBinding({
        source: { bindingSpec, content: poison },
        selector: "#/paths/~1x/get",
        fetch: async () => { fetches += 1; throw new Error("artifact was fetched"); },
      });
      await expect(call.closed).rejects.toMatchObject({ code: ERR_UNSUPPORTED_BINDING_SPEC });
      expect(reads).toBe(0);
      expect(fetches).toBe(0);
    },
  );

  it("refuses a document/token edition mismatch on both synthesis and invocation", async () => {
    await expect(new OpenAPISynthesizer().synthesizeInterface({
      sources: [{ bindingSpec: BINDING_SPEC_OPENAPI_30, content: DOC_31 }],
    })).rejects.toThrow(/not admitted/);
    const call = new OpenAPIInvoker().invokeBinding({
      source: { bindingSpec: BINDING_SPEC_OPENAPI_31, content: DOC_30 },
      selector: "#/paths/~1x/get",
    });
    await expect(call.closed).rejects.toMatchObject({ code: "ERR_SOURCE_LOAD_FAILED" });
  });
});
