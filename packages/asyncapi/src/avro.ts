// The Avro correspondence (§9.2's named-correspondence list, ruled
// 2026-08-14): an Avro-declared payload crosses the boundary as logical
// application values under the Avro specification's own JSON Encoding.
// deriveAvroSchema maps the Avro schema to the JSON Schema of its
// Avro-JSON-encoded data, under the specification's pinned table (Go twin:
// avro.go). Named types materialize once under `$defs` keyed by Avro
// fullname; references become `$ref: "#/$defs/<fullname>"`, rebased onto
// the operation schema's pointer by the cyclic-hoisting pass at emission.
// A declaration that does not parse as an Avro schema reports undefined and
// is handled as an inexpressible contract under the byte rule.

const AVRO_BYTES_PATTERN = "^[\\u0000-\\u00ff]*$";

interface AvroContext {
  defs: Record<string, unknown>;
  inProgress: Set<string>;
  shortNames: Map<string, string>;
}

export function deriveAvroSchema(schema: unknown): Record<string, unknown> | undefined {
  const ctx: AvroContext = { defs: {}, inProgress: new Set(), shortNames: new Map() };
  const derived = deriveAvro(schema, "", ctx);
  if (derived === undefined) return undefined;
  if (Object.keys(ctx.defs).length > 0) derived["$defs"] = ctx.defs;
  return derived;
}

function deriveAvro(node: unknown, namespace: string, ctx: AvroContext): Record<string, unknown> | undefined {
  if (typeof node === "string") return deriveAvroName(node, namespace, ctx);
  if (Array.isArray(node)) {
    const branches: unknown[] = [];
    for (const member of node) {
      if (member === "null") {
        branches.push({ type: "null" });
        continue;
      }
      const derived = deriveAvro(member, namespace, ctx);
      if (derived === undefined) return undefined;
      const name = avroBranchName(member, namespace, ctx);
      if (name === undefined) return undefined;
      branches.push({
        type: "object",
        properties: { [name]: derived },
        required: [name],
        additionalProperties: false,
      });
    }
    if (branches.length === 0) return undefined;
    return { oneOf: branches };
  }
  if (typeof node === "object" && node !== null) {
    const v = node as Record<string, unknown>;
    const typ = typeof v["type"] === "string" ? (v["type"] as string) : "";
    switch (typ) {
      case "record":
      case "error":
        return deriveAvroRecord(v, namespace, ctx);
      case "enum": {
        const symbols = v["symbols"];
        if (!Array.isArray(symbols)) return undefined;
        const full = registerAvroName(v, namespace, ctx);
        if (full === undefined) return undefined;
        ctx.defs[full] = { enum: [...symbols] };
        ctx.inProgress.delete(full);
        return { $ref: `#/$defs/${escapePointer(full)}` };
      }
      case "array": {
        const items = deriveAvro(v["items"], namespace, ctx);
        if (items === undefined) return undefined;
        return { type: "array", items };
      }
      case "map": {
        const values = deriveAvro(v["values"], namespace, ctx);
        if (values === undefined) return undefined;
        return { type: "object", additionalProperties: values };
      }
      case "fixed": {
        const size = v["size"];
        if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return undefined;
        const full = registerAvroName(v, namespace, ctx);
        if (full === undefined) return undefined;
        ctx.defs[full] = { type: "string", pattern: AVRO_BYTES_PATTERN, minLength: size, maxLength: size };
        ctx.inProgress.delete(full);
        return { $ref: `#/$defs/${escapePointer(full)}` };
      }
      case "":
        return undefined;
      default:
        return deriveAvroName(typ, namespace, ctx);
    }
  }
  return undefined;
}

function deriveAvroRecord(v: Record<string, unknown>, namespace: string, ctx: AvroContext): Record<string, unknown> | undefined {
  const full = registerAvroName(v, namespace, ctx);
  if (full === undefined) return undefined;
  const dot = full.lastIndexOf(".");
  const childNS = dot >= 0 ? full.slice(0, dot) : "";
  const fields = v["fields"];
  if (!Array.isArray(fields)) return undefined;
  const properties: Record<string, unknown> = {};
  const required: unknown[] = [];
  for (const rawField of fields) {
    if (typeof rawField !== "object" || rawField === null) return undefined;
    const field = rawField as Record<string, unknown>;
    const name = field["name"];
    if (typeof name !== "string" || name === "") return undefined;
    const derived = deriveAvro(field["type"], childNS, ctx);
    if (derived === undefined) return undefined;
    properties[name] = derived;
    required.push(name);
  }
  ctx.defs[full] = { type: "object", properties, required, additionalProperties: false };
  ctx.inProgress.delete(full);
  return { $ref: `#/$defs/${escapePointer(full)}` };
}

function deriveAvroName(name: string, namespace: string, ctx: AvroContext): Record<string, unknown> | undefined {
  switch (name) {
    case "null":
      return { type: "null" };
    case "boolean":
      return { type: "boolean" };
    case "int":
      return { type: "integer", minimum: -2147483648, maximum: 2147483647 };
    case "long":
      return { type: "integer" };
    case "float":
    case "double":
      return { type: "number" };
    case "bytes":
      return { type: "string", pattern: AVRO_BYTES_PATTERN };
    case "string":
      return { type: "string" };
  }
  const full = resolveAvroName(name, namespace, ctx);
  if (full === "") return undefined;
  if (Object.hasOwn(ctx.defs, full) || ctx.inProgress.has(full)) {
    return { $ref: `#/$defs/${escapePointer(full)}` };
  }
  return undefined;
}

function resolveAvroName(name: string, namespace: string, ctx: AvroContext): string {
  if (name.includes(".")) return name;
  if (namespace !== "") {
    const candidate = `${namespace}.${name}`;
    if (Object.hasOwn(ctx.defs, candidate) || ctx.inProgress.has(candidate)) return candidate;
  }
  const known = ctx.shortNames.get(name);
  if (known !== undefined) return known;
  if (Object.hasOwn(ctx.defs, name) || ctx.inProgress.has(name)) return name;
  return "";
}

function registerAvroName(v: Record<string, unknown>, namespace: string, ctx: AvroContext): string | undefined {
  const name = v["name"];
  if (typeof name !== "string" || name === "") return undefined;
  let ns = typeof v["namespace"] === "string" ? (v["namespace"] as string) : "";
  if (ns === "" && !name.includes(".")) ns = namespace;
  const full = ns !== "" && !name.includes(".") ? `${ns}.${name}` : name;
  const short = full.includes(".") ? full.slice(full.lastIndexOf(".") + 1) : full;
  if (!ctx.shortNames.has(short)) ctx.shortNames.set(short, full);
  ctx.inProgress.add(full);
  return full;
}

// avroBranchName is the JSON Encoding's union wrapper key (Go twin).
function avroBranchName(member: unknown, namespace: string, ctx: AvroContext): string | undefined {
  if (typeof member === "string") {
    switch (member) {
      case "boolean":
      case "int":
      case "long":
      case "float":
      case "double":
      case "bytes":
      case "string":
        return member;
    }
    const full = resolveAvroName(member, namespace, ctx);
    return full === "" ? undefined : full;
  }
  if (typeof member === "object" && member !== null) {
    const v = member as Record<string, unknown>;
    const typ = typeof v["type"] === "string" ? (v["type"] as string) : "";
    switch (typ) {
      case "record":
      case "error":
      case "enum":
      case "fixed": {
        const name = v["name"];
        if (typeof name !== "string" || name === "") return undefined;
        let ns = typeof v["namespace"] === "string" ? (v["namespace"] as string) : "";
        if (ns === "" && !name.includes(".")) ns = namespace;
        return ns !== "" && !name.includes(".") ? `${ns}.${name}` : name;
      }
      case "array":
      case "map":
        return typ;
      default:
        switch (typ) {
          case "boolean":
          case "int":
          case "long":
          case "float":
          case "double":
          case "bytes":
          case "string":
            return typ;
        }
        return undefined;
    }
  }
  return undefined;
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}
