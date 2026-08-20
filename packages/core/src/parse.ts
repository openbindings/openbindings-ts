import type { OBInterface } from "./types.js";
import { ValidationError } from "./errors.js";
import { validateAgainstOBISchema } from "./schema-validation.js";
import { validateInterface, type ValidateOptions } from "./validate.js";
import { isValidSemver, versionRefusalReason } from "./version.js";

/**
 * Parses an OBI document from JSON and validates it against
 * `openbindings.schema.json`:
 *
 *   - OBI-D-01: rejects duplicate JSON object keys.
 *   - OBI-D-02: validates against the meta-schema. The meta-schema's
 *     SemVer pattern on `openbindings` also covers OBI-D-12.
 *   - OBI-T-04: refuses a document whose `openbindings` version declares a
 *     higher major than this SDK's MAX_TESTED_VERSION (or, while pre-1.0, a
 *     higher minor). Enforced here so every parse entry point — including
 *     {@link fetchInterface}, which never calls {@link validateInterface} —
 *     refuses unsupported versions with the same error.
 *
 * The remaining OBI-D rule enforcement (cross-references, identifier
 * patterns, example schema checks, etc.) is the job of
 * {@link validateInterface}. Use {@link validateDocument} for the
 * combined parse-and-validate convenience.
 *
 * Throws {@link ValidationError} on shape/schema failure, or
 * {@link SyntaxError} on malformed JSON.
 */
export function parseDocument(input: string | Uint8Array): OBInterface {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    // TextDecoder strips a leading UTF-8 BOM by default. OBI-D-01 forbids
    // accepting one, so inspect the exact bytes before decoding rather than
    // letting the decoder normalize the document.
    if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
      throw new SyntaxError("parse document: leading byte-order mark is forbidden (OBI-D-01)");
    }
    // OBI-D-01: an OBI document is UTF-8 encoded JSON. The default
    // TextDecoder silently replaces invalid sequences with U+FFFD; decode
    // fatally so encoding errors surface as parse errors.
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      throw new SyntaxError("parse document: input is not valid UTF-8 (OBI-D-01)");
    }
  }
  // A string input has no byte encoding to inspect but can still carry the
  // decoded U+FEFF marker. Treat the leading marker identically to the byte
  // carriage; no input form gets a normalization exception.
  if (text.charCodeAt(0) === 0xfeff) {
    throw new SyntaxError("parse document: leading byte-order mark is forbidden (OBI-D-01)");
  }
  rejectDuplicateObjectKeys(text);
  const parsed: unknown = JSON.parse(text);

  const errs: string[] = [];
  validateAgainstOBISchema(errs, parsed);
  if (errs.length > 0) {
    throw new ValidationError(errs);
  }

  // OBI-T-04 (§11.1): refuse to PARSE a document declaring a higher major
  // version than this SDK's MAX_TESTED_VERSION (or, while pre-1.0, a higher
  // minor). The refusal lives here, after the meta-schema check, so every
  // parse entry point (parseDocument, validateDocument, fetchInterface) is
  // covered with the identical error validateInterface raises. The
  // meta-schema's SemVer pattern already guarantees a valid string by this
  // point; guard defensively in case a future schema relaxes that.
  const ver = ((parsed as Record<string, unknown>)?.openbindings as string ?? "").trim();
  if (ver && isValidSemver(ver)) {
    try {
      // Same ordered accept/refuse decision (upward, downward, and unsupported
      // prereleases) validateInterface and isSupportedVersion make, via the
      // shared versionRefusalReason predicate, with identical messages.
      const reason = versionRefusalReason(ver);
      if (reason) {
        throw new ValidationError([`openbindings: ${reason} (OBI-T-04)`]);
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError([`openbindings: ${(err as Error).message} (OBI-T-04)`]);
    }
  }

  return parsed as OBInterface;
}

/**
 * Convenience that calls {@link parseDocument} followed by
 * {@link validateInterface}. Returns a typed {@link OBInterface} that
 * has passed both the meta-schema check and the full OBI-D rule walk.
 *
 * Throws {@link ValidationError} or {@link SyntaxError} on failure.
 */
export function validateDocument(
  input: string | Uint8Array,
  options: ValidateOptions = {},
): OBInterface {
  const iface = parseDocument(input);
  validateInterface(iface, options);
  return iface;
}

/**
 * Formats a {@link ValidationError} as a human-readable, newline-joined
 * string of its individual problems. Non-validation errors are returned
 * via their `message` property.
 */
export function formatValidationErrors(err: unknown): string {
  if (err instanceof ValidationError) {
    return err.problems.join("\n");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function rejectDuplicateObjectKeys(text: string): void {
  const scanner = new JSONDuplicateKeyScanner(text);
  scanner.scan();
}

class JSONDuplicateKeyScanner {
  private pos = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.skipWhitespace();
    this.parseValue();
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      throw new SyntaxError(`unexpected trailing token at ${this.pos}`);
    }
  }

  private parseValue(): void {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === "{") {
      this.parseObject();
    } else if (ch === "[") {
      this.parseArray();
    } else if (ch === "\"") {
      this.parseString();
    } else if (ch === "t") {
      this.expectLiteral("true");
    } else if (ch === "f") {
      this.expectLiteral("false");
    } else if (ch === "n") {
      this.expectLiteral("null");
    } else {
      this.parseNumber();
    }
  }

  private parseObject(): void {
    this.expect("{");
    this.skipWhitespace();
    const seen = new Set<string>();
    if (this.peek() === "}") {
      this.pos++;
      return;
    }
    for (;;) {
      this.skipWhitespace();
      const key = this.parseString();
      if (seen.has(key)) {
        throw new SyntaxError(`duplicate object key ${JSON.stringify(key)}`);
      }
      seen.add(key);
      this.skipWhitespace();
      this.expect(":");
      this.parseValue();
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === "}") {
        this.pos++;
        return;
      }
      this.expect(",");
    }
  }

  private parseArray(): void {
    this.expect("[");
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.pos++;
      return;
    }
    for (;;) {
      this.parseValue();
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === "]") {
        this.pos++;
        return;
      }
      this.expect(",");
    }
  }

  private parseString(): string {
    const start = this.pos;
    this.expect("\"");
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos++];
      if (ch === "\"") {
        return JSON.parse(this.text.slice(start, this.pos)) as string;
      }
      if (ch === "\\") {
        this.pos++;
      }
    }
    throw new SyntaxError("unterminated string");
  }

  private parseNumber(): void {
    const start = this.pos;
    while (this.pos < this.text.length && /[0-9eE+\-.]/.test(this.text.charAt(this.pos))) {
      this.pos++;
    }
    if (start === this.pos) {
      throw new SyntaxError(`unexpected token ${JSON.stringify(this.peek())} at ${this.pos}`);
    }
  }

  private expectLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.pos)) {
      throw new SyntaxError(`expected ${literal} at ${this.pos}`);
    }
    this.pos += literal.length;
  }

  private expect(ch: string): void {
    if (this.text[this.pos] !== ch) {
      throw new SyntaxError(`expected ${JSON.stringify(ch)} at ${this.pos}`);
    }
    this.pos++;
  }

  private peek(): string {
    return this.text[this.pos] ?? "";
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text.charAt(this.pos))) {
      this.pos++;
    }
  }
}

/** Returns true if a value looks like a valid OBInterface document. */
export function isOBInterface(v: unknown): v is OBInterface {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.openbindings === "string" &&
    typeof obj.operations === "object" &&
    obj.operations !== null &&
    !Array.isArray(obj.operations)
  );
}
