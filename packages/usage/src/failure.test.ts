import { InvocationError } from "@openbindings/sdk";
import { describe, expect, it } from "vitest";
import { usageFailureEvidence } from "./failure.js";

describe("usageFailureEvidence", () => {
  it("extracts process status, signal, bytes, and truncation", () => {
    const error = new InvocationError("ERR_EXECUTION_FAILED", "failed", undefined, {
      usage: { process: {
        exitCode: -1,
        signal: "SIGTERM",
        stdout: { base64: "cGFydGlhbA==", byteLength: 7, truncated: true },
        stderr: { base64: "AP+AQQ==", byteLength: 4 },
      } },
    });
    const evidence = usageFailureEvidence(error);
    expect(evidence?.signal).toBe("SIGTERM");
    expect(evidence?.stdout.truncated).toBe(true);
    expect([...evidence!.stderr.bytes]).toEqual([0, 255, 128, 65]);
    expect(usageFailureEvidence(new Error("local"))).toBeNull();
  });
});
