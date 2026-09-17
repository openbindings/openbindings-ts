// One runtime instance per installation, whichever way Node loads it.
//
// The leaf classes and the authentication registry are module-private, so
// `require("@openbindings/json/internal")` from the CJS jsonata bundle and
// `import "@openbindings/json"` from an ESM consumer must reach the same
// module instance. tsup's CJS code splitting shares the runtime between the
// CJS entries; this script then makes each ESM entry a bridge over its CJS
// twin. Browser conditions keep the native ESM entries, which share chunks.
// Export names are learned by importing the native ESM entry, not by parsing.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["index", "advanced", "internal", "values"];
const header = "// Generated shared-runtime ESM bridge.";

for (const entry of entries) {
  const esm = resolve(directory, `dist/${entry}.js`);
  const source = await readFile(esm, "utf8");
  if (source.startsWith(header)) throw new Error(`dist/${entry}.js is already a bridge; run a fresh tsup build first`);
  const names = Object.keys(await import(pathToFileURL(esm).href)).filter(name => name !== "default").sort();
  if (!names.length || names.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) {
    throw new Error(`dist/${entry}.js: unexpected export names`);
  }
  await copyFile(esm, resolve(directory, `dist/${entry}.browser.js`));
  await writeFile(esm,
    `${header}\nimport runtime from "./${entry}.cjs";\nconst { ${names.join(", ")} } = runtime;\nexport { ${names.join(", ")} };\n`);
  // Both module conditions refer to the same nominal declaration types.
  await writeFile(resolve(directory, `dist/${entry}.d.ts`), `export * from "./${entry}.cjs";\n`);
}
console.log(`shared runtime entries: ${entries.join(", ")}`);
