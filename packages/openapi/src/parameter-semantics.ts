import {
  serializeCookieValue,
  serializeHeaderValue,
  serializeParamContent,
  serializationMethod,
  type BodyPlan,
  type OpenAPIExecutionProfile,
} from "@openbindings/openapi-client/analysis";
import { BINDING_SPEC_OPENAPI_31 } from "./constants.js";
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIParameter,
  OpenAPIPathItem,
} from "./types.js";
import {
  resolveDeclaration,
  resolvedPropertySlots,
  type SchemaDeclaration,
} from "./resolved-declaration.js";

/** §8.1's deterministic consumer conversion from a JSON boolean/number. */
export type ParameterConversion = (value: boolean | number) => string;

export interface PreparedParameterValue {
  value: unknown;
  cookieEmits: boolean;
}

/** §5.2's one source-scope exclusion, intentionally distinct from load refusal. */
export function sourceExclusionReason(
  document: OpenAPIDocument,
  bindingSpec: string,
): string | undefined {
  if (bindingSpec !== BINDING_SPEC_OPENAPI_31 || !Object.hasOwn(document, "jsonSchemaDialect")) {
    return undefined;
  }
  if (document.jsonSchemaDialect === "https://spec.openapis.org/oas/3.1/dialect/base") {
    return undefined;
  }
  return `whole-source exclusion: root jsonSchemaDialect ${JSON.stringify(document.jsonSchemaDialect)} is not the incorporated OpenAPI 3.1 base dialect`;
}

/** Effective rows before malformed declarations are filtered out by the carrier. */
export function effectiveParameterDeclarationRows(
  pathItem: OpenAPIPathItem,
  operation: OpenAPIOperation,
): OpenAPIParameter[] {
  const pathRows = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
  const operationRows = Array.isArray(operation.parameters) ? operation.parameters : [];
  const overridden = new Set<string>();
  for (const parameter of operationRows) {
    const identity = parameterIdentity(parameter);
    if (identity !== undefined) overridden.add(identity);
  }
  return [
    ...pathRows.filter((parameter) => {
      const identity = parameterIdentity(parameter);
      return identity === undefined || !overridden.has(identity);
    }),
    ...operationRows,
  ].filter((parameter) => !ignoredHeaderParameter(parameter));
}

/** Returns the first 3.1 effective Parameter Object that violates the closed gate. */
export function malformedEffectiveParameter(
  parameters: OpenAPIParameter[],
  bindingSpec: string,
): string | undefined {
  if (bindingSpec !== BINDING_SPEC_OPENAPI_31) return undefined;
  for (const parameter of parameters) {
    const name = typeof parameter?.name === "string" && parameter.name !== ""
      ? parameter.name
      : "<unnamed>";
    if (
      !parameter
      || typeof parameter.name !== "string"
      || parameter.name === ""
      || !["path", "query", "header", "cookie"].includes(parameter.in ?? "")
    ) return name;
    const hasSchema = Object.hasOwn(parameter, "schema");
    const hasContent = Object.hasOwn(parameter, "content");
    if (hasSchema === hasContent) return name;
    if (parameter.in === "path" && parameter.required !== true) return name;
    if (hasContent) {
      const content = asRecord(parameter.content);
      if (!content || Object.keys(content).length !== 1) return name;
    }
  }
  return undefined;
}

/** Validates the declaration-only location/style/explode cells through §5.2. */
export function validateParameterSerializationForBinding(
  parameter: OpenAPIParameter,
  oas30: boolean,
): void {
  if (asRecord(parameter.content)) return;
  if (Object.hasOwn(parameter, "style") && (typeof parameter.style !== "string" || parameter.style === "")) {
    throw new Error(`parameter ${JSON.stringify(parameter.name)} declares an invalid style`);
  }
  if (Object.hasOwn(parameter, "explode") && typeof parameter.explode !== "boolean") {
    throw new Error(`parameter ${JSON.stringify(parameter.name)} declares a non-boolean explode`);
  }
  const { style, explode } = serializationMethod(parameter);
  const resolved = resolveDeclaration(parameter.schema, oas30);
  switch (parameter.in) {
    case "path":
      if (!["simple", "label", "matrix"].includes(style)) {
        throw new Error(`path parameter ${JSON.stringify(parameter.name)} declares unsupported style ${JSON.stringify(style)}`);
      }
      return;
    case "header":
      if (style !== "simple") throw new Error(`header parameter ${JSON.stringify(parameter.name)} requires simple style`);
      return;
    case "cookie":
      if (style !== "form") throw new Error(`cookie parameter ${JSON.stringify(parameter.name)} requires form style`);
      return;
    case "query":
      if (style === "form") return;
      if (style === "spaceDelimited" || style === "pipeDelimited") {
        if (explode) throw new Error(`query style ${JSON.stringify(style)} has no explode=true cell`);
        if (resolved.declaresOnly("null", "boolean", "number", "integer", "string")) {
          throw new Error(`query style ${JSON.stringify(style)} is defined only for arrays or objects`);
        }
        return;
      }
      if (style === "deepObject") {
        if (!explode) throw new Error("query style deepObject has no explode=false cell");
        if (resolved.declaresOnly("null", "boolean", "number", "integer", "string", "array")) {
          throw new Error("query style deepObject is defined only for objects");
        }
        return;
      }
      throw new Error(`query parameter ${JSON.stringify(parameter.name)} declares unsupported style ${JSON.stringify(style)}`);
    default:
      throw new Error(`parameter ${JSON.stringify(parameter.name)} declares unsupported location ${JSON.stringify(parameter.in)}`);
  }
}

/** First nested compound declaration that has no style-lane expansion. */
export function parameterStyleLaneUndefinedExpansionMember(
  parameter: OpenAPIParameter,
  oas30: boolean,
): string | null {
  if (!parameter || asRecord(parameter.content) || !Object.hasOwn(parameter, "schema")) return null;
  const { style } = serializationMethod(parameter);
  if (!["form", "spaceDelimited", "pipeDelimited", "deepObject", "simple", "label", "matrix"].includes(style)) {
    return null;
  }
  const member = styleLaneUndefinedExpansionMember(parameter.schema, oas30);
  return member === null ? null : `${parameter.name ?? ""}${member}`;
}

export function styleLaneUndefinedExpansionParam(
  parameters: OpenAPIParameter[],
  profile: OpenAPIExecutionProfile,
  oas30: boolean,
): string | null {
  if (!profile.mediaFidelity) return null;
  for (const parameter of parameters) {
    const member = parameterStyleLaneUndefinedExpansionMember(parameter, oas30);
    if (member !== null) return member;
  }
  return null;
}

export function styleLaneUndefinedExpansionMember(
  schema: SchemaDeclaration,
  oas30: boolean,
): string | null {
  const resolved = resolveDeclaration(schema, oas30);
  if (resolved.declaresOnly("array")) {
    return resolved.items().declaresOnly("object", "array") ? "[]" : null;
  }
  if (!resolved.declaresOnly("object")) return null;
  for (const name of resolved.propertyNames()) {
    if (resolved.property(name).declaresOnly("object", "array")) return `.${name}`;
  }
  return null;
}

export function formStyleCookieMultiValueProof(
  parameter: OpenAPIParameter,
  oas30: boolean,
): boolean {
  if (
    oas30
    || parameter.in !== "cookie"
    || asRecord(parameter.content)
    || !Object.hasOwn(parameter, "schema")
  ) return false;
  const method = serializationMethod(parameter);
  if (method.style !== "form" || !method.explode) return false;
  const resolved = resolveDeclaration(parameter.schema, false);
  return resolved.declaresOnly("array")
    || (resolved.declaresOnly("object") && resolved.propertyNames().length > 0);
}

export function formStyleCookieMultiValueParameter(
  parameters: OpenAPIParameter[],
  oas30: boolean,
): string | undefined {
  return parameters.find((parameter) => formStyleCookieMultiValueProof(parameter, oas30))?.name;
}

export function checkPathTemplateDeclaration(
  pathTemplate: string,
  parameters: OpenAPIParameter[],
  bindingSpec: string,
): string | undefined {
  const declared = new Set(
    parameters.filter((parameter) => parameter.in === "path" && typeof parameter.name === "string")
      .map((parameter) => parameter.name!),
  );
  const expressions = pathTemplateVariables(pathTemplate);
  const seen = new Set<string>();
  const missing: string[] = [];
  const duplicates: string[] = [];
  for (const expression of expressions) {
    if (seen.has(expression)) duplicates.push(expression);
    seen.add(expression);
    if (!declared.has(expression)) missing.push(expression);
  }
  if (missing.length > 0) {
    return `path template variable(s) ${uniqueSorted(missing).join(", ")} have no declared path parameter`;
  }
  if (bindingSpec !== BINDING_SPEC_OPENAPI_31) return undefined;
  if (duplicates.length > 0) {
    return `path template expression(s) ${uniqueSorted(duplicates).join(", ")} occur more than once`;
  }
  const unmatched = [...declared].filter((name) => !seen.has(name)).sort(codePointCompare);
  if (unmatched.length > 0) {
    return `declared path parameter(s) ${unmatched.join(", ")} have no path template expression`;
  }
  return undefined;
}

export function equivalentPathTemplateCollision(
  paths: Record<string, OpenAPIPathItem> | undefined,
  selected: string,
): string | undefined {
  if (!paths) return undefined;
  const wanted = normalizedPathTemplateHierarchy(selected);
  if (!wanted.templated) return undefined;
  for (const candidate of Object.keys(paths)) {
    if (candidate === selected) continue;
    const normalized = normalizedPathTemplateHierarchy(candidate);
    if (normalized.templated && normalized.value === wanted.value) return candidate;
  }
  return undefined;
}

export function convertParameterScalars(
  value: unknown,
  conversion: ParameterConversion | undefined,
  member = false,
): unknown {
  if (value === null) {
    if (member) throw new Error("null array/object member has no RFC 6570 representation");
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      try {
        return convertParameterScalars(item, conversion, true);
      } catch (error: unknown) {
        throw new Error(`array member ${index}: ${errorMessage(error)}`, { cause: error });
      }
    });
  }
  const object = asRecord(value);
  if (object) {
    return Object.fromEntries(Object.entries(object).map(([name, item]) => {
      try {
        return [name, convertParameterScalars(item, conversion, true)];
      } catch (error: unknown) {
        throw new Error(`object member ${JSON.stringify(name)}: ${errorMessage(error)}`, { cause: error });
      }
    }));
  }
  if (typeof value === "string") return value;
  if (typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`value of type ${typeof value} is outside the JSON scalar conversion domain`);
  }
  if (!conversion) throw new Error("JSON boolean or number requires parameterConversion");
  const converted = conversion(value);
  if (typeof converted !== "string") throw new Error("parameterConversion must return a string");
  return converted;
}

export function prepareSchemaParameterValue(
  parameter: OpenAPIParameter | undefined,
  value: unknown,
  bindingSpec: string,
  conversion: ParameterConversion | undefined,
): PreparedParameterValue {
  if (!parameter) throw new Error("has no effective declaration");
  if (asRecord(parameter.content)) {
    const serialized = serializeParamContent(parameter, value);
    if (parameter.in === "header" && !validHeaderFieldValue(serialized)) {
      throw new Error("serialized header contains an invalid HTTP field byte");
    }
    return { value, cookieEmits: parameter.in === "cookie" };
  }

  const method = serializationMethod(parameter);
  const prepared = prepareStyleValue(parameter.name ?? "", value, method.style, bindingSpec, conversion);
  const engineValue = delimitedObjectAsSequence(prepared, method.style);
  if (parameter.in === "header") {
    const serialized = serializeHeaderValue(engineValue, method.style, method.explode);
    if (!validHeaderFieldValue(serialized)) {
      throw new Error("serialized header contains an invalid HTTP field byte");
    }
  }
  if (parameter.in === "cookie") {
    const units = serializeCookieValue(parameter.name ?? "", engineValue, method.style, method.explode);
    if (bindingSpec === BINDING_SPEC_OPENAPI_31 && units.length > 1) {
      throw new Error("supplied value would produce multiple cookie pairs");
    }
    return { value: engineValue, cookieEmits: units.length > 0 };
  }
  return { value: engineValue, cookieEmits: false };
}

export function prepareEncodingStylePropertyValue(
  plan: BodyPlan | undefined,
  name: string,
  value: unknown,
  bindingSpec: string,
  conversion: ParameterConversion | undefined,
): unknown {
  const encoding = asRecord(asRecord(plan?.media?.encoding)?.[name]);
  if (!encoding || !encodingUsesSerialization(encoding)) return value;
  const style = typeof encoding.style === "string" && encoding.style !== "" ? encoding.style : "form";
  const prepared = prepareStyleValue(name, value, style, bindingSpec, conversion);
  return delimitedObjectAsSequence(prepared, style);
}

function prepareStyleValue(
  name: string,
  value: unknown,
  style: string,
  bindingSpec: string,
  conversion: ParameterConversion | undefined,
): unknown {
  if (bindingSpec === BINDING_SPEC_OPENAPI_31 && value === null) {
    if (["matrix", "label", "simple", "form"].includes(style)) return null;
    throw new Error(`JSON null has n/a in style ${JSON.stringify(style)}'s undefined cell`);
  }
  const prepared = bindingSpec === BINDING_SPEC_OPENAPI_31
    ? convertParameterScalars(value, conversion)
    : value;
  const delimiters = nonRFCStyleDelimiters(style);
  if (delimiters !== "" && (
    containsAnyDelimiter(name, delimiters)
    || styleValueContainsDelimiter(prepared, delimiters)
  )) {
    throw new Error(`value or member name contains style ${JSON.stringify(style)}'s structural delimiter`);
  }
  if (style === "spaceDelimited" || style === "pipeDelimited") {
    if (!Array.isArray(prepared) && !asRecord(prepared)) {
      throw new Error(`style ${JSON.stringify(style)} is defined only for arrays or objects`);
    }
  } else if (style === "deepObject" && !asRecord(prepared)) {
    throw new Error("style deepObject is defined only for objects");
  }
  return prepared;
}

/**
 * Gives the older standalone carrier a safe private declaration view after
 * the adapter has applied the binding's stronger declaration proof.
 */
export function prepareEngineParameterView(
  parameters: OpenAPIParameter[],
  routes: { parameters: Array<{ in: string; name: string; engineName?: string }> },
  bindingSpec: string,
): string | undefined {
  const usedHeaders = new Set(
    parameters.filter((parameter) => parameter.in === "header" && typeof parameter.name === "string")
      .map((parameter) => parameter.name!.toLowerCase()),
  );
  let sentinel = "X-Openbindings-Adapter-Raw-Cookie";
  for (let suffix = 2; usedHeaders.has(sentinel.toLowerCase()); suffix += 1) {
    sentinel = `X-Openbindings-Adapter-Raw-Cookie-${suffix}`;
  }
  let foundRaw = false;
  for (const parameter of parameters) {
    if (
      bindingSpec === BINDING_SPEC_OPENAPI_31
      && parameter.in === "header"
      && parameter.name?.toLowerCase() === "cookie"
    ) {
      parameter.name = sentinel;
      foundRaw = true;
    }
    if (asRecord(parameter.content) || !Object.hasOwn(parameter, "schema")) continue;
    const { style } = serializationMethod(parameter);
    parameter.schema = engineSchemaForStyle(style);
  }
  if (!foundRaw) return undefined;
  for (const route of routes.parameters) {
    if (route.in === "header" && route.name.toLowerCase() === "cookie") route.engineName = sentinel;
  }
  return sentinel;
}

export function prepareEngineEncodingView(plans: BodyPlan[]): void {
  for (const plan of plans) {
    const root = plan.media?.schema as SchemaDeclaration;
    const encoding = asRecord(plan.media?.encoding);
    if (!encoding || !asRecord(root)) continue;
    const oas30 = plan.openapiVersion?.startsWith("3.0") === true;
    for (const [name, rawEncoding] of Object.entries(encoding)) {
      const entry = asRecord(rawEncoding);
      if (!encodingUsesSerialization(entry)) continue;
      const style = typeof entry!.style === "string" && entry!.style !== "" ? entry!.style : "form";
      for (const slot of resolvedPropertySlots(root, name, oas30)) {
        slot.owner[slot.name] = engineSchemaForStyle(style);
      }
    }
  }
}

/** Temporarily adapts Encoding declarations while the older planner admits them. */
export function withEngineEncodingAdmissionView<T>(
  operation: OpenAPIOperation,
  openapiVersion: string | undefined,
  run: () => T,
): T {
  const restores: Array<() => void> = [];
  const oas30 = openapiVersion?.startsWith("3.0") ?? true;
  try {
    for (const media of Object.values(operation.requestBody?.content ?? {})) {
      const root = media.schema as SchemaDeclaration;
      const encoding = asRecord(media.encoding);
      if (!encoding || !asRecord(root)) continue;
      for (const [name, rawEncoding] of Object.entries(encoding)) {
        const entry = asRecord(rawEncoding);
        if (!encodingUsesSerialization(entry)) continue;
        const style = typeof entry!.style === "string" && entry!.style !== "" ? entry!.style : "form";
        const explode = typeof entry!.explode === "boolean" ? entry!.explode : style === "form";
        validateEncodingStyle(name, resolveDeclaration(root, oas30).property(name), style, explode);
        const member = styleLaneUndefinedExpansionMember(
          propertySchema(root, name, oas30),
          oas30,
        );
        if (member !== null) {
          throw new Error(`body property ${JSON.stringify(name)} member ${JSON.stringify(name + member)} has no expansion defined`);
        }
        for (const slot of resolvedPropertySlots(root, name, oas30)) {
          const previous = slot.value;
          slot.owner[slot.name] = engineSchemaForStyle(style);
          restores.push(() => { slot.owner[slot.name] = previous; });
        }
      }
    }
    return run();
  } finally {
    for (let index = restores.length - 1; index >= 0; index -= 1) restores[index]!();
  }
}

export function validateCompletedURL(raw: string): void {
  let completed: URL;
  try {
    completed = new URL(raw);
  } catch (error: unknown) {
    throw new Error(
      `completed OpenAPI 3.1 URL does not parse under RFC 3986: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  for (const [name, component] of [
    ["path", completed.pathname],
    ["query", completed.search.slice(1)],
    ["fragment", completed.hash.slice(1)],
  ] as const) {
    if (!hasValidPercentEscapes(component)) {
      throw new Error(
        `completed OpenAPI 3.1 URL ${name} does not percent-decode under RFC 3986`,
      );
    }
  }
}

function hasValidPercentEscapes(component: string): boolean {
  for (let index = 0; index < component.length; index += 1) {
    if (component[index] !== "%") continue;
    if (!/^[0-9A-Fa-f]{2}$/.test(component.slice(index + 1, index + 3))) return false;
    index += 2;
  }
  return true;
}

function validateEncodingStyle(
  name: string,
  resolved: ReturnType<typeof resolveDeclaration>,
  style: string,
  explode: boolean,
): void {
  if (style === "form") return;
  if (style === "spaceDelimited" || style === "pipeDelimited") {
    if (explode) throw new Error(`body property ${JSON.stringify(name)} style ${JSON.stringify(style)} has no explode=true cell`);
    if (resolved.declaresOnly("null", "boolean", "number", "integer", "string")) {
      throw new Error(`body property ${JSON.stringify(name)} style ${JSON.stringify(style)} is defined only for arrays or objects`);
    }
    return;
  }
  if (style === "deepObject") {
    if (!explode) throw new Error(`body property ${JSON.stringify(name)} style deepObject has no explode=false cell`);
    if (resolved.declaresOnly("null", "boolean", "number", "integer", "string", "array")) {
      throw new Error(`body property ${JSON.stringify(name)} style deepObject is defined only for objects`);
    }
    return;
  }
  throw new Error(`body property ${JSON.stringify(name)} declares unsupported encoding style ${JSON.stringify(style)}`);
}

function propertySchema(root: SchemaDeclaration, name: string, oas30: boolean): SchemaDeclaration {
  const slots = resolvedPropertySlots(root, name, oas30);
  if (slots.length === 0) return undefined;
  if (slots.length === 1) return slots[0]!.value;
  return { allOf: slots.map((slot) => slot.value) };
}

function engineSchemaForStyle(style: string): Record<string, unknown> {
  if (style === "spaceDelimited" || style === "pipeDelimited") return { type: "array" };
  if (style === "deepObject") return { type: "object" };
  return {};
}

function delimitedObjectAsSequence(value: unknown, style: string): unknown {
  const object = asRecord(value);
  if (!object || (style !== "spaceDelimited" && style !== "pipeDelimited")) return value;
  return Object.keys(object).sort(codePointCompare).flatMap((name) => [name, object[name]]);
}

function validHeaderFieldValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return false;
  }
  return true;
}

function nonRFCStyleDelimiters(style: string): string {
  if (style === "spaceDelimited") return " ";
  if (style === "pipeDelimited") return "|";
  if (style === "deepObject") return "[]=&";
  return "";
}

function containsAnyDelimiter(value: string, delimiters: string): boolean {
  for (const delimiter of delimiters) if (value.includes(delimiter)) return true;
  return false;
}

function styleValueContainsDelimiter(value: unknown, delimiters: string): boolean {
  if (Array.isArray(value)) {
    return value.some((member) => typeof member === "string" && containsAnyDelimiter(member, delimiters));
  }
  const object = asRecord(value);
  if (!object) return false;
  return Object.entries(object).some(([name, member]) =>
    containsAnyDelimiter(name, delimiters)
    || (typeof member === "string" && containsAnyDelimiter(member, delimiters)));
}

function encodingUsesSerialization(encoding: Record<string, unknown> | null): boolean {
  return encoding !== null && (
    Object.hasOwn(encoding, "style")
    || Object.hasOwn(encoding, "explode")
    || Object.hasOwn(encoding, "allowReserved")
  );
}

function ignoredHeaderParameter(parameter: OpenAPIParameter): boolean {
  return parameter?.in === "header"
    && typeof parameter.name === "string"
    && ["accept", "content-type", "authorization"].includes(parameter.name.toLowerCase());
}

function parameterIdentity(parameter: OpenAPIParameter): string | undefined {
  return parameter
    && typeof parameter.name === "string"
    && typeof parameter.in === "string"
    ? `${parameter.in}\u0000${parameter.name}`
    : undefined;
}

function pathTemplateVariables(pathTemplate: string): string[] {
  const names: string[] = [];
  let open = -1;
  for (let index = 0; index < pathTemplate.length; index += 1) {
    if (pathTemplate[index] === "{") open = index;
    else if (pathTemplate[index] === "}" && open >= 0) {
      names.push(pathTemplate.slice(open + 1, index));
      open = -1;
    }
  }
  return names;
}

function normalizedPathTemplateHierarchy(path: string): { value: string; templated: boolean } {
  let value = "";
  let templated = false;
  for (let index = 0; index < path.length;) {
    if (path[index] !== "{") {
      value += path[index];
      index += 1;
      continue;
    }
    const close = path.indexOf("}", index + 1);
    if (close < 0) {
      value += path[index];
      index += 1;
      continue;
    }
    value += "{}";
    templated = true;
    index = close + 1;
  }
  return { value, templated };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(codePointCompare);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
