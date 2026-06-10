/**
 * Operation graph execution engine.
 *
 * Each node is an async task with its own {@link AsyncQueue} mailbox; the
 * engine routes data and completion events through those queues. Cancellation
 * is via `AbortSignal`; per-node timeouts race an AbortController against
 * `setTimeout`.
 *
 * Correctness invariants:
 *
 *   - **Exit short-circuit**: when an exit node fires, every in-flight node
 *     execution returns without emitting downstream events.
 *   - **maxIterations is per-event lineage**: each event carries its own
 *     lineage map; operation nodes increment their key before invoking and
 *     drop the event when the count reaches the limit.
 *   - **onError routing**: a node failure routes a wrapped error event to
 *     `onError`. Without `onError`, the error is silently dropped. Error
 *     propagation depth is bounded by {@link maxErrorDepth}.
 *   - **Completion propagation**: when a node has heard "complete" from each
 *     of its incoming edges, it (a) flushes buffer/combine state if any,
 *     then (b) propagates "complete" downstream. Completion travels through
 *     the same mailbox as data events to preserve FIFO ordering.
 *   - **Event amplification limit**: a global counter rejects executions
 *     that exceed {@link maxEvents}; map nodes inside cycles are the primary
 *     amplification vector.
 */
import type {
  BindingHandle,
  BindingInvocationArgs,
  OperationInvoker,
  TransformEvaluator,
} from "@openbindings/sdk";
import {
  ERR_EVENT_LIMIT_EXCEEDED,
  ERR_MAP_NOT_ARRAY,
  ERR_OPERATION_GRAPH_EXIT,
  ERR_VALIDATION_FAILED,
  InvocationError,
  isTransformEvaluatorWithBindings,
} from "@openbindings/sdk";
import type { Graph, Node } from "./types.js";
import { validate } from "./validate.js";
import {
  BufferState,
  CombineState,
  cloneEvent,
  copyLineage,
  newEvent,
  type GraphEvent,
  type SchemaCache,
} from "./state.js";

/**
 * Maximum number of data events processed per graph invocation. Primarily
 * protects against map-in-cycle amplification.
 */
export const MAX_EVENTS = 100_000;

/** Maximum depth of onError routing chains. */
export const MAX_ERROR_DEPTH = 32;

/**
 * A FIFO async queue used for per-node mailboxes. `push` is non-blocking;
 * `next` resolves when an item arrives. `close` signals end-of-stream;
 * subsequent `next` calls return `{ done: true }` once the buffer drains.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({ value: this.buffer.shift()!, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }
}

interface EngineDeps {
  graph: Graph;
  invoker: OperationInvoker;
  /** The binding invocation that started this graph (carries interface/context). */
  args: BindingInvocationArgs;
  /** The graph's initial input event data (already read off the handle). */
  input: unknown;
  transform?: TransformEvaluator;
  schemas: SchemaCache;
}

/**
 * Runs a single operation graph invocation against a {@link BindingHandle}.
 * Spawn-once: call {@link run} once; it resolves when the graph has
 * terminated (normal completion, exit node, error, or cancellation).
 */
export class Engine {
  private readonly graph: Graph;
  private readonly invoker: OperationInvoker;
  private readonly args: BindingInvocationArgs;
  private readonly transform?: TransformEvaluator;
  private readonly schemas: SchemaCache;
  private readonly origInput: unknown;

  private readonly outEdges = new Map<string, string[]>();
  private readonly inEdges = new Map<string, string[]>();
  private inputKey = "";

  private handle!: BindingHandle<unknown, unknown>;
  private exitFlag = false;
  private inflight = 0;
  private eventCount = 0;
  private finished = false;
  private readonly abortController = new AbortController();

  /** Mailboxes — one FIFO per node. */
  private readonly mailboxes = new Map<string, AsyncQueue<GraphEvent>>();
  /** Buffer state — one per buffer node. */
  private readonly bufferStates = new Map<string, BufferState>();
  /** Combine state — one per combine node. */
  private readonly combineStates = new Map<string, CombineState>();
  /** Per-node count of "complete" markers received from upstream. */
  private readonly completedSources = new Map<string, number>();

  constructor(deps: EngineDeps) {
    this.graph = deps.graph;
    this.invoker = deps.invoker;
    this.args = deps.args;
    this.transform = deps.transform;
    this.schemas = deps.schemas;
    this.origInput = deps.input;

    for (const e of this.graph.edges ?? []) {
      const o = this.outEdges.get(e.from);
      if (o) o.push(e.to);
      else this.outEdges.set(e.from, [e.to]);
      const i = this.inEdges.get(e.to);
      if (i) i.push(e.from);
      else this.inEdges.set(e.to, [e.from]);
    }
    for (const [k, n] of Object.entries(this.graph.nodes)) {
      if (n.type === "input") this.inputKey = k;
    }
  }

  /**
   * Runs the graph, emitting outputs on `handle` and terminating it
   * (`closeOutput` on completion, `fireError` on terminal failure).
   * Cancellation arrives via `handle.signal` and aborts execution.
   */
  async run(handle: BindingHandle<unknown, unknown>): Promise<void> {
    this.handle = handle;

    // Validate before executing. When `interface` is absent on the args
    // (direct binding invocation via host), skip the operation-key check —
    // bad references will fail at runtime.
    let opKeys: Set<string> | undefined;
    if (this.args.interface) {
      opKeys = new Set(Object.keys(this.args.interface.operations));
    }
    try {
      validate(this.graph, opKeys);
    } catch (err) {
      handle.fireError(new InvocationError(ERR_VALIDATION_FAILED, (err as Error).message));
      return;
    }

    // Tie the invocation's cancellation signal to ours.
    if (handle.signal.aborted) this.abortController.abort();
    else handle.signal.addEventListener("abort", () => this.abortController.abort(), { once: true });
    // When abort fires (from exit node, event-limit, or cancellation),
    // close all mailboxes so workers waiting on next() can exit.
    this.abortController.signal.addEventListener("abort", () => this.shutdown(), { once: true });

    // Allocate mailboxes and per-node state.
    for (const key of Object.keys(this.graph.nodes)) {
      this.mailboxes.set(key, new AsyncQueue<GraphEvent>());
      const node = this.graph.nodes[key];
      if (node.type === "buffer") this.bufferStates.set(key, new BufferState(node, this.schemas));
      if (node.type === "combine") this.combineStates.set(key, new CombineState(this.inEdges.get(key) ?? []));
      if ((this.inEdges.get(key) ?? []).length > 0) this.completedSources.set(key, 0);
    }

    // Spawn one worker task per node.
    const workers = Object.entries(this.graph.nodes).map(([key, node]) =>
      this.runNode(key, node),
    );

    // Inject the initial event into the input node.
    this.incInflight();
    this.mailboxes.get(this.inputKey)!.push(
      newEvent({ data: this.origInput, lineage: new Map() }),
    );

    await Promise.all(workers);
    this.finishOnce();
    // Normal completion. A no-op when a terminal error already fired
    // (exit error, event limit, cancellation).
    handle.closeOutput();
  }

  private async runNode(key: string, node: Node): Promise<void> {
    const mailbox = this.mailboxes.get(key)!;
    for (;;) {
      if (this.abortController.signal.aborted) return;
      const next = await mailbox.next();
      if (next.done) return;
      const ev = next.value;
      if (this.exitFlag) {
        this.decInflight();
        // Drain remaining events without processing them.
        continue;
      }
      await this.processNode(key, node, ev);
      this.decInflight();
    }
  }

  private finishOnce(): void {
    if (this.finished) return;
    this.finished = true;
    this.shutdown();
  }

  /** Closes all mailboxes. Idempotent. */
  private shutdown(): void {
    for (const mb of this.mailboxes.values()) mb.close();
  }

  private incInflight(): void {
    this.inflight++;
  }

  private decInflight(): void {
    this.inflight--;
    if (this.inflight === 0) this.finishOnce();
  }

  /**
   * Emits one output on the handle, honoring backpressure. A rejected emit
   * means the invocation terminated (cancelled or abandoned); stop the
   * engine — there is no one left to deliver to.
   */
  private async emitToCaller(data: unknown): Promise<void> {
    try {
      await this.handle.emitOutput(data);
    } catch {
      this.exitFlag = true;
      this.abortController.abort();
    }
  }

  private sendToNode(toKey: string, ev: GraphEvent): void {
    this.incInflight();
    const mb = this.mailboxes.get(toKey);
    if (!mb) {
      // Should never happen for validated graphs; guard anyway.
      this.decInflight();
      return;
    }
    mb.push(ev);
  }

  private sendDownstream(fromKey: string, ev: GraphEvent): void {
    for (const toKey of this.outEdges.get(fromKey) ?? []) {
      if (this.exitFlag) return;
      const c = cloneEvent(ev);
      c.source = fromKey;
      this.sendToNode(toKey, c);
    }
  }

  /**
   * Routes completion markers through the same mailbox as data events so
   * FIFO ordering preserves the "all data first, then complete" invariant.
   */
  private sendCompletion(fromKey: string): void {
    for (const toKey of this.outEdges.get(fromKey) ?? []) {
      if (this.exitFlag) return;
      this.sendToNode(toKey, newEvent({ source: fromKey, complete: true }));
    }
  }

  private sendError(
    nodeKey: string,
    errMsg: string,
    input: unknown,
    lineage: Map<string, number>,
    errorDepth: number,
  ): void {
    const node = this.graph.nodes[nodeKey];
    if (!node.onError) return;
    if (errorDepth >= MAX_ERROR_DEPTH) return;
    this.sendToNode(
      node.onError,
      newEvent({
        data: { error: errMsg, input },
        source: nodeKey,
        lineage: copyLineage(lineage),
        errorDepth: errorDepth + 1,
      }),
    );
  }

  /**
   * Processes a completion marker arriving at a node. When all upstream
   * sources have completed, flushes any per-node state and propagates
   * completion downstream.
   */
  private handleCompletion(key: string, node: Node): void {
    const prev = this.completedSources.get(key);
    if (prev === undefined) return;
    const newCount = prev + 1;
    this.completedSources.set(key, newCount);
    const required = (this.inEdges.get(key) ?? []).length;
    if (newCount < required) return;

    if (node.type === "buffer") {
      const batch = this.bufferStates.get(key)!.flush();
      if (batch !== null) {
        this.sendDownstream(
          key,
          newEvent({ data: batch, source: key, lineage: new Map() }),
        );
      }
    } else if (node.type === "combine") {
      const result = this.combineStates.get(key)!.complete();
      if (result !== null) {
        this.sendDownstream(
          key,
          newEvent({ data: result, source: key, lineage: new Map() }),
        );
      }
    }
    this.sendCompletion(key);
  }

  private async processNode(key: string, node: Node, ev: GraphEvent): Promise<void> {
    if (ev.complete) {
      this.handleCompletion(key, node);
      return;
    }

    // Event amplification bound.
    if (++this.eventCount > MAX_EVENTS) {
      this.exitFlag = true;
      this.handle.fireError(
        new InvocationError(
          ERR_EVENT_LIMIT_EXCEEDED,
          `exceeded maximum event count (${MAX_EVENTS})`,
        ),
      );
      this.abortController.abort();
      return;
    }

    switch (node.type) {
      case "input":
        this.sendDownstream(key, ev);
        this.sendCompletion(key);
        return;

      case "output":
        await this.emitToCaller(ev.data);
        return;

      case "exit": {
        this.exitFlag = true;
        if (node.error === true) {
          this.handle.fireError(
            new InvocationError(ERR_OPERATION_GRAPH_EXIT, stringify(ev.data)),
          );
        } else {
          await this.emitToCaller(ev.data);
        }
        this.abortController.abort();
        return;
      }

      case "operation":
        await this.processOperation(key, node, ev);
        return;

      case "filter":
        await this.processFilter(key, node, ev);
        return;

      case "transform":
        await this.processTransform(key, node, ev);
        return;

      case "map":
        await this.processMap(key, node, ev);
        return;

      case "buffer": {
        const bs = this.bufferStates.get(key)!;
        for (const batch of bs.add(ev)) {
          this.sendDownstream(
            key,
            newEvent({ data: batch, source: key, lineage: new Map() }),
          );
        }
        return;
      }

      case "combine": {
        const cs = this.combineStates.get(key)!;
        const result = cs.add(ev);
        this.sendDownstream(
          key,
          newEvent({ data: result, source: key, lineage: new Map() }),
        );
        return;
      }
    }
  }

  private async processOperation(key: string, node: Node, ev: GraphEvent): Promise<void> {
    // Check maxIterations on a copy of the lineage; mutate the copy.
    const lineage = copyLineage(ev.lineage);
    if (node.maxIterations !== undefined) {
      const count = lineage.get(key) ?? 0;
      if (count >= node.maxIterations) return; // safety bound, not an error
      lineage.set(key, count + 1);
    }

    // Per-call AbortController so a timeout cancels just this operation.
    // Tied to the engine's controller so cancelling the graph cancels
    // in-flight sub-operations.
    const opCtrl = new AbortController();
    const onAbort = (): void => opCtrl.abort();
    this.abortController.signal.addEventListener("abort", onAbort, { once: true });
    if (this.abortController.signal.aborted) opCtrl.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (node.timeout !== undefined) {
      timer = setTimeout(() => opCtrl.abort(), node.timeout);
    }

    try {
      // invoke throws synchronously on wiring/document errors (unknown
      // operation, binding, or source); those route to onError like any
      // other node failure.
      const call = this.invoker.invoke({
        interface: this.args.interface!,
        operation: node.operation!,
        context: this.args.context,
        signal: opCtrl.signal,
      });
      // One initial event in; close is idempotent and safe even when the
      // binding already closed input (no-input / unary). Rejections here
      // are expected noise — terminal failures surface on the outputs
      // iteration below.
      try {
        if (ev.data !== undefined) await call.write(ev.data);
        await call.close();
      } catch {
        /* surfaces via outputs */
      }
      for await (const out of call.outputs) {
        // Abandoning the iteration (exit fired) cancels the sub-call via
        // the iterator's return().
        if (this.exitFlag) return;
        this.sendDownstream(
          key,
          newEvent({
            data: out,
            source: key,
            lineage: copyLineage(lineage),
          }),
        );
      }
    } catch (err) {
      this.sendError(key, (err as Error).message, ev.data, ev.lineage, ev.errorDepth);
    } finally {
      if (timer) clearTimeout(timer);
      this.abortController.signal.removeEventListener("abort", onAbort);
    }
  }

  private async processFilter(key: string, node: Node, ev: GraphEvent): Promise<void> {
    if (node.schema !== undefined) {
      try {
        const passes = this.schemas.match(node.schema, ev.data);
        if (passes) this.sendDownstream(key, ev);
      } catch (err) {
        this.sendError(key, (err as Error).message, ev.data, ev.lineage, ev.errorDepth);
      }
      return;
    }
    if (node.transform !== undefined) {
      if (!this.transform) {
        this.sendError(key, "no transform evaluator available", ev.data, ev.lineage, ev.errorDepth);
        return;
      }
      try {
        const result = await this.evaluateTransform(node.transform, ev.data);
        if (isTruthy(result)) this.sendDownstream(key, ev);
      } catch (err) {
        this.sendError(key, (err as Error).message, ev.data, ev.lineage, ev.errorDepth);
      }
    }
  }

  private async processTransform(key: string, node: Node, ev: GraphEvent): Promise<void> {
    if (!this.transform) {
      this.sendError(key, "no transform evaluator available", ev.data, ev.lineage, ev.errorDepth);
      return;
    }
    try {
      const result = await this.evaluateTransform(node.transform!, ev.data);
      this.sendDownstream(
        key,
        newEvent({ data: result, source: key, lineage: copyLineage(ev.lineage) }),
      );
    } catch (err) {
      this.sendError(key, (err as Error).message, ev.data, ev.lineage, ev.errorDepth);
    }
  }

  private async processMap(key: string, node: Node, ev: GraphEvent): Promise<void> {
    if (!this.transform) {
      this.sendError(key, "no transform evaluator available", ev.data, ev.lineage, ev.errorDepth);
      return;
    }
    let result: unknown;
    try {
      result = await this.evaluateTransform(node.transform!, ev.data);
    } catch (err) {
      this.sendError(key, (err as Error).message, ev.data, ev.lineage, ev.errorDepth);
      return;
    }
    const arr = toArray(result);
    if (!arr) {
      // Error message is the literal error code so callers can match on text.
      this.sendError(key, ERR_MAP_NOT_ARRAY, ev.data, ev.lineage, ev.errorDepth);
      return;
    }
    for (const item of arr) {
      if (this.exitFlag) return;
      this.sendDownstream(
        key,
        newEvent({ data: item, source: key, lineage: copyLineage(ev.lineage) }),
      );
    }
  }

  private async evaluateTransform(expression: string, data: unknown): Promise<unknown> {
    if (this.transform && isTransformEvaluatorWithBindings(this.transform)) {
      return this.transform.evaluateWithBindings(expression, data, {
        input: this.origInput,
      });
    }
    return this.transform!.evaluate(expression, data);
  }
}

/** Truthiness rule for filter-expression results: false on null/undefined,
 *  false on the value-typed empty cases (false, 0, ""); everything else is
 *  truthy. Object/array values are always truthy regardless of contents. */
function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return true;
}

/**
 * Returns `v` as an array if it is one, or `null` otherwise. The Go version
 * round-trips through JSON to handle arbitrary typed slices; in JS the only
 * useful case is the plain `Array` check.
 */
function toArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

/** Best-effort fmt.Sprintf("%v", ev.data) for exit-error messages. */
function stringify(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
