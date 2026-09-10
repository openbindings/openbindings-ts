// One module instance for nominal SDK owners regardless of Node's import or
// require condition. Browser conditions retain a native ESM entry; this is a
// packaging bridge, not a global registry or duck-typed owner brand.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function writeSharedRuntimeEntry(directory = process.cwd()) {
  // Browsers have no Node dual-loader problem. Preserve tsup's native ESM
  // entry for browser-condition consumers, including unbundled Vite dev links.
  const esm = await readFile(resolve(directory, "dist/index.js"), "utf8");
  if (esm.startsWith("// Generated shared-runtime ESM bridge.")) {
    throw new Error("shared runtime entry requires a fresh tsup build");
  }
  await writeFile(resolve(directory, "dist/index.browser.js"), esm);
  const filename = resolve(directory, "dist/index.cjs");
  // esbuild emits a static CommonJS export annotation for Node interop. Reading
  // it avoids executing SDK/evaluator dependencies merely to enumerate exports.
  const source = await readFile(filename, "utf8");
  const match = source.match(/0\s*&&\s*\(module\.exports\s*=\s*\{([\s\S]*?)\}\);?\s*$/m);
  if (!match) throw new Error("shared runtime entry: missing static esbuild export annotation");
  const names = match[1].split(",").map(name => name.trim()).filter(Boolean);
  if (!names.length || names.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) {
    throw new Error("shared runtime entry: unexpected named export syntax");
  }
  await writeFile(resolve(directory, "dist/index.js"),
    `// Generated shared-runtime ESM bridge.\nimport runtime from "./index.cjs";\nconst { ${names.join(", ")} } = runtime;\nexport { ${names.join(", ")} };\n`);
  // Both module conditions also refer to the same nominal declaration types.
  await writeFile(resolve(directory, "dist/index.d.ts"), 'export * from "./index.cjs";\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await writeSharedRuntimeEntry();
}
