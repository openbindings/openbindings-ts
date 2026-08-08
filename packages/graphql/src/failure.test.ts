import { describe, expect, it } from "vitest";
import { ERR_EXECUTION_FAILED, InvocationError } from "@openbindings/sdk";
import { graphQLFailureEvidence } from "./failure.js";

describe("graphQLFailureEvidence", () => {
  it("extracts exact HTTP response bytes", () => {
    const error = new InvocationError(ERR_EXECUTION_FAILED, "HTTP 500", undefined, {
      httpResponse: { status: 500, headers: { "x-id": ["1"] }, body: { base64: "AP+AQQ==", byteLength: 4 } },
      graphql: { mediaType: "application/json" },
    });
    const evidence = graphQLFailureEvidence(error);
    expect(evidence?.httpResponse?.status).toBe(500);
    expect([...evidence!.httpResponse!.body]).toEqual([0x00, 0xff, 0x80, 0x41]);
    expect(evidence?.mediaType).toBe("application/json");
  });

  it("extracts protocol error payloads and rejects local failures", () => {
    const error = new InvocationError(ERR_EXECUTION_FAILED, "rejected", undefined, {
      graphqlTransportWs: { type: "error", payload: [{ message: "rejected", extensions: { code: "NO" } }] },
    });
    expect(graphQLFailureEvidence(error)?.transportWs?.payload).toEqual([{ message: "rejected", extensions: { code: "NO" } }]);
    expect(graphQLFailureEvidence(new Error("local"))).toBeNull();
  });
});
