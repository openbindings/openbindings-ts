import {
  BINDING_SPEC_OPENAPI_30,
  BINDING_SPEC_OPENAPI_31,
} from "./constants.js";
import { convertToInterface as convertProductionInterface } from "./synthesize.js";
import {
  OpenAPIInvoker as ProductionOpenAPIInvoker,
  OpenAPISynthesizer as ProductionOpenAPISynthesizer,
} from "./invoker.js";
import type {
  BindingInvocationArgs,
  ContextRequiredDetails,
  Invocation,
} from "@openbindings/invoke";
import type { OBInterface, Source } from "@openbindings/core";
import type {
  SourceInspection,
  SynthesizeInput,
  SynthesizeResult,
} from "@openbindings/synthesize";

/** Test-fixture helper; production surfaces never infer or default a token. */
export function bindingSpecForTestDocument(content: unknown): string {
  let edition: unknown;
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    edition = (content as Record<string, unknown>).openapi;
  } else if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        edition = (parsed as Record<string, unknown>).openapi;
      }
    } catch {
      edition = /^\s*openapi\s*:\s*["']?([^\s"']+)/mu.exec(content)?.[1];
    }
  }
  return typeof edition === "string" && edition.startsWith("3.0.")
    ? BINDING_SPEC_OPENAPI_30
    : BINDING_SPEC_OPENAPI_31;
}

type ConvertArgs = Parameters<typeof convertProductionInterface>;

/** Keeps older test call sites terse while supplying an exact fixture-derived token. */
export function convertToInterface(...args: ConvertArgs): ReturnType<typeof convertProductionInterface> {
  return convertProductionInterface(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    bindingSpecForTestDocument(args[1]),
    args[7],
  );
}

function exactTestSource<T extends { content?: unknown; bindingSpec: string }>(source: T): T {
  return source.content === undefined
    ? source
    : { ...source, bindingSpec: bindingSpecForTestDocument(source.content) };
}

function exactTestInput(input: SynthesizeInput): SynthesizeInput {
  return input.sources === undefined
    ? input
    : { ...input, sources: input.sources.map((source) => exactTestSource(source)) };
}

/** Fixture-only wrappers migrate old tests without weakening production token gates. */
export class OpenAPISynthesizer extends ProductionOpenAPISynthesizer {
  override synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    return super.synthesizeInterface(exactTestInput(input), options);
  }

  override synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    return super.synthesizeInterfaceWithCoverage(exactTestInput(input), options);
  }

  override inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    return super.inspectSource(exactTestSource(source), options);
  }
}

export class OpenAPIInvoker extends ProductionOpenAPIInvoker {
  override invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const exactArgs = { ...args, source: exactTestSource(args.source) };
    const invocation = super.invokeBinding<I, O>(exactArgs);
    const write = invocation.write.bind(invocation);
    Object.defineProperty(invocation, "write", {
      configurable: true,
      value: (value: I) => write(legacyTestEnvelope(exactArgs, value) as I),
    });
    return invocation;
  }

  override prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    return super.prepareBinding({ ...args, source: exactTestSource(args.source) });
  }
}

/** Converts pre-M1 test fixture values only; it is neither exported by nor reachable from the package. */
function legacyTestEnvelope(args: BindingInvocationArgs, input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { body: input };
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.every((key) => key === "parameters" || key === "body")) return input;

  const document = parsedTestDocument(args.source.content);
  const target = /^#\/paths\/([^/]+)\/(get|put|post|delete|options|head|patch|trace)$/u.exec(args.selector);
  if (!document || !target) return input;
  const path = target[1]!.replaceAll("~1", "/").replaceAll("~0", "~");
  const method = target[2]!;
  const pathItem = asTestRecord(asTestRecord(document.paths)?.[path]);
  const operation = asTestRecord(pathItem?.[method]);
  if (!pathItem || !operation) return input;

  const rawParameters: unknown[] = [
    ...asTestArray(pathItem.parameters),
    ...asTestArray(operation.parameters),
  ];
  const parameters = rawParameters.map((raw) => resolveTestReference(document, raw))
    .filter((raw): raw is TestParameter => raw !== undefined
      && typeof raw.name === "string" && typeof raw.in === "string");
  const qualified = parameters.some((parameter, index) => parameters.some((other, otherIndex) =>
    otherIndex !== index && other.name === parameter.name && other.in !== parameter.in));
  const callerParameters: Record<string, unknown> = {};
  const consumed = new Set<string>();
  for (const parameter of parameters) {
    const name = parameter.name;
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    const callerKey = qualified
      ? `${parameter.in}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`
      : name;
    callerParameters[callerKey] = value[name];
    consumed.add(name);
  }

  const envelope: Record<string, unknown> = {};
  if (Object.keys(callerParameters).length > 0) envelope.parameters = callerParameters;
  const remaining = Object.fromEntries(
    Object.entries(value).filter(([name]) => !consumed.has(name)),
  );
  const ignoresBody = args.source.bindingSpec === BINDING_SPEC_OPENAPI_30
    && ["get", "head", "delete", "options", "trace"].includes(method)
    || args.source.bindingSpec === BINDING_SPEC_OPENAPI_31 && method === "trace";
  if (!ignoresBody && operation.requestBody !== undefined) {
    const requestBody = resolveTestReference(document, operation.requestBody);
    const content = asTestRecord(requestBody?.content);
    const media = asTestRecord(content?.[Object.keys(content ?? {})[0] ?? ""]);
    const schema = resolveTestReference(document, media?.schema);
    const objectBody = schema?.type === "object" || asTestRecord(schema?.properties) !== undefined;
    if (!objectBody && Object.prototype.hasOwnProperty.call(remaining, "body")) {
      envelope.body = remaining.body;
      for (const [name, member] of Object.entries(remaining)) {
        if (name !== "body") envelope[name] = member;
      }
    } else if (Object.keys(remaining).length > 0) {
      envelope.body = remaining;
    }
  } else {
    for (const [name, member] of Object.entries(remaining)) envelope[name] = member;
  }
  return Object.keys(envelope).length > 0 ? envelope : input;
}

function parsedTestDocument(content: unknown): Record<string, unknown> | undefined {
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content !== "string") return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    return asTestRecord(parsed);
  } catch {
    return undefined;
  }
}

function resolveTestReference(
  document: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> | undefined {
  const value = asTestRecord(raw);
  if (!value || typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) return value;
  let current: unknown = document;
  for (const token of value.$ref.slice(2).split("/")) {
    current = asTestRecord(current)?.[token.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return asTestRecord(current);
}

function asTestRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type TestParameter = Record<string, unknown> & { name: string; in: string };

function asTestArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((member: unknown) => member) : [];
}
