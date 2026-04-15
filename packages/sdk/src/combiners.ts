import type { BindingExecutor, InterfaceCreator } from "./executors.js";
import type {
  BindingExecutionInput,
  StreamEvent,
  FormatInfo,
  CreateInput,
  ListRefsResult,
} from "./executor-types.js";
import type { OBInterface, Source } from "./types.js";
import { type VersionRange, parseRange, matchesRange } from "./format-token.js";
import { formatName } from "./helpers.js";
import { NoExecutorError, NoCreatorError, NoSourcesError } from "./errors.js";

interface ExecutorEntry {
  range: VersionRange;
  executor: BindingExecutor;
  info: FormatInfo;
}

interface CreatorEntry {
  range: VersionRange;
  creator: InterfaceCreator;
  info: FormatInfo;
}

/**
 * Returns a single BindingExecutor that routes to the appropriate inner
 * executor based on the source format token. First match wins.
 */
export interface CombinedExecutor extends BindingExecutor {
  /** Register an additional executor after construction. First match wins. */
  add(executor: BindingExecutor): void;
}

export function combineExecutors(...executors: BindingExecutor[]): CombinedExecutor {
  const entries: ExecutorEntry[] = [];
  const byName = new Map<string, number[]>();
  const allFormats: FormatInfo[] = [];

  function register(exec: BindingExecutor): void {
    for (const info of exec.formats()) {
      let range: VersionRange;
      try {
        range = parseRange(info.token);
      } catch {
        continue;
      }

      const idx = entries.length;
      entries.push({ range, executor: exec, info });

      const indices = byName.get(range.name);
      if (indices) {
        indices.push(idx);
      } else {
        byName.set(range.name, [idx]);
      }

      allFormats.push(info);
    }
  }

  for (const exec of executors) {
    register(exec);
  }

  function findExecutor(sourceFormat: string): BindingExecutor | undefined {
    const name = formatName(sourceFormat);
    const indices = byName.get(name);
    if (!indices) return undefined;
    for (const idx of indices) {
      const entry = entries[idx];
      if (matchesRange(entry.range, sourceFormat)) {
        return entry.executor;
      }
    }
    // Name-only fallback: handles synthesis where the source format is the
    // executor's own range token rather than an exact version from an OBI.
    return indices.length > 0 ? entries[indices[0]].executor : undefined;
  }

  return {
    add: register,
    formats(): FormatInfo[] {
      return [...allFormats];
    },
    async *executeBinding(
      input: BindingExecutionInput,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<StreamEvent> {
      const exec = findExecutor(input.source.format);
      if (!exec) throw new NoExecutorError(input.source.format);
      yield* exec.executeBinding(input, options);
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
      if (matchesRange(entry.range, sourceFormat)) {
        return entry.creator;
      }
    }
    // Name-only fallback
    return indices.length > 0 ? entries[indices[0]].creator : undefined;
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
    async listBindableRefs(
      source: Source,
      options?: { signal?: AbortSignal },
    ): Promise<ListRefsResult> {
      const creator = findCreator(source.format);
      if (!creator) throw new NoCreatorError(source.format);
      if (!creator.listBindableRefs) {
        throw new Error(`Creator for format ${source.format} does not support ref listing`);
      }
      return creator.listBindableRefs(source, options);
    },
  };
}
