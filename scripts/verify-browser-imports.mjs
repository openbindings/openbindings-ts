import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const browserPackages = [
  "core",
  "invoke",
  "synthesize",
  "compare",
  "sdk",
  "openapi",
  "asyncapi",
  "graphql",
  "mcp",
];
const forbidden = /^(?:node:|fs(?:\/promises)?$|path$|url$)/;
const failures = [];

for (const name of browserPackages) {
  const file = resolve("packages", name, "dist", "index.js");
  const source = await readFile(file, "utf8");
  const imports = [
    ...source.matchAll(
      /^\s*import(?:\s+[\s\S]*?\s+from\s+|\s*)["']([^"']+)["'];?\s*$/gm,
    ),
  ].map(match => match[1]);
  const requires = [...source.matchAll(/\brequire\(["']([^"']+)["']\)/g)]
    .map(match => match[1]);

  for (const specifier of [...imports, ...requires]) {
    if (specifier && forbidden.test(specifier)) {
      failures.push(`${name}: ${specifier}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `browser-supported package graphs contain Node built-ins:\n${failures
      .map(failure => `  ${failure}`)
      .join("\n")}`,
  );
}

console.log(
  `browser import graph clean: ${browserPackages.join(", ")}`,
);
