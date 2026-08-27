export type SchemaDeclaration = Record<string, unknown> | boolean | null | undefined;

export type SchemaReferenceResolver = (
  reference: string,
  from: Record<string, unknown>,
) => SchemaDeclaration;

/**
 * The binding siblings' single declaration-only view. This is deliberately
 * not a JSON Schema evaluator: it follows resolvable references, conjoins
 * allOf, selects exactly one non-null anyOf/oneOf branch, ignores
 * not/conditionals, and leaves an absent type typeless.
 */
export interface ResolvedDeclaration {
  readonly ambiguous: boolean;
  readonly types: ReadonlySet<string> | null;
  declaresOnly(...allowed: string[]): boolean;
  admitsStringAsSoleNonNullType(): boolean;
  typeless(): boolean;
  admitsNull(): boolean;
  format(): { value: string; conflict: boolean };
  keywordString(key: "contentEncoding" | "contentMediaType"): { value: string; conflict: boolean };
  admitsStringEnumValue(value: string): boolean;
  propertyNames(): string[];
  requiresProperty(name: string): boolean;
  property(name: string): ResolvedDeclaration;
  items(): ResolvedDeclaration;
}

interface PropertySlot {
  owner: Record<string, unknown>;
  name: string;
  value: SchemaDeclaration;
}

class Declaration implements ResolvedDeclaration {
  constructor(
    private readonly conjuncts: Record<string, unknown>[],
    readonly types: ReadonlySet<string> | null,
    readonly ambiguous: boolean,
    private readonly oas30: boolean,
    private readonly resolveReference?: SchemaReferenceResolver,
    private readonly unsatisfiable = false,
  ) {}

  declaresOnly(...allowed: string[]): boolean {
    if (this.ambiguous || this.types === null || this.types.size === 0) return false;
    const admitted = new Set(allowed);
    for (const member of this.types) if (!admitted.has(member)) return false;
    return true;
  }

  admitsStringAsSoleNonNullType(): boolean {
    if (this.ambiguous || this.types === null || !this.types.has("string")) return false;
    for (const member of this.types) {
      if (member !== "string" && member !== "null") return false;
    }
    return true;
  }

  typeless(): boolean {
    if (this.ambiguous || this.unsatisfiable || this.types !== null) return false;
    return this.conjuncts.every((conjunct) => !Object.hasOwn(conjunct, "type"));
  }

  admitsNull(): boolean {
    return !this.ambiguous && this.types?.has("null") === true;
  }

  format(): { value: string; conflict: boolean } {
    return this.resolvedStringKeyword("format");
  }

  keywordString(
    key: "contentEncoding" | "contentMediaType",
  ): { value: string; conflict: boolean } {
    if (this.oas30) return { value: "", conflict: false };
    return this.resolvedStringKeyword(key);
  }

  admitsStringEnumValue(value: string): boolean {
    if (this.ambiguous || this.unsatisfiable) return false;
    for (const conjunct of this.conjuncts) {
      if (!Array.isArray(conjunct.enum) || conjunct.enum.length === 0) continue;
      if (!conjunct.enum.some((candidate) => candidate === value)) return false;
    }
    return true;
  }

  propertyNames(): string[] {
    if (this.ambiguous) return [];
    const names = new Set<string>();
    for (const conjunct of this.conjuncts) {
      const properties = asRecord(conjunct.properties);
      if (!properties) continue;
      for (const name of Object.keys(properties)) names.add(name);
    }
    return [...names].sort(codePointCompare);
  }

  requiresProperty(name: string): boolean {
    if (this.ambiguous) return false;
    return this.conjuncts.some((conjunct) =>
      Array.isArray(conjunct.required) && conjunct.required.includes(name));
  }

  property(name: string): ResolvedDeclaration {
    if (this.ambiguous) return ambiguousDeclaration(this.oas30, this.resolveReference);
    const matches: SchemaDeclaration[] = [];
    for (const conjunct of this.conjuncts) {
      let matched = false;
      const properties = asRecord(conjunct.properties);
      if (properties && Object.hasOwn(properties, name)) {
        matches.push(properties[name] as SchemaDeclaration);
        matched = true;
      }
      if (!this.oas30) {
        const patterns = asRecord(conjunct.patternProperties);
        for (const pattern of Object.keys(patterns ?? {}).sort(codePointCompare)) {
          let applies = false;
          try { applies = new RegExp(pattern, "u").test(name); } catch { /* validation owns invalid patterns */ }
          if (!applies) continue;
          matched = true;
          matches.push(patterns![pattern] as SchemaDeclaration);
        }
      }
      if (matched) continue;
      const additional = conjunct.additionalProperties;
      if (additional === false) continue;
      matches.push(additional === undefined || additional === true
        ? {}
        : additional as SchemaDeclaration);
    }
    return resolveDeclaration(conjoin(matches), this.oas30, this.resolveReference);
  }

  items(): ResolvedDeclaration {
    if (this.ambiguous) return ambiguousDeclaration(this.oas30, this.resolveReference);
    const matches: SchemaDeclaration[] = [];
    for (const conjunct of this.conjuncts) {
      if (Object.hasOwn(conjunct, "items")) matches.push(conjunct.items as SchemaDeclaration);
    }
    return resolveDeclaration(conjoin(matches), this.oas30, this.resolveReference);
  }

  propertySlots(name: string): PropertySlot[] {
    if (this.ambiguous) return [];
    const slots: PropertySlot[] = [];
    for (const conjunct of this.conjuncts) {
      const properties = asRecord(conjunct.properties);
      if (properties && Object.hasOwn(properties, name)) {
        slots.push({ owner: properties, name, value: properties[name] as SchemaDeclaration });
      }
    }
    return slots;
  }

  private resolvedStringKeyword(
    key: "format" | "contentEncoding" | "contentMediaType",
  ): { value: string; conflict: boolean } {
    const values = new Set<string>();
    for (const conjunct of this.conjuncts) {
      const value = conjunct[key];
      if (typeof value === "string" && value !== "") values.add(value);
    }
    if (values.size > 1) return { value: "", conflict: true };
    return { value: values.values().next().value ?? "", conflict: false };
  }
}

export function resolveDeclaration(
  schema: SchemaDeclaration,
  oas30: boolean,
  resolveReference?: SchemaReferenceResolver,
): ResolvedDeclaration {
  const result = declarationConjuncts(schema, oas30, resolveReference, new Set());
  if (result.ambiguous) return ambiguousDeclaration(oas30, resolveReference);

  let types: Set<string> | null = null;
  for (const conjunct of result.conjuncts) {
    const candidate = declarationTypeSet(conjunct, oas30);
    if (candidate === null) continue;
    if (types === null) {
      types = candidate;
      continue;
    }
    for (const member of types) if (!candidate.has(member)) types.delete(member);
  }
  return new Declaration(
    result.conjuncts,
    types,
    false,
    oas30,
    resolveReference,
    result.unsatisfiable,
  );
}

/** Returns the actual property-map slots contributing to a resolved member. */
export function resolvedPropertySlots(
  schema: SchemaDeclaration,
  name: string,
  oas30: boolean,
  resolveReference?: SchemaReferenceResolver,
): Array<{ owner: Record<string, unknown>; name: string; value: SchemaDeclaration }> {
  const declaration = resolveDeclaration(schema, oas30, resolveReference);
  return declaration instanceof Declaration ? declaration.propertySlots(name) : [];
}

function declarationConjuncts(
  schema: SchemaDeclaration,
  oas30: boolean,
  resolveReference: SchemaReferenceResolver | undefined,
  seen: Set<object>,
): { conjuncts: Record<string, unknown>[]; ambiguous: boolean; unsatisfiable: boolean } {
  if (schema === true) return { conjuncts: [{}], ambiguous: false, unsatisfiable: false };
  const object = asRecord(schema);
  if (schema === false) return { conjuncts: [], ambiguous: false, unsatisfiable: true };
  if (!object) return { conjuncts: [], ambiguous: false, unsatisfiable: false };
  if (seen.has(object)) return { conjuncts: [], ambiguous: false, unsatisfiable: false };
  seen.add(object);
  try {
    const conjuncts: Record<string, unknown>[] = [];
    let unsatisfiable = false;
    const reference = typeof object.$ref === "string" && resolveReference
      ? resolveReference(object.$ref, object)
      : undefined;
    if (reference !== undefined) {
      const target = declarationConjuncts(reference, oas30, resolveReference, seen);
      if (target.ambiguous) return target;
      conjuncts.push(...target.conjuncts);
      unsatisfiable ||= target.unsatisfiable;
      if (oas30) return { conjuncts, ambiguous: false, unsatisfiable };
    }
    conjuncts.push(object);

    for (const keyword of ["anyOf", "oneOf"] as const) {
      const choice = object[keyword];
      if (!Array.isArray(choice) || choice.length === 0) continue;
      const selected: SchemaDeclaration[] = [];
      for (const branch of choice) {
        const candidate = branch as SchemaDeclaration;
        if (resolveDeclaration(candidate, oas30, resolveReference).declaresOnly("null")) continue;
        selected.push(candidate);
      }
      if (selected.length !== 1) {
        return { conjuncts: [], ambiguous: true, unsatisfiable: false };
      }
      const member = declarationConjuncts(selected[0], oas30, resolveReference, seen);
      if (member.ambiguous) return member;
      conjuncts.push(...member.conjuncts);
      unsatisfiable ||= member.unsatisfiable;
    }

    if (Array.isArray(object.allOf)) {
      for (const rawMember of object.allOf) {
        const member = declarationConjuncts(
          rawMember as SchemaDeclaration,
          oas30,
          resolveReference,
          seen,
        );
        if (member.ambiguous) return member;
        conjuncts.push(...member.conjuncts);
        unsatisfiable ||= member.unsatisfiable;
      }
    }
    return { conjuncts, ambiguous: false, unsatisfiable };
  } finally {
    seen.delete(object);
  }
}

function declarationTypeSet(schema: Record<string, unknown>, oas30: boolean): Set<string> | null {
  const raw = schema.type;
  let declared: string[];
  if (oas30) {
    if (typeof raw !== "string" || raw === "") return null;
    declared = [raw];
  } else if (typeof raw === "string" && raw !== "") {
    declared = [raw];
  } else if (Array.isArray(raw)) {
    declared = raw.filter((member): member is string => typeof member === "string" && member !== "");
    if (declared.length === 0) return null;
  } else {
    return null;
  }
  const result = new Set(declared);
  if (oas30 && schema.nullable === true) result.add("null");
  return result;
}

function conjoin(members: SchemaDeclaration[]): SchemaDeclaration {
  if (members.length === 0) return undefined;
  if (members.length === 1) return members[0];
  return { allOf: members };
}

function ambiguousDeclaration(
  oas30: boolean,
  resolveReference?: SchemaReferenceResolver,
): ResolvedDeclaration {
  return new Declaration([], null, true, oas30, resolveReference);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
