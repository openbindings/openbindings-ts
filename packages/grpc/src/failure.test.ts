import { describe, expect, it } from "vitest";
import { ERR_EXECUTION_FAILED, InvocationError } from "@openbindings/sdk";
import { grpcFailureEvidence } from "./failure.js";

describe("grpcFailureEvidence", () => {
  it("extracts exact native status and Any payload bytes", () => {
    const error = new InvocationError(ERR_EXECUTION_FAILED, "rpc failed", {
      grpcStatus: {
        code: 13,
        message: "ledger corrupt",
        statusDetailsBinBase64: "CA0SDmxlZGdlciBjb3JydXB0",
        details: [{
          typeUrl: "type.googleapis.com/demo.Failure",
          valueBase64: "AP+AQQ==",
        }],
      },
    });

    const evidence = grpcFailureEvidence(error);
    expect(evidence).not.toBeNull();
    expect(evidence?.code).toBe(13);
    expect(evidence?.message).toBe("ledger corrupt");
    expect(evidence?.details[0]?.typeUrl).toBe("type.googleapis.com/demo.Failure");
    expect([...evidence!.details[0]!.value]).toEqual([0x00, 0xff, 0x80, 0x41]);
    expect(evidence?.statusDetailsBin).toBeInstanceOf(Uint8Array);
  });

  it("does not invent evidence for local errors and rejects malformed bytes", () => {
    expect(grpcFailureEvidence(new Error("local"))).toBeNull();
    expect(grpcFailureEvidence(new InvocationError(ERR_EXECUTION_FAILED, "bad", {
      grpcStatus: {
        code: 13,
        message: "bad detail",
        details: [{ typeUrl: "demo.Bad", valueBase64: "%%%" }],
      },
    }))).toBeNull();
  });
});
