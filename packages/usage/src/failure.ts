import { InvocationError } from "@openbindings/sdk";

export interface UsageFailureEvidence {
  exitCode: number;
  signal?: string;
  stdout: UsageProcessBytes;
  stderr: UsageProcessBytes;
}

export interface UsageProcessBytes {
  bytes: Uint8Array<ArrayBuffer>;
  truncated: boolean;
}

/** Extracts and validates completed Usage process evidence. */
export function usageFailureEvidence(error: unknown): UsageFailureEvidence | null {
  if (!(error instanceof InvocationError)) return null;
  const details = record(error.details);
  const usage = record(details?.usage);
  const process = record(usage?.process);
  if (!process || !Number.isInteger(process.exitCode)) return null;
  const stdout = capturedBytes(process.stdout);
  const stderr = capturedBytes(process.stderr);
  if (!stdout || !stderr || (process.signal !== undefined && typeof process.signal !== "string")) return null;
  return {
    exitCode: process.exitCode as number,
    ...(typeof process.signal === "string" ? { signal: process.signal } : {}),
    stdout,
    stderr,
  };
}

function capturedBytes(value: unknown): UsageProcessBytes | null {
  const captured = record(value);
  if (!captured || typeof captured.base64 !== "string" ||
      !Number.isInteger(captured.byteLength) || (captured.byteLength as number) < 0 ||
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
