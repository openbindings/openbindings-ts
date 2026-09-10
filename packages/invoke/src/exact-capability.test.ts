import { expect, it } from "vitest";
import { prepareInterface, type OBInterface } from "@openbindings/core";
import { parseJSON } from "@openbindings/json";
import { OperationInvoker } from "./operation-invoker.js";
import { operationSignature } from "./operation-signature.js";
import { HandlerBindingInvoker } from "./handler-binding-invoker.js";
import { single } from "./invocation.js";
import { DiagnosticCollector } from "./diagnostics.js";
import { ERR_RUNTIME } from "./errcodes.js";

for (const path of ["lazy", "prepared-direct", "prepared-pump"] as const) for (const position of ["input", "output"] as const) {
  it(`reports capability refusal, not invalid data, at ${path}/${position}`, async () => {
    const iface: OBInterface = {
      openbindings: "0.2.0",
      operations: {echo: {input: true, output: true, [position]: {minimum: 0}}},
      sources: {local: {bindingSpec: "example.local@1", location: "app://echo"}},
      bindings: {echo: {operation: "echo", source: "local", selector: "echo"}},
    };
    const binding = new HandlerBindingInvoker({bindingSpec: "example.local@1"});
    let emissions = 0;
    binding.register({location: "app://echo", selector: "echo", handler: async handle => {
      for await (const value of handle.inputs()) { await handle.closeInput(); emissions++; await handle.emitOutput(value); break; }
      handle.closeOutput();
    }});
    const engine = new OperationInvoker([binding], path === "prepared-pump" ? {contextResolver: () => null} : undefined);
    const signature = operationSignature("echo"), diagnostics = new DiagnosticCollector();
    const call = path === "lazy"
      ? engine.invoke(iface, signature, {diagnostics})
      : engine.compileOperationHandle(await prepareInterface(iface), signature).invoke({diagnostics});
    const terminal = call.closed.catch(error => error);
    const output = single(call.outputs).catch(error => error);
    try {
      const written = await call.write(parseJSON("1e100000000000000000000000000000000000000")).catch(error => error);
      if (position === "input") expect(written).toMatchObject({code: ERR_RUNTIME});
      else { expect(written).toBeUndefined(); expect(await output).toMatchObject({code: ERR_RUNTIME}); }
      expect(await terminal).toMatchObject({code: ERR_RUNTIME});
      expect(emissions).toBe(position === "output" ? 1 : 0);
      expect(diagnostics.snapshot().records).toHaveLength(0);
    } finally { await call.cancel(); }
  });
}
