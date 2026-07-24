<script
  lang="ts"
  generics="I = unknown, O = unknown"
>
  import {
    resolveOperationRequirement,
    type Invocation,
    type InvokeOptions,
    type OperationImplementation,
    type OperationMatch,
    type OperationRequirement,
    type OperationRequirementResolution,
  } from "@openbindings/sdk";
  import { onDestroy, type Snippet } from "svelte";

  type Available = {
    status: "available";
    match: OperationMatch<I, O>;
    invoke(options?: InvokeOptions): Invocation<I, O>;
  };

  type State =
    | { status: "resolving" }
    | Available
    | Extract<OperationRequirementResolution<I, O>, { status: "ambiguous" }>
    | Extract<OperationRequirementResolution<I, O>, { status: "unavailable" }>
    | { status: "failed"; error: Error };

  let {
    requirement,
    implementations,
    children,
  }: {
    requirement: OperationRequirement<I, O>;
    implementations: readonly OperationImplementation[];
    children: Snippet<[State]>;
  } = $props();

  let state = $state<State>({ status: "resolving" });
  let current: OperationRequirementResolution<I, O> | null = null;
  let generation = 0;
  const active = new Set<Invocation<I, O>>();

  $effect(() => {
    const candidates = implementations;
    const controller = new AbortController();
    const thisGeneration = ++generation;
    current = null;
    state = { status: "resolving" };

    void resolveOperationRequirement(requirement, candidates, {
      signal: controller.signal,
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
        new DOMException("operation candidates changed", "AbortError"),
      );
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
    const invocation = current.match.invoke(options);
    active.add(invocation);
    const forget = () => active.delete(invocation);
    void invocation.closed.then(forget, forget);
    return invocation;
  }
</script>

{@render children(state)}
