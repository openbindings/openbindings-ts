import { describe, it, expect } from "vitest";
import {
  isSupportedVersion,
  supportedRange,
  isValidSemver,
  isHigherMajorOrPre1MinorThanMaxTested,
  MIN_SUPPORTED_VERSION,
  MAX_TESTED_VERSION,
} from "./version.js";

describe("isSupportedVersion", () => {
  it("accepts the exact min version", () => {
    expect(isSupportedVersion(MIN_SUPPORTED_VERSION)).toBe(true);
  });

  it("accepts the exact max version", () => {
    expect(isSupportedVersion(MAX_TESTED_VERSION)).toBe(true);
  });

  it("rejects below-min versions", () => {
    expect(isSupportedVersion("0.1.0")).toBe(false);
    expect(isSupportedVersion("0.0.1")).toBe(false);
  });

  it("rejects higher major", () => {
    expect(isSupportedVersion("1.0.0")).toBe(false);
  });

  it("rejects pre-1.0 higher minor", () => {
    expect(isSupportedVersion("0.3.0")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isSupportedVersion("abc")).toBe(false);
    expect(isSupportedVersion("1.0")).toBe(false);
  });

  it("trims whitespace", () => {
    expect(isSupportedVersion(`  ${MIN_SUPPORTED_VERSION}  `)).toBe(true);
  });
});

describe("supportedRange", () => {
  it("returns the SDK's min and max", () => {
    const r = supportedRange();
    expect(r.min).toBe(MIN_SUPPORTED_VERSION);
    expect(r.max).toBe(MAX_TESTED_VERSION);
  });
});

describe("isValidSemver", () => {
  it.each([
    ["0.0.0", true],
    ["1.2.3", true],
    ["10.20.30", true],
    ["1.0.0-alpha", true],
    ["1.0.0-alpha.1", true],
    ["1.0.0-x.7.z.92", true],
    ["1.0.0+20130313144700", true],
    ["1.0.0-beta+exp.sha.5114f85", true],
    ["  1.2.3  ", true],
    ["", false],
    ["1.2", false],
    ["1.2.3.4", false],
    ["a.b.c", false],
    ["01.2.3", false],
    ["1.2.3-", false],
  ])("isValidSemver(%j) === %s", (input, want) => {
    expect(isValidSemver(input)).toBe(want);
  });
});

describe("isHigherMajorOrPre1MinorThanMaxTested", () => {
  it("returns false for the exact max", () => {
    expect(isHigherMajorOrPre1MinorThanMaxTested(MAX_TESTED_VERSION)).toBe(false);
  });

  it("returns false for lower-minor pre-1.0", () => {
    expect(isHigherMajorOrPre1MinorThanMaxTested("0.1.0")).toBe(false);
  });

  it("returns false for higher patch only", () => {
    expect(isHigherMajorOrPre1MinorThanMaxTested("0.2.5")).toBe(false);
  });

  it("returns true for higher minor while pre-1.0", () => {
    expect(isHigherMajorOrPre1MinorThanMaxTested("0.3.0")).toBe(true);
  });

  it("returns true for higher major", () => {
    expect(isHigherMajorOrPre1MinorThanMaxTested("1.0.0")).toBe(true);
    expect(isHigherMajorOrPre1MinorThanMaxTested("5.0.0")).toBe(true);
  });

  it("throws on invalid semver", () => {
    expect(() => isHigherMajorOrPre1MinorThanMaxTested("not-a-version")).toThrow();
  });
});
