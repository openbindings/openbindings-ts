import { describe, expect, it } from "vitest";
import { concludeVerification } from "./verification.js";

describe("concludeVerification", () => {
  it("reports conformant when all applicable evidence is satisfied", () => {
    expect(
      concludeVerification({
        "OBI-D-02": "satisfied",
        "OBI-D-13": "not-applicable",
      }),
    ).toEqual({ conclusion: "conformant", violated: [], unverified: [] });
  });

  it("reports undetermined and identifies incomplete checks", () => {
    expect(
      concludeVerification({
        "OBI-D-02": "satisfied",
        "OBI-D-11": "unverified",
      }),
    ).toEqual({
      conclusion: "conformance-undetermined",
      violated: [],
      unverified: ["OBI-D-11"],
    });
  });

  it("makes violations decisive while retaining incomplete checks", () => {
    expect(
      concludeVerification({
        "OBI-D-17": "unverified",
        "OBI-D-03": "violated",
        "OBI-D-02": "violated",
      }),
    ).toEqual({
      conclusion: "non-conformant",
      violated: ["OBI-D-02", "OBI-D-03"],
      unverified: ["OBI-D-17"],
    });
  });

  it("does not let an unknown runtime status produce conformant", () => {
    expect(
      concludeVerification({
        "OBI-D-02": "misspelled",
      } as unknown as Parameters<typeof concludeVerification>[0]),
    ).toEqual({
      conclusion: "conformance-undetermined",
      violated: [],
      unverified: ["OBI-D-02"],
    });
  });
});
