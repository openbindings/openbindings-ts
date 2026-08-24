import * as protobuf from "protobufjs";
import type { OBInterface } from "@openbindings/core";
import type { SynthesisCoverageEntry, SynthesizerWarning } from "@openbindings/synthesize";
import { boundMethodRangeError } from "./schema-range.js";

/** Inventories every reflected protobuf RPC method and schema projection. */
export function protobufSynthesisCoverage(
  root: protobuf.Root | undefined,
  iface: OBInterface,
  warnings: SynthesizerWarning[],
  requirements: string[] = [],
): SynthesisCoverageEntry[] {
  if (!root) return [];
  const bySelector = new Map<string, { operationKey: string; bindingSelector: string }>();
  const byOperation = new Map<string, { operationKey: string; bindingSelector: string }>();
  for (const binding of Object.values(iface.bindings ?? {})) {
    if (!binding.selector) continue;
    const identity = { operationKey: binding.operation, bindingSelector: binding.selector };
    bySelector.set(binding.selector, identity);
    byOperation.set(binding.operation, identity);
  }

  const entries: SynthesisCoverageEntry[] = [];
  for (const service of collectServices(root)) {
    for (const method of Object.values(service.methods).sort((a, b) => compare(a.name, b.name))) {
      const selector = `${qualifiedName(service)}/${method.name}`;
      const reason = boundMethodRangeError(root, method);
      if (reason) {
        entries.push({
          sourceIndex: 0,
          sourceSelector: selector,
          scope: "target",
          status: "excluded",
          reasonCode: "grpc.schema_range",
          rule: "GRPC-P-03",
          message: reason,
        });
        continue;
      }
      const identity = bySelector.get(selector);
      if (!identity) {
        entries.push({
          sourceIndex: 0,
          sourceSelector: selector,
          scope: "target",
          status: "implementation-unsupported",
          reasonCode: "grpc.missing_emitted_binding",
          message: "the synthesizer returned without emitting this admitted protobuf RPC method",
        });
        continue;
      }
      entries.push({
        sourceIndex: 0,
        sourceSelector: selector,
        scope: "target",
        status: "represented",
        operationKey: identity.operationKey,
        bindingSelector: identity.bindingSelector,
        requirements: [...requirements],
      });
    }
  }
  for (const [index, warning] of warnings.entries()) {
    const identity = warningIdentity(warning.path, byOperation);
    if (!identity) continue;
    entries.push({
      sourceIndex: 0,
      sourceSelector: `${identity.bindingSelector}::projection::${warning.path ?? ""}::${warning.code}::${index}`,
      scope: "projection",
      status: "lossy",
      operationKey: identity.operationKey,
      bindingSelector: identity.bindingSelector,
      reasonCode: warning.code,
      message: warning.message,
      details: warning.details,
    });
  }
  return entries;
}

function warningIdentity(
  path: string | undefined,
  byOperation: Map<string, { operationKey: string; bindingSelector: string }>,
): { operationKey: string; bindingSelector: string } | undefined {
  if (!path) return undefined;
  for (const [operationKey, identity] of byOperation) {
    if (path === `operations.${operationKey}.input` || path === `operations.${operationKey}.output`) return identity;
  }
  return undefined;
}

function collectServices(root: protobuf.Root): protobuf.Service[] {
  const output: protobuf.Service[] = [];
  const walk = (namespace: protobuf.NamespaceBase): void => {
    for (const nested of namespace.nestedArray) {
      if (nested instanceof protobuf.Service && !qualifiedName(nested).startsWith("grpc.reflection.")) output.push(nested);
      if (nested instanceof protobuf.Namespace) walk(nested);
    }
  };
  walk(root);
  return output.sort((a, b) => compare(qualifiedName(a), qualifiedName(b)));
}

function qualifiedName(value: protobuf.ReflectionObject): string {
  return value.fullName.replace(/^\./, "");
}

function compare(a: string, b: string): number {
  const aa = [...a], bb = [...b];
  for (let index = 0; index < Math.min(aa.length, bb.length); index++) {
    const difference = aa[index]!.codePointAt(0)! - bb[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return aa.length - bb.length;
}
