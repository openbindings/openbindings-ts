import { describe, expect, it } from "vitest";
import { concludeConformance } from "./conformance.js";

describe("concludeConformance", () => {
  it("reports conformant when all applicable evidence is satisfied", () => {
    expect(
      concludeConformance({
        "OBI-D-02": "satisfied",
        "OBI-D-13": "not-applicable",
      }),
    ).toEqual({ conclusion: "conformant", violated: [], inconclusive: [] });
  });

  it("reports undetermined and identifies incomplete checks", () => {
    expect(
      concludeConformance({
        "OBI-D-02": "satisfied",
        "OBI-D-11": "inconclusive",
      }),
    ).toEqual({
      conclusion: "conformance-undetermined",
      violated: [],
      inconclusive: ["OBI-D-11"],
    });
  });

  it("makes violations decisive while retaining incomplete checks", () => {
    expect(
      concludeConformance({
        "OBI-D-17": "inconclusive",
        "OBI-D-03": "violated",
        "OBI-D-02": "violated",
      }),
    ).toEqual({
      conclusion: "non-conformant",
      violated: ["OBI-D-02", "OBI-D-03"],
      inconclusive: ["OBI-D-17"],
    });
  });

  it("does not let an unknown runtime status produce conformant", () => {
    expect(
      concludeConformance({
        "OBI-D-02": "misspelled",
      } as unknown as Parameters<typeof concludeConformance>[0]),
    ).toEqual({
      conclusion: "conformance-undetermined",
      violated: [],
      inconclusive: ["OBI-D-02"],
    });
  });
});
