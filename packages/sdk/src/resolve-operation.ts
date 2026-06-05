import type { OBInterface, Operation } from "./types.js";

/** An operation resolved by name, together with its canonical (primary) key. */
export interface ResolvedOperation {
  /** The operation's primary key (the value bindings reference in `operation`). */
  key: string;
  operation: Operation;
}

/**
 * Resolves an operation by name against an interface, per OBI-T-13.
 *
 * An operation's identifiers are its key plus its `aliases`; together they form
 * one flat namespace in which key and alias matches are equally authoritative.
 * OBI-D-05 makes that namespace document-unique, so a name resolves to at most
 * one operation. Key matches are NOT privileged over alias matches: a name that
 * is some operation's native key always belongs to that operation (a different
 * operation cannot also carry it as an alias without violating OBI-D-05).
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

  // Direct key match. By OBI-D-05 a key is never also another operation's alias,
  // so this is authoritative when it hits — order relative to alias search is
  // irrelevant to the result.
  const direct = ops[name];
  if (direct) return { key: name, operation: direct };

  // Alias match across the flat namespace.
  for (const key of Object.keys(ops)) {
    const op = ops[key];
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
  for (const key of Object.keys(iface.operations)) {
    names.add(key);
    for (const a of iface.operations[key].aliases ?? []) names.add(a);
  }
  return [...names].sort();
}
