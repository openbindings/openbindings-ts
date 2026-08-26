import type { OpenAPIExecutionProfile } from "@openbindings/openapi-client/engine";
import type { OpenAPIParameter } from "./types.js";
import { FAMILY_JSON, type BodyPlan } from "./media.js";
import { codePointCompare, escapePointerSegment } from "./util.js";
import {
  prepareEncodingStylePropertyValue,
  prepareSchemaParameterValue,
  type ParameterConversion,
} from "./parameter-semantics.js";

export interface AbstractParameterRoute {
  in: string;
  name: string;
  /** Adapter-private name used only by the standalone carrier. */
  engineName?: string;
  field: string;
}

/** Synthesis-only correspondence between flat operation fields and §7's caller envelope. */
export interface AbstractInputRoutes {
  parameters: AbstractParameterRoute[];
  bodyFields: Record<string, string>;
  wholeBodyField: string;
  openBody: boolean;
  bodyRequired: boolean;
  needsTransform: boolean;
  parameterField(inValue: string, name: string): string;
  bodyField(name: string): string;
  transformExpression(): string;
}

interface InputSlot {
  kind: "parameter" | "body" | "wholeBody";
  inValue: string;
  name: string;
  base: string;
}

/** Artifact-authored names win; generated suffixes skip every reserved authored name. */
export function planAbstractInputRoutes(
  params: OpenAPIParameter[],
  plans: BodyPlan[],
): AbstractInputRoutes {
  const slots: InputSlot[] = [];
  for (const parameter of params) {
    if (!parameter.name) continue;
    slots.push({
      kind: "parameter",
      inValue: parameter.in ?? "",
      name: parameter.name,
      base: parameter.name,
    });
  }

  const bodyNames = new Set<string>();
  let wholeBody = false;
  let protocolNeutralWholeBody = false;
  let openBody = false;
  let bodyRequired = false;
  for (const plan of plans) {
    bodyRequired ||= plan.required;
    openBody ||= planAllowsObjectPassthrough(plan);
    if (plan.synthetic || plan.wholeObject) {
      wholeBody = true;
      protocolNeutralWholeBody ||= plan.wholeObject === true;
      continue;
    }
    for (const name of plan.props ?? []) bodyNames.add(name);
  }
  for (const name of [...bodyNames].sort(codePointCompare)) {
    slots.push({ kind: "body", inValue: "", name, base: name });
  }
  if (wholeBody) {
    slots.push({
      kind: "wholeBody",
      inValue: "",
      name: "",
      base: protocolNeutralWholeBody ? "payload" : "body",
    });
  }

  const reserved = new Set(slots.map((slot) => slot.base));
  const used = new Set<string>();
  const assigned = slots.map((slot) => {
    let field = slot.base;
    if (used.has(field)) {
      for (let suffix = 2; ; suffix++) {
        const candidate = `${slot.base}_${suffix}`;
        if (!used.has(candidate) && !reserved.has(candidate)) {
          field = candidate;
          break;
        }
      }
    }
    used.add(field);
    return field;
  });

  const parameters: AbstractParameterRoute[] = [];
  const bodyFields: Record<string, string> = {};
  let wholeBodyField = "";
  slots.forEach((slot, index) => {
    const field = assigned[index]!;
    if (slot.kind === "parameter") {
      parameters.push({ in: slot.inValue, name: slot.name, field });
    } else if (slot.kind === "body") {
      bodyFields[slot.name] = field;
    } else {
      wholeBodyField = field;
    }
  });

  const routes: AbstractInputRoutes = {
    parameters,
    bodyFields,
    wholeBodyField,
    openBody,
    bodyRequired,
    needsTransform: slots.length > 0 || openBody || bodyRequired,
    parameterField(inValue, name) {
      return parameters.find((route) => route.in === inValue && route.name === name)?.field ?? name;
    },
    bodyField(name) {
      return bodyFields[name] ?? name;
    },
    transformExpression() {
      return transformExpression(routes, params);
    },
  };
  return routes;
}

export function qualifiedParameterMode(params: OpenAPIParameter[]): boolean {
  const locations = new Map<string, string>();
  for (const parameter of params) {
    const name = parameter.name ?? "";
    const inValue = parameter.in ?? "";
    const previous = locations.get(name);
    if (previous !== undefined && previous !== inValue) return true;
    locations.set(name, inValue);
  }
  return false;
}

export function callerParameterKey(inValue: string, name: string, qualified: boolean): string {
  return qualified ? `${inValue}/${escapePointerSegment(name)}` : name;
}

const JSONATA_UNDEFINED = '$lookup({},"__openbindings_absent")';

function quotedJSONata(value: string): string {
  return JSON.stringify(value);
}

function jsonataLookup(field: string): string {
  return `$lookup($,${quotedJSONata(field)})`;
}

function jsonataObject(fields: Record<string, string>): string {
  const pairs = Object.keys(fields).sort(codePointCompare).map(
    (key) => `${quotedJSONata(key)}:${jsonataLookup(fields[key]!)}`,
  );
  return `{${pairs.join(",")}}`;
}

/** Emits ordinary JSONata; no engine-private marker or route tuple enters an OBI. */
function transformExpression(routes: AbstractInputRoutes, params: OpenAPIParameter[]): string {
  const qualified = qualifiedParameterMode(params);
  const parameterFields: Record<string, string> = {};
  for (const route of routes.parameters) {
    parameterFields[callerParameterKey(route.in, route.name, qualified)] = route.field;
  }
  const parametersExpression = jsonataObject(parameterFields);
  const bodyExpressionFields = { ...routes.bodyFields };
  let bodyExpression = jsonataObject(bodyExpressionFields);
  const bodyPresence = Object.values(routes.bodyFields).map(
    (field) => `$exists(${jsonataLookup(field)})`,
  );
  const excluded = new Set<string>();
  for (const route of routes.parameters) excluded.add(route.field);
  for (const field of Object.values(routes.bodyFields)) excluded.add(field);
  if (routes.wholeBodyField) excluded.add(routes.wholeBodyField);

  if (routes.openBody) {
    const parts = [...excluded].sort(codePointCompare).map(
      (key) => `$key != ${quotedJSONata(key)}`,
    );
    const condition = parts.length > 0 ? parts.join(" and ") : "true";
    const passthrough = `$sift($,function($value,$key){${condition}})`;
    bodyExpression = Object.keys(routes.bodyFields).length > 0
      ? `$merge([${passthrough},${bodyExpression}])`
      : passthrough;
    bodyPresence.push(`$count($keys(${passthrough})) > 0`);
  }
  if (routes.bodyRequired && !routes.wholeBodyField) bodyPresence.push("true");

  const parameterValue = `$count($keys($parameters)) > 0 ? $parameters : ${JSONATA_UNDEFINED}`;
  let bodyValue = JSONATA_UNDEFINED;
  if (Object.keys(routes.bodyFields).length > 0 || routes.openBody || routes.bodyRequired) {
    const condition = bodyPresence.length > 0 ? bodyPresence.join(" or ") : "false";
    bodyValue = `(${condition}) ? $bodyObject : ${JSONATA_UNDEFINED}`;
  }
  if (routes.wholeBodyField) {
    const whole = jsonataLookup(routes.wholeBodyField);
    bodyValue = `$exists(${whole}) ? ${whole} : (${bodyValue})`;
  }

  return `($parameters := ${parametersExpression}; $bodyObject := ${bodyExpression}; {"parameters":${parameterValue},"body":${bodyValue}})`;
}

export interface CallerEnvelope {
  parameters: Record<string, unknown>;
  body: unknown;
  bodyPresent: boolean;
}

export function parseCallerEnvelope(input: unknown): CallerEnvelope {
  const value = asRecord(input);
  if (!value) throw new Error("OpenAPI input value must be the caller envelope object");
  for (const key of Object.keys(value)) {
    if (key !== "parameters" && key !== "body") {
      throw new Error(`caller envelope contains unknown top-level key ${JSON.stringify(key)}`);
    }
  }
  let parameters: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(value, "parameters")) {
    const parsed = asRecord(value.parameters);
    if (!parsed) throw new Error("caller envelope parameters member must be an object");
    parameters = parsed;
  }
  return {
    parameters,
    body: value.body,
    bodyPresent: Object.prototype.hasOwnProperty.call(value, "body"),
  };
}

/** Validates the public envelope, then lowers it into the standalone engine's private input. */
export function engineInputForCallerEnvelope(
  input: unknown,
  params: OpenAPIParameter[],
  plans: BodyPlan[],
  routes: AbstractInputRoutes,
  profile: OpenAPIExecutionProfile,
  bindingSpec?: string,
  parameterConversion?: ParameterConversion,
): unknown {
  const envelope = parseCallerEnvelope(input);
  const qualified = qualifiedParameterMode(params);
  const byCallerKey = new Map<string, AbstractParameterRoute>();
  for (const route of routes.parameters) {
    byCallerKey.set(callerParameterKey(route.in, route.name, qualified), route);
  }

  const value: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(envelope.parameters)) {
    const route = byCallerKey.get(key);
    if (!route) throw new Error(`caller envelope contains unknown parameter key ${JSON.stringify(key)}`);
    if (bindingSpec === undefined) {
      value[route.field] = member;
      continue;
    }
    const parameter = params.find((candidate) => candidate.in === route.in && candidate.name === route.name);
    try {
      value[route.field] = prepareSchemaParameterValue(
        parameter,
        member,
        bindingSpec,
        parameterConversion,
      ).value;
    } catch (error: unknown) {
      throw new Error(`parameter ${JSON.stringify(key)}: ${errorMessage(error)}`, { cause: error });
    }
  }

  const bodyDescriptor: Record<string, unknown> = {};
  if (Object.keys(routes.bodyFields).length > 0) {
    bodyDescriptor.properties = { ...routes.bodyFields };
  }
  if (routes.wholeBodyField) bodyDescriptor.whole = routes.wholeBodyField;
  if (envelope.bodyPresent) {
    const plan = plans[0];
    if (!plan) {
      throw new Error("caller envelope supplies body but the operation declares no supported request body");
    }
    if (plan.synthetic || plan.wholeObject) {
      bodyDescriptor.present = true;
      if (!routes.wholeBodyField) throw new Error("selected request representation has no whole-body route");
      value[routes.wholeBodyField] = envelope.body;
    } else {
      const body = asRecord(envelope.body);
      if (!body) throw new Error("selected request representation requires an object body");
      if (Object.keys(body).length === 0 && plan.required) {
        throw new Error("required request body received no routed value");
      }
      if (Object.keys(body).length > 0) bodyDescriptor.present = true;
      for (const [name, member] of Object.entries(body)) {
        value[routes.bodyField(name)] = bindingSpec === undefined
          ? member
          : prepareEncodingStylePropertyValue(
            plan,
            name,
            member,
            bindingSpec,
            parameterConversion,
          );
      }
    }
  }

  return [{
    $openbindings: profile.inputRouteMarker,
    value,
    parameters: routes.parameters.map((route) => ({
      in: route.in,
      name: route.engineName ?? route.name,
      field: route.field,
    })),
    body: bodyDescriptor,
  }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function planAllowsObjectPassthrough(plan: BodyPlan): boolean {
  return plan.declared && !plan.synthetic && !plan.wholeObject && plan.family === FAMILY_JSON;
}
