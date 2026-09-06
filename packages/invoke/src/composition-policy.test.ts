import { describe, expect, it } from "vitest";
import { prepareInterface, type OBInterface } from "@openbindings/core";
import {
  REFERENCE_COMPOSITION_POLICY_ID,
  referenceCompositionPolicy,
} from "./composition-policy.js";

function interfaceWith(
  key: string,
  input: OBInterface["operations"][string]["input"],
  aliases?: string[],
): OBInterface {
  return {
    openbindings: "0.2.0",
    operations: {
      [key]: {
        ...(aliases ? { aliases } : {}),
        input,
        output: { type: "string" },
      },
    },
  };
}

describe("referenceCompositionPolicy", () => {
  it("is explicitly named and corresponds through key/alias intersection", async () => {
    const required = await prepareInterface(interfaceWith("create", { type: "string" }, ["tasks.create"]));
    const provider = await prepareInterface(interfaceWith("remoteCreate", { type: "string" }, ["tasks.create"]));
    const correspondences = referenceCompositionPolicy.correspondences(
      required.operation("create")!,
      provider,
    );

    expect(referenceCompositionPolicy.id).toBe(REFERENCE_COMPOSITION_POLICY_ID);
    expect(correspondences).toHaveLength(1);
    expect(correspondences[0]).toMatchObject({
      identifier: "tasks.create",
      providerOperation: { canonicalKey: "remoteCreate" },
    });
  });

  it("uses exact identity before the directional profile", async () => {
    const required = await prepareInterface(interfaceWith("create", {
      type: "string",
      pattern: "^[a-z]+$",
    }));
    const provider = await prepareInterface(interfaceWith("create", {
      pattern: "^[a-z]+$",
      type: "string",
    }));
    const correspondence = referenceCompositionPolicy.correspondences(
      required.operation("create")!,
      provider,
    )[0]!;

    await expect(referenceCompositionPolicy.assessContract(required, correspondence, provider))
      .resolves.toMatchObject({ verdict: "compatible", method: "exact" });
  });

  it("keeps profile limitations indeterminate instead of calling them incompatible", async () => {
    const required = await prepareInterface(interfaceWith("create", {
      type: "string",
      pattern: "^[a-z]+$",
    }));
    const provider = await prepareInterface(interfaceWith("create", {
      type: "string",
      pattern: "^[A-Z]+$",
    }));
    const correspondence = referenceCompositionPolicy.correspondences(
      required.operation("create")!,
      provider,
    )[0]!;

    await expect(referenceCompositionPolicy.assessContract(required, correspondence, provider))
      .resolves.toMatchObject({ verdict: "indeterminate", method: "directional-profile" });
  });

  it("keeps an unavailable external schema graph indeterminate", async () => {
    const required = await prepareInterface(interfaceWith("create", {
      $ref: "https://schemas.example/CreateInput",
    }));
    const provider = await prepareInterface(interfaceWith("create", {
      $ref: "https://schemas.example/CreateInput",
    }));
    const correspondence = referenceCompositionPolicy.correspondences(
      required.operation("create")!,
      provider,
    )[0]!;

    await expect(referenceCompositionPolicy.assessContract(required, correspondence, provider))
      .resolves.toMatchObject({ verdict: "indeterminate", method: "directional-profile" });
  });

  it("reports negative directional evidence as incompatible", async () => {
    const required = await prepareInterface(interfaceWith("create", { type: "string" }));
    const provider = await prepareInterface(interfaceWith("create", { type: "number" }));
    const correspondence = referenceCompositionPolicy.correspondences(
      required.operation("create")!,
      provider,
    )[0]!;

    await expect(referenceCompositionPolicy.assessContract(required, correspondence, provider))
      .resolves.toMatchObject({ verdict: "incompatible", method: "directional-profile" });
  });

  it("selects providers separately from their realizations", () => {
    const low = { providerKey: "low", preference: 0, bindingKey: "a" };
    const highA = { providerKey: "high", preference: 10, bindingKey: "a" };
    const highB = { providerKey: "high", preference: 10, bindingKey: "b" };

    expect(referenceCompositionPolicy.selectProvider([low, highA])).toEqual({
      status: "selected",
      provider: highA,
    });
    expect(referenceCompositionPolicy.selectProvider([highA, { ...highA, providerKey: "peer" }]).status)
      .toBe("ambiguous");
    expect(referenceCompositionPolicy.selectRealization([highA, highB]).status)
      .toBe("ambiguous");
    expect(referenceCompositionPolicy.selectRealization([highA, highB], () => "b"))
      .toEqual({ status: "selected", realization: highB });
  });

  it("plans provider inspection by descending preference tiers", () => {
    expect(referenceCompositionPolicy.providerInspectionGroups([
      { providerKey: "low", preference: 0 },
      { providerKey: "high-b", preference: 10 },
      { providerKey: "high-a", preference: 10 },
    ])).toEqual([
      [
        { providerKey: "high-a", preference: 10 },
        { providerKey: "high-b", preference: 10 },
      ],
      [{ providerKey: "low", preference: 0 }],
    ]);
  });
});
