import { InvocationError, resolveDeliveryUnitLimit } from "@openbindings/invoke";
import {
  governingResponse,
  governingResponseMediaMatch,
  isJSONMediaType,
  parseMediaType,
} from "./media.js";
import { resolveDeclaration, type SchemaDeclaration } from "./resolved-declaration.js";
import type {
  OpenAPIDocument,
  OpenAPIMediaType,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIResponse,
} from "./types.js";

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const ACTUAL_CONTENT_TYPE_HEADER = "X-Openbindings-Actual-Content-Type";
export const UNARY_EVENT_STREAM_TYPE = "application/x-openbindings-event-stream-unary";

export type ContentCodingResult = Uint8Array | ArrayBuffer | ArrayBufferView;
export type ContentEncoder = (
  body: Uint8Array,
) => ContentCodingResult | Promise<ContentCodingResult>;
export type ContentDecoder = ContentEncoder;

export interface MediaGovernanceModel {
  document: OpenAPIDocument;
  operation: OpenAPIOperation;
  parameters: OpenAPIParameter[];
  method: string;
  emptyResponse: boolean;
  maxDeliveryUnitBytes?: number;
}

export function normalizeContentCodings<T>(
  input: Record<string, T> | undefined,
  direction: "request" | "response",
): { codecs: ReadonlyMap<string, T>; defect?: Error } {
  const codecs = new Map<string, T>();
  for (const [authored, codec] of Object.entries(input ?? {})) {
    const token = authored.trim().toLowerCase();
    if (!HTTP_TOKEN.test(token) || typeof codec !== "function") {
      return { codecs, defect: new Error(`invalid ${direction} content-coding capability ${JSON.stringify(authored)}`) };
    }
    if (codecs.has(token)) {
      return { codecs, defect: new Error(`${direction} content-coding capabilities collide at ${JSON.stringify(token)}`) };
    }
    codecs.set(token, codec);
  }
  return { codecs };
}

export async function governRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  model: MediaGovernanceModel,
  codecs: ReadonlyMap<string, ContentEncoder>,
): Promise<{ input: RequestInfo | URL; init: RequestInit | undefined }> {
  const sourceHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  const headers = new Headers(sourceHeaders);
  // §9.1 supplies no portable response preference. Remove the predecessor's
  // synthesized field after all security/context placements have run.
  headers.delete("Accept");
  const rawCoding = headers.get("Content-Encoding") ?? "";
  let body = init?.body ?? (input instanceof Request ? input.body : null);
  if (rawCoding !== "") {
    const governing = effectiveContentEncodingParameter(model.parameters);
    if (!governing) requestRefusal("request Content-Encoding has no effective governing Header Parameter");
    if (!schemaAdmitsHeaderValue(governing.schema, rawCoding, model.document.openapi?.startsWith("3.0") ?? true)) {
      requestRefusal("request Content-Encoding is not admitted by its governing Header Parameter");
    }
    let tokens: string[];
    try {
      tokens = parsedContentCodings(rawCoding);
    } catch {
      requestRefusal("invalid Content-Encoding field value");
    }
    let bytes = await bodyBytes(body);
    for (const token of tokens) {
      if (token === "identity") continue;
      const codec = codecs.get(token);
      if (!codec) requestRefusal(`request content-coding ${JSON.stringify(token)} is unsupported`);
      try {
        bytes = codingBytes(await codec(bytes));
      } catch {
        requestRefusal(`request content-coding ${JSON.stringify(token)} failed`);
      }
    }
    body = bytesToArrayBuffer(bytes);
    headers.delete("Content-Length");
  }
  const nextInit: RequestInit = { ...init, headers, ...(body !== null ? { body } : {}) };
  if (input instanceof Request && init === undefined) {
    return { input: new Request(input, nextInit), init: undefined };
  }
  return { input, init: nextInit };
}

export async function governResponse(
  response: Response,
  model: MediaGovernanceModel,
  codecs: ReadonlyMap<string, ContentDecoder>,
): Promise<Response> {
  const governing = governingResponse(model.operation, response.status);
  if (governing) requireGovernedResponseHeaders(governing.response, response.headers);

  let bytes: Uint8Array;
  const deliveryLimit = resolveDeliveryUnitLimit(model);
  try {
    bytes = await readResponseBytes(response, deliveryLimit);
  } catch (error: unknown) {
    if (error instanceof InvocationError) throw error;
    throw new InvocationError("ERR_PROTOCOL");
  }
  if (model.method.toLowerCase() === "head") bytes = new Uint8Array();
  const headers = new Headers(response.headers);
  const rawCoding = headers.get("Content-Encoding") ?? "";
  if (rawCoding !== "") {
    if (!governing) responseError("coded response has no governing Response Object");
    const declared = responseHeader(governing.response, "Content-Encoding");
    if (!declared) responseError("actual response Content-Encoding has no governing Header Object");
    if (!schemaAdmitsHeaderValue(declared.schema as SchemaDeclaration, rawCoding, model.document.openapi?.startsWith("3.0") ?? true)) {
      responseError("actual response Content-Encoding is not admitted by its governing Header Object");
    }
    let tokens: string[];
    try {
      tokens = parsedContentCodings(rawCoding);
    } catch {
      responseError("invalid Content-Encoding field value");
    }
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const token = tokens[index]!;
      if (token === "identity") continue;
      const codec = codecs.get(token);
      if (!codec) responseError(`response content-coding ${JSON.stringify(token)} is unsupported`);
      try {
        bytes = codingBytes(await codec(bytes));
      } catch {
        responseError(`response content-coding ${JSON.stringify(token)} failed`);
      }
      if (bytes.byteLength > deliveryLimit) {
        throw new InvocationError("ERR_RESPONSE_ERROR");
      }
    }
  }

  model.emptyResponse = bytes.length === 0;
  if (bytes.length > 0) {
    if (!governing) responseError("non-empty response has no governing Response Object");
    let contentType = headers.get("Content-Type") ?? "";
    if (contentType === "") {
      contentType = "application/octet-stream";
      headers.set("Content-Type", contentType);
    }
    let match: ReturnType<typeof governingResponseMediaMatch>;
    try {
      match = governingResponseMediaMatch(governing.response, contentType, true, true);
    } catch {
      responseError("actual response media does not match its governing declaration");
    }
    if (!match) responseError("actual response media does not match its governing declaration");
    validateResponseMediaLane(match.media, contentType, model.document.openapi?.startsWith("3.0") ?? true);
    if (parseMediaType(contentType, true).base === "text/event-stream") {
      headers.set(ACTUAL_CONTENT_TYPE_HEADER, contentType);
      headers.set("Content-Type", UNARY_EVENT_STREAM_TYPE);
    }
  }
  headers.delete("Content-Length");
  const body = bytes.length === 0 && responseBodyForbidden(response.status)
    ? null
    : bytesToArrayBuffer(bytes);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Adds an adapter-private unary alias for every governed SSE declaration. */
export function prepareEngineResponseView(operation: OpenAPIOperation): void {
  for (const response of Object.values(operation.responses ?? {})) {
    if (!response || typeof response !== "object") continue;
    try {
      const match = governingResponseMediaMatch(response, "text/event-stream", true, true);
      if (match) {
        response.content ??= {};
        response.content[UNARY_EVENT_STREAM_TYPE] = match.media;
      }
    } catch { /* malformed declarations remain owned by ordinary planning */ }
  }
}

function effectiveContentEncodingParameter(parameters: OpenAPIParameter[]): OpenAPIParameter | null {
  const found = parameters.filter((parameter) =>
    parameter.in === "header" && parameter.name?.toLowerCase() === "content-encoding");
  return found.length === 1 ? found[0]! : null;
}

function responseHeader(response: OpenAPIResponse, wanted: string): Record<string, unknown> | null {
  const headers = asRecord(response.headers);
  const found = Object.entries(headers ?? {})
    .filter(([name, value]) => name.toLowerCase() === wanted.toLowerCase() && asRecord(value) !== null)
    .map(([, value]) => asRecord(value)!);
  return found.length === 1 ? found[0]! : null;
}

function requireGovernedResponseHeaders(response: OpenAPIResponse, actual: Headers): void {
  const headers = asRecord(response.headers);
  for (const [name, raw] of Object.entries(headers ?? {})) {
    const declaration = asRecord(raw);
    if (name.toLowerCase() === "content-type" || declaration?.required !== true) continue;
    if (!actual.has(name)) responseError(`required response header ${JSON.stringify(name)} is absent`);
  }
}

function schemaAdmitsHeaderValue(
  schema: SchemaDeclaration,
  value: string,
  oas30: boolean,
): boolean {
  const declaration = resolveDeclaration(schema, oas30);
  return !declaration.ambiguous
    && (declaration.typeless() || declaration.admitsStringAsSoleNonNullType())
    && declaration.admitsStringEnumValue(value);
}

function parsedContentCodings(raw: string): string[] {
  const members = raw.split(",");
  if (members.length === 0) throw new Error("empty Content-Encoding");
  return members.map((member) => {
    const token = member.trim().toLowerCase();
    if (!HTTP_TOKEN.test(token)) throw new Error("invalid Content-Encoding token");
    return token;
  });
}

function validateResponseMediaLane(
  media: OpenAPIMediaType,
  contentType: string,
  oas30: boolean,
): void {
  const parsed = parseMediaType(contentType, true);
  if (isJSONMediaType(parsed.base)) return;
  const declaration = resolveDeclaration(media.schema, oas30);
  if (isCharacterDataMedia(parsed.base) && declaration.admitsStringAsSoleNonNullType()) {
    requireSupportedCharset(parsed.params.charset ?? "utf-8");
    return;
  }
  if (declaration.typeless()) return;
  if (declaration.admitsStringAsSoleNonNullType()) {
    const format = declaration.format();
    const encoding = declaration.keywordString("contentEncoding");
    if (format.conflict || encoding.conflict) responseError("response declaration has conflicting carriage annotations");
    if ((oas30 && (format.value === "binary" || format.value === "byte")) || (!oas30 && encoding.value !== "")) {
      return;
    }
  }
  responseError(`response media ${JSON.stringify(contentType)} selects no incorporated carriage lane`);
}

function isCharacterDataMedia(base: string): boolean {
  if (base.startsWith("text/")) return true;
  return base === "application/xml" || base.endsWith("+xml");
}

function requireSupportedCharset(charset: string): void {
  if (!["utf-8", "utf8", "us-ascii", "ascii", "iso-8859-1", "iso8859-1", "latin-1", "latin1"]
    .includes(charset.toLowerCase())) {
    responseError(`unsupported response charset ${JSON.stringify(charset)}`);
  }
}

async function bodyBytes(body: BodyInit | ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (body === null) return new Uint8Array();
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new InvocationError("ERR_RESPONSE_ERROR");
      }
      chunks.push(value);
    }
  } catch (error: unknown) {
    try { await reader.cancel(); } catch { /* best effort */ }
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function codingBytes(value: ContentCodingResult): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function responseBodyForbidden(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}

function requestRefusal(message: string): never {
  throw new InvocationError("ERR_REFUSED", { message });
}

function responseError(_message: string): never {
  // Protocol diagnostics are deliberately structural at the abstract SDK
  // boundary; HTTP evidence and transport prose are not portable error data.
  throw new InvocationError("ERR_PROTOCOL");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
