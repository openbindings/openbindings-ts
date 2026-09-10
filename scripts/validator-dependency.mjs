// Rebuild only the upstream package's public ESM/CJS entry points. No SDK API,
// runtime loader, generated-code evaluator, or custom traversal engine is added.
import { build, version } from "esbuild";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
assert(["build", "verify"].includes(mode), "usage: validator-dependency.mjs build <pnpm edit-dir> | verify");
assert.equal(version, "0.28.1", "requalify before changing the patch builder");
const directory = mode === "build" ? resolve(process.argv[3])
  : realpathSync(resolve(root, "packages/core/node_modules/json-schema-library"));
const pkg = JSON.parse(readFileSync(resolve(directory, "package.json")));
assert.equal(pkg.version, "11.6.2");
const hash = value => createHash("sha256").update(value).digest("hex");
const inputs = {};
const outputs = {};
for (const format of ["esm", "cjs"]) {
  const file = `dist/index.${format === "esm" ? "mjs" : "cjs"}`;
  const result = await build({
    absWorkingDir: directory, entryPoints: ["index.ts"], outfile: file,
    tsconfig: resolve(directory, "tsconfig.json"),
    bundle: true, external: Object.keys(pkg.dependencies), platform: "neutral",
    format, target: "es2020", minify: true, legalComments: "inline",
    metafile: true, write: false,
    // esbuild deliberately ignores dependency-local baseUrl in node_modules.
    // Resolve the upstream source alias explicitly in both edit and install dirs.
    plugins: [{ name: "upstream-source-alias", setup(builder) {
      builder.onResolve({ filter: /^src\// }, args => ({ path: resolve(directory, args.path + ".ts") }));
    } }],
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    inputs[path] = hash(readFileSync(resolve(directory, path)));
  }
  const bytes = result.outputFiles[0].contents;
  outputs[file] = hash(bytes);
  if (mode === "build") writeFileSync(resolve(directory, file), bytes);
  else assert.equal(hash(readFileSync(resolve(directory, file))), hash(bytes), `${file}: stale or mismatched build`);
}
const provenance = { version: pkg.version, builder: `esbuild@${version}`, inputs, outputs };
const manifest = resolve(root, "third_party/json-schema-library/build.json");
if (mode === "build") writeFileSync(manifest, JSON.stringify(provenance, null, 2) + "\n");
else assert.deepEqual(provenance, JSON.parse(readFileSync(manifest)));
console.log(`validator ${mode}: public entries match ${Object.keys(inputs).length} qualified source inputs`);
