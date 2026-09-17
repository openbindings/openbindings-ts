// Runs corpus task T04 against the BUILT packages for the installed probe
// lane. Prints one JSON object to stdout, in the shape the coordinator's
// comparator reads:
//
//   {"task":"T04","steps":[{"step":0,"counters":{...}},{"step":1,"counters":{...}},...]}
//
// Step 0 is the origin reading taken immediately before corpus step 1; every
// later entry is the full seven-counter reading after that corpus step. Leaves
// are fresh. Observables that are not corpus steps are printed to stderr as
// JSON after the last recorded step, so they never move a recorded reading.
//
//   pnpm --filter @openbindings/json build && pnpm --filter @openbindings/json-schema build && node packages/json-schema/examples/probe-schema.mjs
import * as json from "@openbindings/json";
import { counters } from "@openbindings/json/advanced";
import { compile } from "@openbindings/json-schema";

const schemaAttachment = {
  type: "object", required: ["file"],
  properties: { file: { type: "string", minLength: 8, maxLength: 8 }, total: { type: "number", multipleOf: 0.1 } },
};
const schemaAttachmentPattern = { type: "object", properties: { file: { type: "string", pattern: "^[A-Za-z0-9+/=]+$" } } };

const steps = [], note = {};
const record = step => steps.push({ step, counters: counters() });

// The T02 output: the attachment as a fresh Base64 leaf and its length.
const t02Output = Object.freeze({ file: json.base64(Uint8Array.of(0, 1, 254, 255)), size: 8 });
record(0);
const schema = compile(schemaAttachment); record(1);
const value = { ...t02Output, total: json.number("0.3") };
const report = schema.validate(value); record(2);
const variant = compile(schemaAttachmentPattern).validate(value); record(3);
console.log(JSON.stringify({ task: "T04", steps }));

note.valid = report.valid; note.costs = report.costs;
note.variantValid = variant.valid; note.variantCosts = variant.costs;
const o3 = schema.validate({ file: value.file, total: json.number("0.30000000000000004") });
note.o3 = { valid: o3.valid, codes: o3.errors.map(e => e.code), messages: o3.errors.map(e => e.message) };
note.keptString = String(value.file); note.keptEncodes = counters().encodes - steps[3].counters.encodes;
console.error(JSON.stringify({ task: "T04", observed: note }));
