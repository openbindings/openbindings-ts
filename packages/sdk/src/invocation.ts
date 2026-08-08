/**
 * The cardinality-agnostic operation invocation handle.
 *
 * One call shape for every cardinality (unary, server-streaming,
 * client-streaming, bidirectional): the caller writes messages until done;
 * the invocation yields messages until done. The OpenBindings spec assigns
 * cardinality to the binding, not the operation, so the call signature never
 * declares it.
 *
 * Two views of one session:
 *   - {@link Invocation}    — the caller-facing handle
 *   - {@link BindingHandle} — the binding-facing push surface
 *
 * The same concrete {@link InvocationImpl} implements both; the views never
 * overlap structurally, so callers can't reach binding-only methods and
 * bindings can't reach caller-facing ones.
 */

import {
  CONTEXT_REQUIRED,
  ERR_ALREADY_CONSUMED,
  ERR_CANCELLED,
  ERR_EXPECTED_SINGLE,
  ERR_INPUT_CLOSED,
  ERR_INVOCATION_CLOSED,
  ERR_TIMEOUT,
} from "./errcodes.js";
import type { InvocationErrorCode } from "./errcodes.js";

/**
 * The structured error type for all terminal invocation failures. A class
 * (not a plain shape) so it carries a stack trace and supports `instanceof`.
 *
 * The terminal error frame is the portable unsuccessful-completion signal.
 * `details` carries portable data defined by an interface-owned code
 * (currently CONTEXT_REQUIRED and validation failures), or an opaque JSON
 * failure value identified as application-authored by the governing binding
 * rules. `diagnostics` is an optional expert escape hatch for selected-binding
 * or implementation evidence; ordinary operation behavior must not depend on
 * it.
 */
export class InvocationError extends Error {
  readonly code: InvocationErrorCode | (string & {});
  readonly details?: unknown;
  readonly diagnostics?: unknown;

  constructor(
    code: InvocationErrorCode | (string & {}),
    message: string,
    details?: unknown,
    diagnostics?: unknown,
  ) {
    // A CONTEXT_REQUIRED challenge is actionable only through its details; an
    // error string that hides the target and the requirement families strands
    // whoever sees it in a log. Formats write the prose, the challenge writes
    // the facts (mirrors the Go SDK's InvocationError.Error()).
    let rendered = message || code;
    if (code === CONTEXT_REQUIRED) {
      const summary = contextRequirementSummary(details);
      if (summary) rendered = `${rendered} (${summary})`;
    }
    super(rendered);
    this.name = "InvocationError";
    this.code = code;
    if (details !== undefined) this.details = details;
    if (diagnostics !== undefined) this.diagnostics = diagnostics;
  }
}

/**
 * True when an abort `reason` denotes a lifetime DEADLINE rather than a manual
 * cancel. `AbortSignal.timeout()` aborts with a `DOMException` named
 * `"TimeoutError"` (WHATWG); a manual `controller.abort()` / handle `cancel()`
 * does not. Duck-typed on the reason's `name` so it holds across runtimes and
 * polyfills, not only where the global `DOMException` constructor is present.
 */
function isTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "TimeoutError"
  );
}

/**
 * Map an abort into its terminal error, mirroring the Go SDK's `ctx.Err()`
 * branch. A deadline (`AbortSignal.timeout()`) is distinct from a
 * caller-initiated `cancel()`. Neither code implies cross-protocol retry
 * policy.
 */
function abortToTerminal(reason: unknown): InvocationError {
  return isTimeoutReason(reason)
    ? new InvocationError(ERR_TIMEOUT, "invocation deadline exceeded")
    : new InvocationError(ERR_CANCELLED, "invocation cancelled");
}

/**
 * Multi-valued binding-native metadata. It is exposed only through the
 * explicitly named diagnostic view and is never part of an operation value.
 */
export type Metadata = Record<string, string[]>;

/** Optional expert evidence for one in-process invocation. */
export interface InvocationDiagnostics {
  /** Binding-native leading metadata, if the selected binding has any. */
  readonly leading: Promise<Metadata>;
  /** Binding-native trailing metadata after termination. */
  trailing(): Metadata;
}

// ---------------------------------------------------------------------------
// Context negotiation shapes (the openbindings.binding-invoker interface)
// ---------------------------------------------------------------------------

/**
 * One runtime prerequisite. `type` names a requirement family
 * (e.g. "auth.bearer", "auth.apiKey", "auth.basic", "auth.oauth2");
 * additional fields are family-specific.
 */
export interface ContextRequirement {
  type: string;
  /**
   * The scheme name as the source artifact declares it (e.g. an OpenAPI
   * `securitySchemes` key, or the AsyncAPI `components.securitySchemes` key a
   * `$ref` resolves through). Distinguishes two requirements of the same
   * `type` within one alternative — two ANDed API keys are otherwise
   * indistinguishable — and keys scheme-scoped credential lookup (see
   * `apiKeys` on {@link ContextStore}/`BindingContext`). Absent when the
   * artifact declares the scheme inline with no addressable name.
   */
  name?: string;
  /**
   * Whether resolved context MAY be persisted and reused. Defaults to true;
   * `durable: false` context MUST be re-satisfied per call. The contract
   * prescribes no store or key derivation.
   */
  durable?: boolean;
  description?: string;
  [key: string]: unknown;
}

/** A conjunctive requirement set: ALL requirements must be satisfied. */
export interface ContextAlternative {
  requirements: ContextRequirement[];
}

/**
 * The details payload of a `CONTEXT_REQUIRED` terminal error, per the
 * `openbindings.binding-invoker` interface. `alternatives` is disjunctive:
 * satisfying any one alternative suffices.
 */
export interface ContextRequiredDetails {
  /**
   * Opaque identifier for the concrete destination or context scope. A
   * runtime may use it when resolving or reusing context; key derivation and
   * persistence are outside the contract.
   */
  target: string;
  alternatives: ContextAlternative[];
}

/** Constructs the canonical CONTEXT_REQUIRED terminal error. */
export function contextRequiredError(
  message: string,
  details: ContextRequiredDetails,
): InvocationError {
  return new InvocationError(CONTEXT_REQUIRED, message, details);
}

/**
 * Builds a `config.value` {@link ContextRequirement} — the binding-invoker
 * family for a configuration value a binding needs but the artifact
 * does not supply (a server variable with no default, a channel address a
 * service generates at runtime). `point` names the binding-specification
 * configuration point ("server", "address", …); `key` names the specific
 * value within it (a server-variable name, or "address" for a whole channel
 * address); `choices` carries values declared by the artifact, while the
 * governing binding specification decides whether that list is closed or
 * advisory. `durable` defaults to true, permitting but not requiring reuse;
 * pass `false` for a value that must be fresh per invocation. The resolved
 * value is carried in the `configuration` context field
 * under `point`; its shape there is the invoker's own, so this requirement
 * names what is needed, not the resolved structure.
 */
export function configValueRequirement(
  point: string,
  key: string,
  description: string,
  choices?: string[],
  durable?: boolean,
): ContextRequirement {
  const req: ContextRequirement = { type: "config.value", point, key, description };
  if (choices && choices.length > 0) req.choices = choices;
  if (durable !== undefined) req.durable = durable;
  return req;
}

/** Narrows a terminal error to a CONTEXT_REQUIRED challenge with usable details. */
export function isContextRequired(
  err: unknown,
): err is InvocationError & { details: ContextRequiredDetails } {
  if (!(err instanceof InvocationError) || err.code !== CONTEXT_REQUIRED) return false;
  const d = err.details as ContextRequiredDetails | undefined;
  return (
    !!d &&
    typeof d === "object" &&
    typeof d.target === "string" &&
    Array.isArray(d.alternatives)
  );
}

/**
 * Maps standard requirement families from the binding-invoker interface to
 * their well-known context fields. The optional store-backed resolver in
 * context.ts checks satisfaction against this same map.
 */
export const REQUIREMENT_FIELDS: Record<string, string> = {
  "auth.bearer": "bearerToken",
  "auth.apiKey": "apiKey",
  "auth.basic": "basic",
  "auth.oauth2": "accessToken",
};

/**
 * Renders `target: <t>; satisfied by: auth.bearer (context field "bearerToken"),
 * or ...` for a CONTEXT_REQUIRED challenge's alternatives. Returns "" when
 * `details` is not a usable ContextRequiredDetails. Mirrors the Go SDK's
 * contextRequirementSummary; used by InvocationError to append the facts.
 */
export function contextRequirementSummary(details: unknown): string {
  const d = details as ContextRequiredDetails | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.alternatives)) return "";
  const alts: string[] = [];
  for (const alt of d.alternatives) {
    const reqs: string[] = [];
    for (const req of alt.requirements ?? []) {
      const field = REQUIREMENT_FIELDS[req.type];
      reqs.push(field ? `${req.type} (context field "${field}")` : req.type);
    }
    if (reqs.length > 0) alts.push(reqs.join(" + "));
  }
  const target = typeof d.target === "string" ? d.target : "";
  if (target === "" && alts.length === 0) return "";
  const parts: string[] = [];
  if (target !== "") parts.push(`target: ${target}`);
  if (alts.length > 0) parts.push(`satisfied by: ${alts.join(", or ")}`);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Caller-facing handle
// ---------------------------------------------------------------------------

/**
 * Cardinality-agnostic, bidirectional invocation session. Conceptually a
 * typed I/O pair scoped to one operation, plus lifecycle controls.
 *
 * Lifecycle:
 *   write(v)    write one input message to the binding's channel
 *   close()     signal no more input (idempotent)
 *   cancel()    request termination (idempotent)
 *   outputs     async-iterable of output messages
 *   closed      resolves on normal close, rejects on terminal failure
 *
 * `write` does NOT dispatch the underlying transport. It puts a message on
 * the caller→binding channel; the binding decides when to dispatch based on
 * what it has collected. The verbs are channel verbs, not transport verbs.
 *
 * Cardinality is observed by the caller's own iteration; the signature does
 * not declare it.
 *
 * Bidi contract: under bounded backpressure a single async context that
 * interleaves `write` and output reads can deadlock. Drive input and output
 * from separate async contexts (`Promise.all([pump(), drain()])`), never a
 * fire-and-forget `void (async () => {...})()`.
 */
export interface Invocation<I = unknown, O = unknown> {
  /**
   * Writes one input message to the binding's input channel. Resolves once
   * the message is enqueued (not processed); parks while the bounded input
   * buffer is full (backpressure).
   *
   * Every rejection is truthful: a flow signal (`ERR_INPUT_CLOSED` once the
   * input side has closed), an input-validation error (terminal — the
   * same error surfaces on both faces), or, when a terminal has already
   * fired, the terminal error itself, never a weaker substitute. The output
   * side remains the authoritative verdict: a write racing a clean
   * completion can reject with `ERR_INVOCATION_CLOSED` even though the
   * invocation succeeded. Treat write rejections as fast-fail, not as the
   * outcome; pick one error-observation point (usually `closed` or the
   * iterator throw) and don't handle the same failure on both paths.
   */
  write(input: I): Promise<void>;

  /**
   * Graceful close: signal that no more input is coming. Idempotent; it
   * never rejects. The invocation continues; outputs flow until the binding
   * closes its output side. For abrupt termination, use `cancel()` instead.
   *
   * Bindings close the input side themselves when they know better
   * (no-input and unary operations), so callers only own `close()` for
   * client-streaming and bidirectional use.
   */
  close(): Promise<void>;

  /** Aborts the invocation. Idempotent; a no-op once terminal. */
  cancel(): Promise<void>;

  /**
   * Output sequence — a standard `AsyncIterable<O>`, so the platform's
   * iterator tooling (`for await`, `Array.fromAsync`, async iterator
   * helpers) works over it unchanged; the SDK ships no parallel operator
   * suite. `for await (const o of call.outputs)` is the base consumption
   * pattern; it returns on normal close and throws an `InvocationError` on
   * terminal failure.
   *
   * Single-consumer, acquired once: the first acquisition (a `for await`,
   * `single`, or an explicit `[Symbol.asyncIterator]()`) claims the
   * sequence; a second throws `ERR_ALREADY_CONSUMED`. Abandoning the
   * sequence early (`break`) invokes the iterator's `return()`, which
   * cancels the invocation.
   */
  readonly outputs: AsyncIterable<O>;

  /** Resolves on normal close. Rejects on terminal failure. */
  readonly closed: Promise<void>;

  /**
   * Resolves once the invocation's input side has closed — by the caller's
   * `close()`, by the binding from below (a unary binding after its first
   * read), or by a terminal transition. Consumers that pipe a stream into
   * the invocation (e.g. operation-graph conduits) await it to learn
   * acceptance has ended without probing with a failing `write`.
   */
  readonly inputClosed: Promise<void>;

  /**
   * Explicit expert escape hatch for binding-native evidence. Correct
   * ordinary operation behavior MUST NOT depend on this view.
   */
  readonly diagnostics: InvocationDiagnostics;
}

// ---------------------------------------------------------------------------
// Binding-facing handle
// ---------------------------------------------------------------------------

/**
 * Binding-facing handle. The binding receives this from the invoker layer
 * and drives the invocation: it consumes inputs(), emits outputs, announces
 * normal close or terminal error, and honors the cancellation signal.
 * Callers never see this interface.
 *
 * Binding-author contract (the type system cannot enforce these; the
 * reference skeletons in the format packages observe all of them):
 *   1. Raise terminal errors (notably CONTEXT_REQUIRED) BEFORE any
 *      observable side effect, so a no-input-consumed retry is safe.
 *   2. Observe the `emitOutput` result: it rejects when the invocation
 *      terminated while the emit was parked; stop emitting on rejection.
 *   3. Do not add your own buffer; `emitOutput` parking IS backpressure.
 *   4. Terminate exactly once: `closeOutput()` on normal completion or
 *      `fireError()` on terminal failure; never emit after either.
 *   5. Close input early when you can (no-input: on entry; unary: after the
 *      first read), so the caller never has to `close()`.
 *   6. Bidi: read inputs and emit outputs from separate async contexts; a
 *      single interleaved loop deadlocks under bounded backpressure.
 */
export interface BindingHandle<I = unknown, O = unknown> {
  /**
   * Reads inputs as an async iterable. Returns cleanly when the input side
   * closes; throws the terminal `InvocationError` if the invocation errors.
   * Single-consumer: a second concurrent reader fails loudly.
   */
  inputs(): AsyncIterable<I>;

  /**
   * Closes the input side from the binding's perspective. Idempotent.
   * Subsequent caller `write()` calls reject with `ERR_INPUT_CLOSED`
   * (non-terminal). The invocation continues; outputs still flow.
   */
  closeInput(): Promise<void>;

  /**
   * Emits one output. Resolves when the output is accepted into the bounded
   * buffer (parks while the buffer is full — this is how backpressure
   * reaches the binding's read loop). Rejects with an `InvocationError` if
   * the invocation was cancelled or its output closed while parked, so a
   * binding that `await`s it stops emitting instead of stranding on a
   * buffer no one will drain.
   */
  emitOutput(output: O): Promise<void>;

  /** Closes the output side normally. Idempotent. */
  closeOutput(): void;

  /** Closes the invocation with a terminal error. Idempotent. */
  fireError(error: InvocationError): void;

  /**
   * The teardown signal — the only lifecycle channel bindings observe.
   * It aborts on EVERY terminal transition (caller `cancel()`, an external
   * signal, `closeOutput`, or `fireError` — including terminals raised on
   * the caller side, such as an input-validation failure), mirroring the
   * Go SDK's `Done()`. On abort, tear down underlying work; if your binding
   * initiated no terminal itself, call `fireError(ERR_CANCELLED)`.
   */
  readonly signal: AbortSignal;

  /** Sets leading metadata; must precede the first `emitOutput`/`closeOutput`. */
  setHeader(md: Metadata): void;

  /** Sets trailing metadata; must precede `closeOutput`/`fireError`. */
  setTrailer(md: Metadata): void;
}

// ---------------------------------------------------------------------------
// Reference implementation
// ---------------------------------------------------------------------------

/**
 * Buffer bounds. A capacity of one is structurally mandatory (the handle is
 * returned synchronously and a binding may emit before the caller reads; a
 * zero-capacity rendezvous would deadlock). Above one is pipelining slack:
 * the output side gets a little decode-ahead; the input side's slack is
 * already supplied by the transport's send window. These are fixed internal
 * defaults, deliberately not configurable — delivery is always lossless,
 * in-order, exactly-once, with block-on-full backpressure in both
 * directions.
 */
export const OUTPUT_BUFFER_CAPACITY = 4;
export const INPUT_BUFFER_CAPACITY = 1;

type OutputWaiter<O> = (r: IteratorResult<O, void>) => void;

interface InputWaiter<I> {
  resolve: (r: IteratorResult<I, void>) => void;
  reject: (err: unknown) => void;
}

interface ProducerWaiter<T> {
  value: T;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface InvocationImplOptions<I> {
  /** External cancellation; converges with `cancel()` on the internal controller. */
  signal?: AbortSignal;
  /**
   * Input-validation hook (OBI-T-16 claim semantics): validates a caller input before it is enqueued. A
   * returned error is terminal AND rejects the offending `write` with the
   * same `InvocationError` (the binding never sees the message). Used by
   * the operation-layer invoker; bindings and direct binding-invoker
   * callers normally leave it unset.
   */
  validateInput?: (input: I) => InvocationError | null | Promise<InvocationError | null>;
}

/**
 * The shared invocation session: implements the caller-facing
 * {@link Invocation} and the binding-facing {@link BindingHandle} over one
 * pair of bounded buffers.
 *
 * Concurrency model: JS microtask serialization replaces locking; every
 * state transition routes through `closeOutput`/`fireError`, which are
 * idempotent (terminal is sticky and single). Invariants:
 *
 *   - A consumer waiter parks only when its buffer is empty; a producer
 *     waiter parks only when the buffer is full. The queue and the consumer
 *     waiters never both hold pending work, which is what guarantees queued
 *     outputs always drain before a terminal error surfaces.
 *   - A consumer pull that frees a slot immediately re-fills it from the
 *     eldest parked producer, preserving order.
 *   - Terminal transitions settle everything: output consumers see
 *     done-then-error, parked producers reject, input consumers reject on
 *     `fireError` but end cleanly on `closeOutput` (this distinction is
 *     what lets a binding's `for await` loop distinguish normal close from
 *     terminal failure without re-checking the signal).
 */
export class InvocationImpl<I = unknown, O = unknown>
  implements Invocation<I, O>, BindingHandle<I, O>
{
  readonly closed: Promise<void>;
  readonly header: Promise<Metadata>;

  get diagnostics(): InvocationDiagnostics {
    return {
      leading: this.header,
      trailing: () => this.trailer(),
    };
  }
  readonly inputClosed: Promise<void>;

  private readonly controller = new AbortController();
  private readonly validateInputHook?: InvocationImplOptions<I>["validateInput"];

  private inputBuf: I[] = [];
  private inputWaiters: InputWaiter<I>[] = [];
  private inputProducerWaiters: ProducerWaiter<I>[] = [];
  private inputSideClosed = false;

  private outputQueue: O[] = [];
  private outputWaiters: OutputWaiter<O>[] = [];
  private outputProducerWaiters: ProducerWaiter<O>[] = [];
  private outputsConsumed = false;

  private state: "open" | "closed" | "errored" = "open";
  private terminalError: InvocationError | undefined;

  private headerMd: Metadata | undefined;
  private headerSettled = false;
  private trailerMd: Metadata | undefined;

  private resolveClosed!: () => void;
  private rejectClosed!: (e: InvocationError) => void;
  private resolveHeader!: (md: Metadata) => void;
  private resolveInputClosed!: () => void;

  constructor(opts: InvocationImplOptions<I> = {}) {
    this.validateInputHook = opts.validateInput;

    this.closed = new Promise<void>((res, rej) => {
      this.resolveClosed = res;
      this.rejectClosed = rej;
    });
    // Avoid unhandled-rejection if the caller never observes `closed`.
    this.closed.catch(() => {});

    this.inputClosed = new Promise<void>((res) => {
      this.resolveInputClosed = res;
    });

    this.header = new Promise<Metadata>((res) => {
      this.resolveHeader = res;
    });

    if (opts.signal) {
      // Forward an externally-supplied abort to the internal controller so
      // user-cancel and handle-cancel converge on one signal.
      if (opts.signal.aborted) {
        this.controller.abort(opts.signal.reason);
      } else {
        opts.signal.addEventListener(
          "abort",
          () => {
            // Transition to terminal FIRST: fireError settles state and drains
            // before it aborts the controller, so every signal listener observes
            // settled state (the documented terminal-state invariant). Aborting
            // here, ahead of fireError, would fire the signal mid-transition.
            // A deadline (AbortSignal.timeout) is ERR_TIMEOUT, a manual cancel
            // is ERR_CANCELLED — distinguished by the abort reason.
            this.fireError(abortToTerminal(opts.signal!.reason));
            // Propagate the external reason onto the (already-aborted) internal
            // controller; abort is idempotent so this does not re-fire the signal.
            this.controller.abort(opts.signal!.reason);
          },
          // `once` handles the abort-fires-first case; `signal` handles the
          // completes-without-abort case: the internal controller aborts on
          // EVERY terminal (closeOutput/fireError), so this unregisters the
          // listener from the (possibly long-lived) external signal at terminal
          // — no per-invocation listener leak on a reused shared signal.
          { once: true, signal: this.controller.signal },
        );
      }
    }

    // An already-aborted external signal transitions immediately; without
    // this the invocation would sit "open" with an aborted controller. The
    // reason (propagated from the external signal above) decides deadline vs.
    // cancel, just like the live-abort listener.
    if (this.controller.signal.aborted) {
      this.fireError(abortToTerminal(this.controller.signal.reason));
    }
  }

  /** Binding-facing: the one cancellation channel bindings observe. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  // ----- Caller-facing -----

  async write(input: I): Promise<void> {
    this.throwIfUnwritable();

    if (this.validateInputHook) {
      const err = await this.validateInputHook(input);
      // State may have moved while validating.
      if (err) {
        // Input-validation dual signal: terminal AND the offending write rejects
        // with the same error. The binding never sees the message.
        this.fireError(err);
        throw err;
      }
      this.throwIfUnwritable();
    }

    const waiter = this.inputWaiters.shift();
    if (waiter) {
      waiter.resolve({ value: input, done: false });
      return;
    }
    if (this.inputBuf.length < INPUT_BUFFER_CAPACITY) {
      this.inputBuf.push(input);
      return;
    }
    // Buffer full: park until a consumer pull frees a slot (backpressure).
    await new Promise<void>((resolve, reject) => {
      this.inputProducerWaiters.push({ value: input, resolve, reject });
    });
  }

  private throwIfUnwritable(): void {
    if (this.state !== "open") {
      throw (
        this.terminalError ??
        new InvocationError(ERR_INVOCATION_CLOSED, "invocation is closed")
      );
    }
    if (this.inputSideClosed) {
      throw new InvocationError(ERR_INPUT_CLOSED, "input is closed");
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the Invocation contract is Promise-returning; this implementation settles synchronously
  async close(): Promise<void> {
    if (this.inputSideClosed) return;
    this.inputSideClosed = true;
    this.resolveInputClosed();
    // Normal close: parked binding reads end cleanly.
    while (this.inputWaiters.length > 0) {
      this.inputWaiters.shift()!.resolve({ value: undefined, done: true });
    }
    // A write parked behind a full buffer was never accepted; it rejects
    // non-terminally, consistent with "wrote after close".
    while (this.inputProducerWaiters.length > 0) {
      this.inputProducerWaiters
        .shift()!
        .reject(new InvocationError(ERR_INPUT_CLOSED, "input is closed"));
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the Invocation contract is Promise-returning; this implementation settles synchronously
  async cancel(): Promise<void> {
    // No-op once terminal: cancelling after completion or after a real
    // terminal error must not overwrite that error with ERR_CANCELLED.
    if (this.state !== "open") return;
    // fireError performs the state transition and drains, THEN aborts the
    // controller last so signal listeners observe settled state (the terminal
    // -state invariant shared by closeOutput/fireError). A pre-abort here would
    // fire the signal mid-transition; matches the Go SDK's Cancel == FireError.
    this.fireError(new InvocationError(ERR_CANCELLED, "invocation cancelled"));
  }

  get outputs(): AsyncIterable<O> {
    return {
      [Symbol.asyncIterator]: () => {
        // Single-consumer, acquire-once: the first acquisition claims the
        // sequence; a second throws rather than splitting outputs. Failing
        // at the acquisition site (not a later read) is deliberate — a
        // second consumer is a programming bug.
        if (this.outputsConsumed) {
          throw new InvocationError(ERR_ALREADY_CONSUMED, "outputs already consumed");
        }
        this.outputsConsumed = true;
        return {
          next: () => this.readNext(),
          // Abandoning the sequence early (a `break`, or `single` bailing
          // on a second item) cancels the invocation, so an early exit
          // tears down cleanly without reaching back to the handle.
          return: async (): Promise<IteratorResult<O, void>> => {
            await this.cancel();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  /**
   * Pulls one output. Order matters: drain the queue BEFORE checking state.
   * This is what guarantees queued outputs always surface before a terminal
   * error, even when emitOutput and fireError run in the same microtask.
   */
  private async readNext(): Promise<IteratorResult<O, void>> {
    if (this.outputQueue.length > 0) {
      const value = this.outputQueue.shift()!;
      // Freed a slot: admit the eldest parked producer, preserving order.
      const producer = this.outputProducerWaiters.shift();
      if (producer) {
        this.outputQueue.push(producer.value);
        producer.resolve();
      }
      return { value, done: false };
    }
    // terminalError is set iff the state moved to "errored" (fireError is
    // the only transition), so the assertion cannot fire on undefined.
    if (this.state === "errored") throw this.terminalError!;
    if (this.state === "closed") return { value: undefined, done: true };

    const r = await new Promise<IteratorResult<O, void>>((resolve) => {
      this.outputWaiters.push(resolve);
    });
    // Resolved by emitOutput (a value), closeOutput (done), or fireError
    // (done). If handed a value, deliver it unconditionally — re-checking
    // `errored` here would drop a value delivered in the same microtask as
    // a following fireError. Only a `done` resolution surfaces the error.
    // (terminalError is set iff the state moved to "errored".)
    if (r.done && this.terminalError) throw this.terminalError;
    return r;
  }

  trailer(): Metadata {
    if (this.state === "open") {
      throw new Error(
        "openbindings: trailer() is valid only after the invocation has terminated",
      );
    }
    return this.trailerMd ?? {};
  }

  // ----- Binding-facing -----

  inputs(): AsyncIterable<I> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<I, void>>((resolve, reject) => {
            // Terminal failure surfaces to the binding as a thrown error;
            // inputs are not drained past it (the binding must stop).
            if (this.state === "errored") {
              // terminalError is set iff the state moved to "errored" (see
              // read()); the assertion cannot fire on undefined.
              reject(this.terminalError!);
              return;
            }
            if (this.inputBuf.length > 0) {
              const value = this.inputBuf.shift()!;
              const producer = this.inputProducerWaiters.shift();
              if (producer) {
                this.inputBuf.push(producer.value);
                producer.resolve();
              }
              resolve({ value, done: false });
              return;
            }
            if (this.inputSideClosed) {
              resolve({ value: undefined, done: true });
              return;
            }
            if (this.inputWaiters.length > 0) {
              // A second concurrent reader is a binding bug (e.g. a bidi
              // binding spawning two read loops): fail loudly instead of
              // racing the buffer.
              reject(
                new InvocationError(
                  ERR_ALREADY_CONSUMED,
                  "concurrent inputs() readers on one invocation",
                ),
              );
              return;
            }
            this.inputWaiters.push({ resolve, reject });
          }),
      }),
    };
  }

  closeInput(): Promise<void> {
    return this.close();
  }

  async emitOutput(output: O): Promise<void> {
    if (this.state !== "open") {
      throw (
        this.terminalError ??
        new InvocationError(ERR_INVOCATION_CLOSED, "invocation is closed")
      );
    }
    // Header settles with the first output if the binding never set it.
    this.settleHeader();

    const waiter = this.outputWaiters.shift();
    if (waiter) {
      waiter({ value: output, done: false });
      return;
    }
    if (this.outputQueue.length < OUTPUT_BUFFER_CAPACITY) {
      this.outputQueue.push(output);
      return;
    }
    // Buffer full: park. This is backpressure reaching the binding's read
    // loop. Rejected (not stranded) if the invocation terminates meanwhile.
    await new Promise<void>((resolve, reject) => {
      this.outputProducerWaiters.push({ value: output, resolve, reject });
    });
  }

  closeOutput(): void {
    if (this.state !== "open") return;
    this.state = "closed";
    this.inputSideClosed = true;
    this.resolveInputClosed();
    this.settleHeader();

    while (this.outputWaiters.length > 0) {
      this.outputWaiters.shift()!({ value: undefined, done: true });
    }
    // An emit parked at close is a binding bug ("terminate exactly once"),
    // but it must not strand: reject it.
    const closedErr = () =>
      new InvocationError(ERR_INVOCATION_CLOSED, "invocation is closed");
    while (this.outputProducerWaiters.length > 0) {
      this.outputProducerWaiters.shift()!.reject(closedErr());
    }
    // Normal close: the binding's input loop exits cleanly.
    while (this.inputWaiters.length > 0) {
      this.inputWaiters.shift()!.resolve({ value: undefined, done: true });
    }
    while (this.inputProducerWaiters.length > 0) {
      this.inputProducerWaiters.shift()!.reject(closedErr());
    }
    this.resolveClosed();
    // The signal fires on every terminal transition (the TS analog of the
    // Go SDK's Done() channel): anything still doing work on behalf of this
    // invocation tears down. Aborted last so listeners observe settled state.
    this.controller.abort();
  }

  fireError(error: InvocationError): void {
    if (this.state !== "open") return;
    this.state = "errored";
    this.terminalError = error;
    this.inputSideClosed = true;
    this.resolveInputClosed();
    this.settleHeader();

    // Drain order: parked output consumers resolve `done` and re-surface
    // the terminal on their next-state check (queued values, when present,
    // were already ahead of any parked consumer by the buffer invariant);
    // THEN parked producers reject.
    while (this.outputWaiters.length > 0) {
      this.outputWaiters.shift()!({ value: undefined, done: true });
    }
    while (this.outputProducerWaiters.length > 0) {
      this.outputProducerWaiters.shift()!.reject(error);
    }
    // Terminal failure: the binding's input loop THROWS (vs the clean exit
    // on closeOutput) — this is what makes "honor signal, only signal"
    // structurally true for bindings.
    while (this.inputWaiters.length > 0) {
      this.inputWaiters.shift()!.reject(error);
    }
    while (this.inputProducerWaiters.length > 0) {
      this.inputProducerWaiters.shift()!.reject(error);
    }
    this.rejectClosed(error);
    // The signal fires on every terminal transition, not just cancel():
    // a terminal raised on the caller side (e.g. an input-validation
    // failure) must tear down the binding's underlying work too. Without
    // this, a binding parked on inputs()/transport strands forever.
    this.controller.abort();
  }

  setHeader(md: Metadata): void {
    if (this.headerSettled) {
      throw new Error(
        "openbindings: setHeader must precede the first emitOutput/closeOutput",
      );
    }
    this.headerMd = md;
    this.settleHeader();
  }

  setTrailer(md: Metadata): void {
    if (this.state !== "open") {
      // Terminal state is reachable at any time via caller/upstream
      // cancellation, so a binding may legally set trailers on an async task
      // after the invocation has already settled. Per the documented contract
      // ("late sets are dropped"), this is a no-op rather than a throw —
      // throwing here would surface a benign cancellation race as a crash,
      // and diverge from the Go SDK's SetTrailer.
      return;
    }
    this.trailerMd = md;
  }

  private settleHeader(): void {
    if (this.headerSettled) return;
    this.headerSettled = true;
    this.resolveHeader(this.headerMd ?? {});
  }
}

// ---------------------------------------------------------------------------
// The one blessed terminal: single
// ---------------------------------------------------------------------------

/**
 * Yields exactly one output. Errors `ERR_EXPECTED_SINGLE` on zero outputs or
 * on a second output — short-circuiting on the second item (no whole-stream
 * buffering) and cancelling the invocation via the iterator's `return()`.
 *
 * `single` is a checked assertion ("I expect one; verify it"), never a mode
 * ("run it unary"): a short-circuit tears down a live invocation, so use it
 * only when confident the selected binding yields one output. It consumes
 * the sequence (single-consumer, acquire-once) and returns the payload
 * only; metadata is read from the handle you still hold.
 *
 * A terminal error after the first output surfaces as that error, not as a
 * false "got more".
 */
export async function single<O>(outputs: AsyncIterable<O>): Promise<O> {
  // Claims the sequence (throws ERR_ALREADY_CONSUMED if already taken).
  const it = outputs[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) {
    throw new InvocationError(ERR_EXPECTED_SINGLE, "expected one output, got none");
  }
  const second = await it.next();
  if (!second.done) {
    await it.return?.(); // abandon -> cancel
    throw new InvocationError(ERR_EXPECTED_SINGLE, "expected one output, got more");
  }
  return first.value;
}
