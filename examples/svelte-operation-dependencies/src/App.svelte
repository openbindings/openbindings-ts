<script lang="ts">
  import {
    dependencySignatureFromOperation,
    operationSignature,
    type ProviderRegistration,
    type OBInterface,
  } from "@openbindings/sdk";
  import SvelteOperation from "./SvelteOperation.svelte";

  type Task = { id: string; title: string };

  const requiredInterface: OBInterface = {
    openbindings: "0.2.0",
    operations: {
      "example.tasks.list": {
        output: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
            },
            required: ["id", "title"],
          },
        },
      },
    },
    dependencies: {
      tasksList: { operation: "example.tasks.list" },
    },
  };

  const consumer = requiredInterface;
  const dependency = dependencySignatureFromOperation(
    "tasksList",
    operationSignature<never, Task[]>("example.tasks.list"),
  );

  // Application state: replace this array whenever available implementations
  // change. The component below has no protocol or delegate-manager surface.
  let providers = $state<readonly ProviderRegistration[]>([]);
</script>

<SvelteOperation {consumer} {dependency} {providers}>
  {#snippet children(operation)}
    <button disabled={operation.status !== "available"}>
      {operation.status === "available" ? "Load tasks" : operation.status}
    </button>
  {/snippet}
</SvelteOperation>
