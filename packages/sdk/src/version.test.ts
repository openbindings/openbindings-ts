import { describe, it, expect } from "vitest";
import {
  isSupportedVersion,
  supportedRange,
  isValidSemver,
  isHigherMajorOrPre1MinorThanMaxTested,
  isUnsupportedPrerelease,
  MIN_SUPPORTED_VERSION,
  MAX_TESTED_VERSION,
} from "./version.js";
import { parseDocument } from "./parse.js";
import { validateInterface } from "./validate.js";
import { ValidationError } from "./errors.js";

describe("isSupportedVersion", () => {
  it("accepts the exact min version", () => {
    expect(isSupportedVersion(MIN_SUPPORTED_VERSION)).toBe(true);
  });

  it("accepts the exact max version", () => {
    expect(isSupportedVersion(MAX_TESTED_VERSION)).toBe(true);
  });

  // OBI-T-04 acceptance is patch-lenient within a supported minor line: a
  // higher patch than MAX_TESTED_VERSION is accepted (it is what
  // validateInterface/parseDocument do), even though it is outside the tested
  // range.
  it("accepts a higher patch within the supported minor", () => {
    expect(isSupportedVersion("0.2.1")).toBe(true);
    expect(isSupportedVersion("0.2.99")).toBe(true);
  });

  it("rejects below-min versions", () => {
    expect(isSupportedVersion("0.1.0")).toBe(false);
    expect(isSupportedVersion("0.1.9")).toBe(false);
    expect(isSupportedVersion("0.0.1")).toBe(false);
  });

  it("rejects higher major", () => {
    expect(isSupportedVersion("1.0.0")).toBe(false);
  });

  it("rejects pre-1.0 higher minor", () => {
    expect(isSupportedVersion("0.3.0")).toBe(false);
  });

  it("rejects unsupported prereleases", () => {
    expect(isSupportedVersion("0.2.0-rc.1")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isSupportedVersion("abc")).toBe(false);
    expect(isSupportedVersion("1.0")).toBe(false);
  });

  it("trims whitespace", () => {
    expect(isSupportedVersion(`  ${MIN_SUPPORTED_VERSION}  `)).toBe(true);
  });
});

// Pins isSupportedVersion to the ACTUAL accept/refuse outcome of parseDocument
// and validateInterface for the same versions, so the acceptance oracle can
// never drift from the paths it is promoted to predict (README, `ob create`).
// The minimal document is otherwise schema-valid, so on a well-formed version
// any refusal is the OBI-T-04 version refusal, tagged "(OBI-T-04)".
describe("isSupportedVersion matches validate/parse refusal (no drift)", () => {
  const versions = [
    "0.2.0", "0.2.1", "0.2.99", "0.1.0", "0.1.9",
    "0.0.1", "0.3.0", "1.0.0", "0.2.0-rc.1", "0.3.0-rc.1",
  ];

  const parseRefuses = (v: string): boolean => {
    try {
      parseDocument(JSON.stringify({ openbindings: v, operations: {} }));
      return false;
    } catch (err) {
      if (err instanceof ValidationError) {
        expect(err.problems.some((p) => p.includes("(OBI-T-04)"))).toBe(true);
        return true;
      }
      throw err; // a non-version failure would be a broken test fixture
    }
  };

  const validateVersionRefuses = (v: string): boolean => {
    try {
      validateInterface({ openbindings: v, operations: {} });
      return false;
    } catch (err) {
      if (err instanceof ValidationError) {
        // Only the version decision is tagged "(OBI-T-04)", so it is isolable
        // from any other shape problems the minimal interface may raise.
        return err.problems.some((p) => p.includes("(OBI-T-04)"));
      }
      throw err;
    }
  };

  it.each(versions)("%s: oracle equals not-refused", (v) => {
    const accepted = isSupportedVersion(v);
    expect(accepted).toBe(!parseRefuses(v));
    expect(accepted).toBe(!validateVersionRefuses(v));
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

describe("isUnsupportedPrerelease", () => {
  // MIN_SUPPORTED_VERSION === MAX_TESTED_VERSION === "0.2.0": no prerelease is in range.
  it.each([
    ["0.2.0", false],
    ["0.2.1", false],
    ["0.2.0+build.1", false],
    ["0.2.0-rc.1", true],
    ["0.3.0-rc.1", true],
    ["not-a-version", false],
  ])("isUnsupportedPrerelease(%j) === %s", (input, want) => {
    expect(isUnsupportedPrerelease(input)).toBe(want);
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
