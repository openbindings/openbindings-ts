import { InvocationError } from "@openbindings/sdk";

/** Source-native response evidence from an unsuccessful OpenAPI invocation. */
export interface OpenAPIFailureEvidence {
  httpResponse: OpenAPIHTTPResponseEvidence;
  openapi: OpenAPIFailureDeclaration;
}

export interface OpenAPIHTTPResponseEvidence {
  status: number;
  statusText?: string;
  url?: string;
  headers: Record<string, string[]>;
  /** Exact response bytes. Absent when the response body was not captured. */
  body?: Uint8Array<ArrayBuffer>;
}

export interface OpenAPIFailureDeclaration {
  declared: boolean;
  responseKey?: string;
  governingMedia?: string;
}

/**
 * Extracts and validates OpenAPI-native failure evidence. The evidence rides
 * an InvocationError completion and never becomes an operation output.
 */
export function openAPIFailureEvidence(error: unknown): OpenAPIFailureEvidence | null {
  if (!(error instanceof InvocationError)) return null;
  const details = record(error.diagnostics);
  const response = record(details?.httpResponse);
  const declaration = record(details?.openapi);
  if (!response || !declaration || !Number.isInteger(response.status) ||
      typeof declaration.declared !== "boolean") {
    return null;
  }

  const headers: Record<string, string[]> = {};
  const rawHeaders = record(response.headers) ?? {};
  for (const [name, values] of Object.entries(rawHeaders)) {
    if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return null;
    headers[name] = [...values];
  }

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (response.body !== undefined) {
    const captured = record(response.body);
    if (!captured || typeof captured.base64 !== "string" ||
        !Number.isInteger(captured.byteLength) || (captured.byteLength as number) < 0) {
      return null;
    }
    try {
      body = decodeBase64(captured.base64);
    } catch {
      return null;
    }
    if (body.byteLength !== captured.byteLength) return null;
  }

  return {
    httpResponse: {
      status: response.status as number,
      ...(typeof response.statusText === "string" ? { statusText: response.statusText } : {}),
      ...(typeof response.url === "string" ? { url: response.url } : {}),
      headers,
      ...(body !== undefined ? { body } : {}),
    },
    openapi: {
      declared: declaration.declared,
      ...(typeof declaration.responseKey === "string"
        ? { responseKey: declaration.responseKey }
        : {}),
      ...(typeof declaration.governingMedia === "string"
        ? { governingMedia: declaration.governingMedia }
        : {}),
    },
  };
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
