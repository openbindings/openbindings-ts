import type { BindingInvoker, InterfaceSynthesizer, SourceInspector } from "./invokers.js";
import type {
  BindingInvocationArgs,
  FormatInfo,
  SynthesizeInput,
  SourceInspection,
} from "./invoker-types.js";
import type { ContextRequiredDetails, Invocation } from "./invocation.js";
import type { OBInterface, Source } from "./types.js";
import { type VersionRange, parseRange, matchesRange } from "./format-token.js";
import { formatName } from "./helpers.js";
import { NoInvokerError, NoSynthesizerError, NoSourcesError } from "./errors.js";

interface InvokerEntry {
  range: VersionRange;
  invoker: BindingInvoker;
  info: FormatInfo;
}

interface SynthesizerEntry {
  range: VersionRange;
  synthesizer: InterfaceSynthesizer;
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
 * Returns a single InterfaceSynthesizer that routes to the appropriate inner
 * synthesizer based on the source format token. First match wins.
 */
export function combineSynthesizers(...synthesizers: InterfaceSynthesizer[]): InterfaceSynthesizer {
  const entries: SynthesizerEntry[] = [];
  const byName = new Map<string, number[]>();
  const allFormats: FormatInfo[] = [];

  for (const synthesizer of synthesizers) {
    for (const info of synthesizer.formats()) {
      let range: VersionRange;
      try {
        range = parseRange(info.token);
      } catch {
        continue;
      }

      const idx = entries.length;
      entries.push({ range, synthesizer, info });

      const indices = byName.get(range.name);
      if (indices) {
        indices.push(idx);
      } else {
        byName.set(range.name, [idx]);
      }

      allFormats.push(info);
    }
  }

  function findSynthesizer(sourceFormat: string): InterfaceSynthesizer | undefined {
    const name = formatName(sourceFormat);
    const indices = byName.get(name);
    if (!indices) return undefined;
    for (const idx of indices) {
      const entry = entries[idx];
      if (entry.info.token === sourceFormat || matchesRange(entry.range, sourceFormat)) {
        return entry.synthesizer;
      }
    }
    return undefined;
  }

  return {
    formats(): FormatInfo[] {
      return [...allFormats];
    },
    async synthesizeInterface(
      input: SynthesizeInput,
      options?: { signal?: AbortSignal },
    ): Promise<OBInterface> {
      if (!input.sources?.length) throw new NoSourcesError();
      const synthesizer = findSynthesizer(input.sources[0].format);
      if (!synthesizer) throw new NoSynthesizerError(input.sources[0].format);
      return synthesizer.synthesizeInterface(input, options);
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
      if (!inspector) throw new NoSynthesizerError(source.format);
      return inspector.inspectSource(source, options);
    },
  };
}
