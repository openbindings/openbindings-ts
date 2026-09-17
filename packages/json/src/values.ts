/** Protocol-neutral retained storage. The logical domain is still JSON.
 *
 * @deprecated The `/values` entry is retired by the value-api-shape loop. It
 * keeps working until Block 8 deletes it. Replacements: `retainFrom` is
 * `external` and `retainedValueAccess` is `access` in `@openbindings/json/advanced`;
 * `bytesValue`, `base64` and `encodedString` are `base64` and `encoded` at the
 * root; `parseRetainedJSON` is `parse`; a `RetainedValue` handle is plain data
 * (property access, `String()`, `Encoded.bytes()`, `stringify`); `ValueSize`,
 * `ValueCosts` and `ValueLimits` are `Size`, `Costs` and `Limits`. */
import isRawJSON from "core-js-pure/actual/json/is-raw-json.js";
import stringify from "core-js-pure/actual/json/stringify.js";
import { JSONNumber, isJSONNumber, numberToken, type JSONValue } from "./index.js";
import { parseExact } from "./parse.js";

/** @deprecated Use `ValueKind` from `@openbindings/json/advanced`. */
export type ValueKind = "null" | "boolean" | "number" | "string" | "array" | "object";
/** @deprecated Use `ForcingReason` from `@openbindings/json`. */
export type StringForcingReason = "export" | "string-operation" | "schema-constraint" | "diagnostic" | "compatibility-executor" | "persistence" | "transport";
/** @deprecated Use `Limits` from `@openbindings/json`. */
export interface ValueLimits { maxDepth?: number; maxNodes?: number; maxBytes?: number }
/** Logical occurrence counts used for admission/queue budgets, not process RSS.
 * Repeated immutable subtrees count at each occurrence, conservatively.
 * @deprecated Use `Size` and `sizeOf` from `@openbindings/json/advanced`. */
export interface ValueSize { readonly nodes: number; readonly scalarBytes: number; readonly nativeBytes: number }
/** @deprecated Use `Costs` from `@openbindings/json` and `counters()` from `@openbindings/json/advanced`. */
export interface ValueCosts {
  readonly nodesRead: number;
  readonly bytesCopied: number;
  readonly base64Encodes: number;
  readonly bytesEncoded: number;
  readonly jsonSerializations: number;
  readonly stringForcingBytes: Readonly<Record<StringForcingReason,number>>;
}
/** Trusted host adapter, supplied explicitly. Never read one from a document.
 * String length means Unicode code points; byte-backed Base64 is ASCII.
 * @deprecated Use `ValueAccess` from `@openbindings/json/advanced` (without the legacy Base64-only trio). */
export interface ValueAccess<T> {
  readonly version: 1;
  kind(value: T): ValueKind;
  get(value: T, key: string | number): T | undefined;
  keys(value: T): readonly string[];
  length(value: T): number | undefined;
  numberToken(value: T): string | undefined;
  scalar(value: T, reason?: StringForcingReason): null | boolean | string | undefined;
  /** Legacy native capability: canonical Base64 representation only. */
  byteLength?(value: T): number | undefined;
  /** Optional trusted storage capability; negotiated as an own data property. */
  deferredString?(value: T): DeferredStringStorage | undefined;
  bytes?(value: T): Uint8Array | undefined;
  /** Optional trusted capability, negotiated only as an own data property.
   * Copy into the receiver's exact-size destination; never retain or expose it.
   * Return the written length (including zero), or undefined for non-byte values.
   * The component executing the physical copy charges it exactly once. */
  copyBytesInto?(value: T, destination: Uint8Array): number | undefined;
}

/** An explicitly supplied, deterministic byte-to-string projection. Callbacks
 * receive disposable copies and must not capture data roots or mutable state.
 * @deprecated Use `Encoding` from `@openbindings/json`. */
export interface StringEncoding {
  readonly length: (bytes: Uint8Array) => number;
  readonly encode: (bytes: Uint8Array) => string;
}
/** Optional owned-storage bridge for a logical string, never a seventh JSON kind.
 * Length is in Unicode code points. The receiver reserves four bytes per point
 * plus native storage before copying. Only encode is retained after capture.
 * The copier must not retain the destination. encode must be deterministic,
 * independent of its receiver, and safe for concurrent use in other runtimes.
 * @deprecated Use `DeferredStringStorage` from `@openbindings/json/advanced`. */
export interface DeferredStringStorage {
  readonly byteLength: number;
  readonly length: number;
  readonly encode: (bytes: Uint8Array) => string;
  copyBytesInto(destination: Uint8Array): number;
}

/** @deprecated A value is plain data: property access, `String()`, `Encoded.bytes()` and `stringify` replace the handle. */
export interface RetainedValue {
  readonly kind: ValueKind;
  readonly length: number | undefined;
  /** Legacy canonical Base64 backing only; use native() for general native data. */
  readonly byteLength: number | undefined;
  readonly costs: ValueCosts;
  readonly borrowed: boolean;
  size(): ValueSize;
  get(key: string | number): RetainedValue | undefined;
  keys(): readonly string[];
  numberToken(): string | undefined;
  scalar(reason?: StringForcingReason): null | boolean | string | number | JSONNumber | undefined;
  /** Legacy canonical Base64 bytes only. */
  bytes(): Uint8Array | undefined;
  native(): unknown;
  json(reason?: StringForcingReason): JSONValue;
  text(space?: number | string, reason?: StringForcingReason): string;
  snapshot(): RetainedValue;
  dispose(): void;
}

type Node =
  | { kind: "null" | "boolean" | "number" | "string"; value: null | boolean | number | JSONNumber | string; borrowed: false }
  | { kind: "string"; bytes: Uint8Array; borrowed: boolean; encoding?: {length: number; encode: (bytes: Uint8Array) => string} }
  | { kind: "array"; items: readonly Node[]; borrowed: boolean }
  | { kind: "object"; members: ReadonlyMap<string, Node>; borrowed: boolean };
type Costs = { -readonly [K in Exclude<keyof ValueCosts,"stringForcingBytes">]: ValueCosts[K] } & {stringForcingBytes:Record<StringForcingReason,number>};
interface State { node: Node | undefined; costs: Costs }
const handles = new WeakMap<object, State>();
const handleKey = Symbol("retained-value-construction");
const sizes = new WeakMap<Node,ValueSize>();
const counters = (): Costs => ({nodesRead:0,bytesCopied:0,base64Encodes:0,bytesEncoded:0,jsonSerializations:0,
  stringForcingBytes:{export:0,"string-operation":0,"schema-constraint":0,diagnostic:0,"compatibility-executor":0,persistence:0,transport:0}});
const defaultLimits = {maxDepth:512,maxNodes:1_000_000,maxBytes:64*1024*1024};

function budget(options: ValueLimits = {}) {
  const limits = {...defaultLimits,...options};
  for (const n of Object.values(limits)) if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("Value limits must be positive safe integers");
  let nodes = 0, bytes = 0;
  return {
    visit(depth: number, size = 0) {
      if (depth > limits.maxDepth || ++nodes > limits.maxNodes || (bytes += size) > limits.maxBytes) throw new RangeError("Retained value budget exceeded");
    },
    size(size: number) { if ((bytes += size) > limits.maxBytes) throw new RangeError("Retained value byte budget exceeded"); },
    count(size: number) { if (size > limits.maxNodes - nodes) throw new RangeError("Retained value node budget exceeded"); },
  };
}

const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
/* eslint-disable @typescript-eslint/unbound-method -- These intrinsic getters are intentionally captured and always invoked with .call(receiver). */
const typedBuffer = Object.getOwnPropertyDescriptor(typed,"buffer")!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typed,"byteOffset")!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typed,"byteLength")!.get!;
const typedName = Object.getOwnPropertyDescriptor(typed,Symbol.toStringTag)!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!;
const setBytes = Uint8Array.prototype.set;
/* eslint-enable @typescript-eslint/unbound-method */
function byteView(bytes: Uint8Array): Uint8Array {
  if (typedName.call(bytes) !== "Uint8Array") throw new TypeError("Expected Uint8Array storage");
  // Intrinsic access avoids subclass getters, iterators and species hooks.
  const buffer = typedBuffer.call(bytes) as ArrayBuffer;
  try { bufferLength.call(buffer); } catch { throw new TypeError("Shared or invalid byte storage is not admitted"); }
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with the verified buffer receiver below.
  const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"resizable")?.get;
  if (resizable?.call(buffer)) throw new TypeError("Resizable byte storage is not admitted");
  return new Uint8Array(buffer,typedOffset.call(bytes) as number,typedLength.call(bytes) as number);
}
function copyBytes(bytes: Uint8Array, costs: Costs): Uint8Array {
  const source = byteView(bytes), result = new Uint8Array(source.byteLength);
  result.set(source); costs.bytesCopied += result.byteLength;
  return result;
}

function encode(bytes: Uint8Array, costs: Costs, reason: StringForcingReason): string {
  bytes=byteView(bytes);
  if (!Object.hasOwn(costs.stringForcingBytes,reason)) throw new TypeError("Unknown string forcing reason");
  costs.base64Encodes++; costs.bytesEncoded += bytes.byteLength;
  costs.stringForcingBytes[reason] += bytes.byteLength;
  const chunks: string[] = [];
  // Chunk boundaries are multiples of three, so padding occurs only at the end.
  for (let offset=0;offset<bytes.length;offset+=12288) {
    let binary = "";
    for (let i=offset;i<Math.min(offset+12288,bytes.length);i++) binary += String.fromCharCode(bytes[i]!);
    chunks.push(btoa(binary));
  }
  return chunks.join("");
}

function encodedSize(byteLength: number, length: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(byteLength+length*4)) throw new TypeError("Invalid deferred string size");
  return byteLength+length*4;
}
function logicalString(node: Extract<Node,{bytes: Uint8Array}>, costs: Costs, reason: StringForcingReason): string {
  if (!node.encoding) return encode(node.bytes,costs,reason);
  if (!Object.hasOwn(costs.stringForcingBytes,reason)) throw new TypeError("Unknown string forcing reason");
  const encoder=node.encoding.encode;
  const text=encoder(copyBytes(node.bytes,costs));
  if (typeof text !== "string" || text.length > node.encoding.length*2 || [...text].length !== node.encoding.length) throw new TypeError("Deferred string logical length mismatch");
  costs.stringForcingBytes[reason]+=node.bytes.byteLength;
  return text;
}

function snapshotNode(node: Node, costs: Costs): Node {
  if (!node.borrowed) return node;
  if ("bytes" in node) return {kind:"string",bytes:copyBytes(node.bytes,costs),borrowed:false};
  if (node.kind === "array") return {kind:"array",items:node.items.map(n=>snapshotNode(n,costs)),borrowed:false};
  if (node.kind === "object") return {kind:"object",members:new Map([...node.members].map(([k,n])=>[k,snapshotNode(n,costs)])),borrowed:false};
  return node;
}

function admit(value: unknown, costs: Costs, limits: ReturnType<typeof budget>, active: Set<object>, depth: number): Node {
  limits.visit(depth);
  const retained = typeof value === "object" && value !== null ? handles.get(value) : undefined;
  if (retained) { const node=requireNode(retained); account(node,limits,depth); return snapshotNode(node,costs); }
  if (value === null) return {kind:"null",value:null,borrowed:false};
  if (typeof value === "boolean") return {kind:"boolean",value,borrowed:false};
  const token = numberToken(value);
  if (token !== undefined) { limits.size(token.length*2); return {kind:"number",value:value as number | JSONNumber,borrowed:false}; }
  if (isRawJSON(value)) throw new TypeError("Unsupported nonnumeric RawJSON carrier");
  if (typeof value === "string") { limits.size(value.length*2); return {kind:"string",value,borrowed:false}; }
  if (typeof value !== "object" || active.has(value)) throw new TypeError("Not an admitted JSON value");
  const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError("Host objects require an explicit value projection");
  active.add(value);
  try {
    if (array) {
      limits.count(value.length);
      for (const key of Reflect.ownKeys(value)) {
        if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw new TypeError("Not a JSON array member");
      }
      const items: Node[] = [];
      for (let i=0;i<value.length;i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value,String(i));
        if (!descriptor || !("value" in descriptor)) throw new TypeError("Not a JSON array element");
        items.push(admit(descriptor.value,costs,limits,active,depth+1));
      }
      return {kind:"array",items,borrowed:false};
    }
    const members = new Map<string,Node>(), keys = Reflect.ownKeys(value);
    limits.count(keys.length);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value,key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError("Not a JSON object member");
      limits.size(key.length*2);
      members.set(key,admit(descriptor.value,costs,limits,active,depth+1));
    }
    return {kind:"object",members,borrowed:false};
  } finally { active.delete(value); }
}

// The root was already charged by admission. Reusing a handle cannot bypass
// the new caller's depth/cardinality/byte budget.
function account(node: Node, limits: ReturnType<typeof budget>, depth: number): void {
  if ("bytes" in node) { limits.size(node.encoding ? encodedSize(byteView(node.bytes).byteLength,node.encoding.length) : byteView(node.bytes).byteLength); return; }
  if ("value" in node) {
    limits.size(typeof node.value === "string" ? node.value.length*2 : node.kind === "number" ? numberToken(node.value)!.length*2 : 0); return;
  }
  const children = node.kind === "array" ? node.items : [...node.members.values()];
  limits.count(children.length);
  if (node.kind === "object") for (const key of node.members.keys()) limits.size(key.length*2);
  for (const child of children) { limits.visit(depth+1); account(child,limits,depth+1); }
}

function requireNode(state: State): Node {
  if (!state.node) throw new Error("Retained value is disposed");
  state.costs.nodesRead++;
  return state.node;
}
function measure(node: Node, costs: Costs): ValueSize {
  const cached = !node.borrowed && sizes.get(node);
  if (cached) return cached;
  costs.nodesRead++;
  let nodes=1, scalarBytes=0, nativeBytes=0;
  if ("bytes" in node) { nativeBytes=byteView(node.bytes).byteLength; scalarBytes=node.encoding ? encodedSize(nativeBytes,node.encoding.length) : nativeBytes; }
  else if ("value" in node) scalarBytes=typeof node.value === "string" ? node.value.length*2 : node.kind === "number" ? numberToken(node.value)!.length*2 : 0;
  else {
    const children=node.kind === "array" ? node.items : [...node.members.values()];
    if (node.kind === "object") for (const key of node.members.keys()) scalarBytes+=key.length*2;
    for (const child of children) { const size=measure(child,costs); nodes+=size.nodes;scalarBytes+=size.scalarBytes;nativeBytes+=size.nativeBytes; }
  }
  const size=Object.freeze({nodes,scalarBytes,nativeBytes});
  if (!node.borrowed) sizes.set(node,size);
  return size;
}
function scalar(node: Node, costs: Costs, reason: StringForcingReason): null | boolean | string | number | JSONNumber | undefined {
  return "bytes" in node ? logicalString(node,costs,reason) : "value" in node ? node.value : undefined;
}
function materialize(node: Node, costs: Costs, projection: "native" | "json" | "text", reason: StringForcingReason): unknown {
  costs.nodesRead++;
  if ("bytes" in node) return projection === "native" ? copyBytes(node.bytes,costs) : logicalString(node,costs,reason);
  // Numeric carriers are already authenticated, immutable RawJSON without hooks.
  if ("value" in node) return node.value;
  if (node.kind === "array") {
    if (projection !== "text") return node.items.map(n=>materialize(n,costs,projection,reason));
    const result: unknown[]=[];Object.setPrototypeOf(result,null);
    for (let i=0;i<node.items.length;i++) result[i]=materialize(node.items[i]!,costs,projection,reason);
    return result;
  }
  // Assign into a fresh dictionary so inherited setters and __proto__ cannot
  // run. Restore the ordinary object prototype only after all own data exists.
  const result = Object.create(null) as Record<string,unknown>;
  for (const [key,value] of node.members) result[key]=materialize(value,costs,projection,reason);
  return projection === "text" ? result : Object.setPrototypeOf(result,Object.prototype);
}

class Handle implements RetainedValue {
  constructor(node: Node, costs: Costs, key: symbol) {
    if (key !== handleKey) throw new TypeError("Use a retained value factory");
    handles.set(this,{node,costs}); Object.freeze(this);
  }
  #state(): State { return handles.get(this)!; }
  get kind(): ValueKind { return requireNode(this.#state()).kind; }
  get borrowed(): boolean { return requireNode(this.#state()).borrowed; }
  size(): ValueSize { const s=this.#state(); return measure(requireNode(s),s.costs); }
  get costs(): ValueCosts { const c=this.#state().costs; return Object.freeze({...c,stringForcingBytes:Object.freeze({...c.stringForcingBytes})}); }
  get byteLength(): number | undefined { const n=requireNode(this.#state()); return "bytes" in n && !n.encoding ? byteView(n.bytes).byteLength : undefined; }
  get length(): number | undefined {
    const n=requireNode(this.#state());
    if ("bytes" in n) return n.encoding?.length ?? Math.ceil(byteView(n.bytes).byteLength/3)*4;
    return n.kind === "array" ? n.items.length : n.kind === "string" && "value" in n ? [...n.value as string].length : undefined;
  }
  get(key: string | number): RetainedValue | undefined {
    const s=this.#state(), n=requireNode(s);
    const child = n.kind === "object" && typeof key === "string" ? n.members.get(key)
      : n.kind === "array" && typeof key === "number" && Number.isSafeInteger(key) && key >= 0 ? n.items[key] : undefined;
    return child === undefined ? undefined : new Handle(child,s.costs,handleKey);
  }
  keys(): readonly string[] { const n=requireNode(this.#state()); return n.kind === "object" ? [...n.members.keys()] : []; }
  numberToken(): string | undefined { const n=requireNode(this.#state()); return n.kind === "number" && "value" in n ? numberToken(n.value) : undefined; }
  scalar(reason: StringForcingReason = "string-operation"): null | boolean | string | number | JSONNumber | undefined { const s=this.#state(); return scalar(requireNode(s),s.costs,reason); }
  bytes(): Uint8Array | undefined { const s=this.#state(), n=requireNode(s); return "bytes" in n && !n.encoding ? copyBytes(n.bytes,s.costs) : undefined; }
  native(): unknown { const s=this.#state(); return materialize(requireNode(s),s.costs,"native","export"); }
  json(reason: StringForcingReason = "export"): JSONValue { const s=this.#state(); return materialize(requireNode(s),s.costs,"json",reason) as JSONValue; }
  text(space?: number | string, reason: StringForcingReason = "export"): string {
    const s=this.#state(), node=requireNode(s);s.costs.jsonSerializations++;
    // Only authenticated nodes enter this path. Arbitrary objects still use
    // stringifyJSON's descriptor-checked admission. No public trust flag exists.
    return stringify(materialize(node,s.costs,"text",reason),undefined,space)!;
  }
  snapshot(): RetainedValue { const s=this.#state(); return new Handle(snapshotNode(requireNode(s),s.costs),s.costs,handleKey); }
  dispose(): void { this.#state().node=undefined; }
  toJSON(): never { throw new TypeError("Use retainedValue.json() or retainedValue.text() explicitly"); }
}

/** Own the supplied JSON data. Existing immutable retained subtrees can be shared.
 * @deprecated A `Value` is already usable; nothing needs retaining. */
export function retain(value: unknown, options?: ValueLimits): RetainedValue {
  const costs=counters(); return new Handle(admit(value,costs,budget(options),new Set(),0),costs,handleKey);
}
/** Parse wire JSON directly into owned storage during the exact parser's walk.
 * This avoids creating an exposed native view and admitting it a second time.
 * Limits count the final JSON value (duplicate names use the parser's policy).
 * @deprecated Use `parse` from `@openbindings/json`. */
export function parseRetainedJSON(text: string, options?: ValueLimits): RetainedValue {
  const limits=budget(options), costs=counters(), heights=new WeakMap<Node,number>();
  const root=parseExact(text,value=>{
    let node: Node, height=0;
    if (value === null) node={kind:"null",value:null,borrowed:false};
    else if (typeof value === "boolean") node={kind:"boolean",value,borrowed:false};
    else if (typeof value === "string") { limits.size(value.length*2); node={kind:"string",value,borrowed:false}; }
    else {
      const token=numberToken(value);
      if (token !== undefined) { limits.size(token.length*2); node={kind:"number",value:value as number | JSONNumber,borrowed:false}; }
      else if (Array.isArray(value)) {
        const items=value as Node[];
        for (const child of items) height=Math.max(height,1+(heights.get(child) ?? 0));
        node={kind:"array",items,borrowed:false};
      } else {
        const members=new Map<string,Node>();
        for (const [key,child] of Object.entries(value as Record<string,Node>)) {
          limits.size(key.length*2); members.set(key,child); height=Math.max(height,1+(heights.get(child) ?? 0));
        }
        node={kind:"object",members,borrowed:false};
      }
    }
    limits.visit(height); heights.set(node,height); return node;
  }) as Node;
  return new Handle(root,costs,handleKey);
}
/** @deprecated Build a plain object; a `Value` needs no factory. */
export function recordValue(value: Readonly<Record<string,unknown>>, options?: ValueLimits): RetainedValue {
  const result=retain(value,options); if (result.kind !== "object") throw new TypeError("Expected an object value"); return result;
}
/** @deprecated Build a plain array; a `Value` needs no factory. */
export function arrayValue(value: readonly unknown[], options?: ValueLimits): RetainedValue {
  const result=retain(value,options); if (result.kind !== "array") throw new TypeError("Expected an array value"); return result;
}
/** Explicitly project bytes as a logical Base64 string; default ownership copies.
 * @deprecated Use `base64` from `@openbindings/json`. */
export function bytesValue(bytes: Uint8Array, options?: ValueLimits): RetainedValue {
  const source=byteView(bytes), costs=counters();budget(options).visit(0,source.byteLength);
  return new Handle({kind:"string",bytes:copyBytes(source,costs),borrowed:false},costs,handleKey);
}
/** Create a canonical Base64 logical string without encoding it. Owns a copy.
 * @deprecated Use `base64` from `@openbindings/json`, which returns an `Encoded`. */
export const base64 = bytesValue;

/** Own byte storage behind an explicit logical string. No encoding occurs here.
 * Callbacks are trusted host code, not a sandbox. Native bytes and the maximum
 * logical string storage are budgeted; callback temporary allocations are not.
 * @deprecated Use `encoded` from `@openbindings/json`. */
export function encodedString(bytes: Uint8Array, encoding: StringEncoding, options?: ValueLimits): RetainedValue {
  const source=byteView(bytes), costs=counters(), limits=budget(options);
  limits.visit(0,source.byteLength);
  const {length:measure,encode:encoder}=encoding;
  if (typeof measure !== "function" || typeof encoder !== "function") throw new TypeError("Invalid string encoding");
  const owned=copyBytes(source,costs), length=measure(copyBytes(owned,costs));
  encodedSize(owned.byteLength,length); limits.size(length*4);
  return new Handle({kind:"string",bytes:owned,encoding:{length,encode:encoder},borrowed:false},costs,handleKey);
}

/** Caller mutations remain visible; snapshot before assigning an evaluation.
 * @deprecated No public borrow exists on the new surface; `base64` copies. */
export function borrowBytes(bytes: Uint8Array, options?: ValueLimits): RetainedValue {
  const source=byteView(bytes);budget(options).visit(0,source.byteLength);
  return new Handle({kind:"string",bytes:source,borrowed:true},counters(),handleKey);
}
/** Transfer an entire ordinary ArrayBuffer into owned storage without a byte
 * copy. This explicitly detaches ALL caller aliases. Partial/pooled views must
 * use bytesValue instead. Budget checks happen before the ownership side effect.
 * @deprecated Use `base64` from `@openbindings/json`; adoption of a caller buffer is not offered. */
export function transferBytes(bytes: Uint8Array, options?: ValueLimits): RetainedValue {
  const source=byteView(bytes);budget(options).visit(0,source.byteLength);
  if (source.byteOffset !== 0 || source.byteLength !== bufferLength.call(source.buffer)) throw new TypeError("Byte transfer requires the entire buffer; use bytesValue for slices");
  const owned=structuredClone(source.buffer,{transfer:[source.buffer]}) as ArrayBuffer;
  return new Handle({kind:"string",bytes:new Uint8Array(owned),borrowed:false},counters(),handleKey);
}
/** @deprecated Use `isDecimal` and `isEncoded` from `@openbindings/json`. */
export function isRetainedValue(value: unknown): value is RetainedValue {
  return typeof value === "object" && value !== null && handles.has(value);
}

/** @deprecated Use `access` from `@openbindings/json/advanced`. */
export const retainedValueAccess: ValueAccess<RetainedValue> = Object.freeze({
  version:1 as const,
  kind:(v: RetainedValue)=>v.kind,
  get:(v: RetainedValue,k: string | number)=>v.get(k),
  keys:(v: RetainedValue)=>v.keys(),
  length:(v: RetainedValue)=>v.length,
  numberToken:(v: RetainedValue)=>v.numberToken(),
  scalar:(v: RetainedValue,reason?: StringForcingReason)=>{ const n=v.scalar(reason); return typeof n === "number" || isJSONNumber(n) ? undefined : n; },
  byteLength:(v: RetainedValue)=>v.byteLength,
  bytes:(v: RetainedValue)=>v.bytes(),
  deferredString:(v: RetainedValue)=>{
    const state=handles.get(v);
    if (!state) throw new TypeError("Expected an authenticated retained value");
    const node=requireNode(state);
    if (!("bytes" in node) || !node.encoding) return undefined;
    return Object.freeze({byteLength:node.bytes.byteLength,length:node.encoding.length,encode:node.encoding.encode,
      copyBytesInto:(destination: Uint8Array)=>{
        const target=byteView(destination);
        if (target.byteLength !== node.bytes.byteLength) throw new TypeError("Byte destination length mismatch");
        setBytes.call(target,node.bytes);state.costs.bytesCopied+=target.byteLength;return target.byteLength;
      }});
  },
  copyBytesInto:(v: RetainedValue,destination: Uint8Array)=>{
    const state=handles.get(v);
    if (!state) throw new TypeError("Expected an authenticated retained value");
    const node=requireNode(state);
    if (!("bytes" in node) || node.encoding) return undefined;
    const source=byteView(node.bytes), target=byteView(destination);
    if (source.byteLength !== target.byteLength) throw new TypeError("Byte destination length mismatch");
    setBytes.call(target,source);state.costs.bytesCopied+=source.byteLength;
    return source.byteLength;
  },
});

/** Snapshot an explicitly trusted external implementation of the access protocol.
 * @deprecated Use `external` from `@openbindings/json/advanced`. */
export function retainFrom<T>(root: T, access: ValueAccess<T>, options?: ValueLimits): RetainedValue {
  if (access.version !== 1) throw new TypeError("Unsupported value access version");
  const limits=budget(options), costs=counters(), active=new Set<T>();
  // Do not invoke a getter or negotiate through a polluted adapter prototype.
  const copyDescriptor=Object.getOwnPropertyDescriptor(access,"copyBytesInto");
  const copy=copyDescriptor && Object.hasOwn(copyDescriptor,"value") && typeof copyDescriptor.value === "function"
    ? copyDescriptor.value as NonNullable<ValueAccess<T>["copyBytesInto"]> : undefined;
  const storageDescriptor=Object.getOwnPropertyDescriptor(access,"deferredString");
  const storage=storageDescriptor && Object.hasOwn(storageDescriptor,"value") && typeof storageDescriptor.value === "function"
    ? storageDescriptor.value as NonNullable<ValueAccess<T>["deferredString"]> : undefined;
  function visit(value: T, depth: number): Node {
    limits.visit(depth);
    if (active.has(value)) throw new TypeError("Cyclic value access");
    const kind=access.kind(value);
    if (kind === "number") {
      const token=access.numberToken(value);
      if (typeof token !== "string") throw new TypeError("Missing exact number token");
      limits.size(token.length*2); return {kind,value:new JSONNumber(token),borrowed:false};
    }
    if (kind === "string") {
      const deferred=storage?.call(access,value);
      if (deferred !== undefined) {
        const {byteLength,length,encode:encoder}=deferred;
        limits.size(encodedSize(byteLength,length));
        if (typeof encoder !== "function" || typeof deferred.copyBytesInto !== "function" || access.length(value) !== length) throw new TypeError("Invalid deferred string storage");
        const destination=new Uint8Array(byteLength);
        if (deferred.copyBytesInto(destination) !== byteLength || byteView(destination).byteLength !== byteLength) throw new TypeError("Deferred string copy length mismatch");
        return {kind,bytes:destination,encoding:{length,encode:encoder},borrowed:false};
      }
      const length=access.byteLength?.(value);
      if (length !== undefined) {
        if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("Invalid byte length");
        limits.size(length);
        if (copy) {
          if (access.length(value) !== Math.ceil(length/3)*4) throw new TypeError("Byte logical length mismatch");
          const destination=new Uint8Array(length);
          if (copy.call(access,value,destination) !== length) throw new TypeError("Byte copy length mismatch");
          // Revalidate in case an explicit host callback detached the destination.
          if (byteView(destination).byteLength !== length) throw new TypeError("Invalid byte destination");
          return {kind,bytes:destination,borrowed:false};
        }
        const bytes=access.bytes?.(value);
        if (bytes === undefined) throw new TypeError("Missing byte storage");
        const view=byteView(bytes);
        if (view.byteLength !== length) throw new TypeError("Byte storage length mismatch");
        return {kind,bytes:copyBytes(view,costs),borrowed:false};
      }
      // Older independent adapters may expose bytes without byte metadata.
      const bytes=access.bytes?.(value);
      if (bytes !== undefined) { const view=byteView(bytes); limits.size(view.byteLength); return {kind,bytes:copyBytes(view,costs),borrowed:false}; }
    }
    if (kind === "null" || kind === "boolean" || kind === "string") {
      const s=access.scalar(value);
      if (!(kind === "null" ? s === null : typeof s === kind)) throw new TypeError("Value access scalar kind mismatch");
      if (typeof s === "string") limits.size(s.length*2);
      return {kind,value:s as null | boolean | string,borrowed:false};
    }
    if (kind !== "object" && kind !== "array") throw new TypeError("Invalid logical value kind");
    active.add(value);
    try {
      if (kind === "array") {
        const length=access.length(value);
        if (length === undefined || !Number.isSafeInteger(length) || length < 0) throw new TypeError("Invalid array length");
        limits.count(length); const items: Node[]=[];
        for (let i=0;i<length;i++) { const child=access.get(value,i); if (child === undefined) throw new TypeError("Missing array element"); items.push(visit(child,depth+1)); }
        return {kind,items,borrowed:false};
      }
      const keys=access.keys(value), members=new Map<string,Node>();limits.count(keys.length);
      for (const key of keys) {
        if (typeof key !== "string" || members.has(key)) throw new TypeError("Invalid or duplicate object key");
        limits.size(key.length*2);const child=access.get(value,key);if (child === undefined) throw new TypeError("Missing object member");
        members.set(key,visit(child,depth+1));
      }
      return {kind,members,borrowed:false};
    } finally { active.delete(value); }
  }
  return new Handle(visit(root,0),costs,handleKey);
}
