import { describe, it, expect } from "vitest";
import { convertToInterface } from "./test-helpers.js";

// Cut-point naming, twinned in openbindings-go/formats/openapi/cutpoint_names.go
// and pinned there by cutpoint_names_test.go. Every document here is authored
// from the OpenAPI text; none is derived from a corpus artifact.
//
// The invariant: a hoisted cycle participant is named by the component's own
// name in the document that DECLARES it, whether that is the artifact or a
// document the artifact composed through an external `$ref`, and that name is a
// function of the cut-point set rather than of the order the walk met them.

const ARTIFACT = "https://api.example/root.yaml";

const NODE_DOCUMENT = `openapi: 3.0.3
info: {title: Shared, version: "1"}
paths: {}
components:
  schemas:
    Node:
      type: object
      properties:
        label: {type: string}
        child: {$ref: '#/components/schemas/Node'}
`;

/** Serves the composed documents the artifact references, and nothing else. */
function serve(files: Record<string, string>): typeof globalThis.fetch {
  return async (input) => {
    const url = String(input);
    const body = files[url];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(body, { status: 200 });
  };
}

async function defsOf(
  root: string,
  files: Record<string, string>,
  operation: string,
): Promise<Record<string, unknown>> {
  const iface = await convertToInterface(
    ARTIFACT,
    root,
    { fetch: serve(files) },
  );
  const op = iface.operations[operation];
  if (!op) throw new Error(`operation ${operation} absent`);
  const output = op.output as Record<string, unknown>;
  return (output["$defs"] ?? {}) as Record<string, unknown>;
}

// (i) A cycle reached only through an external reference is cut at the target
// document's own component name — not at an ordinal this processor invented
// because the artifact itself declared no such component.
describe("cut points carry the declaring document's own component name", () => {
  it("names an externally declared cycle participant after its own document", async () => {
    const defs = await defsOf(
      `openapi: 3.0.3
info: {title: Root, version: "1"}
servers: [{url: "https://api.example.com"}]
paths:
  /nodes:
    get:
      operationId: listNodes
      responses:
        "200":
          description: nodes
          content:
            application/json:
              schema: {$ref: 'shared/node.yaml#/components/schemas/Node'}
`,
      { "https://api.example/shared/node.yaml": NODE_DOCUMENT },
      "listNodes",
    );
    expect(Object.keys(defs)).toEqual(["Node"]);
    expect(JSON.stringify(defs["Node"]))
      .toContain("#/operations/listNodes/output/$defs/Node");
  });

  // (ii) Two documents declaring one component name disambiguate by the
  // document that declares each — deterministically, and identically to Go.
  it("qualifies colliding names by the document that declares each", async () => {
    const defs = await defsOf(
      `openapi: 3.0.3
info: {title: Root, version: "1"}
servers: [{url: "https://api.example.com"}]
paths:
  /both:
    get:
      operationId: getBoth
      responses:
        "200":
          description: both
          content:
            application/json:
              schema:
                type: object
                properties:
                  one: {$ref: 'one.yaml#/components/schemas/Node'}
                  two: {$ref: 'two.yaml#/components/schemas/Node'}
`,
      {
        "https://api.example/one.yaml": NODE_DOCUMENT,
        "https://api.example/two.yaml": NODE_DOCUMENT.replace("label: {type: string}", "label: {type: integer}"),
      },
      "getBoth",
    );
    expect(Object.keys(defs).sort()).toEqual(["one_Node", "two_Node"]);
  });

  it("leaves the artifact's own component name alone when a composed document collides with it", async () => {
    const defs = await defsOf(
      `openapi: 3.0.3
info: {title: Root, version: "1"}
servers: [{url: "https://api.example.com"}]
paths:
  /both:
    get:
      operationId: getBoth
      responses:
        "200":
          description: both
          content:
            application/json:
              schema:
                type: object
                properties:
                  local: {$ref: '#/components/schemas/Node'}
                  remote: {$ref: 'other.yaml#/components/schemas/Node'}
components:
  schemas:
    Node:
      type: object
      properties:
        localOnly: {type: boolean}
        child: {$ref: '#/components/schemas/Node'}
`,
      { "https://api.example/other.yaml": NODE_DOCUMENT },
      "getBoth",
    );
    expect(Object.keys(defs).sort()).toEqual(["Node", "other_Node"]);
  });

  // (iv) Reordering the artifact changes no emitted name. Under the ordinal
  // scheme this replaced, the two entries swapped keys.
  it("emits the same names however the artifact orders its paths and properties", async () => {
    const header = `openapi: 3.0.3
info: {title: Root, version: "1"}
servers: [{url: "https://api.example.com"}]
paths:
`;
    const solo = `  /alpha:
    get:
      operationId: getAlpha
      responses:
        "200": {description: a, content: {application/json: {schema: {$ref: 'two.yaml#/components/schemas/Node'}}}}
`;
    const both = (first: string, second: string): string => `  /both:
    get:
      operationId: getBoth
      responses:
        "200":
          description: both
          content:
            application/json:
              schema:
                type: object
                properties:
                  ${first}: {$ref: '${first}.yaml#/components/schemas/Node'}
                  ${second}: {$ref: '${second}.yaml#/components/schemas/Node'}
`;
    const files = {
      "https://api.example/one.yaml": NODE_DOCUMENT,
      "https://api.example/two.yaml": NODE_DOCUMENT.replace("label: {type: string}", "label: {type: integer}"),
    };

    for (const root of [header + solo + both("one", "two"), header + both("two", "one") + solo]) {
      expect(Object.keys(await defsOf(root, files, "getBoth")).sort())
        .toEqual(["one_Node", "two_Node"]);
      expect(Object.keys(await defsOf(root, files, "getAlpha"))).toEqual(["Node"]);
    }
  });

  // One artifact component reached through several reference spellings is ONE
  // cut point. The Go twin regressed here for a resolver-specific reason; the
  // shared invariant is pinned in both engines.
  it("publishes one cut point per declared component however many references reach it", async () => {
    const defs = await defsOf(
      `openapi: 3.0.3
info: {title: Root, version: "1"}
servers: [{url: "https://api.example.com"}]
paths:
  /reports:
    get:
      operationId: listReports
      responses:
        "200":
          description: reports
          content:
            application/json:
              schema: {$ref: 'shared/model.yaml#/components/schemas/Report'}
`,
      {
        "https://api.example/shared/model.yaml": `openapi: 3.0.3
info: {title: Shared, version: "1"}
paths: {}
components:
  schemas:
    Report:
      type: object
      properties:
        owner: {$ref: '#/components/schemas/Team'}
    Team:
      type: object
      properties:
        lead: {$ref: '#/components/schemas/Member'}
        latest: {$ref: '#/components/schemas/Report'}
    Member:
      type: object
      properties:
        team: {$ref: '#/components/schemas/Team'}
`,
      },
      "listReports",
    );
    expect(Object.keys(defs).sort()).toEqual(["Member", "Report", "Team"]);
  });
});
