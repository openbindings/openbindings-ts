import type { OBInterface, Operation } from "./types.js";
import { Normalizer, inputCompatible, outputCompatible } from "./schema-profile/index.js";
import type { JSONObject } from "./schema-profile/index.js";

export type CompatibilityIssue = {
  operation: string;
  kind: "missing" | "output_incompatible" | "input_incompatible";
  detail?: string;
};

export type CheckCompatibilityOptions = {
  /**
   * Role key identifying the required interface (e.g., "openbindings.workspace-manager").
   * When provided, enables `satisfies`-based matching: an operation in the provided
   * interface can satisfy a required operation via its `satisfies` array entry
   * `{ role: requiredInterfaceId, operation: opKey }`.
   */
  requiredInterfaceId?: string;
};

/**
 * Checks whether a provided interface satisfies the requirements of a
 * required interface. For each operation the required interface declares,
 * the algorithm searches the provided interface using three strategies
 * (first match wins):
 *
 *   1. **Direct key match** — `provided.operations[opKey]` exists
 *   2. **Satisfies match** — any provided operation has a `satisfies` entry
 *      with `{ role: requiredInterfaceId, operation: opKey }`
 *      (requires `options.requiredInterfaceId`)
 *   3. **Aliases match** — any provided operation has `aliases` containing `opKey`
 *
 * For each matched pair, schemas are normalized (resolving $ref pointers,
 * flattening allOf, etc.) and checked:
 *   - Output schemas must be compatible (executor output satisfies required output)
 *   - Input schemas must be compatible (required input satisfies executor input)
 *
 * Returns an empty array when the provided interface is fully compatible.
 */
export async function checkInterfaceCompatibility(
  required: OBInterface,
  provided: OBInterface,
  options?: CheckCompatibilityOptions,
): Promise<CompatibilityIssue[]> {
  const issues: CompatibilityIssue[] = [];
  const interfaceId = options?.requiredInterfaceId;

  // Normalizers resolve $refs against their respective interface's schemas.
  const reqNorm = new Normalizer({ root: required as unknown as Record<string, unknown> });
  const provNorm = new Normalizer({ root: provided as unknown as Record<string, unknown> });

  for (const [opKey, requiredOp] of Object.entries(required.operations)) {
    const providedOp = findMatchingOperation(provided, opKey, interfaceId);
    if (!providedOp) {
      issues.push({ operation: opKey, kind: "missing" });
      continue;
    }

    if (requiredOp.output && providedOp.output) {
      try {
        const reqOutput = await reqNorm.normalize(requiredOp.output as JSONObject);
        const provOutput = await provNorm.normalize(providedOp.output as JSONObject);
        const outputResult = outputCompatible(reqOutput, provOutput);
        if (!outputResult.compatible) {
          issues.push({
            operation: opKey,
            kind: "output_incompatible",
            detail: outputResult.reason
              ? `provided output does not satisfy the required output schema: ${outputResult.reason}`
              : "provided output does not satisfy the required output schema",
          });
        }
      } catch (e: unknown) {
        issues.push({
          operation: opKey,
          kind: "output_incompatible",
          detail: `output schema check failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    if (requiredOp.input && providedOp.input) {
      try {
        const reqInput = await reqNorm.normalize(requiredOp.input as JSONObject);
        const provInput = await provNorm.normalize(providedOp.input as JSONObject);
        const inputResult = inputCompatible(reqInput, provInput);
        if (!inputResult.compatible) {
          issues.push({
            operation: opKey,
            kind: "input_incompatible",
            detail: inputResult.reason
              ? `provided input is not compatible with the required input schema: ${inputResult.reason}`
              : "provided input is not compatible with the required input schema",
          });
        }
      } catch (e: unknown) {
        issues.push({
          operation: opKey,
          kind: "input_incompatible",
          detail: `input schema check failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  return issues;
}

/**
 * Finds an operation in `provided` that matches the required `opKey`, using
 * the three-strategy search: direct key, satisfies, aliases.
 */
function findMatchingOperation(
  provided: OBInterface,
  opKey: string,
  requiredInterfaceId?: string,
): Operation | undefined {
  // 1. Direct key match
  if (provided.operations[opKey]) {
    return provided.operations[opKey];
  }

  // 2. Satisfies match (only when requiredInterfaceId is known)
  if (requiredInterfaceId) {
    for (const op of Object.values(provided.operations)) {
      if (
        op.satisfies?.some(
          (s) => s.role === requiredInterfaceId && s.operation === opKey,
        )
      ) {
        return op;
      }
    }
  }

  // 3. Aliases match
  for (const op of Object.values(provided.operations)) {
    if (op.aliases?.includes(opKey)) {
      return op;
    }
  }

  return undefined;
}

/** Returns true if a value looks like a valid OBInterface document. */
export function isOBInterface(v: unknown): v is OBInterface {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.openbindings === "string" &&
    typeof obj.operations === "object" &&
    obj.operations !== null &&
    !Array.isArray(obj.operations)
  );
}
