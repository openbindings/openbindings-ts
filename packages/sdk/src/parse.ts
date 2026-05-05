import type { OBInterface } from "./types.js";
import { validateInterface, type ValidateOptions } from "./validate.js";

export interface ParseDocumentOptions extends ValidateOptions {}

export function parseDocument(
  input: string | Uint8Array,
  options: ParseDocumentOptions = {},
): OBInterface {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  rejectDuplicateObjectKeys(text);
  const parsed = JSON.parse(text) as OBInterface;
  validateInterface(parsed, options);
  return parsed;
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
