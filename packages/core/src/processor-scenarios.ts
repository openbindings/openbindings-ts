/**
 * Language-neutral primitives for executing the portable binding-specification
 * processor corpus. Family packages translate a scenario into their idiomatic
 * public API and return one normalized observation; this module owns matching
 * so every TypeScript adapter judges the same contract as the Go runner.
 */

export interface ProcessorScenarioFile {
  format:
    | "openbindings.binding-spec-processor-scenarios@1"
    // Revision 3 only ADDS the `notContains` assertion to revision 2, so a
    // revision-3 reader interprets a revision-2 file exactly as a revision-2
    // reader would. Accepting both keeps the corpus and the engines free to
    // merge in either order instead of in lockstep.
    | "openbindings.binding-spec-processor-scenarios@2"
    | "openbindings.binding-spec-processor-scenarios@3"
    | "openbindings.binding-spec-processor-scenarios@4"
    | "openbindings.binding-spec-processor-scenarios@5"
    | "openbindings.invocation-fidelity-scenarios@1";
  bindingSpec: string;
  family: string;
  description: string;
  scenarios: ProcessorScenario[];
}

export interface ProcessorScenario {
  id: string;
  rules: string[];
  section: string;
  description: string;
  given: {
    source: Record<string, unknown>;
    binding: Record<string, unknown>;
    configuration?: Record<string, unknown>;
    invocation: Record<string, unknown> & { inputPresent: boolean };
    peer?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
    /** Closed artifact dependency set supplied to a family adapter's resolver. */
    resources?: Record<string, unknown>;
  };
  expected: ProcessorExpected[];
}

export interface ProcessorExpected {
  disposition: ProcessorDisposition;
  phase: ProcessorPhase;
  description?: string;
  assertions: ProcessorAssertion[];
}

export type ProcessorDisposition = "complete" | "error" | "refusal" | "context-required";
export type ProcessorPhase =
  | "load"
  | "resolution"
  | "pre-dispatch"
  | "dispatch"
  | "response"
  | "completion";

export interface ProcessorAssertion {
  path: string;
  equals?: unknown;
  absent?: true;
  oneOf?: unknown[];
  setEquals?: unknown[];
  contains?: unknown;
  /**
   * Pins the ABSENCE of a substring or member: a header never emitted, a
   * field never serialized. Corpus revision 3.
   */
  notContains?: unknown;
  semanticEquals?: ProcessorSemanticEquality;
}

export interface ProcessorInputMaterialization {
  path: string;
  kind: "unpaired-utf16-code-units";
  codeUnits: number[];
}

export interface ProcessorSemanticEquality {
  as:
    | "form-json-field"
    | "multipart-json-part"
    | "query-json-parameter"
    | "querystring-json"
    | "json-lines"
    | "json-sequence";
  name?: string;
  names?: string[];
  value: unknown;
}

export interface ProcessorObservation {
  disposition: ProcessorDisposition;
  phase: ProcessorPhase;
  data: Record<string, unknown>;
}

export interface ProcessorMatch {
  /** Zero-based index in the scenario's unordered permitted alternatives. */
  alternative: number;
}

/**
 * Matches a normalized observation against the scenario's unordered permitted
 * alternatives. Throws a diagnostic containing every alternative failure.
 */
export function matchProcessorObservation(
  scenario: ProcessorScenario,
  observation: ProcessorObservation,
  options: { family?: string } = {},
): ProcessorMatch {
  const failures: string[] = [];
  for (const [index, expected] of scenario.expected.entries()) {
    try {
      matchAlternative(expected, observation, options.family);
      return { alternative: index };
    } catch (error: unknown) {
      failures.push(`alternative ${index + 1}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`${scenario.id} matched no permitted alternative:\n${failures.join("\n")}`);
}

function matchAlternative(
  expected: ProcessorExpected,
  got: ProcessorObservation,
  family?: string,
): void {
  if (got.disposition !== expected.disposition) {
    throw new Error(`disposition = ${quoted(got.disposition)}, want ${quoted(expected.disposition)}`);
  }
  if (got.phase !== expected.phase) {
    throw new Error(`phase = ${quoted(got.phase)}, want ${quoted(expected.phase)}`);
  }
  checkAssertions(got.data, expected.assertions, { family });
}

/**
 * Applies every assertion to one JSON-shaped root value. Exported so the other
 * portable-corpus runners in this package evaluate the shared assertion
 * vocabulary through this evaluator instead of reimplementing it: the synthesis
 * corpus addresses an emitted OBI document with the same five verbs this corpus
 * addresses a normalized observation with.
 */
export function checkAssertions(
  root: unknown,
  assertions: ProcessorAssertion[],
  options: { family?: string } = {},
): void {
  for (const assertion of assertions) {
    const selected = selectPointer(root, assertion.path);
    if (assertion.absent === true) {
      if (selected.present) {
        throw new Error(`${assertion.path} is present (${printable(selected.value)}), want absent`);
      }
      continue;
    }
    if (!selected.present) throw new Error(`${assertion.path} is absent`);

    if (Object.prototype.hasOwnProperty.call(assertion, "equals")) {
      if (!jsonEqual(selected.value, assertion.equals)) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want ${printable(assertion.equals)}`,
        );
      }
    } else if (assertion.oneOf !== undefined) {
      if (!assertion.oneOf.some((candidate) => jsonEqual(selected.value, candidate))) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want one of ${printable(assertion.oneOf)}`,
        );
      }
    } else if (assertion.setEquals !== undefined) {
      if (!setEqual(selected.value, assertion.setEquals)) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want set ${printable(assertion.setEquals)}`,
        );
      }
    } else if (Object.prototype.hasOwnProperty.call(assertion, "contains")) {
      if (!contains(selected.value, assertion.contains)) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want to contain ${printable(assertion.contains)}`,
        );
      }
    } else if (Object.prototype.hasOwnProperty.call(assertion, "notContains")) {
      if (contains(selected.value, assertion.notContains)) {
        throw new Error(
          `${assertion.path} = ${printable(selected.value)}, want NOT to contain ${printable(assertion.notContains)}`,
        );
      }
    } else if (assertion.semanticEquals !== undefined) {
      const actual = semanticValue(selected.value, assertion.semanticEquals, options.family);
      if (!jsonEqual(actual, assertion.semanticEquals.value)) {
        throw new Error(
          `${assertion.path} semantically = ${printable(actual)}, want ${printable(assertion.semanticEquals.value)}`,
        );
      }
    } else {
      throw new Error(`${assertion.path} has no comparison operator`);
    }
  }
}

interface NamedUnit {
  name: string;
  value: string;
  contentType: string;
}

function semanticValue(
  actual: unknown,
  assertion: ProcessorSemanticEquality,
  family?: string,
): unknown {
  switch (assertion.as) {
    case "json-lines": {
      if (typeof actual !== "string" || actual === "" || !actual.endsWith("\n")) {
        throw new Error("invalid JSON Lines framing");
      }
      const lines = actual.slice(0, -1).split("\n");
      if (lines.some((line) => line === "" || line.includes("\r"))) {
        throw new Error("invalid JSON Lines record boundary");
      }
      return lines.map((line) => JSON.parse(line) as unknown);
    }
    case "json-sequence": {
      if (typeof actual !== "string" || actual === "") {
        throw new Error("invalid JSON sequence body");
      }
      const values: unknown[] = [];
      let offset = 0;
      while (offset < actual.length) {
        if (actual.charCodeAt(offset++) !== 0x1e) throw new Error("JSON sequence frame omits RS");
        const end = actual.indexOf("\n", offset);
        if (end < 0) throw new Error("JSON sequence frame omits LF");
        const text = actual.slice(offset, end);
        if (text === "" || text.includes(String.fromCharCode(0x1e))) {
          throw new Error("invalid JSON sequence frame");
        }
        values.push(JSON.parse(text) as unknown);
        offset = end + 1;
      }
      return values;
    }
    case "querystring-json": {
      if (typeof actual !== "string") throw new Error("querystring assertion requires a URL");
      const query = rawQuery(actual);
      const decoded = decodeAndValidateQueryComponent(query);
      return JSON.parse(decoded) as unknown;
    }
    case "query-json-parameter": {
      if (typeof actual !== "string") throw new Error("query assertion requires a URL");
      const units = namedUnits(rawQuery(actual), false, family);
      checkNames(units, assertion);
      return JSON.parse(selectedUnit(units, assertion.name).value) as unknown;
    }
    case "form-json-field": {
      if (typeof actual !== "string") throw new Error("form assertion requires a string body");
      const units = namedUnits(actual, true, family);
      checkNames(units, assertion);
      return JSON.parse(selectedUnit(units, assertion.name).value) as unknown;
    }
    case "multipart-json-part": {
      if (!isRecord(actual)) throw new Error("multipart assertion requires a dispatch object");
      const headers = isRecord(actual.headers) ? actual.headers : {};
      const rawContentType = headers["content-type"] ?? headers["Content-Type"];
      if (typeof rawContentType !== "string") throw new Error("multipart assertion requires a Content-Type string");
      const contentType = rawContentType;
      const boundary = multipartBoundary(contentType);
      if (typeof actual.body !== "string") throw new Error("multipart assertion requires a string body");
      const parts = parseMultipart(actual.body, boundary);
      checkNames(parts, assertion);
      const selected = selectedUnit(parts, assertion.name);
      if (selected.contentType.toLowerCase() !== "application/json") {
        throw new Error("multipart JSON part has wrong content type");
      }
      return JSON.parse(selected.value) as unknown;
    }
  }
}

function rawQuery(value: string): string {
  const fragment = value.indexOf("#");
  const beforeFragment = fragment < 0 ? value : value.slice(0, fragment);
  const mark = beforeFragment.indexOf("?");
  if (mark < 0) throw new Error("URL has no query component");
  return beforeFragment.slice(mark + 1);
}

function namedUnits(raw: string, plusAsSpace: boolean, family?: string): NamedUnit[] {
  if (raw === "") return [];
  return raw.split("&").map((unit) => {
    const split = unit.indexOf("=");
    const rawName = split < 0 ? unit : unit.slice(0, split);
    const rawValue = split < 0 ? "" : unit.slice(split + 1);
    return {
      name: decodeAndValidateNamedComponent(rawName, plusAsSpace, family),
      value: decodeAndValidateNamedComponent(rawValue, plusAsSpace, family),
      contentType: "",
    };
  });
}

function decodeAndValidateNamedComponent(
  raw: string,
  plusAsSpace: boolean,
  family?: string,
): string {
  const decoded = strictPercentDecode(raw, plusAsSpace);
  if (!plusAsSpace) {
    if (encodeQueryComponent(decoded) !== raw) throw new Error("query component is not in its required wire form");
    return decoded;
  }
  if (family === "openapi-3.1") {
    const canonical = encodeFormComponent(decoded, "openapi-3.1", false);
    const alternate = encodeFormComponent(decoded, "openapi-3.1", true);
    if (raw !== canonical && raw !== alternate) throw new Error("form component is not in the OAS 3.1 permitted set");
  } else if (raw !== encodeFormComponent(decoded, family, false)) {
    throw new Error("form component is not in its required wire form");
  }
  return decoded;
}

function decodeAndValidateQueryComponent(raw: string): string {
  const decoded = strictPercentDecode(raw, false);
  if (encodeQueryComponent(decoded) !== raw) throw new Error("query component is not in its required wire form");
  return decoded;
}

function strictPercentDecode(value: string, plusAsSpace: boolean): string {
  const normalized = plusAsSpace ? value.replaceAll("+", " ") : value;
  if (/%(?![0-9A-F]{2})/u.test(normalized)) throw new Error("percent triplets must use uppercase hex");
  try {
    return decodeURIComponent(normalized);
  } catch (error: unknown) {
    throw new Error("percent-encoded value is not valid UTF-8", { cause: error });
  }
}

function encodeQueryComponent(value: string): string {
  return encodeUTF8(value, (byte) => isAlphaNumeric(byte) || [0x2d, 0x2e, 0x5f, 0x7e].includes(byte));
}

function encodeFormComponent(value: string, family: string | undefined, alternate31: boolean): string {
  const bytes = new TextEncoder().encode(value);
  let result = "";
  for (const byte of bytes) {
    if (byte === 0x20) {
      result += family === "openapi-3.1" && alternate31 ? "%20" : "+";
      continue;
    }
    const literal = family === "openapi-3.2"
      ? isAlphaNumeric(byte) || [0x2a, 0x2d, 0x2e, 0x5f].includes(byte)
      : isAlphaNumeric(byte) || [0x2d, 0x2e, 0x5f].includes(byte)
        || (byte === 0x7e && !(family === "openapi-3.1" && alternate31));
    result += literal ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

function encodeUTF8(value: string, literal: (byte: number) => boolean): string {
  let result = "";
  for (const byte of new TextEncoder().encode(value)) {
    result += literal(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

function isAlphaNumeric(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a);
}

function multipartBoundary(contentType: string): string {
  const pieces = contentType.split(";").map((piece) => piece.trim());
  if (pieces.shift()?.toLowerCase() !== "multipart/form-data") {
    throw new Error("outer multipart media type is not multipart/form-data");
  }
  if (pieces.length !== 1) throw new Error("outer multipart media type must contain only its boundary parameter");
  const match = /^boundary=(?:"([^"]+)"|([^\s;]+))$/iu.exec(pieces[0] ?? "");
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new Error("multipart boundary is absent or invalid");
  return boundary;
}

function parseMultipart(body: string, boundary: string): NamedUnit[] {
  const delimiter = `--${boundary}`;
  if (!body.startsWith(`${delimiter}\r\n`) || !body.endsWith(`${delimiter}--\r\n`)) {
    throw new Error("multipart body has invalid outer framing");
  }
  const rawParts = body.slice(delimiter.length + 2, -(delimiter.length + 4)).split(`\r\n${delimiter}\r\n`);
  return rawParts.map(parsePart);
}

function parsePart(raw: string): NamedUnit {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0 || !raw.endsWith("\r\n")) throw new Error("multipart part has invalid framing");
  const headerLines = raw.slice(0, split).split("\r\n");
  const disposition = headerLines.find((line) => /^content-disposition:/iu.test(line)) ?? "";
  const exactName = /^content-disposition:\s*form-data; name="((?:[^"\\]|\\.)*)"$/iu.exec(disposition);
  if (!exactName || /filename\*?=/iu.test(disposition)) {
    throw new Error("multipart part name is not the exact generated form");
  }
  const contentTypeLines = headerLines.filter((line) => /^content-type:/iu.test(line));
  if (contentTypeLines.length !== 1) throw new Error("multipart JSON part requires exactly one Content-Type");
  return {
    name: exactName[1]!.replace(/\\(["\\])/gu, "$1"),
    value: raw.slice(split + 4, -2),
    contentType: contentTypeLines[0]!.slice(contentTypeLines[0]!.indexOf(":") + 1).trim(),
  };
}

function checkNames(units: NamedUnit[], assertion: ProcessorSemanticEquality): void {
  const actual = units.map((unit) => unit.name).sort();
  const expected = [...(assertion.names ?? [])].sort();
  if (!jsonEqual(actual, expected)) {
    throw new Error(`decoded name multiset = ${printable(actual)}, want ${printable(expected)}`);
  }
}

function selectedUnit(units: NamedUnit[], name: unknown): NamedUnit {
  const selected = units.filter((unit) => unit.name === name);
  if (selected.length !== 1) throw new Error(`expected exactly one ${printable(name)} contribution`);
  return selected[0]!;
}

function selectPointer(root: unknown, pointer: string): { present: boolean; value?: unknown } {
  if (pointer === "") return { present: true, value: root };
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON Pointer ${quoted(pointer)}`);
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return { present: false };
      const index = Number(segment);
      if (index >= current.length) return { present: false };
      current = current[index];
    } else if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { present: false };
      current = current[segment];
    } else {
      return { present: false };
    }
  }
  return { present: true, value: current };
}

function setEqual(actual: unknown, expected: unknown[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const used = new Set<number>();
  for (const wanted of expected) {
    const index = actual.findIndex((value, i) => !used.has(i) && jsonEqual(value, wanted));
    if (index < 0) return false;
    used.add(index);
  }
  return true;
}

function contains(actual: unknown, needle: unknown): boolean {
  if (typeof actual === "string" && typeof needle === "string") return actual.includes(needle);
  if (Array.isArray(actual)) return actual.some((value) => jsonEqual(value, needle));
  if (isRecord(actual) && typeof needle === "string") {
    return Object.prototype.hasOwnProperty.call(actual, needle);
  }
  return false;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJSON(a) === canonicalJSON(b);
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortJSON(value));
}

function sortJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJSON(value[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printable(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
