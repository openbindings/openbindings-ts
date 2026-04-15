import { describe, it, expect, vi } from "vitest";
import { OperationExecutor, defaultBindingSelector } from "./executor.js";
import type { BindingExecutor } from "./executors.js";
import type { StreamEvent } from "./executor-types.js";
import type { OBInterface } from "./types.js";
import { BindingNotFoundError, NoExecutorError, OperationNotFoundError } from "./errors.js";

const mockExecutor: BindingExecutor = {
  formats() {
    return [{ token: "openapi@3.1" }];
  },
  async *executeBinding(input) {
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

describe("OperationExecutor", () => {
  it("routes executeBinding by format", async () => {
    const exec = new OperationExecutor([mockExecutor]);
    const events: StreamEvent[] = [];
    for await (const ev of exec.executeBinding({
      source: { format: "openapi@3.1", location: "https://x.com" },
      ref: "#/paths/~1users/get",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ mock: true, ref: "#/paths/~1users/get" });
  });

  it("throws NoExecutorError for unknown format", async () => {
    const exec = new OperationExecutor([mockExecutor]);
    const gen = exec.executeBinding({
      source: { format: "grpc@1.0", location: "x" },
      ref: "x",
    });
    await expect(gen[Symbol.asyncIterator]().next()).rejects.toThrow(NoExecutorError);
  });

  it("executes an operation by key (stream)", async () => {
    const exec = new OperationExecutor([mockExecutor]);
    const events: StreamEvent[] = [];
    for await (const ev of exec.executeOperation({
      interface: testInterface,
      operation: "getUser",
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ mock: true, ref: "#/paths/~1users/get" });
  });

  it("throws OperationNotFoundError for missing op", async () => {
    const exec = new OperationExecutor([mockExecutor]);
    const gen = exec.executeOperation({
      interface: testInterface,
      operation: "nonexistent",
    });
    await expect(gen.next()).rejects.toThrow(OperationNotFoundError);
  });

  it("yields binding_not_found when bindingKey does not exist", async () => {
    const exec = new OperationExecutor([mockExecutor]);
    const events: StreamEvent[] = [];
    for await (const ev of exec.executeOperation({
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
