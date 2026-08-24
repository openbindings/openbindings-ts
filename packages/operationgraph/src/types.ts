/**
 * Operation graph definition types (openbindings.operation-graph@0.2.0, the
 * transparency rewrite). A graph is the addressable unit of the format: a
 * binding's selector resolves to it via JSON Pointer; the JSON document hosting
 * it is unconstrained and carries no type here.
 */

/** One operation graph definition. */
export interface Graph {
  /**
   * The graph's own format version declaration (the
   * `openbindings.operation-graph` field). Each graph in a document declares
   * its own version independently (OG-V-01, OG-T-02).
   */
  "openbindings.operation-graph": string;
  description?: string;
  nodes: Record<string, Node>;
  edges: Edge[];
}

/**
 * A typed node. The `type` field is the discriminator determining which
 * other fields are valid (enforced by validate's per-type field whitelists,
 * mirroring the format schema).
 */
export interface Node {
  type: string;

  // All processing nodes (not input/output; OG-V-17).
  onError?: string;

  // operation (the conduit) and each.
  operation?: string;
  timeout?: number;

  // each only.
  maxIterations?: number;

  // buffer.
  limit?: number;
  until?: unknown;
  through?: unknown;

  // filter (schema-based).
  schema?: unknown;

  // filter (expression-based), transform, map.
  transform?: string;

  // exit.
  error?: boolean;
}

/** An edge connecting two nodes. Edges carry event streams and no logic. */
export interface Edge {
  from: string;
  to: string;
}

/**
 * Converts a JSON value (the target of a resolved selector) into a Graph. The
 * value must be a JSON object; structural validity beyond that is
 * validate's concern.
 */
export function graphFromValue(v: unknown): Graph {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("resolved selector value is not a JSON object");
  }
  return v as Graph;
}
