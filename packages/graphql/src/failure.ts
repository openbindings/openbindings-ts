import { InvocationError } from "@openbindings/sdk";

export interface GraphQLFailureEvidence {
  httpResponse?: GraphQLHTTPFailureEvidence;
  mediaType?: string;
  transportWs?: GraphQLTransportWSEvidence;
}

export interface GraphQLHTTPFailureEvidence {
  status: number;
  statusText?: string;
  url?: string;
  headers: Record<string, string[]>;
  body: Uint8Array<ArrayBuffer>;
  truncated: boolean;
}

export interface GraphQLTransportWSEvidence {
  type: "error" | "close";
  payload?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

/** Extracts GraphQL-over-HTTP or graphql-transport-ws native failure evidence. */
export function graphQLFailureEvidence(error: unknown): GraphQLFailureEvidence | null {
  if (!(error instanceof InvocationError)) return null;
  const details = record(error.details);
  const result: GraphQLFailureEvidence = {};

  const response = record(details?.httpResponse);
  if (response) {
    const headers = stringArrays(response.headers);
    const body = capturedBytes(response.body);
    if (!Number.isInteger(response.status) || !headers || !body) return null;
    result.httpResponse = {
      status: response.status as number,
      ...(typeof response.statusText === "string" ? { statusText: response.statusText } : {}),
      ...(typeof response.url === "string" ? { url: response.url } : {}),
      headers,
      body: body.bytes,
      truncated: body.truncated,
    };
    const graphql = record(details?.graphql);
    if (typeof graphql?.mediaType === "string") result.mediaType = graphql.mediaType;
  }

  const ws = record(details?.graphqlTransportWs);
  if (ws) {
    if (ws.type !== "error" && ws.type !== "close") return null;
    result.transportWs = {
      type: ws.type,
      ...(Object.hasOwn(ws, "payload") ? { payload: ws.payload } : {}),
      ...(typeof ws.code === "number" ? { code: ws.code } : {}),
      ...(typeof ws.reason === "string" ? { reason: ws.reason } : {}),
      ...(typeof ws.wasClean === "boolean" ? { wasClean: ws.wasClean } : {}),
    };
  }
  return result.httpResponse || result.transportWs ? result : null;
}

function capturedBytes(value: unknown): { bytes: Uint8Array<ArrayBuffer>; truncated: boolean } | null {
  const captured = record(value);
  if (!captured || typeof captured.base64 !== "string" || !Number.isInteger(captured.byteLength) ||
      (captured.byteLength as number) < 0 ||
      (captured.truncated !== undefined && typeof captured.truncated !== "boolean")) return null;
  try {
    const bytes = Uint8Array.from(atob(captured.base64), (character) => character.charCodeAt(0));
    return bytes.byteLength === captured.byteLength
      ? { bytes, truncated: captured.truncated === true }
      : null;
  } catch {
    return null;
  }
}

function stringArrays(value: unknown): Record<string, string[]> | null {
  const raw = record(value);
  if (!raw) return null;
  const result: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(raw)) {
    if (!Array.isArray(values) || !values.every((item) => typeof item === "string")) return null;
    result[name] = [...values];
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
