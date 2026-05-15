/**
 * Per-node state machines for buffer and combine, plus a per-Invoker
 * compiled-schema cache shared by filter and buffer schema matching.
 *
 * JavaScript is single-threaded, so unlike the Go port there are no
 * mutexes. Each engine processes events serially within its own
 * async loop; the shapes here just hold mutable state.
 */
import { Validator } from "@cfworker/json-schema";
import type { Node } from "./types.js";

/** Internal event flowing through the graph. */
export interface GraphEvent {
  /** Event payload. */
  data: unknown;
  /** Node key that produced this event (used by combine to key its snapshot). */
  source: string;
  /** Per-node iteration counts for maxIterations enforcement. */
  lineage: Map<string, number>;
  /** True when this is a completion marker rather than a data event. */
  complete: boolean;
  /** onError chain depth, bounded to prevent unbounded error processing. */
  errorDepth: number;
}

export function newEvent(partial: Partial<GraphEvent> = {}): GraphEvent {
  return {
    data: partial.data,
    source: partial.source ?? "",
    lineage: partial.lineage ?? new Map(),
    complete: partial.complete ?? false,
    errorDepth: partial.errorDepth ?? 0,
  };
}

export function cloneEvent(ev: GraphEvent): GraphEvent {
  return {
    data: ev.data,
    source: ev.source,
    lineage: new Map(ev.lineage),
    complete: ev.complete,
    errorDepth: ev.errorDepth,
  };
}

export function copyLineage(m: Map<string, number>): Map<string, number> {
  return new Map(m);
}

/**
 * Tracks accumulated events for a buffer node.
 *
 * Behavior:
 *   - `until` schema: when an event matches, flush the previously accumulated
 *     batch (excluding the matching event), and drop the matching event.
 *   - `through` schema: when an event matches, include it in the flushed batch.
 *   - `limit`: flush every N events as a sliding window.
 *   - No conditions: drain on completion only.
 */
export class BufferState {
  private acc: unknown[] = [];

  constructor(
    private readonly node: Node,
    private readonly schemas: SchemaCache,
  ) {}

  /** Process an incoming event and return any batches to flush. */
  add(ev: GraphEvent): unknown[][] {
    if (this.node.until !== undefined) {
      if (this.schemas.match(this.node.until, ev.data)) {
        if (this.acc.length === 0) return [];
        const batch = this.acc;
        this.acc = [];
        return [batch];
      }
    }

    if (this.node.through !== undefined) {
      this.acc.push(ev.data);
      if (this.schemas.match(this.node.through, ev.data)) {
        const batch = this.acc;
        this.acc = [];
        return [batch];
      }
      return [];
    }

    this.acc.push(ev.data);

    if (this.node.limit !== undefined && this.acc.length >= this.node.limit) {
      const batch = this.acc;
      this.acc = [];
      return [batch];
    }

    return [];
  }

  /** Flush remaining accumulated events on completion. */
  flush(): unknown[] | null {
    if (this.acc.length === 0) return null;
    const batch = this.acc;
    this.acc = [];
    return batch;
  }
}

/**
 * Tracks the latest event from each source for a combine node and emits a
 * snapshot every time any source produces a new event (combineLatest
 * semantics). Sources that have not yet produced an event appear as null.
 */
export class CombineState {
  private readonly expected: Set<string>;
  private readonly latest = new Map<string, unknown>();
  private readonly has = new Set<string>();

  constructor(sources: string[]) {
    this.expected = new Set(sources);
  }

  /** Record an event and return the combined snapshot to emit. */
  add(ev: GraphEvent): Record<string, unknown> {
    this.latest.set(ev.source, ev.data);
    this.has.add(ev.source);
    return this.snapshot();
  }

  /**
   * Called when all upstream sources are done. The engine handles combine's
   * completion through normal propagation; nothing to emit here.
   */
  complete(): Record<string, unknown> | null {
    return null;
  }

  private snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const source of this.expected) {
      out[source] = this.has.has(source) ? this.latest.get(source) ?? null : null;
    }
    return out;
  }
}

/**
 * Per-Invoker cache of compiled JSON schemas, keyed by the canonical JSON
 * representation of the schema. Filter and buffer nodes share this cache.
 */
export class SchemaCache {
  private readonly compiled = new Map<string, Validator>();

  /** Validate `data` against `schema`, compiling and caching on first use. */
  match(schema: unknown, data: unknown): boolean {
    const key = JSON.stringify(schema);
    let v = this.compiled.get(key);
    if (!v) {
      // Validator does not accept a primitive root schema. Operation graph
      // filter schemas are always JSON Schema objects per the spec.
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        throw new Error("filter schema must be a JSON Schema object");
      }
      v = new Validator(schema as object, "2020-12");
      this.compiled.set(key, v);
    }
    try {
      const result = v.validate(data);
      return result.valid;
    } catch {
      // Validation library may throw on inputs that JSON cannot represent
      // (e.g., undefined). Treat as non-match — equivalent to Go's
      // "validation failed = event doesn't match".
      return false;
    }
  }
}
