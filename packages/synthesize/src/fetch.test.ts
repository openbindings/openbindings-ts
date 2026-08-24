import { describe, it, expect } from "vitest";
import { fetchInterface } from "./fetch.js";
import type { CoverageSynthesizer, InterfaceSynthesizer } from "./synthesizer.js";
import { finalizeSynthesisCoverage } from "./synthesizer-types.js";

/** A fetch that returns reachable non-OBI JSON (an HTML-ish API root stand-in). */
function nonObiFetch(): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify({ hello: "world" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

/** A synthesizer that always throws for its one binding specification. */
function failingSynthesizer(bindingSpec: string, err: string): InterfaceSynthesizer {
  return {
    checkBindingSpecs: bindingSpecs => [...new Set(bindingSpecs)].map(candidate => ({
      bindingSpec: candidate,
      supported: candidate === bindingSpec,
    })),
    bindingSpecs: () => [{ bindingSpec }],
    synthesizeInterface: async () => {
      throw new Error(err);
    },
  };
}

function coverageSynthesizer(): CoverageSynthesizer {
  const iface = {
    openbindings: "0.2.0",
    operations: { ping: {} },
    sources: {
      source: { bindingSpec: "fake.coverage@1", location: "https://api.example.com/" },
    },
    bindings: {
      "ping.source": { operation: "ping", source: "source", selector: "ping" },
    },
  };
  return {
    checkBindingSpecs: bindingSpecs => [...new Set(bindingSpecs)].map(bindingSpec => ({
      bindingSpec,
      supported: bindingSpec === "fake.coverage@1",
    })),
    bindingSpecs: () => [{ bindingSpec: "fake.coverage@1" }],
    synthesizeInterface: async () => iface,
    synthesizeInterfaceWithCoverage: async () =>
      finalizeSynthesisCoverage(iface, [{
        sourceIndex: 0,
        sourceKey: "source",
        sourceRef: "ping",
        scope: "target",
        status: "represented",
        operationKey: "ping",
        bindingKey: "ping.source",
        bindingSelector: "ping",
      }], true),
  };
}

describe("fetchInterface resolution trail", () => {
  it("reports every step tried when no synthesizer is supplied", async () => {
    await expect(
      fetchInterface("https://api.example.com/", { fetch: nonObiFetch() }),
    ).rejects.toThrow(/no OBI available at https:\/\/api\.example\.com\/ \(.*direct fetch: not an OBI.*\) and no synthesizers/);
  });

  it("carries the whole trail (direct + well-known + per-synthesizer) on total failure", async () => {
    let msg: string;
    try {
      await fetchInterface("https://api.example.com/", {
        fetch: nonObiFetch(),
        synthesizers: [failingSynthesizer("openapi@3.1.0", "not an OpenAPI document")],
      });
      throw new Error("expected rejection");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("could not resolve an OBI from https://api.example.com/");
    expect(msg).toContain("direct fetch: not an OBI");
    expect(msg).toContain("/.well-known/openbindings: not an OBI");
    expect(msg).toContain("synthesize as openapi@3.1.0: not an OpenAPI document");
    expect(msg).toContain("hint: if the target serves a raw spec");
  });

  it("captures a network error as a trail step rather than aborting the chain", async () => {
    const netFail = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      fetchInterface("https://down.example.com/", { fetch: netFail }),
    ).rejects.toThrow(/direct fetch: ECONNREFUSED/);
  });

  it("retains coverage from the synthesis call", async () => {
    const result = await fetchInterface("https://api.example.com/", {
      fetch: nonObiFetch(),
      synthesizers: [coverageSynthesizer()],
    });
    expect(result.synthesized).toBe(true);
    expect(result.coverage?.exhaustive).toBe(true);
    expect(result.coverage?.fullyRepresented).toBe(true);
    expect(result.coverage?.entries).toHaveLength(1);
  });
});
