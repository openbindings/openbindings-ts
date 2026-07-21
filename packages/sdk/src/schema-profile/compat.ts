import type { JSONObject, JSONValue } from "./helpers.js";
import { asMap, asSlice, canonicalKey, ptrJoin, toFloat64 } from "./helpers.js";
import { NotNormalizedError } from "./errors.js";

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

/**
 * Checks whether `cand` is a compatible input schema for `tgt` (i.e. `cand`
 * accepts at least everything `tgt` accepts). Both schemas MUST already be
 * normalized (see Normalizer.normalize): $refs are not resolved here.
 * Tell-tale non-normalized shapes (a scalar type, an unresolved $ref, an
 * unflattened allOf) are refused with a NotNormalizedError rather than
 * risking a silently divergent verdict.
 */
export function inputCompatible(tgt: JSONObject, cand: JSONObject): CompatResult {
  assertNormalizedPair(tgt, cand);
  if (Object.keys(cand).length === 0) return COMPATIBLE;
  return compat(tgt, cand, true);
}

/**
 * Checks whether `cand` is a compatible output schema for `tgt` (i.e. `cand`
 * only produces values that `tgt` allows). Both schemas MUST already be
 * normalized; see inputCompatible, including the loud NotNormalizedError
 * refusal of tell-tale non-normalized shapes.
 */
export function outputCompatible(tgt: JSONObject, cand: JSONObject): CompatResult {
  assertNormalizedPair(tgt, cand);
  if (Object.keys(cand).length === 0) {
    return Object.keys(tgt).length === 0
      ? COMPATIBLE
      : fail("candidate is unconstrained but target is not");
  }
  return compat(tgt, cand, false);
}

/**
 * Guards the pre-normalization contract of the two free directional checks:
 * the target is checked first, then the candidate, so a violation on both
 * sides reports deterministically.
 */
function assertNormalizedPair(tgt: JSONObject, cand: JSONObject): void {
  assertNormalized(tgt, "target");
  assertNormalized(cand, "candidate");
}

/**
 * Refuses the cheap, unambiguous shapes the Normalizer can never emit: an
 * unresolved $ref (always inlined), an unflattened allOf (always merged
 * away), and a non-array type (always canonicalized to a sorted array).
 * These are exactly the shapes that would otherwise decide verdicts
 * silently — most notably a raw scalar type, which the two reference SDKs
 * historically read differently. This is NOT a full normalized-form
 * validator; anything subtler stays the caller's contract. Nested walks
 * visit properties (sorted), additionalProperties, items, then oneOf/anyOf
 * variants — mirrored in the Go SDK's assertNormalized.
 */
function assertNormalized(schema: JSONObject, path: string): void {
  if ("$ref" in schema) throw new NotNormalizedError(path, "$ref", "resolved");
  if ("allOf" in schema) throw new NotNormalizedError(path, "allOf", "flattened");
  if ("type" in schema && !Array.isArray(schema["type"])) {
    throw new NotNormalizedError(path, "type", "an array");
  }
  const props = asMap(schema["properties"]);
  if (props) {
    for (const k of Object.keys(props).sort()) {
      const vm = asMap(props[k]);
      if (vm) assertNormalized(vm, ptrJoin(path, `properties[${canonicalKey(k)}]`));
    }
  }
  const ap = asMap(schema["additionalProperties"]);
  if (ap) assertNormalized(ap, ptrJoin(path, "additionalProperties"));
  const items = asMap(schema["items"]);
  if (items) assertNormalized(items, ptrJoin(path, "items"));
  for (const key of ["oneOf", "anyOf"] as const) {
    const arr = asSlice(schema[key]);
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      const vm = asMap(arr[i]);
      if (vm) assertNormalized(vm, ptrJoin(path, `${key}[${i}]`));
    }
  }
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
      : fail("candidate is unconstrained but target is not");
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

/**
 * Returns a comma-separated list of the types in `a` that are not in `b`,
 * each rendered via canonicalKey — the same JCS (JSON-string escaping)
 * rendering member names get — and sorted lexicographically so the reason
 * string is deterministic. Legitimate lowercase type names render
 * byte-identically to the previous literal quoting; the difference is
 * visible only for pathological names carrying quotes, backslashes, or
 * control characters. Mirrors the Go SDK's missingTypes byte for byte
 * ("all types" when `a` is untyped).
 */
function missingTypes(a: Set<string> | null, b: Set<string> | null): string {
  if (a === null) return "all types";
  const missing: string[] = [];
  for (const k of a) {
    if (b === null) {
      missing.push(canonicalKey(k));
      continue;
    }
    if (b.has(k)) continue;
    if (k === "integer" && b.has("number")) continue;
    missing.push(canonicalKey(k));
  }
  missing.sort();
  return missing.join(", ");
}

function hasType(schema: JSONObject, t: string): boolean {
  const s = typeSet(schema);
  return s !== null && s.has(t);
}

function hasUnion(schema: JSONObject): boolean {
  return "oneOf" in schema || "anyOf" in schema;
}

/**
 * Applies the const/enum rules. Reason prefixes follow the deciding-keyword
 * convention: the prefix names the keyword whose constraint rejects the
 * flowing value — for inputs the CANDIDATE's keyword (the target sends, the
 * candidate refuses), for outputs the TARGET's (the candidate produces, the
 * target refuses). Values and counts interpolate in JCS rendering. Mirrored
 * byte for byte in the Go SDK's compatConstEnum.
 */
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
          : fail(`const: candidate const ${canonicalKey(cand["const"])} does not match target const ${canonicalKey(tgt["const"])}`);
      }
      if (candHasEnum) {
        return candEnum!.has(canonicalKey(tgt["const"]))
          ? COMPATIBLE
          : fail(`enum: target const ${canonicalKey(tgt["const"])} not in candidate enum`);
      }
      return COMPATIBLE;
    }
    if (tgtHasEnum) {
      if (candHasConst) {
        if (tgtEnum!.size !== 1) {
          return fail(`const: candidate const ${canonicalKey(cand["const"])} cannot cover ${tgtEnum!.size} target enum values`);
        }
        return tgtEnum!.has(canonicalKey(cand["const"]))
          ? COMPATIBLE
          : fail(`const: candidate const ${canonicalKey(cand["const"])} not in target enum`);
      }
      if (candHasEnum) {
        for (const k of sortedSetValues(tgtEnum!)) {
          if (!candEnum!.has(k)) return fail(`enum: target value ${k} not in candidate enum`);
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
        : fail(`enum: candidate const ${canonicalKey(cand["const"])} not in target enum`);
    }
    if (candHasEnum) {
      for (const k of sortedSetValues(candEnum!)) {
        if (!tgtEnum!.has(k)) return fail(`enum: candidate value ${k} not in target enum`);
      }
      return COMPATIBLE;
    }
    return fail("enum: candidate is unconstrained but target has enum");
  }
  if (tgtHasConst) {
    if (candHasConst) {
      return canonicalKey(tgt["const"]) === canonicalKey(cand["const"])
        ? COMPATIBLE
        : fail(`const: candidate const ${canonicalKey(cand["const"])} does not match target const ${canonicalKey(tgt["const"])}`);
    }
    if (candHasEnum) {
      if (candEnum!.size !== 1) {
        return fail(`const: candidate enum has ${candEnum!.size} values but target allows only const ${canonicalKey(tgt["const"])}`);
      }
      return candEnum!.has(canonicalKey(tgt["const"]))
        ? COMPATIBLE
        : fail(`const: candidate enum value does not match target const ${canonicalKey(tgt["const"])}`);
    }
    return fail(`const: candidate is unconstrained but target requires const ${canonicalKey(tgt["const"])}`);
  }
  return COMPATIBLE;
}

function enumSetOf(schema: JSONObject): [Set<string> | null, boolean] {
  if (!("enum" in schema)) return [null, false];
  const arr = asSlice(schema["enum"]);
  // A malformed (non-array) enum value behaves as an empty set — present
  // but admitting nothing — matching the Go SDK's nil-map semantics.
  if (!arr) return [new Set<string>(), true];
  return [new Set(arr.map(canonicalKey)), true];
}

/** A set's values in lexicographic order — reasons never leak insertion order. */
function sortedSetValues(set: Set<string>): string[] {
  return [...set].sort();
}

/**
 * Applies the object rules. Set and property iteration is SORTED so the
 * first-failing member named in the reason is deterministic (and
 * byte-identical with the Go SDK) when several members fail. Property and
 * required member names interpolate via canonicalKey — the same JCS
 * rendering values get — so names carrying quotes, backslashes, or control
 * characters escape identically across the reference SDKs (plain names
 * render exactly as a bare quoted spelling).
 */
function compatObject(tgt: JSONObject, cand: JSONObject, isInput: boolean): CompatResult {
  const tgtReq = stringSetOf(tgt["required"]);
  const candReq = stringSetOf(cand["required"]);
  const tgtProps = asMap(tgt["properties"]) ?? {};
  const candProps = asMap(cand["properties"]) ?? {};

  if (isInput) {
    for (const k of sortedSetValues(candReq)) {
      if (!tgtReq.has(k)) return fail(`required: candidate requires ${canonicalKey(k)} but target does not`);
    }
    for (const p of Object.keys(tgtProps).sort()) {
      const tvm = asMap(tgtProps[p]);
      if (!tvm) continue;
      if (p in candProps) {
        const cvm = asMap(candProps[p]);
        if (!cvm) continue;
        const r = compat(tvm, cvm, true);
        if (!r.compatible) return prefixed(`properties[${canonicalKey(p)}]`, r);
      }
    }
    return COMPATIBLE;
  }

  for (const k of sortedSetValues(tgtReq)) {
    if (!candReq.has(k)) return fail(`required: target requires ${canonicalKey(k)} but candidate does not`);
  }

  const tgtAP = tgt["additionalProperties"];

  for (const p of Object.keys(candProps).sort()) {
    const cv = candProps[p];
    if (!(p in tgtProps)) {
      // The extra-property fault names the property's own path (the same
      // properties["..."] site every other property-level failure uses).
      if (tgtAP === false) return fail(`properties[${canonicalKey(p)}]: target forbids additional properties`);
    }
    if (p in tgtProps) {
      const tvm = asMap(tgtProps[p]);
      const cvm = asMap(cv);
      if (tvm && cvm) {
        const r = compat(tvm, cvm, false);
        if (!r.compatible) return prefixed(`properties[${canonicalKey(p)}]`, r);
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
      return fail("additionalProperties: candidate is less restrictive than target");
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
  if (!tgtVars || !candVars) {
    // One side is not a (well-formed) union: the profile defines no
    // cross-form rule. Same fixed prefix as the Go SDK.
    if (!tgtVars) return fail("oneOf: target is not a union but candidate is");
    return fail("oneOf: candidate is not a union but target is");
  }

  // The variant-miss reasons carry the target's REAL union key and the
  // failing variant's index (mirrors the Go SDK).
  const unionKey = "anyOf" in tgt ? "anyOf" : "oneOf";

  if (isInput) {
    for (const [i, tv] of tgtVars.entries()) {
      if (!candVars.some((w) => compat(tv, w, true).compatible)) {
        return fail(`${unionKey}: target variant ${i} has no compatible candidate variant`);
      }
    }
    return COMPATIBLE;
  }

  for (const [i, cv] of candVars.entries()) {
    if (!tgtVars.some((v) => compat(v, cv, false).compatible)) {
      return fail(`${unionKey}: candidate variant ${i} has no compatible target variant`);
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

  // Exclusive bounds are marked; numbers render in ECMAScript form, which
  // is the JCS rendering the Go SDK uses — the strings match byte for byte.
  const fmtBound = (v: number, excl: boolean): string => (excl ? `exclusive ${v}` : `${v}`);

  if (isInput) {
    if (tgtHasLo && candHasLo) {
      if (!lowerBoundLessOrEqual(candLo, candLoExcl, tgtLo, tgtLoExcl)) {
        return fail(`minimum: candidate minimum ${fmtBound(candLo, candLoExcl)} is greater than target minimum ${fmtBound(tgtLo, tgtLoExcl)}`);
      }
    }
    if (tgtHasHi && candHasHi) {
      if (!upperBoundGreaterOrEqual(candHi, candHiExcl, tgtHi, tgtHiExcl)) {
        return fail(`maximum: candidate maximum ${fmtBound(candHi, candHiExcl)} is less than target maximum ${fmtBound(tgtHi, tgtHiExcl)}`);
      }
    }
  } else {
    if (tgtHasLo) {
      if (!candHasLo) return fail(`minimum: target has minimum ${fmtBound(tgtLo, tgtLoExcl)} but candidate has none`);
      if (!lowerBoundGreaterOrEqual(candLo, candLoExcl, tgtLo, tgtLoExcl)) {
        return fail(`minimum: candidate minimum ${fmtBound(candLo, candLoExcl)} is less than target minimum ${fmtBound(tgtLo, tgtLoExcl)}`);
      }
    }
    if (tgtHasHi) {
      if (!candHasHi) return fail(`maximum: target has maximum ${fmtBound(tgtHi, tgtHiExcl)} but candidate has none`);
      if (!upperBoundLessOrEqual(candHi, candHiExcl, tgtHi, tgtHiExcl)) {
        return fail(`maximum: candidate maximum ${fmtBound(candHi, candHiExcl)} is greater than target maximum ${fmtBound(tgtHi, tgtHiExcl)}`);
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
      if (!(minKey in cand)) return fail(`${minKey}: target has ${minKey} ${toFloat64(tgt[minKey])} but candidate has none`);
      if (toFloat64(cand[minKey]) < toFloat64(tgt[minKey])) {
        return fail(`${minKey}: candidate ${minKey} ${toFloat64(cand[minKey])} is less than target ${minKey} ${toFloat64(tgt[minKey])}`);
      }
    }
    if (maxKey in tgt) {
      if (!(maxKey in cand)) return fail(`${maxKey}: target has ${maxKey} ${toFloat64(tgt[maxKey])} but candidate has none`);
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
