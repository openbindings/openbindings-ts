import type { OBInterface } from "./types.js";
import { ValidationError } from "./errors.js";
import { validateAgainstOBISchema } from "./schema-validation.js";
import { validateInterface, type ValidateOptions } from "./validate.js";

/**
 * Options accepted by {@link parseDocument}. Reserved for future flags;
 * the SDK's parse step currently has no configurable behavior. Use
 * {@link validateDocument} or {@link validateInterface} for OBI-D rule
 * enforcement options such as `rejectUnknownTypedFields`.
 */
export interface ParseDocumentOptions {}

/**
 * Parses an OBI document from JSON and validates it against
 * `openbindings.schema.json`:
 *
 *   - OBI-D-01: rejects duplicate JSON object keys.
 *   - OBI-D-02: validates against the meta-schema. The meta-schema's
 *     SemVer pattern on `openbindings` also covers OBI-D-16.
 *
 * Returns a typed {@link OBInterface}. Full OBI-D rule enforcement
 * (cross-references, identifier patterns, example schema checks,
 * version refusal via OBI-T-04, etc.) is the job of
 * {@link validateInterface}. Use {@link validateDocument} for the
 * combined parse-and-validate convenience.
 *
 * Throws {@link ValidationError} on shape/schema failure, or
 * {@link SyntaxError} on malformed JSON.
 */
export function parseDocument(
  input: string | Uint8Array,
  _options: ParseDocumentOptions = {},
): OBInterface {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  rejectDuplicateObjectKeys(text);
  const parsed = JSON.parse(text);

  const errs: string[] = [];
  validateAgainstOBISchema(errs, parsed);
  if (errs.length > 0) {
    throw new ValidationError(errs);
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
    while (this.pos < this.text.length && /[0-9eE+\-.]/.test(this.text[this.pos])) {
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
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) {
      this.pos++;
    }
  }
}
