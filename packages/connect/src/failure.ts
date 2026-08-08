import { InvocationError } from "@openbindings/sdk";

export interface ConnectFailureEvidence {
  httpResponse?: ConnectHTTPFailureEvidence;
  error?: Record<string, unknown>;
  endStream?: ConnectEndStreamFailureEvidence;
}

export interface ConnectHTTPFailureEvidence {
  status: number;
  statusText?: string;
  url?: string;
  headers: Record<string, string[]>;
  body: Uint8Array<ArrayBuffer>;
  /** True means body is an explicitly marked captured prefix, not the whole response. */
  truncated: boolean;
}

export interface ConnectEndStreamFailureEvidence {
  error: Record<string, unknown>;
  payload: Uint8Array<ArrayBuffer>;
}

/** Extracts and validates Connect-native HTTP or END_STREAM failure evidence. */
export function connectFailureEvidence(error: unknown): ConnectFailureEvidence | null {
  if (!(error instanceof InvocationError)) return null;
  const details = record(error.details);
  const native = record(details?.connect);
  const response = record(details?.httpResponse);
  const result: ConnectFailureEvidence = {};

  if (response) {
    if (!Number.isInteger(response.status)) return null;
    const headers = stringArrays(response.headers);
    const body = capturedBytes(response.body);
    if (!headers || !body) return null;
    result.httpResponse = {
      status: response.status as number,
      ...(typeof response.statusText === "string" ? { statusText: response.statusText } : {}),
      ...(typeof response.url === "string" ? { url: response.url } : {}),
      headers,
      body: body.bytes,
      truncated: body.truncated,
    };
  }

  const nativeError = record(native?.error);
  if (nativeError) result.error = nativeError;
  const end = record(native?.endStream);
  if (end) {
    const endError = record(end.error);
    const payload = capturedBytes(end.payload);
    if (!endError || !payload) return null;
    result.endStream = { error: endError, payload: payload.bytes };
  }

  return result.httpResponse || result.endStream ? result : null;
}

function capturedBytes(value: unknown): { bytes: Uint8Array<ArrayBuffer>; truncated: boolean } | null {
  const captured = record(value);
  if (!captured || typeof captured.base64 !== "string" ||
      !Number.isInteger(captured.byteLength) || (captured.byteLength as number) < 0 ||
      (captured.truncated !== undefined && typeof captured.truncated !== "boolean")) return null;
  try {
    const binary = atob(captured.base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== captured.byteLength) return null;
    return { bytes, truncated: captured.truncated === true };
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
