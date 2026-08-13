/**
 * SSE subscription streaming for the AsyncAPI invoker (openbindings.asyncapi@1
 * §8, ASYNC-P-06): reads an established `text/event-stream` response per the
 * WHATWG server-sent events processing model — incorporated for EVENT
 * FRAMING ONLY — emitting one output value per event as units arrive
 * (ASYNC-P-05). Mirrors the Go SDK's streamSSE in invoke.go (and openapi's
 * sse.ts — format packages do not share private helpers).
 *
 * Event extraction, per the WHATWG model:
 *
 *   - `data:` lines accumulate; an event's data lines joined with U+000A
 *     form the event's text
 *   - comment-only and empty-`data` events emit nothing
 *   - `event`, `id`, and `retry` are FRAMING: they never enter the output
 *     value; they surface out of band on the per-unit meta
 *     (x-sse-event / x-sse-id / x-sse-retry). `retry` is never acted on:
 *     reconnection is a revision-1 exclusion — one transport, one
 *     invocation
 *   - CRLF, lone CR, and lone LF all terminate lines; one leading U+FEFF
 *     BOM is ignored; exactly one leading space is stripped from a field
 *     value; a line with no colon is a field with an empty value
 *   - an incomplete final event (end of stream before its dispatching
 *     blank line) is discarded, never flushed
 *
 * Owns the terminal transition: closeOutput on clean transport close
 * (which COMPLETES the subscription), ERR_STREAM_ERROR on a read failure,
 * a clean return when the caller cancels. The size cap is PER EVENT, not
 * cumulative (ERR_RESPONSE_ERROR): a long-lived subscription legitimately
 * streams more than the cap in total.
 */

import {
  InvocationError,
  ERR_RESPONSE_ERROR,
  ERR_STREAM_ERROR,
  decodeThroughHooks,
  resolveDeliveryUnitLimit,
  type BindingHandle,
  type BindingInvocationArgs,
  type InvokeSite,
  type Metadata,
  type OutputDecoder,
  type RawResult,
} from "@openbindings/sdk";

/**
 * Bounds buffered not-yet-terminated line length to prevent runaway memory
 * use from a misbehaving server (Go parity: sseMaxLineBytes). STAYS FIXED
 * under the delivery-unit knob: a line-framing scan guard on unterminated
 * text, not a bound on a delivery unit (the per-event cap below is the
 * delivery-unit bound and is consumer-configurable).
 */
const SSE_MAX_LINE_BYTES = 16 * 1024 * 1024;

export async function streamSSE(
  resp: Response,
  args: BindingInvocationArgs,
  site: InvokeSite,
  h: BindingHandle<unknown, unknown>,
  invocationMeta: Metadata,
  builtinDecode: OutputDecoder,
): Promise<void> {
  let eventName = "";
  let lastEventID = "";
  let dataLines: string[] = [];
  let retryMs = 0;
  let eventBytes = 0;
  let firstLine = true;

  const status = resp.status;
  const byteLength = new TextEncoder();
  // Per-event size cap — each event is one delivery unit, so the
  // consumer-configurable delivery-unit bound applies
  // (args.maxDeliveryUnitBytes, default 10MB; Go parity).
  const maxEventBytes = resolveDeliveryUnitLimit(args);

  // dispatch decodes and emits the accumulated event. It returns false when
  // the invocation terminated (decode error fired, or the emit rejected
  // because the handle went terminal while parked), signalling the caller
  // to stop reading the body.
  const dispatch = async (): Promise<boolean> => {
    const rawData = dataLines.join("\n");
    const name = eventName;
    eventName = "";
    dataLines = [];
    // Comment-only and empty-data events emit nothing (§8): an event whose
    // joined data text is empty is discarded.
    if (rawData === "") return true;

    // Per-unit meta: invocation-scoped headers merged with this event's
    // framing fields (out of band — never the output value).
    const meta: Metadata = { ...invocationMeta };
    if (name !== "") meta["x-sse-event"] = [name];
    if (lastEventID !== "") meta["x-sse-id"] = [lastEventID];
    if (retryMs !== 0) {
      meta["x-sse-retry"] = [String(retryMs)];
      retryMs = 0;
    }

    const raw: RawResult = { status, body: rawData, meta };
    let ev: unknown;
    try {
      ev = await decodeThroughHooks(args.hooks, site, raw, builtinDecode);
    } catch (e: unknown) {
      // A decode error mid-stream is terminal; already-emitted outputs
      // stand (drain-before-terminal).
      h.fireError(
        e instanceof InvocationError ? e : new InvocationError(ERR_RESPONSE_ERROR),
      );
      return false;
    }
    try {
      await h.emitOutput(ev);
      return true;
    } catch {
      return false; // the invocation terminated while the emit was parked
    }
  };

  // processLine handles one complete SSE line (terminator already removed).
  // Returns false to stop reading (invocation terminal or cap tripped).
  const processLine = async (line: string): Promise<boolean> => {
    if (firstLine) {
      // One leading U+FEFF BOM is ignored per the WHATWG stream grammar.
      if (line.startsWith("\uFEFF")) line = line.slice(1);
      firstLine = false;
    }

    // The size cap is PER EVENT, not cumulative (the same choice the Go
    // SDK's streamSSE documents for its per-event cap).
    eventBytes += byteLength.encode(line).length + 1; // +1 for the newline
    if (eventBytes > maxEventBytes) {
      h.fireError(
        new InvocationError(ERR_RESPONSE_ERROR),
      );
      return false;
    }

    if (line === "") {
      eventBytes = 0;
      return dispatch();
    }
    if (line.startsWith(":")) {
      return true; // comment line; ignored per spec
    }

    let field: string;
    let value: string;
    const i = line.indexOf(":");
    if (i >= 0) {
      field = line.slice(0, i);
      value = line.slice(i + 1);
      // Exactly one leading space in the value is stripped, per spec.
      if (value.startsWith(" ")) value = value.slice(1);
    } else {
      // A line with no colon is a field with an empty value.
      field = line;
      value = "";
    }

    switch (field) {
      case "event":
        eventName = value;
        break;
      case "id":
        // A value containing U+0000 NULL is ignored; otherwise it sets the
        // last event ID (an empty value resets it), per WHATWG.
        if (!value.includes("\0")) lastEventID = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "retry":
        // ASCII digits only, per WHATWG; recorded on meta only — never
        // acted on (reconnection is excluded from revision 1).
        if (/^[0-9]+$/.test(value)) retryMs = Number.parseInt(value, 10);
        break;
      // Unknown fields are ignored per spec.
    }
    return true;
  };

  const body = resp.body;
  if (!body) {
    // An empty stream: nothing buffered, nothing flushed; close cleanly.
    h.closeOutput();
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  // buffer holds text with no line terminator yet; scanned marks how far
  // terminator scanning has advanced (everything before it is known
  // terminator-free), so an arriving chunk never re-scans text a previous
  // round already checked — a single line spanning many chunks stays
  // linear in stream size. A trailing CR is held back one round because
  // the LF of a CRLF pair may not have arrived yet.
  let buffer = "";
  let scanned = 0;
  // Per-invocation (never module-level: lastIndex is mutable state and
  // interleaved invocations would corrupt each other's scans).
  const terminator = /\r\n|\r|\n/g;

  // drainLines extracts every complete line from the buffer per the WHATWG
  // event-stream line grammar (CRLF, lone CR, or lone LF terminate a line).
  const drainLines = async (atEOF: boolean): Promise<boolean> => {
    let start = 0;
    terminator.lastIndex = scanned;
    for (;;) {
      const m = terminator.exec(buffer);
      if (!m) break;
      // A lone CR at the buffer's edge may be the first half of a CRLF
      // pair whose LF has not arrived; hold it back until more data (or EOF).
      if (m[0] === "\r" && m.index + 1 === buffer.length && !atEOF) break;
      if (!(await processLine(buffer.slice(start, m.index)))) return false;
      start = m.index + m[0].length;
      terminator.lastIndex = start;
    }
    buffer = buffer.slice(start);
    scanned = buffer.endsWith("\r") && !atEOF ? buffer.length - 1 : buffer.length;
    return true;
  };

  try {
    for (;;) {
      if (h.signal.aborted) {
        await reader.cancel().catch(() => {});
        return; // cancelled; the handle is already terminal
      }

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (h.signal.aborted) return;
        // Abnormal termination is a failure outcome; output values already
        // emitted stand, and the incomplete pending event is DISCARDED —
        // never flushed (WHATWG; Go parity).
        h.fireError(new InvocationError(ERR_STREAM_ERROR));
        return;
      }
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      if (!(await drainLines(false))) {
        await reader.cancel().catch(() => {});
        return;
      }

      if (buffer.length > SSE_MAX_LINE_BYTES) {
        await reader.cancel().catch(() => {});
        h.fireError(
          new InvocationError(ERR_STREAM_ERROR),
        );
        return;
      }
    }

    buffer += decoder.decode();
    // A final line with no terminator still parses as a line; the event it
    // belongs to has no dispatching blank line, so it is discarded below.
    if (!(await drainLines(true))) return;
    if (buffer !== "") {
      if (!(await processLine(buffer))) return;
    }

    // End of stream: an incomplete final event (no dispatching blank line)
    // is discarded per the WHATWG processing model — never flushed.
    h.closeOutput();
  } finally {
    reader.releaseLock();
  }
}
