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
} from "./errcodes.js";
import type { InvocationErrorCode } from "./errcodes.js";

/**
 * The structured error type for all terminal invocation failures. A class
 * (not a plain shape) so it carries a stack trace and supports `instanceof`.
 *
 * The terminal error frame is the portable unsuccessful-completion signal.
 * `data`, when present, carries portable JSON defined by the authority that
 * owns `code`, or an opaque application-authored failure value admitted by the
 * governing binding rules. Protocol and implementation evidence never belongs
 * on this abstract record. The inherited Error.message is local presentation
 * only and serializes neither on invoker frames nor through JSON.stringify.
 */
export class InvocationError extends Error {
  readonly code: InvocationErrorCode | (string & {});
  declare readonly data?: unknown;

  constructor(
    code: InvocationErrorCode | (string & {}),
    data?: unknown,
  ) {
    if (typeof code !== "string" || code.length === 0) {
      throw new TypeError("InvocationError code must be a nonempty string");
    }
    const normalized = data === undefined ? undefined : normalizePortableInvocationData(data);
    if (data !== undefined && normalized === INVALID_PORTABLE_DATA) {
      throw new TypeError("InvocationError data must be a JSON-domain value");
    }
    if (code === CONTEXT_REQUIRED && !isContextRequiredDetails(normalized)) {
      throw new TypeError("CONTEXT_REQUIRED data must be a valid ContextRequiredDetails object");
    }
    super(code);
    Object.defineProperty(this, "name", { value: "InvocationError", configurable: true });
    this.code = code;
    if (data !== undefined) {
      Object.defineProperty(this, "data", {
        value: normalized,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }
}

/** True when a value can cross an invoker frame without native-type coercion. */
export function isPortableInvocationData(value: unknown): boolean {
  return normalizePortableInvocationData(value) !== INVALID_PORTABLE_DATA;
}

const INVALID_PORTABLE_DATA = Symbol("invalid portable invocation data");

function normalizePortableInvocationData(value: unknown): unknown {
  if (!portableJSONValue(value, new Set<object>())) return INVALID_PORTABLE_DATA;
  // Validation above excludes accessors, custom prototypes, cycles, holes,
  // hidden fields, symbols, and non-finite numbers. A JSON round-trip then
  // gives in-process callers the same value that framed callers observe
  // (including normalization such as -0 to 0).
  return deepFreezeJSON(JSON.parse(JSON.stringify(value)) as unknown);
}

function deepFreezeJSON(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeJSON(child);
    Object.freeze(value);
  }
  return value;
}

function portableJSONValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return false;
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) return false;
      if (Object.getOwnPropertySymbols(value).length > 0) return false;
      return value.every((item) => portableJSONValue(item, ancestors));
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    const keys = Object.keys(value);
    if (Object.getOwnPropertyNames(value).length !== keys.length) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
      if (!portableJSONValue(descriptor.value, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

/** Map every caller-owned abort into the invocation interface's one code. */
function abortToTerminal(_reason: unknown): InvocationError {
  return new InvocationError(ERR_CANCELLED);
}

/**
 * Multi-valued binding-native metadata used inside artifact-specific hooks.
 * It is not exposed by the abstract invocation handle.
 */
export type Metadata = Record<string, string[]>;

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
   * indistinguishable — and keys scheme-scoped lookup in
   * `BindingContext.credentials` (with historical `apiKeys` support for API
   * keys). Absent when the
   * artifact declares the scheme inline with no addressable name.
   */
  name?: string;
  /**
   * Whether resolved context MAY be persisted and reused. Defaults to false;
   * only `durable: true` permits persistence. The contract
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
 * The data payload of a `CONTEXT_REQUIRED` terminal error, per the
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
  data: ContextRequiredDetails,
): InvocationError {
  return new InvocationError(CONTEXT_REQUIRED, data);
}

/**
 * Builds a `config.value` {@link ContextRequirement} — the binding-invoker
 * family for a configuration value a binding needs but the artifact
 * does not supply (a server variable with no default, a channel address a
 * service generates at runtime). `point` names the binding-specification
 * configuration point ("server", "address", …); `path` is a JSON Pointer
 * relative to that point, with the empty pointer addressing the whole point;
 * `choices` carries values declared by the artifact, while the
 * governing binding specification decides whether that list is closed or
 * advisory. `durable` defaults to false; pass `true` only when reuse is
 * permitted. For example, `/variables/region` addresses
 * `configuration[point].variables.region` and `/value` addresses a member
 * literally named `value`.
 */
export function configValueRequirement(
  point: string,
  path: string,
  description: string,
  choices?: string[],
  durable?: boolean,
): ContextRequirement {
  const req: ContextRequirement = { type: "config.value", point, path, description };
  if (choices && choices.length > 0) req.choices = choices;
  if (durable !== undefined) req.durable = durable;
  return req;
}

/** Narrows a terminal error to a CONTEXT_REQUIRED challenge with usable data. */
export function isContextRequired(
  err: unknown,
): err is InvocationError & { data: ContextRequiredDetails } {
  return err instanceof InvocationError
    && err.code === CONTEXT_REQUIRED
    && isContextRequiredDetails(err.data);
}

/** Validates the complete portable CONTEXT_REQUIRED data shape. */
export function isContextRequiredDetails(value: unknown): value is ContextRequiredDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  if (Object.keys(details).some((key) => key !== "target" && key !== "alternatives")) return false;
  if (typeof details["target"] !== "string") return false;
  const alternatives = details["alternatives"];
  if (!Array.isArray(alternatives) || alternatives.length === 0) return false;
  return alternatives.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const alternative = candidate as Record<string, unknown>;
    if (Object.keys(alternative).some((key) => key !== "requirements")) return false;
    const requirements = alternative["requirements"];
    if (!Array.isArray(requirements) || requirements.length === 0) return false;
    return requirements.every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const req = raw as Record<string, unknown>;
      if (typeof req["type"] !== "string" || req["type"].length === 0) return false;
      if (
        "name" in req
        && (typeof req["name"] !== "string" || req["name"].length === 0)
      ) return false;
      if ("description" in req && typeof req["description"] !== "string") return false;
      if ("durable" in req && typeof req["durable"] !== "boolean") return false;
      if (req["type"] === "config.value") {
        if (typeof req["point"] !== "string" || req["point"].length === 0) return false;
        if (typeof req["path"] !== "string" || !validConfigurationPointer(req["path"])) return false;
        if (
          "choices" in req
          && (!Array.isArray(req["choices"]) || !req["choices"].every((v) => typeof v === "string"))
        ) return false;
      }
      return true;
    });
  });
}

function validConfigurationPointer(path: string): boolean {
  return path === "" || (path.startsWith("/") && path.split("/").slice(1).every(
    (token) => !/(?:~(?![01]))/.test(token),
  ));
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
 * `data` is not a usable ContextRequiredDetails. This is a local presentation
 * helper; its text is not part of the interoperable error record.
 */
export function contextRequirementSummary(data: unknown): string {
  const d = data as ContextRequiredDetails | undefined;
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
   * same `InvocationError` (the binding never sees the rejected input value). Used by
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

  private resolveClosed!: () => void;
  private rejectClosed!: (e: InvocationError) => void;
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
            // The interface intentionally treats every caller-owned abort,
            // including AbortSignal.timeout(), as ERR_CANCELLED.
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
        new InvocationError(ERR_INVOCATION_CLOSED)
      );
    }
    if (this.inputSideClosed) {
      throw new InvocationError(ERR_INPUT_CLOSED);
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
        .reject(new InvocationError(ERR_INPUT_CLOSED));
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
    this.fireError(new InvocationError(ERR_CANCELLED));
  }

  get outputs(): AsyncIterable<O> {
    return {
      [Symbol.asyncIterator]: () => {
        // Single-consumer, acquire-once: the first acquisition claims the
        // sequence; a second throws rather than splitting outputs. Failing
        // at the acquisition site (not a later read) is deliberate — a
        // second consumer is a programming bug.
        if (this.outputsConsumed) {
          throw new InvocationError(ERR_ALREADY_CONSUMED);
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
                new InvocationError(ERR_ALREADY_CONSUMED),
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
        new InvocationError(ERR_INVOCATION_CLOSED)
      );
    }
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
    while (this.outputWaiters.length > 0) {
      this.outputWaiters.shift()!({ value: undefined, done: true });
    }
    // An emit parked at close is a binding bug ("terminate exactly once"),
    // but it must not strand: reject it.
    const closedErr = () =>
      new InvocationError(ERR_INVOCATION_CLOSED);
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
 * only.
 *
 * A terminal error after the first output surfaces as that error, not as a
 * false "got more".
 */
export async function single<O>(outputs: AsyncIterable<O>): Promise<O> {
  // Claims the sequence (throws ERR_ALREADY_CONSUMED if already taken).
  const it = outputs[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) {
    throw new InvocationError(ERR_EXPECTED_SINGLE);
  }
  const second = await it.next();
  if (!second.done) {
    await it.return?.(); // abandon -> cancel
    throw new InvocationError(ERR_EXPECTED_SINGLE);
  }
  return first.value;
}
