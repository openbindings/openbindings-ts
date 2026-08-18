import type { OBInterface } from "./types.js";
import { schemaObjectForm } from "./types.js";
import { OperationNotFoundError } from "./errors.js";
import {
  allOperationIdentifiers,
  resolveOperation,
} from "./resolve-operation.js";
import {
  Normalizer,
  inputCompatible,
  outputCompatible,
} from "./schema-profile/index.js";

export type CompatibilityIssue = {
  operation: string;
  kind: "missing" | "output_incompatible" | "input_incompatible";
  detail?: string;
};

type RequiredOperationEntry = {
  name: string;
  operation: OBInterface["operations"][string];
};

/**
 * Checks whether a provided interface is compatible with a required
 * interface. For each operation the required interface declares by key, the
 * provided interface is searched by that name against its flat
 * key+aliases namespace (OBI-T-12): a provided operation matches if its key
 * equals the required key or one of its aliases does. Carrying the required
 * contract's operation name asserts correspondence; the schema checks below
 * separately evaluate structural compatibility.
 *
 * For each matched pair, schemas are normalized (resolving $ref pointers,
 * flattening allOf, etc.) and checked:
 *   - Output schemas must be compatible (provided output satisfies required output)
 *   - Input schemas must be compatible (required input satisfies provided input)
 *
 * Returns an empty array when the provided interface is fully compatible.
 * Issues appear in sorted required-operation-key order (never document
 * order), with the output issue before the input issue within an operation
 * — the same order the Go SDK's CheckInterfaceCompatibility emits.
 */
export async function checkInterfaceCompatibility(
  required: OBInterface,
  provided: OBInterface,
): Promise<CompatibilityIssue[]> {
  const requiredOperations = Object.entries(required.operations)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, operation]) => ({ name, operation }));
  return checkCompatibility(required, requiredOperations, provided);
}

/**
 * Checks one operation requirement against a provided interface.
 *
 * `operation` is resolved against the required interface's flat key+aliases
 * namespace, then that exact identifier is matched against the provided
 * interface. This is the per-operation primitive behind opportunistic use:
 * carrying part of a contract is normal, so unrelated operations in
 * `required` neither help nor prevent this result. Each side still normalizes
 * schemas against its complete containing document, preserving local `$ref`
 * meaning.
 *
 * Throws when `operation` is not an identifier carried by `required`.
 */
export async function checkOperationCompatibility(
  required: OBInterface,
  operation: string,
  provided: OBInterface,
): Promise<CompatibilityIssue[]> {
  const resolved = resolveOperation(required, operation);
  if (!resolved) {
    throw new OperationNotFoundError(
      operation,
      allOperationIdentifiers(required),
    );
  }
  return checkCompatibility(
    required,
    [{ name: operation, operation: resolved.operation }],
    provided,
  );
}

async function checkCompatibility(
  required: OBInterface,
  requiredOperations: RequiredOperationEntry[],
  provided: OBInterface,
): Promise<CompatibilityIssue[]> {
  const issues: CompatibilityIssue[] = [];

  // Normalizers resolve $refs against their respective interface's schemas.
  const reqNorm = new Normalizer({
    root: required as unknown as Record<string, unknown>,
  });
  const provNorm = new Normalizer({
    root: provided as unknown as Record<string, unknown>,
  });

  for (const { name: opKey, operation: requiredOp } of requiredOperations) {
    const providedOp = resolveOperation(provided, opKey)?.operation;
    if (!providedOp) {
      issues.push({ operation: opKey, kind: "missing" });
      continue;
    }

    // Per spec: absent/null schemas are "unspecified" (skip in
    // compatibility); {} and boolean schemas are specified and must be
    // checked. `true` is identical to {} and flows through the normal
    // check via schemaObjectForm. `false` — the spec's spelling for
    // "carries no input" / "emits no output" — is a call-convention fact,
    // not a value set the profile can express (its object spelling is
    // {"not": {}}, outside the profile), so it short-circuits: compatible
    // exactly with itself.
    if (requiredOp.output != null && providedOp.output != null) {
      if (requiredOp.output === false || providedOp.output === false) {
        if (requiredOp.output !== providedOp.output) {
          issues.push({
            operation: opKey,
            kind: "output_incompatible",
            detail:
              "output schema `false` (emits no output) is compatible only with `false`",
          });
        }
        // both false: compatible; fall through to the input check either way
      } else {
        const reqOutObj = schemaObjectForm(requiredOp.output);
        const provOutObj = schemaObjectForm(providedOp.output);
        if (reqOutObj === undefined || provOutObj === undefined) {
          issues.push({
            operation: opKey,
            kind: "output_incompatible",
            detail:
              "output schema check failed: schema is not a JSON Schema object or boolean",
          });
        } else {
          try {
            const reqOutput = await reqNorm.normalize(reqOutObj);
            const provOutput = await provNorm.normalize(provOutObj);
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
    }

    if (requiredOp.input != null && providedOp.input != null) {
      if (requiredOp.input === false || providedOp.input === false) {
        if (requiredOp.input !== providedOp.input) {
          issues.push({
            operation: opKey,
            kind: "input_incompatible",
            detail:
              "input schema `false` (carries no input) is compatible only with `false`",
          });
        }
        continue;
      }
      const reqInObj = schemaObjectForm(requiredOp.input);
      const provInObj = schemaObjectForm(providedOp.input);
      if (reqInObj === undefined || provInObj === undefined) {
        issues.push({
          operation: opKey,
          kind: "input_incompatible",
          detail:
            "input schema check failed: schema is not a JSON Schema object or boolean",
        });
        continue;
      }
      try {
        const reqInput = await reqNorm.normalize(reqInObj);
        const provInput = await provNorm.normalize(provInObj);
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
