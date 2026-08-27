export * from "@openbindings/openapi-client/analysis";

import {
  FAMILY_MULTIPART,
  FAMILY_URLENCODED,
  buildMultipartBody as buildMultipartBodyFromClient,
  parseMediaRange,
  parseMediaType,
  planRequestBodies as planRequestBodiesFromClient,
  type BodyPlan,
  type OpenAPIDocument,
  type OpenAPIMediaType,
  type OpenAPIOperation,
  type ParsedMediaRange,
  type ParsedMediaType,
} from "@openbindings/openapi-client/analysis";
import { withEngineEncodingAdmissionView } from "./parameter-semantics.js";
import {
  resolveDeclaration,
  resolvedPropertySlots,
  type SchemaDeclaration,
} from "./resolved-declaration.js";

interface PropertyMediaFacts {
  required: string[];
  declarations: Record<string, string>;
  raw: string[];
  transferEncodings: Record<string, string>;
  unsafeMultipartName: boolean;
  unusable: boolean;
  oas30: boolean;
}

export interface AdapterBodyPlan extends BodyPlan {
  /** Properties whose selected form/part representation needs one consumer choice. */
  propertyMedia?: string[];
  /** Authored Encoding contentType declaration for each required choice. */
  propertyMediaDeclarations?: Record<string, string>;
  /** Properties that cross the SDK boundary as canonical Base64 raw octets. */
  rawProperties?: string[];
  /** Artifact-declared OAS 3.0 Content-Transfer-Encoding fields. */
  transferEncodings?: Record<string, string>;
  oas30?: boolean;
}

/**
 * Routes request planning through the binding's resolved-declaration view and
 * gives the predecessor carrier an invocation-private spelling for corrected
 * typeless multipart parts. The returned plan retains the authored media
 * object and records every propertyMedia decision separately.
 */
export function planRequestBodies(
  ...args: Parameters<typeof planRequestBodiesFromClient>
): ReturnType<typeof planRequestBodiesFromClient> {
  const [operation, options] = args;
  const oas30 = options?.openapiVersion?.startsWith("3.0") ?? true;
  const facts = requestPropertyMediaFacts(operation, oas30);
  return withEngineEncodingAdmissionView(operation, options?.openapiVersion, () =>
    withEngineMediaAdmissionView(operation, oas30, facts, () => {
      const plans = planRequestBodiesFromClient(...args) as AdapterBodyPlan[];
      return plans.flatMap((plan) => {
        const mediaFacts = facts.get(plan.mediaKey);
        if (mediaFacts && (mediaFacts.unusable
          || (mediaFacts.unsafeMultipartName && plan.family === FAMILY_MULTIPART))) return [];
        if (mediaFacts) {
          plan.propertyMedia = [...mediaFacts.required];
          plan.propertyMediaDeclarations = { ...mediaFacts.declarations };
          plan.rawProperties = [...mediaFacts.raw];
          plan.transferEncodings = { ...mediaFacts.transferEncodings };
          plan.oas30 = mediaFacts.oas30;
        }
        return [plan];
      });
    }));
}

/** Required propertyMedia names carried by one represented request plan. */
export function requiredPropertyMediaNames(plan: BodyPlan): string[] {
  return [...((plan as AdapterBodyPlan).propertyMedia ?? [])];
}

export function plansRequirePropertyMedia(plans: readonly BodyPlan[]): boolean {
  return plans.some((plan) => requiredPropertyMediaNames(plan).length > 0);
}

/**
 * The direct helper's corrected 3.1 typeless-part lane. Other parts remain on
 * the standalone carrier. A typeless application value is a canonical Base64
 * string and the part receives the decoded octets.
 */
export function buildMultipartBody(
  doc: OpenAPIDocument,
  media: OpenAPIMediaType | null,
  fields: Record<string, unknown>,
  revision3 = false,
  dynamicProperties = false,
): FormData {
  if (!revision3) {
    return buildMultipartBodyFromClient(doc, media, fields, revision3, dynamicProperties);
  }
  const oas30 = doc.openapi?.startsWith("3.0") ?? true;
  const root = media?.schema as SchemaDeclaration;
  const resolved = resolveDeclaration(root, oas30);
  const rawNames = new Set<string>();
  if (!oas30) {
    for (const name of Object.keys(fields)) {
      let member = resolved.property(name);
      if (member.declaresOnly("array")) member = member.items();
      if (member.typeless()) rawNames.add(name);
    }
  }

  const ordinary = Object.fromEntries(
    Object.entries(fields).filter(([name]) => !rawNames.has(name)),
  );
  const form = withRuntimeEncodingView(media, oas30, () =>
    buildMultipartBodyFromClient(doc, media, ordinary, revision3, dynamicProperties));
  const encoding = asRecord(media?.encoding) ?? {};
  for (const name of [...rawNames].sort(codePointCompare)) {
    const enc = asRecord(encoding[name]);
    const declared = typeof enc?.contentType === "string" ? enc.contentType : "";
    const contentType = declared === ""
      ? "application/octet-stream"
      : singleConcreteMediaType(declared).canonical;
    const property = resolved.property(name);
    const values = property.declaresOnly("array")
      ? requireArray(fields[name], name)
      : [fields[name]];
    for (const value of values) {
      const bytes = canonicalBase64Bytes(value, `multipart property ${JSON.stringify(name)}`);
      form.append(name, new Blob([bytes as BlobPart], { type: contentType }), name);
    }
  }
  return form;
}

/**
 * Validates and materializes propertyMedia choices on the adapter-private
 * operation handed to the predecessor transport.
 */
export function prepareEnginePropertyMediaView(
  plans: readonly BodyPlan[],
  context: Record<string, unknown> | undefined,
): void {
  const configured = propertyMediaMap(context);
  for (const basePlan of plans) {
    const plan = basePlan as AdapterBodyPlan;
    if (!plan.media || (plan.family !== FAMILY_MULTIPART && plan.family !== FAMILY_URLENCODED)) {
      continue;
    }
    const required = plan.propertyMedia ?? [];
    const selected: Record<string, string> = {};
    for (const name of required) {
      const raw = configured?.[name];
      if (typeof raw === "string") {
        selected[name] = selectPropertyMedia(plan, name, raw);
        continue;
      }
      // Unselected and optional plans still need a predecessor-carrier
      // spelling at prepare time. Invocation validates the selected plan and
      // never treats this placeholder as a consumer decision.
      const declaration = plan.propertyMediaDeclarations?.[name] ?? "";
      selected[name] = firstConcreteMediaMember(declaration) ?? "application/octet-stream";
    }

    const media = plan.media as OpenAPIMediaType & { encoding?: Record<string, Record<string, unknown>> };
    media.encoding ??= {};
    for (const [name, contentType] of Object.entries(selected)) {
      media.encoding[name] = { ...(media.encoding[name] ?? {}), contentType };
    }
    for (const name of plan.rawProperties ?? []) {
      const contentType = selected[name] ?? media.encoding[name]?.contentType;
      media.encoding[name] = {
        ...(media.encoding[name] ?? {}),
        ...(typeof contentType === "string" && contentType !== "" ? { contentType } : {}),
      };
      materializeRawProperty(plan.media.schema, name, plan.oas30 === true);
    }
    stripDescriptiveEncodingHeaders(media);
    if (plan.oas30 && plan.family === FAMILY_MULTIPART) stripMultipartStyleControls(media);
  }
}

export function configuredPropertyMedia(
  plan: BodyPlan,
  context: Record<string, unknown> | undefined,
): Record<string, string> {
  const configured = propertyMediaMap(context);
  const result: Record<string, string> = {};
  for (const name of requiredPropertyMediaNames(plan)) {
    const raw = configured?.[name];
    if (typeof raw !== "string") throw new Error(`configuration.propertyMedia.${name} is required`);
    result[name] = selectPropertyMedia(plan, name, raw);
  }
  return result;
}

export function selectPropertyMedia(
  plan: AdapterBodyPlan,
  name: string,
  choice: string,
): string {
  const wanted = parseMediaType(choice, true);
  const declaration = plan.propertyMediaDeclarations?.[name] ?? "";
  if (declaration === "") return wanted.canonical;
  const members = splitHTTPList(declaration);
  const parsed = members.map((member) => parseMediaDeclaration(member));
  const identities = new Map<string, number>();
  for (const member of parsed) identities.set(member.identity, (identities.get(member.identity) ?? 0) + 1);
  const matches = parsed.filter((member) =>
    identities.get(member.identity) === 1 && mediaDeclarationMatches(member, wanted));
  if (matches.length === 0) {
    throw new Error(`configuration.propertyMedia.${name} matches no declared Encoding contentType member`);
  }
  const bestRange = Math.max(...matches.map(mediaSpecificity));
  const atRange = matches.filter((member) => mediaSpecificity(member) === bestRange);
  const bestParams = Math.max(...atRange.map((member) => Object.keys(member.params).length));
  if (atRange.filter((member) => Object.keys(member.params).length === bestParams).length !== 1) {
    throw new Error(`configuration.propertyMedia.${name} is ambiguous`);
  }
  return wanted.canonical;
}

function requestPropertyMediaFacts(
  operation: OpenAPIOperation,
  oas30: boolean,
): Map<string, PropertyMediaFacts> {
  const result = new Map<string, PropertyMediaFacts>();
  for (const [mediaKey, media] of Object.entries(operation.requestBody?.content ?? {})) {
    const multipart = concreteBase(mediaKey) === "multipart/form-data";
    const urlencoded = concreteBase(mediaKey) === "application/x-www-form-urlencoded";
    if (!multipart && !urlencoded) continue;
    const root = media.schema as SchemaDeclaration;
    const resolved = resolveDeclaration(root, oas30);
    const encoding = asRecord(media.encoding) ?? {};
    const required: string[] = [];
    const raw: string[] = [];
    const transferEncodings: Record<string, string> = {};
    const declarations: Record<string, string> = {};
    let unsafeMultipartName = false;
    let unusable = false;
    for (const name of resolved.propertyNames()) {
      if (multipart && /[\r\n]/.test(name)) unsafeMultipartName = true;
      if (
        oas30
        && resolvedPropertySlots(root, name, true)
          .some((slot) => typeof slot.value === "boolean")
      ) {
        // Boolean-literal schemas are outside the closed 3.0 Schema Object
        // dialect. The acceptance floor accounts the invalid alternative;
        // no propertyMedia decision repairs that malformed spelling.
        continue;
      }
      let property = resolved.property(name);
      if (property.declaresOnly("array")) property = property.items();
      const typeless = property.typeless();
      const enc = asRecord(encoding[name]);
      const contentType = typeof enc?.contentType === "string" ? enc.contentType : "";
      const contentPath = !encodingUsesStyleControls(enc);
      const mediaChoice = contentPath && contentType !== "" && !isSingleConcreteMediaType(contentType);
      if ((oas30 && multipart && typeless) || mediaChoice) {
        required.push(name);
        declarations[name] = contentType;
      }
      if (multipart && typeless) raw.push(name);
      if (oas30 && multipart && property.format().value === "byte") {
        const transferEncoding = declaredBase64TransferEncoding(enc);
        if (transferEncoding === false) unusable = true;
        else if (transferEncoding !== null) transferEncodings[name] = transferEncoding;
      }
    }
    result.set(mediaKey, {
      required: uniqueSorted(required),
      declarations,
      raw: uniqueSorted(raw),
      transferEncodings,
      unsafeMultipartName,
      unusable,
      oas30,
    });
  }
  return result;
}

function withEngineMediaAdmissionView<T>(
  operation: OpenAPIOperation,
  oas30: boolean,
  facts: ReadonlyMap<string, PropertyMediaFacts>,
  run: () => T,
): T {
  const restores: Array<() => void> = [];
  try {
    for (const [mediaKey, media] of Object.entries(operation.requestBody?.content ?? {})) {
      const mediaFacts = facts.get(mediaKey);
      if (!mediaFacts) continue;
      const root = media.schema as SchemaDeclaration;
      for (const name of mediaFacts.raw) {
        for (const slot of resolvedPropertySlots(root, name, oas30)) {
          const previous = slot.value;
          slot.owner[slot.name] = privateRawProperty(previous, oas30);
          restores.push(() => { slot.owner[slot.name] = previous; });
        }
      }
      const encoding = asRecord(media.encoding);
      for (const name of mediaFacts.required) {
        const entry = asRecord(encoding?.[name]);
        if (!entry || typeof entry.contentType !== "string" || isSingleConcreteMediaType(entry.contentType)) {
          continue;
        }
        const previous = entry.contentType;
        entry.contentType = propertyMediaAdmissionPlaceholder(
          previous,
          resolveDeclaration(root, oas30).property(name),
        );
        restores.push(() => { entry.contentType = previous; });
      }
      if (encoding) {
        for (const entry of Object.values(encoding)) {
          const enc = asRecord(entry);
          if (!enc) continue;
          if (Object.hasOwn(enc, "headers")) {
            const previous = enc.headers;
            delete enc.headers;
            restores.push(() => { enc.headers = previous; });
          }
          if (oas30 && concreteBase(mediaKey) === "multipart/form-data") {
            for (const key of ["style", "explode", "allowReserved"] as const) {
              if (!Object.hasOwn(enc, key)) continue;
              const previous = enc[key];
              delete enc[key];
              restores.push(() => { enc[key] = previous; });
            }
          }
        }
      }
    }
    return run();
  } finally {
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]!();
  }
}

function withRuntimeEncodingView<T>(
  media: OpenAPIMediaType | null,
  oas30: boolean,
  run: () => T,
): T {
  if (!media) return run();
  const restores: Array<() => void> = [];
  const encoding = asRecord(media.encoding);
  try {
    for (const entry of Object.values(encoding ?? {})) {
      const enc = asRecord(entry);
      if (!enc) continue;
      if (Object.hasOwn(enc, "headers")) {
        const previous = enc.headers;
        delete enc.headers;
        restores.push(() => { enc.headers = previous; });
      }
      if (oas30) {
        for (const key of ["style", "explode", "allowReserved"] as const) {
          if (!Object.hasOwn(enc, key)) continue;
          const previous = enc[key];
          delete enc[key];
          restores.push(() => { enc[key] = previous; });
        }
      }
    }
    return run();
  } finally {
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]!();
  }
}

function privateRawProperty(schema: SchemaDeclaration, oas30: boolean): Record<string, unknown> {
  const raw = asRecord(schema) ?? {};
  if (resolveDeclaration(raw, oas30).declaresOnly("array")) {
    const items = asRecord(raw.items) ?? {};
    return { ...raw, items: privateRawProperty(items, oas30) };
  }
  return oas30
    ? { ...raw, type: "string", format: "binary" }
    : { ...raw, type: "string", contentEncoding: "base64" };
}

function materializeRawProperty(root: SchemaDeclaration, name: string, oas30: boolean): void {
  for (const slot of resolvedPropertySlots(root, name, oas30)) {
    slot.owner[slot.name] = privateRawProperty(slot.value, oas30);
  }
}

function propertyMediaMap(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const configuration = asRecord(context?.configuration);
  const raw = configuration?.propertyMedia;
  if (raw === undefined || raw === null) return undefined;
  const value = asRecord(raw);
  if (!value) throw new Error("configuration.propertyMedia must be an object keyed by property name");
  return value;
}

function stripDescriptiveEncodingHeaders(media: OpenAPIMediaType): void {
  for (const value of Object.values(asRecord(media.encoding) ?? {})) {
    const encoding = asRecord(value);
    if (encoding) delete encoding.headers;
  }
}

function stripMultipartStyleControls(media: OpenAPIMediaType): void {
  for (const value of Object.values(asRecord(media.encoding) ?? {})) {
    const encoding = asRecord(value);
    if (!encoding) continue;
    delete encoding.style;
    delete encoding.explode;
    delete encoding.allowReserved;
  }
}

function encodingUsesStyleControls(encoding: Record<string, unknown> | null): boolean {
  return encoding !== null && ["style", "explode", "allowReserved"]
    .some((key) => Object.hasOwn(encoding, key));
}

function declaredBase64TransferEncoding(
  encoding: Record<string, unknown> | null,
): "base64" | false | null {
  const headers = asRecord(encoding?.headers);
  const declared = Object.entries(headers ?? {})
    .filter(([name]) => name.toLowerCase() === "content-transfer-encoding")
    .map(([, value]) => asRecord(value));
  if (declared.length === 0) return null;
  const header = declared[0];
  if (declared.length !== 1 || header === null || header === undefined) return false;
  const schema = header.schema as SchemaDeclaration;
  const resolved = resolveDeclaration(schema, true);
  return !resolved.ambiguous
    && (resolved.typeless() || resolved.admitsStringAsSoleNonNullType())
    && resolved.admitsStringEnumValue("base64")
    ? "base64"
    : false;
}

function splitHTTPList(raw: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (escaped) escaped = false;
    else if (character === "\\" && quoted) escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      const member = raw.slice(start, index).trim();
      if (member === "") throw new Error("empty media declaration member");
      result.push(member);
      start = index + 1;
    }
  }
  if (quoted) throw new Error("unterminated quoted media declaration");
  const last = raw.slice(start).trim();
  if (last === "") throw new Error("empty media declaration member");
  result.push(last);
  return result;
}

function parseMediaDeclaration(raw: string): ParsedMediaType | ParsedMediaRange {
  try { return parseMediaType(raw, true); } catch { return parseMediaRange(raw, true); }
}

function mediaDeclarationMatches(
  declared: ParsedMediaType | ParsedMediaRange,
  concrete: ParsedMediaType,
): boolean {
  const specificity = mediaSpecificity(declared);
  if (specificity === 2 && declared.base !== concrete.base) return false;
  if (specificity === 1 && declared.base.split("/", 1)[0] !== concrete.base.split("/", 1)[0]) return false;
  return Object.entries(declared.params).every(([name, value]) => concrete.params[name] === value);
}

function mediaSpecificity(value: ParsedMediaType | ParsedMediaRange): number {
  return "specificity" in value ? value.specificity : 2;
}

function isSingleConcreteMediaType(raw: string): boolean {
  try {
    return splitHTTPList(raw).length === 1 && Boolean(parseMediaType(raw, true));
  } catch {
    return false;
  }
}

function singleConcreteMediaType(raw: string): ParsedMediaType {
  const members = splitHTTPList(raw);
  if (members.length !== 1) throw new Error("media declaration requires one concrete member");
  return parseMediaType(members[0]!, true);
}

function firstConcreteMediaMember(raw: string): string | null {
  if (raw === "") return null;
  try {
    for (const member of splitHTTPList(raw)) {
      try { return parseMediaType(member, true).canonical; } catch { /* range member */ }
    }
  } catch { /* malformed declarations remain owned by planning */ }
  return null;
}

function propertyMediaAdmissionPlaceholder(
  raw: string,
  property: ReturnType<typeof resolveDeclaration>,
): string {
  try {
    for (const member of splitHTTPList(raw)) {
      try { return parseMediaType(member, true).canonical; } catch { /* range member */ }
      try {
        const range = parseMediaRange(member, true);
        if (range.specificity === 1 && range.base.startsWith("text/")) return "text/plain";
        if (range.specificity === 1 && range.base.startsWith("application/")) return "application/json";
      } catch { /* malformed declarations remain owned by planning */ }
    }
  } catch { /* malformed declarations remain owned by planning */ }
  return property.admitsStringAsSoleNonNullType() ? "text/plain" : "application/json";
}

function concreteBase(raw: string): string {
  try { return parseMediaType(raw, true).base; } catch { return ""; }
}

function canonicalBase64Bytes(value: unknown, subject: string): Uint8Array {
  if (typeof value !== "string") throw new Error(`${subject} requires a canonical Base64 string`);
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) throw new Error("non-canonical Base64");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error: unknown) {
    throw new Error(`${subject} requires a canonical Base64 string`, { cause: error });
  }
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`multipart property ${JSON.stringify(name)} requires an array`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(codePointCompare);
}

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
