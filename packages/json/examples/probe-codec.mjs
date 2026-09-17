// Runs the codec steps of corpus tasks T01, T02 and T08 against the BUILT
// package for the installed probe lane. Prints one JSON object per task to
// stdout, in the shape the coordinator's comparator reads:
//
//   {"task":"T02","steps":[{"step":0,"counters":{...}},{"step":1,"counters":{...}},...]}
//
// Step 0 is the origin reading taken immediately before corpus step 1 of that
// task; every later entry is the full seven-counter reading after that corpus
// step. Values are fresh per task. bytes() is called once per corpus step.
// Observables that are not corpus steps are printed to stderr as JSON and run
// after the last recorded step so they never move a recorded reading.
//
//   pnpm --filter @openbindings/json build && node packages/json/examples/probe-codec.mjs
import * as json from "@openbindings/json";
import { counters } from "@openbindings/json/advanced";

function task(id, run) {
  const steps = [], note = {};
  const record = step => steps.push({ step, counters: counters() });
  record(0);
  run(record, note);
  console.log(JSON.stringify({ task: id, steps }));
  console.error(JSON.stringify({ task: id, observed: note }));
}
const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code ?? error.name; } };

// T01: parse, evaluate (composed here; the engine is Block 2), read, stringify.
task("T01", (record, note) => {
  const document1 = '{"id":9007199254740993,"price":0.1,"quantity":3}';
  const input = json.parse(document1); record(1);
  const output = { id: input.id, total: json.number("0.3") }; record(2);
  const id = output.id, total = output.total; record(3);
  const text = json.stringify(output); record(4);
  note.text = text;
  note.idIsDecimal = json.isDecimal(id); note.total = String(total); note.totalRaw = total.raw.rawJSON;
  note.exact = codeOf(() => json.toNumber(id)); note.lossy = json.toNumber(id, { lossy: true }); note.multiply = codeOf(() => id * 2);
  note.nativeParseId = JSON.parse(text).id; note.reparseId = String(json.parse(text).id);
});

// T02: base64, mutate the source, evaluate (composed), read size, bytes once,
// stringify, logical string a second time.
task("T02", (record, note) => {
  const bytes = Uint8Array.of(0, 1, 254, 255);
  const input = { attachment: json.base64(bytes) }; record(1);
  bytes[0] = 9; record(2);
  const output = { file: input.attachment, size: input.attachment.length }; record(3);
  const size = output.size; record(4);
  const fileBytes = output.file.bytes(); record(5);
  const text = json.stringify(output); record(6);
  const again = String(output.file); record(7);
  note.size = size; note.bytes = [...fileBytes]; note.text = text; note.again = again; note.shared = output.file === input.attachment;
  fileBytes[0] = 77; note.laterBytesUnchanged = [...output.file.bytes()].join() === "0,1,254,255";
});

// T08: encoded with the hex adapter, evaluate (composed; $uppercase forces
// once), bytes once plus the identity question, both logical strings, bytes
// of the primitive.
task("T08", (record, note) => {
  let encodeCalls = 0;
  const hex = { length: b => b.length * 2, encode: b => { encodeCalls++; return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); } };
  const value = json.encoded(Uint8Array.of(251, 255), hex); record(1);
  const output = { same: value, upper: String(value).toUpperCase() }; record(2);
  const sameBytes = output.same.bytes(); const isBase64 = output.same.encoding === json.BASE64; record(3);
  const s = String(output.same), u = String(output.upper); record(4);
  const upperBytes = json.bytes(output.upper); record(5);
  note.sameBytes = [...sameBytes]; note.isBase64 = isBase64; note.same = s; note.upper = u; note.upperBytes = upperBytes ?? null;
  note.upperIsEncoded = json.isEncoded(output.upper); note.encodeCalls = encodeCalls;
});
