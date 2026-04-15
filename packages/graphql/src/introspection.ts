/** GraphQL introspection types and query. */

export interface IntrospectionSchema {
  queryType: TypeRef | null;
  mutationType: TypeRef | null;
  subscriptionType: TypeRef | null;
  types: FullType[];
}

export interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}

export interface FullType {
  kind: string;
  name: string;
  description?: string;
  fields?: Field[];
  inputFields?: InputValue[];
  enumValues?: EnumValue[];
  interfaces?: TypeRef[];
  possibleTypes?: TypeRef[];
}

export interface Field {
  name: string;
  description?: string;
  args: InputValue[];
  type: TypeRef;
  isDeprecated: boolean;
  deprecationReason?: string;
}

export interface InputValue {
  name: string;
  description?: string;
  type: TypeRef;
  defaultValue?: string | null;
}

export interface EnumValue {
  name: string;
  description?: string;
  isDeprecated: boolean;
  deprecationReason?: string;
}

export type TypeMap = Map<string, FullType>;

export function buildTypeMap(schema: IntrospectionSchema): TypeMap {
  const m = new Map<string, FullType>();
  for (const t of schema.types) {
    m.set(t.name, t);
  }
  return m;
}

export function rootTypeName(schema: IntrospectionSchema, rootType: string): string | null {
  switch (rootType) {
    case "Query": return schema.queryType?.name ?? null;
    case "Mutation": return schema.mutationType?.name ?? null;
    case "Subscription": return schema.subscriptionType?.name ?? null;
    default: return null;
  }
}

/** Unwrap NON_NULL and LIST wrappers to get the underlying named type. */
export function unwrapTypeName(t: TypeRef): string | null {
  let current = t;
  while ((current.kind === "NON_NULL" || current.kind === "LIST") && current.ofType) {
    current = current.ofType;
  }
  return current.name;
}

export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        args {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
        type { ...TypeRef }
        isDeprecated
        deprecationReason
      }
      inputFields {
        name
        description
        type { ...TypeRef }
        defaultValue
      }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
      interfaces { ...TypeRef }
      possibleTypes { ...TypeRef }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
}`;
