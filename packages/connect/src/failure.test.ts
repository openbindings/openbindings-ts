import { describe, expect, it } from "vitest";
import { ERR_AUTH_REQUIRED, ERR_UNAVAILABLE, InvocationError } from "@openbindings/sdk";
import { connectFailureEvidence } from "./failure.js";

describe("connectFailureEvidence", () => {
  it("extracts exact HTTP failure bytes and the native error", () => {
    const error = new InvocationError(ERR_AUTH_REQUIRED, "expired", {
      httpResponse: {
        status: 401,
        headers: { "x-request-id": ["req-1"] },
        body: { base64: "AP+AQQ==", byteLength: 4 },
      },
      connect: { error: { code: "unauthenticated", message: "expired" } },
    });
    const evidence = connectFailureEvidence(error);
    expect(evidence?.httpResponse?.status).toBe(401);
    expect([...evidence!.httpResponse!.body]).toEqual([0x00, 0xff, 0x80, 0x41]);
    expect(evidence?.error?.code).toBe("unauthenticated");
  });

  it("extracts END_STREAM evidence without inventing it for local errors", () => {
    const error = new InvocationError(ERR_UNAVAILABLE, "quota", {
      connect: { endStream: {
        error: { code: "resource_exhausted", message: "quota" },
        payload: { base64: "AP+AQQ==", byteLength: 4 },
      } },
    });
    expect(connectFailureEvidence(error)?.endStream?.error.code).toBe("resource_exhausted");
    expect(connectFailureEvidence(new Error("local"))).toBeNull();
  });
});
