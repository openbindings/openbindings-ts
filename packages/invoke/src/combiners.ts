import { checkBindingSpecs as unsupportedVerdicts } from "@openbindings/core";
import type { BindingSpecInfo, BindingSpecVerdict } from "@openbindings/core";
import { isBindingCompiler, type BindingInvoker, type CompiledBindingInvoker } from "./invokers.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { ContextRequiredDetails, Invocation } from "./invocation.js";
import { NoInvokerError } from "./errors.js";

/**
 * Returns a single BindingInvoker that routes to the appropriate inner
 * invoker by the source's binding-specification identifier. Identifiers are
 * exact and opaque (core §6): matching is string equality, never
 * version-range interpretation. First registration wins for a given
 * identifier; order matters.
 */
export interface CombinedInvoker extends BindingInvoker {
  /** Register an additional invoker after construction. First registration wins per identifier. */
  add(invoker: BindingInvoker): void;
  /** Always present on the combiner: routes to the inner invoker's preflight, or reports no requirement. */
  prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null>;
  /** Selects and optionally compiles the exact binding runtime once. */
  compileBinding(args: BindingInvocationArgs): CompiledBindingInvoker;
}

export function combineInvokers(...invokers: BindingInvoker[]): CombinedInvoker {
  const registered: BindingInvoker[] = [];
  const specs: BindingSpecInfo[] = [];
  const listed = new Set<string>();

  function register(invoker: BindingInvoker): void {
    registered.push(invoker);
    for (const info of invoker.bindingSpecs()) {
      if (listed.has(info.bindingSpec)) continue;
      listed.add(info.bindingSpec);
      specs.push(info);
    }
  }

  for (const invoker of invokers) {
    register(invoker);
  }

  function supportingInvoker(bindingSpec: string): BindingInvoker | undefined {
    return registered.find((invoker) => {
      const verdict = invoker.checkBindingSpecs([bindingSpec])[0];
      return verdict?.bindingSpec === bindingSpec && verdict.supported === true;
    });
  }

  return {
    add: register,
    checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
      const verdicts = unsupportedVerdicts(bindingSpecs, []);
      const bySpec = new Map(verdicts.map((verdict) => [verdict.bindingSpec, verdict]));
      const requested = verdicts.map(({ bindingSpec }) => bindingSpec);
      for (const invoker of registered) {
        for (const verdict of invoker.checkBindingSpecs(requested)) {
          const combined = bySpec.get(verdict.bindingSpec);
          if (combined && verdict.supported === true) combined.supported = true;
        }
      }
      return verdicts;
    },
    bindingSpecs(): BindingSpecInfo[] {
      return [...specs];
    },
    invokeBinding<I, O>(args: BindingInvocationArgs): Invocation<I, O> {
      const invoker = supportingInvoker(args.source.bindingSpec);
      // A missing invoker is a wiring error, knowable synchronously: throw
      // rather than returning a pre-errored handle.
      if (!invoker) throw new NoInvokerError(args.source.bindingSpec);
      return invoker.invokeBinding<I, O>(args);
    },
    async prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
      const invoker = supportingInvoker(args.source.bindingSpec);
      if (!invoker) throw new NoInvokerError(args.source.bindingSpec);
      // An invoker without preflight support simply reports no requirement.
      return invoker.prepareBinding ? invoker.prepareBinding(args) : null;
    },
		compileBinding(args: BindingInvocationArgs): CompiledBindingInvoker {
			const invoker = supportingInvoker(args.source.bindingSpec);
      if (!invoker) throw new NoInvokerError(args.source.bindingSpec);
      if (isBindingCompiler(invoker)) return invoker.compileBinding(args);
      return Object.freeze({
        invokeBinding<I, O>(dynamicArgs: BindingInvocationArgs): Invocation<I, O> {
          return invoker.invokeBinding<I, O>(dynamicArgs);
        },
        async prepareBinding(dynamicArgs: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
          return invoker.prepareBinding ? invoker.prepareBinding(dynamicArgs) : null;
        },
      });
    },
  };
}
