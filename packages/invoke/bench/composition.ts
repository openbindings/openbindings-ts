import { performance } from "node:perf_hooks";
import process from "node:process";
import { prepareInterface } from "@openbindings/core";
import {
  CompositionSession,
  unsafeDependencySignature,
  OperationInvoker,
  operationSignature,
  prepareProvider,
  resolveDependency,
  single,
  type DependencyMatch,
  type InterfaceProvider,
  type Invocation,
  type PreparedOperation,
  type PreparedDependencyRoute,
  type PreparedProvider,
} from "../src/index.js";
import {
  createCompositionWorkload,
  type BenchmarkInput,
  type BenchmarkOutput,
  type CompositionWorkload,
} from "./composition-workload.js";

interface Distribution {
  readonly samples: number;
  readonly operationsPerSample: number;
  readonly p50Microseconds: number;
  readonly p95Microseconds: number;
  readonly p99Microseconds: number;
  readonly meanMicroseconds: number;
  readonly minMicroseconds: number;
  readonly maxMicroseconds: number;
}

interface BenchmarkResult extends Distribution {
  readonly name: string;
  readonly category: "floor" | "steady_state" | "cold" | "scale";
  readonly operationCount: number;
  readonly bindingsPerOperation: number;
}

interface RetentionResult {
  readonly name: string;
  readonly operationCount: number;
  readonly routes: number;
  readonly elapsedMilliseconds: number;
  readonly approximateHeapDeltaBytes: number;
  readonly gcAvailable: boolean;
}

interface Options {
  readonly json: boolean;
  readonly quick: boolean;
  readonly samples: number;
  readonly callsPerSample: number;
  readonly sizes: readonly number[];
}

function parsePositiveInt(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): Options {
  let json = false;
  let quick = false;
  let samples = 21;
  let callsPerSample = 100;
  let sizes: readonly number[] = [1, 10, 100, 1_000, 5_000];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--quick") {
      quick = true;
      samples = 9;
      callsPerSample = 25;
      sizes = [1, 10, 1_000];
    } else if (arg === "--samples") {
      samples = parsePositiveInt(argv[++index], "samples");
    } else if (arg === "--calls") {
      callsPerSample = parsePositiveInt(argv[++index], "calls");
    } else if (arg === "--sizes") {
      const raw = argv[++index];
      if (!raw) throw new TypeError("sizes requires a comma-separated value");
      sizes = raw.split(",").map(value => parsePositiveInt(value, "size"));
    } else {
      throw new TypeError(`unknown argument: ${arg}`);
    }
  }
  return { json, quick, samples, callsPerSample, sizes };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index]!;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function summarize(samples: readonly number[], operationsPerSample: number): Distribution {
  const microseconds = samples
    .map(milliseconds => milliseconds * 1_000 / operationsPerSample)
    .sort((a, b) => a - b);
  const mean = microseconds.reduce((sum, value) => sum + value, 0) / microseconds.length;
  return {
    samples: microseconds.length,
    operationsPerSample,
    p50Microseconds: round(percentile(microseconds, 0.5)),
    p95Microseconds: round(percentile(microseconds, 0.95)),
    p99Microseconds: round(percentile(microseconds, 0.99)),
    meanMicroseconds: round(mean),
    minMicroseconds: round(microseconds[0]!),
    maxMicroseconds: round(microseconds.at(-1)!),
  };
}

async function measure(
  name: string,
  category: BenchmarkResult["category"],
  workload: CompositionWorkload,
  samples: number,
  operationsPerSample: number,
  operation: () => Promise<void>,
  warmupCount = Math.min(5, samples),
): Promise<BenchmarkResult> {
  for (let index = 0; index < warmupCount; index++) await operation();

  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let call = 0; call < operationsPerSample; call++) await operation();
    durations.push(performance.now() - start);
  }
  return {
    name,
    category,
    operationCount: workload.operationCount,
    bindingsPerOperation: workload.bindingsPerOperation,
    ...summarize(durations, operationsPerSample),
  };
}

async function prepareSuccessor(
  workload: CompositionWorkload,
  key = "benchmark-provider",
): Promise<{
  consumer: Awaited<ReturnType<typeof prepareInterface>>;
  provider: PreparedProvider;
  session: CompositionSession;
}> {
  const [consumer, provider] = await Promise.all([
    prepareInterface(workload.consumer),
    prepareProvider({ key, interface: workload.provider, runtime: workload.invoker }),
  ]);
  return {
    consumer,
    provider,
    session: new CompositionSession({ consumer, providers: [{ provider }] }),
  };
}

async function invokeOne(
  factory: () => Invocation<BenchmarkInput, BenchmarkOutput>,
  input: BenchmarkInput,
): Promise<void> {
  const invocation = factory();
  await invocation.write(input);
  await single(invocation.outputs);
}

function forceGC(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return false;
  gc();
  return true;
}

async function retainedPreparedRoutes(operationCount: number): Promise<RetentionResult> {
  const workload = createCompositionWorkload(operationCount);
  const gcAvailable = forceGC();
  const before = process.memoryUsage().heapUsed;
  const routes: PreparedOperation<BenchmarkInput, BenchmarkOutput>[] = [];
  const start = performance.now();
  for (let index = 0; index < operationCount; index++) {
    routes.push(await workload.invoker.prepareOperationHandle(
      workload.provider,
      operationSignature<BenchmarkInput, BenchmarkOutput>(
        workload.providerOperationKeys[index]!,
      ),
      { bindingKey: workload.bindingKeys[index]! },
    ));
  }
  const elapsedMilliseconds = performance.now() - start;
  forceGC();
  const after = process.memoryUsage().heapUsed;
  // Keep routes observably alive through the measurement.
  if (routes.length !== operationCount) throw new Error("retained route mismatch");
  return {
    name: "prepared.retain_all_routes",
    operationCount,
    routes: routes.length,
    elapsedMilliseconds: round(elapsedMilliseconds),
    approximateHeapDeltaBytes: after - before,
    gcAvailable,
  };
}

async function retainedDependencyRoutes(operationCount: number): Promise<RetentionResult> {
  const workload = createCompositionWorkload(operationCount);
  const successor = await prepareSuccessor(workload);
  const gcAvailable = forceGC();
  const before = process.memoryUsage().heapUsed;
  const routes: PreparedDependencyRoute<BenchmarkInput, BenchmarkOutput>[] = [];
  const start = performance.now();
  for (const key of workload.dependencyKeys) {
    const result = await successor.session.resolve<BenchmarkInput, BenchmarkOutput>(key);
    if (result.status !== "available") {
      throw new Error(`dependency ${key} did not resolve: ${result.status}`);
    }
    routes.push(result.route);
  }
  const elapsedMilliseconds = performance.now() - start;
  forceGC();
  const after = process.memoryUsage().heapUsed;
  if (routes.length !== operationCount) throw new Error("retained dependency route mismatch");
  return {
    name: "composition_v2.retain_all_routes",
    operationCount,
    routes: routes.length,
    elapsedMilliseconds: round(elapsedMilliseconds),
    approximateHeapDeltaBytes: after - before,
    gcAvailable,
  };
}

async function run(options: Options): Promise<{
  metadata: Record<string, unknown>;
  results: BenchmarkResult[];
  retention: RetentionResult[];
}> {
  const results: BenchmarkResult[] = [];
  const input: BenchmarkInput = { id: "bench-1", payload: "x".repeat(32) };
  const hot = createCompositionWorkload(1);
  const providerOperation = hot.providerOperationKeys[0]!;
  const bindingKey = hot.bindingKeys[0]!;
  const prepared = await hot.invoker.prepareOperationHandle(
    hot.provider,
    operationSignature<BenchmarkInput, BenchmarkOutput>(providerOperation),
    { bindingKey },
  );
  const resolution = await resolveDependency(
    hot.consumer,
    unsafeDependencySignature<BenchmarkInput, BenchmarkOutput>(hot.dependencyKeys[0]!),
    [hot.candidate],
  );
  if (resolution.status !== "available") {
    throw new Error(`hot dependency did not resolve: ${resolution.status}`);
  }
  const matched: DependencyMatch<BenchmarkInput, BenchmarkOutput> = resolution.match;
  const hotSuccessor = await prepareSuccessor(hot);
  const compiled = hot.invoker.compileOperationHandle<BenchmarkInput, BenchmarkOutput>(
    hotSuccessor.provider.interface,
    operationSignature(providerOperation),
    { bindingKey },
  );
  const successorResolution = await hotSuccessor.session.resolve<BenchmarkInput, BenchmarkOutput>(
    hot.dependencyKeys[0]!,
  );
  if (successorResolution.status !== "available") {
    throw new Error(`hot successor dependency did not resolve: ${successorResolution.status}`);
  }
  const directRealization = hotSuccessor.provider.closeRealization<BenchmarkInput, BenchmarkOutput>(
    bindingKey,
  );

  results.push(await measure(
    "raw.async_handler_floor",
    "floor",
    hot,
    options.samples,
    options.callsPerSample,
    async () => {
      await Promise.resolve({ id: input.id, accepted: true });
    },
  ));
  results.push(await measure(
    "invocation.compiled_direct_v2",
    "steady_state",
    hot,
    options.samples,
    options.callsPerSample,
    () => invokeOne(() => compiled.invoke(), input),
  ));
  results.push(await measure(
    "invocation.prepared_dependency_route_v2",
    "steady_state",
    hot,
    options.samples,
    options.callsPerSample,
    () => invokeOne(() => successorResolution.route.invoke(), input),
  ));
  results.push(await measure(
    "invocation.prepared_realization_direct_v2",
    "steady_state",
    hot,
    options.samples,
    options.callsPerSample,
    () => invokeOne(() => directRealization.invoke(), input),
  ));
  results.push(await measure(
    "invocation.ordinary_exact_binding",
    "steady_state",
    hot,
    options.samples,
    options.callsPerSample,
    () => invokeOne(
      () => hot.invoker.invoke(
        hot.provider,
        operationSignature<BenchmarkInput, BenchmarkOutput>(providerOperation),
        { bindingKey },
      ),
      input,
    ),
  ));
  results.push(await measure(
    "invocation.prepared_direct",
    "steady_state",
    hot,
    options.samples,
    options.callsPerSample,
    () => invokeOne(() => prepared.invoke(), input),
  ));
  results.push(await measure(
    "invocation.prepared_via_dependency_match",
    "steady_state",
    hot,
    options.samples,
    options.callsPerSample,
    () => invokeOne(() => matched.invoke(), input),
  ));

  for (const size of options.sizes) {
    const workload = createCompositionWorkload(size);
    const target = size - 1;
    results.push(await measure(
      "interface.prepare_single_v2",
      "cold",
      workload,
      options.quick ? 5 : Math.max(21, options.samples),
      1,
      async () => {
        await prepareInterface(workload.provider);
      },
      0,
    ));
    const catalogInterface = await prepareInterface(workload.provider);
    results.push(await measure(
      "provider.prepare_catalog_v2",
      "cold",
      workload,
      options.quick ? 3 : 7,
      1,
      async () => {
        const provider = await prepareProvider({
          key: `catalog-${size}`,
          interface: catalogInterface,
          runtime: workload.invoker,
        });
        await provider.dispose();
      },
      0,
    ));
    results.push(await measure(
      "interface.prepare_provider_pair_v2",
      "cold",
      workload,
      options.quick ? 2 : 5,
      1,
      async () => {
        await prepareSuccessor(workload, `cold-${size}`);
      },
      0,
    ));
    const successor = await prepareSuccessor(workload, `warm-${size}`);
    const coldSampleCount = options.quick ? 3 : 7;
    const coldSessions = await Promise.all(Array.from(
      { length: coldSampleCount },
      (_, index) => prepareSuccessor(workload, `cold-route-${size}-${index}`),
    ));
    let coldSessionIndex = 0;
    results.push(await measure(
      "composition.prepared_first_dependency_v2",
      "scale",
      workload,
      coldSampleCount,
      1,
      async () => {
        const result = await coldSessions[coldSessionIndex++]!.session.resolve(
          workload.dependencyKeys[target]!,
        );
        if (result.status !== "available") {
          throw new Error(`prepared dependency did not resolve at size ${size}: ${result.status}`);
        }
      },
      0,
    ));
    const warmResult = await successor.session.resolve(workload.dependencyKeys[target]!);
    if (warmResult.status !== "available") throw new Error(`warm dependency: ${warmResult.status}`);
    results.push(await measure(
      "composition.prepared_warm_dependency_v2",
      "scale",
      workload,
      options.samples,
      options.callsPerSample,
      async () => {
        const result = await successor.session.resolve(workload.dependencyKeys[target]!);
        if (result.status !== "available") throw new Error(`warm dependency: ${result.status}`);
      },
    ));
    results.push(await measure(
      "prepared.cold_exact_route",
      "cold",
      workload,
      options.quick ? 3 : 7,
      1,
      async () => {
        await workload.invoker.prepareOperationHandle(
          successor.provider.interface,
          operationSignature<BenchmarkInput, BenchmarkOutput>(
            workload.providerOperationKeys[target]!,
          ),
          { bindingKey: workload.bindingKeys[target]! },
        );
      },
    ));
    results.push(await measure(
      "composition.cold_one_dependency",
      "scale",
      workload,
      options.quick ? 3 : 7,
      1,
      async () => {
        const result = await resolveDependency(
          workload.consumer,
          unsafeDependencySignature<BenchmarkInput, BenchmarkOutput>(
            workload.dependencyKeys[target]!,
          ),
          [workload.candidate],
        );
        if (result.status !== "available") {
          throw new Error(`dependency did not resolve at size ${size}: ${result.status}`);
        }
      },
    ));

    if (size <= 100) {
      results.push(await measure(
        "composition.cold_all_dependencies",
        "scale",
        workload,
        options.quick ? 2 : 5,
        1,
        async () => {
          for (const dependencyKey of workload.dependencyKeys) {
            const result = await resolveDependency(
              workload.consumer,
              unsafeDependencySignature<BenchmarkInput, BenchmarkOutput>(dependencyKey),
              [workload.candidate],
            );
            if (result.status !== "available") {
              throw new Error(`dependency ${dependencyKey} did not resolve: ${result.status}`);
            }
          }
        },
      ));
      const allDependencySampleCount = options.quick ? 3 : 7;
      const allDependencySessions = await Promise.all(Array.from(
        { length: allDependencySampleCount },
        (_, index) => prepareSuccessor(workload, `cold-all-${size}-${index}`),
      ));
      let allDependencySessionIndex = 0;
      results.push(await measure(
        "composition.prepared_cold_all_dependencies_v2",
        "scale",
        workload,
        allDependencySampleCount,
        1,
        async () => {
          const cold = allDependencySessions[allDependencySessionIndex++]!;
          for (const dependencyKey of workload.dependencyKeys) {
            const result = await cold.session.resolve(dependencyKey);
            if (result.status !== "available") {
              throw new Error(`prepared dependency ${dependencyKey} did not resolve: ${result.status}`);
            }
          }
        },
        0,
      ));
      for (const dependencyKey of workload.dependencyKeys) {
        const result = await successor.session.resolve(dependencyKey);
        if (result.status !== "available") {
          throw new Error(`warm-all dependency ${dependencyKey}: ${result.status}`);
        }
      }
      results.push(await measure(
        "composition.prepared_warm_all_dependencies_v2",
        "scale",
        workload,
        options.samples,
        1,
        async () => {
          for (const dependencyKey of workload.dependencyKeys) {
            const result = await successor.session.resolve(dependencyKey);
            if (result.status !== "available") {
              throw new Error(`warm-all dependency ${dependencyKey}: ${result.status}`);
            }
          }
        },
      ));
    }
  }

  const multi = createCompositionWorkload(1, 10);
  results.push(await measure(
    "composition.one_provider_ten_bindings",
    "scale",
    multi,
    options.quick ? 3 : 7,
    1,
    async () => {
      const result = await resolveDependency(
        multi.consumer,
        unsafeDependencySignature<BenchmarkInput, BenchmarkOutput>(multi.dependencyKeys[0]!),
        [multi.candidate],
      );
      if (result.status !== "ambiguous") {
        throw new Error(`expected current first-proof ambiguity, got ${result.status}`);
      }
    },
  ));
  const preparedMulti = await prepareSuccessor(multi, "multi-provider");
  const preparedMultiWarm = await preparedMulti.session.resolve(multi.dependencyKeys[0]!);
  if (preparedMultiWarm.status !== "ambiguous") {
    throw new Error(`expected prepared realization ambiguity, got ${preparedMultiWarm.status}`);
  }
  results.push(await measure(
    "composition.prepared_one_provider_ten_bindings_v2",
    "scale",
    multi,
    options.samples,
    options.callsPerSample,
    async () => {
      const result = await preparedMulti.session.resolve(multi.dependencyKeys[0]!);
      if (result.status !== "ambiguous") {
        throw new Error(`expected prepared realization ambiguity, got ${result.status}`);
      }
    },
  ));

  const providerWorkloads = Array.from(
    { length: 10 },
    () => createCompositionWorkload(1),
  );
  const providerCandidates: InterfaceProvider[] = providerWorkloads.map(
    (workload, index) => ({
      ...workload.candidate,
      label: `provider-${index}`,
      preference: index,
    }),
  );
  results.push(await measure(
    "composition.ten_providers_unique_top_preference",
    "scale",
    hot,
    options.quick ? 3 : 7,
    1,
    async () => {
      const result = await resolveDependency(
        hot.consumer,
        unsafeDependencySignature<BenchmarkInput, BenchmarkOutput>(hot.dependencyKeys[0]!),
        providerCandidates,
      );
      if (result.status !== "available" || result.match.providerPreference !== 9) {
        throw new Error(`expected unique highest provider, got ${result.status}`);
      }
    },
  ));
  const preparedProviderCandidates = await Promise.all(providerWorkloads.map(
    (workload, index) => prepareProvider({
      key: `prepared-provider-${index}`,
      interface: workload.provider,
      runtime: workload.invoker,
    }),
  ));
  const preparedProviderSession = new CompositionSession({
    consumer: hotSuccessor.consumer,
    providers: preparedProviderCandidates.map((provider, index) => ({
      provider,
      preference: index,
    })),
  });
  const preparedProviderWarm = await preparedProviderSession.resolve(hot.dependencyKeys[0]!);
  if (preparedProviderWarm.status !== "available" || preparedProviderWarm.route.providerKey !== "prepared-provider-9") {
    throw new Error(`expected prepared unique highest provider, got ${preparedProviderWarm.status}`);
  }
  results.push(await measure(
    "composition.prepared_ten_providers_unique_top_v2",
    "scale",
    hot,
    options.samples,
    options.callsPerSample,
    async () => {
      const result = await preparedProviderSession.resolve(hot.dependencyKeys[0]!);
      if (result.status !== "available" || result.route.providerKey !== "prepared-provider-9") {
        throw new Error(`expected prepared unique highest provider, got ${result.status}`);
      }
    },
  ));

  const unsupportedCandidates: InterfaceProvider[] = providerWorkloads.map(
    (workload, index) => ({
      interface: workload.provider,
      invoker: new OperationInvoker([]),
      label: `unsupported-${index}`,
    }),
  );
  results.push(await measure(
    "composition.ten_unsupported_providers",
    "scale",
    hot,
    options.quick ? 3 : 7,
    1,
    async () => {
      const result = await resolveDependency(
        hot.consumer,
        unsafeDependencySignature<BenchmarkInput, BenchmarkOutput>(hot.dependencyKeys[0]!),
        unsupportedCandidates,
      );
      if (result.status !== "unavailable") {
        throw new Error(`expected unavailable providers, got ${result.status}`);
      }
    },
  ));
  const preparedUnsupportedProviders = await Promise.all(providerWorkloads.map(
    (workload, index) => prepareProvider({
      key: `prepared-unsupported-${index}`,
      interface: workload.provider,
      runtime: new OperationInvoker([]),
    }),
  ));
  const preparedUnsupportedSession = new CompositionSession({
    consumer: hotSuccessor.consumer,
    providers: preparedUnsupportedProviders.map(provider => ({ provider })),
  });
  results.push(await measure(
    "composition.prepared_ten_unsupported_v2",
    "scale",
    hot,
    options.samples,
    options.callsPerSample,
    async () => {
      const result = await preparedUnsupportedSession.resolve(hot.dependencyKeys[0]!);
      if (result.status !== "unavailable") {
        throw new Error(`expected prepared unavailable providers, got ${result.status}`);
      }
    },
  ));

  const retention: RetentionResult[] = [];
  for (const size of options.quick ? [1, 10] : [1, 10, 100]) {
    retention.push(await retainedPreparedRoutes(size));
    retention.push(await retainedDependencyRoutes(size));
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
      mode: options.quick ? "quick" : "default",
      samples: options.samples,
      callsPerSample: options.callsPerSample,
      sizes: options.sizes,
      warning: "Local machine evidence; compare equivalent-semantics rows and rerun before changing budgets.",
    },
    results,
    retention,
  };
}

function printHuman(report: Awaited<ReturnType<typeof run>>): void {
  console.log(JSON.stringify(report.metadata, null, 2));
  console.table(report.results.map(result => ({
    name: result.name,
    operations: result.operationCount,
    bindings: result.bindingsPerOperation,
    p50_us: result.p50Microseconds,
    p95_us: result.p95Microseconds,
    mean_us: result.meanMicroseconds,
  })));
  console.table(report.retention.map(result => ({
    name: result.name,
    operations: result.operationCount,
    routes: result.routes,
    elapsed_ms: result.elapsedMilliseconds,
    heap_delta_bytes: result.approximateHeapDeltaBytes,
    gc: result.gcAvailable,
  })));
}

const options = parseArgs(process.argv.slice(2));
const report = await run(options);
if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}
