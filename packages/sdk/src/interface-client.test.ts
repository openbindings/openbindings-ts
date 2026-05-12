import { describe, it, expect } from "vitest";
import {
  InterfaceClient,
  OperationInvoker,
  checkInterfaceCompatibility,
  type OBInterface,
  type BindingInvocationInput,
  type StreamEvent,
  type BindingInvoker,
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

describe("InterfaceClient", () => {
  it("holds the OBI passed to the constructor", () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(serviceOBI, opInvoker);
    expect(client.interface).toBe(serviceOBI);
  });

  it("invokes operations against the supplied OBI", async () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(serviceOBI, opInvoker);

    const events: { data?: unknown; error?: unknown }[] = [];
    for await (const ev of client.invoke("search" as never, { q: "test" } as never)) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ result: "ok" });
    expect(events[0].error).toBeUndefined();
  });

  it("interfaceJSON() serializes the supplied OBI", () => {
    const opInvoker = new OperationInvoker([createMockDriver()]);
    const client = new InterfaceClient(workspaceManagerIface, opInvoker);
    const json = client.interfaceJSON();
    expect(JSON.parse(json)).toEqual(workspaceManagerIface);
  });
});

describe("checkInterfaceCompatibility — caller-driven validation", () => {
  it("returns empty array when service satisfies the contract", async () => {
    const issues = await checkInterfaceCompatibility(workspaceManagerIface, serviceOBI);
    expect(issues).toEqual([]);
  });

  it("returns issues when service lacks required operations", async () => {
    const issues = await checkInterfaceCompatibility(incompatibleIface, serviceOBI);
    expect(issues.length).toBe(1);
    expect(issues[0].operation).toBe("doSomethingExotic");
    expect(issues[0].kind).toBe("missing");
  });

  it("supports satisfies-based matching when requiredInterfaceId is provided", async () => {
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

    const issues = await checkInterfaceCompatibility(renamedIface, serviceOBI, {
      requiredInterfaceId: "openbindings.workspace-manager",
    });
    expect(issues).toEqual([]);
  });
});
