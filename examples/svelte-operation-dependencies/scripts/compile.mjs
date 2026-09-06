import { readFile } from "node:fs/promises";
import { compile } from "svelte/compiler";

const source = await readFile("src/SvelteOperation.svelte", "utf8");
const compiled = compile(source, {
  filename: "SvelteOperation.svelte",
  generate: "client",
});

if (!compiled.js.code.includes("CompositionSession")) {
  throw new Error("Svelte adapter did not retain dependency composition");
}
if (compiled.js.code.includes("node:")) {
  throw new Error("Svelte adapter compiled with a Node dependency");
}

console.log("Svelte lifecycle adapter compiled without a Node dependency");
