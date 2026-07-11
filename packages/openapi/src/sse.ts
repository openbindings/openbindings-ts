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
import { errorMessage } from "./util.js";

/**
 * Bounds individual SSE line length to prevent runaway memory use from a
 * misbehaving server. The W3C SSE spec does not impose a line limit, but a
 * single 16 MB line is generous in practice (Go parity: sseMaxLineBytes).
 */
const SSE_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Reports whether the given Content-Type header value indicates a
 * Server-Sent Events stream. Per the W3C SSE specification, the MIME type
 * is `text/event-stream`. Charset and other parameters may follow.
 */
export function isSSEContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  let mt = contentType.trim().toLowerCase();
  const i = mt.indexOf(";");
  if (i >= 0) mt = mt.slice(0, i).trim();
  return mt === "text/event-stream";
}

/**
 * Reads a `text/event-stream` HTTP response body line by line per the W3C
 * Server-Sent Events specification, emitting each parsed event as one output
 * on the invocation handle. It takes ownership of the terminal transition:
 * `closeOutput` when the body is exhausted cleanly, `fireError`
 * (ERR_STREAM_ERROR) on a read failure, and a clean return (the handle is
 * already terminal) when the caller cancels.
 *
 * SSE event field handling (Go parity — sse.go):
 *
 *   - `data:` lines accumulate; multiple data lines for one event are joined
 *     with a literal newline (per the spec)
 *   - `event:`, `id:`, `retry:` fields are FRAMING: they ride the per-unit
 *     meta (x-sse-event / x-sse-id / x-sse-retry), never the output value
 *   - Comment lines (starting with `:`) are ignored
 *   - Blank lines dispatch the accumulated event
 *
 * Decode runs per delivery unit (event) through the consultation seam. The
 * builtin lane follows the response's Content-Type header —
 * text/event-stream, hence text — never payload sniffing; JSON event
 * payloads are an OutputDecoder case. Status carries the initial response's
 * status on every unit (it is real and invocation-scoped, never fabricated);
 * classification ran once, at dispatch.
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
  let eventID = "";
  let dataLines: string[] = [];
  let retryMs = 0;

  const status = resp.status;

  // dispatch decodes and emits the accumulated event. It returns false when
  // the invocation terminated (decode error fired, or the emit rejected
  // because the handle went terminal while parked), signalling the caller to
  // stop reading the body.
  const dispatch = async (): Promise<boolean> => {
    if (dataLines.length === 0 && eventName === "" && eventID === "") {
      return true;
    }
    const rawData = dataLines.join("\n");

    // Per-unit meta: invocation-scoped headers merged with this event's
    // framing fields.
    const meta: Metadata = { ...invocationMeta };
    if (eventName !== "") meta["x-sse-event"] = [eventName];
    if (eventID !== "") meta["x-sse-id"] = [eventID];
    if (retryMs !== 0) meta["x-sse-retry"] = [String(retryMs)];

    const raw: RawResult = { status, body: rawData, meta };
    let data: unknown;
    try {
      data = await decodeThroughHooks(args.hooks, site, raw, builtinDecode);
    } catch (e: unknown) {
      // A decode error mid-stream is terminal; already-emitted outputs
      // stand (drain-before-terminal).
      inv.fireError(
        e instanceof InvocationError
          ? e
          : new InvocationError(ERR_STREAM_ERROR, errorMessage(e)),
      );
      return false;
    }

    eventName = "";
    eventID = "";
    dataLines = [];
    retryMs = 0;

    try {
      await inv.emitOutput(data);
      return true;
    } catch {
      return false; // the invocation terminated while the emit was parked
    }
  };

  // processLine handles one complete (newline-terminated) SSE line.
  const processLine = async (line: string): Promise<boolean> => {
    // Strip optional trailing CR (servers may send CRLF).
    if (line.endsWith("\r")) line = line.slice(0, -1);

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
        eventID = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "retry": {
        const ms = Number.parseInt(value, 10);
        if (Number.isInteger(ms) && ms >= 0) retryMs = ms;
        break;
      }
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
  let buffer = "";

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
        // Flush the pending accumulated event before surfacing the stream
        // error (Go parity: the scan loop exits, the pending dispatch
        // flushes, THEN scanner.Err() fires ERR_STREAM_ERROR).
        if (!(await dispatch())) return;
        inv.fireError(new InvocationError(ERR_STREAM_ERROR, errorMessage(e)));
        return;
      }
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!(await processLine(line))) {
          await reader.cancel().catch(() => {});
          return;
        }
      }

      if (buffer.length > SSE_MAX_LINE_BYTES) {
        await reader.cancel().catch(() => {});
        inv.fireError(
          new InvocationError(
            ERR_STREAM_ERROR,
            `SSE line exceeds ${SSE_MAX_LINE_BYTES} byte limit`,
          ),
        );
        return;
      }
    }

    buffer += decoder.decode();
    // Process any final unterminated line, then flush the pending event when
    // the body ends without a trailing blank line.
    if (buffer !== "") {
      if (!(await processLine(buffer))) return;
    }
    if (!(await dispatch())) return;

    inv.closeOutput();
  } finally {
    reader.releaseLock();
  }
}
