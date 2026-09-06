/**
 * Serializes a JSON value to its canonical form per RFC 8785 (JSON
 * Canonicalization Scheme, JCS): deterministic UTF-16 object-key ordering and
 * ECMAScript number/string formatting. It underlies prepared-interface
 * revisions and the schema-comparison profile, mirroring Go's
 * `canonicaljson.Marshal`.
 *
 * Returns `undefined` for input the JCS cannot represent (for example a bare
 * `undefined`).
 */
export function canonicalize(value: unknown): string | undefined {
  return canonicalizedValue(value)?.canonical;
}

/** @internal Canonical bytes plus their private normalized JSON graph. */
export function canonicalizedValue(
  value: unknown,
): Readonly<{
  canonical: string;
  snapshot: unknown;
  requiresManualOrdering: boolean;
}> | undefined {
  const state = { requiresManualOrdering: false };
  const normalized = normalizeCanonicalJSON(value, state);
  if (normalized === undefined) return undefined;
  // Native JSON serialization is substantially faster and less allocation
  // heavy once object insertion order is canonical. ECMAScript reorders
  // array-index-like object keys numerically, however, so those uncommon
  // documents retain the fully manual RFC 8785 path.
  const canonical = state.requiresManualOrdering
    ? serializeCanonical(normalized)
    : JSON.stringify(normalized);
  if (canonical === undefined) return undefined;
  return {
    canonical,
    snapshot: normalized,
    requiresManualOrdering: state.requiresManualOrdering,
  };
}

interface NormalizationState {
  requiresManualOrdering: boolean;
}

function normalizeCanonicalJSON(
  value: unknown,
  state: NormalizationState,
): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("non-finite numbers are not valid canonical JSON");
  }
  if (value === null) return null;
  switch (typeof value) {
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "number":
      return Object.is(value, -0) ? 0 : value;
    case "string":
    case "boolean":
    case "bigint":
      return value;
  }

  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return normalizeCanonicalJSON(toJSON.call(value), state);
  }

  if (Array.isArray(value)) {
    const clone = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index++) {
      clone[index] = normalizeCanonicalJSON(value[index], state) ?? null;
    }
    return clone;
  }

  const source = value as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (isArrayIndexKey(key)) state.requiresManualOrdering = true;
    const member = normalizeCanonicalJSON(source[key], state);
    if (member === undefined) continue;
    // Assignment to this legacy accessor would mutate the clone's prototype.
    if (key === "__proto__") {
      Object.defineProperty(clone, key, {
        value: member,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      clone[key] = member;
    }
  }
  return clone;
}

function isArrayIndexKey(key: string): boolean {
  const number = Number(key);
  return Number.isInteger(number)
    && number >= 0
    && number < 0xffff_ffff
    && String(number) === key;
}

function serializeCanonical(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("non-finite numbers are not valid canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return serializeCanonical(toJSON.call(value));
  }

  if (Array.isArray(value)) {
    const array = value as unknown[];
    const members = new Array<string>(array.length);
    for (let index = 0; index < array.length; index++) {
      const serialized = serializeCanonical(array[index]);
      members[index] = serialized === undefined ? "null" : serialized;
    }
    return `[${members.join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(object).sort()) {
    const serialized = serializeCanonical(object[key]);
    if (serialized === undefined) continue;
    members.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${members.join(",")}}`;
}
