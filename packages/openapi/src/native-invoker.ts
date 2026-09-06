import { canonicalize, checkBindingSpecs as checkBindingSpecSupport, type BindingSpecInfo, type BindingSpecVerdict } from "@openbindings/core";
import {
  CONTEXT_REQUIRED,
  InvocationError,
  InvocationImpl,
  contextConfiguration,
  type BindingInvoker,
  type BindingInvocationArgs,
  type ContextRequiredDetails,
  type ContextRequirement,
  type Invocation,
} from "@openbindings/invoke";
import {
  OPENAPI_USE_DEFAULT,
  OpenAPIClient,
  OpenAPIClientError,
  type OpenAPIAuthValue,
  type OpenAPICallInput,
  type OpenAPICallOptions,
  type OpenAPICharacterDecoder,
  type OpenAPICharacterEncoder,
  type OpenAPIClientHooks,
  type OpenAPIConfigurationRequirement,
  type OpenAPIConfigurationRequirements,
  type OpenAPIContentCodec,
  type OpenAPIOperationAnalysis,
  type OpenAPIParameterConverter,
  type OpenAPIRedirectPolicy,
  type OpenAPISecurityHandler,
  type OpenAPIServerSelection,
  type OpenAPISource,
} from "@openbindings/openapi-client";
import {
  BINDING_SPEC_OPENAPI_20,
  BINDING_SPEC_OPENAPI_30,
  BINDING_SPEC_OPENAPI_31,
  BINDING_SPEC_OPENAPI_32,
  ERR_UNSUPPORTED_BINDING_SPEC,
  checkAcceptedOpenAPIEdition,
} from "./constants.js";

/** Construction-time capabilities shared by every invocation of one adapter. */
export interface OpenAPIInvokerOptions {
  parameterConversion?: OpenAPIParameterConverter;
  securityHandlers?: Record<string, OpenAPISecurityHandler>;
  requestContentCodings?: Record<string, OpenAPIContentCodec>;
  responseContentCodings?: Record<string, OpenAPIContentCodec>;
  requestCharacterEncodings?: Record<string, OpenAPICharacterEncoder>;
  responseCharacterEncodings?: Record<string, OpenAPICharacterDecoder>;
  redirect?: OpenAPIRedirectPolicy;
}

/**
 * The OpenBindings protocol adapter over the standalone native OpenAPI client.
 * It owns only boundary translation: source identity, flat OBI input routing,
 * context requirements, lifecycle, hooks, and portable failure data.
 */
export class OpenAPIInvoker implements BindingInvoker {
  private static readonly MAX_SOURCE_CLIENTS = 64;
  private readonly options: Readonly<OpenAPIInvokerOptions>;
  private readonly sourceClients = new Map<string, Promise<OpenAPIClient>>();

  constructor(options: OpenAPIInvokerOptions = {}) {
    this.options = {
      ...options,
      ...(options.securityHandlers ? { securityHandlers: { ...options.securityHandlers } } : {}),
      ...(options.requestContentCodings ? { requestContentCodings: { ...options.requestContentCodings } } : {}),
      ...(options.responseContentCodings ? { responseContentCodings: { ...options.responseContentCodings } } : {}),
      ...(options.requestCharacterEncodings ? { requestCharacterEncodings: { ...options.requestCharacterEncodings } } : {}),
      ...(options.responseCharacterEncodings ? { responseCharacterEncodings: { ...options.responseCharacterEncodings } } : {}),
    };
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkBindingSpecSupport(bindingSpecs, openAPIBindingSpecs());
  }

  bindingSpecs(): BindingSpecInfo[] {
    return openAPIBindingSpecs();
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const invocation = new InvocationImpl<I, O>({ signal: args.signal });
    queueMicrotask(() => {
      this.run(args, invocation).catch((error: unknown) => invocation.fireError(toInvocationError(error)));
    });
    return invocation;
  }

  async prepareBinding(args: BindingInvocationArgs): Promise<ContextRequiredDetails | null> {
    try {
      assertRegisteredBindingSpec(args.source.bindingSpec);
      const client = await this.clientForPrepare(args);
      if (!client) return null;
      assertEdition(args.source.bindingSpec, client.edition);
      const base = callOptions(args, this.options);
      const input = configuredInput(args.context);
      const credentials = await selectedCredentials(client, args.selector, input, base);
      const options = { ...base, auth: { ...(base.auth ?? {}), ...authFromContext(args.context, credentials) } };
      return bindingRequirements(await client.preflight({ ref: args.selector }, input, options));
    } catch (error: unknown) {
      const mapped = toInvocationError(error);
      if (mapped.code === CONTEXT_REQUIRED) return mapped.data as ContextRequiredDetails;
      // `prepareBinding` is advisory for non-context failures; invocation
      // remains the authoritative terminal for source and selector errors.
      if (mapped.code !== "ERR_REFUSED") return null;
      throw mapped;
    }
  }

  private async run<I, O>(args: BindingInvocationArgs, outer: InvocationImpl<I, O>): Promise<void> {
    assertRegisteredBindingSpec(args.source.bindingSpec);
    const client = await this.clientForRun(args);
    assertEdition(args.source.bindingSpec, client.edition);
    const base = { ...callOptions(args, this.options), signal: outer.signal };
    const configured = configuredInput(args.context);
    const credentials = await selectedCredentials(client, args.selector, configured, base);
    const options = { ...base, auth: { ...(base.auth ?? {}), ...authFromContext(args.context, credentials) } };
    const requirements = await client.preflight({ ref: args.selector }, configured, options);
    const contextRequirements = bindingRequirements(requirements);
    if (contextRequirements) throw new InvocationError(CONTEXT_REQUIRED, contextRequirements);

    const operation = await client.analyzeOperation({ ref: args.selector });

    const hasInputLane = operation.parameters.length > 0 || operation.requestBodies.length > 0;
    let input = configured;
    if (hasInputLane) {
      const iterator = outer.inputs()[Symbol.asyncIterator]();
      const first = await iterator.next();
      await outer.closeInput();
      if (!first.done) {
        input = { ...bindingInput(operation, first.value, configured.mediaType, client.edition), ...configured };
      }
    } else {
      // Closing first makes a zero-input operation self-starting while retaining
      // any input the caller already queued.  Such queued input must still pass
      // the binding's closed-envelope check; it cannot be silently discarded.
      await outer.closeInput();
      const first = await outer.inputs()[Symbol.asyncIterator]().next();
      if (!first.done) {
        input = { ...bindingInput(operation, first.value, configured.mediaType, client.edition), ...configured };
      }
    }
    const result = await client.stream<O, unknown>({ ref: args.selector }, input, options);
    if (!result.ok) {
      throw result.openapi.declared && result.openapi.mediaType !== undefined
        && Object.hasOwn(result, "error") && result.error !== undefined
        ? new InvocationError("ERR_EXECUTION_FAILED", portableOutput(result.error))
        : new InvocationError("ERR_EXECUTION_FAILED");
    }
    try {
      for await (const event of result.events) {
        const data = portableOutput(event.data);
        await outer.emitOutput((event.sse
          ? {
            ...(event.sse.event !== undefined ? { event: event.sse.event } : {}),
            data,
            ...(event.sse.id !== undefined ? { id: event.sse.id } : {}),
            ...(event.sse.retry !== undefined ? { retry: event.sse.retry } : {}),
          }
          : data) as O);
      }
      await result.closed;
      outer.closeOutput();
    } catch (error: unknown) {
      await result.cancel().catch(() => undefined);
      if (error instanceof OpenAPIClientError && error.applicationFailure) {
        throw new InvocationError("ERR_EXECUTION_FAILED", portableOutput(error.applicationFailure.data));
      }
      throw error;
    }
  }

  private async clientForPrepare(args: BindingInvocationArgs): Promise<OpenAPIClient | undefined> {
    const key = await sourceClientKey(args);
    if (key) {
      const cached = this.cachedSourceClient(args, key);
      if (cached) return cached;
    }
    return Object.hasOwn(args.source, "content") ? loadClient(args, false) : undefined;
  }

  private async clientForRun(args: BindingInvocationArgs): Promise<OpenAPIClient> {
    const key = await sourceClientKey(args);
    if (!key) return loadClient(args);
    const present = this.cachedSourceClient(args, key);
    if (present) return present;
    const pending = loadClient(args, true);
    this.sourceClients.set(key, pending);
    if (this.sourceClients.size > OpenAPIInvoker.MAX_SOURCE_CLIENTS) {
      const oldest = this.sourceClients.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.sourceClients.delete(oldest);
    }
    pending.catch(() => {
      if (this.sourceClients.get(key) === pending) this.sourceClients.delete(key);
    });
    return pending;
  }

  private cachedSourceClient(
    args: BindingInvocationArgs,
    key: string,
  ): Promise<OpenAPIClient> | undefined {
    const exact = this.sourceClients.get(key);
    if (Object.hasOwn(args.source, "content") || !args.source.location) return exact;
    const prefix = sourceLocationClientPrefix(args);
    const keys = [...this.sourceClients.keys()];
    for (let index = keys.length - 1; index >= 0; index--) {
      const candidate = keys[index]!;
      if (candidate.startsWith(prefix)) return this.sourceClients.get(candidate);
    }
    return undefined;
  }
}

function openAPIBindingSpecs(): BindingSpecInfo[] {
  return [
    { bindingSpec: BINDING_SPEC_OPENAPI_20, description: "Swagger 2.0 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_30, description: "OpenAPI 3.0 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_31, description: "OpenAPI 3.1 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_32, description: "OpenAPI 3.2 HTTP APIs" },
  ];
}

async function loadClient(args: BindingInvocationArgs, allowDocumentFetch = true): Promise<OpenAPIClient> {
  const source: OpenAPISource = {
    ...(args.source.location ? { location: args.source.location } : {}),
    ...(Object.hasOwn(args.source, "content") ? { content: args.source.content } : {}),
  };
  return OpenAPIClient.load(source, {
    documentFetch: allowDocumentFetch
      ? args.fetch
      : () => Promise.reject(new Error("prepareBinding does not retrieve external OpenAPI resources")),
    documentSignal: args.signal,
  });
}

async function sourceClientKey(args: BindingInvocationArgs): Promise<string | undefined> {
  if (Object.hasOwn(args.source, "content")) {
    const content = canonicalize(args.source.content);
    return content === undefined
      ? undefined
      : `${sourceLocationClientPrefix(args)}${await sha256(content)}`;
  }
  return args.source.location
    ? `${sourceLocationClientPrefix(args)}location-only`
    : undefined;
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("OpenAPI source caching requires Web Crypto SHA-256");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function sourceLocationClientPrefix(args: BindingInvocationArgs): string {
  return `${args.source.bindingSpec}\u0000location\u0000${args.source.location ?? ""}\u0000content\u0000`;
}

function assertRegisteredBindingSpec(bindingSpec: string): void {
  if (![BINDING_SPEC_OPENAPI_20, BINDING_SPEC_OPENAPI_30, BINDING_SPEC_OPENAPI_31, BINDING_SPEC_OPENAPI_32].includes(bindingSpec)) {
    throw new InvocationError(ERR_UNSUPPORTED_BINDING_SPEC, { bindingSpec });
  }
}

function assertEdition(bindingSpec: string, edition: string): void {
  try {
    checkAcceptedOpenAPIEdition(bindingSpec, edition);
  } catch {
    if (![BINDING_SPEC_OPENAPI_20, BINDING_SPEC_OPENAPI_30, BINDING_SPEC_OPENAPI_31, BINDING_SPEC_OPENAPI_32].includes(bindingSpec)) {
      throw new InvocationError(ERR_UNSUPPORTED_BINDING_SPEC, { bindingSpec });
    }
    throw new InvocationError("ERR_SOURCE_LOAD_FAILED");
  }
}

function bindingInput(
  operation: Readonly<OpenAPIOperationAnalysis>,
  input: unknown,
  mediaType: string | undefined,
  edition: string,
): OpenAPICallInput {
  const envelope = record(input);
  if (!envelope) throw new InvocationError("ERR_REFUSED");
  const extra = Object.keys(envelope).find((name) => name !== "parameters" && name !== "body");
  if (extra !== undefined) throw new InvocationError("ERR_REFUSED");
  const flat = envelope.parameters === undefined ? {} : record(envelope.parameters);
  if (!flat) throw new InvocationError("ERR_REFUSED");
  const routed: NonNullable<OpenAPICallInput["parameters"]> = {};
  const formData: Record<string, unknown> = {};
  const claimed = new Set<string>();
  for (const parameter of operation.parameters) {
    if (parameter.in === "body") continue;
    if (!Object.hasOwn(flat, parameter.inputKey)) continue;
    if (parameter.in === "formData") formData[parameter.name] = flat[parameter.inputKey];
    else (routed[parameter.in] ??= {})[parameter.name] = flat[parameter.inputKey];
    claimed.add(parameter.inputKey);
  }
  if (Object.keys(flat).some((name) => !claimed.has(name))) throw new InvocationError("ERR_REFUSED");
  if (Object.keys(formData).length > 0 && Object.hasOwn(envelope, "body")) throw new InvocationError("ERR_REFUSED");
  let body = Object.hasOwn(envelope, "body") ? envelope.body : undefined;
  let bodyPresent = Object.hasOwn(envelope, "body");
  if (Object.keys(formData).length > 0) {
    body = formData;
    bodyPresent = true;
  }
  if (bodyPresent && edition !== "2.0") {
    const bodyAnalysis = selectedBodyAnalysis(operation, mediaType);
    if (bodyAnalysis?.base64) {
      body = decodeBase64(body);
    } else if (bodyAnalysis && bodyAnalysis.base64Properties.length > 0) {
      const object = record(body);
      if (!object) throw new InvocationError("ERR_REFUSED");
      const decoded = { ...object };
      for (const name of bodyAnalysis.base64Properties) {
        if (Object.hasOwn(decoded, name)) decoded[name] = boundaryBase64(decoded[name]);
      }
      body = decoded;
    }
  }
  return {
    ...(Object.keys(routed).length > 0 ? { parameters: routed } : {}),
    ...(bodyPresent ? { body } : {}),
  };
}

function selectedBodyAnalysis(operation: Readonly<OpenAPIOperationAnalysis>, selected: string | undefined) {
  const usable = selected === undefined
    ? operation.requestBodies
    : operation.requestBodies.filter((body) => mediaIdentity(body.mediaType) === mediaIdentity(selected));
  return usable.length === 1 ? usable[0] : undefined;
}

function mediaIdentity(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function decodeBase64(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new InvocationError("ERR_REFUSED");
  }
  const decoded = atob(value);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (base64(bytes) !== value) throw new InvocationError("ERR_REFUSED");
  return bytes;
}

function boundaryBase64(value: unknown): string {
  if (typeof value === "string") {
    decodeBase64(value);
    return value;
  }
  if (value instanceof Uint8Array) return base64(value);
  if (value instanceof ArrayBuffer) return base64(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  throw new InvocationError("ERR_REFUSED");
}

function portableOutput(value: unknown): unknown {
  if (value instanceof Uint8Array) return base64(value);
  if (value instanceof ArrayBuffer) return base64(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return value;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function callOptions(args: BindingInvocationArgs, configured: Readonly<OpenAPIInvokerOptions>): OpenAPICallOptions {
  const configuration = contextConfiguration(args.context);
  const server = serverSelection(configuration.server);
  if (Object.hasOwn(configuration, "server") && server === undefined) throw new InvocationError("ERR_REFUSED");
  const selectedSecurity = securityAlternative(configuration.security);
  if (Object.hasOwn(configuration, "security") && selectedSecurity === undefined) throw new InvocationError("ERR_REFUSED");
  if (Object.hasOwn(configuration, "implicitConnectionScope")
    && configuration.implicitConnectionScope !== "entry"
    && configuration.implicitConnectionScope !== "referring") throw new InvocationError("ERR_REFUSED");
  if (Object.hasOwn(configuration, "emptyValueForm")
    && configuration.emptyValueForm !== "name-only"
    && configuration.emptyValueForm !== "empty") throw new InvocationError("ERR_REFUSED");
  return {
    ...(configured.securityHandlers ? { auth: { ...configured.securityHandlers } } : {}),
    ...(server ? { server } : {}),
    ...(selectedSecurity !== undefined
      ? { securityAlternative: selectedSecurity }
      : {}),
    ...(configuration.implicitConnectionScope === "entry" || configuration.implicitConnectionScope === "referring"
      ? { implicitConnectionScope: configuration.implicitConnectionScope }
      : {}),
    ...(configuration.emptyValueForm === "name-only" || configuration.emptyValueForm === "empty"
      ? { emptyValueForm: configuration.emptyValueForm }
      : {}),
    signal: args.signal,
    fetch: args.fetch,
    maxDeliveryUnitBytes: args.maxDeliveryUnitBytes,
    parameterConverter: configured.parameterConversion,
    requestContentCodings: configured.requestContentCodings,
    responseContentCodings: configured.responseContentCodings,
    requestCharacterEncodings: configured.requestCharacterEncodings,
    responseCharacterEncodings: configured.responseCharacterEncodings,
    redirect: configured.redirect,
    hooks: adaptHooks(args),
  };
}

function serverSelection(value: unknown): OpenAPIServerSelection | undefined {
  if (typeof value === "string") return { url: value };
  const source = record(value);
  if (!source) return undefined;
  if (typeof source.baseUrl === "string") return { url: source.baseUrl };
  const variables = stringRecord(source.variables);
  if (Number.isSafeInteger(source.index)) {
    return { index: source.index as number, ...(variables ? { variables } : {}) };
  }
  return variables ? { variables } : undefined;
}

function securityAlternative(value: unknown): number | undefined {
  const source = record(value);
  return source && Number.isSafeInteger(source.index) ? source.index as number : undefined;
}

async function selectedCredentials(
  client: OpenAPIClient,
  ref: string,
  input: OpenAPICallInput,
  options: OpenAPICallOptions,
): Promise<ReadonlyMap<string, string>> {
  const requirements = await client.preflight({ ref }, input, options);
  const credentials = new Map<string, string>();
  for (const alternative of requirements?.alternatives ?? []) {
    for (const requirement of alternative) {
      if (requirement.kind === "credential") credentials.set(requirement.name, requirement.credential);
    }
  }
  return credentials;
}

function configuredInput(context: Record<string, unknown> | undefined): OpenAPICallInput {
  const configuration = contextConfiguration(context);
  if (Object.hasOwn(configuration, "requestMedia") && typeof configuration.requestMedia !== "string") {
    throw new InvocationError("ERR_REFUSED");
  }
  const propertyMedia = stringRecord(configuration.propertyMedia);
  if (Object.hasOwn(configuration, "propertyMedia") && propertyMedia === undefined) {
    throw new InvocationError("ERR_REFUSED");
  }
  return {
    ...(typeof configuration.requestMedia === "string" ? { mediaType: configuration.requestMedia } : {}),
    ...(propertyMedia ? { propertyMediaTypes: propertyMedia } : {}),
  };
}

function authFromContext(
  context: Record<string, unknown> | undefined,
  selectedCredentials: ReadonlyMap<string, string>,
): Record<string, OpenAPIAuthValue> {
  if (selectedCredentials.size === 0) return {};
  const credentials = record(context?.credentials);
  const apiKeys = record(context?.apiKeys);
  const result: Record<string, OpenAPIAuthValue> = {};
  for (const [name, credential] of selectedCredentials) {
    const supplied = credentials?.[name]
      ?? apiKeys?.[name]
      ?? flatCredential(context, credential);
    if (supplied === undefined) continue;
    if (typeof supplied === "string") {
      result[name] = supplied;
      continue;
    }
    const value = record(supplied);
    if (!value) throw new InvocationError("ERR_REFUSED");
    if (typeof value.userId === "string" && typeof value.password === "string") {
      result[name] = { username: value.userId, password: value.password };
      continue;
    }
    if (typeof value.username === "string" && typeof value.password === "string") {
      result[name] = { username: value.username, password: value.password };
      continue;
    }
    if (typeof value.accessToken === "string") {
      if (value.tokenType !== undefined && value.tokenType !== "Bearer") throw new InvocationError("ERR_REFUSED");
      result[name] = {
        accessToken: value.accessToken,
        ...(Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string")
          ? { scopes: value.scopes }
          : {}),
      };
      continue;
    }
    throw new InvocationError("ERR_REFUSED");
  }
  return result;
}

function flatCredential(context: Record<string, unknown> | undefined, credential: string): unknown {
  if (!context) return undefined;
  switch (credential) {
    case "apiKey": return context.apiKey;
    case "basic": return context.basic;
    case "bearer": return context.bearerToken;
    case "oauth2": return context.accessToken ?? context.bearerToken;
    default: return undefined;
  }
}

function toContextRequirements(
  native: OpenAPIConfigurationRequirements | null,
): ContextRequiredDetails | null {
  if (!native) return null;
  return {
    target: native.target,
    alternatives: native.alternatives.map((alternative) => ({
      requirements: alternative.map(contextRequirement),
    })),
  };
}

function bindingRequirements(
  native: OpenAPIConfigurationRequirements | null,
): ContextRequiredDetails | null {
  if (!native) return null;
  const capabilityNames = new Set([
    "parameterConverter",
    "requestContentCodings",
    "responseContentCodings",
    "requestCharacterEncodings",
    "responseCharacterEncodings",
  ]);
  if (native.alternatives.some((alternative) => alternative.some(
    (requirement) => requirement.kind === "option" && capabilityNames.has(requirement.name),
  ))) {
    throw new InvocationError("ERR_REFUSED");
  }
  return toContextRequirements(native);
}

function contextRequirement(requirement: OpenAPIConfigurationRequirement): ContextRequirement {
  if (requirement.kind === "credential") {
    return {
      type: `auth.${requirement.credential}`,
      name: requirement.name,
      durable: true,
      ...(requirement.details ?? {}),
      ...(requirement.description ? { description: requirement.description } : {}),
    };
  }
  const point = requirement.kind === "input"
    ? requirement.name === "mediaType" ? "requestMedia" : "propertyMedia"
    : requirement.name === "securityAlternative" ? "security"
      : requirement.name === "parameterConverter" ? "parameterConversion"
        : requirement.name;
  const path = requirement.kind === "option" && requirement.name === "securityAlternative"
    ? "/index"
    : requirement.path;
  return {
    type: "config.value",
    point,
    path,
    durable: true,
    ...(requirement.allowedValues ? { schema: { enum: [...requirement.allowedValues] } } : {}),
    ...(requirement.description ? { description: requirement.description } : {}),
  };
}

function adaptHooks(args: BindingInvocationArgs): OpenAPIClientHooks | undefined {
  const hooks = args.hooks;
  if (!hooks) return undefined;
  const site = (target: string) => ({
    ...(args.site ?? {
      operation: "",
      invokedAs: "",
      bindingKey: "",
      bindingSpec: args.source.bindingSpec,
      selector: args.selector,
      target: "",
    }),
    target,
  });
  return {
    decode: async (nativeSite, result) => {
      const declined = Symbol("openapi-adapter:decode-declined");
      const value = await hooks.decodeOutput(
        site(nativeSite.target),
        { status: result.status, body: result.body, meta: cloneMetadata(result.metadata) },
        () => declined,
      );
      return value === declined ? OPENAPI_USE_DEFAULT : value;
    },
    classify: async (nativeSite, result) => {
      const declined = { kind: "openapi-adapter:classify-declined" };
      const value = await hooks.classify(
        site(nativeSite.target),
        { status: result.status, body: result.body, meta: cloneMetadata(result.metadata) },
        () => declined as unknown as boolean,
      );
      return value === (declined as unknown) ? OPENAPI_USE_DEFAULT : value;
    },
  };
}

function toInvocationError(error: unknown): InvocationError {
  const authored = invocationCause(error);
  if (authored) {
    try {
      return new InvocationError(authored.code, authored.data);
    } catch {
      return new InvocationError("ERR_RUNTIME");
    }
  }
  if (!(error instanceof OpenAPIClientError)) return new InvocationError("ERR_RUNTIME");
  if (error.code === "CONFIGURATION_REQUIRED" && error.requirements) {
    return new InvocationError(CONTEXT_REQUIRED, toContextRequirements(error.requirements));
  }
  if (error.applicationFailure) {
    return new InvocationError("ERR_EXECUTION_FAILED", portableOutput(error.applicationFailure.data));
  }
  if (error.kind === "source") return new InvocationError("ERR_SOURCE_LOAD_FAILED");
  if (error.code === "SOURCE_EXCLUDED") return new InvocationError("ERR_SELECTOR_NOT_FOUND");
  if (error.code === "INVALID_OPERATION_REF") return new InvocationError("ERR_INVALID_SELECTOR");
  if (error.code === "OPERATION_NOT_FOUND") return new InvocationError("ERR_SELECTOR_NOT_FOUND");
  if (error.kind === "input" || error.kind === "configuration" || error.kind === "operation") {
    return new InvocationError("ERR_REFUSED");
  }
  if (error.kind === "cancelled") return new InvocationError("ERR_CANCELLED");
  return new InvocationError("ERR_EXECUTION_FAILED");
}

function invocationCause(error: unknown): InvocationError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  let authored: InvocationError | undefined;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof InvocationError) authored = current;
    seen.add(current);
    current = current.cause;
  }
  return authored;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const source = record(value);
  if (!source || !Object.values(source).every((member) => typeof member === "string")) return undefined;
  return source as Record<string, string>;
}

function cloneMetadata(metadata: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(metadata).map(([name, values]) => [name, [...values]]));
}
