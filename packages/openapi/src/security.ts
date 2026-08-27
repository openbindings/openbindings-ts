import {
  contextAccessTokenFor,
  contextApiKeyFor,
  contextBasicAuthFor,
  contextBearerTokenFor,
  contextConfiguration,
  contextSatisfies,
  type ContextAlternative,
  type ContextRequiredDetails,
  type ContextRequirement,
} from "@openbindings/invoke";
import type { OpenAPIEngineSecurityHandler } from "@openbindings/openapi-client/engine";
import type {
  OpenAPIDocument,
  OpenAPIOperation,
  OpenAPIParameter,
} from "./types.js";
import { REFERRING_SECURITY_SCHEMES_MARKER } from "./binding-origins.js";
import { codePointCompare } from "./util.js";

export interface SecurityScheme extends Record<string, unknown> {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
}

export interface SecurityPlan {
  context: ContextAlternative;
  schemes: Array<{ name: string; scheme: SecurityScheme }>;
  authoredIndex: number;
}

export interface SecuritySelection {
  requirement: Record<string, unknown>;
  plans: SecurityPlan[];
  authoredIndex: number;
}

export function effectiveSecurityRequirements(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
): Array<Record<string, unknown>> | null {
  const operationSecurity = operation.security;
  if (Array.isArray(operationSecurity)) return operationSecurity as Array<Record<string, unknown>>;
  return Array.isArray(document.security)
    ? document.security as Array<Record<string, unknown>>
    : null;
}

export function securityPlans(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  baseURL: string,
  context?: Record<string, unknown>,
): SecurityPlan[] {
  const requirements = effectiveSecurityRequirements(document, operation);
  if (!requirements || requirements.length === 0) return [];
  const plans: SecurityPlan[] = [];
  for (const [authoredIndex, rawRequirement] of requirements.entries()) {
    const requirement = asRecord(rawRequirement);
    if (!requirement) continue;
    const names = Object.keys(requirement).sort(codePointCompare);
    if (names.length === 0) {
      plans.push({ context: { requirements: [] }, schemes: [], authoredIndex });
      continue;
    }
    let expanded: SecurityPlan[] = [{ context: { requirements: [] }, schemes: [], authoredIndex }];
    let usable = true;
    for (const name of names) {
      const scheme = securitySchemeForOperation(document, operation, name, context);
      const values = requirement[name];
      if (!scheme || malformedSecurityScheme(scheme) || !Array.isArray(values)
        || values.some((value) => typeof value !== "string")) {
        usable = false;
        break;
      }
      const strings = values as string[];
      if (document.openapi?.startsWith("3.0.") && scheme.type === "mutualTLS") {
        usable = false;
        break;
      }
      if (document.openapi?.startsWith("3.0.") && !securitySchemeUsesScopes(scheme) && strings.length > 0) {
        usable = false;
        break;
      }
      const options = schemeRequirements(scheme, baseURL, strings).map((option) => ({
        ...option,
        name,
        durable: true,
        ...(scheme.description ? { description: scheme.description } : {}),
        ...(document.openapi?.startsWith("3.1.") && !securitySchemeUsesScopes(scheme) && strings.length > 0
          ? { roles: [...strings] }
          : {}),
      }));
      if (options.length === 0) {
        usable = false;
        break;
      }
      expanded = expanded.flatMap((plan) => options.map((option) => ({
        context: { requirements: [...plan.context.requirements, option] },
        schemes: [...plan.schemes, { name, scheme }],
        authoredIndex,
      })));
    }
    if (usable) plans.push(...expanded);
  }
  return plans;
}

export function viableSecurityPlans(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  baseURL: string,
  parameters: OpenAPIParameter[],
  context?: Record<string, unknown>,
): SecurityPlan[] {
  return securityPlans(document, operation, baseURL, context)
    .filter((plan) => credentialCollision(credentialDestinations(plan), parameters) === "");
}

export function electSecurityAlternative(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  context: Record<string, unknown> | undefined,
  baseURL: string,
  parameters: OpenAPIParameter[],
): SecuritySelection | null {
  const configuration = contextConfiguration(context);
  validateImplicitConnectionScope(configuration.implicitConnectionScope);
  const requirements = effectiveSecurityRequirements(document, operation);
  if (!requirements || requirements.length === 0) return null;

  let authoredIndex = 0;
  const rawSelection = configuration.security;
  if (requirements.length > 1 && rawSelection == null) {
    throw new Error(
      `the effective security list has ${requirements.length} alternatives; configuration.security must select one`,
    );
  }
  if (rawSelection != null) {
    const selected = securityConfigurationIndex(rawSelection);
    if (selected === null || selected < 0 || selected >= requirements.length) {
      throw new Error("configuration.security must select an effective alternative by zero-based index");
    }
    authoredIndex = selected;
  }

  const plans = viableSecurityPlans(document, operation, baseURL, parameters, context)
    .filter((plan) => plan.authoredIndex === authoredIndex);
  if (plans.length === 0) {
    throw new Error(`selected security alternative ${authoredIndex} is unusable`);
  }
  return { requirement: requirements[authoredIndex]!, plans, authoredIndex };
}

export function installSelectedSecurityAlternative(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  selection: SecuritySelection | null,
): void {
  if (!selection) return;
  operation.security = [{ ...selection.requirement }];
  const components = asRecord(document.components) ?? {};
  if (!asRecord(document.components)) document.components = components;
  const schemes = asRecord(components.securitySchemes) ?? {};
  if (!asRecord(components.securitySchemes)) components.securitySchemes = schemes;
  for (const plan of selection.plans) {
    for (const named of plan.schemes) schemes[named.name] = named.scheme;
  }
}

export function requiredSecuritySelectionContext(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  context: Record<string, unknown> | undefined,
  target: string,
): ContextRequiredDetails | null {
  const requirements = effectiveSecurityRequirements(document, operation);
  if (!requirements || requirements.length <= 1) return null;
  const raw = contextConfiguration(context).security;
  if (raw != null) {
    const selected = securityConfigurationIndex(raw);
    if (selected === null || selected < 0 || selected >= requirements.length) {
      throw new Error("configuration.security must select an effective alternative by zero-based index");
    }
    return null;
  }
  return {
    target,
    alternatives: [{ requirements: [{
      type: "config.value",
      point: "security",
      path: "/index",
      description: "select one complete effective OpenAPI security alternative",
      schema: { type: "integer", enum: requirements.map((_, index) => index) },
      durable: true,
    }] }],
  };
}

export function requiredImplicitConnectionScopeContext(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  context: Record<string, unknown> | undefined,
  baseURL: string,
  parameters: OpenAPIParameter[],
  target: string,
): ContextRequiredDetails | null {
  const configuration = contextConfiguration(context);
  validateImplicitConnectionScope(configuration.implicitConnectionScope);
  if (configuration.implicitConnectionScope != null) return null;
  const requirements = effectiveSecurityRequirements(document, operation);
  if (!requirements || requirements.length === 0) return null;
  let selected = 0;
  if (requirements.length > 1) {
    if (configuration.security == null) return null;
    const index = securityConfigurationIndex(configuration.security);
    if (index === null || index < 0 || index >= requirements.length) {
      throw new Error("configuration.security must select an effective alternative by zero-based index");
    }
    selected = index;
  }
  if (viableAtScope(document, operation, context, baseURL, parameters, selected, "entry").length > 0) {
    return null;
  }
  if (viableAtScope(document, operation, context, baseURL, parameters, selected, "referring").length === 0) {
    return null;
  }
  return {
    target,
    alternatives: [{ requirements: [{
      type: "config.value",
      point: "implicitConnectionScope",
      path: "",
      description: "resolve Security Requirement names in the referring OpenAPI document",
      schema: { type: "string", enum: ["referring"] },
      durable: true,
    }] }],
  };
}

export function requiredSelectedSecurityContext(
  selection: SecuritySelection | null,
  context: Record<string, unknown> | undefined,
  target: string,
  handlers?: Record<string, OpenAPIEngineSecurityHandler>,
): ContextRequiredDetails | null {
  if (!selection) return null;
  if (selection.plans.some((plan) => plan.context.requirements.length === 0)) return null;
  if (selection.plans.some((plan) => plan.schemes.some((named) => handlers?.[named.name]))) return null;
  const details: ContextRequiredDetails = {
    target,
    alternatives: selection.plans.map((plan) => plan.context),
  };
  return context && contextSatisfies(context, details) ? null : details;
}

export function validateSelectedCredentials(
  selection: SecuritySelection | null,
  context: Record<string, unknown> | undefined,
): void {
  if (!selection || !context) return;
  for (const plan of selection.plans) {
    const details: ContextRequiredDetails = { target: "", alternatives: [plan.context] };
    if (plan.context.requirements.length > 0 && !contextSatisfies(context, details)) continue;
    for (const { name, scheme } of plan.schemes) {
      if (scheme.type === "apiKey" && scheme.in === "cookie") {
        const value = contextApiKeyFor(context, name);
        if (value && !validRFC6265CookieValue(value)) {
          throw new Error(`cookie credential ${JSON.stringify(scheme.name)} cannot be carried as an RFC 6265 cookie-value`);
        }
      } else if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic") {
        const basic = contextBasicAuthFor(context, name);
        if (basic && (basic.username.includes(":")
          || !validBasicCredentialText(basic.username)
          || !validBasicCredentialText(basic.password))) {
          throw new Error(`basic credential ${JSON.stringify(name)} violates RFC 7617 constraints`);
        }
      } else if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "bearer") {
        const token = contextBearerTokenFor(context, name);
        if (token && !validBearerToken(token)) {
          throw new Error(`bearer credential ${JSON.stringify(name)} is not an RFC 6750 b64token`);
        }
      } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
        const token = contextAccessTokenFor(context, name) || contextBearerTokenFor(context, name);
        if (token && !validBearerToken(token)) {
          throw new Error(`access token for ${JSON.stringify(name)} is not an RFC 6750 b64token`);
        }
      }
    }
    return;
  }
}

export function securityCoverageRequirements(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  parameters: OpenAPIParameter[],
): string[] {
  const requirements = effectiveSecurityRequirements(document, operation);
  if (!requirements || requirements.length === 0) return [];
  const result: string[] = [];
  if (requirements.length > 1) result.push("configuration.security");
  const entry = viableSecurityPlans(document, operation, "", parameters, withScope(undefined, "entry"));
  const referring = viableSecurityPlans(document, operation, "", parameters, withScope(undefined, "referring"));
  if (entry.length === 0 && referring.length > 0) result.push("configuration.implicitConnectionScope");
  return result;
}

export function securityAlternativeUsable(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  parameters: OpenAPIParameter[],
  authoredIndex: number,
): boolean {
  for (const scope of ["entry", "referring"] as const) {
    if (viableSecurityPlans(document, operation, "", parameters, withScope(undefined, scope))
      .some((plan) => plan.authoredIndex === authoredIndex)) return true;
  }
  return false;
}

function viableAtScope(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  context: Record<string, unknown> | undefined,
  baseURL: string,
  parameters: OpenAPIParameter[],
  authoredIndex: number,
  scope: "entry" | "referring",
): SecurityPlan[] {
  return viableSecurityPlans(document, operation, baseURL, parameters, withScope(context, scope))
    .filter((plan) => plan.authoredIndex === authoredIndex);
}

function withScope(
  context: Record<string, unknown> | undefined,
  scope: "entry" | "referring",
): Record<string, unknown> {
  return {
    ...(context ?? {}),
    configuration: { ...contextConfiguration(context), implicitConnectionScope: scope },
  };
}

function securitySchemeForOperation(
  document: OpenAPIDocument,
  operation: OpenAPIOperation,
  name: string,
  context: Record<string, unknown> | undefined,
): SecurityScheme | null {
  const scope = contextConfiguration(context).implicitConnectionScope ?? "entry";
  if (scope === "referring") {
    const referring = asRecord(operation[REFERRING_SECURITY_SCHEMES_MARKER]);
    const candidate = asRecord(referring?.[name]);
    if (candidate) return candidate as SecurityScheme;
  }
  const components = asRecord(document.components);
  const schemes = asRecord(components?.securitySchemes);
  const candidate = asRecord(schemes?.[name]);
  return candidate ? candidate as SecurityScheme : null;
}

function malformedSecurityScheme(scheme: SecurityScheme): string {
  switch (scheme.type) {
    case "apiKey":
      return typeof scheme.name === "string" && scheme.name !== ""
        && ["header", "query", "cookie"].includes(scheme.in ?? "")
        ? ""
        : "apiKey Security Scheme Object requires a name and destination";
    case "http":
      return typeof scheme.scheme === "string" && scheme.scheme !== ""
        ? ""
        : "HTTP Security Scheme Object requires a scheme";
    case "oauth2":
      return asRecord(scheme.flows) ? "" : "OAuth 2.0 Security Scheme Object requires flows";
    case "openIdConnect":
      return typeof scheme.openIdConnectUrl === "string" && scheme.openIdConnectUrl !== ""
        ? ""
        : "OpenID Connect Security Scheme Object requires openIdConnectUrl";
    case "mutualTLS":
      return "";
    default:
      return `Security Scheme Object type ${JSON.stringify(scheme.type)} is not admitted`;
  }
}

function securitySchemeUsesScopes(scheme: SecurityScheme): boolean {
  return scheme.type === "oauth2" || scheme.type === "openIdConnect";
}

function schemeRequirements(
  scheme: SecurityScheme,
  baseURL: string,
  values: string[],
): ContextRequirement[] {
  if (scheme.type === "oauth2") return oauth2Requirements(scheme, baseURL, values);
  switch (scheme.type) {
    case "http": {
      const token = scheme.scheme?.toLowerCase() ?? "";
      if (token === "basic") return [{ type: "auth.basic" }];
      if (token === "bearer") return [{ type: "auth.bearer" }];
      return [{ type: token ? `auth.http.${token}` : "auth.http" }];
    }
    case "apiKey":
      return [{ type: "auth.apiKey" }];
    case "openIdConnect":
      return [{
        type: "auth.oauth2",
        scopes: [...values],
        ...(typeof scheme.openIdConnectUrl === "string"
          ? { openIdConnectUrl: absolutize(scheme.openIdConnectUrl, baseURL) }
          : {}),
      }];
    default:
      return [{ type: `auth.${scheme.type}` }];
  }
}

function oauth2Requirements(
  scheme: SecurityScheme,
  baseURL: string,
  scopes: string[],
): ContextRequirement[] {
  const flows = asRecord(scheme.flows) ?? {};
  const candidates: Array<[string, string]> = [
    ["authorization_code", "authorizationCode"],
    ["implicit", "implicit"],
    ["password", "password"],
    ["client_credentials", "clientCredentials"],
  ];
  const result: ContextRequirement[] = [];
  for (const [grantType, key] of candidates) {
    const flow = asRecord(flows[key]);
    if (!flow || !oauthFlowUsable(grantType, flow, scopes)) continue;
    result.push({
      type: "auth.oauth2",
      scopes: [...scopes],
      grantType,
      ...(typeof flow.authorizationUrl === "string" ? { authorizeUrl: absolutize(flow.authorizationUrl, baseURL) } : {}),
      ...(typeof flow.tokenUrl === "string" ? { tokenUrl: absolutize(flow.tokenUrl, baseURL) } : {}),
    });
  }
  return result.length > 0 ? result : [{ type: "auth.oauth2", scopes: [...scopes] }];
}

function oauthFlowUsable(grantType: string, flow: Record<string, unknown>, scopes: string[]): boolean {
  if (grantType === "authorization_code"
    && (typeof flow.authorizationUrl !== "string" || typeof flow.tokenUrl !== "string")) return false;
  if (grantType === "implicit" && typeof flow.authorizationUrl !== "string") return false;
  if (["password", "client_credentials"].includes(grantType) && typeof flow.tokenUrl !== "string") return false;
  const available = asRecord(flow.scopes) ?? {};
  return scopes.every((scope) => Object.hasOwn(available, scope));
}

function absolutize(value: string, baseURL: string): string {
  try { return new URL(value, baseURL).toString(); } catch { return value; }
}

interface CredentialDestination {
  channel: "header" | "query" | "cookie";
  name: string;
}

function credentialDestinations(plan: SecurityPlan): CredentialDestination[] {
  const result: CredentialDestination[] = [];
  for (const { scheme } of plan.schemes) {
    if (scheme.type === "apiKey" && typeof scheme.name === "string"
      && (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie")) {
      result.push({ channel: scheme.in, name: scheme.name });
    } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect"
      || (scheme.type === "http" && ["basic", "bearer"].includes(scheme.scheme?.toLowerCase() ?? ""))) {
      result.push({ channel: "header", name: "Authorization" });
    }
  }
  return result;
}

function credentialCollision(
  destinations: CredentialDestination[],
  parameters: OpenAPIParameter[],
): string {
  const parameterKeys = new Set(parameters.flatMap((parameter) => {
    if (typeof parameter.name !== "string") return [];
    const channel = parameter.in;
    if (channel !== "header" && channel !== "query" && channel !== "cookie") return [];
    return [`${channel}:${channel === "header" ? parameter.name.toLowerCase() : parameter.name}`];
  }));
  const rawCookie = parameterKeys.has("header:cookie");
  const seen = new Set<string>();
  for (const destination of destinations) {
    const name = destination.channel === "header" ? destination.name.toLowerCase() : destination.name;
    const key = `${destination.channel}:${name}`;
    if (destination.channel === "header"
      && ["host", "content-length", "content-type", "accept"].includes(name)) return key;
    if (destination.channel === "cookie" && rawCookie) return key;
    if (parameterKeys.has(key) || seen.has(key)) return key;
    seen.add(key);
  }
  return "";
}

function securityConfigurationIndex(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  const record = asRecord(raw);
  return typeof record?.index === "number" && Number.isInteger(record.index) ? record.index : null;
}

function validateImplicitConnectionScope(raw: unknown): void {
  if (raw == null) return;
  if (raw !== "entry" && raw !== "referring") {
    throw new Error("configuration.implicitConnectionScope must be entry or referring");
  }
}

function validBasicCredentialText(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0x20 && code <= 0x7e;
  });
}

function validBearerToken(value: string): boolean {
  return /^[A-Za-z0-9\-._~+/]+={0,}$/u.test(value);
}

function validRFC6265CookieValue(value: string): boolean {
  const bytes = new TextEncoder().encode(value);
  return [...bytes].every((byte) => byte === 0x21
    || (byte >= 0x23 && byte <= 0x2b)
    || (byte >= 0x2d && byte <= 0x3a)
    || (byte >= 0x3c && byte <= 0x5b)
    || (byte >= 0x5d && byte <= 0x7e));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
