import { InvocationError, type Metadata } from "./invocation.js";
import { ERR_EXECUTION_FAILED, ERR_RESPONSE_ERROR, ERR_RUNTIME } from "./errcodes.js";
import { familyName } from "./helpers.js";
import type { JSONSchema } from "./types.js";

// The consumer hook surface: specification + configuration = complete
// invocation. Where a binding-source format's specification is lacking,
// the gap is made up in CONSUMER CONFIGURATION — these hooks — never by OB
// authoring the missing coverage into a document and never by OBI
// absorbing format conventions. The model is stated in the conventions
// record's completeness-spectrum section (spec/binding-specs/README.md); this
// file mirrors the Go SDK's hooks.go so the two SDKs answer the wire
// questions identically.
//
// Generic SHAPE, protocol-specific HANDLING: one set of signatures serves
// every format; the callback body switches on the site (siteFamilyName,
// operation, target). Hooks are process-local — they never ride documents,
// context, or the wire; each hop of a multi-hop composition configures
// itself.

/**
 * Identifies where a hook is being consulted: which operation, through
 * which binding, against which source's governing binding specification
 * and target. Hook tables key on its string fields.
 *
 * `operation` is the RESOLVED CANONICAL operation key (post-OBI-T-12), so
 * tables keyed on it always fire regardless of the alias the caller used;
 * `invokedAs` carries the caller's name. `target` is the base URL / binary
 * name where known — best-effort on the HTTP lanes.
 */
export interface InvokeSite {
  operation: string;
  invokedAs: string;
  bindingKey: string;
  bindingSpec: string;
  ref: string;
  target: string;
}

/**
 * Bare family name of a site's binding specification
 * ("openbindings.openapi@1" → "openapi"; a pre-promotion draft token like
 * "graphql" passes through), so hook bodies never string-match
 * identifiers. Mirrors the Go SDK's InvokeSite.FamilyName.
 */
export function siteFamilyName(site: InvokeSite): string {
  return familyName(site.bindingSpec);
}

/**
 * ONE DELIVERY UNIT of a completed transport exchange, as the decode and
 * classify hooks see it.
 *
 * `status` is the transport's scalar completion status in the format's own
 * units (HTTP status | exit code | rpc code) — NULL where no such status
 * exists (e.g. a WS frame); it is never fabricated, on either hook path.
 * `body` is the unit's text (response body | SSE event data | WS frame
 * payload). `meta` carries invocation-scoped values (headers) merged with
 * the unit's framing fields where the lane has them.
 */
export interface RawResult {
  status: number | null;
  body: string;
  meta: Metadata;
}

/**
 * The uniform decline sentinel: a decode or classify hook returning it
 * falls to the NEXT precedence tier (per-invocation → invoker-level →
 * format built-in). FieldRouter declines with "".
 */
export const USE_DEFAULT: unique symbol = Symbol("openbindings: use default");

/**
 * Turns one delivery unit of a completed, classified-ok transport exchange
 * into an output value. Return USE_DEFAULT to decline. A THROWN error is
 * the invocation's DELIBERATE terminal (data failures are not bugs); throw
 * an InvocationError to choose the code, else the seam wraps it as
 * ERR_RESPONSE_ERROR with tier provenance.
 */
export type OutputDecoder = (
  site: InvokeSite,
  raw: RawResult,
  // `unknown` absorbs `typeof USE_DEFAULT`; the union deliberately documents
  // the decline sentinel in the signature consumers read.
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
) => unknown | typeof USE_DEFAULT | Promise<unknown | typeof USE_DEFAULT>;

/**
 * Decides whether a completed transport exchange is a success. Return
 * USE_DEFAULT to decline. Classify-false produces the format's NATIVE
 * failure — hooks change the verdict, never the error vocabulary. A thrown
 * error is a deliberate terminal (ERR_EXECUTION_FAILED unless it is
 * already an InvocationError).
 */
export type ResultClassifier = (
  site: InvokeSite,
  raw: RawResult,
) => boolean | typeof USE_DEFAULT | Promise<boolean | typeof USE_DEFAULT>;

/**
 * Places one POST-TRANSFORM input field on a transport channel, returning
 * a format-defined channel token. Return "" to decline to the next tier /
 * the format default. (Included for cross-SDK parity: no TS-native format
 * consults the route axis today — exec dispatch is Go/ob's; a TS consumer
 * reaches CLIs through a running ob. An unrecognized token is refused
 * loudly by any consulting format, never a silent fallback.)
 */
export type FieldRouter = (site: InvokeSite, field: string, value: unknown) => string;

/** One tier's hook slots; either tier may be all-undefined. */
export interface HookSlots {
  decode?: OutputDecoder;
  classify?: ResultClassifier;
  route?: FieldRouter;
}

function slotsEmpty(s: HookSlots): boolean {
  return !s.decode && !s.classify && !s.route;
}

const TIER_PER_INVOCATION = "per-invocation hook";
const TIER_INVOKER_LEVEL = "invoker-level hook";

/** Wraps a hook's thrown error per the seam's three failure channels. */
function hookTerminal(_tier: string, nativeCode: string, err: unknown): InvocationError {
  if (err instanceof InvocationError) {
    // Deliberate passthrough: the hook chose its own code and portable data.
    // Tier provenance is implementation evidence and does not cross the
    // abstract invocation boundary.
    return new InvocationError(err.code, err.data);
  }
  return new InvocationError(nativeCode);
}

/**
 * The consultation seam: the ONLY way format packages run consumer hooks.
 * It snapshots BOTH tiers (per-invocation and invoker-level) at invoke
 * entry — "resolved once" means immunity to later field mutation only;
 * precedence applies at CONSULTATION time by decline-chaining. It is
 * null-safe (format code calls the module-level decodeOutput/classify
 * helpers, which run the builtin for a null carrier), error-containing (a
 * throwing hook becomes a deliberate terminal or a contained ERR_RUNTIME,
 * never an unhandled rejection), and provenance-carrying (every failure
 * names the deciding tier).
 *
 * Hooks may run multiple times per invoke (per attempt, per delivery unit)
 * and must be effectively pure.
 */
export class InvokeHooks {
  private readonly perInvocation: HookSlots;
  private readonly invokerLevel: HookSlots;
  // Tier-blind success provenance ("hook" | "builtin") — the failure paths
  // are tier-precise; success provenance is not. Read by the
  // contract-decided teaching and the x-ob-decode/x-ob-classify provenance
  // stamps (per the conventions record's recommended built-in defaults,
  // spec/binding-specs/README.md).
  private decodeDecided = "";
  private classifyDecided = "";

  constructor(perInvocation: HookSlots, invokerLevel: HookSlots) {
    this.perInvocation = perInvocation;
    this.invokerLevel = invokerLevel;
  }

  /** "hook", "builtin", or "" (no decode yet). */
  decodeDecidedBy(): string {
    return this.decodeDecided;
  }

  /** "hook", "builtin", or "" (no classification yet). */
  classifyDecidedBy(): string {
    return this.classifyDecided;
  }

  /**
   * Runs the decode chain: per-invocation → invoker-level → builtin, each
   * tier declining with USE_DEFAULT. The builtin is the owning format's;
   * passing null means the format consults no decode builtin, and an
   * all-decline chain is a loud ERR_RUNTIME, never a silent value.
   */
  async decodeOutput(
    site: InvokeSite,
    raw: RawResult,
    builtin: OutputDecoder | null,
  ): Promise<unknown> {
    const tiers: Array<[string, OutputDecoder | undefined]> = [
      [TIER_PER_INVOCATION, this.perInvocation.decode],
      [TIER_INVOKER_LEVEL, this.invokerLevel.decode],
    ];
    for (const [tier, fn] of tiers) {
      if (!fn) continue;
      // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- documents the decline sentinel (see OutputDecoder)
      let v: unknown | typeof USE_DEFAULT;
      try {
        v = await fn(site, raw);
      } catch (err) {
        throw hookTerminal(tier, ERR_RESPONSE_ERROR, err);
      }
      if (v === USE_DEFAULT) continue;
      this.decodeDecided = "hook";
      return v;
    }
    this.decodeDecided = "builtin";
    return runBuiltinDecode(site, raw, builtin);
  }

  /** Runs the classify chain with the same tiering and channels. */
  async classify(
    site: InvokeSite,
    raw: RawResult,
    builtin: ResultClassifier | null,
  ): Promise<boolean> {
    const tiers: Array<[string, ResultClassifier | undefined]> = [
      [TIER_PER_INVOCATION, this.perInvocation.classify],
      [TIER_INVOKER_LEVEL, this.invokerLevel.classify],
    ];
    for (const [tier, fn] of tiers) {
      if (!fn) continue;
      let v: boolean | typeof USE_DEFAULT;
      try {
        v = await fn(site, raw);
      } catch (err) {
        throw hookTerminal(tier, ERR_EXECUTION_FAILED, err);
      }
      if (v === USE_DEFAULT) continue;
      this.classifyDecided = "hook";
      return v;
    }
    this.classifyDecided = "builtin";
    return runBuiltinClassify(site, raw, builtin);
  }

  /**
   * Runs the route chain: per-invocation → invoker-level, declining with
   * "". A throwing router is a contained deliberate terminal.
   */
  routeField(site: InvokeSite, field: string, value: unknown): string {
    const tiers: Array<[string, FieldRouter | undefined]> = [
      [TIER_PER_INVOCATION, this.perInvocation.route],
      [TIER_INVOKER_LEVEL, this.invokerLevel.route],
    ];
    for (const [tier, fn] of tiers) {
      if (!fn) continue;
      let v: string;
      try {
        v = fn(site, field, value);
      } catch (err) {
        throw hookTerminal(tier, ERR_RUNTIME, err);
      }
      if (v !== "") return v;
    }
    return "";
  }
}

/**
 * Snapshots the two tiers into a carrier, or null when both are empty
 * (null carrier = builtins only; the module-level helpers are null-safe).
 */
export function newInvokeHooks(perInvocation: HookSlots, invokerLevel: HookSlots): InvokeHooks | null {
  if (slotsEmpty(perInvocation) && slotsEmpty(invokerLevel)) return null;
  return new InvokeHooks(perInvocation, invokerLevel);
}

/**
 * Null-safe decode through the seam: format code calls this with whatever
 * carrier the args carry (possibly null) and its own builtin. A null
 * carrier runs the builtin directly (and reports builtin provenance).
 */
export async function decodeThroughHooks(
  hooks: InvokeHooks | null | undefined,
  site: InvokeSite,
  raw: RawResult,
  builtin: OutputDecoder | null,
): Promise<unknown> {
  if (hooks) return hooks.decodeOutput(site, raw, builtin);
  return runBuiltinDecode(site, raw, builtin);
}

/** Null-safe classify through the seam (see decodeThroughHooks). */
export async function classifyThroughHooks(
  hooks: InvokeHooks | null | undefined,
  site: InvokeSite,
  raw: RawResult,
  builtin: ResultClassifier | null,
): Promise<boolean> {
  if (hooks) return hooks.classify(site, raw, builtin);
  return runBuiltinClassify(site, raw, builtin);
}

async function runBuiltinDecode(
  site: InvokeSite,
  raw: RawResult,
  builtin: OutputDecoder | null,
): Promise<unknown> {
  if (!builtin) {
    throw new InvocationError(ERR_RUNTIME);
  }
  const v = await builtin(site, raw);
  if (v === USE_DEFAULT) {
    throw new InvocationError(ERR_RUNTIME);
  }
  return v;
}

async function runBuiltinClassify(
  site: InvokeSite,
  raw: RawResult,
  builtin: ResultClassifier | null,
): Promise<boolean> {
  if (!builtin) {
    throw new InvocationError(ERR_RUNTIME);
  }
  const v = await builtin(site, raw);
  if (v === USE_DEFAULT) {
    throw new InvocationError(ERR_RUNTIME);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Contract inspectors + the unvalidated-assumption warning (per the
// conventions record's recommended built-in defaults, spec/binding-specs/README.md)
// ---------------------------------------------------------------------------

/**
 * Reports whether a schema carries the synthesis floor-stamp
 * ({"type":"string","x-ob":{"floor":...}}) — the declaration the
 * diagnostics key on. Content-independent: it reads the contract, never
 * payload bytes.
 */
export function floorStamped(schema: JSONSchema | undefined | null): boolean {
  if (!schema || typeof schema !== "object") return false;
  const xob = (schema)["x-ob"];
  if (!xob || typeof xob !== "object" || Array.isArray(xob)) return false;
  return "floor" in (xob as Record<string, unknown>);
}

/**
 * Reports whether an output contract cannot catch a wrong decode lane:
 * absent, empty, boolean-true, or admitting bare strings. Content-
 * independent contract inspection (the unvalidated-assumption warning's
 * trigger arms).
 */
export function nonDiscriminatingOutput(schema: JSONSchema | undefined | null): boolean {
  if (typeof schema === "boolean") {
    // Boolean-true accepts everything (cannot catch a wrong lane);
    // boolean-false rejects everything (any wrong decode fails loudly).
    return schema;
  }
  if (!schema || typeof schema !== "object") return true;
  const m = schema;
  if (Object.keys(m).length === 0) return true;
  if (floorStamped(schema)) return true;
  const t = m["type"];
  if (typeof t === "string") return t === "string";
  if (Array.isArray(t)) return t.includes("string");
  if (t == null) {
    // No type constraint at the top level and no combinator that obviously
    // excludes strings: treat as non-discriminating unless a combinator is
    // present (a oneOf/anyOf/allOf is at least TRYING to discriminate).
    if (!m["oneOf"] && !m["anyOf"] && !m["allOf"] && !m["$ref"]) return true;
  }
  return false;
}

/**
 * Composes the unvalidated/undiscriminating-assumption warning the
 * conventions record's recommended built-in defaults call for
 * (spec/binding-specs/README.md): it fires when an ASSUMPTION decoded the output
 * (decodeStamp is the format's x-ob-decode trailer stamp —
 * "assumption/<detail>" means the
 * documented default ran; "hook", "header/...", "spec/...", or absent mean
 * it did not) AND the output contract cannot catch a wrong lane (no
 * schema, a non-discriminating schema, or a floor-stamped schema).
 * Format-generic text; "" means no warning. Content-independent — it reads
 * provenance and the contract, never payload bytes. Keying on the stamp
 * rather than the hook carrier keeps it honest: a format that consults no
 * decode axis emits no stamp and can never be accused of a decode it did
 * not run.
 */
export function assumptionWarning(
  decodeStamp: string,
  outputSchema: JSONSchema | undefined | null,
): string {
  if (!decodeStamp.startsWith("assumption/")) return "";
  const isObj = typeof outputSchema === "object" && outputSchema !== null;
  let reason: string;
  if (floorStamped(outputSchema)) {
    reason = "floor-stamped output schema";
  } else if (outputSchema == null || (isObj && Object.keys(outputSchema).length === 0)) {
    reason = "no output schema";
  } else if (nonDiscriminatingOutput(outputSchema)) {
    reason = "non-discriminating output schema";
  } else {
    return "";
  }
  return `the built-in default decoded the output and the output contract cannot catch a wrong lane (${reason}); a wrong decode assumption would pass silently — set an outputDecoder or elect the real output schema`;
}
