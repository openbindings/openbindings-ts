import { describe, expect, it } from "vitest";
import { prepareInterface, type OBInterface } from "@openbindings/core";
import {
  CompositionSession,
  OperationInvoker,
  dependencySignatureFromOperation,
  localUnary,
  operationSignature,
  prepareLocalProvider,
  prepareProvider,
  single,
  type PreparedProvider,
} from "@openbindings/invoke";
import { OpenAPIInvoker, OpenAPISynthesizer } from "./test-helpers.js";

type CreateTaskInput = { title: string };
type CreateTaskOutput = { id: string };

const CREATE = operationSignature<CreateTaskInput, CreateTaskOutput>(
  "example.tasks.create",
);
const CREATION = dependencySignatureFromOperation("creation", CREATE);

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
  dependencies: {
    creation: {
      operation: "example.tasks.create",
		bindingSpecs: ["openbindings.openapi-3.1@1", "example.local@1"],
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

async function createTask(
  consumer: Awaited<ReturnType<typeof prepareInterface>>,
  provider: PreparedProvider,
  input: CreateTaskInput,
): Promise<CreateTaskOutput> {
  const resolution = await new CompositionSession({
    consumer,
    providers: [{ provider }],
  }).resolve(CREATION);
  if (resolution.status !== "available") {
    throw new Error(`creation dependency is ${resolution.status}`);
  }
  const invocation = resolution.route.invoke();
  await invocation.write(input);
  return single(invocation.outputs);
}

describe("runtime composition — OpenAPI and local substitution", () => {
  it("changes providers without changing protocol-neutral consumer code", async () => {
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
        bindingSpec: "openbindings.openapi-3.1@1",
        content: OPENAPI,
      }],
    });
		const openAPIProvider = await prepareProvider({
			key: "tasks-api",
      interface: candidate,
      runtime: new OperationInvoker([new OpenAPIInvoker()], { fetch }),
    });
    const localDocument: OBInterface = {
      openbindings: "0.2.0",
      operations: REQUIRED.operations,
      sources: {
        local: {
          bindingSpec: "example.local@1",
          location: "app://tasks",
        },
      },
      bindings: {
        create: {
          operation: "example.tasks.create",
          source: "local",
				selector: "create",
        },
      },
    };
    const localInput = { title: "Keep native identity" };
    let received: CreateTaskInput | undefined;
    const localProvider = await prepareLocalProvider({
      key: "local-tasks",
      interface: localDocument,
      implementations: {
        create: localUnary<CreateTaskInput, CreateTaskOutput>(input => {
          received = input;
          return { id: "task_local" };
        }),
      },
    });
    const consumer = await prepareInterface(REQUIRED);

    await expect(createTask(consumer, openAPIProvider, { title: "Ship the operation layer" }))
      .resolves.toEqual({ id: "task_1" });
    expect(requests).toEqual([{
      url: "https://tasks.example.test/todos",
      method: "POST",
      body: { title: "Ship the operation layer" },
    }]);

    const localResult = await createTask(consumer, localProvider, localInput);
    expect(localResult).toEqual({ id: "task_local" });
    expect(received).toBe(localInput);

    await Promise.all([openAPIProvider.dispose(), localProvider.dispose()]);
  });
});
