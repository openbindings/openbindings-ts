import type { DependencyEntry, OBInterface, Operation } from "./types.js";

/** A dependency and the exact local operation contract it references. */
export interface ResolvedDependency {
  /** The dependency's local map key. Dependency keys have no alias form. */
  key: string;
  dependency: DependencyEntry;
  /** The canonical operation key stored by the dependency entry. */
  operationKey: string;
  operation: Operation;
}

/**
 * Looks up a named dependency and its referenced operation.
 *
 * Dependency lookup is exact: dependency keys do not participate in operation
 * alias resolution. The operation reference is also an exact own-property key
 * per OBI-D-19. A validated OBI therefore either resolves completely or has no
 * result; malformed programmatically-constructed values fail closed.
 */
export function lookupDependency(
  iface: OBInterface,
  key: string,
): ResolvedDependency | undefined {
  const dependencies = iface.dependencies;
  if (!dependencies || !Object.hasOwn(dependencies, key)) return undefined;
  const dependency = dependencies[key];
  if (!dependency || typeof dependency.operation !== "string") return undefined;
  if (!Object.hasOwn(iface.operations, dependency.operation)) return undefined;
  const operation = iface.operations[dependency.operation];
  if (!operation) return undefined;
  return {
    key,
    dependency,
    operationKey: dependency.operation,
    operation,
  };
}
