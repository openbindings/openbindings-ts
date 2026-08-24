import type { IntrospectionSchema } from "./introspection.js";
import { buildTypeMap, rootTypeName } from "./introspection.js";

interface Token { kind: "name" | "punct" | "value"; value: string }
interface Directive { name: string; ifValue?: { literal?: boolean; variable?: string } }
interface Selection {
  fieldName?: string;
  responseKey?: string;
  fragmentName?: string;
  typeCondition?: string;
  directives: Directive[];
  selections: Selection[];
  inline?: boolean;
}
interface Operation { kind: string; name?: string; selections: Selection[] }
interface Fragment { typeCondition: string; directives: Directive[]; selections: Selection[] }

export class ExecutableDocument {
  constructor(
    readonly operations: Operation[],
    readonly fragments: Map<string, Fragment>,
  ) {}

  verifySelection(
    operationName: string | undefined,
    wantKind: string,
    wantField: string,
    variables: Record<string, unknown> | undefined,
    schema: IntrospectionSchema,
  ): void {
	this.responseKey(operationName, wantKind, wantField, variables, schema);
  }

  responseKey(
    operationName: string | undefined,
    wantKind: string,
    wantField: string,
    variables: Record<string, unknown> | undefined,
    schema: IntrospectionSchema,
  ): string {
    let operation: Operation;
    if (operationName) {
      const matches = this.operations.filter((item) => item.name === operationName);
      if (matches.length !== 1) throw new Error(`operationName ${JSON.stringify(operationName)} does not select exactly one operation`);
      operation = matches[0]!;
    } else {
      if (this.operations.length !== 1) throw new Error("operationName is required when a document contains multiple operations");
      operation = this.operations[0]!;
    }
    if (operation.kind !== wantKind) {
      throw new Error(`selected operation kind ${JSON.stringify(operation.kind)} does not match binding selector kind ${JSON.stringify(wantKind)}`);
    }
    const rootName = rootTypeName(schema, wantKind);
    if (!rootName) throw new Error(`schema has no ${wantKind} root type`);
    const groups = new Map<string, string[]>();
    this.collect(operation.selections, [], rootName, variables ?? {}, schema, groups, new Set());
    if (groups.size !== 1) {
      throw new Error(`selected operation must collect exactly one root response-key group, got ${groups.size}`);
    }
    for (const fields of groups.values()) {
      for (const field of fields) {
        if (field !== wantField) {
          throw new Error(`selected root field ${JSON.stringify(field)} does not match binding selector field ${JSON.stringify(wantField)}`);
        }
      }
    }
	return groups.keys().next().value as string;
  }

  private collect(
    selections: Selection[],
    inherited: Directive[],
    rootName: string,
    variables: Record<string, unknown>,
    schema: IntrospectionSchema,
    groups: Map<string, string[]>,
    visiting: Set<string>,
  ): void {
    for (const selection of selections) {
      if (!includeSelection([...inherited, ...selection.directives], variables)) continue;
      if (selection.fieldName) {
        const values = groups.get(selection.responseKey!) ?? [];
        values.push(selection.fieldName);
        groups.set(selection.responseKey!, values);
      } else if (selection.fragmentName) {
        const fragment = this.fragments.get(selection.fragmentName);
        if (!fragment) throw new Error(`fragment ${JSON.stringify(selection.fragmentName)} is not defined`);
        if (visiting.has(selection.fragmentName)) throw new Error(`fragment cycle includes ${JSON.stringify(selection.fragmentName)}`);
        if (!typeConditionApplies(fragment.typeCondition, rootName, schema)) continue;
        visiting.add(selection.fragmentName);
        this.collect(fragment.selections, fragment.directives, rootName, variables, schema, groups, visiting);
        visiting.delete(selection.fragmentName);
      } else if (selection.inline) {
        if (selection.typeCondition && !typeConditionApplies(selection.typeCondition, rootName, schema)) continue;
        this.collect(selection.selections, [], rootName, variables, schema, groups, visiting);
      }
    }
  }
}

export function parseExecutableDocument(source: string): ExecutableDocument {
  const p = new Parser(lex(source));
  const operations: Operation[] = [];
  const fragments = new Map<string, Fragment>();
  while (!p.eof()) {
    if (p.peek("{")) {
      operations.push({ kind: "query", selections: p.selectionSet() });
      continue;
    }
    const keyword = p.name();
    if (keyword === "fragment") {
      const name = p.name();
      if (name === "on") throw new Error("fragment name cannot be on");
      if (fragments.has(name)) throw new Error(`duplicate fragment ${JSON.stringify(name)}`);
      p.expectName("on");
      const typeCondition = p.name();
      const directives = p.directives();
      fragments.set(name, { typeCondition, directives, selections: p.selectionSet() });
      continue;
    }
    if (keyword !== "query" && keyword !== "mutation" && keyword !== "subscription") {
      throw new Error(`unexpected definition ${JSON.stringify(keyword)}`);
    }
    const operation: Operation = { kind: keyword, selections: [] };
    if (p.peekKind("name")) operation.name = p.name();
    if (p.peek("(")) p.variableDefinitions();
    p.directives();
    operation.selections = p.selectionSet();
    operations.push(operation);
  }
  if (operations.length === 0) throw new Error("document contains no executable operation");
  return new ExecutableDocument(operations, fragments);
}

function includeSelection(directives: Directive[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    if (!directive.ifValue || (directive.name !== "skip" && directive.name !== "include")) continue;
    let known = false;
    let value = false;
    if (directive.ifValue.literal !== undefined) {
      known = true;
      value = directive.ifValue.literal;
    } else if (directive.ifValue.variable && typeof variables[directive.ifValue.variable] === "boolean") {
      known = true;
      value = variables[directive.ifValue.variable] as boolean;
    }
    if (!known) continue;
    if (directive.name === "skip" && value) return false;
    if (directive.name === "include" && !value) return false;
  }
  return true;
}

function typeConditionApplies(condition: string, rootName: string, schema: IntrospectionSchema): boolean {
  if (condition === rootName) return true;
  const map = buildTypeMap(schema);
  const type = map.get(condition);
  if (!type) throw new Error(`fragment type condition ${JSON.stringify(condition)} cannot be resolved from the schema`);
  if (type.kind === "OBJECT") return false;
  if (type.kind !== "INTERFACE" && type.kind !== "UNION") {
    throw new Error(`fragment type condition ${JSON.stringify(condition)} is not a composite type`);
  }
  if (type.possibleTypes?.some((item) => item.name === rootName)) return true;
  if (type.kind === "INTERFACE") {
    const root = map.get(rootName);
    if (!root) throw new Error(`root type ${JSON.stringify(rootName)} cannot be resolved from the schema`);
    if (root.interfaces?.some((item) => item.name === condition)) return true;
  }
  return false;
}

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}
  eof(): boolean { return this.at >= this.tokens.length; }
  peek(value: string): boolean { return !this.eof() && this.tokens[this.at]!.value === value; }
  peekKind(kind: Token["kind"]): boolean { return !this.eof() && this.tokens[this.at]!.kind === kind; }
  name(): string {
    if (!this.peekKind("name")) throw new Error(`expected GraphQL Name${this.eof() ? " at end of document" : `, got ${JSON.stringify(this.tokens[this.at]!.value)}`}`);
    return this.tokens[this.at++]!.value;
  }
  expect(value: string): void {
    if (!this.peek(value)) throw new Error(`expected ${JSON.stringify(value)}`);
    this.at++;
  }
  expectName(value: string): void {
    if (!this.peekKind("name") || !this.peek(value)) throw new Error(`expected ${JSON.stringify(value)}`);
    this.at++;
  }
  selectionSet(): Selection[] {
    this.expect("{");
    const selections: Selection[] = [];
    while (!this.peek("}")) {
      if (this.eof()) throw new Error("unterminated selection set");
      selections.push(this.selection());
    }
    this.at++;
    if (selections.length === 0) throw new Error("selection set cannot be empty");
    return selections;
  }
  selection(): Selection {
    if (this.peek("...")) {
      this.at++;
      if (this.peek("on")) {
        this.at++;
        const typeCondition = this.name();
        const directives = this.directives();
        return { inline: true, typeCondition, directives, selections: this.selectionSet() };
      }
      if (this.peek("@")) {
        const directives = this.directives();
        return { inline: true, directives, selections: this.selectionSet() };
      }
      const fragmentName = this.name();
      return { fragmentName, directives: this.directives(), selections: [] };
    }
    const first = this.name();
    let fieldName = first;
    let responseKey = first;
    if (this.peek(":")) {
      this.at++;
      fieldName = this.name();
      responseKey = first;
    }
    if (this.peek("(")) this.arguments(true);
    const directives = this.directives();
    return {
      fieldName, responseKey, directives,
      selections: this.peek("{") ? this.selectionSet() : [],
    };
  }
  directives(): Directive[] {
    const out: Directive[] = [];
    while (this.peek("@")) {
      this.at++;
      const directive: Directive = { name: this.name() };
      if (this.peek("(")) {
        const args = this.arguments(true);
        const ifValue = args.get("if");
        if (ifValue !== undefined) directive.ifValue = ifValue;
      }
      out.push(directive);
    }
    return out;
  }

  variableDefinitions(): void {
    this.expect("(");
    if (this.peek(")")) throw new Error("variable definitions cannot be empty");
    while (!this.peek(")")) {
      if (this.eof()) throw new Error("unterminated variable definitions");
      this.expect("$");
      this.name();
      this.expect(":");
      this.typeReference();
      if (this.peek("=")) {
        this.at++;
        this.value(false);
      }
      this.directives();
    }
    this.at++;
  }

  typeReference(): void {
    if (this.peek("[")) {
      this.at++;
      this.typeReference();
      this.expect("]");
    } else {
      this.name();
    }
    if (this.peek("!")) this.at++;
  }

  arguments(allowVariables: boolean): Map<string, Directive["ifValue"]> {
    this.expect("(");
    if (this.peek(")")) throw new Error("argument list cannot be empty");
    const out = new Map<string, Directive["ifValue"]>();
    while (!this.peek(")")) {
      if (this.eof()) throw new Error("unterminated argument list");
      const name = this.name();
      this.expect(":");
      try {
        out.set(name, this.value(allowVariables));
      } catch (error) {
        throw new Error(
          `invalid argument ${JSON.stringify(name)}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    this.at++;
    return out;
  }

  value(allowVariables: boolean): Directive["ifValue"] {
    if (this.peek("$")) {
      if (!allowVariables) throw new Error("variables are not allowed in constant values");
      this.at++;
      return { variable: this.name() };
    }
    if (this.peek("[")) {
      this.at++;
      while (!this.peek("]")) {
        if (this.eof()) throw new Error("unterminated list value");
        this.value(allowVariables);
      }
      this.at++;
      return {};
    }
    if (this.peek("{")) {
      this.at++;
      while (!this.peek("}")) {
        if (this.eof()) throw new Error("unterminated object value");
        this.name();
        this.expect(":");
        this.value(allowVariables);
      }
      this.at++;
      return {};
    }
    if (this.peekKind("value")) {
      this.at++;
      return {};
    }
    if (this.peekKind("name")) {
      const name = this.name();
      if (name === "true") return { literal: true };
      if (name === "false") return { literal: false };
      return {};
    }
    throw new Error(`expected value${this.eof() ? " at end of document" : `, got ${JSON.stringify(this.tokens[this.at]!.value)}`}`);
  }
}

function lex(source: string): Token[] {
  const out: Token[] = [];
  for (let at = 0; at < source.length;) {
    const cp = source.codePointAt(at)!;
    const ch = String.fromCodePoint(cp);
    const size = ch.length;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "," || ch === "\uFEFF") { at += size; continue; }
    if (ch === "#") {
      while (at < source.length && source[at] !== "\n" && source[at] !== "\r") at++;
      continue;
    }
    if (source.startsWith("...", at)) { out.push({ kind: "punct", value: "..." }); at += 3; continue; }
    if (ch === '"') {
      const start = at;
      if (source.startsWith('"""', at)) {
        at += 3;
        for (;;) {
          const end = source.indexOf('"""', at);
          if (end < 0) throw new Error("unterminated block string");
          // GraphQL block strings spell an embedded triple quote as \""";
          // that sequence is content, not the terminator.
          if (end > start + 3 && source[end - 1] === "\\") {
            at = end + 3;
            continue;
          }
          at = end + 3;
          break;
        }
      } else {
        at++;
        let escaped = false;
        while (at < source.length) {
          const next = source[at++]!;
          if (next.charCodeAt(0) < 0x20 && next !== "\t") {
            throw new Error("unescaped control character in string");
          }
          if (escaped) {
            if (!'"\\/bfnrtu'.includes(next)) throw new Error(`invalid string escape \\${next}`);
            if (next === "u") {
              if (source[at] === "{") {
                const close = source.indexOf("}", at + 1);
                if (close < 0) throw new Error("invalid Unicode scalar escape");
                const digits = source.slice(at + 1, close);
                if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) throw new Error("invalid Unicode scalar escape");
                const scalar = Number.parseInt(digits, 16);
                if (scalar > 0x10ffff || (scalar >= 0xd800 && scalar <= 0xdfff)) {
                  throw new Error("invalid Unicode scalar escape");
                }
                at = close + 1;
              } else {
                const digits = source.slice(at, at + 4);
                if (!/^[0-9A-Fa-f]{4}$/.test(digits)) throw new Error("invalid Unicode escape");
                at += 4;
              }
            }
            escaped = false;
          }
          else if (next === "\\") escaped = true;
          else if (next === '"') break;
        }
        if (source[at - 1] !== '"') throw new Error("unterminated string");
      }
      out.push({ kind: "value", value: source.slice(start, at) });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const start = at;
      at += size;
      while (at < source.length && /[_0-9A-Za-z]/.test(source[at]!)) at++;
      out.push({ kind: "name", value: source.slice(start, at) });
      continue;
    }
    if ("!$():=@[]{|}&".includes(ch)) {
      out.push({ kind: "punct", value: ch });
      at += size;
      continue;
    }
    if (ch === "-" || /[0-9]/.test(ch)) {
      const start = at;
      at += size;
      while (at < source.length && !/[ \t\r\n,()[\]{}!$:@=|&]/.test(source[at]!)) at++;
      const number = source.slice(start, at);
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(number)) {
        throw new Error(`invalid number ${JSON.stringify(number)}`);
      }
      out.push({ kind: "value", value: number });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return out;
}
