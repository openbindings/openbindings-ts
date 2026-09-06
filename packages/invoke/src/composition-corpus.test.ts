import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  prepareInterface,
  type BindingSpecInfo,
  type OBInterface,
} from "@openbindings/core";
import { CompositionSession } from "./composition-session.js";
import { REFERENCE_COMPOSITION_POLICY_ID } from "./composition-policy.js";
import { InvocationImpl } from "./invocation.js";
import {
  prepareProvider,
  type CompiledRealizationBehavior,
  type ProviderRuntime,
} from "./prepared-provider.js";

interface CorpusProvider {
  readonly key: string;
  readonly preference: number;
  readonly runtimeBindingSpecs: readonly string[];
  readonly interface: OBInterface;
}

interface CorpusCase {
  readonly id: string;
  readonly consumer: OBInterface;
  readonly providers: readonly CorpusProvider[];
  readonly dependency: string;
  readonly invocation?: { readonly input: unknown; readonly output: unknown };
  readonly expected: {
    readonly status: "available" | "ambiguous" | "unavailable";
    readonly providerKey?: string;
    readonly bindingKey?: string;
    readonly ambiguityStage?: "provider" | "realization";
    readonly assessmentCodes: readonly string[];
  };
}

interface Corpus {
  readonly formatVersion: string;
  readonly policyId: string;
  readonly cases: readonly CorpusCase[];
}

const localURL = new URL("./testdata/runtime-composition-v1.json", import.meta.url);
const localBytes = readFileSync(localURL);
const corpus = JSON.parse(localBytes.toString("utf8")) as Corpus;

class CorpusRuntime implements ProviderRuntime {
  constructor(readonly specs: readonly string[]) {}

  bindingSpecs(): BindingSpecInfo[] {
    return this.specs.map(bindingSpec => ({ bindingSpec }));
  }

  compileOperationHandle<I, O>(): CompiledRealizationBehavior<I, O> {
    return {
      invoke: () => {
        const invocation = new InvocationImpl<I, O>();
        queueMicrotask(() => {
          void (async () => {
            const input = await invocation.inputs()[Symbol.asyncIterator]().next();
            await invocation.closeInput();
            if (!input.done) await invocation.emitOutput(input.value as unknown as O);
            invocation.closeOutput();
          })();
        });
        return invocation;
      },
      preflight: async () => null,
    };
  }
}

describe("portable runtime composition corpus", () => {
  it("is the byte-identical interfaces source corpus when the sibling checkout exists", () => {
    const authoritative = new URL(
      "../../../../interfaces/conformance/composition/cases.json",
      import.meta.url,
    );
    if (existsSync(authoritative)) {
      expect(readFileSync(authoritative)).toEqual(localBytes);
    }
  });

  it("pins the reference policy identifier", () => {
    expect(corpus.formatVersion).toBe("1.0.0");
    expect(corpus.policyId).toBe(REFERENCE_COMPOSITION_POLICY_ID);
  });

  for (const scenario of corpus.cases) {
    it(scenario.id, async () => {
      const consumer = await prepareInterface(scenario.consumer);
      const providers = await Promise.all(scenario.providers.map(async candidate => ({
        provider: await prepareProvider({
          key: candidate.key,
          interface: candidate.interface,
          runtime: new CorpusRuntime(candidate.runtimeBindingSpecs),
        }),
        preference: candidate.preference,
      })));
      const result = await new CompositionSession({ consumer, providers })
        .resolve(scenario.dependency);

      expect(result.status).toBe(scenario.expected.status);
      if (result.status === "available") {
        expect(result.route.providerKey).toBe(scenario.expected.providerKey);
        expect(result.route.bindingKey).toBe(scenario.expected.bindingKey);
        if (scenario.invocation) {
          const call = result.route.invoke();
          await call.write(scenario.invocation.input);
          await expect(call.outputs[Symbol.asyncIterator]().next()).resolves.toEqual({
            done: false,
            value: scenario.invocation.output,
          });
        }
      } else if (result.status === "ambiguous") {
        expect(result.ambiguity.stage).toBe(scenario.expected.ambiguityStage);
      } else {
        expect(result.assessments.map(assessment => assessment.code))
          .toEqual(scenario.expected.assessmentCodes);
      }
    });
  }
});
