import { isJSONNumber } from "@openbindings/json";
import { isRetainedValue, retain, retainFrom, retainedValueAccess } from "@openbindings/json/values";
import type { RetainedValue, StringForcingReason, ValueAccess, ValueCosts } from "@openbindings/json/values";

// Only this module can construct schema scalar views. Ordinary JSON markers
// and caller-supplied toJSON methods confer no scalar identity.
const strings = new WeakMap<object, RetainedValue>();
export const stringValue = (value: unknown): RetainedValue | undefined =>
  value !== null && typeof value === "object" ? strings.get(value) : undefined;

// Module-level factories keep a child view out of the root's lexical scope.
function scalarView(value: RetainedValue): object {
  // The backend has an existing JSON.stringify call on oneOf failure. This
  // private hook serves that diagnostic without eagerly projecting an instance.
  const scalar = Object.freeze(Object.defineProperty(Object.create(null) as object, "toJSON", {
    value: () => value.scalar("diagnostic"),
  }));
  strings.set(scalar, value);
  return scalar;
}
function visit(value: RetainedValue): unknown {
  if (value.kind === "array") return Array.from({ length: value.length! }, (_, i) => visit(value.get(i)!));
  if (value.kind === "object") return Object.fromEntries(value.keys().map(key => [key, visit(value.get(key)!)]));
  return value.byteLength === undefined ? value.json("schema-constraint") : scalarView(value);
}

export function prepareValue<T>(value: T, access?: ValueAccess<T>): {instance:unknown; costs():ValueCosts} {
  if (!access && !isRetainedValue(value)) throw new TypeError("Expected an authenticated retained value or an explicit external adapter");
  // Independent ownership also covers scalar roots and borrowed memory.
  const local = isRetainedValue(value) && (!access || access === retainedValueAccess);
  const source = local ? retain(value) : retainFrom(value,access!);
  return {instance:visit(source), costs:()=>source.costs};
}

/** Prepare ordinary containers for the upstream validator, retaining byte leaves.
 * This copies structure, not JSON text. Validation traversal remains upstream.
 * @deprecated Use `compile(schema).validate(value)`; plain data with rich leaves is read in place.
 */
export function valueInstance(value: RetainedValue): unknown;
export function valueInstance<T>(value: T, access: ValueAccess<T>): unknown;
export function valueInstance<T>(value: T, access?: ValueAccess<T>): unknown {
  return prepareValue(value,access).instance;
}

/** Materialize logical operands only for equality constraints or diagnostics.
 * No stringify/parse bridge; exact numeric carriers pass through unchanged.
 */
export function projectInstance(value: unknown, reason: StringForcingReason): unknown {
  const active = new Set<object>();
  let remaining = 1_000_000;
  const visit = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 512) throw new RangeError("Schema operand projection budget exceeded");
    const scalar = stringValue(value);
    if (scalar) return scalar.scalar(reason);
    if (value === null || typeof value !== "object" || isJSONNumber(value)) return value;
    // SchemaNode diagnostic metadata is handled by the error renderer. Never
    // enumerate a host object's methods or call arbitrary serialization hooks.
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!array && prototype !== null && prototype !== Object.prototype) return value;
    if (active.has(value)) throw new TypeError("Cyclic schema operand");
    active.add(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = array ? Array.from({length:value.length}, (_, i) => String(i)) : Object.keys(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("Schema operands require own data properties");
      Object.defineProperty(result, key, {value:visit(descriptor.value, depth + 1), enumerable:true, writable:true, configurable:true});
    }
    active.delete(value);
    return result;
  };
  return visit(value, 0);
}
