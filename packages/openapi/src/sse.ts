import {
  InvocationError,
  ERR_STREAM_ERROR,
  decodeThroughHooks,
  type BindingHandle,
  type BindingInvocationArgs,
  type InvokeSite,
  type Metadata,
  type OutputDecoder,
  type RawResult,
} from "@openbindings/sdk";
import { normalizeMediaType } from "./media.js";
import { errorMessage } from "./util.js";

/**
 * Bounds individual SSE line length to prevent runaway memory use from a
 * misbehaving server. The WHATWG SSE spec does not impose a line limit, but
 * a single 16 MB line is generous in practice (Go parity: sseMaxLineBytes).
 */
const SSE_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Reports whether the given Content-Type header value indicates a
 * Server-Sent Events stream (`text/event-stream`). Charset and other
 * parameters may follow.
 */
export function isSSEContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return normalizeMediaType(contentType) === "text/event-stream";
}

/**
 * Reads a `text/event-stream` HTTP response body per the WHATWG
 * server-sent events processing model (openbindings.openapi@1 §8,
 * OAPI-P-06), emitting one output per received event on the invocation
 * handle. It takes ownership of the terminal transition: `closeOutput`
 * when the body is exhausted cleanly, `fireError` (ERR_STREAM_ERROR) on a
 * read failure (abnormal termination is a failure outcome; output values
 * already emitted stand), and a clean return (the handle is already
 * terminal) when the caller cancels.
 *
 * Event extraction, per the WHATWG model:
 *
 *   - `data:` lines accumulate; an event's data lines joined with U+000A
 *     form the event's text
 *   - comment-only and empty-`data` events emit no value (an event whose
 *     joined data text is empty is discarded, `event:`/`id:`-only events
 *     included)
 *   - `event`, `id`, and `retry` are FRAMING: they never enter the output
 *     value. This implementation surfaces them out of band on the per-unit
 *     meta (x-sse-event / x-sse-id / x-sse-retry); the last event ID
 *     persists across events until changed, WHATWG lastEventId semantics
 *   - CRLF, lone CR, and lone LF all terminate lines; one leading U+FEFF
 *     BOM is ignored
 *   - an incomplete final event (end of stream before its dispatching
 *     blank line) is discarded, never flushed
 *
 * Decode runs per delivery unit (event) through the consultation seam. The
 * builtin lane is the per-event text default (OAPI-P-07): the event's
 * U+000A-joined data text itself — SSE events carry no per-event framing
 * to decide otherwise, so JSON-emitting endpoints decode via consumer
 * configuration at the decode point. Status carries the initial response's
 * status on every unit (it is real and invocation-scoped, never
 * fabricated); classification ran once, at dispatch.
 */
export async function streamSSE(
  resp: Response,
  args: BindingInvocationArgs,
  site: InvokeSite,
  inv: BindingHandle<unknown, unknown>,
  invocationMeta: Metadata,
  builtinDecode: OutputDecoder,
): Promise<void> {
  let eventName = "";
  let lastEventID = "";
  let dataLines: string[] = [];
  let retryMs = 0;
  let firstLine = true;

  const status = resp.status;

  // dispatch decodes and emits the accumulated event. It returns false when
  // the invocation terminated (decode error fired, or the emit rejected
  // because the handle went terminal while parked), signalling the caller
  // to stop reading the body.
  const dispatch = async (): Promise<boolean> => {
    const rawData = dataLines.join("\n");
    const name = eventName;
    eventName = "";
    dataLines = [];
    // Comment-only and empty-data events emit no value: an event whose
    // joined data text is empty is discarded (WHATWG step 2 plus the
    // trailing-newline strip; the last event ID, already set, persists).
    if (rawData === "") return true;

    // Per-unit meta: invocation-scoped headers merged with this event's
    // framing fields.
    const meta: Metadata = { ...invocationMeta };
    if (name !== "") meta["x-sse-event"] = [name];
    if (lastEventID !== "") meta["x-sse-id"] = [lastEventID];
    if (retryMs !== 0) {
      meta["x-sse-retry"] = [String(retryMs)];
      retryMs = 0;
    }

    const raw: RawResult = { status, body: rawData, meta };
    let data: unknown;
    try {
      data = await decodeThroughHooks(args.hooks, site, raw, builtinDecode);
    } catch (e: unknown) {
      // A decode error mid-stream is terminal; already-emitted outputs
      // stand (drain-before-terminal).
      inv.fireError(
        e instanceof InvocationError ? e : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
      );
      return false;
    }

    try {
      await inv.emitOutput(data);
      return true;
    } catch {
      return false; // the invocation terminated while the emit was parked
    }
  };

  // processLine handles one complete SSE line (terminator already removed).
  const processLine = async (line: string): Promise<boolean> => {
    if (firstLine) {
      // One leading U+FEFF BOM is ignored per the WHATWG stream grammar.
      if (line.startsWith("\uFEFF")) line = line.slice(1);
      firstLine = false;
    }

    if (line === "") {
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
      // Per spec, a single leading space in the value is stripped.
      if (value.startsWith(" ")) value = value.slice(1);
    } else {
      // A line with no colon is treated as a field with empty value.
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
        // ASCII digits only, per WHATWG; anything else is ignored.
        if (/^[0-9]+$/.test(value)) retryMs = Number.parseInt(value, 10);
        break;
      // Unknown fields are ignored per spec.
    }
    return true;
  };

  const body = resp.body;
  if (!body) {
    // An empty stream: nothing to flush; close cleanly.
    inv.closeOutput();
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
      if (inv.signal.aborted) {
        await reader.cancel().catch(() => {});
        return; // cancelled; the handle is already terminal
      }

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e: unknown) {
        if (inv.signal.aborted) return;
        // Abnormal termination is a failure outcome; output values already
        // emitted stand, and the incomplete pending event is DISCARDED —
        // never flushed (WHATWG; Go parity).
        inv.fireError(new InvocationError(ERR_STREAM_ERROR, errorMessage(e)));
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
        inv.fireError(
          new InvocationError(ERR_STREAM_ERROR, `SSE line exceeds ${SSE_MAX_LINE_BYTES} byte limit`),
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
    inv.closeOutput();
  } finally {
    reader.releaseLock();
  }
}
