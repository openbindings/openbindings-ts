import type { ValidationFailure } from "@openbindings/core";

export type ValidationPhase = "input" | "output";

/**
 * Process-local evidence explaining an operation validation failure. It never
 * becomes InvocationError.data and never contains the rejected value,
 * protocol metadata, credentials, or validator prose.
 */
export interface InvocationDiagnostic {
  readonly phase: ValidationPhase;
  readonly operationKey: string;
  readonly bindingKey: string;
  readonly instancePointer: string;
  readonly schemaPointer?: string;
  readonly keyword?: string;
}

/** A private snapshot of a bounded diagnostic collector. */
export interface InvocationDiagnosticSnapshot {
  readonly records: readonly InvocationDiagnostic[];
  readonly truncated: boolean;
}

/**
 * Bounded process-local side channel for validation evidence. There is no
 * callback into consumer code, so collection cannot alter or delay invocation.
 */
export class DiagnosticCollector {
  readonly limit: number;
  readonly #records: InvocationDiagnostic[] = [];
  #truncated = false;

  constructor(options?: { readonly limit?: number }) {
    const value = options?.limit;
    this.limit = value !== undefined && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 32;
  }

  snapshot(): InvocationDiagnosticSnapshot {
    return Object.freeze({
      records: Object.freeze(this.#records.map(record => Object.freeze({ ...record }))),
      truncated: this.#truncated,
    });
  }

  /** @internal */
  recordValidation(
    phase: ValidationPhase,
    operationKey: string,
    bindingKey: string,
    failures: readonly ValidationFailure[],
  ): void {
    const remaining = this.limit - this.#records.length;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    const normalized = failures.slice(0, remaining).map(failure => {
      const schemaPointer = failure.schemaPath;
      const tokens = schemaPointer?.split("/").filter(Boolean) ?? [];
      const keyword = tokens.at(-1);
      return {
        phase,
        operationKey,
        bindingKey,
        instancePointer: safeInstancePointer(failure.path, schemaPointer),
        ...(schemaPointer ? { schemaPointer } : {}),
        ...(keyword ? { keyword } : {}),
      } satisfies InvocationDiagnostic;
    }).sort((left, right) =>
      compareStrings(left.instancePointer, right.instancePointer) ||
      compareStrings(left.schemaPointer ?? "", right.schemaPointer ?? "") ||
      compareStrings(left.keyword ?? "", right.keyword ?? "")
    );

    this.#records.push(...normalized);
    if (failures.length > remaining) this.#truncated = true;
  }
}

function safeInstancePointer(instancePointer: string, schemaPointer?: string): string {
  const schema = pointerTokens(schemaPointer ?? "");
  const declared = new Set<string>();
  for (let index = 0; index + 1 < schema.length; index++) {
    if (schema[index] === "properties") {
      declared.add(schema[index + 1]!);
      index++;
    }
  }
  return encodePointer(pointerTokens(instancePointer).map(token =>
    declared.has(token) ? token : "*"
  ));
}

function pointerTokens(pointer: string): string[] {
  if (!pointer) return [];
  return pointer.slice(1).split("/").map(token =>
    token.replaceAll("~1", "/").replaceAll("~0", "~")
  );
}

function encodePointer(tokens: readonly string[]): string {
  if (tokens.length === 0) return "";
  return `/${tokens.map(token => token.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
