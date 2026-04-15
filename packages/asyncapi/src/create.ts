import type { OBInterface, Operation, Source, SecurityMethod } from "@openbindings/sdk";
import { MAX_TESTED_VERSION, detectFormatVersion } from "@openbindings/sdk";
import type {
  AsyncAPIDocument,
  AsyncAPIOperation,
  AsyncAPIOperationReply,
  AsyncAPISecurityScheme,
  AsyncAPISecurityRequirement,
} from "./asyncapi-types.js";
import { DEFAULT_SOURCE_NAME } from "./constants.js";
import { sanitizeKey, uniqueKey } from "./util.js";

export async function convertToInterface(
  location?: string,
  content?: AsyncAPIDocument,
  _options?: { signal?: AbortSignal },
): Promise<OBInterface> {
  if (!content) throw new Error("asyncapi convertToInterface: content is required");
  const doc = content;
  const formatVersion = detectFormatVersion(doc.asyncapi);

  const sourceEntry: Source = {
    format: `asyncapi@${formatVersion}`,
  };
  if (location) sourceEntry.location = location;

  const info = doc.info;
  const iface: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    name: info.title ?? undefined,
    version: info.version,
    description: info.description ?? undefined,
    operations: {},
    bindings: {},
    sources: { [DEFAULT_SOURCE_NAME]: sourceEntry },
  };

  // Build security scheme lookup from components.
  const docSchemes = doc.components?.securitySchemes ?? {};
  const schemeMethods: Record<string, SecurityMethod> = {};
  for (const [name, scheme] of Object.entries(docSchemes)) {
    if (!name) continue;
    schemeMethods[name] = convertSecurityScheme(scheme);
  }

  const usedKeys = new Set<string>();
  const securityEntries: Record<string, SecurityMethod[]> = {};
  const ops = Object.entries(doc.operations ?? {});
  // Sort by id for deterministic output
  ops.sort(([a], [b]) => a.localeCompare(b));

  for (const [opID, asyncOp] of ops) {
    const opKey = uniqueKey(sanitizeKey(opID), usedKeys);
    usedKeys.add(opKey);

    const obiOp: Operation = {
      description: asyncOp.description || asyncOp.summary || undefined,
    };

    const tags = asyncOp.tags;
    if (tags && tags.length) {
      obiOp.tags = tags.map((t) => t.name);
    }

    const action = asyncOp.action;
    switch (action) {
      case "receive":
        {
          const payload = resolveOperationPayload(asyncOp);
          if (payload) obiOp.output = payload;
        }
        break;
      case "send":
        {
          const inputPayload = resolveOperationPayload(asyncOp);
          if (inputPayload) obiOp.input = inputPayload;
          const reply = asyncOp.reply;
          if (reply) {
            const outputPayload = resolveReplyPayload(reply);
            if (outputPayload) obiOp.output = outputPayload;
          }
        }
        break;
    }

    iface.operations[opKey] = obiOp;

    const ref = `#/operations/${opID}`;
    const bindingKey = `${opKey}.${DEFAULT_SOURCE_NAME}`;
    iface.bindings![bindingKey] = {
      operation: opKey,
      source: DEFAULT_SOURCE_NAME,
      ref,
    };

    // Populate security for this operation.
    // After dereference, security items are resolved scheme objects (with a `type` field).
    const opSecReqs = asyncOp.security;
    if (opSecReqs && opSecReqs.length > 0) {
      const schemeNames: string[] = [];

      for (const req of opSecReqs) {
        if (isSecurityScheme(req)) {
          // This is a dereferenced security scheme object. Find its name by
          // matching against document-level schemes (by object identity or by type+scheme).
          let name = findSchemeName(docSchemes, req);
          if (!name) continue;
          schemeNames.push(name);

          if (!schemeMethods[name]) {
            schemeMethods[name] = convertSecurityScheme(req);
          }
        }
      }

      if (schemeNames.length > 0) {
        schemeNames.sort();
        const secKey = schemeNames.join("+");

        if (!securityEntries[secKey]) {
          const methods: SecurityMethod[] = [];
          for (const n of schemeNames) {
            if (schemeMethods[n]) methods.push(schemeMethods[n]);
          }
          if (methods.length > 0) {
            securityEntries[secKey] = methods;
          }
        }

        if (securityEntries[secKey]) {
          iface.bindings![bindingKey].security = secKey;
        }
      }
    }
  }

  if (Object.keys(securityEntries).length > 0) {
    iface.security = securityEntries;
  }

  return iface;
}

/** Type guard: after dereference, security entries that were $refs to securitySchemes
 *  are resolved into the scheme object itself (which has a `type` field). */
function isSecurityScheme(obj: unknown): obj is AsyncAPISecurityScheme {
  return typeof obj === "object" && obj !== null && "type" in obj;
}

/** Find the name of a resolved security scheme by matching it against the
 *  document-level securitySchemes (by identity or structural equality). */
function findSchemeName(
  docSchemes: Record<string, AsyncAPISecurityScheme>,
  scheme: AsyncAPISecurityScheme,
): string | undefined {
  // Try identity first (works when dereference preserves object references).
  for (const [name, s] of Object.entries(docSchemes)) {
    if (s === scheme) return name;
  }
  // Fall back to structural match on type + scheme fields.
  for (const [name, s] of Object.entries(docSchemes)) {
    if (s.type === scheme.type && s.scheme === scheme.scheme && s.name === scheme.name && s.in === scheme.in) return name;
  }
  return undefined;
}

function resolveOperationPayload(
  op: AsyncAPIOperation,
): Record<string, unknown> | undefined {
  // Try operation-level messages first (after dereference these are resolved objects)
  const opMsgs = op.messages;
  if (opMsgs && opMsgs.length > 0) {
    const payload = opMsgs[0].payload;
    if (payload) return stripParserExtensions(payload);
  }

  // Fall back to channel messages
  const channel = op.channel;
  if (channel?.messages) {
    const channelMsgs = Object.values(channel.messages);
    for (const msg of channelMsgs) {
      const payload = msg.payload;
      if (payload) return stripParserExtensions(payload);
    }
  }

  return undefined;
}

function resolveReplyPayload(
  reply: AsyncAPIOperationReply,
): Record<string, unknown> | undefined {
  const replyMsgs = reply.messages;
  if (replyMsgs && replyMsgs.length > 0) {
    const payload = replyMsgs[0].payload;
    if (payload) return stripParserExtensions(payload);
  }
  return undefined;
}

/** Converts an AsyncAPI security scheme to an OBI SecurityMethod. */
function convertSecurityScheme(
  scheme: AsyncAPISecurityScheme,
): SecurityMethod {
  const schemeType = scheme.type;
  const desc = scheme.description ?? undefined;

  switch (schemeType) {
    case "http":
    case "httpApiKey": {
      const httpScheme = scheme.scheme?.toLowerCase() ?? "";
      switch (httpScheme) {
        case "bearer":
          return { type: "bearer", description: desc };
        case "basic":
          return { type: "basic", description: desc };
        default:
          if (schemeType === "httpApiKey") {
            return {
              type: "apiKey",
              description: desc,
              name: scheme.name,
              in: scheme.in as SecurityMethod["in"],
            };
          }
          return { type: httpScheme || schemeType, description: desc };
      }
    }

    case "oauth2": {
      const m: SecurityMethod = { type: "oauth2", description: desc };
      const flows = scheme.flows;
      if (flows) {
        const flow =
          flows.authorizationCode ??
          flows.implicit ??
          flows.clientCredentials ??
          flows.password;
        if (flow) {
          const authUrl = flow.authorizationUrl;
          if (authUrl) m.authorizeUrl = authUrl;
          const tokenUrl = flow.tokenUrl;
          if (tokenUrl) m.tokenUrl = tokenUrl;
          const flowScopes = flow.scopes;
          if (flowScopes) {
            const scopeKeys = Object.keys(flowScopes).sort();
            if (scopeKeys.length > 0) m.scopes = scopeKeys;
          }
        }
      }
      return m;
    }

    case "apiKey":
      return {
        type: "apiKey",
        description: desc,
        name: scheme.name,
        in: scheme.in as SecurityMethod["in"],
      };

    case "openIdConnect":
      return { type: "bearer", description: "OpenID Connect" };

    default:
      return { type: schemeType, description: desc };
  }
}

/**
 * Remove x-parser-* extension keys from a schema object (shallow top-level only).
 * These may appear in source documents; they shouldn't leak into OBI output.
 */
function stripParserExtensions(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("x-parser-")) continue;
    result[k] = v;
  }
  return result;
}
