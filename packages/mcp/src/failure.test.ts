import { InvocationError } from "@openbindings/sdk";
import { describe, expect, it } from "vitest";
import { mcpFailureEvidence } from "./failure.js";

describe("mcpFailureEvidence", () => {
  it("extracts all native evidence lanes", () => {
    const error = new InvocationError("ERR_EXECUTION_FAILED", "failed", undefined, {
      mcp: {
        result: { isError: true, structuredContent: { reason: "policy" } },
        jsonrpcError: { code: -32042, message: "quota", data: { limit: 10 } },
      },
      httpResponse: {
        status: 503,
        headers: { "x-id": ["1"] },
        body: { base64: "AP+AQQ==", byteLength: 4 },
      },
    });
    const evidence = mcpFailureEvidence(error);
    expect(evidence?.result?.isError).toBe(true);
    expect(evidence?.jsonrpcError).toEqual({ code: -32042, message: "quota", data: { limit: 10 } });
    expect([...evidence!.httpResponse!.body]).toEqual([0, 255, 128, 65]);
    expect(mcpFailureEvidence(new Error("local"))).toBeNull();
  });
});
