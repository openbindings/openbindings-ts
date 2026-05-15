/**
 * Operation graph source document types (openbindings.operation-graph@0.2.0).
 */

/** Top-level operation graph source document. */
export interface Document {
  "openbindings.operation-graph": string;
  graphs: Record<string, Graph>;
}

/** A single named operation graph. */
export interface Graph {
  description?: string;
  nodes: Record<string, Node>;
  edges: Edge[];
}

/**
 * A typed node in the graph. The `type` field determines which other
 * fields are meaningful.
 */
export interface Node {
  type: string;

  // All nodes
  onError?: string;

  // operation
  operation?: string;
  maxIterations?: number;
  timeout?: number;

  // buffer
  limit?: number;
  until?: unknown;
  through?: unknown;

  // filter (schema-based)
  schema?: unknown;

  // filter (expression-based), transform, map
  transform?: string;

  // exit
  error?: boolean;
}

/** An edge connecting two nodes. */
export interface Edge {
  from: string;
  to: string;
}

/**
 * Parses an operation graph source document from JSON text or an already-parsed
 * object.
 */
export function parseDocument(data: unknown): Document {
  let parsed: unknown;
  if (typeof data === "string") {
    parsed = JSON.parse(data);
  } else if (data instanceof Uint8Array) {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } else {
    parsed = data;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("operation graph document must be a JSON object");
  }
  return parsed as Document;
}
