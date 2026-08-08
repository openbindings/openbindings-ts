import { InvocationError } from "@openbindings/sdk";

export interface MCPFailureEvidence {
  result?: Record<string, unknown>;
  jsonrpcError?: MCPJSONRPCFailureEvidence;
  httpResponse?: MCPHTTPFailureEvidence;
}

export interface MCPJSONRPCFailureEvidence {
  code: number;
  message: string;
  data?: unknown;
}

export interface MCPHTTPFailureEvidence {
  status: number;
  statusText?: string;
  url?: string;
  headers: Record<string, string[]>;
  body: Uint8Array<ArrayBuffer>;
}

/** Extracts and validates MCP-native result, JSON-RPC, and HTTP evidence. */
export function mcpFailureEvidence(error: unknown): MCPFailureEvidence | null {
  if (!(error instanceof InvocationError)) return null;
  const details = record(error.diagnostics);
  const mcp = record(details?.mcp);
  const result: MCPFailureEvidence = {};

  const nativeResult = record(mcp?.result);
  if (nativeResult) result.result = nativeResult;
  const rpc = record(mcp?.jsonrpcError);
  if (rpc) {
    if (!Number.isInteger(rpc.code) || typeof rpc.message !== "string") return null;
    result.jsonrpcError = {
      code: rpc.code as number,
      message: rpc.message,
      ...(Object.hasOwn(rpc, "data") ? { data: rpc.data } : {}),
    };
  }

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
      body,
    };
  }
  return result.result || result.jsonrpcError || result.httpResponse ? result : null;
}

function capturedBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  const captured = record(value);
  if (!captured || typeof captured.base64 !== "string" ||
      !Number.isInteger(captured.byteLength) || (captured.byteLength as number) < 0) return null;
  try {
    const bytes = Uint8Array.from(atob(captured.base64), (character) => character.charCodeAt(0));
    return bytes.byteLength === captured.byteLength ? bytes : null;
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
