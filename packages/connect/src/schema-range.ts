import * as protobuf from "protobufjs";

type FeatureCarrier = {
  _edition?: string;
  _features?: Record<string, unknown>;
  group?: boolean;
};

/** Mirrors the protobuf closure gate incorporated from openbindings.grpc@1. */
export function boundMethodRangeError(
  root: protobuf.Root,
  method: protobuf.Method,
): string | undefined {
  const seen = new Set<string>();
  for (const name of [method.requestType, method.responseType]) {
    const reason = visitType(root.lookupType(name), seen);
    if (reason) return `method ${method.parent?.fullName.replace(/^\./, "")}/${method.name} is outside the accepted schema range: ${reason}`;
  }
  return undefined;
}

export function assertBoundMethodRange(
  root: protobuf.Root,
  method: protobuf.Method,
): void {
  const reason = boundMethodRangeError(root, method);
  if (reason) throw new Error(reason);
}

function visitType(type: protobuf.Type, seen: Set<string>): string | undefined {
  const fullName = type.fullName.replace(/^\./, "");
  if (seen.has(fullName)) return undefined;
  seen.add(fullName);

  const edition = (type as unknown as FeatureCarrier)._edition;
  if (edition !== "proto2" && edition !== "proto3" && feature(type, "json_format") === "LEGACY_BEST_EFFORT") {
    return `message ${fullName} resolves json_format = LEGACY_BEST_EFFORT`;
  }
  for (const field of Object.values(type.fields).sort((a, b) => a.id - b.id)) {
    if (field.required || feature(field, "field_presence") === "LEGACY_REQUIRED") {
      return `field ${field.fullName.replace(/^\./, "")} has required presence`;
    }
    if (
      feature(field, "message_encoding") === "DELIMITED"
      || (field.resolvedType instanceof protobuf.Type && (field.resolvedType as unknown as FeatureCarrier).group === true)
    ) {
      return `field ${field.fullName.replace(/^\./, "")} uses a proto2 group or DELIMITED message encoding`;
    }
    if (field.resolvedType instanceof protobuf.Type) {
      const reason = visitType(field.resolvedType, seen);
      if (reason) return reason;
    }
  }
  return undefined;
}

function feature(value: protobuf.ReflectionObject, name: string): unknown {
  return (value as unknown as FeatureCarrier)._features?.[name];
}
