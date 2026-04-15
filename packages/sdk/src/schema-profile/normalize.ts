import canonicalize from "canonicalize";
import { OutsideProfileError, RefError, SchemaError } from "./errors.js";
import { inputCompatible, outputCompatible } from "./compat.js";
import type { CompatResult } from "./compat.js";
import type { JSONValue, JSONObject } from "./helpers.js";
import { asMap, asSlice, canonicalKey, pathOrRoot, ptrJoin, toFloat64 } from "./helpers.js";


export interface Fetcher {
  fetch(url: URL): Promise<Uint8Array | string>;
}

const IN_SCOPE_KEYWORDS = new Set([
  "$ref", "$defs", "allOf",
  "type", "enum", "const",
  "properties", "required", "additionalProperties",
  "items", "oneOf", "anyOf",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "minItems", "maxItems",
]);

const ANNOTATION_KEYWORDS = new Set([
  "title", "description", "examples", "default",
  "deprecated", "readOnly", "writeOnly", "$schema",
  // OpenAPI-originated keywords that are semantically annotations for
  // compatibility purposes. `format` is a validation hint, not structural.
  // `discriminator` is tooling guidance for union disambiguation.
  // `nullable` is handled structurally (converted to type union) before
  // this set is checked — but listed here so stray occurrences (e.g.
  // nullable without a type) are stripped rather than rejected.
  "format", "discriminator", "nullable",
]);

/** Normalizes JSON Schema documents within the OBI profile, resolving refs and flattening allOf. */
export class Normalizer {
  readonly root: JSONValue;
  readonly base?: URL;
  readonly fetcher?: Fetcher;

  private refStack = new Set<string>();

  constructor(opts?: { root?: JSONValue; base?: URL; fetcher?: Fetcher }) {
    this.root = opts?.root;
    this.base = opts?.base;
    this.fetcher = opts?.fetcher;
  }

  /** Normalizes a schema by resolving refs, flattening allOf, and sorting deterministically. */
  async normalize(schema: JSONObject): Promise<JSONObject> {
    this.refStack = new Set();
    return this.normalizeAt(schema, "");
  }

  /** Normalizes both schemas and checks input compatibility (candidate accepts at least what target accepts). */
  async inputCompatible(target: JSONObject, candidate: JSONObject): Promise<CompatResult> {
    this.refStack = new Set();
    const tn = await this.normalizeAt(target, "");
    this.refStack = new Set();
    const cn = await this.normalizeAt(candidate, "");
    return inputCompatible(tn, cn);
  }

  /** Normalizes both schemas and checks output compatibility (candidate only produces values target allows). */
  async outputCompatible(target: JSONObject, candidate: JSONObject): Promise<CompatResult> {
    this.refStack = new Set();
    const tn = await this.normalizeAt(target, "");
    this.refStack = new Set();
    const cn = await this.normalizeAt(candidate, "");
    return outputCompatible(tn, cn);
  }

  private async normalizeAt(schema: JSONObject | null | undefined, path: string): Promise<JSONObject> {
    if (!schema || Object.keys(schema).length === 0) return {};

    // Convert OpenAPI 3.0 `nullable: true` to a type union before the
    // profile keyword check. This is structural (affects compatibility)
    // so it must happen before annotations are stripped.
    schema = applyNullable(schema);

    assertProfileKeywords(schema, path);

    const ref = schema["$ref"];
    if (typeof ref === "string" && ref.trim()) {
      const { value, cleanup } = await this.resolveRef(ref, path);
      try {
        const rm = asMap(value);
        if (!rm) throw new RefError(path, ref, "resolved $ref is not an object");
        return this.normalizeAt(rm, path);
      } finally {
        cleanup();
      }
    }

    const out: JSONObject = {};
    for (const [k, v] of Object.entries(schema)) {
      if (ANNOTATION_KEYWORDS.has(k) || k === "$defs" || k.startsWith("x-")) continue;
      out[k] = v;
    }

    if ("allOf" in out) {
      const merged = await this.flattenAllOf(out["allOf"], path);
      return this.normalizeAt(merged, path);
    }

    if ("type" in out) {
      out["type"] = normalizeType(out["type"], path);
    }

    if ("required" in out) {
      out["required"] = normalizeStringSet(out["required"], path);
    }

    if ("properties" in out) {
      const props = asMap(out["properties"]);
      if (!props) throw new Error(`${pathOrRoot(path)}.properties: must be object`);
      const nm: JSONObject = {};
      for (const [k, v] of Object.entries(props)) {
        const vm = asMap(v);
        if (!vm) throw new Error(`${pathOrRoot(path)}.properties["${k}"]: must be object`);
        nm[k] = await this.normalizeAt(vm, ptrJoin(path, `properties["${k}"]`));
      }
      out["properties"] = nm;
    }

    if ("additionalProperties" in out) {
      const ap = out["additionalProperties"];
      if (typeof ap === "boolean") {
        out["additionalProperties"] = ap;
      } else {
        const apm = asMap(ap);
        if (!apm) throw new Error(`${pathOrRoot(path)}.additionalProperties: must be boolean or object`);
        out["additionalProperties"] = await this.normalizeAt(apm, ptrJoin(path, "additionalProperties"));
      }
    }

    if ("items" in out) {
      const im = asMap(out["items"]);
      if (!im) throw new Error(`${pathOrRoot(path)}.items: must be object`);
      out["items"] = await this.normalizeAt(im, ptrJoin(path, "items"));
    }

    for (const k of ["oneOf", "anyOf"] as const) {
      if (!(k in out)) continue;
      const arr = asSlice(out[k]);
      if (!arr) throw new Error(`${pathOrRoot(path)}.${k}: must be array`);
      const variants: JSONObject[] = [];
      for (let i = 0; i < arr.length; i++) {
        const m = asMap(arr[i]);
        if (!m) throw new Error(`${pathOrRoot(path)}.${k}[${i}]: must be object`);
        variants.push(await this.normalizeAt(m, ptrJoin(path, `${k}[${i}]`)));
      }
      const scored = variants.map((v) => ({
        canon: canonicalize(v) ?? "",
        v,
      }));
      scored.sort((a, b) => (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0));
      out[k] = scored.map((s) => s.v);
    }

    return out;
  }

  private async resolveRef(
    ref: string,
    path: string,
  ): Promise<{ value: JSONValue; cleanup: () => void }> {
    let u: URL;
    try {
      u = new URL(ref, this.base ?? "resolve://local/");
    } catch (e: unknown) {
      throw new RefError(pathOrRoot(path), ref, e instanceof Error ? e : String(e));
    }

    const isFragmentOnly = ref.startsWith("#") || u.protocol === "resolve:";
    const key = isFragmentOnly ? `#${u.hash.slice(1) || ""}` : u.href;

    if (this.refStack.has(key)) {
      throw new RefError(pathOrRoot(path), ref, "cycle detected");
    }

    this.refStack.add(key);
    const cleanup = () => this.refStack.delete(key);

    let doc: JSONValue;
    if (isFragmentOnly) {
      doc = this.root;
    } else {
      if (!this.fetcher) {
        cleanup();
        throw new RefError(pathOrRoot(path), ref, "external $ref unsupported (no fetcher)");
      }
      try {
        const raw = await this.fetcher.fetch(u);
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        doc = JSON.parse(text);
      } catch (e: unknown) {
        cleanup();
        throw new RefError(pathOrRoot(path), ref, e instanceof Error ? e : String(e));
      }
    }

    const fragment = u.hash ? u.hash.slice(1) : (ref.startsWith("#") ? ref.slice(1) : "");
    const value = resolveJSONPointer(doc, fragment, ref, path);
    return { value, cleanup };
  }

  private async flattenAllOf(allOf: JSONValue, path: string): Promise<JSONObject> {
    const arr = asSlice(allOf);
    if (!arr) throw new Error(`${pathOrRoot(path)}.allOf: must be array`);
    if (arr.length === 0) return {};

    const merged: JSONObject = {};
    for (let i = 0; i < arr.length; i++) {
      let branch = asMap(arr[i]);
      if (!branch) throw new Error(`${pathOrRoot(path)}.allOf[${i}]: must be object`);

      const branchPath = ptrJoin(path, `allOf[${i}]`);
      branch = applyNullable(branch);
      assertProfileKeywords(branch, branchPath);

      if ("oneOf" in branch) throw new OutsideProfileError(branchPath, "oneOf inside allOf");
      if ("anyOf" in branch) throw new OutsideProfileError(branchPath, "anyOf inside allOf");

      const ref = branch["$ref"];
      if (typeof ref === "string" && ref.trim()) {
        const { value, cleanup } = await this.resolveRef(ref, branchPath);
        cleanup();
        const rm = asMap(value);
        if (!rm) throw new RefError(branchPath, ref, "resolved $ref is not an object");
        branch = rm;
      }

      mergeAllOfBranch(merged, branch, branchPath);
    }

    return merged;
  }
}

// -- Private helpers --

function assertProfileKeywords(schema: JSONObject, path: string): void {
  for (const k of Object.keys(schema)) {
    if (IN_SCOPE_KEYWORDS.has(k) || ANNOTATION_KEYWORDS.has(k) || k.startsWith("x-")) continue;
    throw new OutsideProfileError(pathOrRoot(path), k);
  }
}

/**
 * Converts OpenAPI 3.0 `nullable: true` to a JSON Schema type union.
 * `{ "type": "string", "nullable": true }` becomes `{ "type": ["null", "string"] }`.
 * If `type` is already an array containing "null", this is a no-op.
 * If `nullable` is absent or false, returns the schema unchanged.
 */
function applyNullable(schema: JSONObject): JSONObject {
  if (schema["nullable"] !== true) return schema;
  const t = schema["type"];
  if (t === undefined) return schema;
  // Clone to avoid mutating the input
  const out = { ...schema };
  delete out["nullable"];
  if (typeof t === "string") {
    out["type"] = t === "null" ? ["null"] : ["null", t];
  } else if (Array.isArray(t)) {
    if (!t.includes("null")) {
      out["type"] = ["null", ...t];
    }
  }
  return out;
}

function normalizeType(v: JSONValue, path: string): unknown[] {
  if (typeof v === "string") {
    if (!v.trim()) throw new Error(`${pathOrRoot(path)}.type: must not be empty`);
    return [v];
  }
  if (Array.isArray(v)) {
    const set = new Set<string>();
    for (const it of v) {
      if (typeof it !== "string" || !it.trim()) {
        throw new Error(`${pathOrRoot(path)}.type: must be array of non-empty strings`);
      }
      set.add(it);
    }
    return [...set].sort();
  }
  throw new Error(`${pathOrRoot(path)}.type: must be string or array of strings`);
}

function normalizeStringSet(v: JSONValue, path: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${pathOrRoot(path)}.required: must be array`);
  const set = new Set<string>();
  for (const it of v) {
    if (typeof it !== "string" || !it.trim()) {
      throw new Error(`${pathOrRoot(path)}.required: must contain only non-empty strings`);
    }
    set.add(it);
  }
  return [...set].sort();
}

function resolveJSONPointer(doc: JSONValue, fragment: string, ref: string, path: string): JSONValue {
  if (!fragment) return doc;
  if (!fragment.startsWith("/")) {
    throw new RefError(pathOrRoot(path), ref, "unsupported fragment (must be JSON Pointer)");
  }
  const toks = fragment.split("/").slice(1);
  let cur: JSONValue = doc;
  for (const rawTok of toks) {
    const tok = rawTok.replaceAll("~1", "/").replaceAll("~0", "~");
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      const obj = cur as JSONObject;
      if (!(tok in obj)) throw new RefError(pathOrRoot(path), ref, `pointer not found: "${tok}"`);
      cur = obj[tok];
    } else if (Array.isArray(cur)) {
      const idx = parseInt(tok, 10);
      if (isNaN(idx) || idx < 0 || idx >= cur.length) {
        throw new RefError(pathOrRoot(path), ref, `array index out of range: "${tok}"`);
      }
      cur = cur[idx];
    } else {
      throw new RefError(pathOrRoot(path), ref, "pointer traversed non-container");
    }
  }
  return cur;
}

function mergeAllOfBranch(acc: JSONObject, branch: JSONObject, path: string): void {
  if ("type" in branch) {
    const bTypes = normalizeType(branch["type"], path);
    if ("type" in acc) {
      const aTypes = normalizeType(acc["type"], path);
      const inter = intersectTypeSlices(aTypes as string[], bTypes as string[]);
      if (inter.length === 0) throw new SchemaError(path, "allOf type intersection is empty");
      acc["type"] = inter;
    } else {
      acc["type"] = bTypes;
    }
  }

  if ("properties" in branch) {
    const bProps = asMap(branch["properties"]);
    if (!bProps) throw new Error(`${path}.properties: must be object`);
    let aProps = asMap(acc["properties"]);
    if (!aProps) aProps = {};
    for (const [k, bv] of Object.entries(bProps)) {
      if (k in aProps) {
        const avm = asMap(aProps[k]) ?? {};
        const bvm = asMap(bv) ?? {};
        const merged = { ...avm };
        mergeAllOfBranch(merged, bvm, `${path}.properties["${k}"]`);
        aProps[k] = merged;
      } else {
        aProps[k] = bv;
      }
    }
    acc["properties"] = aProps;
  }

  if ("required" in branch) {
    const bReq = normalizeStringSet(branch["required"], path);
    if ("required" in acc) {
      const aReq = normalizeStringSet(acc["required"], path);
      acc["required"] = unionStrings(aReq, bReq);
    } else {
      acc["required"] = bReq;
    }
  }

  if ("additionalProperties" in branch) {
    const bap = branch["additionalProperties"];
    if (typeof bap === "boolean") {
      if (!bap) {
        acc["additionalProperties"] = false;
      } else if (!("additionalProperties" in acc)) {
        acc["additionalProperties"] = true;
      }
    } else if (typeof bap === "object" && bap !== null) {
      const bvm = bap as JSONObject;
      if ("additionalProperties" in acc) {
        const aap = acc["additionalProperties"];
        if (typeof aap === "boolean") {
          if (aap) acc["additionalProperties"] = bvm;
        } else if (typeof aap === "object" && aap !== null) {
          const merged = { ...(aap as JSONObject) };
          mergeAllOfBranch(merged, bvm, `${path}.additionalProperties`);
          acc["additionalProperties"] = merged;
        }
      } else {
        acc["additionalProperties"] = bvm;
      }
    }
  }

  if ("enum" in branch) {
    const bEnum = asSlice(branch["enum"]);
    if (!bEnum) throw new Error(`${path}.enum: must be array`);
    if ("enum" in acc) {
      const aEnum = asSlice(acc["enum"]) ?? [];
      const inter = intersectValues(aEnum, bEnum);
      if (inter.length === 0) throw new SchemaError(path, "allOf enum intersection is empty");
      acc["enum"] = inter;
    } else {
      acc["enum"] = bEnum;
    }
  }

  if ("const" in branch) {
    if ("const" in acc) {
      if (canonicalKey(acc["const"]) !== canonicalKey(branch["const"])) {
        throw new SchemaError(path, "allOf const conflict");
      }
    } else {
      acc["const"] = branch["const"];
    }
  }

  if ("items" in branch) {
    const bItems = asMap(branch["items"]);
    if (!bItems) throw new Error(`${path}.items: must be object`);
    if ("items" in acc) {
      const aItems = asMap(acc["items"]) ?? {};
      const merged = { ...aItems };
      mergeAllOfBranch(merged, bItems, `${path}.items`);
      acc["items"] = merged;
    } else {
      acc["items"] = bItems;
    }
  }

  for (const k of ["minimum", "exclusiveMinimum", "minLength", "minItems"]) {
    if (k in branch) {
      const bf = toFloat64(branch[k]);
      if (k in acc) {
        if (bf > toFloat64(acc[k])) acc[k] = branch[k];
      } else {
        acc[k] = branch[k];
      }
    }
  }
  for (const k of ["maximum", "exclusiveMaximum", "maxLength", "maxItems"]) {
    if (k in branch) {
      const bf = toFloat64(branch[k]);
      if (k in acc) {
        if (bf < toFloat64(acc[k])) acc[k] = branch[k];
      } else {
        acc[k] = branch[k];
      }
    }
  }
}

function intersectTypeSlices(a: string[], b: string[]): string[] {
  const aSet = new Set(a);
  const bSet = new Set(b);
  const result = new Set<string>();

  for (const s of aSet) {
    if (s === "number" || s === "integer") continue;
    if (bSet.has(s)) result.add(s);
  }

  const aNum = aSet.has("number");
  const bNum = bSet.has("number");
  const aInt = aSet.has("integer");
  const bInt = bSet.has("integer");

  if ((aNum || aInt) && (bNum || bInt)) {
    result.add(aNum && bNum ? "number" : "integer");
  }

  return [...result].sort();
}

function unionStrings(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function intersectValues(a: unknown[], b: unknown[]): unknown[] {
  const bKeys = new Set(b.map(canonicalKey));
  return a.filter((v) => bKeys.has(canonicalKey(v)));
}
