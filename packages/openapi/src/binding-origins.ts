export const SERVER_DOCUMENT_MARKER = "x-openbindings-internal-server-document";
export const OPERATION_DOCUMENT_MARKER = "x-openbindings-internal-operation-document";
export const REFERRING_SECURITY_SCHEMES_MARKER = "x-openbindings-internal-referring-security-schemes";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/** Retains declaring-document facts lost when an external Path Item is dereferenced. */
export function markBindingOrigins(root: unknown, baseURI: string | undefined): void {
  const document = asRecord(root);
  if (!document) return;
  markServers(document.servers, baseURI);
  const schemes = asRecord(asRecord(document.components)?.securitySchemes);
  for (const collectionName of ["paths", "webhooks"]) {
    for (const pathItem of Object.values(asRecord(document[collectionName]) ?? {})) {
      markPathItemOrigins(pathItem, baseURI, schemes);
    }
  }
}

/** Marks a Path Item reached through `$ref` with facts from its containing document. */
export function markReferencedPathItemOrigins(
  target: unknown,
  declaringRoot: unknown,
  baseURI: string | undefined,
): void {
  const root = asRecord(declaringRoot);
  const schemes = asRecord(asRecord(root?.components)?.securitySchemes);
  markPathItemOrigins(target, baseURI, schemes);
}

function markPathItemOrigins(
  raw: unknown,
  baseURI: string | undefined,
  schemes: Record<string, unknown> | undefined,
): void {
  const item = asRecord(raw);
  if (!item) return;
  markServers(item.servers, baseURI);
  for (const method of METHODS) {
    const operation = asRecord(item[method]);
    if (!operation) continue;
    markServers(operation.servers, baseURI);
    if (!Object.hasOwn(operation, "security")) continue;
    if (baseURI) operation[OPERATION_DOCUMENT_MARKER] = baseURI;
    if (schemes && Object.keys(schemes).length > 0) {
      operation[REFERRING_SECURITY_SCHEMES_MARKER] = schemes;
    }
  }
}

function markServers(raw: unknown, baseURI: string | undefined): void {
  if (!baseURI || !Array.isArray(raw)) return;
  for (const value of raw) {
    const server = asRecord(value);
    if (server) server[SERVER_DOCUMENT_MARKER] = baseURI;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
