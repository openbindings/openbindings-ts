import * as protobuf from "protobufjs";

/** Parses canonical ProtoJSON with unknown fields refused. */
export function fromProtoJSON(type: protobuf.Type, value: unknown): protobuf.Message {
  const object = prepareMessage(type, value);
  const message = type.fromObject(object);
  const reason = type.verify(message);
  if (reason) throw new Error(reason);
  return message;
}

/** Renders canonical ProtoJSON using the protobuf mapping's default posture. */
export function toProtoJSON(type: protobuf.Type, message: protobuf.Message): unknown {
  const object = type.toObject(message, { longs: String, enums: String, bytes: String, defaults: false, oneofs: false });
  return renderMessage(type, object);
}

function prepareMessage(type: protobuf.Type, value: unknown): Record<string, unknown> {
  const special = prepareWellKnown(type, value);
  if (special) return special;
  if (!record(value)) throw new Error(`ProtoJSON ${name(type)} value must be an object`);
  const output: Record<string, unknown> = {};
  const seen = new Set<string>();
  const seenOneofs = new Map<string, string>();
  for (const [key, member] of Object.entries(value)) {
    const field = Object.values(type.fields).find((candidate) => candidate.name === key || jsonName(candidate) === key);
    if (!field) throw new Error(`unknown ProtoJSON field ${JSON.stringify(key)} in ${name(type)}`);
    if (seen.has(field.name)) throw new Error(`ProtoJSON field ${field.name} is supplied by more than one spelling`);
    seen.add(field.name);
    // ProtoJSON parsers accept null for every ordinary field and leave it
    // unset. google.protobuf.Value is handled above and preserves null as
    // its NULL_VALUE arm.
    if (member === null) continue;
    const oneof = field.partOf?.name;
    if (oneof) {
      const previous = seenOneofs.get(oneof);
      if (previous) throw new Error(`ProtoJSON oneof ${oneof} supplies both ${previous} and ${field.name}`);
      seenOneofs.set(oneof, field.name);
    }
    output[field.name] = prepareField(field, member);
  }
  return output;
}

function prepareField(field: protobuf.Field, value: unknown): unknown {
  if (field.map) {
    if (!record(value)) throw new Error(`map field ${field.name} must be an object`);
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, prepareScalar(field, member)]));
  }
  if (field.repeated) {
    if (!Array.isArray(value)) throw new Error(`repeated field ${field.name} must be an array`);
    return value.map((member) => prepareScalar(field, member));
  }
  return prepareScalar(field, value);
}

function prepareScalar(field: protobuf.Field, value: unknown): unknown {
  if (field.resolvedType instanceof protobuf.Type) return prepareMessage(field.resolvedType, value);
  if (field.resolvedType instanceof protobuf.Enum) {
    if (typeof value === "string" && Object.hasOwn(field.resolvedType.values, value)) return value;
    if (typeof value === "number" && Number.isInteger(value)) return value;
    throw new Error(`enum field ${field.name} must be a declared name or integer value`);
  }
  switch (field.type) {
    case "bool": if (typeof value !== "boolean") fail(field, "boolean"); return value;
    case "string": if (typeof value !== "string") fail(field, "string"); return value;
    case "bytes": { const encoded = typeof value === "string" ? canonicalBase64(value) : undefined; if (encoded === undefined) fail(field, "base64 string"); return encoded; }
    case "int32": case "sint32": case "sfixed32": return integer(field, value, -2147483648, 2147483647);
    case "uint32": case "fixed32": return integer(field, value, 0, 4294967295);
    case "int64": case "sint64": case "sfixed64": return integer64(field, value, true);
    case "uint64": case "fixed64": return integer64(field, value, false);
    case "float": case "double":
      if (typeof value === "number" || value === "NaN" || value === "Infinity" || value === "-Infinity") return value;
      return fail(field, "number or canonical non-finite string");
    default: return value;
  }
}

function renderMessage(type: protobuf.Type, value: Record<string, unknown>): unknown {
  const special = renderWellKnown(type, value);
  if (special.handled) return special.value;
  const output: Record<string, unknown> = {};
  for (const field of Object.values(type.fields)) {
    if (!Object.hasOwn(value, field.name)) continue;
    output[jsonName(field)] = renderField(field, value[field.name]);
  }
  return output;
}

function renderField(field: protobuf.Field, value: unknown): unknown {
  if (field.map && record(value)) return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, renderScalar(field, member)]));
  if (field.repeated && Array.isArray(value)) return value.map((member) => renderScalar(field, member));
  return renderScalar(field, value);
}

function renderScalar(field: protobuf.Field, value: unknown): unknown {
  return field.resolvedType instanceof protobuf.Type && record(value) ? renderMessage(field.resolvedType, value) : value;
}

function prepareWellKnown(type: protobuf.Type, value: unknown): Record<string, unknown> | undefined {
  switch (name(type)) {
    case "google.protobuf.Timestamp": return timestampInput(value);
    case "google.protobuf.Duration": return durationInput(value);
    case "google.protobuf.FieldMask":
      if (typeof value !== "string") throw new Error("FieldMask ProtoJSON value must be a string");
      return { paths: value === "" ? [] : value.split(",").map(camelToSnake) };
    case "google.protobuf.Empty": if (!record(value) || Object.keys(value).length) throw new Error("Empty ProtoJSON value must be {}"); return {};
    case "google.protobuf.Struct": if (!record(value)) throw new Error("Struct ProtoJSON value must be an object"); return { fields: Object.fromEntries(Object.entries(value).map(([key, member]) => [key, valueInput(member)])) };
    case "google.protobuf.Value": return valueInput(value);
    case "google.protobuf.ListValue": if (!Array.isArray(value)) throw new Error("ListValue ProtoJSON value must be an array"); return { values: value.map(valueInput) };
    case "google.protobuf.BoolValue": return wrapper(value, "boolean");
    case "google.protobuf.StringValue": return wrapper(value, "string");
    case "google.protobuf.BytesValue": { const encoded = typeof value === "string" ? canonicalBase64(value) : undefined; if (encoded === undefined) throw new Error("BytesValue requires a base64 string"); return { value: encoded }; }
    case "google.protobuf.Int32Value": return wrapperInteger(value, -2147483648, 2147483647);
    case "google.protobuf.UInt32Value": return wrapperInteger(value, 0, 4294967295);
    case "google.protobuf.Int64Value": return wrapperInteger64(value, true);
    case "google.protobuf.UInt64Value": return wrapperInteger64(value, false);
    case "google.protobuf.FloatValue": case "google.protobuf.DoubleValue": return wrapperNumber(value);
    case "google.protobuf.Any": return anyInput(type, value);
    default: return undefined;
  }
}

function renderWellKnown(type: protobuf.Type, value: Record<string, unknown>): { handled: boolean; value?: unknown } {
  switch (name(type)) {
    case "google.protobuf.Timestamp": return { handled: true, value: timestampOutput(value) };
    case "google.protobuf.Duration": return { handled: true, value: durationOutput(value) };
    case "google.protobuf.FieldMask": return { handled: true, value: Array.isArray(value.paths) ? value.paths.map((path) => snakeToCamel(String(path))).join(",") : "" };
    case "google.protobuf.Empty": return { handled: true, value: {} };
    case "google.protobuf.Struct": return { handled: true, value: record(value.fields) ? Object.fromEntries(Object.entries(value.fields).map(([key, member]) => [key, valueOutput(member)])) : {} };
    case "google.protobuf.Value": return { handled: true, value: valueOutput(value) };
    case "google.protobuf.ListValue": return { handled: true, value: Array.isArray(value.values) ? value.values.map(valueOutput) : [] };
    case "google.protobuf.BoolValue": case "google.protobuf.StringValue": case "google.protobuf.BytesValue": case "google.protobuf.Int32Value": case "google.protobuf.UInt32Value": case "google.protobuf.Int64Value": case "google.protobuf.UInt64Value": case "google.protobuf.FloatValue": case "google.protobuf.DoubleValue": return { handled: true, value: value.value };
    case "google.protobuf.Any": return { handled: true, value: anyOutput(type, value) };
    default: return { handled: false };
  }
}

function timestampInput(value: unknown): Record<string, unknown> {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (!match) throw new Error("Timestamp must use RFC 3339 ProtoJSON form");
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[10] ?? 0), offsetMinute = Number(match[11] ?? 0);
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth(year!, month!) || hour! > 23 || minute! > 59 || second! > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error("Timestamp carries an invalid RFC 3339 calendar value");
  }
  const instant = new Date(0);
  instant.setUTCFullYear(year!, month! - 1, day!);
  instant.setUTCHours(hour!, minute!, second!, 0);
  const offsetSign = match[9] === "-" ? -1 : 1;
  const seconds = Math.floor(instant.getTime() / 1000) - offsetSign * (offsetHour * 3600 + offsetMinute * 60);
  if (seconds < -62135596800 || seconds > 253402300799) throw new Error("Timestamp is outside the protobuf range");
  return { seconds: String(seconds), nanos: Number((match[7] ?? "").padEnd(9, "0")) };
}

function timestampOutput(value: Record<string, unknown>): string {
  const seconds = Number(value.seconds ?? 0);
  const nanos = Number(value.nanos ?? 0);
  if (!Number.isInteger(seconds) || seconds < -62135596800 || seconds > 253402300799 || !Number.isInteger(nanos) || nanos < 0 || nanos > 999999999) {
    throw new Error("Timestamp is outside the protobuf range");
  }
  const base = new Date(seconds * 1000).toISOString().replace(".000Z", "");
  const fraction = protoFraction(nanos);
  return `${base}${fraction}Z`;
}

function durationInput(value: unknown): Record<string, unknown> {
  const match = typeof value === "string" ? /^(-)?(\d+)(?:\.(\d{1,9}))?s$/.exec(value) : null;
  if (!match) throw new Error("Duration must be a canonical seconds string ending in s");
  const sign = match[1] ? -1 : 1;
  const seconds = BigInt(`${match[1] ?? ""}${match[2]}`);
  if (seconds < -315576000000n || seconds > 315576000000n) throw new Error("Duration is outside the protobuf range");
  return { seconds: seconds.toString(), nanos: sign * Number((match[3] ?? "").padEnd(9, "0")) };
}

function durationOutput(value: Record<string, unknown>): string {
  const seconds = String(value.seconds ?? "0");
  const nanos = Number(value.nanos ?? 0);
  const wholeSeconds = BigInt(seconds);
  if (wholeSeconds < -315576000000n || wholeSeconds > 315576000000n || !Number.isInteger(nanos) || Math.abs(nanos) > 999999999) {
    throw new Error("Duration is outside the protobuf range");
  }
  if ((wholeSeconds < 0n && nanos > 0) || (wholeSeconds > 0n && nanos < 0)) throw new Error("Duration seconds and nanos have inconsistent signs");
  const negative = seconds.startsWith("-") || nanos < 0;
  const whole = seconds.replace(/^-/, "");
  const fraction = protoFraction(Math.abs(nanos));
  return `${negative ? "-" : ""}${whole}${fraction}s`;
}

function valueInput(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: "NULL_VALUE" };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Value number must be finite JSON");
    return { numberValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(valueInput) } };
  if (record(value)) return { structValue: { fields: Object.fromEntries(Object.entries(value).map(([key, member]) => [key, valueInput(member)])) } };
  throw new Error("Value carries an unsupported JSON value");
}

function valueOutput(value: unknown): unknown {
  if (!record(value)) return null;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "boolValue")) return value.boolValue;
  if (Object.hasOwn(value, "numberValue")) return value.numberValue;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (record(value.listValue)) return Array.isArray(value.listValue.values) ? value.listValue.values.map(valueOutput) : [];
  if (record(value.structValue) && record(value.structValue.fields)) return Object.fromEntries(Object.entries(value.structValue.fields).map(([key, member]) => [key, valueOutput(member)]));
  return null;
}

function anyInput(type: protobuf.Type, value: unknown): Record<string, unknown> {
  if (!record(value) || typeof value["@type"] !== "string") throw new Error("Any ProtoJSON value requires @type");
  const typeURL = value["@type"];
  const embedded = type.root.lookupType(typeURL.slice(typeURL.lastIndexOf("/") + 1));
  const custom = isCustomWellKnown(embedded);
  const payload = custom ? value.value : Object.fromEntries(Object.entries(value).filter(([key]) => key !== "@type"));
  return { type_url: typeURL, value: embedded.encode(fromProtoJSON(embedded, payload)).finish() };
}

function anyOutput(type: protobuf.Type, value: Record<string, unknown>): unknown {
  const typeURL = String(value.typeUrl ?? value.type_url ?? "");
  const embedded = type.root.lookupType(typeURL.slice(typeURL.lastIndexOf("/") + 1));
  const bytes = value.value instanceof Uint8Array ? value.value : Uint8Array.from(value.value as number[] ?? []);
  const rendered = toProtoJSON(embedded, embedded.decode(bytes));
  return isCustomWellKnown(embedded) ? { "@type": typeURL, value: rendered } : { "@type": typeURL, ...(record(rendered) ? rendered : {}) };
}

function isCustomWellKnown(type: protobuf.Type): boolean { return name(type).startsWith("google.protobuf.") && !["google.protobuf.Any", "google.protobuf.Empty"].includes(name(type)); }
function wrapper(value: unknown, expected: string): Record<string, unknown> { if (typeof value !== expected) throw new Error(`wrapper ProtoJSON value must be ${expected}`); return { value }; }
function wrapperInteger(value: unknown, min: number, max: number): Record<string, unknown> { if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`integer wrapper requires an integer in [${min}, ${max}]`); return { value }; }
function wrapperInteger64(value: unknown, signed: boolean): Record<string, unknown> { if (!validInteger64(value, signed)) throw new Error("64-bit wrapper requires an in-range integer string or safe integer"); return { value }; }
function wrapperNumber(value: unknown): Record<string, unknown> { if (!(typeof value === "number" || value === "NaN" || value === "Infinity" || value === "-Infinity")) throw new Error("numeric wrapper requires a number"); return { value }; }
function integer(field: protobuf.Field, value: unknown, min: number, max: number): number { if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return fail(field, `integer in [${min}, ${max}]`); return value; }
function integer64(field: protobuf.Field, value: unknown, signed: boolean): unknown { if (!validInteger64(value, signed)) return fail(field, "in-range 64-bit integer string or safe integer"); return value; }
function validInteger64(value: unknown, signed: boolean): boolean {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return false;
  if (typeof value !== "number" && !(typeof value === "string" && new RegExp(signed ? "^-?\\d+$" : "^\\d+$").test(value))) return false;
  const integer = BigInt(value);
  return signed ? integer >= -9223372036854775808n && integer <= 9223372036854775807n : integer >= 0n && integer <= 18446744073709551615n;
}
function fail(field: protobuf.Field, expected: string): never { throw new Error(`field ${field.name} must be ${expected}`); }
function canonicalBase64(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    const canonical = Buffer.from(normalized, "base64").toString("base64");
    return canonical.replace(/=+$/, "") === normalized ? canonical : undefined;
  } catch { return undefined; }
}
function name(type: protobuf.Type): string { return type.fullName.replace(/^\./, ""); }
function jsonName(field: protobuf.Field): string { const configured = field.options?.["json_name"]; return typeof configured === "string" ? configured : field.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()); }
function camelToSnake(value: string): string { if (value.includes("_")) throw new Error("FieldMask ProtoJSON paths must use lowerCamelCase"); return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }
function snakeToCamel(value: string): string { return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()); }
function protoFraction(nanos: number): string { if (!nanos) return ""; const digits = nanos % 1_000_000 === 0 ? 3 : nanos % 1_000 === 0 ? 6 : 9; return `.${String(nanos).padStart(9, "0").slice(0, digits)}`; }
function daysInMonth(year: number, month: number): number { return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31; }
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
