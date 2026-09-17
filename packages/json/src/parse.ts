import parse from "core-js-pure/actual/json/parse.js";
import { JSONNumber } from "./index.js";

/** The shared source-token parser. A private projection runs in the parser's
 * bottom-up walk, before parsed containers escape to a caller. */
export function parseExact(text: string, project: (value: unknown) => unknown): unknown {
  return parse(text, (_key, value, context) => {
    if (typeof value === "number") {
      if (context.source === undefined) throw new Error("JSON source-text access is unavailable");
      if (!(Number.isSafeInteger(value) && /^-?(0|[1-9][0-9]*)$/.test(context.source))) value = new JSONNumber(context.source);
    }
    return project(value);
  });
}
