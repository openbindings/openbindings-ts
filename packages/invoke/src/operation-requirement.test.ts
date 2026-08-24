import { describe, expect, it } from "vitest";
import {
  InvocationError,
  InvocationImpl,
  single,
  type ContextRequiredDetails,
  type Invocation,
} from "./invocation.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { BindingSpecInfo } from "@openbindings/core";
import type { BindingInvoker } from "./invokers.js";
import { OperationInvoker } from "./operation-invoker.js";
import {
  matchOperationRequirement,
  operationRequirement,
  resolveOperationRequirement,
  type OperationImplementation,
} from "./operation-requirement.js";
import { operationSignature } from "./operation-signature.js";
import type { OBInterface } from "@openbindings/core";

type CreateInput = { title: string };
type CreateOutput = { id: string };

const REQUIRED: OBInterface = {
  openbindings: "0.2.0",
  operations: {
    "example.tasks.create": {
      input: { $ref: "#/schemas/CreateInput" },
      output: { $ref: "#/schemas/CreateOutput" },
    },
    "example.tasks.list": {
      output: { type: "array" },
    },
  },
  schemas: {
    CreateInput: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    CreateOutput: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
};

const CREATE = operationSignature<CreateInput, CreateOutput>("example.tasks.create");

function candidateInterface(
  bindingSpec: string,
  outputSchema: Record<string, unknown> = { $ref: "#/schemas/CreateOutput" },
): OBInterface {
  return {
    openbindings: "0.2.0",
    name: bindingSpec,
    operations: {
      createTodo: {
        aliases: ["example.tasks.create"],
        input: { $ref: "#/schemas/CreateInput" },
        output: outputSchema,
      },
    },
    schemas: REQUIRED.schemas,
    sources: {
      service: { bindingSpec },
    },
    bindings: {
      createTodo: {
        operation: "createTodo",
        source: "service",
        selector: "create",
      },
    },
  };
}

async function first<T>(values: AsyncIterable<T>): Promise<T | undefined> {
  for await (const value of values) return value;
  return undefined;
}

class LocalBindingInvoker implements BindingInvoker {
  invocationCount = 0;

  constructor(
    private readonly bindingSpec: string,
    private readonly prefix: string,
    private readonly requirements: ContextRequiredDetails | null = null,
  ) {}

  checkBindingSpecs(bindingSpecs: readonly string[]) {
    return [...new Set(bindingSpecs)].map(bindingSpec => ({ bindingSpec, supported: bindingSpec === this.bindingSpec }));
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: this.bindingSpec }];
  }

  async prepareBinding(): Promise<ContextRequiredDetails | null> {
    return this.requirements;
  }

  invokeBinding<I = unknown, O = unknown>(
    args: BindingInvocationArgs,
  ): Invocation<I, O> {
    this.invocationCount += 1;
    const invocation = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(async () => {
      try {
        const input = await first(invocation.inputs()) as CreateInput | undefined;
        await invocation.closeInput();
        if (!input) throw new Error("missing input");
        await invocation.emitOutput({ id: `${this.prefix}:${input.title}` });
        invocation.closeOutput();
      } catch (error: unknown) {
        invocation.fireError(
          error instanceof Error
            ? new InvocationError("ERR_RUNTIME")
            : new InvocationError("ERR_RUNTIME"),
        );
      }
    });
    return invocation as Invocation<I, O>;
  }
}

function implementation(
  bindingSpec: string,
  prefix: string,
  options?: {
    preference?: number;
    outputSchema?: Record<string, unknown>;
    requirements?: ContextRequiredDetails | null;
  },
): OperationImplementation {
  const binding = new LocalBindingInvoker(
    bindingSpec,
    prefix,
    options?.requirements,
  );
  return {
    interface: candidateInterface(bindingSpec, options?.outputSchema),
    invoker: new OperationInvoker([binding]),
    label: prefix,
    ...(options?.preference !== undefined ? { preference: options.preference } : {}),
  };
}

describe("operationRequirement", () => {
  it("pairs a typed signature with an ordinary required OBI", () => {
    const requirement = operationRequirement(REQUIRED, CREATE);
    expect(requirement.interface).toBe(REQUIRED);
    expect(requirement.signature).toBe(CREATE);
  });

  it("refuses an identifier the required interface does not carry", () => {
    expect(() =>
      operationRequirement(REQUIRED, operationSignature("example.tasks.remove")),
    ).toThrow(/operation not found/);
  });
});

describe("resolveOperationRequirement", () => {
  it("uses only the requested operation and preserves each complete schema graph", async () => {
    const resolution = await resolveOperationRequirement(
      operationRequirement(REQUIRED, CREATE),
      [implementation("example.local@1", "local")],
    );

    expect(resolution.status).toBe("available");
    if (resolution.status !== "available") return;
    expect(resolution.match.canonicalOperation).toBe("createTodo");
    expect(resolution.match.knownContextRequirements).toBeNull();

    const call = resolution.match.invoke();
    await call.write({ title: "draft" });
    await expect(single(call.outputs)).resolves.toEqual({ id: "local:draft" });
  });

  it("substitutes binding families without changing the requirement", async () => {
    const requirement = operationRequirement(REQUIRED, CREATE);
    const one = implementation("example.protocol-one@1", "one");
    const two = implementation("example.protocol-two@1", "two");

    const firstResolution = await resolveOperationRequirement(requirement, [one]);
    const secondResolution = await resolveOperationRequirement(requirement, [two]);
    expect(firstResolution.status).toBe("available");
    expect(secondResolution.status).toBe("available");

    if (firstResolution.status === "available" && secondResolution.status === "available") {
      const firstCall = firstResolution.match.invoke();
      const secondCall = secondResolution.match.invoke();
      await firstCall.write({ title: "same-consumer" });
      await secondCall.write({ title: "same-consumer" });
      await expect(single(firstCall.outputs)).resolves.toEqual({
        id: "one:same-consumer",
      });
      await expect(single(secondCall.outputs)).resolves.toEqual({
        id: "two:same-consumer",
      });
    }
  });

  it("refuses an equal-preference tie and honors a unique caller preference", async () => {
    const requirement = operationRequirement(REQUIRED, CREATE);
    const one = implementation("example.protocol-one@1", "one");
    const two = implementation("example.protocol-two@1", "two");

    const tied = await resolveOperationRequirement(requirement, [one, two]);
    expect(tied.status).toBe("ambiguous");
    if (tied.status === "ambiguous") {
      expect(tied.matches.map(match => match.implementation.label)).toEqual(["one", "two"]);
    }

    const preferred = await resolveOperationRequirement(requirement, [
      one,
      { ...two, preference: 10 },
    ]);
    expect(preferred.status).toBe("available");
    if (preferred.status === "available") {
      expect(preferred.match.implementation.label).toBe("two");
    }
  });

  it("returns every ordered match without imposing route-to-one composition", async () => {
    const requirement = operationRequirement(REQUIRED, CREATE);
    const one = implementation("example.protocol-one@1", "one", {
      preference: -1,
    });
    const two = implementation("example.protocol-two@1", "two", {
      preference: 10,
    });
    const three = implementation("example.protocol-three@1", "three", {
      preference: 10,
    });

    const result = await matchOperationRequirement(requirement, [one, two, three]);
    expect(result.matches.map(match => match.implementation.label)).toEqual([
      "two",
      "three",
      "one",
    ]);
    expect(result.assessments).toEqual([]);
  });

  it("preflights candidates without invoking them", async () => {
    const binding = new LocalBindingInvoker("example.local@1", "local");
    const concrete = {
      interface: candidateInterface("example.local@1"),
      invoker: new OperationInvoker([binding]),
    };

    const result = await matchOperationRequirement(
      operationRequirement(REQUIRED, CREATE),
      [concrete],
    );

    expect(result.matches).toHaveLength(1);
    expect(binding.invocationCount).toBe(0);
  });

  it("cancels matching and forwards the signal to binding preflight", async () => {
    const controller = new AbortController();
    const cancelled = new Error("candidate set changed");
    let started!: () => void;
    const preflightStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const binding: BindingInvoker = {
      checkBindingSpecs: bindingSpecs => [...new Set(bindingSpecs)].map(bindingSpec => ({
        bindingSpec,
        supported: bindingSpec === "example.slow@1",
      })),
      bindingSpecs: () => [{ bindingSpec: "example.slow@1" }],
      prepareBinding: args => {
        observedSignal = args.signal;
        started();
        return new Promise((_resolve, reject) => {
          args.signal?.addEventListener(
            "abort",
            () => reject(
              args.signal?.reason instanceof Error
                ? args.signal.reason
                : new DOMException("preflight cancelled", "AbortError"),
            ),
            { once: true },
          );
        });
      },
      invokeBinding: () => {
        throw new Error("matching must not invoke");
      },
    };

    const matching = matchOperationRequirement(
      operationRequirement(REQUIRED, CREATE),
      [{
        interface: candidateInterface("example.slow@1"),
        invoker: new OperationInvoker([binding]),
      }],
      { signal: controller.signal },
    );
    await preflightStarted;
    controller.abort(cancelled);

    await expect(matching).rejects.toBe(cancelled);
    expect(observedSignal).toBe(controller.signal);
  });

  it("reports schema incompatibility rather than treating an identifier claim as proof", async () => {
    const incompatibleOutput = {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    };
    const resolution = await resolveOperationRequirement(
      operationRequirement(REQUIRED, CREATE),
      [
        implementation("example.local@1", "bad", {
          outputSchema: incompatibleOutput,
        }),
      ],
    );

    expect(resolution.status).toBe("unavailable");
    if (resolution.status === "unavailable") {
      expect(resolution.assessments[0]?.issues).toEqual([
        expect.objectContaining({
          operation: "example.tasks.create",
          kind: "output_incompatible",
        }),
      ]);
    }
  });

  it("attaches advisory context preflight while keeping the operation available", async () => {
    const requirements: ContextRequiredDetails = {
      target: "local:test",
      alternatives: [{ requirements: [{ type: "approval.user", durable: false }] }],
    };
    const resolution = await resolveOperationRequirement(
      operationRequirement(REQUIRED, CREATE),
      [
        implementation("example.local@1", "approval", {
          requirements,
        }),
      ],
    );

    expect(resolution.status).toBe("available");
    if (resolution.status === "available") {
      expect(resolution.match.knownContextRequirements).toEqual(requirements);
    }
  });

  it("does not call a schema-compatible interface available when its binding is unsupported", async () => {
    const resolution = await resolveOperationRequirement(
      operationRequirement(REQUIRED, CREATE),
      [{
        interface: candidateInterface("example.uninstalled@1"),
        invoker: new OperationInvoker([]),
      }],
    );

    expect(resolution.status).toBe("unavailable");
    if (resolution.status === "unavailable") {
      expect(resolution.assessments[0]?.issues).toEqual([]);
      expect(resolution.assessments[0]?.reason).toMatch(/no binding|no invoker/);
    }
  });

  it("refuses non-finite preference instead of inventing an order", async () => {
    const resolution = await resolveOperationRequirement(
      operationRequirement(REQUIRED, CREATE),
      [{ ...implementation("example.local@1", "bad-pref"), preference: Number.NaN }],
    );
    expect(resolution.status).toBe("unavailable");
    if (resolution.status === "unavailable") {
      expect(resolution.assessments[0]?.reason).toMatch(/finite/);
    }
  });

  it("reports malformed runtime candidates instead of crashing", async () => {
    const resolution = await resolveOperationRequirement(
      operationRequirement(REQUIRED, CREATE),
      [{
        interface: candidateInterface("example.local@1"),
      } as OperationImplementation],
    );

    expect(resolution.status).toBe("unavailable");
    if (resolution.status === "unavailable") {
      expect(resolution.assessments[0]?.reason).toMatch(/invoker is required/);
    }
  });
});
