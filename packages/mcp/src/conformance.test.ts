/**
 * Conformance suite for openbindings.mcp@1, ported case-for-case from the
 * Go SDK's formats/mcp/conformance_test.go (commit 5f3df51). The Go tests
 * are the behavioral contract; only the Go-specific mechanisms have no TS
 * equivalent (the raw SSE tee and its sseObserver scanning test — the TS
 * MCP SDK hands progress handlers the notification's raw params minus
 * progressToken, so presence preservation needs no tee and is asserted
 * here at the invoker boundary instead).
 */
import { describe, it, expect } from "vitest";
import {
  ERR_REF_NOT_FOUND,
  ERR_SOURCE_LOAD_FAILED,
  ERR_VALIDATION_FAILED,
  InvocationError,
  single,
  type Invocation,
} from "@openbindings/sdk";
import { MCPInvoker } from "./invoker.js";
import { ENDPOINT, mcpServer, textResult, type MCPServerOptions, type RpcRequest, type RpcReply } from "./testserver.js";

const source = { bindingSpec: "openbindings.mcp@1", location: ENDPOINT };

/** Drains the output stream, returning the values and the terminal error (if any). */
async function drain(call: Invocation<unknown, unknown>): Promise<{ vals: unknown[]; err?: InvocationError }> {
  const vals: unknown[] = [];
  try {
    for await (const v of call.outputs) vals.push(v);
  } catch (e) {
    return { vals, err: e as InvocationError };
  }
  return { vals };
}

/**
 * The conformance server (Go: setupConformanceServer): one entity of each
 * family plus a progress-capable tool. The `progress` tool notifies
 * progress twice (total 2) only when the call carried a progressToken,
 * mirroring the Go fixture's NotifyProgress-when-token-attached handler;
 * the template read echoes the concrete URI it was asked to read so tests
 * can observe the RFC 6570 expansion the invoker performed.
 */
function conformanceServer(opts?: Partial<MCPServerOptions>) {
  const respond = (req: RpcRequest): RpcReply => {
    switch (req.method) {
      case "tools/call": {
        if (req.params.name === "progress") {
          const token = req.params._meta?.progressToken;
          if (token !== undefined) {
            return {
              sse: [
                { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } },
                { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2, total: 2 } },
                { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "done" }] } },
              ],
            };
          }
          return textResult("done");
        }
        return textResult("ok");
      }
      case "prompts/get":
        return {
          result: {
            messages: [{ role: "user", content: { type: "text", text: `hi ${(req.params.arguments as Record<string, string> | undefined)?.name ?? ""}` } }],
          },
        };
      case "resources/read": {
        const uri = req.params.uri as string;
        if (uri === "app://static") {
          return { result: { contents: [{ uri, mimeType: "text/plain", text: "s" }] } };
        }
        // Template lane: echo the concrete URI that was read.
        return { result: { contents: [{ uri, mimeType: "text/plain", text: uri }] } };
      }
      default:
        return { error: { code: -32601, message: `unexpected method ${req.method}` } };
    }
  };
  return mcpServer(respond, {
    tools: ["probe", "progress"],
    resources: ["app://static"],
    resourceTemplates: ["file:///logs/{date}"],
    prompts: ["greet"],
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Item 1 — pinned listings (MCP-D-01, §3/§5/§6)
// ---------------------------------------------------------------------------

describe("pinned listings (MCP-D-01)", () => {
  // An invalid pin is refused loudly BEFORE any network I/O: stray members
  // (pagination carriage included) and malformed entity arrays are all
  // outside the pin grammar.
  it.each([
    ["stray nextCursor", { tools: [{ name: "probe" }], nextCursor: "page2" }],
    ["stray _meta", { tools: [{ name: "probe" }], _meta: {} }],
    ["arbitrary stray member", { tools: [{ name: "probe" }], extras: [] }],
    ["non-object content", "not a listing"],
    ["array content", []],
    ["member not an array", { tools: { name: "probe" } }],
    ["entry not an object", { tools: ["probe"] }],
    ["entry missing identity", { tools: [{ description: "no name" }] }],
    ["entry identity not a string", { resources: [{ uri: 7 }] }],
  ])("refuses an invalid pin loudly pre-I/O: %s", async (_name, pin) => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({
      source: { ...source, content: pin },
      ref: "tools/probe",
      fetch: server.fn,
    });
    const { vals, err } = await drain(call);
    expect(vals).toEqual([]);
    expect(err).toMatchObject({ code: ERR_SOURCE_LOAD_FAILED });
    expect(server.fetches()).toBe(0); // refused before network I/O
  });

  // A pin displaces the list requests entirely (§6 content primacy,
  // MCP-P-02): ref resolution is answered from the pin and dispatch
  // proceeds against it.
  it("displaces list requests entirely", async () => {
    const server = conformanceServer();
    const pin = { tools: [{ name: "probe" }] };
    const call = new MCPInvoker().invokeBinding({
      source: { ...source, content: pin },
      ref: "tools/probe",
      fetch: server.fn,
    });
    await call.write({ q: "1" });
    await expect(single(call.outputs)).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(server.count("tools/list")).toBe(0);
    expect(server.count("tools/call")).toBe(1);
  });

  // With a pin, unresolvable and ambiguous refs are refused offline —
  // before any connection (§7, MCP-P-02).
  it.each([
    ["ref matches nothing", "tools/missing", { tools: [{ name: "probe" }] }, /matches no/],
    ["ambiguous tool name", "tools/dup", { tools: [{ name: "dup" }, { name: "dup" }] }, /ambiguous/],
    [
      "ambiguous template",
      "resourceTemplates/file:///x/{id}",
      { resourceTemplates: [{ uriTemplate: "file:///x/{id}" }, { uriTemplate: "file:///x/{id}" }] },
      /ambiguous/,
    ],
    ["empty pin resolves nothing", "prompts/greet", {}, /matches no/],
  ])("refuses %s offline with ERR_REF_NOT_FOUND", async (_name, ref, pin, wantMessage) => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({
      source: { ...source, content: pin },
      ref,
      fetch: server.fn,
    });
    const { err } = await drain(call);
    expect(err).toMatchObject({ code: ERR_REF_NOT_FOUND });
    expect(err!.message).toMatch(wantMessage);
    expect(server.fetches()).toBe(0); // resolution refusals fire before network I/O
  });

  // A pinned static resource resolves offline and dispatches directly.
  it("reads a pinned static resource without list requests", async () => {
    const server = conformanceServer();
    const pin = { resources: [{ uri: "app://static", name: "static" }] };
    const call = new MCPInvoker().invokeBinding({
      source: { ...source, content: pin },
      ref: "resources/app://static",
      fetch: server.fn,
    });
    await expect(single(call.outputs)).resolves.toEqual({
      contents: [{ uri: "app://static", mimeType: "text/plain", text: "s" }],
    });
    expect(server.count("resources/list")).toBe(0);
    expect(server.count("resources/templates/list")).toBe(0);
  });

  // A pinned resource template resolves offline; the input expands the
  // template before resources/read (items 1+7 together).
  it("expands a pinned template per RFC 6570 before resources/read", async () => {
    const server = conformanceServer();
    const pin = { resourceTemplates: [{ uriTemplate: "file:///logs/{date}" }] };
    const call = new MCPInvoker().invokeBinding({
      source: { ...source, content: pin },
      ref: "resourceTemplates/file:///logs/{date}",
      fetch: server.fn,
    });
    await call.write({ date: "2026-07-15" });
    await expect(single(call.outputs)).resolves.toEqual({
      contents: [{ uri: "file:///logs/2026-07-15", mimeType: "text/plain", text: "file:///logs/2026-07-15" }],
    });
    expect(server.count("resources/templates/list")).toBe(0);
    const reads = server.params("resources/read");
    expect(reads).toHaveLength(1);
    expect(reads.at(0)?.uri).toBe("file:///logs/2026-07-15");
  });
});

// ---------------------------------------------------------------------------
// Item 2 — pagination exhaustion (MCP-P-02, §3)
// ---------------------------------------------------------------------------

describe("pagination exhaustion (MCP-P-02)", () => {
  // With a page size of 1, resolving a tool that sorts onto the last page
  // requires following nextCursor to exhaustion; a first-page-only
  // implementation would refuse a perfectly resolvable ref.
  it("follows nextCursor to exhaustion before resolution", async () => {
    const server = conformanceServer({ tools: ["probe", "progress", "zzz-last"], pageSize: 1 });
    const call = new MCPInvoker().invokeBinding({ source, ref: "tools/zzz-last", fetch: server.fn });
    await call.write({});
    await expect(single(call.outputs)).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(server.count("tools/list")).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Item 3 — progress solicitation configuration point (§9.2/§9.3, MCP-P-04/05)
// ---------------------------------------------------------------------------

describe("progress solicitation (§9.3 `solicit`, MCP-P-04/MCP-P-05)", () => {
  // The solicit point is consulted per-invocation configuration →
  // consumer-level configuration → default OFF. The wire tells the truth:
  // solicited calls carry _meta.progressToken, unsolicited calls carry none.
  it.each<
    [name: string, solicitProgress: boolean | undefined, bindCtx: Record<string, unknown> | undefined, wantToken: boolean]
  >([
    ["default off", undefined, undefined, false],
    ["per-invocation opt-in", undefined, { configuration: { solicit: true } }, true],
    ["consumer-level opt-in", true, undefined, true],
    ["per-invocation overrides consumer", true, { configuration: { solicit: false } }, false],
    ["non-bool override declines and falls through", undefined, { configuration: { solicit: "yes" } }, false],
  ])("consults the point in order: %s", async (_name, solicitProgress, bindCtx, wantToken) => {
    const server = conformanceServer();
    const invoker = solicitProgress !== undefined ? new MCPInvoker({ solicitProgress }) : new MCPInvoker();
    const call = invoker.invokeBinding({ source, ref: "tools/progress", context: bindCtx, fetch: server.fn });
    await call.write({});
    const { vals, err } = await drain(call);
    expect(err).toBeUndefined();

    const calls = server.params("tools/call");
    expect(calls).toHaveLength(1);
    const meta = calls.at(0)?._meta;
    expect(meta !== undefined && "progressToken" in meta).toBe(wantToken);

    if (!wantToken) {
      // Not solicited: the stream is the result value alone (§9.2) —
      // realization-neutral by default.
      expect(vals).toEqual([{ content: [{ type: "text", text: "done" }] }]);
    } else {
      // Solicited: the result is last; anything before it is a progress
      // value {progress, total?, message?} with progressToken removed.
      expect(vals.length).toBeGreaterThanOrEqual(1);
      expect(vals[vals.length - 1]).toEqual({ content: [{ type: "text", text: "done" }] });
      for (const ev of vals.slice(0, -1)) {
        expect(ev).toMatchObject({ progress: expect.anything() });
        expect(ev).not.toHaveProperty("progressToken");
        expect((ev as Record<string, unknown>).total).toBe(2);
      }
    }
  });

  // The presence-preserving progress value (§9.2, MCP-P-04): an explicit
  // "total": 0 and an explicit "message": "" SURVIVE, an absent total stays
  // absent, and progressToken (correlation plumbing, not output) is
  // removed. Go proves this at its raw SSE tee
  // (TestSolicit_RawPresencePreserved) because go-mcp's typed structs
  // collapse an explicit zero; the TS MCP SDK hands the handler the raw
  // params minus progressToken, so the same behavior is asserted here at
  // the invoker boundary.
  it("preserves presence in progress values: explicit total:0 and message:'' survive, absent stays absent", async () => {
    const server = mcpServer(
      (req) => ({
        sse: [
          {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: req.params._meta?.progressToken, progress: 1, total: 0, message: "" },
          },
          {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: req.params._meta?.progressToken, progress: 2 },
          },
          { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "done" }] } },
        ],
      }),
      { tools: ["long_job"] },
    );
    const call = new MCPInvoker({ solicitProgress: true }).invokeBinding({
      source,
      ref: "tools/long_job",
      fetch: server.fn,
    });
    await call.write({});
    const { vals, err } = await drain(call);
    expect(err).toBeUndefined();

    expect(vals).toHaveLength(3);
    expect(vals[0]).toEqual({ progress: 1, total: 0, message: "" }); // explicit zero/empty survive; token removed
    expect(vals[1]).toEqual({ progress: 2 });
    expect(vals[1]).not.toHaveProperty("total"); // absent stays absent
    expect(vals[2]).toEqual({ content: [{ type: "text", text: "done" }] });
  });
});

// ---------------------------------------------------------------------------
// Item 5 — absent input omits arguments; string-typed refusals (§9.1, MCP-P-03)
// ---------------------------------------------------------------------------

describe("input mapping (§9.1, MCP-P-03)", () => {
  // An absent input value omits the arguments member ENTIRELY on tools/call
  // and prompts/get — never arguments: {} and never arguments: null.
  it.each([
    ["tool, caller closes without writing", "tools/probe", "tools/call"],
    ["prompt, caller closes without writing", "prompts/greet", "prompts/get"],
  ])("omits the arguments member for an absent input: %s", async (_name, ref, method) => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({ source, ref, fetch: server.fn });
    await call.close();
    await expect(single(call.outputs)).resolves.toBeDefined();

    const reqs = server.params(method);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).not.toHaveProperty("arguments");
  });

  // The no-input operation convention (binding set, inputSchema absent)
  // also dispatches with the arguments member omitted.
  it("omits the arguments member for a no-input operation", async () => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({
      source,
      ref: "tools/probe",
      binding: { operation: "probe", source: "s", ref: "tools/probe" },
      fetch: server.fn,
    });
    await expect(single(call.outputs)).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });

    const reqs = server.params("tools/call");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).not.toHaveProperty("arguments");
  });

  // A supplied input that is not an object — JSON null included (absent
  // means "never written", not "written as null") — and a non-string
  // prompt argument are refused loudly, never coerced, before the entity
  // request is dispatched.
  it.each<[name: string, ref: string, method: string, input: unknown]>([
    ["tool null input", "tools/probe", "tools/call", null],
    ["tool string input", "tools/probe", "tools/call", "not an object"],
    ["prompt null input", "prompts/greet", "prompts/get", null],
    ["prompt array input", "prompts/greet", "prompts/get", ["x"]],
    // Previously the invoker stringified non-string prompt arguments
    // (String(v) coercion) — payload coercion that §9.1/MCP-P-03 forbids:
    // prompt arguments are string-typed and never coerced.
    ["prompt non-string member", "prompts/greet", "prompts/get", { name: 42 }],
    ["prompt bool member", "prompts/greet", "prompts/get", { name: true }],
  ])("refuses a supplied bad shape pre-dispatch: %s", async (_name, ref, method, input) => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({ source, ref, fetch: server.fn });
    await call.write(input);
    const { vals, err } = await drain(call);
    expect(vals).toEqual([]);
    expect(err).toMatchObject({ code: ERR_VALIDATION_FAILED });
    expect(server.count(method)).toBe(0); // refusal precedes dispatch
    expect(server.fetches()).toBe(0); // and, for tools/prompts, any I/O at all
  });
});

// ---------------------------------------------------------------------------
// Item 7 — RFC 6570 template expansion (§9.1, MCP-P-03), live listing
// ---------------------------------------------------------------------------

describe("resource templates (§9.1, MCP-P-03)", () => {
  it("expands a live-resolved template per RFC 6570 before resources/read", async () => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({ source, ref: "resourceTemplates/file:///logs/{date}", fetch: server.fn });
    await call.write({ date: "2026-07-15" });
    await expect(single(call.outputs)).resolves.toEqual({
      contents: [{ uri: "file:///logs/2026-07-15", mimeType: "text/plain", text: "file:///logs/2026-07-15" }],
    });
    // The template was resolved against the live, exhausted template listing.
    expect(server.count("resources/templates/list")).toBeGreaterThanOrEqual(1);
    const reads = server.params("resources/read");
    expect(reads).toHaveLength(1);
    expect(reads.at(0)?.uri).toBe("file:///logs/2026-07-15");
  });

  it.each([
    ["list", ["2026", "07"], "file:///logs/2026,07"],
    ["associative map", { year: "2026", month: "07" }, "file:///logs/month,07,year,2026"],
  ])("preserves the RFC 6570 %s value domain", async (_name, date, expected) => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({ source, ref: "resourceTemplates/file:///logs/{date}", fetch: server.fn });
    await call.write({ date });
    await single(call.outputs);
    expect(server.params("resources/read").at(0)?.uri).toBe(expected);
  });

  // A declared variable the input does not supply follows RFC 6570's
  // undefined-value expansion; an absent input expands with all variables
  // undefined.
  it("expands an absent input with all variables undefined", async () => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({ source, ref: "resourceTemplates/file:///logs/{date}", fetch: server.fn });
    await call.close(); // absent input
    await expect(single(call.outputs)).resolves.toEqual({
      contents: [{ uri: "file:///logs/", mimeType: "text/plain", text: "file:///logs/" }],
    });
    const reads = server.params("resources/read");
    expect(reads).toHaveLength(1);
    expect(reads.at(0)?.uri).toBe("file:///logs/");
  });

  // Template-variable refusals fire before resources/read is dispatched: a
  // non-string variable (never coerced), an undeclared variable, and a
  // non-object input.
  it.each<[name: string, input: unknown]>([
    ["non-string variable", { date: 42 }],
    ["undeclared variable", { date: "x", extra: "y" }],
    ["non-object input", "2026-07-15"],
  ])("refuses template input pre-dispatch: %s", async (_name, input) => {
    const server = conformanceServer();
    const call = new MCPInvoker().invokeBinding({ source, ref: "resourceTemplates/file:///logs/{date}", fetch: server.fn });
    await call.write(input);
    const { vals, err } = await drain(call);
    expect(vals).toEqual([]);
    expect(err).toMatchObject({ code: ERR_VALIDATION_FAILED });
    expect(server.count("resources/read")).toBe(0); // refusal precedes dispatch
  });
});
