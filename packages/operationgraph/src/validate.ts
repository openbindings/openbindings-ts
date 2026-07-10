/**
 * Enforces the format spec's validation rules OG-V-01 through OG-V-17 on one
 * graph definition, plus the per-type field whitelists the format's JSON
 * Schema expresses structurally (which is how OG-V-17 and the each/operation
 * field split are caught without a separate schema pass).
 *
 * `validateGraph` returns structured issues (rule id + offending node keys)
 * so callers like graph editors can attribute failures to nodes; `validate`
 * is the throwing form used by the invoker (OG-T-01).
 */
import { SUPPORTED_MAJOR, SUPPORTED_MINOR } from "./constants.js";
import type { Graph, Node } from "./types.js";

/** The SemVer 2.0.0 pattern (the same pattern the format schema carries). */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * OG-T-02: refuses a graph declaring a format version this implementation
 * does not support. Returns an error message, or null when supported.
 */
// Keyword-shape tables for the OG-V-18 walk: recursion follows JSON Schema
// 2020-12 keyword shapes so property NAMES under `properties`/`$defs`/etc.
// are schema content, never treated as keywords (the same discipline as the
// core SDK's schema walk).
const EMBEDDED_MAP_KEYWORDS = new Set([
  "properties", "patternProperties", "$defs", "definitions", "dependentSchemas",
]);
const EMBEDDED_SINGLE_KEYWORDS = new Set([
  "items", "additionalItems", "unevaluatedItems", "contains",
  "additionalProperties", "unevaluatedProperties", "propertyNames", "not",
  "if", "then", "else", "contentSchema",
]);
const EMBEDDED_ARRAY_KEYWORDS = new Set(["prefixItems", "allOf", "anyOf", "oneOf"]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * OG-V-18 on one embedded schema object: $schema, when present, equals the
 * 2020-12 dialect URI, and $vocabulary appears at no schema position within
 * the tree. Recursion is keyword-shape-aware: only schema positions walk.
 */
function validateEmbeddedSchema(
  report: (message: string) => void,
  prefix: string,
  s: Record<string, unknown>,
): void {
  const draft202012 = "https://json-schema.org/draft/2020-12/schema";
  if (typeof s.$schema === "string" && s.$schema !== draft202012) {
    report(`${prefix}: $schema "${s.$schema}" must equal "${draft202012}" (OG-V-18)`);
  }
  if ("$vocabulary" in s) {
    report(`${prefix}: $vocabulary is forbidden in embedded schemas (OG-V-18)`);
  }
  for (const [k, v] of Object.entries(s)) {
    if (EMBEDDED_MAP_KEYWORDS.has(k) && isObj(v)) {
      for (const [mk, mv] of Object.entries(v)) {
        if (isObj(mv)) validateEmbeddedSchema(report, `${prefix}.${k}.${mk}`, mv);
      }
    } else if (EMBEDDED_SINGLE_KEYWORDS.has(k) && isObj(v)) {
      validateEmbeddedSchema(report, `${prefix}.${k}`, v);
    } else if (EMBEDDED_ARRAY_KEYWORDS.has(k) && Array.isArray(v)) {
      v.forEach((item, i) => {
        if (isObj(item)) validateEmbeddedSchema(report, `${prefix}.${k}[${i}]`, item);
      });
    }
  }
}

export function checkVersion(version: string): string | null {
  const m = SEMVER_RE.exec(version);
  if (!m) return `version "${version}" is not a SemVer 2.0.0 string`;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > SUPPORTED_MAJOR || (SUPPORTED_MAJOR === 0 && major === 0 && minor > SUPPORTED_MINOR)) {
    return `OG-T-02: graph declares openbindings.operation-graph ${version}; this implementation supports up to ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}.x`;
  }
  if (major < SUPPORTED_MAJOR || (SUPPORTED_MAJOR === 0 && major === 0 && minor < SUPPORTED_MINOR)) {
    return `OG-T-02: graph declares openbindings.operation-graph ${version}; this implementation supports no lower than ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}.x`;
  }
  if (m[4]) {
    return `OG-T-02: graph declares prerelease openbindings.operation-graph ${version}; this implementation declares no prerelease support`;
  }
  return null;
}

/**
 * One validation failure. `rule` is the stable identifier from the format
 * spec's Validation rules section (OG-V-##) when the failure maps to a
 * numbered rule; per-type field-whitelist failures (the schema's structural
 * enforcement) carry no rule id unless they realize OG-V-17. `nodeKeys`
 * names the offending node(s) when the failure is attributable — a graph
 * editor can highlight them directly.
 */
export interface GraphValidationIssue {
  rule?: string;
  message: string;
  nodeKeys?: string[];
}

/** Renders an issue the way the throwing `validate` reports it. */
export function formatIssue(issue: GraphValidationIssue): string {
  return issue.rule ? `${issue.rule}: ${issue.message}` : issue.message;
}

interface FieldRules {
  allowed: Set<string>;
  required: string[];
}

function rules(required: string[], ...allowed: string[]): FieldRules {
  return { allowed: new Set([...required, ...allowed]), required };
}

const NODE_FIELD_RULES: Record<string, FieldRules> = {
  input: rules([]),
  output: rules([]),
  operation: rules(["operation"], "timeout", "onError"),
  each: rules(["operation"], "maxIterations", "timeout", "onError"),
  transform: rules(["transform"], "onError"),
  filter: rules([], "schema", "transform", "onError"),
  map: rules(["transform"], "onError"),
  buffer: rules([], "limit", "until", "through", "onError"),
  combine: rules([], "onError"),
  exit: rules([], "error", "onError"),
};

const SPEC_FIELDS = [
  "onError",
  "operation",
  "maxIterations",
  "timeout",
  "limit",
  "until",
  "through",
  "schema",
  "transform",
  "error",
] as const;

// Per-field value types (the schema's structural enforcement, matching the
// strict decode typed implementations perform). In particular `transform` is
// a plain JSONata expression string — not an object wrapper.
const FIELD_TYPES: Record<string, { ok: (v: unknown) => boolean; expected: string }> = {
  onError: { ok: (v) => typeof v === "string", expected: "string" },
  operation: { ok: (v) => typeof v === "string", expected: "string" },
  transform: { ok: (v) => typeof v === "string", expected: "string (a JSONata expression)" },
  maxIterations: { ok: (v) => typeof v === "number", expected: "number" },
  timeout: { ok: (v) => typeof v === "number", expected: "number" },
  limit: { ok: (v) => typeof v === "number", expected: "number" },
  schema: { ok: isPlainObject, expected: "object (a JSON Schema)" },
  until: { ok: isPlainObject, expected: "object (a JSON Schema)" },
  through: { ok: isPlainObject, expected: "object (a JSON Schema)" },
  error: { ok: (v) => typeof v === "boolean", expected: "boolean" },
};

function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function presentFields(n: Node): string[] {
  return SPEC_FIELDS.filter((f) => (n as unknown as Record<string, unknown>)[f] !== undefined);
}

/**
 * All spec-defined node fields across every node type — the universe the
 * per-type whitelists draw from. Fields outside this list (x-* extensions,
 * future spec additions) are not the validator's concern.
 */
export const SPEC_NODE_FIELDS: readonly string[] = SPEC_FIELDS;

/**
 * The spec's field whitelist for a node type (required fields included), or
 * undefined for an unknown type. Lets editors derive which fields survive a
 * node retype instead of duplicating spec knowledge.
 */
export function allowedNodeFields(type: string): ReadonlySet<string> | undefined {
  return NODE_FIELD_RULES[type]?.allowed;
}

/** The spec's required fields for a node type, or undefined for an unknown type. */
export function requiredNodeFields(type: string): readonly string[] | undefined {
  return NODE_FIELD_RULES[type]?.required;
}

/**
 * Validates a graph, returning structured issues (empty = valid).
 * `operationKeys` is the set of operation keys the containing OBI declares;
 * when undefined, the OG-V-11 reference check is skipped (references then
 * fail at invocation time).
 */
export function validateGraph(
  g: Graph | null | undefined,
  operationKeys?: Set<string>,
): GraphValidationIssue[] {
  if (!g) return [{ message: "graph is nil" }];
  if (!g.nodes || Object.keys(g.nodes).length === 0) {
    return [{ message: "graph has no nodes" }];
  }

  const issues: GraphValidationIssue[] = [];

  // OG-V-01: version field present and SemVer 2.0.0.
  const version = g["openbindings.operation-graph"];
  if (version === undefined || version === "") {
    issues.push({
      rule: "OG-V-01",
      message: "graph must declare an openbindings.operation-graph version field",
    });
  } else if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    issues.push({
      rule: "OG-V-01",
      message: `version "${version}" is not a SemVer 2.0.0 string`,
    });
  }

  // OG-V-02 / OG-V-03: exactly one input and one output node.
  const inputKeys: string[] = [];
  const outputKeys: string[] = [];
  for (const [key, node] of Object.entries(g.nodes)) {
    if (node.type === "input") inputKeys.push(key);
    else if (node.type === "output") outputKeys.push(key);
  }
  const inputKey = inputKeys.length === 1 ? inputKeys[0] : "";
  const outputKey = outputKeys.length === 1 ? outputKeys[0] : "";
  if (inputKeys.length !== 1) {
    issues.push({
      rule: "OG-V-02",
      message: `expected exactly 1 input node, found ${inputKeys.length}`,
      nodeKeys: inputKeys.length > 0 ? inputKeys : undefined,
    });
  }
  if (outputKeys.length !== 1) {
    issues.push({
      rule: "OG-V-03",
      message: `expected exactly 1 output node, found ${outputKeys.length}`,
      nodeKeys: outputKeys.length > 0 ? outputKeys : undefined,
    });
  }

  // Adjacency; OG-V-07 (valid endpoints) and OG-V-08 (no duplicates).
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();
  const edgeSeen = new Set<string>();
  for (const e of g.edges ?? []) {
    if (!(e.from in g.nodes)) {
      issues.push({
        rule: "OG-V-07",
        message: `edge references unknown node "${e.from}" in from`,
        nodeKeys: e.to in g.nodes ? [e.to] : undefined,
      });
    }
    if (!(e.to in g.nodes)) {
      issues.push({
        rule: "OG-V-07",
        message: `edge references unknown node "${e.to}" in to`,
        nodeKeys: e.from in g.nodes ? [e.from] : undefined,
      });
    }
    const edgeKey = `${e.from} -> ${e.to}`;
    if (edgeSeen.has(edgeKey)) {
      issues.push({
        rule: "OG-V-08",
        message: `duplicate edge: ${edgeKey}`,
        nodeKeys: [e.from, e.to].filter((k) => k in g.nodes),
      });
    }
    edgeSeen.add(edgeKey);
    pushTo(outEdges, e.from, e.to);
    pushTo(inEdges, e.to, e.from);
  }

  // OG-V-04 / OG-V-05: boundary edge constraints.
  if (inputKey && (inEdges.get(inputKey)?.length ?? 0) > 0) {
    issues.push({
      rule: "OG-V-04",
      message: "input node must not have incoming edges",
      nodeKeys: [inputKey],
    });
  }
  if (outputKey && (outEdges.get(outputKey)?.length ?? 0) > 0) {
    issues.push({
      rule: "OG-V-05",
      message: "output node must not have outgoing edges",
      nodeKeys: [outputKey],
    });
  }

  // OG-V-16: exit nodes have no outgoing edges.
  for (const [key, node] of Object.entries(g.nodes)) {
    if (node.type === "exit" && (outEdges.get(key)?.length ?? 0) > 0) {
      issues.push({
        rule: "OG-V-16",
        message: `exit node "${key}" must not have outgoing edges`,
        nodeKeys: [key],
      });
    }
  }

  // succ is the control adjacency: data edges plus onError references.
  // Both OG-V-06 (reachability) and OG-V-09/OG-V-10 (cycles) follow it.
  const succ = new Map<string, string[]>();
  for (const [key, node] of Object.entries(g.nodes)) {
    const next = [...(outEdges.get(key) ?? [])];
    if (node.onError) next.push(node.onError);
    succ.set(key, next);
  }

  // OG-V-06: every node reachable from input.
  if (inputKey) {
    const reachable = new Set<string>();
    const walk = (key: string): void => {
      if (reachable.has(key)) return;
      reachable.add(key);
      for (const next of succ.get(key) ?? []) {
        if (next in g.nodes) walk(next);
      }
    };
    walk(inputKey);
    for (const key of Object.keys(g.nodes)) {
      if (!reachable.has(key)) {
        issues.push({
          rule: "OG-V-06",
          message: `node "${key}" is not reachable from input`,
          nodeKeys: [key],
        });
      }
    }
  }

  // OG-V-09 / OG-V-10: cycle rules over the control adjacency.
  for (const cycle of findCycles(g.nodes, succ)) {
    cycle.sort();
    let hasBoundedEach = false;
    for (const key of cycle) {
      const node = g.nodes[key];
      if (node.type === "each" && node.maxIterations !== undefined) hasBoundedEach = true;
      if (node.type === "operation") {
        issues.push({
          rule: "OG-V-10",
          message: `operation node "${key}" must not participate in a cycle [${cycle.join(" -> ")}]`,
          nodeKeys: [key],
        });
      }
    }
    if (!hasBoundedEach) {
      issues.push({
        rule: "OG-V-09",
        message: `cycle [${cycle.join(" -> ")}] must contain at least one each node with maxIterations`,
        nodeKeys: [...cycle],
      });
    }
  }

  // Per-node rules: OG-V-11 .. OG-V-15, OG-V-17, plus per-type field
  // whitelists (the schema's structural enforcement).
  for (const [key, node] of Object.entries(g.nodes)) {
    const fields = NODE_FIELD_RULES[node.type];
    if (!fields) {
      issues.push({
        rule: "OG-V-14",
        message: `node "${key}" has unsupported type "${node.type}"`,
        nodeKeys: [key],
      });
      continue;
    }

    for (const f of presentFields(node)) {
      if (!fields.allowed.has(f)) {
        const isBoundaryOnError =
          f === "onError" && (node.type === "input" || node.type === "output");
        issues.push({
          rule: isBoundaryOnError ? "OG-V-17" : undefined,
          message: `node "${key}" (${node.type}) does not permit field "${f}"`,
          nodeKeys: [key],
        });
        continue;
      }
      const ft = FIELD_TYPES[f];
      const value = (node as unknown as Record<string, unknown>)[f];
      if (ft && !ft.ok(value)) {
        issues.push({
          message: `node "${key}" field "${f}" must be a ${ft.expected}`,
          nodeKeys: [key],
        });
      }
    }
    for (const f of fields.required) {
      if ((node as unknown as Record<string, unknown>)[f] === undefined) {
        issues.push({
          message: `${node.type} node "${key}" missing ${f} field`,
          nodeKeys: [key],
        });
      }
    }

    // OG-V-11: operation and each references resolve in the containing OBI.
    if ((node.type === "operation" || node.type === "each") && node.operation) {
      if (operationKeys && !operationKeys.has(node.operation)) {
        issues.push({
          rule: "OG-V-11",
          message: `${node.type} node "${key}" references unknown operation "${node.operation}"`,
          nodeKeys: [key],
        });
      }
    }

    // OG-V-12: filter mutual exclusivity (exactly one of schema/transform).
    if (node.type === "filter") {
      const hasSchema = node.schema !== undefined;
      const hasTransform = node.transform !== undefined;
      if (hasSchema === hasTransform) {
        issues.push({
          rule: "OG-V-12",
          message: `filter node "${key}" must have exactly one of schema or transform`,
          nodeKeys: [key],
        });
      }
    }

    // OG-V-18: embedded schemas are 2020-12 objects — $schema, when
    // present, pinned to the 2020-12 URI; $vocabulary nowhere within.
    for (const [field, embedded] of [
      ["schema", (node as unknown as Record<string, unknown>).schema],
      ["until", (node as unknown as Record<string, unknown>).until],
      ["through", (node as unknown as Record<string, unknown>).through],
    ] as Array<[string, unknown]>) {
      if (embedded === undefined) continue;
      if (typeof embedded !== "object" || embedded === null || Array.isArray(embedded)) {
        issues.push({
          rule: "OG-V-18",
          message: `node "${key}" ${field} must be a JSON Schema 2020-12 object`,
          nodeKeys: [key],
        });
        continue;
      }
      validateEmbeddedSchema(
        (message) => issues.push({ rule: "OG-V-18", message, nodeKeys: [key] }),
        `node "${key}" ${field}`,
        embedded as Record<string, unknown>,
      );
    }

    // OG-V-13: buffer until/through mutual exclusivity.
    if (node.type === "buffer" && node.until !== undefined && node.through !== undefined) {
      issues.push({
        rule: "OG-V-13",
        message: `buffer node "${key}" must not have both until and through`,
        nodeKeys: [key],
      });
    }

    // OG-V-15: onError references an existing node.
    if (node.onError && !(node.onError in g.nodes)) {
      issues.push({
        rule: "OG-V-15",
        message: `node "${key}" onError references unknown node "${node.onError}"`,
        nodeKeys: [key],
      });
    }
  }

  return issues;
}

/**
 * Throwing form of {@link validateGraph}: the OG-T-01 gate used by the
 * invoker. Throws an Error joining every issue, one per line.
 */
export function validate(g: Graph | null | undefined, operationKeys?: Set<string>): void {
  const issues = validateGraph(g, operationKeys);
  if (issues.length === 0) return;
  if (issues.length === 1 && issues[0].nodeKeys === undefined && issues[0].rule === undefined) {
    // Shape preconditions ("graph is nil", "graph has no nodes") throw bare,
    // matching the historical behavior.
    throw new Error(issues[0].message);
  }
  throw new Error(`validation errors:\n  ${issues.map(formatIssue).join("\n  ")}`);
}

function pushTo(m: Map<string, string[]>, k: string, v: string): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * Returns all strongly connected components with more than one node, plus
 * single-node SCCs with a self-loop, over the given adjacency (data edges
 * plus onError references). Iterative Tarjan (deep graphs would blow the
 * call stack in recursive form).
 */
function findCycles(nodes: Record<string, Node>, succ: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const visited = new Set<string>();
  const result: string[][] = [];

  type Frame = { v: string; iter: Iterator<string> };

  const strongConnect = (start: string): void => {
    const frames: Frame[] = [];
    const init = (v: string): void => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      visited.add(v);
      stack.push(v);
      onStack.add(v);
      const next = (succ.get(v) ?? []).filter((w) => w in nodes);
      frames.push({ v, iter: next[Symbol.iterator]() });
    };
    init(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const next = frame.iter.next();
      if (!next.done) {
        const w = next.value;
        if (!visited.has(w)) {
          init(w);
          continue;
        }
        if (onStack.has(w)) {
          const wIdx = indices.get(w)!;
          if (wIdx < lowlinks.get(frame.v)!) lowlinks.set(frame.v, wIdx);
        }
        continue;
      }

      frames.pop();
      if (lowlinks.get(frame.v) === indices.get(frame.v)) {
        const scc: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
          if (w === frame.v) break;
        }
        if (scc.length > 1) {
          result.push(scc);
        } else if (scc.length === 1) {
          for (const to of succ.get(scc[0]) ?? []) {
            if (to === scc[0]) {
              result.push(scc);
              break;
            }
          }
        }
      }
      if (frames.length > 0) {
        const parent = frames[frames.length - 1];
        const childLow = lowlinks.get(frame.v)!;
        if (childLow < lowlinks.get(parent.v)!) lowlinks.set(parent.v, childLow);
      }
    }
  };

  for (const key of Object.keys(nodes)) {
    if (!visited.has(key)) strongConnect(key);
  }
  return result;
}
