import { describe, it, expect } from "vitest";
import { OpenAPISynthesizer } from "./test-helpers.js";

// A declared example crosses into the OBI as the value the artifact wrote.
// String content parses as YAML 1.2.2, whose core tag resolution (§10.3.2)
// resolves the null/bool/int/float patterns and makes every other plain
// scalar a string; the OAS requires exactly that restriction, since "Tags
// MUST be limited to those allowed by [YAML's] JSON schema ruleset" (§4.2)
// and YAML 1.1's timestamp tag is outside it. Resolving one anyway produced
// a Date, which the canonical-JSON writer emitted as {} — the declared
// value destroyed with no diagnostic. The Go twin pins the same table in
// formats/openapi/yaml_scalars_test.go.
describe("YAML 1.2.2 core scalars at the OBI boundary", () => {
  const document = (spelling: string) => `openapi: 3.0.0
info:
  title: scalars
  version: 1.0.0
servers:
  - url: https://scalars.example
paths:
  /probe:
    get:
      operationId: probe
      parameters:
        - name: value
          in: query
          schema:
            type: string
            example: ${spelling}
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: string
`;

  const emittedExample = async (spelling: string): Promise<unknown> => {
    const result = await new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
      sources: [{
        bindingSpec: "openbindings.openapi-3.1@1",
        location: "https://scalars.example/openapi.yaml",
        content: document(spelling),
      }],
    });
    const input = result.interface.operations?.["probe"]?.input as
      { properties?: Record<string, { example?: unknown }> } | undefined;
    return input?.properties?.["value"]?.example;
  };

  it.each([
    "2020-01-01T12:00:00Z",
    "2020-01-01",
    "2020-01-01 12:00:00",
    "12:30:45",
    "yes",
    "off",
  ])("emits the string-resolved scalar %s unchanged", async (spelling) => {
    expect(await emittedExample(spelling)).toBe(spelling);
  });

  it.each([
    ["true", true],
    ["~", null],
    ["017", 17],
    ["0o17", 15],
    ["0x1F", 31],
    ["+12.3", 12.3],
    [".5", 0.5],
  ] as const)("emits %s with its §10.3.2 JSON type", async (spelling, want) => {
    expect(await emittedExample(spelling)).toStrictEqual(want);
  });

  // ±.inf and .nan have no JSON image, so the artifact is refused whole
  // rather than emitted as a null the author never wrote — the same outcome
  // the Go twin reaches, where the YAML-to-JSON conversion fails.
  it.each([".inf", "-.inf", ".nan"])(
    "refuses the artifact declaring %s",
    async (spelling) => {
      await expect(new OpenAPISynthesizer().synthesizeInterfaceWithCoverage({
        sources: [{
          bindingSpec: "openbindings.openapi-3.1@1",
          location: "https://scalars.example/openapi.yaml",
          content: document(spelling),
        }],
      })).rejects.toThrow(/no JSON representation/u);
    },
  );
});
