import { InvocationError, type BindingInvocationArgs, type InvocationImpl } from "@openbindings/invoke";
import {
  Swagger20Number,
  Swagger20ExecutionError,
  prepareSwagger20,
  type Swagger20Input,
  type Swagger20ContentCodec,
  type Swagger20ParameterInfo,
  type Swagger20Parameters,
  type Swagger20SecurityCredentials,
  type Swagger20Source,
} from "@openbindings/openapi-client/engine";

export interface Swagger20AdapterOptions {
  parameterConversion?: (value: unknown) => string;
  requestContentCodings?: ReadonlyMap<string, Swagger20ContentCodec>;
  responseContentCodings?: ReadonlyMap<string, Swagger20ContentCodec>;
}

/**
 * Edition-specific adapter dispatch. This file owns only SDK vocabulary;
 * artifact loading, reference resolution, and selector meaning stay in the
 * standalone client's native Swagger 2.0 lane.
 */
export async function runSwagger20Adapter<I, O>(
  args: BindingInvocationArgs,
  invocation: InvocationImpl<I, O>,
  options: Swagger20AdapterOptions = {},
): Promise<void> {
  const source: Swagger20Source = {
    ...(args.source.location !== undefined ? { location: args.source.location } : {}),
    ...(args.source.content !== undefined ? { content: args.source.content } : {}),
  };
  const configuration = swagger20Configuration(args.context);
  let prepared;
  try {
    prepared = await prepareSwagger20({
      source,
      ref: args.selector,
      context: args.context,
      signal: args.signal,
      fetch: args.fetch,
      server: configuration.server,
      serverSchemeIndex: configuration.serverSchemeIndex,
      securityAlternative: configuration.securityAlternative,
      securityCredentials: swagger20Credentials(args.context),
      emptyValueForm: configuration.emptyValueForm,
      parameterConverter: options.parameterConversion,
      requestMedia: configuration.requestMedia,
      propertyMedia: configuration.propertyMedia,
      requestContentCodings: options.requestContentCodings,
      responseContentCodings: options.responseContentCodings,
    });
  } catch (error: unknown) {
    throw bridgeSwagger20Error(error);
  }

  let parameters: Swagger20ParameterInfo[];
  try {
    parameters = await prepared.parameters();
  } catch (error: unknown) {
    throw bridgeSwagger20Error(error);
  }
  const iterator = invocation.inputs()[Symbol.asyncIterator]();
  const first = await iterator.next();
  await invocation.closeInput();
  try {
    const input = first.done ? {} : swagger20InputForCallerEnvelope(first.value, parameters);
    const result = await prepared.execute(input);
    if (result.outputPresent) await invocation.emitOutput(result.output as O);
    invocation.closeOutput();
  } catch (error: unknown) {
    throw bridgeSwagger20Error(error);
  }
}

interface Swagger20RuntimeConfiguration {
  server?: string;
  serverSchemeIndex?: number;
  securityAlternative?: number;
  emptyValueForm?: "name-only" | "empty";
  requestMedia?: string;
  propertyMedia?: Record<string, string>;
}

function swagger20Configuration(context: Record<string, unknown> | undefined): Swagger20RuntimeConfiguration {
  const raw = asRecord(context?.configuration) ?? {};
  const result: Swagger20RuntimeConfiguration = {};
  if (Object.hasOwn(raw, "server")) {
    const server = raw.server;
    if (typeof server === "string" && server !== "") result.server = server;
    else {
      const object = asRecord(server);
      if (!object || Object.keys(object).length !== 1) throw new InvocationError("ERR_REFUSED");
      if (Object.hasOwn(object, "index")) {
        if (!Number.isSafeInteger(object.index) || (object.index as number) < 0) throw new InvocationError("ERR_REFUSED");
        result.serverSchemeIndex = object.index as number;
      } else if (typeof object.baseUrl === "string" && object.baseUrl !== "") result.server = object.baseUrl;
      else throw new InvocationError("ERR_REFUSED");
    }
  }
  if (Object.hasOwn(raw, "security")) {
    const security = asRecord(raw.security);
    if (!security || Object.keys(security).length !== 1 || !Number.isSafeInteger(security.index)
      || (security.index as number) < 0) throw new InvocationError("ERR_REFUSED");
    result.securityAlternative = security.index as number;
  }
  if (Object.hasOwn(raw, "emptyValueForm")) {
    if (raw.emptyValueForm !== "name-only" && raw.emptyValueForm !== "empty") throw new InvocationError("ERR_REFUSED");
    result.emptyValueForm = raw.emptyValueForm;
  }
  if (Object.hasOwn(raw, "requestMedia")) {
    if (typeof raw.requestMedia !== "string" || raw.requestMedia === "") throw new InvocationError("ERR_REFUSED");
    result.requestMedia = raw.requestMedia;
  }
  if (Object.hasOwn(raw, "propertyMedia")) {
    const propertyMedia = asRecord(raw.propertyMedia);
    if (!propertyMedia) throw new InvocationError("ERR_REFUSED");
    result.propertyMedia = {};
    for (const [name, media] of Object.entries(propertyMedia)) {
      if (typeof media !== "string" || media === "") throw new InvocationError("ERR_REFUSED");
      result.propertyMedia[name] = media;
    }
  }
  return result;
}

function swagger20Credentials(context: Record<string, unknown> | undefined): Swagger20SecurityCredentials {
  const result: Swagger20SecurityCredentials = { basic: {}, apiKeys: {}, oauth2: {} };
  const add = (values: Record<string, unknown> | undefined): void => {
    for (const [name, raw] of Object.entries(values ?? {})) {
      if (typeof raw === "string") {
        result.apiKeys![name] = raw;
        continue;
      }
      const credential = asRecord(raw);
      if (!credential) continue;
      const userId = typeof credential.userId === "string" ? credential.userId
        : typeof credential.username === "string" ? credential.username : undefined;
      if (userId !== undefined && typeof credential.password === "string") {
        result.basic![name] = { userId, password: credential.password };
      }
      if (typeof credential.accessToken === "string") {
        const scopes = credential.scopes === undefined ? []
          : Array.isArray(credential.scopes) && credential.scopes.every((scope) => typeof scope === "string")
            ? credential.scopes as string[] : undefined;
        if (scopes) result.oauth2![name] = { accessToken: credential.accessToken, scopes };
      }
    }
  };
  add(asRecord(context?.credentials));
  add(asRecord(context?.apiKeys));
  return result;
}

function swagger20InputForCallerEnvelope(input: unknown, parameters: Swagger20ParameterInfo[]): Swagger20Input {
  const envelope = asRecord(input);
  if (!envelope) throw new InvocationError("ERR_REFUSED");
  for (const key of Object.keys(envelope)) {
    if (key !== "parameters" && key !== "body") throw new InvocationError("ERR_REFUSED");
  }
  const supplied = Object.hasOwn(envelope, "parameters") ? asRecord(envelope.parameters) : {};
  if (!supplied) throw new InvocationError("ERR_REFUSED");
  const locations = new Map<string, string>();
  let qualified = false;
  for (const parameter of parameters) {
    if (parameter.in === "body") continue;
    const previous = locations.get(parameter.name);
    if (previous !== undefined && previous !== parameter.in) qualified = true;
    locations.set(parameter.name, parameter.in);
  }
  const byKey = new Map<string, Swagger20ParameterInfo>();
  for (const parameter of parameters) {
    if (parameter.in === "body") continue;
    const key = qualified ? `${parameter.in}/${escapePointerToken(parameter.name)}` : parameter.name;
    byKey.set(key, parameter);
  }
  const native: Swagger20Parameters = { path: {}, query: {}, header: {}, formData: {} };
  for (const [key, value] of Object.entries(supplied)) {
    const parameter = byKey.get(key);
    if (!parameter || parameter.in === "body") throw new InvocationError("ERR_REFUSED");
    native[parameter.in]![parameter.name] = value;
  }
  return {
    parameters: native,
    ...(Object.hasOwn(envelope, "body") ? { body: envelope.body, bodyPresent: true } : {}),
  };
}

function escapePointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Swagger20Number)
    ? value as Record<string, unknown>
    : undefined;
}

export function bridgeSwagger20Error(error: unknown): InvocationError {
  if (error instanceof InvocationError) return new InvocationError(error.code, error.data);
  if (!(error instanceof Swagger20ExecutionError)) return new InvocationError("ERR_RUNTIME");
  const code = error.code === "SOURCE_LOAD_FAILED" ? "ERR_SOURCE_LOAD_FAILED"
    : error.code === "INVALID_OPERATION_REF" ? "ERR_INVALID_SELECTOR"
    : error.code === "OPERATION_NOT_FOUND" ? "ERR_SELECTOR_NOT_FOUND"
    : error.code;
  return error.details === undefined ? new InvocationError(code) : new InvocationError(code, error.details);
}
