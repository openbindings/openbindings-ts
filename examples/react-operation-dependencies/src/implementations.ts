import {
  InvocationImpl,
  OperationInvoker,
  checkBindingSpecs,
  type BindingInvocationArgs,
  type BindingInvoker,
  type BindingSpecInfo,
  type Invocation,
  type OBInterface,
  type OperationImplementation,
} from "@openbindings/sdk";
import { OpenAPIInvoker, OpenAPISynthesizer } from "@openbindings/openapi";
import { TASK_REQUIREMENTS, type Activity } from "./contracts.js";

const LOCAL_ACTIVITY_BINDING = "example.local-activity@1";
const SLOW_BINDING = "example.slow-preflight@1";

export async function tasksImplementation(
  label = "primary-api",
  preference = 0,
): Promise<OperationImplementation> {
  const artifact = {
    openapi: "3.1.0",
    info: { title: "Task fixture", version: "1.0.0" },
    servers: [{ url: window.location.origin }],
    paths: {
      "/api/tasks": {
        get: {
          operationId: "example.tasks.list",
          responses: {
            "200": {
              description: "Tasks",
              content: {
                "application/json": {
                  schema:
                    TASK_REQUIREMENTS.operations["example.tasks.list"]?.output,
                },
              },
            },
          },
        },
        post: {
          operationId: "example.tasks.create",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema:
                  TASK_REQUIREMENTS.operations["example.tasks.create"]?.input,
              },
            },
          },
          responses: {
            "201": {
              description: "Created task",
              content: {
                "application/json": {
                  schema:
                    TASK_REQUIREMENTS.operations["example.tasks.create"]
                      ?.output,
                },
              },
            },
          },
        },
      },
    },
  };
  const iface = await new OpenAPISynthesizer().synthesizeInterface({
    sources: [
      {
        bindingSpec: "openbindings.openapi-3.1@1",
        content: artifact,
      },
    ],
  });
  return {
    interface: iface,
    invoker: new OperationInvoker([new OpenAPIInvoker()]),
    label,
    preference,
  };
}

class ActivityBinding implements BindingInvoker {
  constructor(private readonly onCancelled: () => void) {}

  checkBindingSpecs(bindingSpecs: readonly string[]) {
    return checkBindingSpecs(bindingSpecs, this.bindingSpecs());
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: LOCAL_ACTIVITY_BINDING }];
  }

  prepareBinding(): Promise<null> {
    return Promise.resolve(null);
  }

  invokeBinding<I = unknown, O = unknown>(
    args: BindingInvocationArgs,
  ): Invocation<I, O> {
    const invocation = new InvocationImpl<unknown, Activity>({
      signal: args.signal,
    });
    let completed = false;
    invocation.signal.addEventListener(
      "abort",
      () => {
        if (!completed) {
          this.onCancelled();
        }
      },
      { once: true },
    );
    queueMicrotask(() => {
      void (async () => {
        await invocation.closeInput();
        for (let sequence = 1; sequence <= 3; sequence++) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (invocation.signal.aborted) return;
          await invocation.emitOutput({
            sequence,
            message: `activity ${sequence}`,
          });
        }
        completed = true;
        invocation.closeOutput();
      })();
    });
    return invocation as Invocation<I, O>;
  }
}

export function activityImplementation(
  onCancelled: () => void,
): OperationImplementation {
  const iface: OBInterface = {
    openbindings: "0.2.0",
    operations: {
      watchLocalActivity: {
        aliases: ["example.activity.watch"],
        output: TASK_REQUIREMENTS.operations["example.activity.watch"]?.output,
      },
    },
    sources: {
      local: { bindingSpec: LOCAL_ACTIVITY_BINDING },
    },
    bindings: {
      watch: {
        operation: "watchLocalActivity",
        source: "local",
      },
    },
  };
  return {
    interface: iface,
    invoker: new OperationInvoker([new ActivityBinding(onCancelled)]),
    label: "local-activity",
  };
}

class SlowPreflightBinding implements BindingInvoker {
  checkBindingSpecs(bindingSpecs: readonly string[]) {
    return checkBindingSpecs(bindingSpecs, this.bindingSpecs());
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: SLOW_BINDING }];
  }

  prepareBinding(args: BindingInvocationArgs): Promise<null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), 350);
      args.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(
            args.signal?.reason instanceof Error
              ? args.signal.reason
              : new DOMException("preflight cancelled", "AbortError"),
          );
        },
        { once: true },
      );
    });
  }

  invokeBinding(): never {
    throw new Error("slow preflight fixture must never invoke");
  }
}

export function slowImplementation(): OperationImplementation {
  const iface: OBInterface = {
    openbindings: "0.2.0",
    operations: {
      slowList: {
        aliases: ["example.tasks.list"],
        output: TASK_REQUIREMENTS.operations["example.tasks.list"]?.output,
      },
      slowCreate: {
        aliases: ["example.tasks.create"],
        input: TASK_REQUIREMENTS.operations["example.tasks.create"]?.input,
        output: TASK_REQUIREMENTS.operations["example.tasks.create"]?.output,
      },
    },
    sources: {
      slow: { bindingSpec: SLOW_BINDING },
    },
    bindings: {
      list: { operation: "slowList", source: "slow" },
      create: { operation: "slowCreate", source: "slow" },
    },
  };
  return {
    interface: iface,
    invoker: new OperationInvoker([new SlowPreflightBinding()]),
    label: "slow-candidate",
  };
}
