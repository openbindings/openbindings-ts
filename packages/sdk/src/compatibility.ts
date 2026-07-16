import type { OBInterface } from "./types.js";
import { schemaObjectForm } from "./types.js";
import { resolveOperation } from "./resolve-operation.js";
import { Normalizer, inputCompatible, outputCompatible } from "./schema-profile/index.js";
import type { JSONObject } from "./schema-profile/index.js";

export type CompatibilityIssue = {
  operation: string;
  kind: "missing" | "output_incompatible" | "input_incompatible";
  detail?: string;
};

/**
 * Checks whether a provided interface satisfies the requirements of a
 * required interface. For each operation the required interface declares by
 * key, the provided interface is searched by that name against its flat
 * key+aliases namespace (OBI-T-12): a provided operation matches if its key
 * equals the required key or one of its aliases does. Carrying the required
 * contract's operation name as an alias is exactly how an implementation
 * claims to fulfill that contract.
 *
 * For each matched pair, schemas are normalized (resolving $ref pointers,
 * flattening allOf, etc.) and checked:
 *   - Output schemas must be compatible (provided output satisfies required output)
 *   - Input schemas must be compatible (required input satisfies provided input)
 *
 * Returns an empty array when the provided interface is fully compatible.
 */
export async function checkInterfaceCompatibility(
  required: OBInterface,
  provided: OBInterface,
): Promise<CompatibilityIssue[]> {
  const issues: CompatibilityIssue[] = [];

  // Normalizers resolve $refs against their respective interface's schemas.
  const reqNorm = new Normalizer({ root: required as unknown as Record<string, unknown> });
  const provNorm = new Normalizer({ root: provided as unknown as Record<string, unknown> });

  for (const [opKey, requiredOp] of Object.entries(required.operations)) {
    const providedOp = resolveOperation(provided, opKey)?.operation;
    if (!providedOp) {
      issues.push({ operation: opKey, kind: "missing" });
      continue;
    }

    // Per spec: absent/null schemas are "unspecified" (skip in
    // compatibility); {} and boolean schemas are specified and must be
    // checked. Boolean schemas take their equivalent object spellings
    // (true = {}, false = {"not": {}}) so the profile normalizer sees one
    // form.
    if (requiredOp.output != null && providedOp.output != null) {
      const reqOutObj = schemaObjectForm(requiredOp.output);
      const provOutObj = schemaObjectForm(providedOp.output);
      if (reqOutObj === undefined || provOutObj === undefined) {
        issues.push({
          operation: opKey,
          kind: "output_incompatible",
          detail: "output schema check failed: schema is not a JSON Schema object or boolean",
        });
      } else {
        try {
          const reqOutput = await reqNorm.normalize(reqOutObj as JSONObject);
          const provOutput = await provNorm.normalize(provOutObj as JSONObject);
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
    }

    if (requiredOp.input != null && providedOp.input != null) {
      const reqInObj = schemaObjectForm(requiredOp.input);
      const provInObj = schemaObjectForm(providedOp.input);
      if (reqInObj === undefined || provInObj === undefined) {
        issues.push({
          operation: opKey,
          kind: "input_incompatible",
          detail: "input schema check failed: schema is not a JSON Schema object or boolean",
        });
        continue;
      }
      try {
        const reqInput = await reqNorm.normalize(reqInObj as JSONObject);
        const provInput = await provNorm.normalize(provInObj as JSONObject);
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
