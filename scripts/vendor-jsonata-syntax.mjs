// Private parse-only relocation: no evaluator or arithmetic runtime is copied.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[2] ?? path.join(root, "../jsonata-runtime/javascript"));
const target = path.join(root, "packages/core/src/internal/jsonata-syntax");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const files = {};
const hashes = {};
for (const name of ["src/parser.js", "src/signature.js", "LICENSE"]) {
  const raw = fs.readFileSync(path.join(source, name));
  hashes[name] = digest(raw);
  const destination = name === "LICENSE" ? name : path.basename(name).replace(/\.js$/, ".cjs");
  let text = raw.toString();
  if (name === "src/parser.js") {
    for (const [before, after] of [["require('./signature')", "require('./signature.cjs')"], ["require('./numeric')", "require('./number-lexeme.cjs')"]]) {
      if (text.split(before).length !== 2) throw Error("Syntax relocation anchor changed: " + before);
      text = text.replace(before, after);
    }
  }
  if (name === "src/signature.js") {
    // These helpers are used only by the returned runtime argument validator,
    // never while parsing a signature. Fail closed if this private syntax
    // artifact is accidentally used to validate runtime values.
    const before = "var utils = require('./utils');";
    if (text.split(before).length !== 2) throw Error("Signature dependency anchor changed");
    text = text.replace(before, 'var runtimeUnavailable = function () { throw new Error("Syntax-only artifact cannot validate runtime values"); };\nvar utils = {isFunction: runtimeUnavailable, isNumeric: runtimeUnavailable};');
  }
  files[destination] = text;
}
// Validation discards the AST. Retain numeric lexemes instead of instantiating
// an evaluator's assigned-value domain or imposing its arithmetic capacities.
files["number-lexeme.cjs"] = `"use strict";
const grammar = /^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
exports.fromText = value => { if (!grammar.test(value)) throw new SyntaxError("Invalid numeric literal"); return value; };
exports.isNumeric = value => typeof value === "string" && grammar.test(value);
exports.text = value => value;
`;
files["parser.d.cts"] = "declare function parse(source: string): unknown;\nexport = parse;\n";
const familyInputs = path.join(source, "../maintenance/INPUTS.json");
const baseCommit = fs.existsSync(familyInputs)
  ? JSON.parse(fs.readFileSync(familyInputs)).inputs.find(input => input.name === "jsonata-js").head
  : execFileSync("git", ["rev-parse", "HEAD"], {cwd: source, encoding: "utf8"}).trim();
const manifest = {schema: 1, purpose: "Private syntax-only validator; no evaluation API or numeric policy", upstream: "https://github.com/jsonata-js/jsonata", baseCommit, sourceFiles: hashes, files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, digest(text)]))};
const previousPath = path.join(target, "SOURCE.json");
if (fs.existsSync(previousPath)) {
  const previous = JSON.parse(fs.readFileSync(previousPath));
  for (const [name, hash] of Object.entries(previous.files)) {
    if (digest(fs.readFileSync(path.join(target, name))) !== hash) throw Error("Refusing to overwrite modified syntax vendor file: " + name);
  }
}
fs.mkdirSync(target, {recursive: true});
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(target, name), text);
fs.writeFileSync(previousPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
