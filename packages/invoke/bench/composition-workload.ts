import type { OBInterface } from "@openbindings/core";
import type {
  BindingHandler,
  InterfaceProvider,
} from "../src/index.js";
import {
  HandlerBindingInvoker,
  OperationInvoker,
} from "../src/index.js";

export const BENCHMARK_BINDING_SPEC = "benchmark.local-handler@1";
export const BENCHMARK_LOCATION = "bench://providers/main";

export interface BenchmarkInput {
  readonly id: string;
  readonly payload: string;
}

export interface BenchmarkOutput {
  readonly id: string;
  readonly accepted: boolean;
}

export interface CompositionWorkload {
  readonly operationCount: number;
  readonly bindingsPerOperation: number;
  readonly consumer: OBInterface;
  readonly provider: OBInterface;
  readonly dependencyKeys: readonly string[];
  readonly consumerOperationKeys: readonly string[];
  readonly providerOperationKeys: readonly string[];
  readonly bindingKeys: readonly string[];
  readonly invoker: OperationInvoker;
  readonly candidate: InterfaceProvider;
}

function padded(index: number): string {
  return index.toString().padStart(5, "0");
}

function inputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      payload: { type: "string" },
    },
    required: ["id", "payload"],
    additionalProperties: false,
  };
}

function outputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      accepted: { type: "boolean" },
    },
    required: ["id", "accepted"],
    additionalProperties: false,
  };
}

const handler: BindingHandler<BenchmarkInput, BenchmarkOutput> = async handle => {
  for await (const input of handle.inputs()) {
    await handle.closeInput();
    await handle.emitOutput({ id: input.id, accepted: true });
    handle.closeOutput();
    return;
  }
  handle.closeOutput();
};

/**
 * Builds deterministic small/large composition workloads.
 *
 * Every consumer operation has one named dependency. Every provider operation
 * adopts the corresponding consumer key as an alias and has the requested
 * number of concrete bindings. This lets the same corpus exercise one named
 * dependency, every dependency, and multi-realization ambiguity without
 * relying on map insertion order for a semantic decision.
 */
export function createCompositionWorkload(
  operationCount: number,
  bindingsPerOperation = 1,
): CompositionWorkload {
  if (!Number.isSafeInteger(operationCount) || operationCount < 1) {
    throw new TypeError("operationCount must be a positive safe integer");
  }
  if (!Number.isSafeInteger(bindingsPerOperation) || bindingsPerOperation < 1) {
    throw new TypeError("bindingsPerOperation must be a positive safe integer");
  }

  const consumerOperations: OBInterface["operations"] = {};
  const providerOperations: OBInterface["operations"] = {};
  const dependencies: NonNullable<OBInterface["dependencies"]> = {};
  const bindings: NonNullable<OBInterface["bindings"]> = {};
  const dependencyKeys: string[] = [];
  const consumerOperationKeys: string[] = [];
  const providerOperationKeys: string[] = [];
  const bindingKeys: string[] = [];

  const bindingInvoker = new HandlerBindingInvoker({
    bindingSpec: BENCHMARK_BINDING_SPEC,
    description: "Node-only provider-composition benchmark binding",
  });

  for (let index = 0; index < operationCount; index++) {
    const suffix = padded(index);
    const consumerOperationKey = `benchmark.operation.${suffix}`;
    const providerOperationKey = `benchmark.provider.${suffix}`;
    const dependencyKey = `dependency.${suffix}`;

    consumerOperations[consumerOperationKey] = {
      input: inputSchema(),
      output: outputSchema(),
    };
    providerOperations[providerOperationKey] = {
      aliases: [consumerOperationKey],
      input: inputSchema(),
      output: outputSchema(),
    };
    dependencies[dependencyKey] = {
      operation: consumerOperationKey,
      bindingSpecs: [BENCHMARK_BINDING_SPEC],
    };

    dependencyKeys.push(dependencyKey);
    consumerOperationKeys.push(consumerOperationKey);
    providerOperationKeys.push(providerOperationKey);

    for (let bindingIndex = 0; bindingIndex < bindingsPerOperation; bindingIndex++) {
      const bindingKey = `binding.${suffix}.${padded(bindingIndex)}`;
      const selector = `handler.${suffix}.${padded(bindingIndex)}`;
      bindings[bindingKey] = {
        operation: providerOperationKey,
        source: "local",
        selector,
      };
      bindingKeys.push(bindingKey);
      bindingInvoker.register<BenchmarkInput, BenchmarkOutput>({
        location: BENCHMARK_LOCATION,
        selector,
        handler,
      });
    }
  }

  const consumer: OBInterface = {
    openbindings: "0.2.0",
    name: `benchmark consumer (${operationCount})`,
    operations: consumerOperations,
    dependencies,
  };
  const provider: OBInterface = {
    openbindings: "0.2.0",
    name: `benchmark provider (${operationCount}x${bindingsPerOperation})`,
    operations: providerOperations,
    sources: {
      local: {
        bindingSpec: BENCHMARK_BINDING_SPEC,
        location: BENCHMARK_LOCATION,
      },
    },
    bindings,
  };
  const invoker = new OperationInvoker([bindingInvoker]);
  const candidate: InterfaceProvider = {
    interface: provider,
    invoker,
    label: `provider-${operationCount}x${bindingsPerOperation}`,
  };

  return {
    operationCount,
    bindingsPerOperation,
    consumer,
    provider,
    dependencyKeys: Object.freeze(dependencyKeys),
    consumerOperationKeys: Object.freeze(consumerOperationKeys),
    providerOperationKeys: Object.freeze(providerOperationKeys),
    bindingKeys: Object.freeze(bindingKeys),
    invoker,
    candidate,
  };
}
