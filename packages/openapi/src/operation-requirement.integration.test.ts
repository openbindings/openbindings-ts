import { describe, expect, it } from "vitest";
import { type OBInterface } from "@openbindings/core";
import {
  OperationInvoker,
  operationRequirement,
  operationSignature,
  resolveOperationRequirement,
  single,
} from "@openbindings/invoke";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./invoker.js";

type CreateTaskInput = { title: string };
type CreateTaskOutput = { id: string };

const REQUIRED: OBInterface = {
  openbindings: "0.2.0",
  operations: {
    "example.tasks.create": {
      input: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      output: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
};

const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Tasks", version: "1.0.0" },
  servers: [{ url: "https://tasks.example.test" }],
  paths: {
    "/todos": {
      post: {
        operationId: "example.tasks.create",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: REQUIRED.operations["example.tasks.create"]?.input,
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: REQUIRED.operations["example.tasks.create"]?.output,
              },
            },
          },
        },
      },
    },
  },
};

describe("operation requirement — synthesized OpenAPI vertical slice", () => {
  it("synthesizes and invokes HTTP without protocol code in the consumer", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ id: "task_1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    const candidate = await new OpenAPISynthesizer().synthesizeInterface({
      sources: [{
        bindingSpec: "openbindings.openapi@1",
        content: OPENAPI,
      }],
    });
    const invoker = new OperationInvoker([new OpenAPIInvoker()], { fetch });
    const requirement = operationRequirement(
      REQUIRED,
      operationSignature<CreateTaskInput, CreateTaskOutput>("example.tasks.create"),
    );
    const resolution = await resolveOperationRequirement(requirement, [{
      interface: candidate,
      invoker,
      label: "tasks-api",
    }]);

    expect(resolution.status).toBe("available");
    if (resolution.status !== "available") return;

    const invocation = resolution.match.invoke();
    await invocation.write({ title: "Ship the operation layer" });
    await expect(single(invocation.outputs)).resolves.toEqual({ id: "task_1" });
    expect(requests).toEqual([{
      url: "https://tasks.example.test/todos",
      method: "POST",
      body: { title: "Ship the operation layer" },
    }]);
  });
});
