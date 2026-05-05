import { describe, it, expect } from "vitest";
import {
  InterfaceClient,
  OperationInvoker,
  type OBInterface,
  type BindingInvocationInput,
  type StreamEvent,
  type BindingInvoker,
  type CompatibilityIssue,
} from "./index.js";

function createMockDriver(
  invokeFn?: (input: BindingInvocationInput) => AsyncIterable<StreamEvent>,
): BindingInvoker {
  return {
    formats() {
      return [{ token: "test@1.0" }];
    },
    async *invokeBinding(input: BindingInvocationInput) {
      if (invokeFn) {
        yield* invokeFn(input);
        return;
      }
      yield { data: { result: "ok" } };
    },
  };
}

const serviceOBI: OBInterface = {
  openbindings: "0.2.0",
  operations: {
    listWorkspaces: {
      kind: "method",
      output: { type: "object" },
      satisfies: [
        { role: "openbindings.workspace-manager", operation: "listWorkspaces" },
      ],
    },
    getWorkspace: {
      kind: "method",
      input: { type: "object", properties: { id: { type: "string" } } },
      output: { type: "object" },
      satisfies: [
        { role: "openbindings.workspace-manager", operation: "getWorkspace" },
      ],
    },
    search: {
      kind: "method",
      input: { type: "object", properties: { q: { type: "string" } } },
      output: { type: "object" },
    },
    getInfo: {
      kind: "method",
      output: { type: "object" },
    },
  },
  sources: { s: { format: "test@1.0", location: "x" } },
  bindings: {
    "listWorkspaces.s": { operation: "listWorkspaces", source: "s", ref: "" },
    "getWorkspace.s": { operation: "getWorkspace", source: "s", ref: "" },
    "search.s": { operation: "search", source: "s", ref: "" },
    "getInfo.s": { operation: "getInfo", source: "s", ref: "" },
  },
};

const workspaceManagerIface: OBInterface = {
  openbindings: "0.2.0",
  operations: {
    listWorkspaces: { kind: "method", output: { type: "object" } },
    getWorkspace: {
      kind: "method",
      input: { type: "object", properties: { id: { type: "string" } } },
      output: { type: "object" },
    },
  },
};

const incompatibleIface: OBInterface = {
  openbindings: "0.2.0",
  operations: {
    doSomethingExotic: { kind: "method", output: { type: "object" } },
  },
};

// ---------------------------------------------------------------------------
// Discovery mode
// ---------------------------------------------------------------------------

describe("InterfaceClient — discovery mode", () => {
  it("accepts null and resolves to bound without compatibility check", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(null, opInvoker);

    expect(client.interface).toBeNull();
    expect(client.state.kind).toBe("idle");

    await client.resolve(serviceOBI);

    expect(client.state.kind).toBe("bound");
    expect(client.resolved).toBe(serviceOBI);
  });

  it("invokes operations against the resolved OBI", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(null, opInvoker);

    await client.resolve(serviceOBI);
    const events: { data?: unknown; error?: unknown }[] = [];
    for await (const ev of client.invoke("search" as any, { q: "test" })) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ result: "ok" });
    expect(events[0].error).toBeUndefined();
  });

  it("throws when invoking before resolution", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(null, opInvoker);

    await expect(async () => {
      for await (const _ev of client.invoke("search" as any)) { /* drain */ }
    }).rejects.toThrow("not bound");
  });
});

// ---------------------------------------------------------------------------
// conforms()
// ---------------------------------------------------------------------------

describe("InterfaceClient.conforms()", () => {
  it("returns empty array when service conforms to the required interface", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(null, opInvoker);
    await client.resolve(serviceOBI);

    const issues = await client.conforms(workspaceManagerIface);
    expect(issues).toEqual([]);
  });

  it("returns issues when service lacks required operations", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(null, opInvoker);
    await client.resolve(serviceOBI);

    const issues = await client.conforms(incompatibleIface);
    expect(issues.length).toBe(1);
    expect(issues[0].operation).toBe("doSomethingExotic");
    expect(issues[0].kind).toBe("missing");
  });

  it("supports satisfies-based matching when interfaceId is provided", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(null, opInvoker);

    const renamedIface: OBInterface = {
      openbindings: "0.2.0",
      operations: {
        listWorkspaces: { kind: "method", output: { type: "object" } },
        getWorkspace: {
          kind: "method",
          input: { type: "object", properties: { id: { type: "string" } } },
          output: { type: "object" },
        },
      },
    };

    await client.resolve(serviceOBI);
    const issues = await client.conforms(renamedIface, "openbindings.workspace-manager");
    expect(issues).toEqual([]);
  });

  it("throws when called before resolution", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(null, opInvoker);

    await expect(client.conforms(workspaceManagerIface)).rejects.toThrow(
      "Cannot check conformance before resolution",
    );
  });

  it("works from demand mode too (single required interface)", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const requiredIface: OBInterface = {
      openbindings: "0.2.0",
      operations: { getInfo: { kind: "method", output: { type: "object" } } },
    };

    const client = new InterfaceClient(requiredIface, opInvoker);
    await client.resolve(serviceOBI);
    expect(client.state.kind).toBe("bound");

    const wsIssues = await client.conforms(workspaceManagerIface);
    expect(wsIssues).toEqual([]);

    const exoticIssues = await client.conforms(incompatibleIface);
    expect(exoticIssues.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — demand mode unchanged
// ---------------------------------------------------------------------------

describe("InterfaceClient — demand mode (backward compat)", () => {
  it("still enforces compatibility when required interface is provided", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(incompatibleIface, opInvoker);

    await client.resolve(serviceOBI);

    expect(client.state.kind).toBe("incompatible");
    expect(client.issues.length).toBe(1);
    expect(client.issues[0].operation).toBe("doSomethingExotic");
  });

  it("reaches bound state with a compatible required interface", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(workspaceManagerIface, opInvoker);

    await client.resolve(serviceOBI);

    expect(client.state.kind).toBe("bound");
    expect(client.resolved).toBe(serviceOBI);
  });

  it("close() resets state in demand mode", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(workspaceManagerIface, opInvoker);

    await client.resolve(serviceOBI);
    expect(client.state.kind).toBe("bound");

    client.close();
    expect(client.state.kind).toBe("idle");
    expect(client.resolved).toBeUndefined();
  });

  it("interfaceJSON() returns the required interface", () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(workspaceManagerIface, opInvoker);
    const json = client.interfaceJSON();
    expect(JSON.parse(json)).toEqual(workspaceManagerIface);
  });

  it("interfaceJSON() returns 'null' in discovery mode", () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(null, opInvoker);
    expect(client.interfaceJSON()).toBe("null");
  });
});
