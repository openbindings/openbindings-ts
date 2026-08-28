import {
  ConfigRequired,
  absolutizeServerURL as absolutizeNativeServerURL,
  effectiveServers as effectiveNativeServers,
  eligibleServers as eligibleNativeServers,
  replaceSerializedServerBase,
  requestWithOpenAPIURL,
  resolveOpenAPIServerSelection,
  substituteServerVariables as substituteNativeServerVariables,
  type OpenAPIServerEntry,
  type OpenAPIServerVariable,
} from "@openbindings/openapi-client/analysis";
import { contextConfiguration, contextMetadata } from "@openbindings/invoke";
import type { OpenAPIDocument, OpenAPIOperation, OpenAPIPathItem } from "./types.js";
import { SERVER_DOCUMENT_MARKER } from "./binding-origins.js";

export { ConfigRequired } from "@openbindings/openapi-client/analysis";
export { replaceSerializedServerBase, requestWithOpenAPIURL };
export type ServerEntry = OpenAPIServerEntry;
export type ServerVariable = OpenAPIServerVariable;

/** Maps OpenBindings context choices onto client-owned OpenAPI server resolution. */
export function resolveServer(
  doc: OpenAPIDocument,
  pathItem: OpenAPIPathItem | null,
  operation: OpenAPIOperation | null,
  context: Record<string, unknown> | undefined,
  sourceLocation: string | undefined,
): string {
  const version = typeof doc.openapi === "string" ? doc.openapi : "";
  const servers = eligibleServers(effectiveServers(doc, pathItem, operation), version, sourceLocation);
  const configuration = contextConfiguration(context);
  if (configuration.server != null) {
    const selected = resolveOpenAPIServerSelection(configuration.server, servers, version);
    return absolutizeServerURL(
      selected.url,
      declaringDocumentLocation(selected.server, sourceLocation),
    );
  }

  const metadataBase = contextMetadata(context).baseURL;
  if (typeof metadataBase === "string" && metadataBase !== "") {
    return absolutizeServerURL(metadataBase, sourceLocation);
  }

  if (servers.length !== 1) {
    throw new ConfigRequired(
      "server",
      "/url",
      `the effective server list has ${servers.length} alternatives; configuration.server must select one`,
      { enum: servers.map((server) => server.url) },
      true,
    );
  }
  return absolutizeServerURL(
    substituteServerVariables(servers[0], undefined, version),
    declaringDocumentLocation(servers[0], sourceLocation),
  );
}

export function effectiveServers(
  doc: OpenAPIDocument,
  pathItem: OpenAPIPathItem | null,
  operation: OpenAPIOperation | null,
): [ServerEntry, ...ServerEntry[]] {
  return effectiveNativeServers(doc, pathItem, operation);
}

export function eligibleServers(
  servers: readonly ServerEntry[],
  version: string,
  sourceLocation: string | undefined,
): [ServerEntry, ...ServerEntry[]] {
  return eligibleNativeServers(
    servers,
    version,
    sourceLocation,
    (server) => declaringDocumentLocation(server, sourceLocation),
  );
}

export function substituteServerVariables(
  server: ServerEntry,
  supplied: Record<string, string> | undefined,
  version = "",
): string {
  return substituteNativeServerVariables(server, supplied, version);
}

export function absolutizeServerURL(serverURL: string, sourceLocation: string | undefined): string {
  return absolutizeNativeServerURL(serverURL, sourceLocation);
}

function declaringDocumentLocation(
  server: ServerEntry | undefined,
  fallback: string | undefined,
): string | undefined {
  const declared = server?.[SERVER_DOCUMENT_MARKER];
  return typeof declared === "string" && declared !== "" ? declared : fallback;
}
