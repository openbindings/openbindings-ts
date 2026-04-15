import { describe, it, expect } from "vitest";
import { isSupportedVersion, supportedRange } from "./version.js";

describe("isSupportedVersion", () => {
  it("accepts 0.1.0", () => {
    expect(isSupportedVersion("0.1.0")).toBe(true);
  });

  it("rejects 0.0.1", () => {
    expect(isSupportedVersion("0.0.1")).toBe(false);
  });

  it("rejects 1.0.0", () => {
    expect(isSupportedVersion("1.0.0")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isSupportedVersion("abc")).toBe(false);
  });
});

describe("supportedRange", () => {
  it("returns min and max", () => {
    const r = supportedRange();
    expect(r.min).toBe("0.1.0");
    expect(r.max).toBe("0.1.0");
  });
});
