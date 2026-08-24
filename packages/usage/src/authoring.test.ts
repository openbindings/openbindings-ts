import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { single } from "@openbindings/invoke";
import { BINDING_SPEC, UsageInvoker, UsageSynthesizer, type ProcessRequest } from "./index.js";

const descriptor = `name "tool"
bin "tool"
version "1.2.3"
flag "--profile <name>" global=#true
cmd "db" {
  cmd "run" {
    help "Run a migration"
    flag "--force"
    arg "<file>"
  }
}
`;

describe("Usage authoring and expanded behavior", () => {
  it("returns the deterministic source-less scaffold", async () => {
    await expect(new UsageSynthesizer().synthesizeInterface({ name: "scaffold" })).resolves.toEqual({
      openbindings: "0.2.0", name: "scaffold", operations: {},
    });
  });

  it("accepts an authoring file path but emits pristine embedded content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbindings-usage-"));
    const path = join(directory, "usage.kdl");
    const content = `name "tool"\nbin "tool"\ncmd "run" help="Run it"\n`;
    try {
      await writeFile(path, content);
      const synth = new UsageSynthesizer();
      const iface = await synth.synthesizeInterface({ sources: [{ bindingSpec: BINDING_SPEC, location: path }] });
      const inspection = await synth.inspectSource({ bindingSpec: BINDING_SPEC, location: path });
      expect(iface.sources?.default).toEqual({ bindingSpec: BINDING_SPEC, content });
      expect(inspection.targets.map((target) => target.selector)).toEqual(["", "run"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("synthesizes and inspects matching primary command paths", async () => {
    const source = { bindingSpec: BINDING_SPEC, content: descriptor };
    const synth = new UsageSynthesizer();
    const iface = await synth.synthesizeInterface({ sources: [source] });
    const inspection = await synth.inspectSource(source);
    expect(inspection.targets.map((target) => target.selector)).toEqual(["", "db", "db run"]);
    expect(Object.values(iface.bindings ?? {}).map((binding) => binding.selector ?? "").sort()).toEqual(["", "db", "db run"]);
    expect(iface.operations["db.run"]?.input).toMatchObject({
      type: "object",
      properties: { profile: { type: "string" }, force: { type: "boolean" }, file: { type: "string" } },
    });
    expect(iface.sources?.default).toEqual(source);
  });

  it("does not invent target identity from name when bin is absent", async () => {
    const source = { bindingSpec: BINDING_SPEC, content: `name "tool"\ncmd "run" help="Run it"\n` };
    const synth = new UsageSynthesizer();
    const iface = await synth.synthesizeInterface({ sources: [source] });
    const inspection = await synth.inspectSource(source);
    expect(iface.operations).toEqual({});
    expect(iface.bindings).toEqual({});
    expect(inspection).toEqual({ targets: [], exhaustive: true });
  });

  it("accounts for the root and every exact command-alias path", async () => {
    const content = `bin "tool"
flag "--profile <name>" global=#true
cmd "database" {
  alias "db"
  cmd "run" {
    alias "r"
    flag "--force"
  }
}
`;
    const source = { bindingSpec: BINDING_SPEC, content };
    const synth = new UsageSynthesizer();
    const result = await synth.synthesizeInterfaceWithCoverage({ sources: [source] });
    const refs = Object.values(result.interface.bindings ?? {})
      .map((binding) => binding.selector ?? "")
      .sort();
    expect(refs).toEqual([
      "",
      "database",
      "database r",
      "database run",
      "db",
      "db r",
      "db run",
    ]);
    expect(result.coverage).toMatchObject({
      exhaustive: true,
      fullyRepresented: true,
    });
    expect(result.coverage.entries.map((entry) => entry.sourceRef).sort()).toEqual([
      "<root>",
      ...refs.filter(Boolean),
    ]);
    expect(result.interface.operations.tool?.input).toMatchObject({
      properties: { profile: { type: "string" } },
    });
  });

  it("refuses ambiguous sibling spellings without discarding unique alternatives", async () => {
    const content = `bin "tool"
cmd "x"
cmd "beta" {
  alias "x"
}
`;
    const source = { bindingSpec: BINDING_SPEC, content };
    const synth = new UsageSynthesizer();
    const result = await synth.synthesizeInterfaceWithCoverage({ sources: [source] });
    expect(Object.values(result.interface.bindings ?? {}).map((binding) => binding.selector ?? "").sort())
      .toEqual(["", "beta"]);
    expect(result.coverage.fullyRepresented).toBe(false);
    expect(result.coverage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceRef: "ambiguous-selector:x",
        scope: "alternative",
        status: "excluded",
        reasonCode: "usage.ambiguous_command_spelling",
      }),
      expect.objectContaining({
        sourceRef: "command:x",
        scope: "target",
        status: "excluded",
        reasonCode: "usage.no_unique_command_selector",
      }),
    ]));

    const invocation = new UsageInvoker({
      executor: async () => { throw new Error("ambiguous selector must not dispatch"); },
    }).invokeBinding({ source, selector: "x" });
    await invocation.close();
    await expect(single(invocation.outputs)).rejects.toMatchObject({ code: "ERR_INVALID_SELECTOR" });
  });

  it("does not count navigation-only groups as interactions and still covers descendants", async () => {
    const content = `bin "tool"
cmd "group" subcommand_required=#true {
  alias "g"
  cmd "run"
}
`;
    const result = await new UsageSynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{ bindingSpec: BINDING_SPEC, content }],
    });
    expect(result.coverage.fullyRepresented).toBe(true);
    expect(result.coverage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceRef: "g run",
        status: "represented",
      }),
    ]));
    expect(result.coverage.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRef: "group" }),
      expect.objectContaining({ sourceRef: "g" }),
    ]));
  });

  it("applies ancestor globals and the text decode convention", async () => {
    let dispatched: ProcessRequest | undefined;
    const call = new UsageInvoker({
      executor: async (request) => { dispatched = request; return { exitCode: 0, stdout: "done\r\n\n" }; },
    }).invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: descriptor },
      selector: "db run",
    });
    await call.write({ profile: "ci", force: false, file: "plan.sql" });
    expect(await single(call.outputs)).toBe("done");
    expect(dispatched?.argv).toEqual(["tool", "db", "run", "--profile", "ci", "plan.sql"]);
  });

  it("lets declared environment satisfy an omitted required field", async () => {
    let dispatched: ProcessRequest | undefined;
    const call = new UsageInvoker({
      executor: async (request) => { dispatched = request; return { exitCode: 0 }; },
    }).invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: "bin \"tool\"\narg \"<profile>\" env=\"PROFILE\"\n" },
      selector: "",
      context: { environment: { PROFILE: "ci" } },
    });
    await call.close();
    expect(await single(call.outputs)).toBe("");
    expect(dispatched?.argv).toEqual(["tool"]);
  });

  it("preserves child-arg syntax, flag aliases, multiplicity, and argv order", async () => {
    const content = `bin "tool"
flag "-v" global=#true help="Verbose" { alias "--verbose" }
cmd "run" help="Run it" {
  flag "--tag... <tag>"
  flag "--include" { arg "<pattern>..." }
  arg "<files>..." double_dash="required"
}
`;
    let dispatched: ProcessRequest | undefined;
    const call = new UsageInvoker({
      executor: async (request) => { dispatched = request; return { exitCode: 0 }; },
    }).invokeBinding({ source: { bindingSpec: BINDING_SPEC, content }, selector: "run" });
    await call.write({ verbose: true, tag: ["a", "b"], include: ["x", "y"], files: ["--one", "two"] });
    expect(await single(call.outputs)).toBe("");
    expect(dispatched?.argv).toEqual([
      "tool", "run", "--verbose", "--tag", "a", "--tag", "b", "--include", "x", "y", "--", "--one", "two",
    ]);

    const iface = await new UsageSynthesizer().synthesizeInterface({ sources: [{ bindingSpec: BINDING_SPEC, content }] });
    expect(iface.operations.run?.description).toBe("Run it");
    expect(iface.operations.run?.input).toMatchObject({
      properties: {
        verbose: { type: "boolean", description: "Verbose" },
        tag: { type: "array" },
        include: { type: "array" },
        files: { type: "array" },
      },
    });
  });

  it("enforces required_if and required_unless by canonical flag identity", async () => {
    const content = `bin "tool"
flag "--file <file>" required_if="--dir"
flag "--dir <dir>"
flag "--identity <id>" required_unless="--anonymous"
flag "--anonymous"
`;
    const executor = async () => ({ exitCode: 0 });
    const missingIf = new UsageInvoker({ executor }).invokeBinding({ source: { bindingSpec: BINDING_SPEC, content }, selector: "" });
    await missingIf.write({ dir: "tmp", anonymous: true });
    await expect(single(missingIf.outputs)).rejects.toMatchObject({ code: "ERR_VALIDATION_FAILED" });

    const missingUnless = new UsageInvoker({ executor }).invokeBinding({ source: { bindingSpec: BINDING_SPEC, content }, selector: "" });
    await missingUnless.close();
    await expect(single(missingUnless.outputs)).rejects.toMatchObject({ code: "ERR_VALIDATION_FAILED" });
  });

  it("does not close a dynamic choice set in the synthesized schema", async () => {
    const content = `bin "tool"
flag "--environment" { arg "<environment>" { choices "dev" env="DEPLOY_ENVS" } }
`;
    const iface = await new UsageSynthesizer().synthesizeInterface({ sources: [{ bindingSpec: BINDING_SPEC, content }] });
    expect(iface.operations.tool?.input).toMatchObject({ properties: { environment: { type: "string" } } });
    expect((iface.operations.tool?.input as { properties?: { environment?: { enum?: unknown } } }).properties?.environment?.enum).toBeUndefined();
  });

  it("keeps process bytes intact for fatal UTF-8 decoding and byte encoders", async () => {
    const invalid = new UsageInvoker({
      executor: async () => ({ exitCode: 0, stdout: new Uint8Array([0xff]) }),
    }).invokeBinding({ source: { bindingSpec: BINDING_SPEC, content: "bin \"tool\"" }, selector: "" });
    await invalid.close();
    await expect(single(invalid.outputs)).rejects.toMatchObject({ code: "ERR_RESPONSE_ERROR" });

    let dispatched: ProcessRequest | undefined;
    const binary = new UsageInvoker({
      encoders: { raw: () => new Uint8Array([0, 255]) },
      executor: async (request) => { dispatched = request; return { exitCode: 0 }; },
    }).invokeBinding({
      source: { bindingSpec: BINDING_SPEC, content: "bin \"tool\"\narg \"[payload]\"" },
      selector: "",
      context: { configuration: { route: { payload: { kind: "stdin", operand: "pure" } }, encode: { payload: "raw" } } },
    });
    await binary.write({ payload: { opaque: true } });
    expect(await single(binary.outputs)).toBe("");
    expect(dispatched?.stdin).toEqual(new Uint8Array([0, 255]));
  });
});
