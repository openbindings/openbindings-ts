// Twin of openbindings-go/formats/openapi/swagger20_species_test.go.
//
// openbindings.openapi-2.0@1 §3.2's context-required species names a §12.1
// point "so supplying it makes the same invocation proceed". Two surfaces of
// this invoker can name a point: the advisory preflight (prepareBinding) and
// the authoritative invocation challenge. §12.1 states ONE boundary per point,
// so the two must state the same one.
import { describe, expect, it, vi } from "vitest";
import { InvocationError, type ContextRequiredDetails, type ContextRequirement } from "@openbindings/invoke";
import { OpenAPIInvoker } from "./invoker.js";

const HEAD = { swagger: "2.0", info: { title: "species", version: "1" }, host: "api.example", schemes: ["https"] };
const LOCATION = "https://api.example/swagger.json";

function args(document: unknown, selector: string, context?: Record<string, unknown>): Parameters<OpenAPIInvoker["prepareBinding"]>[0] {
  return {
    source: { bindingSpec: "openbindings.openapi-2.0@1", location: LOCATION, content: JSON.stringify(document) },
    selector,
    ...(context === undefined ? {} : { context }),
  };
}

async function invokeChallenge(
  document: unknown,
  selector: string,
  input: unknown,
  context?: Record<string, unknown>,
): Promise<{ error?: InvocationError; dispatches: number }> {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const call = new OpenAPIInvoker().invokeBinding({ ...args(document, selector, context), fetch: fetchMock });
  try {
    if (input !== undefined) await call.write(input);
    await call.close?.();
    for await (const _ of call.outputs) void _;
    await call.closed;
  } catch (error) {
    return { error: error as InvocationError, dispatches: fetchMock.mock.calls.length };
  }
  return { dispatches: fetchMock.mock.calls.length };
}

function byPoint(details: ContextRequiredDetails | null | undefined, point: string): ContextRequirement | undefined {
  return details?.alternatives.flatMap((a) => a.requirements).find((r) => r.point === point);
}

function byName(details: ContextRequiredDetails | null | undefined, name: string): ContextRequirement | undefined {
  return details?.alternatives.flatMap((a) => a.requirements).find((r) => r.name === name && r.type !== "config.value");
}

const CASES: { name: string; document: unknown; selector: string; input?: unknown; point?: string; auth?: string }[] = [
  {
    name: "emptyValueForm",
    document: { ...HEAD, paths: { "/p": { get: {
      parameters: [{ name: "q", in: "query", type: "string", allowEmptyValue: true }],
      responses: { 204: { description: "ok" } } } } } },
    selector: "#/paths/~1p/get", input: { parameters: { q: "" } }, point: "emptyValueForm",
  },
  {
    name: "requestMedia",
    document: { ...HEAD, consumes: ["application/json", "text/plain"], paths: { "/p": { post: {
      parameters: [{ name: "b", in: "body", required: true, schema: { type: "string" } }],
      responses: { 204: { description: "ok" } } } } } },
    selector: "#/paths/~1p/post", input: { body: "x" }, point: "requestMedia",
  },
  {
    name: "propertyMedia",
    document: { ...HEAD, consumes: ["multipart/form-data"], paths: { "/p": { post: {
      parameters: [{ name: "f", in: "formData", required: true, type: "file" }],
      responses: { 204: { description: "ok" } } } } } },
    selector: "#/paths/~1p/post", input: { parameters: { f: "QUFB" } }, point: "propertyMedia",
  },
  {
    name: "security selection",
    document: { ...HEAD,
      securityDefinitions: { k: { type: "apiKey", name: "X-Key", in: "header" }, b: { type: "basic" } },
      security: [{ k: [] }, { b: [] }],
      paths: { "/p": { get: { responses: { 204: { description: "ok" } } } } } },
    selector: "#/paths/~1p/get", point: "security",
  },
  {
    name: "apiKey credential",
    document: { ...HEAD,
      securityDefinitions: { k: { type: "apiKey", name: "X-Key", in: "header" } },
      security: [{ k: [] }],
      paths: { "/p": { get: { responses: { 204: { description: "ok" } } } } } },
    selector: "#/paths/~1p/get", auth: "k",
  },
];

describe("Swagger 2.0 refusal species across both surfaces", () => {
  for (const testCase of CASES) {
    it(`states one boundary for ${testCase.name}`, async () => {
      const { error, dispatches } = await invokeChallenge(testCase.document, testCase.selector, testCase.input);
      expect(error?.code).toBe("CONTEXT_REQUIRED");
      expect(dispatches).toBe(0);
      const challenge = error?.data as ContextRequiredDetails;
      const preflight = await new OpenAPIInvoker().prepareBinding(args(testCase.document, testCase.selector));
      const fromChallenge = testCase.point ? byPoint(challenge, testCase.point) : byName(challenge, testCase.auth!);
      const fromPreflight = testCase.point ? byPoint(preflight, testCase.point) : byName(preflight, testCase.auth!);
      expect(fromChallenge).toBeDefined();
      expect(fromPreflight).toBeDefined();
      expect(fromChallenge).toEqual(fromPreflight);
    });
  }

  // The guard the block's own refusal condition asks for: naming a point must
  // change what a refusal CARRIES, never whether the invocation refuses at all.
  const EMPTY_VALUE = { ...HEAD, paths: { "/p": { get: {
    parameters: [{ name: "q", in: "query", type: "string", allowEmptyValue: true }],
    responses: { 204: { description: "ok" } } } } } };
  const ADMISSIBILITY: { name: string; input?: unknown; context?: Record<string, unknown>; dispatch?: boolean; code?: string }[] = [
    { name: "empty value, no choice", input: { parameters: { q: "" } }, code: "CONTEXT_REQUIRED" },
    { name: "non-empty value, no choice", input: { parameters: { q: "x" } }, dispatch: true },
    { name: "value absent, no choice", input: { parameters: {} }, dispatch: true },
    { name: "no envelope at all", dispatch: true },
    { name: "empty value, name-only", input: { parameters: { q: "" } }, context: { configuration: { emptyValueForm: "name-only" } }, dispatch: true },
    { name: "empty value, empty", input: { parameters: { q: "" } }, context: { configuration: { emptyValueForm: "empty" } }, dispatch: true },
    { name: "empty value, value the point does not admit", input: { parameters: { q: "" } }, context: { configuration: { emptyValueForm: "sometimes" } }, code: "ERR_REFUSED" },
  ];
  for (const testCase of ADMISSIBILITY) {
    it(`keeps admissibility fixed: ${testCase.name}`, async () => {
      const { error, dispatches } = await invokeChallenge(EMPTY_VALUE, "#/paths/~1p/get", testCase.input, testCase.context);
      if (testCase.dispatch) {
        expect(error).toBeUndefined();
        expect(dispatches).toBe(1);
        return;
      }
      expect(error?.code).toBe(testCase.code);
      expect(dispatches).toBe(0);
    });
  }
});
