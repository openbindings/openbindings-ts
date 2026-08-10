import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goRoot = process.env.OB_GO_ROOT ?? resolve(root, "../openbindings-go");
const specCorpus = process.env.OB_SPEC_CORPUS ?? resolve(root, "../spec/conformance");
const matrix = JSON.parse(await readFile(resolve(specCorpus, "reference-sdk-correspondence.json"), "utf8"));
if (matrix.format !== "openbindings.reference-sdk-correspondence@1") throw new Error("unsupported correspondence matrix format");

const expected = new Map([
  ["openbindings.openapi@5", ["openapi", "OpenAPIInvoker", "OpenAPISynthesizer"]],
  ["openbindings.asyncapi@1", ["asyncapi", "AsyncAPIInvoker", "AsyncAPISynthesizer"]],
  ["openbindings.mcp@2", ["mcp", "MCPInvoker", "MCPSynthesizer"]],
  ["openbindings.grpc@1", ["grpc", "GrpcInvoker", "GrpcSynthesizer"]],
  ["openbindings.connect@1", ["connect", "ConnectInvoker", "ConnectSynthesizer"]],
  ["openbindings.usage@1", ["usage", "UsageInvoker", "UsageSynthesizer"]],
  ["openbindings.graphql@2", ["graphql", "GraphQLInvoker", "GraphQLSynthesizer"]],
]);

for (const family of matrix.families) {
  const declaration = expected.get(family.bindingSpec);
  if (!declaration) throw new Error(`matrix contains unknown family ${family.bindingSpec}`);
  const [directory, invoker, synthesizer] = declaration;
  if (!family.roles.includes("coverageSynthesizer")) {
    throw new Error(`${family.bindingSpec} omits the coverageSynthesizer role`);
  }
  if (family.typescript.invoker !== invoker || family.typescript.synthesizer !== synthesizer) {
    throw new Error(`${family.bindingSpec} TypeScript names diverge from exported correspondence`);
  }
  const files = await Promise.all([
    readFile(resolve(root, `packages/${directory}/src/index.ts`), "utf8").catch(() => ""),
    readFile(resolve(root, `packages/${directory}/src/invoker.ts`), "utf8").catch(() => ""),
    readFile(resolve(root, `packages/${directory}/src/authoring.ts`), "utf8").catch(() => ""),
  ]);
  const source = files.join("\n");
  for (const className of [invoker, synthesizer]) {
    if (!source.includes(`export class ${className}`)) throw new Error(`${family.bindingSpec} does not export ${className}`);
  }
  for (const method of ["bindingSpecs", "invokeBinding", "synthesizeInterface", "synthesizeInterfaceWithCoverage", "inspectSource"]) {
    if (!source.includes(`${method}(`) && !source.includes(`${method}<`)) throw new Error(`${family.bindingSpec} lacks ${method}`);
  }

  if (family.go.invoker !== `${directory}.Invoker` || family.go.synthesizer !== `${directory}.Synthesizer`) {
    throw new Error(`${family.bindingSpec} Go names diverge from exported correspondence`);
  }
  const goFiles = await Promise.all([
    readFile(resolve(goRoot, `formats/${directory}/invoker.go`), "utf8").catch(() => ""),
    readFile(resolve(goRoot, `formats/${directory}/synthesize.go`), "utf8").catch(() => ""),
    readFile(resolve(goRoot, `formats/${directory}/synthesize_interface.go`), "utf8").catch(() => ""),
    readFile(resolve(goRoot, `formats/${directory}/list_refs.go`), "utf8").catch(() => ""),
  ]);
  const goSource = goFiles.join("\n");
  for (const typeName of ["Invoker", "Synthesizer"]) {
    if (!goSource.includes(`type ${typeName} struct`)) throw new Error(`${family.bindingSpec} does not export Go ${typeName}`);
  }
  for (const method of ["BindingSpecs", "InvokeBinding", "SynthesizeInterface", "SynthesizeInterfaceWithCoverage", "InspectSource"]) {
    if (!goSource.includes(`) ${method}(`)) throw new Error(`${family.bindingSpec} lacks Go ${method}`);
  }
  expected.delete(family.bindingSpec);
}
if (expected.size) throw new Error(`matrix omits ${[...expected.keys()].join(", ")}`);
console.log(`verified ${matrix.families.length} Go/TypeScript family correspondences`);
