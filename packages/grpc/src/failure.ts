import { InvocationError } from "@openbindings/sdk";

/** Source-native final-status evidence from an unsuccessful gRPC invocation. */
export interface GrpcFailureEvidence {
  code: number;
  message: string;
  details: GrpcStatusDetailEvidence[];
  /** Exact serialized google.rpc.Status when grpc-status-details-bin was present. */
  statusDetailsBin?: Uint8Array<ArrayBuffer>;
}

/** One google.protobuf.Any entry; value contains the exact Any payload bytes. */
export interface GrpcStatusDetailEvidence {
  typeUrl: string;
  value: Uint8Array<ArrayBuffer>;
}

/**
 * Extracts and validates gRPC-native status evidence. Response messages emitted
 * before this failure remain outputs; the evidence itself is never an output.
 */
export function grpcFailureEvidence(error: unknown): GrpcFailureEvidence | null {
  if (!(error instanceof InvocationError)) return null;
  const details = record(error.diagnostics);
  const status = record(details?.grpcStatus);
  if (!status || !Number.isInteger(status.code) || (status.code as number) < 0 ||
      (status.code as number) > 16 || typeof status.message !== "string") {
    return null;
  }

  const decodedDetails: GrpcStatusDetailEvidence[] = [];
  if (status.details !== undefined) {
    if (!Array.isArray(status.details)) return null;
    for (const raw of status.details) {
      const detail = record(raw);
      if (!detail || typeof detail.typeUrl !== "string" || typeof detail.valueBase64 !== "string") return null;
      const value = decodeBase64(detail.valueBase64);
      if (!value) return null;
      decodedDetails.push({ typeUrl: detail.typeUrl, value });
    }
  }

  let statusDetailsBin: Uint8Array<ArrayBuffer> | undefined;
  if (status.statusDetailsBinBase64 !== undefined) {
    if (typeof status.statusDetailsBinBase64 !== "string") return null;
    statusDetailsBin = decodeBase64(status.statusDetailsBinBase64) ?? undefined;
    if (!statusDetailsBin) return null;
  }

  return {
    code: status.code as number,
    message: status.message,
    details: decodedDetails,
    ...(statusDetailsBin ? { statusDetailsBin } : {}),
  };
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
