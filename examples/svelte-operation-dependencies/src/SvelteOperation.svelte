<script
  lang="ts"
  generics="I = unknown, O = unknown"
>
  import {
    CompositionSession,
    prepareInterface,
    type DependencyRouteResolution,
    type DependencySignature,
    type Invocation,
    type InvokeOptions,
    type PreparedDependencyRoute,
    type PreparedInterface,
    type OBInterface,
    type ProviderRegistration,
  } from "@openbindings/sdk";
  import { onDestroy, type Snippet } from "svelte";

  type Available = {
    status: "available";
    route: PreparedDependencyRoute<I, O>;
    invoke(options?: InvokeOptions): Invocation<I, O>;
  };

  type State =
    | { status: "resolving" }
    | Available
    | Extract<DependencyRouteResolution<I, O>, { status: "ambiguous" }>
    | Extract<DependencyRouteResolution<I, O>, { status: "unavailable" }>
    | { status: "failed"; error: Error };

  let {
    consumer,
    dependency,
    providers,
    children,
  }: {
    consumer: OBInterface | PreparedInterface;
    dependency: DependencySignature<I, O>;
    providers: readonly ProviderRegistration[];
    children: Snippet<[State]>;
  } = $props();

  let state = $state<State>({ status: "resolving" });
  let current: DependencyRouteResolution<I, O> | null = null;
  let generation = 0;
  const active = new Set<Invocation<I, O>>();

  $effect(() => {
    const candidates = providers;
    const controller = new AbortController();
    const thisGeneration = ++generation;
    current = null;
    state = { status: "resolving" };

    void prepareInterface(consumer).then(prepared => {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const session = new CompositionSession({
        consumer: prepared,
        providers: candidates,
      });
      return session.resolve(dependency, { signal: controller.signal });
    }).then(
      next => {
        if (controller.signal.aborted || generation !== thisGeneration) return;
        current = next;
        state = next.status === "available"
          ? { ...next, invoke }
          : next;
      },
      error => {
        if (controller.signal.aborted || generation !== thisGeneration) return;
        state = {
          status: "failed",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      },
    );

    return () => {
      controller.abort(
        new DOMException("providers changed", "AbortError"),
      );
      for (const invocation of active) void invocation.cancel();
      active.clear();
    };
  });

  onDestroy(() => {
    for (const invocation of active) void invocation.cancel();
    active.clear();
  });

  function invoke(options?: InvokeOptions): Invocation<I, O> {
    if (current?.status !== "available") {
      throw new Error("operation is not available");
    }
    const invocation = current.route.invoke(options);
    active.add(invocation);
    const forget = () => active.delete(invocation);
    void invocation.closed.then(forget, forget);
    return invocation;
  }
</script>

{@render children(state)}
