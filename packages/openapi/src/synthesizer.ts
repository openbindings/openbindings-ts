import {
  checkBindingSpecs as checkBindingSpecSupport,
  type BindingEntry,
  type BindingSpecInfo,
  type BindingSpecVerdict,
  type OBInterface,
  type Source,
} from "@openbindings/core";
import {
  MultipleSourcesError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  type CoverageSynthesizer,
  type InterfaceSynthesizer,
  type SourceInspection,
  type SourceInspector,
  type SynthesizeInput,
  type SynthesizeSource,
  type SynthesizeResult,
  type SynthesisCoverageEntry,
} from "@openbindings/synthesize";
import {
  analyzeOpenAPIProjection,
  type ProjectionAnalysis,
  type ProjectionDocument,
} from "@openbindings/openapi-client/provider";
import {
  BINDING_SPEC_OPENAPI_20,
  BINDING_SPEC_OPENAPI_30,
  BINDING_SPEC_OPENAPI_31,
  BINDING_SPEC_OPENAPI_32,
  DEFAULT_SOURCE_NAME,
  checkAcceptedOpenAPIEdition,
  assertImplementedBindingSpec,
} from "./constants.js";
import { projectionInputTransform } from "./input-routes-v2.js";
import { codePointCompare, validateDocumentAddress } from "./util.js";
import { normalizeAuthoringLocation, readAuthoringArtifact } from "./platform.js";
import { synthesizeSwagger20 } from "./swagger20-synthesis.js";

/** Thin OpenBindings projection over the standalone client's native analysis. */
export class OpenAPISynthesizer implements InterfaceSynthesizer, CoverageSynthesizer, SourceInspector {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options?: { fetch?: typeof globalThis.fetch }) {
    this.fetchFn = options?.fetch ?? globalThis.fetch;
  }

  checkBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
    return checkBindingSpecSupport(bindingSpecs, openAPIBindingSpecs());
  }

  bindingSpecs(): BindingSpecInfo[] {
    return openAPIBindingSpecs();
  }

  async synthesizeInterface(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<OBInterface> {
    const source = singleSource(input);
    if (!source) return synthesisSkeleton(input);
    if (source.bindingSpec === BINDING_SPEC_OPENAPI_20) {
      return (await synthesizeSwagger20(input, this.fetchFn, false, options)).iface;
    }
    const observed = await this.analyze(input, source, options);
    if (observed.analysis.failures.length > 0) {
      const failure = observed.analysis.failures[0]!;
      throw new Error(
        `cannot synthesize OpenAPI operation at ${JSON.stringify(failure.sourceRef)}: ${failure.message}; synthesis would return a statically unbindable partial interface`,
      );
    }
    return observed.iface;
  }

  async synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    const source = singleSource(input);
    if (!source) return finalizeSynthesisCoverage(synthesisSkeleton(input), [], true);
    if (source.bindingSpec === BINDING_SPEC_OPENAPI_20) {
      const observed = await synthesizeSwagger20(input, this.fetchFn, true, options);
      return finalizeSynthesisCoverage(observed.iface, observed.coverage, true, undefined, { revalidateInterface: false });
    }
    const observed = await this.analyze(input, source, options);
    const coverage = [
      ...observed.analysis.coverage,
      ...observed.analysis.failures
        .filter((failure) => failure.sourceRef === "#")
        .map((failure): SynthesisCoverageEntry => ({
          sourceIndex: 0,
          sourceRef: failure.sourceRef,
          scope: "source",
          status: failure.status as SynthesisCoverageEntry["status"],
          reasonCode: failure.reasonCode,
          ...(failure.rule ? { rule: failure.rule } : {}),
          message: failure.message,
          requirements: [],
        })),
    ];
    return finalizeSynthesisCoverage(
      observed.iface,
      coverage as SynthesisCoverageEntry[],
      true,
      undefined,
      { revalidateInterface: false },
    );
  }

  async inspectSource(
    source: Source,
    options?: { signal?: AbortSignal },
  ): Promise<SourceInspection> {
    if (source.bindingSpec === BINDING_SPEC_OPENAPI_20) {
      const observed = await synthesizeSwagger20({ sources: [source] }, this.fetchFn, true, options);
      return inspectionFromInterface(observed.iface);
    }
    const input: SynthesizeInput = { sources: [source] };
    const observed = await this.analyze(input, source, options);
    return inspectionFromInterface(observed.iface);
  }

  private async analyze(
    input: SynthesizeInput,
    source: AdapterSource,
    options?: { signal?: AbortSignal },
  ): Promise<{ analysis: Readonly<ProjectionAnalysis>; iface: OBInterface }> {
    assertImplementedBindingSpec(source.bindingSpec);
    if (source.outputLocation) validateDocumentAddress(source.outputLocation);
    const location = normalizeAuthoringLocation(source.location);
    const content = source.content === undefined && source.embed && location
      ? await readAuthoringArtifact(location, options?.signal, this.fetchFn)
      : source.content;
    const nativeSource = content !== undefined
      ? { ...(location ? { location } : {}), content }
      : location!;
    const analysis = await analyzeOpenAPIProjection(nativeSource, {
      documentFetch: this.fetchFn,
      documentSignal: options?.signal,
    });
    checkAcceptedOpenAPIEdition(source.bindingSpec, analysis.edition);
    for (const warning of analysis.warnings) input.onWarning?.({ ...warning });
    const iface = interfaceFromProjection(input, source, analysis.openapi3, content);
    return { analysis, iface };
  }
}

function interfaceFromProjection(
  input: SynthesizeInput,
  source: AdapterSource,
  projection: ProjectionDocument | undefined,
  embeddedContent: unknown,
): OBInterface {
  const iface = synthesisSkeleton(input);
  const sourceEntry: Source = {
    bindingSpec: source.bindingSpec,
    ...(source.location ? { location: normalizeAuthoringLocation(source.location) } : {}),
    ...(embeddedContent !== undefined ? { content: embeddedContent } : {}),
  };
  iface.sources = { [DEFAULT_SOURCE_NAME]: sourceEntry };
  if (projection) {
    if (projection.name) iface.name = projection.name;
    if (projection.version) iface.version = projection.version;
    if (projection.description) iface.description = projection.description;
    iface.operations = Object.fromEntries(Object.entries(projection.operations).map(
      ([key, operation]) => [key, { ...structuredClone(operation) }],
    ));
    const bindings: Record<string, BindingEntry> = {};
    for (const [key, binding] of Object.entries(projection.bindings ?? {})) {
      bindings[key] = {
        operation: binding.operation,
        source: DEFAULT_SOURCE_NAME,
        selector: binding.selector,
        ...(binding.input ? { inputTransform: projectionInputTransform(binding.input) } : {}),
      };
    }
    if (Object.keys(bindings).length > 0) iface.bindings = bindings;
    if (projection.dependencies && Object.keys(projection.dependencies).length > 0) {
      iface.dependencies = Object.fromEntries(Object.entries(projection.dependencies).map(
        ([key, dependency]) => [key, { ...structuredClone(dependency) }],
      ));
    }
  }
  return finalizeSynthesis(iface, input, DEFAULT_SOURCE_NAME, source.bindingSpec);
}

function inspectionFromInterface(iface: OBInterface): SourceInspection {
  const targets: SourceInspection["targets"] = [];
  for (const binding of Object.values(iface.bindings ?? {})) {
    targets.push({
      selector: binding.selector ?? "",
      operationKey: binding.operation,
      operation: iface.operations[binding.operation],
    });
  }
  targets.sort((left, right) => codePointCompare(left.selector, right.selector));
  return { targets, exhaustive: true };
}

function singleSource(input: SynthesizeInput): SynthesizeSource | undefined {
  const sources = input.sources ?? [];
  if (sources.length > 1) throw new MultipleSourcesError();
  return sources[0];
}

interface AdapterSource {
  bindingSpec: string;
  name?: string;
  location?: string;
  content?: unknown;
  outputLocation?: string;
  embed?: boolean;
  description?: string;
}

function openAPIBindingSpecs(): BindingSpecInfo[] {
  return [
    { bindingSpec: BINDING_SPEC_OPENAPI_20, description: "Swagger 2.0 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_30, description: "OpenAPI 3.0 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_31, description: "OpenAPI 3.1 HTTP APIs" },
    { bindingSpec: BINDING_SPEC_OPENAPI_32, description: "OpenAPI 3.2 HTTP APIs" },
  ];
}
