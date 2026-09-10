import { equalJSON } from "@openbindings/json";
import { asMap } from "./helpers.js";
import type { JSONObject } from "./helpers.js";

/** Structural identity of normalized schemas, not general schema equivalence.
 * Only schema union positions are multisets; const/enum values stay ordinary JSON. */
export function equalNormalizedSchemas(a: JSONObject, b: JSONObject): boolean {
  if (Object.keys(a).length !== Object.keys(b).length) return false;
  for (const key of Object.keys(a)) {
    if (!Object.hasOwn(b, key)) return false;
    const av = a[key], bv = b[key];
    if ((key === "oneOf" || key === "anyOf") && Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      const used = new Set<number>();
      for (const variant of av) {
        const candidate = asMap(variant);
        const i = bv.findIndex((v: unknown, i) => {
          const other = asMap(v);
          return !used.has(i) && !!candidate && !!other && equalNormalizedSchemas(candidate, other);
        });
        if (i < 0) return false;
        used.add(i);
      }
    } else if (key === "properties" && asMap(av) && asMap(bv)) {
      const am = av as JSONObject, bm = bv as JSONObject;
      if (Object.keys(am).length !== Object.keys(bm).length) return false;
      for (const name of Object.keys(am)) {
        const x = asMap(am[name]), y = asMap(bm[name]);
        if (!x || !y || !equalNormalizedSchemas(x, y)) return false;
      }
    } else if ((key === "items" || key === "additionalProperties") && asMap(av) && asMap(bv)) {
      if (!equalNormalizedSchemas(av as JSONObject, bv as JSONObject)) return false;
    } else if (!equalJSON(av, bv)) return false;
  }
  return true;
}
