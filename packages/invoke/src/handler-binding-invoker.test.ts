import { describe, expect, it } from "vitest";
import { HandlerBindingInvoker } from "./handler-binding-invoker.js";
import { single } from "./invocation.js";

describe("HandlerBindingInvoker deterministic closure", () => {
  it("pins the exact registration instead of consulting the mutable map per call", async () => {
    const invoker = new HandlerBindingInvoker({ bindingSpec: "example.local@1" });
    const remove = invoker.register<string, string>({
      location: "app://handlers",
      selector: "echo",
      async handler(handle) {
        for await (const input of handle.inputs()) {
          await handle.closeInput();
          await handle.emitOutput(input);
          handle.closeOutput();
          return;
        }
      },
    });
    const args = {
      source: { bindingSpec: "example.local@1", location: "app://handlers" },
      selector: "echo",
    };
    const compiled = invoker.compileBinding(args);
    remove();

    const invocation = compiled.invokeBinding<string, string>(args);
    await invocation.write("native");
    await expect(single(invocation.outputs)).resolves.toBe("native");

    const dynamic = invoker.invokeBinding<string, string>(args);
    await expect(single(dynamic.outputs)).rejects.toMatchObject({ code: "ERR_SELECTOR_NOT_FOUND" });
  });
});
