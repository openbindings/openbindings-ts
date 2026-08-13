/**
 * Operation graph execution engine (the transparency rewrite).
 *
 * Each node is an async task with its own {@link AsyncQueue} mailbox; the
 * engine routes data and completion events through those queues.
 *
 * Semantics implemented:
 *   - `operation` is the conduit: one held invocation per graph invocation.
 *     Arriving events are written into it in order; when the inner binding
 *     closes its input from below the node becomes non-accepting and later
 *     events are WRITE_REJECTED error events. An unhandled terminal error on
 *     the held invocation terminates the graph invocation with that error
 *     (the identity law's terminal-status clause); onError opts it into
 *     in-graph handling.
 *   - `each` opens one single-write invocation per arriving event;
 *     `maxIterations` bounds it per event lineage; failures are per-event.
 *   - Caller writes stream through the input node, each rooting a lineage;
 *     back-closure closes the caller-facing input side once every direct
 *     consumer of the input node is a non-accepting conduit.
 *   - `$input` is the lineage root; merge nodes (buffer, combine, the
 *     conduit) take the element-wise max of lineage counts and keep a root
 *     only when all contributors share one.
 *   - Completion propagates per edge exactly once; at quiescence (no events
 *     or inner invocations in flight, input closed) the engine injects any
 *     undelivered edge completions — the spec's implementation-defined drain
 *     detection for cycles (and error-route-fed merges).
 */
import type {
  BindingHandle,
  BindingInvocationArgs,
  Invocation,
  OperationInvoker,
  TransformEvaluator,
} from "@openbindings/sdk";
import {
  ERR_CANCELLED,
  ERR_EVENT_LIMIT_EXCEEDED,
  ERR_INPUT_CLOSED,
  ERR_OPERATION_GRAPH_EXIT,
  InvocationError,
  isTransformEvaluatorWithBindings,
  operationSignature,
} from "@openbindings/sdk";
import {
  EXPRESSION_EVALUATION_FAILED,
  MAP_NOT_ARRAY,
  TIMEOUT_EXCEEDED,
  TRANSFORM_UNDEFINED,
  WRITE_REJECTED,
} from "./constants.js";
import type { Graph, Node } from "./types.js";
import {
  BufferState,
  CombineState,
  NO_ROOT,
  RootTracker,
  SchemaCache,
  cloneEvent,
  copyLineage,
  mergeMaxInto,
  newEvent,
  type GraphEvent,
} from "./state.js";

/**
 * Maximum number of data events processed per graph invocation (the spec's
 * SHOULD-level amplification backstop; map-in-cycle is the primary vector).
 */
export const MAX_EVENTS = 100_000;

/**
 * Maximum depth of onError routing chains, as defense in depth. The
 * normative bound is lineage: error events inherit it and onError routes
 * count as cycle edges (OG-V-09/OG-V-10).
 */
export const MAX_ERROR_DEPTH = 32;

/**
 * A FIFO async queue used for per-node mailboxes. `push` is non-blocking;
 * `next` resolves when an item arrives. `close` signals end-of-stream.
 */
export class AsyncQueue<T> {
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
      this.waiters.shift()!({ value: undefined, done: true });
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
}

/**
 * The in-graph `error` value for a failure originating in an inner
 * invocation: the inner abstract terminal record surfaced verbatim as a
 * JSON-domain value. This preserves optional data, including explicit null,
 * without carrying the local Error instance or stack into the graph.
 */
function errValue(err: unknown): unknown {
  if (err instanceof InvocationError) {
    return Object.hasOwn(err, "data")
      ? { code: err.code, data: err.data }
      : { code: err.code };
  }
  return err instanceof Error ? err.message : String(err);
}

/** An operation node's held invocation: one per graph invocation. */
class ConduitState {
  started = false;
  accepting = true;
  call?: Invocation<unknown, unknown>;
  timedOut = false;
  timer?: ReturnType<typeof setTimeout>;
  readonly lineage = new Map<string, number>();
  readonly roots = new RootTracker();

  mergeEvent(ev: GraphEvent): void {
    mergeMaxInto(this.lineage, ev.lineage);
    this.roots.add(ev.root);
  }

  merged(): { lineage: Map<string, number>; root: number } {
    return { lineage: copyLineage(this.lineage), root: this.roots.merged() };
  }
}

interface EngineDeps {
  graph: Graph;
  invoker: OperationInvoker;
  args: BindingInvocationArgs;
  transform?: TransformEvaluator;
  schemas: SchemaCache;
}

/**
 * Runs a single operation graph invocation against a {@link BindingHandle}.
 * Spawn-once: call {@link run} once; it resolves when the graph has
 * terminated (normal completion, exit node, error, or cancellation). The
 * graph is validated by the invoker before the engine is constructed.
 *
 * Part of the TS-first editor-support surface (see this package's README):
 * exported to serve the planned OpenBindings headless component collection,
 * which is TypeScript-first. The Go SDK does not export the engine by design.
 */
export class Engine {
  private readonly graph: Graph;
  private readonly invoker: OperationInvoker;
  private readonly args: BindingInvocationArgs;
  private readonly transform?: TransformEvaluator;
  private readonly schemas: SchemaCache;

  private readonly outEdges = new Map<string, string[]>();
  private readonly inEdges = new Map<string, string[]>();
  private inputKey = "";

  private handle!: BindingHandle<unknown, unknown>;
  private exitFlag = false;
  private inflight = 0;
  private eventCount = 0;
  private readonly abortController = new AbortController();

  private readonly rootValues: unknown[] = [];
  private readonly conduits = new Map<string, ConduitState>();
  private readonly conduitPumps: Promise<void>[] = [];

  private readonly mailboxes = new Map<string, AsyncQueue<GraphEvent>>();
  private readonly bufferStates = new Map<string, BufferState>();
  private readonly combineStates = new Map<string, CombineState>();
  private readonly completedSources = new Map<string, number>();

  /** Per-edge completion dedup: quiescence injection vs natural propagation. */
  private readonly completionSent = new Map<string, Set<string>>();

  /** Resolvers woken at each inflight zero-crossing (true quiescence). */
  private idleWaiters: Array<() => void> = [];

  constructor(deps: EngineDeps) {
    this.graph = deps.graph;
    this.invoker = deps.invoker;
    this.args = deps.args;
    this.transform = deps.transform;
    this.schemas = deps.schemas;

    for (const e of this.graph.edges ?? []) {
      pushTo(this.outEdges, e.from, e.to);
      pushTo(this.inEdges, e.to, e.from);
    }
    for (const [k, n] of Object.entries(this.graph.nodes)) {
      if (n.type === "input") this.inputKey = k;
      if (n.type === "operation") this.conduits.set(k, new ConduitState());
    }
  }

  async run(handle: BindingHandle<unknown, unknown>): Promise<void> {
    this.handle = handle;

    if (handle.signal.aborted) this.abortController.abort();
    else handle.signal.addEventListener("abort", () => this.abortController.abort(), { once: true });
    this.abortController.signal.addEventListener("abort", () => this.shutdown(), { once: true });

    for (const [key, node] of Object.entries(this.graph.nodes)) {
      this.mailboxes.set(key, new AsyncQueue<GraphEvent>());
      if (node.type === "buffer") this.bufferStates.set(key, new BufferState(node, this.schemas));
      if (node.type === "combine") this.combineStates.set(key, new CombineState(this.inEdges.get(key) ?? []));
      if ((this.inEdges.get(key) ?? []).length > 0) this.completedSources.set(key, 0);
    }

    // An operation node denotes one unconditional held session. Open every
    // conduit with the graph, before waiting for caller input, so startup
    // output and startup failure retain the causal availability of direct
    // invocation. Mailboxes already exist, so an eager output pump can queue
    // events before node workers start consuming them.
    for (const [key, node] of Object.entries(this.graph.nodes)) {
      if (node.type === "operation") this.startConduit(key, node);
    }

    const workers = Object.entries(this.graph.nodes).map(([key, node]) => this.runNode(key, node));

    // Input pump: every caller write becomes one event at the input node, in
    // write order, each rooting a lineage. The pump's inflight token keeps
    // the graph alive while the caller's input side is open; back-closure
    // (or the caller's close) ends it. End-of-input travels through the
    // input node's mailbox like any event, so FIFO ordering guarantees it
    // never overtakes a write.
    this.incInflight();
    const pump = (async () => {
      try {
        for await (const v of handle.inputs()) {
          this.rootValues.push(v);
          this.sendToNode(
            this.inputKey,
            newEvent({ data: v, root: this.rootValues.length - 1 }),
          );
        }
      } catch {
        /* terminal failure; the engine tears down via the signal */
      }
      this.sendToNode(this.inputKey, newEvent({ complete: true }));
      this.decInflight();
    })();

    // Quiescence loop: a zero crossing means no event can ever flow again
    // (the pump and every live inner invocation hold tokens). Any edge whose
    // completion has not been delivered by then is starved by a cycle or
    // feeds from an error route; injecting those completions is the spec's
    // implementation-defined drain detection. Injected markers may flush
    // buffers and complete combines, producing new work; loop until a zero
    // crossing injects nothing.
    for (;;) {
      await this.waitIdle();
      if (this.abortController.signal.aborted || this.exitFlag) break;
      if (this.inflight !== 0) continue;
      let injected = false;
      for (const e of this.graph.edges ?? []) {
        if (this.deliverCompletion(e.from, e.to)) injected = true;
      }
      if (!injected) break;
    }

    this.shutdown();
    await Promise.all([pump, ...workers, ...this.conduitPumps]);
    for (const c of this.conduits.values()) {
      if (c.timer) clearTimeout(c.timer);
    }
    // Normal completion. A no-op when a terminal error already fired (exit
    // error, unhandled conduit terminal, event limit, cancellation).
    handle.closeOutput();
  }

  // ----- plumbing -----

  private incInflight(): void {
    this.inflight++;
  }

  private decInflight(): void {
    this.inflight--;
    if (this.inflight === 0) {
      const ws = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of ws) w();
    }
  }

  private waitIdle(): Promise<void> {
    if (this.inflight === 0 || this.abortController.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.abortController.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  private shutdown(): void {
    for (const mb of this.mailboxes.values()) mb.close();
    const ws = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of ws) w();
  }

  private sendToNode(toKey: string, ev: GraphEvent): void {
    this.incInflight();
    const mb = this.mailboxes.get(toKey);
    if (!mb) {
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

  /** Delivers one edge's completion marker at most once. */
  private deliverCompletion(fromKey: string, toKey: string): boolean {
    let sent = this.completionSent.get(fromKey);
    if (!sent) {
      sent = new Set();
      this.completionSent.set(fromKey, sent);
    }
    if (sent.has(toKey)) return false;
    sent.add(toKey);
    this.sendToNode(toKey, newEvent({ source: fromKey, complete: true }));
    return true;
  }

  private sendCompletion(fromKey: string): void {
    for (const toKey of this.outEdges.get(fromKey) ?? []) {
      if (this.exitFlag) return;
      this.deliverCompletion(fromKey, toKey);
    }
  }

  /**
   * Routes a per-event failure ({error, event}) to the node's onError
   * target. Without an explicit route, the complete error event terminates
   * the graph; omission never silently discards a failed event.
   */
  private sendPerEventError(
    nodeKey: string,
    errVal: unknown,
    ev: GraphEvent,
    lineage: Map<string, number>,
  ): void {
    const node = this.graph.nodes[nodeKey];
    const errorEvent = { error: errVal, event: ev.data };
    if (!node?.onError || ev.errorDepth >= MAX_ERROR_DEPTH) {
      this.exitFlag = true;
      this.handle.fireError(
        new InvocationError(ERR_OPERATION_GRAPH_EXIT, errorEvent),
      );
      this.abortController.abort();
      return;
    }
    this.sendToNode(
      node.onError,
      newEvent({
        data: errorEvent,
        source: nodeKey,
        root: ev.root,
        lineage: copyLineage(lineage),
        errorDepth: ev.errorDepth + 1,
      }),
    );
  }

  /**
   * Back-closure: close the caller-facing input side once every node the
   * input node feeds is a non-accepting operation conduit. Built-in
   * consumers keep closure caller-owned (non-acceptance is defined for
   * operation nodes only).
   */
  private backClosure(): void {
    const consumers = this.outEdges.get(this.inputKey) ?? [];
    if (consumers.length === 0) return;
    for (const k of consumers) {
      if (this.graph.nodes[k]?.type !== "operation") return;
      if (this.conduits.get(k)!.accepting) return;
    }
    void this.handle.closeInput();
  }

  // ----- node workers -----

  private async runNode(key: string, node: Node): Promise<void> {
    const mailbox = this.mailboxes.get(key)!;
    for (;;) {
      if (this.abortController.signal.aborted) return;
      const next = await mailbox.next();
      if (next.done) return;
      const ev = next.value;
      if (this.exitFlag) {
        this.decInflight();
        continue;
      }
      await this.processNode(key, node, ev);
      this.decInflight();
    }
  }

  private async processNode(key: string, node: Node, ev: GraphEvent): Promise<void> {
    if (ev.complete) {
      this.handleCompletion(key, node, ev);
      return;
    }

    if (++this.eventCount > MAX_EVENTS) {
      this.exitFlag = true;
      this.handle.fireError(
        new InvocationError(ERR_EVENT_LIMIT_EXCEEDED),
      );
      this.abortController.abort();
      return;
    }

    switch (node.type) {
      case "input":
        this.sendDownstream(key, ev);
        return;

      case "output":
        try {
          await this.handle.emitOutput(ev.data);
        } catch {
          this.exitFlag = true;
          this.abortController.abort();
        }
        return;

      case "exit": {
        this.exitFlag = true;
        if (node.error === true) {
          this.handle.fireError(
            new InvocationError(ERR_OPERATION_GRAPH_EXIT, ev.data),
          );
        } else {
          try {
            await this.handle.emitOutput(ev.data);
          } catch {
            /* the abort below tears the engine down either way */
          }
        }
        this.abortController.abort();
        return;
      }

      case "operation":
        await this.processConduitEvent(key, node, ev);
        return;

      case "each":
        await this.processEach(key, node, ev);
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
        const b = this.bufferStates.get(key)!.add(ev);
        if (b) this.sendDownstream(key, newEvent({ data: b.data, source: key, root: b.root, lineage: b.lineage }));
        return;
      }

      case "combine": {
        const snap = this.combineStates.get(key)!.add(ev);
        if (snap) {
          this.sendDownstream(key, newEvent({ data: snap.data, source: key, root: snap.root, lineage: snap.lineage }));
        }
        return;
      }
    }
  }

  private handleCompletion(key: string, node: Node, ev: GraphEvent): void {
    // The input node's completion marker comes from the pump through its own
    // mailbox (so it can never overtake buffered writes); forward it.
    if (node.type === "input") {
      this.sendCompletion(key);
      return;
    }
    // combine consumes per-source completion before the all-complete
    // transition (completion can be what makes it ready).
    if (node.type === "combine") {
      const snap = this.combineStates.get(key)!.sourceComplete(ev.source);
      if (snap) {
        this.sendDownstream(key, newEvent({ data: snap.data, source: key, root: snap.root, lineage: snap.lineage }));
      }
    }
    const prev = this.completedSources.get(key);
    if (prev === undefined) return;
    const count = prev + 1;
    this.completedSources.set(key, count);
    if (count < (this.inEdges.get(key) ?? []).length) return;

    // All incoming edges complete.
    if (node.type === "operation") {
      // Close the held invocation's input side; the output pump sends this
      // node's completion when the invocation's outputs finish.
      this.startConduit(key, node);
      void this.conduits.get(key)!.call!.close();
      return;
    }
    if (node.type === "buffer") {
      const b = this.bufferStates.get(key)!.flush();
      if (b) this.sendDownstream(key, newEvent({ data: b.data, source: key, root: b.root, lineage: b.lineage }));
    }
    this.sendCompletion(key);
  }

  // ----- operation (the conduit) -----

  /**
   * Opens an operation node's held invocation and spawns its
   * acceptance watcher and output pump. The output pump owns the node's
   * downstream completion and its terminal error handling: routed per
   * onError when set, fatal to the graph when not (the identity law's
   * terminal-status clause).
   */
  private startConduit(key: string, node: Node): void {
    const c = this.conduits.get(key)!;
    if (c.started) return;
    c.started = true;

    const call = this.invoker.invoke<unknown, unknown>(
      this.args.interface!,
      operationSignature<unknown, unknown>(node.operation!),
      { context: this.args.context, signal: this.abortController.signal },
    );
    c.call = call;
    if (node.timeout !== undefined) {
      c.timer = setTimeout(() => {
        c.timedOut = true;
        void call.cancel();
      }, node.timeout);
    }

    // Acceptance watcher: the inner binding closing its input from below (or
    // any terminal transition) makes the node non-accepting and may
    // back-close the graph's own input side.
    void call.inputClosed.then(() => {
      c.accepting = false;
      this.backClosure();
    });

    // Output pump. Holds an inflight token: the graph is not complete while
    // an inner invocation is in flight.
    this.incInflight();
    this.conduitPumps.push(
      (async () => {
        try {
          for await (const out of call.outputs) {
            if (this.exitFlag) return; // iterator return() cancels the call
            const { lineage, root } = c.merged();
            this.sendDownstream(key, newEvent({ data: out, source: key, root, lineage }));
          }
          this.sendCompletion(key);
        } catch (err) {
          c.accepting = false;
          this.backClosure();
          let ie =
            err instanceof InvocationError
              ? err
              : new InvocationError(ERR_CANCELLED);
          if (c.timedOut) {
            ie = new InvocationError(TIMEOUT_EXCEEDED);
          } else if (ie.code === ERR_CANCELLED && this.abortController.signal.aborted) {
            return; // the graph itself is tearing down
          }
          if (node.onError) {
            // Opt-in handling: an error event without an `event` member (the
            // failure belongs to the invocation as a whole), carrying the
            // merged lineage of everything written into it. The node
            // completes; the graph continues.
            const { lineage, root } = c.merged();
            this.sendToNode(node.onError, newEvent({ data: { error: errValue(ie) }, source: key, root, lineage }));
            this.sendCompletion(key);
            return;
          }
          // Fatal default: the graph invocation terminates with the inner
          // terminal error, verbatim.
          this.exitFlag = true;
          this.handle.fireError(ie);
          this.abortController.abort();
        } finally {
          if (c.timer) clearTimeout(c.timer);
          this.decInflight();
        }
      })(),
    );
  }

  /**
   * Writes one arriving event into the conduit's held invocation, or rejects
   * it (WRITE_REJECTED) when the node is non-accepting.
   */
  private async processConduitEvent(key: string, node: Node, ev: GraphEvent): Promise<void> {
    const c = this.conduits.get(key)!;
    if (!c.accepting) {
      this.sendPerEventError(key, WRITE_REJECTED, ev, ev.lineage);
      return;
    }
    this.startConduit(key, node);
    c.mergeEvent(ev);
    try {
      await c.call!.write(ev.data);
    } catch (err) {
      if (err instanceof InvocationError && err.code === ERR_INPUT_CLOSED) {
        // The write raced the inner binding closing its input from below.
        c.accepting = false;
        this.backClosure();
        this.sendPerEventError(key, WRITE_REJECTED, ev, ev.lineage);
      }
      // Terminal failures surface through the output pump, which owns
      // reporting; nothing further to do here.
    }
  }

  // ----- each -----

  /**
   * Opens one invocation per arriving event, writing the event as its only
   * input. maxIterations bounds invocations per event lineage.
   */
  private async processEach(key: string, node: Node, ev: GraphEvent): Promise<void> {
    const lineage = copyLineage(ev.lineage);
    if (node.maxIterations !== undefined && (lineage.get(key) ?? 0) >= node.maxIterations) {
      return; // safety bound: the event is dropped, not errored
    }
    lineage.set(key, (lineage.get(key) ?? 0) + 1);

    const call = this.invoker.invoke<unknown, unknown>(
      this.args.interface!,
      operationSignature<unknown, unknown>(node.operation!),
      { context: this.args.context, signal: this.abortController.signal },
    );
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (node.timeout !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        void call.cancel();
      }, node.timeout);
    }

    try {
      // One write, then close: each fixes the graph's contribution at one
      // write per session. Write/close failures surface via the outputs.
      try {
        await call.write(ev.data);
        await call.close();
      } catch {
        /* surfaces via outputs */
      }
      for await (const out of call.outputs) {
        if (this.exitFlag) return;
        this.sendDownstream(key, newEvent({ data: out, source: key, root: ev.root, lineage: copyLineage(lineage) }));
      }
    } catch (err) {
      let val = errValue(err);
      if (timedOut) {
        val = TIMEOUT_EXCEEDED;
      } else if (
        err instanceof InvocationError &&
        err.code === ERR_CANCELLED &&
        this.abortController.signal.aborted
      ) {
        return; // graph teardown, not a node failure
      }
      this.sendPerEventError(key, val, ev, lineage);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ----- expression nodes -----

  private async processFilter(key: string, node: Node, ev: GraphEvent): Promise<void> {
    if (node.schema !== undefined) {
      try {
        if (this.schemas.match(node.schema, ev.data)) this.sendDownstream(key, ev);
      } catch (err) {
        this.sendPerEventError(key, errValue(err), ev, ev.lineage);
      }
      return;
    }
    const r = await this.evalOrFail(key, node.transform!, ev);
    if (r.failed) return;
    if (isTruthy(r.result)) this.sendDownstream(key, ev);
  }

  private async processTransform(key: string, node: Node, ev: GraphEvent): Promise<void> {
    const r = await this.evalOrFail(key, node.transform!, ev);
    if (r.failed) return;
    this.sendDownstream(key, newEvent({ data: r.result, source: key, root: ev.root, lineage: copyLineage(ev.lineage) }));
  }

  private async processMap(key: string, node: Node, ev: GraphEvent): Promise<void> {
    const r = await this.evalOrFail(key, node.transform!, ev);
    if (r.failed) return;
    if (!Array.isArray(r.result)) {
      this.sendPerEventError(key, MAP_NOT_ARRAY, ev, ev.lineage);
      return;
    }
    for (const item of r.result) {
      if (this.exitFlag) return;
      this.sendDownstream(key, newEvent({ data: item, source: key, root: ev.root, lineage: copyLineage(ev.lineage) }));
    }
  }

  /**
   * Evaluates a node expression with the event as $ and the lineage's root
   * input as $input. An undefined result fails the node with
   * TRANSFORM_UNDEFINED; other evaluation failures fail it with their
   * message. failed=true means a per-event error was already routed (or
   * dropped).
   */
  private async evalOrFail(
    key: string,
    expression: string,
    ev: GraphEvent,
  ): Promise<{ result?: unknown; failed: boolean }> {
    if (!this.transform) {
      this.sendPerEventError(key, EXPRESSION_EVALUATION_FAILED, ev, ev.lineage);
      return { failed: true };
    }
    let result: unknown;
    try {
      if (isTransformEvaluatorWithBindings(this.transform)) {
        const bindings: Record<string, unknown> = {};
        if (ev.root !== NO_ROOT) bindings.input = this.rootValues[ev.root];
        result = await this.transform.evaluateWithBindings(expression, ev.data, bindings);
      } else {
        result = await this.transform.evaluate(expression, ev.data);
      }
    } catch {
      this.sendPerEventError(key, EXPRESSION_EVALUATION_FAILED, ev, ev.lineage);
      return { failed: true };
    }
    if (result === undefined) {
      this.sendPerEventError(key, TRANSFORM_UNDEFINED, ev, ev.lineage);
      return { failed: true };
    }
    return { result, failed: false };
  }
}

function pushTo(m: Map<string, string[]>, k: string, v: string): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * JSONata 2.1's boolean cast ($boolean) for filter-expression results:
 * false/null/0/"" are false, empty composites are false, and an array is
 * true only if some member casts to true. (undefined never reaches here:
 * it fails the node with TRANSFORM_UNDEFINED per the Transforms rule.)
 */
function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  if (Array.isArray(v)) return v.some(isTruthy);
  if (typeof v === "function") return false;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}
