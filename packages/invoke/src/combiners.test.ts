import { describe, expect, it } from "vitest";
import type { BindingSpecVerdict } from "@openbindings/core";
import { InvocationImpl } from "./invocation.js";
import type { BindingInvoker } from "./invokers.js";
import { combineInvokers } from "./combiners.js";

describe("combineInvokers", () => {
  it("routes support warranted by the authoritative query even when the advisory listing omits it", () => {
    let invoked = false;
    const hidden: BindingInvoker = {
      bindingSpecs: () => [],
      checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
        return [...new Set(bindingSpecs)].map(bindingSpec => ({
          bindingSpec,
          supported: bindingSpec === "example.hidden@1",
        }));
      },
      invokeBinding() {
        invoked = true;
        return new InvocationImpl();
      },
    };

    const combined = combineInvokers(hidden);
    expect(combined.bindingSpecs()).toEqual([]);
    expect(combined.checkBindingSpecs([
      "example.hidden@1",
      "example.hidden@1.0",
      "example.hidden@1",
    ])).toEqual([
      { bindingSpec: "example.hidden@1", supported: true },
      { bindingSpec: "example.hidden@1.0", supported: false },
    ]);

    combined.invokeBinding({
      source: { bindingSpec: "example.hidden@1" },
      selector: "",
    });
    expect(invoked).toBe(true);
  });
});
