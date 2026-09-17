/** The authentication registry: frozen containers this installation produced
 * (evaluator output, `external` output). An authenticated graph is admitted by
 * an engine without a walk or a copy. Module-private; the jsonata package
 * reaches it through the internal entry. */
import { admission } from "./errors.js";
import { isDecimal, isEncoded } from "./leaves.js";

const authenticated = new WeakSet<object>();

/** Mark one frozen container as this installation's output. */
export function authenticate(container: object): void {
  if (typeof container !== "object" || container === null || !Object.isFrozen(container)) {
    throw admission("Only a frozen container can be authenticated");
  }
  authenticated.add(container);
}

/** True when the container was produced and frozen by this installation. */
export function isAuthenticated(value: unknown): boolean {
  return typeof value === "object" && value !== null && authenticated.has(value);
}

/** Freeze every container of a graph this installation built and mark each.
 * The graph is trusted: it was built by this package or by the engine from
 * admitted data. Leaves are frozen already; primitives need nothing. */
export function authenticateGraph<T>(root: T): T {
  freezeAll(root);
  return root;
}

function freezeAll(value: unknown): void {
  if (typeof value !== "object" || value === null || isDecimal(value) || isEncoded(value) || authenticated.has(value)) return;
  Object.freeze(value);
  authenticated.add(value);
  if (Array.isArray(value)) { for (const item of value) freezeAll(item); }
  else for (const key of Object.keys(value)) freezeAll((value as Record<string, unknown>)[key]);
}
