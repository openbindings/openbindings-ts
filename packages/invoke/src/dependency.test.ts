import type { BindingSpecInfo, BindingSpecVerdict, OBInterface } from "@openbindings/core";
import { checkBindingSpecs, DependencyNotFoundError } from "@openbindings/core";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_REQUIRED,
  ERR_CANCELLED,
  ERR_SELECTOR_NOT_FOUND,
  ERR_RUNTIME,
} from "./errcodes.js";
import { HandlerBindingInvoker } from "./handler-binding-invoker.js";
import {
  InvocationError,
  InvocationImpl,
  single,
  type ContextRequiredDetails,
  type Invocation,
} from "./invocation.js";
import type { BindingInvocationArgs } from "./invoker-types.js";
import type { BindingInvoker } from "./invokers.js";
import { OperationInvoker } from "./operation-invoker.js";
import {
  dependencySignature,
  unsafeDependencySignature,
  matchDependency,
  resolveDependency,
  type InterfaceProvider,
} from "./dependency.js";

type CreateInput = { title: string };
type CreateOutput = { id: string };

const LOCAL_SPEC = "example.application-handler@1";
const REMOTE_SPEC = "example.remote@1";
const LOCAL_LOCATION = "app://task-providers/main";

const CONSUMER: OBInterface = {
  openbindings: "0.2.0",
  operations: {
    "tasks.create": {
      input: { $ref: "#/schemas/CreateInput" },
      output: { $ref: "#/schemas/CreateOutput" },
    },
  },
  dependencies: {
    creation: {
      operation: "tasks.create",
      bindingSpecs: [LOCAL_SPEC, REMOTE_SPEC],
    },
  },
  schemas: {
    CreateInput: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    CreateOutput: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
};

const CREATION = unsafeDependencySignature<CreateInput, CreateOutput>("creation");

function providerInterface(
  bindingSpec: string,
  bindings: Record<string, { source: string; selector: string }> = {
    primary: { source: "service", selector: "create" },
  },
): OBInterface {
  return {
    openbindings: "0.2.0",
    operations: {
      createTask: {
        aliases: ["tasks.create"],
        input: { $ref: "#/schemas/CreateInput" },
        output: { $ref: "#/schemas/CreateOutput" },
      },
    },
    schemas: CONSUMER.schemas,
    sources: {
      service: {
        bindingSpec,
        location: bindingSpec === LOCAL_SPEC
          ? LOCAL_LOCATION
          : "https://tasks.example.test/openbindings",
      },
    },
    bindings: Object.fromEntries(
      Object.entries(bindings).map(([key, binding]) => [
        key,
        { operation: "createTask", ...binding },
      ]),
    ),
  };
}

function localProvider(
  prefix: string,
  options?: {
    preference?: number;
    requirements?: ContextRequiredDetails | null;
    onInput?: (input: CreateInput) => void;
  },
): InterfaceProvider {
  const binding = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
  binding.register<CreateInput, CreateOutput>({
    location: LOCAL_LOCATION,
    selector: "create",
    prepare: () => options?.requirements ?? null,
    handler: async handle => {
      for await (const input of handle.inputs()) {
        await handle.closeInput();
        options?.onInput?.(input);
        await handle.emitOutput({ id: `${prefix}:${input.title}` });
        handle.closeOutput();
        return;
      }
      handle.fireError(new InvocationError(ERR_RUNTIME));
    },
  });
  return {
    interface: providerInterface(LOCAL_SPEC),
    invoker: new OperationInvoker([binding]),
    label: prefix,
    ...(options?.preference === undefined ? {} : { preference: options.preference }),
  };
}

class TransportLikeInvoker implements BindingInvoker {
  constructor(private readonly prefix: string) {}

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: REMOTE_SPEC }];
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkBindingSpecs(bindingSpecs, this.bindingSpecs());
  }

  invokeBinding<I = unknown, O = unknown>(
    args: BindingInvocationArgs,
  ): Invocation<I, O> {
    const invocation = new InvocationImpl<I, O>({ signal: args.signal });
    queueMicrotask(async () => {
      try {
        for await (const value of invocation.inputs()) {
          await invocation.closeInput();
          // Deliberately simulate a transport boundary. Dependency matching
          // and calling are unchanged even though this implementation copies.
          const input = JSON.parse(JSON.stringify(value)) as CreateInput;
          await invocation.emitOutput(
            { id: `${this.prefix}:${input.title}` } as O,
          );
          invocation.closeOutput();
          return;
        }
        invocation.fireError(new InvocationError(ERR_RUNTIME));
      } catch (error: unknown) {
        invocation.fireError(
          error instanceof InvocationError
            ? error
            : new InvocationError(ERR_RUNTIME),
        );
      }
    });
    return invocation;
  }
}

function remoteProvider(prefix: string): InterfaceProvider {
  return {
    interface: providerInterface(REMOTE_SPEC),
    invoker: new OperationInvoker([new TransportLikeInvoker(prefix)]),
    label: prefix,
  };
}

async function call(
  provider: InterfaceProvider,
  input: CreateInput,
): Promise<CreateOutput> {
  const resolution = await resolveDependency(CONSUMER, CREATION, [provider]);
  expect(resolution.status).toBe("available");
  if (resolution.status !== "available") throw new Error("unavailable dependency");
  const invocation = resolution.match.invoke();
  await invocation.write(input);
  return single(invocation.outputs);
}

describe("dependency matching", () => {
  it("takes its operation and binding-spec constraint from the named dependency", async () => {
    const result = await matchDependency(CONSUMER, CREATION, [localProvider("local")]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      dependencyKey: "creation",
      requiredOperationKey: "tasks.create",
      correspondenceIdentifier: "tasks.create",
      providerOperationKey: "createTask",
      bindingKey: "primary",
      bindingSpec: LOCAL_SPEC,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.matches)).toBe(true);
    expect(Object.isFrozen(result.matches[0])).toBe(true);
  });

  it("requires an exact dependency key", async () => {
    await expect(
      matchDependency(
        CONSUMER,
        dependencySignature("tasks.create"),
        [localProvider("local")],
      ),
    ).rejects.toBeInstanceOf(DependencyNotFoundError);
  });

  it("filters each concrete binding by the dependency and installed invokers", async () => {
    const iface = providerInterface(LOCAL_SPEC, {
      allowed: { source: "service", selector: "create" },
      unsupported: { source: "remote", selector: "create" },
      disallowed: { source: "other", selector: "create" },
    });
    iface.sources!.remote = {
      bindingSpec: REMOTE_SPEC,
      location: "https://tasks.example.test/remote",
    };
    iface.sources!.other = {
      bindingSpec: "example.disallowed@1",
      location: "https://tasks.example.test/other",
    };
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    handler.register({
      location: LOCAL_LOCATION,
      selector: "create",
      handler: handle => handle.closeOutput(),
    });

    const result = await matchDependency(CONSUMER, CREATION, [{
      interface: iface,
      invoker: new OperationInvoker([handler]),
    }]);

    expect(result.matches.map(match => match.bindingKey)).toEqual(["allowed"]);
    expect(result.assessments.map(item => item.reason)).toEqual(expect.arrayContaining([
      "binding specification is not allowed by the dependency",
      "provider invoker does not support the binding specification",
    ]));
    expect(result.assessments.map(item => item.code)).toEqual(expect.arrayContaining([
      "binding_spec_disallowed",
      "binding_spec_unsupported",
    ]));
  });

  it("reports schema-incompatible and unbound operations as declarations, not providers", async () => {
    const incompatible = providerInterface(LOCAL_SPEC);
    incompatible.operations.createTask!.output = { type: "integer" };
    const unbound = providerInterface(LOCAL_SPEC);
    delete unbound.bindings;
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    handler.register({
      location: LOCAL_LOCATION,
      selector: "create",
      handler: handle => handle.closeOutput(),
    });

    const result = await matchDependency(CONSUMER, CREATION, [
      { interface: incompatible, invoker: new OperationInvoker([handler]) },
      { interface: unbound, invoker: new OperationInvoker([handler]) },
    ]);

    expect(result.matches).toHaveLength(0);
    expect(result.assessments.some(item => item.issues.length > 0)).toBe(true);
    expect(result.assessments.some(
      item => item.reason === "compatible operation has no concrete binding",
    )).toBe(true);
  });

  it("returns one match per concrete binding and treats an equal top rank as ambiguous", async () => {
    const iface = providerInterface(LOCAL_SPEC, {
      first: { source: "service", selector: "first" },
      second: { source: "service", selector: "second" },
    });
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    for (const selector of ["first", "second"]) {
      handler.register<CreateInput, CreateOutput>({
        location: LOCAL_LOCATION,
        selector,
        handler: async handle => {
          for await (const input of handle.inputs()) {
            await handle.closeInput();
            await handle.emitOutput({ id: `${selector}:${input.title}` });
            handle.closeOutput();
            return;
          }
          handle.fireError(new InvocationError(ERR_RUNTIME));
        },
      });
    }
    const provider = { interface: iface, invoker: new OperationInvoker([handler]) };

    const matches = await matchDependency(CONSUMER, CREATION, [provider]);
    expect(matches.matches.map(match => match.bindingKey)).toEqual(["first", "second"]);
    const selected = matches.matches[1]!;
    const invocation = selected.invoke();
    await invocation.write({ title: "pinned" });
    await expect(single(invocation.outputs)).resolves.toEqual({ id: "second:pinned" });
    await expect(resolveDependency(CONSUMER, CREATION, [provider])).resolves.toMatchObject({
      status: "ambiguous",
    });
  });

  it("uses only application-owned provider preference to elect a unique route", async () => {
    const low = localProvider("low", { preference: 1 });
    const high = localProvider("high", { preference: 2 });
    const result = await resolveDependency(CONSUMER, CREATION, [low, high]);

    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.match.provider).toBe(high);
  });

  it("captures provider preference once instead of re-reading mutable policy", async () => {
    let reads = 0;
    const dynamic = localProvider("dynamic");
    Object.defineProperty(dynamic, "preference", {
      get() {
        reads++;
        return reads === 1 ? 2 : -100;
      },
    });
    const low = localProvider("low", { preference: 1 });

    const result = await resolveDependency(CONSUMER, CREATION, [low, dynamic]);

    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.match.provider).toBe(dynamic);
    expect(result.match.providerPreference).toBe(2);
    expect(reads).toBe(1);
  });

  it("retains an immutable executable provider snapshot after matching", async () => {
    const provider = localProvider("stable");
    const result = await resolveDependency(CONSUMER, CREATION, [provider]);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;

    provider.interface.bindings!["primary"]!.selector = "missing";
    provider.interface.sources!["service"]!.bindingSpec = "example.changed@9";
    provider.interface.operations.createTask!.output = { type: "integer" };

    const invocation = result.match.invoke();
    await invocation.write({ title: "draft" });
    await expect(single(invocation.outputs)).resolves.toEqual({ id: "stable:draft" });
  });

  it("classifies preparation failures and preserves invocation error data", async () => {
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    const provider: InterfaceProvider = {
      interface: providerInterface(LOCAL_SPEC),
      invoker: new OperationInvoker([handler]),
    };

    const result = await matchDependency(CONSUMER, CREATION, [provider]);

    expect(result.matches).toHaveLength(0);
    expect(result.assessments).toContainEqual(expect.objectContaining({
      code: "preparation_failed",
      bindingKey: "primary",
      failure: { code: ERR_SELECTOR_NOT_FOUND },
    }));
  });

  it("rejects malformed preparer details during matching", async () => {
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    handler.register({
      location: LOCAL_LOCATION,
      selector: "create",
      prepare: () => ({ target: LOCAL_LOCATION, alternatives: [] }),
      handler: handle => handle.closeOutput(),
    });
    const provider: InterfaceProvider = {
      interface: providerInterface(LOCAL_SPEC),
      invoker: new OperationInvoker([handler]),
    };

    const result = await matchDependency(CONSUMER, CREATION, [provider]);

    expect(result.matches).toHaveLength(0);
    expect(result.assessments).toContainEqual(expect.objectContaining({
      code: "preparation_failed",
      failure: { code: ERR_RUNTIME },
    }));
  });

  it("preflights and later invokes the same pinned binding", async () => {
    const requirements: ContextRequiredDetails = {
      target: LOCAL_LOCATION,
      alternatives: [{ requirements: [{ type: "config.value", point: "tenant", path: "" }] }],
    };
    const result = await resolveDependency(
      CONSUMER,
      CREATION,
      [localProvider("local", { requirements })],
    );

    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.match.knownContextRequirements).toEqual(requirements);
    await expect(result.match.prepare()).resolves.toEqual(requirements);
    expect(result.match.bindingKey).toBe("primary");
  });

  it("cancels dependency matching through preflight", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(matchDependency(
      CONSUMER,
      CREATION,
      [localProvider("local")],
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("in-process proof", () => {
  it("passes local values by reference without JSON serialization", async () => {
    let observed: CreateInput | undefined;
    const input = { title: "draft" };

    await expect(call(localProvider("local", { onInput: value => { observed = value; } }), input))
      .resolves.toEqual({ id: "local:draft" });
    expect(observed).toBe(input);
  });

  it("runs the same dependency-facing consumer code against local and transport-like providers", async () => {
    await expect(call(localProvider("local"), { title: "one" }))
      .resolves.toEqual({ id: "local:one" });
    await expect(call(remoteProvider("remote"), { title: "two" }))
      .resolves.toEqual({ id: "remote:two" });
  });

  it("makes handler registration exact, duplicate-safe, and reversible", async () => {
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    const unregister = handler.register({
      location: LOCAL_LOCATION,
      selector: "create",
      handler: handle => handle.closeOutput(),
    });
    expect(() => handler.register({
      location: LOCAL_LOCATION,
      selector: "create",
      handler: handle => handle.closeOutput(),
    })).toThrow(/already registered/);

    unregister();
    const invocation = handler.invokeBinding({
      source: { bindingSpec: LOCAL_SPEC, location: LOCAL_LOCATION },
      selector: "create",
    });
    await expect(invocation.closed).rejects.toMatchObject({ code: ERR_SELECTOR_NOT_FOUND });
  });

  it("maps synchronous handler failures and does not start an already-cancelled handler", async () => {
    let starts = 0;
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    handler.register({
      location: LOCAL_LOCATION,
      selector: "throws",
      handler: () => {
        starts += 1;
        throw new Error("private implementation detail");
      },
    });
    const failed = handler.invokeBinding({
      source: { bindingSpec: LOCAL_SPEC, location: LOCAL_LOCATION },
      selector: "throws",
    });
    await expect(failed.closed).rejects.toMatchObject({ code: ERR_RUNTIME });

    const controller = new AbortController();
    controller.abort();
    const cancelled = handler.invokeBinding({
      source: { bindingSpec: LOCAL_SPEC, location: LOCAL_LOCATION },
      selector: "throws",
      signal: controller.signal,
    });
    await expect(cancelled.closed).rejects.toMatchObject({ code: "ERR_CANCELLED" });
    expect(starts).toBe(1);
  });

  it("enforces handler preflight before application code runs", async () => {
    const requirements: ContextRequiredDetails = {
      target: LOCAL_LOCATION,
      alternatives: [{ requirements: [{ type: "config.value", point: "tenant", path: "" }] }],
    };
    let starts = 0;
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    handler.register({
      location: LOCAL_LOCATION,
      selector: "gated",
      prepare: args => args.context?.tenant ? null : requirements,
      handler: handle => {
        starts++;
        handle.closeOutput();
      },
    });

    const blocked = handler.invokeBinding({
      source: { bindingSpec: LOCAL_SPEC, location: LOCAL_LOCATION },
      selector: "gated",
    });
    await expect(blocked.closed).rejects.toMatchObject({
      code: CONTEXT_REQUIRED,
      data: requirements,
    });
    expect(starts).toBe(0);

    const allowed = handler.invokeBinding({
      source: { bindingSpec: LOCAL_SPEC, location: LOCAL_LOCATION },
      selector: "gated",
      context: { tenant: "acme" },
    });
    await expect(allowed.closed).resolves.toBeUndefined();
    expect(starts).toBe(1);
  });

  it("lets the operation resolver satisfy handler preflight before execution", async () => {
    const requirements: ContextRequiredDetails = {
      target: LOCAL_LOCATION,
      alternatives: [{ requirements: [{ type: "auth.bearer" }] }],
    };
    let starts = 0;
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    handler.register<CreateInput, CreateOutput>({
      location: LOCAL_LOCATION,
      selector: "create",
      prepare: args => args.context?.bearerToken ? null : requirements,
      handler: async handle => {
        starts++;
        for await (const input of handle.inputs()) {
          await handle.closeInput();
          await handle.emitOutput({ id: `resolved:${input.title}` });
          handle.closeOutput();
          return;
        }
      },
    });
    const invoker = new OperationInvoker([handler], {
      contextResolver: () => ({ bearerToken: "token" }),
    });

    const invocation = invoker.invoke(
      providerInterface(LOCAL_SPEC),
      { key: "createTask" },
      { bindingKey: "primary" },
    );
    await invocation.write({ title: "draft" });
    await expect(single(invocation.outputs)).resolves.toEqual({ id: "resolved:draft" });
    expect(starts).toBe(1);
  });

  it("does not enter a handler when cancellation wins during asynchronous preflight", async () => {
    let release: ((value: ContextRequiredDetails | null) => void) | undefined;
    let starts = 0;
    const pending = new Promise<ContextRequiredDetails | null>(resolve => {
      release = resolve;
    });
    const handler = new HandlerBindingInvoker({ bindingSpec: LOCAL_SPEC });
    handler.register({
      location: LOCAL_LOCATION,
      selector: "slow",
      prepare: () => pending,
      handler: handle => {
        starts++;
        handle.closeOutput();
      },
    });
    const controller = new AbortController();
    const invocation = handler.invokeBinding({
      source: { bindingSpec: LOCAL_SPEC, location: LOCAL_LOCATION },
      selector: "slow",
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();
    release?.(null);

    await expect(invocation.closed).rejects.toMatchObject({ code: ERR_CANCELLED });
    expect(starts).toBe(0);
  });
});
