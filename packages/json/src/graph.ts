import { isJSONNumber } from "./index.js";
import isRawJSON from "core-js-pure/actual/json/is-raw-json.js";

/** Detach an internal JSON-shaped graph, retaining alias/cycle cut points.
 * This is not JSON admission: optional undefined metadata may exist in models.
 * Exact numbers are immutable leaves, never objects to walk or reconstitute.
 * @deprecated Internal to json-schema; results of the public surface are frozen and need no clone.
 */
export function cloneValueGraph<T>(value: T): T {
  const memo = new Map<object, unknown>();
  function clone(node: unknown): unknown {
    if (node === undefined || node === null || typeof node === "string" || typeof node === "boolean" || isJSONNumber(node)) return node;
    if (typeof node === "number" && Number.isFinite(node)) return node;
    if (typeof node !== "object" || isRawJSON(node)) throw new TypeError("internal value graph contains a non-JSON value");
    if (memo.has(node)) return memo.get(node);
    const proto = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && proto !== Object.prototype && proto !== null) {
      throw new TypeError("internal value graph contains a non-JSON object");
    }
    const out = Array.isArray(node) ? new Array(node.length) : Object.create(proto);
    memo.set(node, out);
    for (const key of Reflect.ownKeys(node)) {
      if (Array.isArray(node) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(node, key)!;
      if (!("value" in descriptor)) throw new TypeError("internal value graph contains an accessor");
      Object.defineProperty(out, key, { value: clone(descriptor.value), enumerable: descriptor.enumerable, writable: true, configurable: true });
    }
    return out;
  }
  return clone(value) as T;
}
