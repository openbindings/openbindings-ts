import { describe, it, expect, vi } from "vitest";
import { OperationInvoker, defaultBindingSelector } from "./operation-invoker.js";
import type { BindingInvoker, TransformEvaluator } from "./invokers.js";
import type { StreamEvent } from "./invoker-types.js";
import type { OBInterface } from "./types.js";
import { BindingNotFoundError, NoInvokerError, OperationNotFoundError } from "./errors.js";
import { ERR_VALIDATION_FAILED } from "./errcodes.js";

const mockInvoker: BindingInvoker = {
  formats() {
    return [{ token: "openapi@3.1" }];
  },
  async *invokeBinding(input) {
    yield { data: { mock: true, ref: input.ref } };
  },
};

const testInterface: OBInterface = {
  openbindings: "0.1.0",
  operations: {
    getUser: { kind: "method" },
  },
  sources: {
    api: { format: "openapi@3.1", location: "https://example.com/api.json" },
  },
  bindings: {
    "getUser.api": {
      operation: "getUser",
      source: "api",
      ref: "#/paths/~1users/get",
    },
  },
};

describe("OperationInvoker", () => {
  it("routes invokeBinding by format", async () => {
    const invoker = new OperationInvoker([mockInvoker]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invokeBinding({
      source: { format: "openapi@3.1", location: "https://x.com" },
      ref: "#/paths/~1users/get",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ mock: true, ref: "#/paths/~1users/get" });
  });

  it("throws NoInvokerError for unknown format", async () => {
    const invoker = new OperationInvoker([mockInvoker]);
    const gen = invoker.invokeBinding({
      source: { format: "grpc@1.0", location: "x" },
      ref: "x",
    });
    await expect(gen[Symbol.asyncIterator]().next()).rejects.toThrow(NoInvokerError);
  });

  it("invokes an operation by key (stream)", async () => {
    const invoker = new OperationInvoker([mockInvoker]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: testInterface,
      operation: "getUser",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ mock: true, ref: "#/paths/~1users/get" });
  });

  it("throws OperationNotFoundError for missing op", async () => {
    const invoker = new OperationInvoker([mockInvoker]);
    const gen = invoker.invoke({
      interface: testInterface,
      operation: "nonexistent",
    });
    await expect(gen.next()).rejects.toThrow(OperationNotFoundError);
  });

  it("yields binding_not_found when bindingKey does not exist", async () => {
    const invoker = new OperationInvoker([mockInvoker]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: testInterface,
      operation: "getUser",
      bindingKey: "getUser.nope",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error?.code).toBe("binding_not_found");
  });
});

// ---------------------------------------------------------------------------
// OBI-T-07 / OBI-T-08 — input/output schema validation
// ---------------------------------------------------------------------------

const ifaceWithInputSchema: OBInterface = {
  openbindings: "0.1.0",
  operations: {
    createUser: {
      input: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
        },
        required: ["name"],
      },
    },
  },
  sources: {
    api: { format: "openapi@3.1", location: "https://example.com/api.json" },
  },
  bindings: {
    "createUser.api": {
      operation: "createUser",
      source: "api",
      ref: "#/paths/~1users/post",
    },
  },
};

const ifaceWithOutputSchema: OBInterface = {
  openbindings: "0.1.0",
  operations: {
    getUser: {
      output: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
    },
  },
  sources: {
    api: { format: "openapi@3.1", location: "https://example.com/api.json" },
  },
  bindings: {
    "getUser.api": {
      operation: "getUser",
      source: "api",
      ref: "#/paths/~1users~1{id}/get",
    },
  },
};

const ifaceWithSchemaRef: OBInterface = {
  openbindings: "0.1.0",
  schemas: {
    User: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
  },
  operations: {
    getUser: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      output: { $ref: "#/schemas/User" },
    },
  },
  sources: {
    api: { format: "openapi@3.1", location: "https://example.com/api.json" },
  },
  bindings: {
    "getUser.api": {
      operation: "getUser",
      source: "api",
      ref: "#/paths/~1users~1{id}/get",
    },
  },
};

function stubInvoker(data: unknown): BindingInvoker {
  return {
    formats: () => [{ token: "openapi@3.1" }],
    async *invokeBinding() { yield { data }; },
  };
}

describe("OBI-T-07 — input validation", () => {
  it("rejects invalid input when schema is specified", async () => {
    const invoker = new OperationInvoker([stubInvoker({ ok: true })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: ifaceWithInputSchema,
      operation: "createUser",
      input: { age: 25 }, // missing required "name"
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error?.code).toBe(ERR_VALIDATION_FAILED);
  });

  it("accepts valid input when schema is specified", async () => {
    const invoker = new OperationInvoker([stubInvoker({ ok: true })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: ifaceWithInputSchema,
      operation: "createUser",
      input: { name: "alice", age: 30 },
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ ok: true });
    expect(events[0].error).toBeUndefined();
  });

  it("skips validation when no input schema is specified", async () => {
    const invoker = new OperationInvoker([stubInvoker({ ok: true })]);
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { ping: {} },
      sources: { api: { format: "openapi@3.1", location: "x" } },
      bindings: { "ping.api": { operation: "ping", source: "api", ref: "" } },
    };
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: iface,
      operation: "ping",
      input: { anything: "goes" },
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error).toBeUndefined();
  });

  it("skips validation when input is undefined", async () => {
    const invoker = new OperationInvoker([stubInvoker({ ok: true })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: ifaceWithInputSchema,
      operation: "createUser",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error).toBeUndefined();
  });

  it("validates input with $ref to #/schemas", async () => {
    const iface: OBInterface = {
      openbindings: "0.1.0",
      schemas: {
        CreateUserInput: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      operations: {
        createUser: { input: { $ref: "#/schemas/CreateUserInput" } },
      },
      sources: { api: { format: "openapi@3.1", location: "x" } },
      bindings: { "createUser.api": { operation: "createUser", source: "api", ref: "" } },
    };
    const invoker = new OperationInvoker([stubInvoker({ ok: true })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: iface,
      operation: "createUser",
      input: { name: "alice" },
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ ok: true });
    expect(events[0].error).toBeUndefined();
  });

  it("rejects input that fails $ref schema", async () => {
    const iface: OBInterface = {
      openbindings: "0.1.0",
      schemas: {
        CreateUserInput: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      operations: {
        createUser: { input: { $ref: "#/schemas/CreateUserInput" } },
      },
      sources: { api: { format: "openapi@3.1", location: "x" } },
      bindings: { "createUser.api": { operation: "createUser", source: "api", ref: "" } },
    };
    const invoker = new OperationInvoker([stubInvoker({ ok: true })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: iface,
      operation: "createUser",
      input: { missing: "name field" },
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error?.code).toBe(ERR_VALIDATION_FAILED);
  });

  it("does not call inputTransform when input validation fails", async () => {
    const evaluateSpy = vi.fn(async () => ({ transformed: true }));
    const transformEval: TransformEvaluator = { evaluate: evaluateSpy };
    const driver: BindingInvoker = {
      formats: () => [{ token: "openapi@3.1" }],
      async *invokeBinding() { yield { data: { ok: true } }; },
    };
    const invoker = new OperationInvoker([driver], { transformEvaluator: transformEval });
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: {
        createUser: {
          input: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      },
      sources: { api: { format: "openapi@3.1", location: "x" } },
      bindings: {
        "createUser.api": {
          operation: "createUser",
          source: "api",
          ref: "",
          inputTransform: "transform-expr",
        },
      },
    };
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: iface,
      operation: "createUser",
      input: { age: 25 }, // missing required "name"
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error?.code).toBe(ERR_VALIDATION_FAILED);
    expect(evaluateSpy).not.toHaveBeenCalled();
  });
});

describe("OBI-T-08 — output validation", () => {
  it("rejects invalid output when schema is specified", async () => {
    const invoker = new OperationInvoker([stubInvoker({ invalid: true })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: ifaceWithOutputSchema,
      operation: "getUser",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error?.code).toBe(ERR_VALIDATION_FAILED);
  });

  it("accepts valid output when schema is specified", async () => {
    const invoker = new OperationInvoker([stubInvoker({ id: "1", name: "alice" })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: ifaceWithOutputSchema,
      operation: "getUser",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ id: "1", name: "alice" });
    expect(events[0].error).toBeUndefined();
  });

  it("skips validation when no output schema is specified", async () => {
    const invoker = new OperationInvoker([stubInvoker({ anything: true })]);
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { ping: {} },
      sources: { api: { format: "openapi@3.1", location: "x" } },
      bindings: { "ping.api": { operation: "ping", source: "api", ref: "" } },
    };
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: iface,
      operation: "ping",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error).toBeUndefined();
  });

  it("validates output with $ref to #/schemas", async () => {
    const invoker = new OperationInvoker([stubInvoker({ id: "1", name: "alice" })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: ifaceWithSchemaRef,
      operation: "getUser",
      input: { id: "1" },
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ id: "1", name: "alice" });
    expect(events[0].error).toBeUndefined();
  });

  it("rejects output that fails $ref schema", async () => {
    const invoker = new OperationInvoker([stubInvoker({ missing: "fields" })]);
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: ifaceWithSchemaRef,
      operation: "getUser",
      input: { id: "1" },
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error?.code).toBe(ERR_VALIDATION_FAILED);
  });

  it("validates output after transform", async () => {
    const driver: BindingInvoker = {
      formats: () => [{ token: "openapi@3.1" }],
      async *invokeBinding() { yield { data: { raw: true } }; },
    };
    const transformEval: TransformEvaluator = {
      evaluate: async () => ({ id: "1", name: "alice" }),
    };
    const invoker = new OperationInvoker([driver], { transformEvaluator: transformEval });
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: {
        getUser: {
          output: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["id", "name"],
          },
        },
      },
      sources: { api: { format: "openapi@3.1", location: "x" } },
      bindings: {
        "getUser.api": {
          operation: "getUser",
          source: "api",
          ref: "",
          outputTransform: "transform-expr",
        },
      },
    };
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: iface,
      operation: "getUser",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ id: "1", name: "alice" });
    expect(events[0].error).toBeUndefined();
  });

  it("rejects invalid output after transform", async () => {
    const driver: BindingInvoker = {
      formats: () => [{ token: "openapi@3.1" }],
      async *invokeBinding() { yield { data: { raw: true } }; },
    };
    const transformEval: TransformEvaluator = {
      evaluate: async () => ({ wrong: "shape" }),
    };
    const invoker = new OperationInvoker([driver], { transformEvaluator: transformEval });
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: {
        getUser: {
          output: {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["id", "name"],
          },
        },
      },
      sources: { api: { format: "openapi@3.1", location: "x" } },
      bindings: {
        "getUser.api": {
          operation: "getUser",
          source: "api",
          ref: "",
          outputTransform: "transform-expr",
        },
      },
    };
    const events: StreamEvent[] = [];
    for await (const ev of invoker.invoke({
      interface: iface,
      operation: "getUser",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].error?.code).toBe(ERR_VALIDATION_FAILED);
  });
});

describe("defaultBindingSelector", () => {
  it("selects the only matching binding", () => {
    const { key, binding } = defaultBindingSelector(testInterface, "getUser");
    expect(key).toBe("getUser.api");
    expect(binding.ref).toBe("#/paths/~1users/get");
  });

  it("throws when no binding matches", () => {
    expect(() => defaultBindingSelector(testInterface, "deleteUser")).toThrow(BindingNotFoundError);
  });

  it("prefers non-deprecated over deprecated", () => {
    const iface: OBInterface = {
      openbindings: "0.1.0",
      operations: { op: { kind: "method" } },
      sources: { s: { format: "openapi@3.1", location: "x" } },
      bindings: {
        "op.deprecated": { operation: "op", source: "s", deprecated: true, priority: 1 },
        "op.fresh": { operation: "op", source: "s", priority: 10 },
      },
    };
    const { key } = defaultBindingSelector(iface, "op");
    expect(key).toBe("op.fresh");
  });
});
