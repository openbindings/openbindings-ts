# @openbindings/workers-rpc

Cloudflare Workers RPC binding invoker for OpenBindings. Dispatches operation calls from one Worker to a sibling Worker exposing a `WorkerEntrypoint` class via a service binding declared in `wrangler.toml`.

## Install

```bash
npm install @openbindings/workers-rpc
```

## What it does

Workers RPC is Cloudflare's mechanism for one Worker to call exported methods on another Worker without going through HTTP. Each method on a `WorkerEntrypoint` class is callable as a property on the bound service stub (`env.MY_SERVICE.someMethod(arg)`), with structured-clone serialization across the boundary.

This package wraps that mechanism as a `BindingInvoker`. The dispatch is local to the Cloudflare runtime — there's no network leg, no JSON envelope, no auth header dance. The Cloudflare runtime is the trust boundary; only Workers with the binding declared in their wrangler.toml `[[services]]` block can reach the target.

## Usage

The invoker is constructed per-request because `env` is request-scoped on Workers:

```typescript
import { OperationInvoker } from "@openbindings/sdk";
import { WorkersRpcInvoker } from "@openbindings/workers-rpc";
import { MyServiceInvoker } from "./generated/my-service-invoker.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const operationInvoker = new OperationInvoker([
      new WorkersRpcInvoker({ binding: env.MY_SERVICE }),
    ]);
    const myService = new MyServiceInvoker(operationInvoker);

    // For workers-rpc the OBI is embedded in the codegen output as
    // `MyServiceInvoker.CONTRACT` — there is no remote /.well-known endpoint.
    const result = await myService.someMethod(MyServiceInvoker.CONTRACT, { foo: "bar" });
    return Response.json(result);
  },
};
```

## Conventions

- **Format token**: `workers-rpc@^1.0.0`
- **Source `location`**: symbolic `workers-rpc://<service-name>`. There's no network dispatch; the URL exists only to identify the source. Any URL works as long as the format token matches.
- **Binding `ref`**: the literal method name on the target `WorkerEntrypoint` class.
- **Source `content`**: not used. Methods are discovered at runtime by property lookup on the binding object.

## Source shape

```json
{
  "sources": {
    "auth": {
      "format": "workers-rpc@^1.0.0",
      "location": "workers-rpc://auth-service"
    }
  },
  "bindings": {
    "mintToken.auth": {
      "operation": "mintToken",
      "source": "auth",
      "ref": "mintToken"
    }
  }
}
```

`workers-rpc://` is a convention indicating a non-HTTP source whose OBI is embedded in the codegen output rather than fetched from `/.well-known/openbindings`. Callers pass `<Name>Invoker.CONTRACT` (the embedded OBI) to typed-invoker methods directly.

## Error model

Errors thrown by the target Worker's RPC method propagate across the binding boundary as `Error` instances (the structured-clone algorithm preserves `name` and `message`). The invoker catches them and yields an `InvocationOutput` with `error.code = "execution_failed"` and ends the stream. Custom error subclasses are flattened to the base `Error` shape — if the target wants to communicate structured error info, return a discriminated-union result type from the method instead of throwing.

`durationMs` is populated on every event (success and error) for observability.

## Streaming

Workers RPC supports streaming via async iterables, but this invoker currently treats every method as unary (one yield per call). Streaming support could be added later by detecting iterable returns and yielding multiple events. File an issue if you need it.

## Trust model

There's no auth handshake. The Cloudflare runtime is the trust boundary — only Workers that have the binding declared in their wrangler.toml `[[services]]` block can reach the target. Don't expose a `WorkerEntrypoint` method that you wouldn't want every other Worker in your account to be able to call.

## How it works

1. The invoker receives a `BindingInvocationInput` with a `workers-rpc` source.
2. It looks up `input.ref` as a property on the bound service stub.
3. If the lookup yields a function, the invoker calls it with `input.input` as the single argument.
4. The return value is yielded as `InvocationOutput.output`. Errors thrown by the method are caught and yielded as `error.code = "execution_failed"`.

Method invocation uses plain property access (`this.binding[methodName](...)`) rather than `Function.prototype.call`. Cloudflare's ServiceStub Proxy returns a dispatch function with the stub captured in a closure; `.call(stub, ...)` makes the runtime try to serialize the stub itself, which fails because ServiceStubs are intentionally non-serializable.

## License

Apache-2.0
