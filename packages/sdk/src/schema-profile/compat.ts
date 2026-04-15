import type { JSONObject, JSONValue } from "./helpers.js";
import { asMap, asSlice, canonicalKey, toFloat64 } from "./helpers.js";

export interface CompatResult {
  compatible: boolean;
  reason?: string;
}

const COMPATIBLE: CompatResult = { compatible: true };

function fail(reason: string): CompatResult {
  return { compatible: false, reason };
}

function prefixed(prefix: string, r: CompatResult): CompatResult {
  if (r.compatible) return r;
  return fail(r.reason ? `${prefix}: ${r.reason}` : prefix);
}

/** Checks whether `cand` is a compatible input schema for `tgt` (i.e. `cand` accepts at least everything `tgt` accepts). */
export function inputCompatible(tgt: JSONObject, cand: JSONObject): CompatResult {
  if (Object.keys(cand).length === 0) return COMPATIBLE;
  return compat(tgt, cand, true);
}

/** Checks whether `cand` is a compatible output schema for `tgt` (i.e. `cand` only produces values that `tgt` allows). */
export function outputCompatible(tgt: JSONObject, cand: JSONObject): CompatResult {
  if (Object.keys(cand).length === 0) {
    return Object.keys(tgt).length === 0
      ? COMPATIBLE
      : fail("candidate is empty but target is not");
  }
  return compat(tgt, cand, false);
}

function compat(tgt: JSONObject, cand: JSONObject, isInput: boolean): CompatResult {
  if (Object.keys(tgt).length === 0) {
    // Empty target ({}) is Top — "could send/receive anything".
    // For input:  the candidate must also be unconstrained, because the interface may
    //             send any value and the candidate must accept it all.  A narrower
    //             candidate cannot cover the full Top domain → incompatible.
    // For output: any candidate is a subset of Top, so always compatible.
    if (isInput && Object.keys(cand).length > 0) {
      return fail("candidate is constrained but target is unconstrained (Top)");
    }
    return COMPATIBLE;
  }
  if (Object.keys(cand).length === 0) {
    if (isInput) return COMPATIBLE;
    return Object.keys(tgt).length === 0
      ? COMPATIBLE
      : fail("candidate is empty but target is not");
  }

  const tgtTypes = typeSet(tgt);
  const candTypes = typeSet(cand);
  if (tgtTypes !== null || candTypes !== null) {
    if (isInput) {
      if (!subsetTypes(tgtTypes, candTypes)) {
        const missing = missingTypes(tgtTypes, candTypes);
        return fail(`type: candidate does not allow ${missing}`);
      }
    } else {
      if (!subsetTypes(candTypes, tgtTypes)) {
        const extra = missingTypes(candTypes, tgtTypes);
        return fail(`type: candidate allows ${extra} but target does not`);
      }
    }
  }

  let r: CompatResult;

  r = compatConstEnum(tgt, cand, isInput);
  if (!r.compatible) return r;

  if (hasType(tgt, "object") || hasType(cand, "object")) {
    r = compatObject(tgt, cand, isInput);
    if (!r.compatible) return r;
  }

  if (hasType(tgt, "array") || hasType(cand, "array")) {
    r = compatArray(tgt, cand, isInput);
    if (!r.compatible) return r;
  }

  if (hasType(tgt, "number") || hasType(tgt, "integer") || hasType(cand, "number") || hasType(cand, "integer")) {
    r = compatNumericBounds(tgt, cand, isInput);
    if (!r.compatible) return r;
  }

  if (hasType(tgt, "string") || hasType(cand, "string")) {
    r = compatSimpleBounds(tgt, cand, isInput, "minLength", "maxLength");
    if (!r.compatible) return r;
  }

  if (hasType(tgt, "array") || hasType(cand, "array")) {
    r = compatSimpleBounds(tgt, cand, isInput, "minItems", "maxItems");
    if (!r.compatible) return r;
  }

  if (hasUnion(tgt) || hasUnion(cand)) {
    r = compatUnion(tgt, cand, isInput);
    if (!r.compatible) return r;
  }

  return COMPATIBLE;
}

function typeSet(schema: JSONObject): Set<string> | null {
  const v = schema["type"];
  if (!v) return null;
  if (typeof v === "string") return new Set([v]);
  if (!Array.isArray(v)) return null;
  const set = new Set<string>();
  for (const it of v) {
    if (typeof it === "string") set.add(it);
  }
  return set;
}

function subsetTypes(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null) return b === null;
  if (b === null) return true;
  for (const k of a) {
    if (b.has(k)) continue;
    if (k === "integer" && b.has("number")) continue;
    return false;
  }
  return true;
}

function missingTypes(a: Set<string> | null, b: Set<string> | null): string {
  if (a === null) return "unknown";
  if (b === null) {
    return `"${[...a].join('", "')}"`;
  }
  const missing: string[] = [];
  for (const k of a) {
    if (!b.has(k) && !(k === "integer" && b.has("number"))) {
      missing.push(`"${k}"`);
    }
  }
  return missing.join(", ") || "unknown";
}

function hasType(schema: JSONObject, t: string): boolean {
  const s = typeSet(schema);
  return s !== null && s.has(t);
}

function hasUnion(schema: JSONObject): boolean {
  return "oneOf" in schema || "anyOf" in schema;
}

function compatConstEnum(tgt: JSONObject, cand: JSONObject, isInput: boolean): CompatResult {
  const tgtHasConst = "const" in tgt;
  const candHasConst = "const" in cand;
  const [tgtEnum, tgtHasEnum] = enumSetOf(tgt);
  const [candEnum, candHasEnum] = enumSetOf(cand);

  if (isInput) {
    if (tgtHasConst) {
      if (candHasConst) {
        return canonicalKey(tgt["const"]) === canonicalKey(cand["const"])
          ? COMPATIBLE
          : fail("const: candidate const does not match target const");
      }
      if (candHasEnum) {
        return candEnum!.has(canonicalKey(tgt["const"]))
          ? COMPATIBLE
          : fail("enum: target const value not in candidate enum");
      }
      return COMPATIBLE;
    }
    if (tgtHasEnum) {
      if (candHasConst) {
        return tgtEnum!.size === 1 && tgtEnum!.has(canonicalKey(cand["const"]))
          ? COMPATIBLE
          : fail("const: candidate const does not match target enum");
      }
      if (candHasEnum) {
        for (const k of tgtEnum!) {
          if (!candEnum!.has(k)) return fail("enum: target enum value not in candidate enum");
        }
        return COMPATIBLE;
      }
      return COMPATIBLE;
    }
    return COMPATIBLE;
  }

  if (tgtHasEnum) {
    if (candHasConst) {
      return tgtEnum!.has(canonicalKey(cand["const"]))
        ? COMPATIBLE
        : fail("enum: candidate const value not in target enum");
    }
    if (candHasEnum) {
      for (const k of candEnum!) {
        if (!tgtEnum!.has(k)) return fail("enum: candidate enum value not in target enum");
      }
      return COMPATIBLE;
    }
    return fail("enum: candidate has no const or enum but target requires enum");
  }
  if (tgtHasConst) {
    if (candHasConst) {
      return canonicalKey(tgt["const"]) === canonicalKey(cand["const"])
        ? COMPATIBLE
        : fail("const: candidate const does not match target const");
    }
    if (candHasEnum) {
      return candEnum!.size === 1 && candEnum!.has(canonicalKey(tgt["const"]))
        ? COMPATIBLE
        : fail("enum: candidate enum does not match target const");
    }
    return fail("const: candidate has no const or enum but target requires const");
  }
  return COMPATIBLE;
}

function enumSetOf(schema: JSONObject): [Set<string> | null, boolean] {
  if (!("enum" in schema)) return [null, false];
  const arr = asSlice(schema["enum"]);
  if (!arr) return [null, true];
  return [new Set(arr.map(canonicalKey)), true];
}

function compatObject(tgt: JSONObject, cand: JSONObject, isInput: boolean): CompatResult {
  const tgtReq = stringSetOf(tgt["required"]);
  const candReq = stringSetOf(cand["required"]);
  const tgtProps = asMap(tgt["properties"]) ?? {};
  const candProps = asMap(cand["properties"]) ?? {};

  if (isInput) {
    for (const k of candReq) {
      if (!tgtReq.has(k)) return fail(`required: candidate requires "${k}" but target does not`);
    }
    for (const [p, tv] of Object.entries(tgtProps)) {
      const tvm = asMap(tv);
      if (!tvm) continue;
      if (p in candProps) {
        const cvm = asMap(candProps[p]);
        if (!cvm) continue;
        const r = compat(tvm, cvm, true);
        if (!r.compatible) return prefixed(`properties["${p}"]`, r);
      }
    }
    return COMPATIBLE;
  }

  for (const k of tgtReq) {
    if (!candReq.has(k)) return fail(`required: target requires "${k}" but candidate does not`);
  }

  const tgtAP = tgt["additionalProperties"];

  for (const [p, cv] of Object.entries(candProps)) {
    if (!(p in tgtProps)) {
      if (tgtAP === false) return fail(`additionalProperties: target forbids but candidate has property "${p}"`);
    }
    if (p in tgtProps) {
      const tvm = asMap(tgtProps[p]);
      const cvm = asMap(cv);
      if (tvm && cvm) {
        const r = compat(tvm, cvm, false);
        if (!r.compatible) return prefixed(`properties["${p}"]`, r);
      }
    }
  }

  if (typeof tgtAP === "boolean" && !tgtAP) {
    const candAP = cand["additionalProperties"];
    if (typeof candAP === "boolean") {
      return !candAP
        ? COMPATIBLE
        : fail("additionalProperties: target forbids but candidate allows");
    }
    return fail("additionalProperties: target forbids but candidate allows");
  }

  if (typeof tgtAP === "object" && tgtAP !== null) {
    const candAP = cand["additionalProperties"];
    if (typeof candAP === "object" && candAP !== null) {
      const r = compat(tgtAP as JSONObject, candAP as JSONObject, false);
      if (!r.compatible) return prefixed("additionalProperties", r);
    } else if (typeof candAP === "boolean" && !candAP) {
      return COMPATIBLE;
    } else {
      return fail("additionalProperties: target constrains but candidate does not");
    }
  }

  return COMPATIBLE;
}

function compatArray(tgt: JSONObject, cand: JSONObject, isInput: boolean): CompatResult {
  const tv = asMap(tgt["items"]) ?? {};
  const cv = asMap(cand["items"]) ?? {};
  return prefixed("items", compat(tv, cv, isInput));
}

function compatUnion(tgt: JSONObject, cand: JSONObject, isInput: boolean): CompatResult {
  const tgtVars = unionVariants(tgt);
  const candVars = unionVariants(cand);
  if (!tgtVars || !candVars) return fail("oneOf: missing or invalid union variants");

  if (isInput) {
    for (const v of tgtVars) {
      if (!candVars.some((w) => compat(v, w, true).compatible)) {
        return fail("oneOf: target variant has no compatible candidate variant");
      }
    }
    return COMPATIBLE;
  }

  for (const w of candVars) {
    if (!tgtVars.some((v) => compat(v, w, false).compatible)) {
      return fail("oneOf: candidate variant has no compatible target variant");
    }
  }
  return COMPATIBLE;
}

function unionVariants(schema: JSONObject): JSONObject[] | null {
  const key = "oneOf" in schema ? "oneOf" : "anyOf" in schema ? "anyOf" : null;
  if (!key) return null;
  const arr = asSlice(schema[key]);
  if (!arr) return null;
  const out: JSONObject[] = [];
  for (const it of arr) {
    const m = asMap(it);
    if (!m) return null;
    out.push(m);
  }
  return out;
}

function compatNumericBounds(tgt: JSONObject, cand: JSONObject, isInput: boolean): CompatResult {
  const [tgtLo, tgtLoExcl] = effectiveLowerBound(tgt);
  const [candLo, candLoExcl] = effectiveLowerBound(cand);
  const [tgtHi, tgtHiExcl] = effectiveUpperBound(tgt);
  const [candHi, candHiExcl] = effectiveUpperBound(cand);

  const tgtHasLo = "minimum" in tgt || "exclusiveMinimum" in tgt;
  const tgtHasHi = "maximum" in tgt || "exclusiveMaximum" in tgt;
  const candHasLo = "minimum" in cand || "exclusiveMinimum" in cand;
  const candHasHi = "maximum" in cand || "exclusiveMaximum" in cand;

  if (isInput) {
    if (tgtHasLo && candHasLo) {
      if (!lowerBoundLessOrEqual(candLo, candLoExcl, tgtLo, tgtLoExcl)) {
        return fail(`minimum: candidate minimum ${candLo} is greater than target minimum ${tgtLo}`);
      }
    }
    if (tgtHasHi && candHasHi) {
      if (!upperBoundGreaterOrEqual(candHi, candHiExcl, tgtHi, tgtHiExcl)) {
        return fail(`maximum: candidate maximum ${candHi} is less than target maximum ${tgtHi}`);
      }
    }
  } else {
    if (tgtHasLo) {
      if (!candHasLo) return fail("minimum: target has minimum but candidate does not");
      if (!lowerBoundGreaterOrEqual(candLo, candLoExcl, tgtLo, tgtLoExcl)) {
        return fail(`minimum: candidate minimum ${candLo} is less than target minimum ${tgtLo}`);
      }
    }
    if (tgtHasHi) {
      if (!candHasHi) return fail("maximum: target has maximum but candidate does not");
      if (!upperBoundLessOrEqual(candHi, candHiExcl, tgtHi, tgtHiExcl)) {
        return fail(`maximum: candidate maximum ${candHi} is greater than target maximum ${tgtHi}`);
      }
    }
  }
  return COMPATIBLE;
}

function effectiveLowerBound(schema: JSONObject): [number, boolean] {
  const hasMin = "minimum" in schema;
  const hasEMin = "exclusiveMinimum" in schema;
  if (hasMin && hasEMin) {
    const mv = toFloat64(schema["minimum"]);
    const ev = toFloat64(schema["exclusiveMinimum"]);
    return ev >= mv ? [ev, true] : [mv, false];
  }
  if (hasEMin) return [toFloat64(schema["exclusiveMinimum"]), true];
  if (hasMin) return [toFloat64(schema["minimum"]), false];
  return [0, false];
}

function effectiveUpperBound(schema: JSONObject): [number, boolean] {
  const hasMax = "maximum" in schema;
  const hasEMax = "exclusiveMaximum" in schema;
  if (hasMax && hasEMax) {
    const mv = toFloat64(schema["maximum"]);
    const ev = toFloat64(schema["exclusiveMaximum"]);
    return ev <= mv ? [ev, true] : [mv, false];
  }
  if (hasEMax) return [toFloat64(schema["exclusiveMaximum"]), true];
  if (hasMax) return [toFloat64(schema["maximum"]), false];
  return [0, false];
}

function lowerBoundLessOrEqual(a: number, aExcl: boolean, b: number, bExcl: boolean): boolean {
  if (a < b) return true;
  if (a > b) return false;
  return !(aExcl && !bExcl);
}

function lowerBoundGreaterOrEqual(a: number, aExcl: boolean, b: number, bExcl: boolean): boolean {
  if (a > b) return true;
  if (a < b) return false;
  return !(bExcl && !aExcl);
}

function upperBoundLessOrEqual(a: number, aExcl: boolean, b: number, bExcl: boolean): boolean {
  if (a < b) return true;
  if (a > b) return false;
  return !(bExcl && !aExcl);
}

function upperBoundGreaterOrEqual(a: number, aExcl: boolean, b: number, bExcl: boolean): boolean {
  if (a > b) return true;
  if (a < b) return false;
  return !(aExcl && !bExcl);
}

function compatSimpleBounds(
  tgt: JSONObject,
  cand: JSONObject,
  isInput: boolean,
  minKey: string,
  maxKey: string,
): CompatResult {
  if (isInput) {
    if (minKey in tgt && minKey in cand) {
      if (toFloat64(cand[minKey]) > toFloat64(tgt[minKey])) {
        return fail(`${minKey}: candidate ${minKey} ${toFloat64(cand[minKey])} is greater than target ${minKey} ${toFloat64(tgt[minKey])}`);
      }
    }
    if (maxKey in tgt && maxKey in cand) {
      if (toFloat64(cand[maxKey]) < toFloat64(tgt[maxKey])) {
        return fail(`${maxKey}: candidate ${maxKey} ${toFloat64(cand[maxKey])} is less than target ${maxKey} ${toFloat64(tgt[maxKey])}`);
      }
    }
  } else {
    if (minKey in tgt) {
      if (!(minKey in cand)) return fail(`${minKey}: target has ${minKey} but candidate does not`);
      if (toFloat64(cand[minKey]) < toFloat64(tgt[minKey])) {
        return fail(`${minKey}: candidate ${minKey} ${toFloat64(cand[minKey])} is less than target ${minKey} ${toFloat64(tgt[minKey])}`);
      }
    }
    if (maxKey in tgt) {
      if (!(maxKey in cand)) return fail(`${maxKey}: target has ${maxKey} but candidate does not`);
      if (toFloat64(cand[maxKey]) > toFloat64(tgt[maxKey])) {
        return fail(`${maxKey}: candidate ${maxKey} ${toFloat64(cand[maxKey])} is greater than target ${maxKey} ${toFloat64(tgt[maxKey])}`);
      }
    }
  }
  return COMPATIBLE;
}

function stringSetOf(v: JSONValue): Set<string> {
  if (!Array.isArray(v)) return new Set();
  const s = new Set<string>();
  for (const it of v) {
    if (typeof it === "string") s.add(it);
  }
  return s;
}
