import { describe, expect, it } from "vitest";
import { type InvocationError } from "@openbindings/invoke";
import { BINDING_SPEC_OPENAPI_31 as BINDING_SPEC } from "./constants.js";
import { OpenAPIInvoker } from "./test-helpers.js";
import { governingResponseMediaMatch } from "./media.js";
import { convertToInterface } from "./test-helpers.js";

function responseDocument(
  openapi: string,
  content: Record<string, unknown>,
): Record<string, unknown> {
  return {
    openapi,
    info: { title: "response carriage", version: "1" },
    servers: [{ url: "https://api.example" }],
    paths: {
      "/payload": {
        get: {
          operationId: "getPayload",
          responses: { "200": { description: "payload", content } },
        },
      },
    },
  };
}

async function invokeResponse(
  spec: unknown,
  bindingSpec: string,
  response: Response,
): Promise<{ outputs: unknown[]; error?: InvocationError }> {
  const call = new OpenAPIInvoker().invokeBinding({
    source: { bindingSpec, content: spec },
    selector: "#/paths/~1payload/get",
    fetch: async () => response,
  });
  await call.close();
  const outputs: unknown[] = [];
  let error: InvocationError | undefined;
  try {
    for await (const output of call.outputs) outputs.push(output);
  } catch (caught: unknown) {
    error = caught as InvocationError;
  }
  return { outputs, error };
}

describe("openbindings.openapi-3.1@1 response carriage", () => {
  it("emits exact OAS 3.0 binary response octets as canonical Base64", async () => {
    const spec = responseDocument("3.0.4", {
      "image/png": { schema: { type: "string", format: "binary" } },
    });
    const result = await invokeResponse(
      spec,
      BINDING_SPEC,
      new Response(Uint8Array.from([0, 1, 254, 255]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual(["AAH+/w=="]);

    const iface = await convertToInterface(
      undefined,
      spec,
      undefined,
      undefined,
      undefined,
      undefined,
      BINDING_SPEC,
    );
    expect(iface.operations["getPayload"]?.output).toEqual({
      type: "string",
      contentEncoding: "base64",
    });
  });

  it("lets an actual concrete response select a range and preserves schema-omitted 3.1 bytes", async () => {
    const spec = responseDocument("3.1.2", { "image/*": {} });
    const result = await invokeResponse(
      spec,
      BINDING_SPEC,
      new Response(Uint8Array.from([222, 173, 190, 239]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual(["3q2+7w=="]);

    const iface = await convertToInterface(
      undefined,
      spec,
      undefined,
      undefined,
      undefined,
      undefined,
      BINDING_SPEC,
    );
    expect(iface.operations["getPayload"]?.output).toEqual({
      type: "string",
      contentEncoding: "base64",
    });
  });

  it("uses the concrete member's JSON framing under an application range", async () => {
    const spec = responseDocument("3.1.2", {
      "application/*": { schema: { type: "object", properties: { ok: { type: "boolean" } } } },
    });
    const result = await invokeResponse(
      spec,
      BINDING_SPEC,
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual([{ ok: true }]);
  });

  it("ranks exact, type-range, and all-range declarations before parameter count", () => {
    const match = governingResponseMediaMatch({
      description: "ranked",
      content: {
        "*/*; profile=v1": {},
        "image/*; profile=v1": {},
        "image/png": {},
      },
    }, "image/png; profile=v1", true, true);
    expect(match?.mediaKey).toBe("image/png");
  });
});
