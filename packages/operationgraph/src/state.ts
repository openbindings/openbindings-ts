/**
 * Per-node state machines for buffer and combine (with lineage and root
 * tracking per the spec's merge rules), plus a per-Invoker compiled-schema
 * cache shared by filter and buffer schema matching.
 *
 * Each engine processes events serially within its own async loop, so the
 * shapes here just hold mutable state with no lock coordination.
 */
import { compileEmbeddedSchema, type CompiledSchema } from "@openbindings/core";
import type { Node } from "./types.js";

/**
 * Marks an event whose lineage root is undefined: it descends from a merge
 * whose contributors disagree on a root (or had none), so $input is unbound
 * during expression evaluation.
 */
export const NO_ROOT = -1;

/** Internal event flowing through the graph. */
export interface GraphEvent {
  /** Event payload. */
  data: unknown;
  /** Node key that produced this event (combine keys its snapshot on it). */
  source: string;
  /** Lineage root (index into the engine's root values); NO_ROOT = undefined $input. */
  root: number;
  /** Per-each-node invocation counts for maxIterations enforcement. */
  lineage: Map<string, number>;
  /** True when this is a completion marker rather than a data event. */
  complete: boolean;
  /** onError chain depth (defense-in-depth cap). */
  errorDepth: number;
}

export function newEvent(partial: Partial<GraphEvent> = {}): GraphEvent {
  return {
    data: partial.data,
    source: partial.source ?? "",
    root: partial.root ?? NO_ROOT,
    lineage: partial.lineage ?? new Map<string, number>(),
    complete: partial.complete ?? false,
    errorDepth: partial.errorDepth ?? 0,
  };
}

export function cloneEvent(ev: GraphEvent): GraphEvent {
  return {
    data: ev.data,
    source: ev.source,
    root: ev.root,
    lineage: new Map(ev.lineage),
    complete: ev.complete,
    errorDepth: ev.errorDepth,
  };
}

export function copyLineage(m: Map<string, number>): Map<string, number> {
  return new Map(m);
}

/**
 * Merges src into dst taking the element-wise maximum (the spec's lineage
 * merge rule: a merge never lowers a count).
 */
export function mergeMaxInto(dst: Map<string, number>, src: Map<string, number>): void {
  for (const [k, v] of src) {
    if (v > (dst.get(k) ?? 0)) dst.set(k, v);
  }
}

/**
 * Accumulates the merged lineage root across contributing events: defined
 * if and only if every contributor shares one root.
 */
export class RootTracker {
  private set = false;
  private root = NO_ROOT;
  private conflict = false;

  add(root: number): void {
    if (!this.set) {
      this.set = true;
      this.root = root;
      return;
    }
    if (this.root !== root) this.conflict = true;
  }

  merged(): number {
    if (!this.set || this.conflict || this.root === NO_ROOT) return NO_ROOT;
    return this.root;
  }
}

/**
 * One merge-node emission (a buffer flush's array or a combine snapshot's
 * object) plus the merged lineage and root of its contributors.
 */
export interface Batch {
  data: unknown;
  lineage: Map<string, number>;
  root: number;
}

/**
 * Tracks accumulated events for a buffer node: one accumulator instance per
 * graph invocation, accumulating across lineages.
 */
export class BufferState {
  private acc: unknown[] = [];
  private lineage = new Map<string, number>();
  private roots = new RootTracker();

  constructor(
    private readonly node: Node,
    private readonly schemas: SchemaCache,
  ) {}

  /**
   * Processes one incoming event per the spec's flush precedence: the event
   * is added, then limit is evaluated, then until/through — so an event that
   * both reaches the limit and matches until/through flushes as part of the
   * batch. An until-matched event is excluded and dropped (its lineage does
   * not merge into the batch).
   */
  add(ev: GraphEvent): Batch | null {
    const limitHit = this.node.limit !== undefined && this.acc.length + 1 >= this.node.limit;
    if (limitHit) {
      this.retain(ev);
      return this.takeBatch();
    }
    if (this.node.until !== undefined && this.schemas.match(this.node.until, ev.data)) {
      if (this.acc.length === 0) return null;
      return this.takeBatch();
    }
    if (this.node.through !== undefined && this.schemas.match(this.node.through, ev.data)) {
      this.retain(ev);
      return this.takeBatch();
    }
    this.retain(ev);
    return null;
  }

  /**
   * Returns any remaining partial batch on completion (null when empty — a
   * buffer that accumulated nothing emits nothing, not an empty array).
   */
  flush(): Batch | null {
    if (this.acc.length === 0) return null;
    return this.takeBatch();
  }

  private retain(ev: GraphEvent): void {
    this.acc.push(ev.data);
    mergeMaxInto(this.lineage, ev.lineage);
    this.roots.add(ev.root);
  }

  private takeBatch(): Batch {
    const b: Batch = { data: this.acc, lineage: this.lineage, root: this.roots.merged() };
    this.acc = [];
    this.lineage = new Map();
    this.roots = new RootTracker();
    return b;
  }
}

/**
 * Implements the spec's combine readiness rule: a combine node emits nothing
 * until every incoming source has produced at least one event or completed;
 * it then emits a combined object, and again on every subsequent event from
 * a still-active source. A source that completed without producing
 * contributes null. One instance per graph invocation.
 */
export class CombineState {
  private readonly latest = new Map<string, unknown>();
  private readonly lineages = new Map<string, Map<string, number>>();
  private readonly roots = new Map<string, number>();
  private readonly produced = new Set<string>();
  private readonly completed = new Set<string>();
  private ready = false;

  constructor(private readonly sources: string[]) {}

  /**
   * Records an event from a source. Returns a snapshot to emit when the node
   * is ready (every source produced-or-completed), null otherwise.
   */
  add(ev: GraphEvent): Batch | null {
    this.latest.set(ev.source, ev.data);
    this.lineages.set(ev.source, ev.lineage);
    this.roots.set(ev.source, ev.root);
    this.produced.add(ev.source);
    this.refreshReady();
    return this.ready ? this.snapshot() : null;
  }

  /**
   * Records one source's completion. When that completion is what makes the
   * node ready, returns the one readiness-triggered snapshot to emit (null
   * for every source that completed without producing).
   */
  sourceComplete(source: string): Batch | null {
    this.completed.add(source);
    if (this.ready) return null;
    this.refreshReady();
    return this.ready ? this.snapshot() : null;
  }

  private refreshReady(): void {
    for (const s of this.sources) {
      if (!this.produced.has(s) && !this.completed.has(s)) return;
    }
    this.ready = true;
  }

  private snapshot(): Batch {
    const obj: Record<string, unknown> = {};
    const lineage = new Map<string, number>();
    const roots = new RootTracker();
    for (const s of this.sources) {
      if (this.produced.has(s)) {
        obj[s] = this.latest.get(s);
        mergeMaxInto(lineage, this.lineages.get(s)!);
        roots.add(this.roots.get(s)!);
      } else {
        obj[s] = null;
      }
    }
    return { data: obj, lineage, root: roots.merged() };
  }
}

/**
 * Per-Invoker cache of compiled JSON schemas, keyed by the canonical JSON
 * representation of the schema. Filter and buffer nodes share this cache.
 */
export class SchemaCache {
  private readonly compiled = new Map<string, CompiledSchema>();

  /** Validates `data` against `schema`, compiling and caching on first use. */
  match(schema: unknown, data: unknown): boolean {
    const key = JSON.stringify(schema);
    let v = this.compiled.get(key);
    if (!v) {
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        throw new Error("embedded schema must be a JSON Schema object");
      }
      // format is an annotation at embedded-schema evaluation (Embedded
      // schemas; aligned with core §6.2) — compileEmbeddedSchema's
      // boundary draft is annotation-only natively. Embedded schemas are
      // self-contained by OG-V-18, so no compound/defs handling applies.
      v = compileEmbeddedSchema(schema);
      this.compiled.set(key, v);
    }
    try {
      return v.validate(data).valid;
    } catch {
      // The validator throws on inputs JSON can't represent (e.g. undefined):
      // treat as non-match so a filter with a strict schema drops them.
      return false;
    }
  }
}
