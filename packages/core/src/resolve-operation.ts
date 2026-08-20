import type { OBInterface, Operation } from "./types.js";

/** An operation resolved by name, together with its canonical (primary) key. */
export interface ResolvedOperation {
  /** The operation's primary key (the value bindings reference in `operation`). */
  key: string;
  operation: Operation;
}

/**
 * Resolves an operation by name against an interface, per OBI-T-12.
 *
 * An operation's identifiers are its key plus its `aliases`; together they form
 * one flat namespace in which key and alias matches are equally authoritative.
 * OBI-D-04 makes that namespace document-unique, so a name resolves to at most
 * one operation. Key matches are NOT privileged over alias matches: a name that
 * is some operation's native key always belongs to that operation (a different
 * operation cannot also carry it as an alias without violating OBI-D-04).
 *
 * Returns the resolved operation and its canonical key, or `undefined` if the
 * name matches no identifier. Binding selection MUST use the returned `key`, not
 * the name the caller looked up by.
 */
export function resolveOperation(
  iface: OBInterface,
  name: string,
): ResolvedOperation | undefined {
  const ops = iface.operations;

  // Direct key match. By OBI-D-04 a key is never also another operation's alias,
  // so this is authoritative when it hits — order relative to alias search is
  // irrelevant to the result. Own property only: a name such as "constructor"
  // must match an operation the document actually defines, never a Function
  // inherited from the map object's prototype chain.
  const direct = Object.hasOwn(ops, name) ? ops[name] : undefined;
  if (direct) return { key: name, operation: direct };

  // Alias match across the flat namespace.
  for (const [key, op] of Object.entries(ops)) {
    if (op.aliases?.includes(name)) return { key, operation: op };
  }

  return undefined;
}

/**
 * Returns the sorted list of every identifier (keys + aliases) in the document,
 * for diagnostic-grade "operation not found" errors.
 */
export function allOperationIdentifiers(iface: OBInterface): string[] {
  const names = new Set<string>();
  for (const [key, op] of Object.entries(iface.operations)) {
    names.add(key);
    for (const a of op.aliases ?? []) names.add(a);
  }
  return [...names].sort();
}
