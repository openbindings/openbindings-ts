# @openbindings/invoke

The OpenBindings invocation layer: the binding-invoker and operation-invoker
pattern. Invocation handles, prepared providers, explicit composition policy,
named dependency routes, local native implementations, context, hooks, and
transitional operation-requirement compatibility APIs.

```ts
import { OperationInvoker, operationSignature } from "@openbindings/invoke";
```

The primary 0.2 composition path prepares documents once, then resolves an
OBI dependency to an immutable, SDK-identified route:

```ts
const consumer = await prepareInterface(componentOBI);
const provider = await prepareProvider({
  key: "tasks-api",
  interface: tasksOBI,
  runtime: tasksInvoker,
});
const session = new CompositionSession({
  consumer,
  providers: [{ provider, preference: 10 }],
});

const result = await session.resolve(DependencySignatures.creation);
if (result.status === "available") {
  // Live context is deliberately separate from static route closure.
  await result.route.preflight({ context: requestContext });
  const call = result.route.invoke({ context: requestContext });
  await call.write({ title: "Ship it" });
  const created = await single(call.outputs);
}
```

The versioned reference policy inspects provider preference tiers from highest
to lowest and stops once a tier can resolve; a slow lower-ranked provider
cannot delay the ordinary happy path. `session.inspect(...)` is the deliberate
exhaustive diagnostics path. Custom `CompositionPolicy` implementations make
this staging explicit with `providerInspectionGroups`, separate from provider
and realization selection.

For in-process implementations, register by OBI binding key; the local lane
uses the same verified route and ordinary invocation substrate, with native
values passed by reference:

```ts
const provider = await prepareLocalProvider({
  key: "local-tasks",
  interface: tasksOBI,
  implementations: {
    "tasks.create.local": localUnary(async input => ({
      id: await repository.create(input.title),
    })),
  },
});
```

`matchDependency`, `resolveDependency`, `PreparedOperation`, and the
operation-requirement APIs remain transitional compatibility surfaces while
the 0.2 draft is stabilized. New wiring should use `PreparedInterface`,
`PreparedProvider`, and `CompositionSession`.

Depends only on
[`@openbindings/core`](https://www.npmjs.com/package/@openbindings/core) and
[`@openbindings/compare`](https://www.npmjs.com/package/@openbindings/compare) —
no third-party runtime dependencies. Binding-spec invokers (for example
`@openbindings/openapi`) implement the interfaces published here;
[`@openbindings/sdk`](https://www.npmjs.com/package/@openbindings/sdk) is the
facade re-exporting this package alongside its siblings.

See the [OpenBindings documentation](https://openbindings.com) and the
[repository README](https://github.com/openbindings/openbindings-ts) for the
full picture.

## License

Apache-2.0
