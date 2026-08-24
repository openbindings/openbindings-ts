import { describe, expect, it } from "vitest";
import type { BindingSpecVerdict, OBInterface } from "@openbindings/core";
import type { InterfaceSynthesizer } from "./synthesizer.js";
import { combineSynthesizers } from "./combiners.js";

describe("combineSynthesizers", () => {
  it("routes support warranted by the authoritative query even when the advisory listing omits it", async () => {
    let synthesized = false;
    const hidden: InterfaceSynthesizer = {
      bindingSpecs: () => [],
      checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
        return [...new Set(bindingSpecs)].map(bindingSpec => ({
          bindingSpec,
          supported: bindingSpec === "example.hidden@1",
        }));
      },
      async synthesizeInterface(): Promise<OBInterface> {
        synthesized = true;
        return { openbindings: "0.2.0", operations: {} };
      },
    };

    const combined = combineSynthesizers(hidden);
    expect(combined.bindingSpecs()).toEqual([]);
    expect(combined.checkBindingSpecs([
      "example.hidden@1",
      "example.hidden@1.0",
      "example.hidden@1",
    ])).toEqual([
      { bindingSpec: "example.hidden@1", supported: true },
      { bindingSpec: "example.hidden@1.0", supported: false },
    ]);

    await combined.synthesizeInterface({
      sources: [{ bindingSpec: "example.hidden@1" }],
    });
    expect(synthesized).toBe(true);
  });
});
