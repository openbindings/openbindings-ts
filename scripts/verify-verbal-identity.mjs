import { readFile } from "node:fs/promises";

const canonicalTagline = "**One interface. Any binding.**";
const canonicalDescriptor =
  "Describe what a service does separately from how you access it.";
const legacyTaglines = [
  "one interface, limitless bindings",
  "one interface · limitless bindings",
];

for (const path of ["README.md", "packages/sdk/README.md"]) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");

  for (const fragment of [canonicalTagline, canonicalDescriptor]) {
    if (!source.includes(fragment)) {
      throw new Error(`${path} is missing OpenBindings verbal identity revision 1: ${fragment}`);
    }
  }

  for (const legacyTagline of legacyTaglines) {
    if (source.toLowerCase().includes(legacyTagline)) {
      throw new Error(`${path} retains a legacy OpenBindings tagline: ${legacyTagline}`);
    }
  }
}

console.log("verbal identity: revision 1 current");
