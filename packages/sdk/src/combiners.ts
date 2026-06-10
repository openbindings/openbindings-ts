import type { BindingInvoker, InterfaceCreator, SourceInspector } from "./invokers.js";
import type {
  BindingInvocationArgs,
  FormatInfo,
  CreateInput,
  SourceInspection,
} from "./invoker-types.js";
import type { ContextRequiredDetails, Invocation } from "./invocation.js";
import type { OBInterface, Source } from "./types.js";
import { type VersionRange, parseRange, matchesRange } from "./format-token.js";
import { formatName } from "./helpers.js";
import { NoInvokerError, NoCreatorError, NoSourcesError } from "./errors.js";

interface InvokerEntry {
  range: VersionRange;
  invoker: BindingInvoker;
  info: FormatInfo;
}

interface CreatorEntry {
  range: VersionRange;
  creator: InterfaceCreator;
  info: FormatInfo;
}

interface InspectorEntry {
  range: VersionRange;
  inspector: SourceInspector;
  info: FormatInfo;
}

/**
 * Returns a single BindingInvoker that routes to the appropriate inner
 * invoker based on the source format token. First match wins.
 */
export interface CombinedInvoker extends BindingInvoker {
  /** Register an additional invoker after construction. First match wins. */
  add(invoker: BindingInvoker): void;
  /** Always present on the combiner: routes to the inner invoker's preflight, or reports no requirement. */
  prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null>;
}

export function combineInvokers(...invokers: BindingInvoker[]): CombinedInvoker {
  const entries: InvokerEntry[] = [];
  const byName = new Map<string, number[]>();
  const allFormats: FormatInfo[] = [];

  function register(invoker: BindingInvoker): void {
    for (const info of invoker.formats()) {
      let range: VersionRange;
      try {
        range = parseRange(info.token);
      } catch {
        continue;
      }

      const idx = entries.length;
      entries.push({ range, invoker, info });

      const indices = byName.get(range.name);
      if (indices) {
        indices.push(idx);
      } else {
        byName.set(range.name, [idx]);
      }

      allFormats.push(info);
    }
  }

  for (const invoker of invokers) {
    register(invoker);
  }

  function findInvoker(sourceFormat: string): BindingInvoker | undefined {
    const name = formatName(sourceFormat);
    const indices = byName.get(name);
    if (!indices) return undefined;
    for (const idx of indices) {
      const entry = entries[idx];
      if (entry.info.token === sourceFormat || matchesRange(entry.range, sourceFormat)) {
        return entry.invoker;
      }
    }
    return undefined;
  }

  return {
    add: register,
    formats(): FormatInfo[] {
      return [...allFormats];
    },
    invokeBinding<I, O>(args: BindingInvocationArgs): Invocation<I, O> {
      const invoker = findInvoker(args.source.format);
      // A missing invoker is a wiring error, knowable synchronously: throw
      // rather than returning a pre-errored handle.
      if (!invoker) throw new NoInvokerError(args.source.format);
      return invoker.invokeBinding<I, O>(args);
    },
    async prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
      const invoker = findInvoker(args.source.format);
      if (!invoker) throw new NoInvokerError(args.source.format);
      // An invoker without preflight support simply reports no requirement.
      return invoker.prepareBinding ? invoker.prepareBinding(args) : null;
    },
  };
}

/**
 * Returns a single InterfaceCreator that routes to the appropriate inner
 * creator based on the source format token. First match wins.
 */
export function combineCreators(...creators: InterfaceCreator[]): InterfaceCreator {
  const entries: CreatorEntry[] = [];
  const byName = new Map<string, number[]>();
  const allFormats: FormatInfo[] = [];

  for (const creator of creators) {
    for (const info of creator.formats()) {
      let range: VersionRange;
      try {
        range = parseRange(info.token);
      } catch {
        continue;
      }

      const idx = entries.length;
      entries.push({ range, creator, info });

      const indices = byName.get(range.name);
      if (indices) {
        indices.push(idx);
      } else {
        byName.set(range.name, [idx]);
      }

      allFormats.push(info);
    }
  }

  function findCreator(sourceFormat: string): InterfaceCreator | undefined {
    const name = formatName(sourceFormat);
    const indices = byName.get(name);
    if (!indices) return undefined;
    for (const idx of indices) {
      const entry = entries[idx];
      if (entry.info.token === sourceFormat || matchesRange(entry.range, sourceFormat)) {
        return entry.creator;
      }
    }
    return undefined;
  }

  return {
    formats(): FormatInfo[] {
      return [...allFormats];
    },
    async createInterface(
      input: CreateInput,
      options?: { signal?: AbortSignal },
    ): Promise<OBInterface> {
      if (!input.sources?.length) throw new NoSourcesError();
      const creator = findCreator(input.sources[0].format);
      if (!creator) throw new NoCreatorError(input.sources[0].format);
      return creator.createInterface(input, options);
    },
  };
}

/**
 * Returns a single SourceInspector that routes to the appropriate inner
 * inspector based on the source format token. First match wins.
 */
export function combineSourceInspectors(...inspectors: SourceInspector[]): SourceInspector {
  const entries: InspectorEntry[] = [];
  const byName = new Map<string, number[]>();
  const allFormats: FormatInfo[] = [];

  for (const inspector of inspectors) {
    for (const info of inspector.formats()) {
      let range: VersionRange;
      try {
        range = parseRange(info.token);
      } catch {
        continue;
      }

      const idx = entries.length;
      entries.push({ range, inspector, info });

      const indices = byName.get(range.name);
      if (indices) {
        indices.push(idx);
      } else {
        byName.set(range.name, [idx]);
      }

      allFormats.push(info);
    }
  }

  function findInspector(sourceFormat: string): SourceInspector | undefined {
    const name = formatName(sourceFormat);
    const indices = byName.get(name);
    if (!indices) return undefined;
    for (const idx of indices) {
      const entry = entries[idx];
      if (entry.info.token === sourceFormat || matchesRange(entry.range, sourceFormat)) {
        return entry.inspector;
      }
    }
    return undefined;
  }

  return {
    formats(): FormatInfo[] {
      return [...allFormats];
    },
    async inspectSource(
      source: Source,
      options?: { signal?: AbortSignal },
    ): Promise<SourceInspection> {
      const inspector = findInspector(source.format);
      if (!inspector) throw new NoCreatorError(source.format);
      return inspector.inspectSource(source, options);
    },
  };
}
