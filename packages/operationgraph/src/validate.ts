/**
 * Validates an operation graph against the well-formedness rules in the
 * openbindings.operation-graph@0.2.0 spec. Mirrors the Go reference
 * implementation; rule numbers in comments match the spec section.
 */
import type { Graph, Node } from "./types.js";

const KNOWN_NODE_TYPES = new Set([
  "input",
  "output",
  "operation",
  "buffer",
  "filter",
  "transform",
  "map",
  "combine",
  "exit",
]);

/**
 * Validates a graph. `operationKeys` is the set of valid operation keys from
 * the containing OBI; when undefined, the operation-existence check is
 * skipped (references will fail at runtime if invalid).
 */
export function validate(g: Graph | null | undefined, operationKeys?: Set<string>): void {
  if (!g) throw new Error("graph is nil");
  if (!g.nodes || Object.keys(g.nodes).length === 0) {
    throw new Error("graph has no nodes");
  }

  const errs: string[] = [];

  // Rules 1 & 2: exactly one input and one output node.
  let inputKey = "";
  let outputKey = "";
  let inputCount = 0;
  let outputCount = 0;
  for (const [key, node] of Object.entries(g.nodes)) {
    if (node.type === "input") {
      inputCount++;
      inputKey = key;
    } else if (node.type === "output") {
      outputCount++;
      outputKey = key;
    }
  }
  if (inputCount !== 1) errs.push(`expected exactly 1 input node, found ${inputCount}`);
  if (outputCount !== 1) errs.push(`expected exactly 1 output node, found ${outputCount}`);

  // Build adjacency.
  const outEdges = new Map<string, string[]>();
  const inEdges = new Map<string, string[]>();
  const edgeSeen = new Set<string>();
  const edges = g.edges ?? [];
  for (const e of edges) {
    // Rule 6: edges reference valid node keys.
    if (!(e.from in g.nodes)) errs.push(`edge references unknown node "${e.from}" in from`);
    if (!(e.to in g.nodes)) errs.push(`edge references unknown node "${e.to}" in to`);
    // Rule 7: no duplicate edges.
    const edgeKey = `${e.from} -> ${e.to}`;
    if (edgeSeen.has(edgeKey)) errs.push(`duplicate edge: ${edgeKey}`);
    edgeSeen.add(edgeKey);

    pushTo(outEdges, e.from, e.to);
    pushTo(inEdges, e.to, e.from);
  }

  // Rule 3: input has no incoming edges.
  if (inputKey && (inEdges.get(inputKey)?.length ?? 0) > 0) {
    errs.push("input node must not have incoming edges");
  }

  // Rule 4: output has no outgoing edges.
  if (outputKey && (outEdges.get(outputKey)?.length ?? 0) > 0) {
    errs.push("output node must not have outgoing edges");
  }

  // Rule 14: exit nodes have no outgoing edges.
  for (const [key, node] of Object.entries(g.nodes)) {
    if (node.type === "exit" && (outEdges.get(key)?.length ?? 0) > 0) {
      errs.push(`exit node "${key}" must not have outgoing edges`);
    }
  }

  // Rule 5: every node reachable from input via edges or onError references.
  if (inputKey) {
    const reachable = new Set<string>();
    const walk = (key: string): void => {
      if (reachable.has(key)) return;
      reachable.add(key);
      for (const to of outEdges.get(key) ?? []) walk(to);
      const node = g.nodes[key];
      if (node?.onError) walk(node.onError);
    };
    walk(inputKey);
    for (const key of Object.keys(g.nodes)) {
      if (!reachable.has(key)) errs.push(`node "${key}" is not reachable from input`);
    }
  }

  // Rule 8: every cycle must contain at least one operation node with maxIterations.
  const cycles = findCycles(g);
  for (const cycle of cycles) {
    cycle.sort();
    let hasGuard = false;
    for (const key of cycle) {
      const node = g.nodes[key];
      if (node.type === "operation" && node.maxIterations !== undefined) {
        hasGuard = true;
        break;
      }
    }
    if (!hasGuard) {
      errs.push(
        `cycle [${cycle.join(" -> ")}] must contain at least one operation node with maxIterations`,
      );
    }
  }

  // Per-node validation.
  for (const [key, node] of Object.entries(g.nodes)) {
    // Rule 12: valid type.
    if (!KNOWN_NODE_TYPES.has(node.type)) {
      errs.push(`node "${key}" has unsupported type "${node.type}"`);
    }

    // Rule 9: operation nodes reference valid operations.
    if (node.type === "operation") {
      if (!node.operation) {
        errs.push(`operation node "${key}" missing operation field`);
      } else if (operationKeys && !operationKeys.has(node.operation)) {
        errs.push(`operation node "${key}" references unknown operation "${node.operation}"`);
      }
    }

    // Rule 10: filter mutual exclusivity.
    if (node.type === "filter") {
      const hasSchema = node.schema !== undefined;
      const hasTransform = node.transform !== undefined;
      if (!hasSchema && !hasTransform) {
        errs.push(`filter node "${key}" must have schema or transform`);
      }
      if (hasSchema && hasTransform) {
        errs.push(`filter node "${key}" must have exactly one of schema or transform`);
      }
    }

    // Rule 11: buffer mutual exclusivity.
    if (node.type === "buffer" && node.until !== undefined && node.through !== undefined) {
      errs.push(`buffer node "${key}" must not have both until and through`);
    }

    // Rule 13: onError references valid node.
    if (node.onError && !(node.onError in g.nodes)) {
      errs.push(`node "${key}" onError references unknown node "${node.onError}"`);
    }

    // transform and map nodes require a transform field.
    if ((node.type === "transform" || node.type === "map") && node.transform === undefined) {
      errs.push(`${node.type} node "${key}" missing transform field`);
    }
  }

  if (errs.length > 0) {
    throw new Error(`validation errors:\n  ${errs.join("\n  ")}`);
  }
}

function pushTo(m: Map<string, string[]>, k: string, v: string): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * Returns all strongly connected components with more than one node,
 * plus single-node SCCs that have a self-loop. Implements Tarjan's algorithm.
 *
 * Iterative implementation: deep graphs would otherwise blow the call stack
 * for the recursive form used in the Go reference.
 */
function findCycles(g: Graph): string[][] {
  const outEdges = new Map<string, string[]>();
  for (const e of g.edges ?? []) pushTo(outEdges, e.from, e.to);

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
      frames.push({ v, iter: (outEdges.get(v) ?? [])[Symbol.iterator]() });
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

      // Frame finished — pop and propagate lowlink to parent.
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
          for (const to of outEdges.get(scc[0]) ?? []) {
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

  for (const key of Object.keys(g.nodes)) {
    if (!visited.has(key)) strongConnect(key);
  }
  return result;
}
