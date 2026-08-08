import { describe, expect, it } from "vitest";
import { InvocationError } from "@openbindings/sdk";
import { openAPIFailureEvidence } from "./failure.js";

describe("openAPIFailureEvidence", () => {
  it("extracts exact binary response bytes before and after an invoker-frame JSON round trip", () => {
    const details = {
      status: 500,
      httpResponse: {
        status: 500,
        headers: { "content-type": ["application/octet-stream"] },
        body: { base64: "AP+AQQ==", byteLength: 4 },
      },
      openapi: { declared: false },
    };
    for (const candidate of [details, JSON.parse(JSON.stringify(details)) as unknown]) {
      const evidence = openAPIFailureEvidence(
        new InvocationError("ERR_EXECUTION_FAILED", "HTTP 500", undefined, candidate),
      );
      expect(evidence).toMatchObject({
        httpResponse: { status: 500, headers: { "content-type": ["application/octet-stream"] } },
        openapi: { declared: false },
      });
      expect([...evidence!.httpResponse.body!]).toEqual([0x00, 0xff, 0x80, 0x41]);
    }
  });

  it("does not invent native evidence for local or corrupt errors", () => {
    expect(openAPIFailureEvidence(new Error("local runtime failure"))).toBeNull();
    expect(openAPIFailureEvidence(new InvocationError("ERR_EXECUTION_FAILED", "bad capture", undefined, {
      httpResponse: { status: 500, headers: {}, body: { base64: "AA==", byteLength: 2 } },
      openapi: { declared: false },
    }))).toBeNull();
  });
});
