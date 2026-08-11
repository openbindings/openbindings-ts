import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InvocationError, ERR_REF_NOT_FOUND, ERR_PROTOCOL } from "@openbindings/sdk";
import { BINDING_SPEC } from "./constants.js";

/**
 * A listing is this family's artifact (openbindings.mcp@1 §3): the aggregate
 * of a server's declared tools, resources, resource templates, and prompts,
 * always pagination-exhausted. Only entity identities are kept — ref matching
 * is byte-exact against them (MCP-D-03), and the matched remainder itself is
 * what dispatch uses — but multiplicity matters: MCP names are only
 * SHOULD-unique, so ambiguity detection needs every occurrence.
 */
export interface Listing {
  tools: string[]; // Tool.name
  /** Tool names whose 2025-11-25 declaration requires task augmentation. */
  requiredTaskTools?: string[];
  /** Application output schemas keyed by tool name when declared. */
  toolOutputSchemas?: Record<string, unknown>;
  resources: string[]; // Resource.uri
  templates: string[]; // ResourceTemplate.uriTemplate
  prompts: string[]; // Prompt.name
  pinned: boolean;
}

/**
 * The outcome of resolving a ref against the listing: which entity family
 * the binding invokes through (§8).
 */
export type TargetKind = "tool" | "prompt" | "staticResource" | "templateResource";

/**
 * Maps each allowed pinned-listing member (MCP-D-01) to the identity member
 * of its 2025-11-25 entity shape — the one member resolution matches
 * byte-exactly.
 */
const PIN_IDENTITY_MEMBER: Record<string, string> = {
  tools: "name",
  resources: "uri",
  resourceTemplates: "uriTemplate",
  prompts: "name",
};

/**
 * Validates source content as a pinned listing per openbindings.mcp@1 §3/§5
 * (MCP-D-01): a JSON object whose members are tools, resources,
 * resourceTemplates, and prompts — each optional, each a pagination-exhausted
 * entity array in the 2025-11-25 result shapes. Pagination members
 * (nextCursor, _meta) and any other member are not part of the
 * representation: their presence makes the content invalid, refused loudly
 * here (a plain Error the caller classifies as ERR_SOURCE_LOAD_FAILED).
 */
export function parsePinnedListing(content: unknown): Listing {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(
      "MCP source content must be a pinned-listing object (MCP-D-01): a JSON object with entity arrays under tools/resources/resourceTemplates/prompts",
    );
  }
  const members = content as Record<string, unknown>;

  // Stray members are refused loudly, deterministically (sorted first
  // offender): nextCursor and _meta are pagination carriage, not part of
  // the pinned representation, and anything else is outside the grammar.
  for (const name of Object.keys(members).sort()) {
    if (!(name in PIN_IDENTITY_MEMBER)) {
      throw new Error(
        `MCP pinned listing carries member ${JSON.stringify(name)}, which is not part of the representation (MCP-D-01 allows only tools, resources, resourceTemplates, prompts; pagination members like nextCursor and _meta are excluded)`,
      );
    }
  }

  const tools = pinEntityIdentities(members["tools"], "tools", "name");
  return {
    tools,
    requiredTaskTools: requiredTaskToolNames(members["tools"]),
    toolOutputSchemas: toolOutputSchemas(members["tools"]),
    resources: pinEntityIdentities(members["resources"], "resources", "uri"),
    templates: pinEntityIdentities(members["resourceTemplates"], "resourceTemplates", "uriTemplate"),
    prompts: pinEntityIdentities(members["prompts"], "prompts", "name"),
    pinned: true,
  };
}

function toolOutputSchemas(raw: unknown): Record<string, unknown> {
  if (!Array.isArray(raw)) return {};
  const schemas: Record<string, unknown> = {};
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record["name"] === "string" && record["outputSchema"] !== undefined) {
      schemas[record["name"]] = record["outputSchema"];
    }
  }
  return schemas;
}

function requiredTaskToolNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const execution = record["execution"];
    if (
      typeof record["name"] === "string" &&
      execution !== null &&
      typeof execution === "object" &&
      !Array.isArray(execution) &&
      (execution as Record<string, unknown>)["taskSupport"] === "required"
    ) names.push(record["name"]);
  }
  return names;
}

/**
 * Extracts the identity strings from one pinned entity array. The member is
 * optional; when present it must be an array of objects each carrying its
 * identity member as a string (the 2025-11-25 result shapes) — anything else
 * invalidates the pin loudly.
 */
function pinEntityIdentities(raw: unknown, member: string, idKey: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`MCP pinned listing member ${JSON.stringify(member)} must be an entity array (MCP-D-01)`);
  }
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`MCP pinned listing ${member}[${i}] must be an object in the 2025-11-25 result shape (MCP-D-01)`);
    }
    const id = (entry as Record<string, unknown>)[idKey];
    if (typeof id !== "string") {
      throw new Error(`MCP pinned listing ${member}[${i}] must carry a string ${JSON.stringify(idKey)} (MCP-D-01)`);
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Follows one MCP list request to pagination exhaustion (MCP-P-02): the
 * request is issued repeatedly, feeding each nextCursor back, until the
 * server stops returning one. Shared by ref resolution (liveListing) and
 * interface synthesis (discover), whose artifact is the same
 * pagination-exhausted aggregate (§3).
 */
// MAX_LIST_PAGES is a defensive backstop: MCP-P-02 mandates exhaustion, not
// unbounded trust. A server returning an always-new nextCursor forever would
// otherwise loop until the caller's AbortSignal. The ceiling is absurdly high
// — 10_000 pages × a typical page ≈ millions of entities, no real MCP server —
// so it fires only on a non-terminating server, refusing with the same
// ERR_PROTOCOL the Go SDK's item bound uses.
const MAX_LIST_PAGES = 10_000;

export async function exhaustPages<P extends { nextCursor?: string }>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  collect: (page: P) => void,
): Promise<void> {
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await fetchPage(cursor);
    collect(page);
    const next = page.nextCursor || undefined;
    // A repeated cursor is the common non-terminating bug; refuse immediately
    // rather than loop forever.
    if (next !== undefined && next === cursor) {
      throw new InvocationError(
        ERR_PROTOCOL,
        `MCP server did not terminate pagination: nextCursor repeated (${next}) (MCP-P-02)`,
      );
    }
    if (++pages > MAX_LIST_PAGES) {
      throw new InvocationError(
        ERR_PROTOCOL,
        `MCP server did not terminate pagination: exceeded ${MAX_LIST_PAGES} pages (MCP-P-02)`,
      );
    }
    cursor = next;
  } while (cursor !== undefined);
}

/**
 * Obtains the entity family a ref needs from the addressed server,
 * capability-gated and followed to pagination exhaustion (MCP-P-02). Only
 * the family the ref addresses is fetched — resolution consults nothing
 * else, so the other families cannot affect it. The resources capability
 * gates both resource lists.
 */
export async function liveListing(client: Client, entityType: string, signal: AbortSignal): Promise<Listing> {
  const l: Listing = { tools: [], requiredTaskTools: [], toolOutputSchemas: {}, resources: [], templates: [], prompts: [], pinned: false };
  const caps = client.getServerCapabilities();
  if (!caps) return l;

  switch (entityType) {
    case "tools": {
      if (!caps.tools) return l;
      await exhaustPages(
        (cursor) => client.listTools(cursor !== undefined ? { cursor } : undefined, { signal }),
        (page) => {
          for (const t of page.tools ?? []) {
            l.tools.push(t.name);
            if (t.execution?.taskSupport === "required") l.requiredTaskTools!.push(t.name);
            if (t.outputSchema !== undefined) l.toolOutputSchemas![t.name] = t.outputSchema;
          }
        },
      );
      break;
    }
    case "prompts": {
      if (!caps.prompts) return l;
      await exhaustPages(
        (cursor) => client.listPrompts(cursor !== undefined ? { cursor } : undefined, { signal }),
        (page) => {
          for (const p of page.prompts ?? []) l.prompts.push(p.name);
        },
      );
      break;
    }
    default: {
      // resources
      if (!caps.resources) return l;
      await exhaustPages(
        (cursor) => client.listResources(cursor !== undefined ? { cursor } : undefined, { signal }),
        (page) => {
          for (const r of page.resources ?? []) l.resources.push(r.uri);
        },
      );
      await exhaustPages(
        (cursor) => client.listResourceTemplates(cursor !== undefined ? { cursor } : undefined, { signal }),
        (page) => {
          for (const t of page.resourceTemplates ?? []) l.templates.push(t.uriTemplate);
        },
      );
      break;
    }
  }
  return l;
}

/**
 * Resolves a parsed ref against the (pinned or live, exhausted) listing
 * BEFORE dispatch (§7, MCP-P-02): a remainder matching nothing makes the
 * binding unresolvable, and a remainder matching more than one entry is
 * ambiguous WITHIN its entity's collection and likewise unresolvable —
 * loudly, never first-match. resources matches only declared resource URIs;
 * resourceTemplates matches only declared template strings (§7, R5): the two
 * are separate namespaces, so a resource URI and a byte-identical template
 * string never collide — each is reached by its own entity token. Throws
 * InvocationError(ERR_REF_NOT_FOUND) on refusal.
 */
export function resolveRef(
  l: Listing,
  entityType: string,
  remainder: string,
  bindingSpec = BINDING_SPEC,
): TargetKind {
  const where = l.pinned ? "pinned listing" : "server listing";
  const ref = `${entityType}/${remainder}`;
  const count = (ids: string[]): number => ids.filter((id) => id === remainder).length;
  const notFound = (what: string): InvocationError =>
    new InvocationError(ERR_REF_NOT_FOUND, `MCP ref ${JSON.stringify(ref)} matches no ${what} in the ${where}`);
  const ambiguous = (what: string, n: number): InvocationError =>
    new InvocationError(
      ERR_REF_NOT_FOUND,
      `MCP ref ${JSON.stringify(ref)} is ambiguous: ${n} ${what}s in the ${where} share that identity; an ambiguous ref is unresolvable`,
    );

  switch (entityType) {
    case "tools": {
      const n = count(l.tools);
      if (n === 1) {
        if ((l.requiredTaskTools ?? []).includes(remainder)) {
          throw new InvocationError(
            ERR_REF_NOT_FOUND,
            `MCP ref ${JSON.stringify(ref)} names a tool that requires task augmentation, which ${bindingSpec} excludes`,
          );
        }
        if (bindingSpec === BINDING_SPEC && l.toolOutputSchemas?.[remainder] === undefined) {
          throw new InvocationError(
            ERR_REF_NOT_FOUND,
            `MCP tool ${JSON.stringify(remainder)} has no outputSchema application contract and is not bindable through ${BINDING_SPEC} (MCP-P-04)`,
          );
        }
        return "tool";
      }
      if (n > 1) throw ambiguous("tool", n);
      throw notFound("tool");
    }
    case "prompts": {
      if (bindingSpec === BINDING_SPEC) throw new InvocationError(ERR_REF_NOT_FOUND, "MCP prompts have no application output schema and are excluded by openbindings.mcp@1 (MCP-P-04)");
      const n = count(l.prompts);
      if (n === 1) return "prompt";
      if (n > 1) throw ambiguous("prompt", n);
      throw notFound("prompt");
    }
    case "resources": {
      if (bindingSpec === BINDING_SPEC) throw new InvocationError(ERR_REF_NOT_FOUND, "MCP resources have no application output schema and are excluded by openbindings.mcp@1 (MCP-P-04)");
      const n = count(l.resources);
      if (n === 1) return "staticResource";
      if (n > 1) throw ambiguous("resource", n);
      throw notFound("resource");
    }
    case "resourceTemplates": {
      if (bindingSpec === BINDING_SPEC) throw new InvocationError(ERR_REF_NOT_FOUND, "MCP resource templates have no application output schema and are excluded by openbindings.mcp@1 (MCP-P-04)");
      const t = count(l.templates);
      if (t === 1) return "templateResource";
      if (t > 1) throw ambiguous("resource template", t);
      throw notFound("resource template");
    }
    default:
      throw new InvocationError(
        ERR_REF_NOT_FOUND,
        `MCP ref ${JSON.stringify(ref)} names an unknown entity ${JSON.stringify(entityType)} (expected tools, resources, resourceTemplates, or prompts)`,
      );
  }
}
