/**
 * Explicit M6 boundary around M5t's request implementation. Only the
 * already-shared plain-unary 3.1-equivalence bridge is admitted here.
 */
export const OPENAPI32_M6_RESPONSE_SEAMS = Object.freeze([
  { section: "5.1", rule: "OAPI32-P-01", name: "response-side reference identity and confinement" },
  { section: "6.2", rule: "OAPI32-S-01", name: "callback and webhook dependency contracts and coverage" },
  { section: "9.4", rule: "OAPI32-P-03", name: "governing response Content-Encoding declarations and decoder stacks" },
  { section: "9.5", rule: "OAPI32-P-03", name: "sequential response media, itemSchema, JSONL/NDJSON/JSON-seq, positional multipart, and SSE" },
  { section: "9.6", rule: "OAPI32-P-03", name: "3.2 response-key ranges, lookup, classification, required headers, media election, and value boundaries" },
] as const);
