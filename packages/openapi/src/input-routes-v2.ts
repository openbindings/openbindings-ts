import type { OpenAPIOperation, OpenAPIParameter } from "./types.js";
import { BINDING_SPEC_V2 } from "./constants.js";
import {
  FAMILY_JSON,
  type BodyPlan,
} from "./media.js";
import {
  MissingPathParamError,
  routeParameter,
  type RoutedInput,
} from "./params.js";
import { codePointCompare } from "./util.js";

export interface AbstractParameterRoute {
  in: string;
  name: string;
  field: string;
}

/**
 * Synthesis-only correspondence between distinct OpenAPI declarations and
 * protocol-neutral operation property names. Concrete identity is carried to
 * the binding side by a core inputTransform, never by the operation schema.
 */
export interface AbstractInputRoutes {
  parameters: AbstractParameterRoute[];
  bodyFields: Record<string, string>;
  wholeBodyField: string;
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

/**
 * Preserves every unique author name. Duplicate declarations receive the
 * first unused numeric suffix, while all authored base names stay reserved
 * so a generated suffix never steals a different declaration's name.
 */
export function planAbstractInputRoutes(
  params: OpenAPIParameter[],
  plans: BodyPlan[],
  bindingSpec: string = BINDING_SPEC_V2,
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
  let dynamicObjectBody = false;
  for (const plan of plans) {
    if (plan.synthetic || plan.wholeObject) {
      wholeBody = true;
      dynamicObjectBody ||= plan.wholeObject === true;
    } else {
      for (const name of plan.props ?? []) bodyNames.add(name);
    }
  }
  for (const name of [...bodyNames].sort(codePointCompare)) {
    slots.push({ kind: "body", inValue: "", name, base: name });
  }
  if (wholeBody) {
    slots.push({ kind: "wholeBody", inValue: "", name: "", base: dynamicObjectBody ? "payload" : "body" });
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
  // A dynamic object uses a protocol-neutral public field and therefore
  // always needs the private whole-body route, even without a collision.
  const needsTransform = dynamicObjectBody
    || slots.some((slot, index) => assigned[index] !== slot.base);

  return {
    parameters,
    bodyFields,
    wholeBodyField,
    needsTransform,
    parameterField(inValue, name) {
      return parameters.find((route) => route.in === inValue && route.name === name)?.field ?? name;
    },
    bodyField(name) {
      return bodyFields[name] ?? name;
    },
    transformExpression() {
      const body: Record<string, unknown> = {};
      if (Object.keys(bodyFields).length > 0) body.properties = bodyFields;
      if (wholeBodyField) body.whole = wholeBodyField;
      return `[{"$openbindings":${JSON.stringify(bindingSpec)},"value":$,"parameters":${JSON.stringify(parameters)},"body":${JSON.stringify(body)}}]`;
    },
  };
}

/**
 * Detects ambiguity that exists before request-media candidate election: one
 * supplied flat field naming multiple independently declared parameters.
 * Parameter/body collisions remain candidate-specific.
 */
export function flatInputHasAmbiguousParameter(
  params: OpenAPIParameter[],
  input: Record<string, unknown>,
): boolean {
  const seen = new Set<string>();
  for (const parameter of params) {
    const name = parameter.name ?? "";
    if (!name) continue;
    if (seen.has(name) && Object.prototype.hasOwnProperty.call(input, name)) return true;
    seen.add(name);
  }
  return false;
}

export interface RoutedEnvelope {
  value: Record<string, unknown>;
  parameters: AbstractParameterRoute[];
  bodyFields: Record<string, string>;
  wholeBodyField: string;
}

export function parseRoutedEnvelope(
  input: unknown,
  bindingSpec: string = BINDING_SPEC_V2,
): RoutedEnvelope | null {
  const revision = bindingSpec === BINDING_SPEC_V2 ? "revision-2" : "revision-3";
  if (!Array.isArray(input)) return null;
  if (input.length !== 1) {
    throw new Error(`${revision} routed input must be an exact one-item array`);
  }
  const envelope = asRecord(input[0]);
  if (!envelope) throw new Error(`${revision} routed input array item must be an object`);
  if (!("$openbindings" in envelope)) {
    throw new Error(`${revision} routed input array item requires $openbindings marker`);
  }
  if (
    Object.keys(envelope).length !== 4
    || envelope.value === undefined
    || envelope.parameters === undefined
    || envelope.body === undefined
  ) {
    throw new Error(
      `${revision} routed input array item must contain exactly $openbindings, value, parameters, and body`,
    );
  }
  if (envelope.$openbindings !== bindingSpec) {
    throw new Error(`${revision} routed input has invalid $openbindings marker ${JSON.stringify(envelope.$openbindings)}`);
  }
  const value = asRecord(envelope.value);
  if (!value) throw new Error(`${revision} routed input value must be a JSON object`);

  const rawParameters = envelope.parameters ?? [];
  if (!Array.isArray(rawParameters)) {
    throw new Error(`${revision} routed input parameters must be an array`);
  }
  const parameters: AbstractParameterRoute[] = [];
  const seen = new Set<string>();
  const seenFields = new Set<string>();
  for (const raw of rawParameters) {
    const entry = asRecord(raw);
    if (!entry) throw new Error(`${revision} routed parameter entry must be an object`);
    const inValue = typeof entry.in === "string" ? entry.in : "";
    const name = typeof entry.name === "string" ? entry.name : "";
    const field = typeof entry.field === "string" ? entry.field : "";
    if (!inValue || !name || !field) {
      throw new Error(`${revision} routed parameter entry requires non-empty in, name, and field`);
    }
    const identity = `${inValue}\u0000${name}`;
    if (seen.has(identity)) {
      throw new Error(`${revision} routed input repeats parameter ${JSON.stringify(name)} in ${JSON.stringify(inValue)}`);
    }
    if (seenFields.has(field)) {
      throw new Error(`${revision} routed input field ${JSON.stringify(field)} supplies more than one destination`);
    }
    seen.add(identity);
    seenFields.add(field);
    parameters.push({ in: inValue, name, field });
  }

  const bodyFields: Record<string, string> = {};
  let wholeBodyField = "";
  if (envelope.body !== undefined) {
    const body = asRecord(envelope.body);
    if (!body) throw new Error(`${revision} routed input body descriptor must be an object`);
    if (body.properties !== undefined) {
      const properties = asRecord(body.properties);
      if (!properties) throw new Error(`${revision} routed body properties must be an object`);
      for (const [name, rawField] of Object.entries(properties)) {
        if (!name || typeof rawField !== "string" || !rawField) {
          throw new Error(`${revision} routed body property mappings require non-empty string names and fields`);
        }
        if (seenFields.has(rawField)) {
          throw new Error(`${revision} routed input field ${JSON.stringify(rawField)} supplies more than one destination`);
        }
        seenFields.add(rawField);
        bodyFields[name] = rawField;
      }
    }
    if (body.whole !== undefined) {
      if (typeof body.whole !== "string" || !body.whole) {
        throw new Error(`${revision} routed whole-body field must be a non-empty string`);
      }
      if (seenFields.has(body.whole)) {
        throw new Error(`${revision} routed input field ${JSON.stringify(body.whole)} supplies more than one destination`);
      }
      seenFields.add(body.whole);
      wholeBodyField = body.whole;
    }
  }
  return { value, parameters, bodyFields, wholeBodyField };
}

/** Proves that every concrete identity in the private envelope exists. */
export function validateEnvelopeRoutes(
  params: OpenAPIParameter[],
  plans: BodyPlan[],
  envelope: RoutedEnvelope,
  bindingSpec: string = BINDING_SPEC_V2,
): void {
  const revision = bindingSpec === BINDING_SPEC_V2 ? "revision-2" : "revision-3";
  const knownParameters = new Set(
    params
      .filter((parameter) => parameter.name && parameter.in)
      .map((parameter) => `${parameter.in}\u0000${parameter.name}`),
  );
  for (const route of envelope.parameters) {
    if (!knownParameters.has(`${route.in}\u0000${route.name}`)) {
      throw new Error(
        `${revision} routed parameter ${JSON.stringify(route.name)} in ${JSON.stringify(route.in)} does not identify an effective OpenAPI declaration`,
      );
    }
  }

  const knownBodyFields = new Set<string>();
  let wholeBody = false;
  for (const plan of plans) {
    if (plan.synthetic || plan.wholeObject) wholeBody = true;
    else for (const name of plan.props ?? []) knownBodyFields.add(name);
  }
  for (const name of Object.keys(envelope.bodyFields)) {
    if (!knownBodyFields.has(name)) {
      throw new Error(
        `${revision} routed body property ${JSON.stringify(name)} does not identify a property in any admissible request-body candidate`,
      );
    }
  }
  if (envelope.wholeBodyField && !wholeBody) {
    throw new Error(
      `${revision} routed whole-body field does not identify any admissible whole-value request-body candidate`,
    );
  }
}

/** Maps the revision-2 source representation onto the existing wire accumulator. */
export function routeEnvelope(
  params: OpenAPIParameter[],
  envelope: RoutedEnvelope,
  pathTemplate: string,
  plan: BodyPlan | null,
  bindingSpec: string = BINDING_SPEC_V2,
): RoutedInput {
  const routed: RoutedInput = {
    resolvedPath: pathTemplate,
    queryUnits: [],
    headers: [],
    cookieUnits: [],
    bodyFields: {},
    bodyValue: undefined,
    bodySet: false,
    populated: { header: new Set(), query: new Set(), cookie: new Set() },
  };
  const consumed = new Set<string>();
  const missingPath: string[] = [];

  for (const parameter of params) {
    if (!parameter.name || !parameter.in) continue;
    const mapping = envelope.parameters.find(
      (route) => route.in === parameter.in && route.name === parameter.name,
    );
    if (!mapping || !(mapping.field in envelope.value)) {
      if (parameter.in === "path") missingPath.push(parameter.name);
      continue;
    }
    consumed.add(mapping.field);
    routeParameter(routed, parameter, envelope.value[mapping.field], bindingSpec);
  }
  if (missingPath.length > 0) {
    missingPath.sort(codePointCompare);
    throw new MissingPathParamError(
      `missing path parameter(s) ${missingPath.join(", ")}: the URL cannot be built without them`,
    );
  }

  if (plan?.declared) {
    if (plan.synthetic || plan.wholeObject) {
      if (envelope.wholeBodyField && envelope.wholeBodyField in envelope.value) {
        routed.bodyValue = envelope.value[envelope.wholeBodyField];
        routed.bodySet = true;
        consumed.add(envelope.wholeBodyField);
      }
    } else {
      for (const bodyName of Object.keys(envelope.bodyFields).sort(codePointCompare)) {
        const field = envelope.bodyFields[bodyName]!;
        if (!(field in envelope.value)) continue;
        if (!plan.props?.has(bodyName)) continue;
        routed.bodyFields[bodyName] = envelope.value[field];
        consumed.add(field);
      }
    }
  }

  const unmatched: string[] = [];
  for (const name of Object.keys(envelope.value).sort(codePointCompare)) {
    if (consumed.has(name)) continue;
    // Body-property routes describe candidate-specific destinations. A
    // field reserved by some other candidate is still an unmatched field
    // for the selected open JSON object and therefore passes through. The
    // abstract envelope must not make one candidate's route table close a
    // different candidate's otherwise-open JSON body.
    if (plan?.declared && !plan.synthetic && !plan.wholeObject && plan.family === FAMILY_JSON) {
      routed.bodyFields[name] = envelope.value[name];
    } else {
      unmatched.push(name);
    }
  }
  if (unmatched.length > 0) {
    throw new Error(
      `field(s) ${unmatched.join(", ")} have no destination in the selected OpenAPI request representation`,
    );
  }
  return routed;
}

export function envelopeWillEmitBody(
  envelope: RoutedEnvelope,
  op: OpenAPIOperation,
): boolean {
  if (op.requestBody == null) return false;
  if (op.requestBody.required === true) return true;
  const parameterFields = new Set(envelope.parameters.map((route) => route.field));
  return Object.keys(envelope.value).some((name) => !parameterFields.has(name));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
