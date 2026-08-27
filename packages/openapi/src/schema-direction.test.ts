import { describe, expect, it } from "vitest";
import { createOpenAPISchemaProjector } from "./schema-direction.js";

describe("createOpenAPISchemaProjector", () => {
  it("projects directionality inside contentSchema", () => {
    const schema = {
      type: "string",
      contentMediaType: "application/json",
      contentSchema: {
        type: "object",
        required: ["server", "client"],
        properties: {
          server: { type: "string", readOnly: true },
          client: { type: "string", writeOnly: true },
        },
      },
    };

    const request = createOpenAPISchemaProjector("request").project(schema) as Record<string, unknown>;
    const response = createOpenAPISchemaProjector("response").project(schema) as Record<string, unknown>;
    const requestContent = request.contentSchema as Record<string, unknown>;
    const responseContent = response.contentSchema as Record<string, unknown>;

    const preserved = {
      server: { type: "string", readOnly: true },
      client: { type: "string", writeOnly: true },
    };
    expect(requestContent.properties).toEqual(preserved);
    expect(requestContent.required).toEqual(["server", "client"]);
    expect(responseContent.properties).toEqual(preserved);
    expect(responseContent.required).toEqual(["server", "client"]);
  });
});
