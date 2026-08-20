import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, type Document, type Node as KDLNode } from "@bgotink/kdl";
import {
  MAX_TESTED_VERSION,
  type BindingSpecInfo,
  type JSONSchema,
  type OBInterface,
  type Source,
} from "@openbindings/core";
import {
  InvocationError,
  InvocationImpl,
  contextApiKey,
  contextConfiguration,
  contextEnvironment,
  contextRequiredError,
  ERR_INVALID_REF,
  ERR_EXECUTION_FAILED,
  ERR_RUNTIME,
  ERR_RESPONSE_ERROR,
  ERR_SOURCE_CONFIG_ERROR,
  ERR_SOURCE_LOAD_FAILED,
  ERR_VALIDATION_FAILED,
  type BindingInvocationArgs,
  type BindingInvoker,
  type Invocation,
} from "@openbindings/invoke";
import {
  MultipleSourcesError,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  synthesisSkeleton,
  type CoverageSynthesizer,
  type InterfaceSynthesizer,
  type SourceInspection,
  type SourceInspector,
  type SynthesisCoverageEntry,
  type SynthesizeInput,
  type SynthesizeResult,
} from "@openbindings/synthesize";

export const BINDING_SPEC = "openbindings.usage@1";
export const IMPLEMENTED_USAGE_VERSION = "3.5.6";

export interface ProcessRequest {
  argv: string[];
  environment: Record<string, string>;
  stdin?: string | Uint8Array;
  signal: AbortSignal;
}

export interface ProcessResult {
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
  exitCode: number;
  /** Native signal name when the process terminated by signal. */
  signal?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type ProcessExecutor = (request: ProcessRequest) => Promise<ProcessResult>;

export interface UsageInvokerOptions {
  executor?: ProcessExecutor;
  authorizeExecAddress?: (argv: string[]) => boolean;
  encoders?: Record<string, (value: unknown) => string | Uint8Array>;
  decoders?: Record<string, (value: Uint8Array) => unknown>;
  classifiers?: Record<string, (result: ProcessResult) => boolean>;
}

export interface UsageSynthesizerOptions {
  executor?: ProcessExecutor;
  authorizeExecAddress?: (argv: string[]) => boolean;
  fetch?: typeof globalThis.fetch;
}

interface Field {
  key: string;
  kind: "flag" | "arg";
  spelling: string;
  takesValue: boolean;
  variadic: boolean;
  count: boolean;
  repeatable: boolean;
  env?: string;
  overrides: string[];
  doubleDash?: string;
  choicesEnv?: string;
  choices: string[];
  required: boolean;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  negate?: string;
  global: boolean;
  help?: string;
  spellings: string[];
  requiredIf?: string;
  requiredUnless?: string;
}

interface Command {
  name: string;
  aliases: string[];
  fields: Field[];
  commands: Command[];
  help?: string;
  subcommandRequired: boolean;
}

interface Descriptor {
  name?: string;
  bin?: string;
  version?: string;
  about?: string;
  minVersion?: string;
  root: Command;
}

/** Node.js implementation of openbindings.usage@1. */
export class UsageInvoker implements BindingInvoker {
  readonly #executor: ProcessExecutor;
  readonly #authorizeExecAddress?: (argv: string[]) => boolean;
  readonly #encoders: Record<string, (value: unknown) => string | Uint8Array>;
  readonly #decoders: Record<string, (value: Uint8Array) => unknown>;
  readonly #classifiers: Record<string, (result: ProcessResult) => boolean>;

  constructor(options: UsageInvokerOptions = {}) {
    this.#executor = options.executor ?? executeProcess;
    this.#authorizeExecAddress = options.authorizeExecAddress;
    this.#encoders = options.encoders ?? {};
    this.#decoders = options.decoders ?? {};
    this.#classifiers = options.classifiers ?? {};
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "CLI tools described by jdx usage" }];
  }

  invokeBinding<I = unknown, O = unknown>(args: BindingInvocationArgs): Invocation<I, O> {
    const invocation = new InvocationImpl<unknown, unknown>({ signal: args.signal });
    queueMicrotask(() => void this.#run(args, invocation).catch((error: unknown) => {
      invocation.fireError(error instanceof InvocationError
        ? error
        : new InvocationError(ERR_RUNTIME));
    }));
    return invocation as Invocation<I, O>;
  }

  async #run(args: BindingInvocationArgs, invocation: InvocationImpl<unknown, unknown>): Promise<void> {
    let descriptor: Descriptor;
    try {
      descriptor = parseDescriptor(await this.#loadArtifact(args));
    } catch (error: unknown) {
      invocation.fireError(new InvocationError(ERR_SOURCE_LOAD_FAILED));
      return;
    }
    if (!descriptor.bin) {
      invocation.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR));
      return;
    }

    let command: Command;
    let selectedPath: string[];
    try {
      ({ command, selectedPath } = resolveCommand(descriptor.root, args.ref));
    } catch (error: unknown) {
      invocation.fireError(new InvocationError(ERR_INVALID_REF));
      return;
    }

    if (contextApiKey(args.context)) {
      invocation.fireError(contextRequiredError({ target: descriptor.bin, alternatives: [{ requirements: [{ type: "auth.apiKey", description: "name an environment-variable carriage" }] }] }));
      return;
    }

    let input: Record<string, unknown> = {};
    if (command.fields.length === 0) void invocation.closeInput();
    else {
      const first = await firstInput(invocation.inputs());
      void invocation.closeInput();
      if (first !== undefined) {
      if (!isRecord(first)) {
        invocation.fireError(new InvocationError(ERR_VALIDATION_FAILED));
        return;
      }
      input = first;
      }
    }

    let planned: PlannedProcess | undefined;
    try {
      planned = await planProcess(
        descriptor,
        command,
        selectedPath,
        input,
        args.context,
        this.#encoders,
        invocation.signal,
      );
    } catch (error: unknown) {
      invocation.fireError(new InvocationError(ERR_VALIDATION_FAILED));
      return;
    }

    let result: ProcessResult;
    try {
      result = await this.#executor(planned.request);
    } catch (error: unknown) {
      if (!invocation.signal.aborted) invocation.fireError(new InvocationError(ERR_RUNTIME));
      return;
    } finally {
      await planned?.cleanup();
    }
    const cfg = contextConfiguration(args.context);
    const classifier = typeof cfg["classify"] === "string" ? this.#classifiers[cfg["classify"]] : undefined;
    if (typeof cfg["classify"] === "string" && !classifier) {
      invocation.fireError(new InvocationError(ERR_SOURCE_CONFIG_ERROR));
      return;
    }
    if (!(classifier ? classifier(result) : result.exitCode === 0)) {
      invocation.fireError(new InvocationError(ERR_EXECUTION_FAILED));
      return;
    }
    let output: unknown;
    try {
      const bytes = outputBytes(result.stdout);
      const decoder = typeof cfg["decode"] === "string" ? this.#decoders[cfg["decode"]] : undefined;
      if (typeof cfg["decode"] === "string" && !decoder) throw new Error(`unknown decode configuration ${JSON.stringify(cfg["decode"])}`);
      output = decoder ? decoder(bytes) : stripTrailingLineEndings(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      invocation.fireError(new InvocationError(ERR_RESPONSE_ERROR));
      return;
    }
    await invocation.emitOutput(output);
    invocation.closeOutput();
  }

  async #loadArtifact(args: BindingInvocationArgs): Promise<string> {
    return loadUsageArtifact(args.source, {
      executor: this.#executor,
      authorizeExecAddress: this.#authorizeExecAddress,
      fetch: args.fetch,
      signal: args.signal,
    });
  }
}

/** Authoring implementation for usage descriptor sources. */
export class UsageSynthesizer implements InterfaceSynthesizer, CoverageSynthesizer, SourceInspector {
  readonly #executor: ProcessExecutor;
  readonly #authorizeExecAddress?: (argv: string[]) => boolean;
  readonly #fetch?: typeof globalThis.fetch;

  constructor(options: UsageSynthesizerOptions = {}) {
    this.#executor = options.executor ?? executeProcess;
    this.#authorizeExecAddress = options.authorizeExecAddress;
    this.#fetch = options.fetch;
  }

  bindingSpecs(): BindingSpecInfo[] {
    return [{ bindingSpec: BINDING_SPEC, description: "CLI tools described by jdx usage" }];
  }

  async synthesizeInterface(input: SynthesizeInput, options?: { signal?: AbortSignal }): Promise<OBInterface> {
    return (await this.#synthesizeObserved(input, options)).interface;
  }

  async synthesizeInterfaceWithCoverage(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<SynthesizeResult> {
    const observation = await this.#synthesizeObserved(input, options);
    return finalizeSynthesisCoverage(
      observation.interface,
      observation.descriptor ? synthesisCoverage(observation.descriptor, observation.interface) : [],
      true,
    );
  }

  async #synthesizeObserved(
    input: SynthesizeInput,
    options?: { signal?: AbortSignal },
  ): Promise<{ interface: OBInterface; descriptor?: Descriptor }> {
    const sources = input.sources ?? [];
    if (sources.length === 0) return { interface: synthesisSkeleton(input) };
    if (sources.length > 1) throw new MultipleSourcesError();
    const source = sources[0]!;
    if (source.bindingSpec !== BINDING_SPEC) throw new Error(`synthesizer supports exact binding specification ${JSON.stringify(BINDING_SPEC)}, got ${JSON.stringify(source.bindingSpec)}`);
    if (source.outputLocation) validateUsageLocation(source.outputLocation);
    const authoringSource = normalizeAuthoringSource(source);
    const text = await loadUsageArtifact(authoringSource, {
      executor: this.#executor,
      authorizeExecAddress: this.#authorizeExecAddress,
      fetch: this.#fetch,
      signal: options?.signal,
    });
    const descriptor = parseDescriptor(text);
    const sourceEntry: Source = { bindingSpec: BINDING_SPEC };
    if (source.content !== undefined) {
      sourceEntry.content = source.content;
      if (authoringSource.location) sourceEntry.location = authoringSource.location;
    } else if (authoringSource.location?.startsWith("file:")) {
      sourceEntry.content = text;
    } else if (authoringSource.location) {
      sourceEntry.location = authoringSource.location;
      if (source.embed) sourceEntry.content = text;
    }
    const iface = interfaceFromUsage(descriptor, sourceEntry);
    return {
      interface: finalizeSynthesis(iface, input, "default", BINDING_SPEC),
      descriptor,
    };
  }

  async inspectSource(source: Source, options?: { signal?: AbortSignal }): Promise<SourceInspection> {
    const text = await loadUsageArtifact(normalizeAuthoringSource(source), {
      executor: this.#executor,
      authorizeExecAddress: this.#authorizeExecAddress,
      fetch: this.#fetch,
      signal: options?.signal,
    });
    const descriptor = parseDescriptor(text);
    const targets = commandPlans(descriptor).flatMap(({ refs, operationKey, command }) =>
      refs.map((ref) => ({
        ref,
        operationKey,
        operation: command.help ? { description: command.help } : undefined,
      })));
    return { targets: targets.sort((a, b) => compare(a.ref, b.ref)), exhaustive: true };
  }
}

function normalizeAuthoringSource<T extends Pick<Source, "bindingSpec" | "location" | "content">>(source: T): T {
  if (!source.location || source.content !== undefined) return source;
  try {
    new URL(source.location);
    return source;
  } catch {
    return { ...source, location: pathToFileURL(resolve(source.location)).href };
  }
}

function validateUsageLocation(location: string): void {
  if (location.startsWith("exec:")) {
    parseExecAddress(location);
    return;
  }
  const url = new URL(location);
  if (!url.protocol) throw new Error("usage outputLocation must be a document or exec address");
}

async function loadUsageArtifact(
  source: Pick<Source, "content" | "location">,
  options: { executor: ProcessExecutor; authorizeExecAddress?: (argv: string[]) => boolean; fetch?: typeof globalThis.fetch; signal?: AbortSignal },
): Promise<string> {
  if (source.content !== undefined) {
    if (typeof source.content !== "string") throw new Error("usage source content must be descriptor text");
    return source.content;
  }
  const location = source.location;
  if (!location) throw new Error("usage source requires location or content");
  if (location.startsWith("exec:")) {
    const argv = parseExecAddress(location);
    if (!options.authorizeExecAddress?.(argv)) throw new Error(`exec address ${JSON.stringify(location)} is not authorized`);
    const result = await options.executor({ argv, environment: {}, signal: options.signal ?? new AbortController().signal });
    if (result.exitCode !== 0) throw new Error(diagnostic(result.stderr) || `artifact command exited ${result.exitCode}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(outputBytes(result.stdout));
  }
  const url = new URL(location);
  if (url.protocol === "file:") return decodeArtifactText(await readFile(fileURLToPath(url)));
  if (url.protocol === "http:" || url.protocol === "https:") {
    const response = await (options.fetch ?? fetch)(url, { signal: options.signal });
    if (!response.ok) throw new Error(`artifact fetch returned HTTP ${response.status}`);
    return decodeArtifactText(new Uint8Array(await response.arrayBuffer()));
  }
  throw new Error(`unsupported usage location scheme ${url.protocol}`);
}

function decodeArtifactText(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error: unknown) {
    throw new Error(`usage artifact is not valid UTF-8 (USAGE-D-01): ${message(error)}`);
  }
}

function interfaceFromUsage(descriptor: Descriptor, source: Source): OBInterface {
  const iface: OBInterface = {
    openbindings: MAX_TESTED_VERSION,
    name: descriptor.name,
    version: descriptor.version,
    description: descriptor.about,
    operations: {},
    bindings: {},
    sources: { default: source },
  };
  for (const { refs, operationKey, command, input } of commandPlans(descriptor)) {
    iface.operations[operationKey] = {
      ...(command.help ? { description: command.help } : {}),
      ...(input ? { input } : {}),
      output: { type: "string", "x-ob": { floor: "text" } },
      ...(refs[0]?.includes(" ") ? { tags: refs[0].split(" ").slice(0, -1) } : {}),
    };
    for (const [index, ref] of refs.entries()) {
      const bindingKey = index === 0
        ? `${operationKey}.default`
        : `${operationKey}.default.alias${index}`;
      iface.bindings![bindingKey] = {
        operation: operationKey,
        source: "default",
        ...(ref ? { ref } : {}),
      };
    }
  }
  return iface;
}

interface CommandPlan {
  refs: string[];
  operationKey: string;
  command: Command;
  input?: JSONSchema;
}

function commandPlans(descriptor: Descriptor): CommandPlan[] {
  const plans: CommandPlan[] = [];
  if (!descriptor.bin) return plans;
  const used = new Set<string>();
  const rootKey = uniqueKey(sanitizeKey(descriptor.bin), used);
  used.add(rootKey);
  const root = { ...descriptor.root, fields: descriptor.root.fields, help: descriptor.about };
  try {
    plans.push({ refs: [""], operationKey: rootKey, command: root, input: inputSchema(root) });
  } catch {
    // Coverage records a command-local unresolvable root while preserving
    // otherwise bindable descendants.
  }
  const walk = (
    commands: Command[],
    path: string[],
    inherited: Field[],
    refPrefixes: string[][],
  ): void => {
    for (const command of commands) {
      const nextPath = [...path, command.name];
      const effective = { ...command, fields: [...inherited, ...command.fields] };
      const operationKey = uniqueKey(sanitizeKey(nextPath.join(".")), used);
      used.add(operationKey);
      const spellings = [...new Set([command.name, ...command.aliases].filter(Boolean))];
      const nextPrefixes = refPrefixes.flatMap((prefix) => spellings.map((spelling) => [...prefix, spelling]));
      if (!command.subcommandRequired && command.name) {
        try {
          const refs = uniquelyResolvableRefs(descriptor, nextPath, nextPrefixes);
          if (refs.length > 0) {
            plans.push({
              refs,
              operationKey,
              command: effective,
              input: inputSchema(effective),
            });
          }
        } catch {
          // Coverage records the exact exclusion.
        }
      }
      walk(
        command.commands,
        nextPath,
        [...inherited, ...command.fields.filter((field) => field.global)],
        nextPrefixes,
      );
    }
  };
  walk(descriptor.root.commands, [], descriptor.root.fields.filter((field) => field.global), [[]]);
  return plans;
}

function uniquelyResolvableRefs(
  descriptor: Descriptor,
  canonicalPath: string[],
  candidates: string[][],
): string[] {
  const refs: string[] = [];
  for (const segments of candidates) {
    const ref = segments.join(" ");
    try {
      if (samePath(resolveCommand(descriptor.root, ref).canonicalPath, canonicalPath)) refs.push(ref);
    } catch {
      // The artifact is authoritative about its spellings, but declaration
      // order is not target identity. Ambiguous alternatives are accounted
      // for by synthesisCoverage and never advertised as invocable bindings.
    }
  }
  return refs;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function synthesisCoverage(descriptor: Descriptor, iface: OBInterface): SynthesisCoverageEntry[] {
  const represented = new Map<string, { operationKey: string; bindingRef: string }>();
  for (const binding of Object.values(iface.bindings ?? {})) {
    represented.set(binding.ref ?? "", {
      operationKey: binding.operation,
      bindingRef: binding.ref ?? "",
    });
  }
  const entries: SynthesisCoverageEntry[] = [];
  const add = (
    sourceRef: string,
    bindingRef: string,
    scope: "target" | "alternative" | "projection" = "target",
    exclusion?: Omit<SynthesisCoverageEntry, "sourceIndex" | "sourceRef" | "scope">,
  ): void => {
    if (exclusion) {
      entries.push({ sourceIndex: 0, sourceRef, scope, ...exclusion });
      return;
    }
    const match = represented.get(bindingRef);
    if (match) {
      entries.push({
        sourceIndex: 0,
        sourceRef,
        scope,
        status: "represented",
        ...match,
      });
      return;
    }
    entries.push({
      sourceIndex: 0,
      sourceRef,
      scope,
      status: "implementation-unsupported",
      reasonCode: "usage.missing_emitted_binding",
      message: "the synthesizer returned without emitting this resolvable command path",
    });
  };
  const excluded = (
    status: "excluded" | "invalid",
    reasonCode: string,
    rule: string,
    message: string,
  ): Omit<SynthesisCoverageEntry, "sourceIndex" | "sourceRef" | "scope"> => ({
    status, reasonCode, rule, message,
  });

  const missingBin = !descriptor.bin;
  const root = { ...descriptor.root, fields: descriptor.root.fields, help: descriptor.about };
  if (missingBin) {
    add("<root>", "", "target", excluded(
      "excluded",
      "usage.missing_target_identity",
      "USAGE-P-03",
      "the descriptor has no non-empty bin target identity",
    ));
  } else {
    try {
      inputSchema(root);
      add("<root>", "");
    } catch (error: unknown) {
      add("<root>", "", "target", excluded(
        "excluded",
        "usage.unresolvable_surface",
        "USAGE-P-04",
        message(error),
      ));
    }
  }

  const ambiguousReported = new Set<string>();
  const walk = (
    commands: Command[],
    path: string[],
    inherited: Field[],
    refPrefixes: string[][],
  ): void => {
    for (const command of commands) {
      const nextPath = [...path, command.name];
      const spellings = [...new Set([command.name, ...command.aliases].filter(Boolean))];
      const nextPrefixes = refPrefixes.flatMap((prefix) => spellings.map((spelling) => [...prefix, spelling]));
      const effective = { ...command, fields: [...inherited, ...command.fields] };
      let disposition: Omit<SynthesisCoverageEntry, "sourceIndex" | "sourceRef" | "scope"> | undefined;
      if (!command.name) {
        disposition = excluded(
          "invalid",
          "usage.empty_command_identity",
          "USAGE-D-01",
          "a command has no non-empty primary name",
        );
      } else if (command.subcommandRequired) {
        // A subcommand-required group is navigation in the artifact, not an
        // invocable interaction. Its descendants are still inventoried.
        walk(
          command.commands,
          nextPath,
          [...inherited, ...command.fields.filter((field) => field.global)],
          nextPrefixes,
        );
        continue;
      }
      const refs: string[] = [];
      for (const segments of nextPrefixes) {
        const ref = segments.join(" ");
        try {
          const resolved = resolveCommand(descriptor.root, ref);
          if (samePath(resolved.canonicalPath, nextPath)) refs.push(ref);
        } catch (error: unknown) {
          if (error instanceof AmbiguousCommandSpellingError && !ambiguousReported.has(ref)) {
            ambiguousReported.add(ref);
            add(
              `ambiguous-ref:${ref}`,
              "",
              "alternative",
              excluded(
                "excluded",
                "usage.ambiguous_command_spelling",
                "USAGE-D-03",
                "the command path matches more than one sibling command and declaration order is not target identity",
              ),
            );
          }
        }
      }
      if (refs.length === 0 && command.name) {
        add(
          `command:${nextPath.join(" ")}`,
          "",
          "target",
          excluded(
            "excluded",
            "usage.no_unique_command_ref",
            "USAGE-D-03",
            "the command has no spelling path that resolves uniquely through the descriptor",
          ),
        );
        walk(
          command.commands,
          nextPath,
          [...inherited, ...command.fields.filter((field) => field.global)],
          nextPrefixes,
        );
        continue;
      }
      if (missingBin) {
        disposition = excluded(
          "excluded",
          "usage.missing_target_identity",
          "USAGE-P-03",
          "the descriptor has no non-empty bin target identity",
        );
      } else {
        try {
          inputSchema(effective);
        } catch (error: unknown) {
          disposition = excluded(
            "excluded",
            "usage.unresolvable_surface",
            "USAGE-P-04",
            message(error),
          );
        }
      }
      if (refs.length === 0) {
        add(
          `<command:${command.name || "missing"}>`,
          "",
          "target",
          disposition ?? excluded(
            "invalid",
            "usage.empty_command_identity",
            "USAGE-D-01",
            "a command has no usable primary or alias spelling",
          ),
        );
      } else {
        for (const ref of refs) add(ref, ref, "target", disposition);
      }
      walk(
        command.commands,
        nextPath,
        [...inherited, ...command.fields.filter((field) => field.global)],
        nextPrefixes,
      );
    }
  };
  walk(descriptor.root.commands, [], descriptor.root.fields.filter((field) => field.global), [[]]);
  return entries;
}

function sanitizeKey(name: string): string {
  let key = name.replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/^_+|_+$/gu, "");
  if (!key) return "unnamed";
  if (!/^[A-Za-z_]/u.test(key)) key = `_${key}`;
  return key;
}

function uniqueKey(key: string, used: Set<string>): string {
  if (!used.has(key)) return key;
  for (let index = 2; ; index += 1) {
    const candidate = `${key}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function inputSchema(command: Command): JSONSchema | undefined {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  const seen = new Set<string>();
  for (const field of command.fields) {
    if (seen.has(field.key)) throw new Error(`canonical field identity ${JSON.stringify(field.key)} collides on command ${command.name}`);
    seen.add(field.key);
    let schema: Record<string, unknown>;
    if (field.count) schema = { type: "integer", minimum: 0 };
    else if (!field.takesValue && field.kind === "flag") schema = { type: "boolean" };
    else {
      const scalar: Record<string, unknown> = {
        type: "string",
        // A dynamic choices environment can add values at invocation time;
        // publishing the literal subset as a closed enum would reject
        // artifact-valid inputs before the binding can consult that context.
        ...(field.choices.length > 0 && !field.choicesEnv ? { enum: field.choices } : {}),
      };
      schema = field.repeatable || field.variadic
        ? { type: "array", items: scalar, ...(field.min !== undefined ? { minItems: field.min } : {}), ...(field.max !== undefined ? { maxItems: field.max } : {}) }
        : scalar;
    }
    if (field.help) schema.description = field.help;
    if (field.defaultValue !== undefined) schema.default = field.defaultValue;
    properties[field.key] = schema;
    // An artifact-declared environment fallback can satisfy an omitted
    // field. The OBI schema cannot inspect invocation context, so requiring
    // that property here would overstate the caller-value contract.
    if (field.required && field.defaultValue === undefined && !field.env) required.push(field.key);
  }
  if (Object.keys(properties).length === 0) return undefined;
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

function parseDescriptor(text: string): Descriptor {
  const document = parse(text, { as: "document" });
  rejectExcluded(document);
  const minVersion = stringArgument(document.findNodeByName("min_usage_version"));
  if (minVersion && compareVersions(minVersion, IMPLEMENTED_USAGE_VERSION) > 0) {
    throw new Error(`artifact requires usage ${minVersion}, above implemented ${IMPLEMENTED_USAGE_VERSION}`);
  }
  return {
    name: stringArgument(document.findNodeByName("name")),
    bin: stringArgument(document.findNodeByName("bin")),
    version: stringArgument(document.findNodeByName("version")),
    about: stringArgument(document.findNodeByName("about")),
    minVersion,
    root: {
      name: "", aliases: [], fields: parseFields(document.nodes), commands: parseCommands(document.nodes),
      help: stringArgument(document.findNodeByName("about")), subcommandRequired: false,
    },
  };
}

function rejectExcluded(document: Document): void {
  const walk = (nodes: KDLNode[]): void => {
    for (const node of nodes) {
      const name = node.getName();
      if (["include", "config", "config_file", "config_alias", "mount"].includes(name)) {
        throw new Error(`usage construct ${name} is excluded from openbindings.usage@1 revision 1`);
      }
      if ((name === "arg" || name === "flag") && node.hasProperty("parse")) {
        throw new Error("usage argument parse commands are excluded from revision 1");
      }
      if (node.children) walk(node.children.nodes);
    }
  };
  walk(document.nodes);
}

function parseCommands(nodes: KDLNode[]): Command[] {
  return nodes.filter((node) => node.getName() === "cmd").map((node) => ({
    name: String(node.getArgument(0) ?? ""),
    aliases: (node.children?.findNodesByName("alias") ?? []).flatMap(allStringArguments),
    fields: parseFields(node.children?.nodes ?? []),
    commands: parseCommands(node.children?.nodes ?? []),
    help: stringPropertyOrChild(node, "help"),
    subcommandRequired: node.getProperty("subcommand_required") === true,
  }));
}

function parseFields(nodes: KDLNode[]): Field[] {
  return nodes.filter((node) => node.getName() === "flag" || node.getName() === "arg").map((node) => {
    const kind = node.getName() as "flag" | "arg";
    const syntax = String(node.getArgument(0) ?? "");
    const childArg = kind === "flag" ? node.children?.findNodeByName("arg") : undefined;
    const valueSyntax = kind === "flag"
      ? (syntax.split(/\s+/u).find((part) => /^[<[]/.test(part)) ?? stringArgument(childArg) ?? "")
      : syntax;
    const syntaxSpellings = kind === "flag"
      ? syntax.split(/\s+/u).filter((part) => part.startsWith("-")).map(cleanFlagSpelling)
      : [];
    const aliasSpellings = kind === "flag"
      ? (node.children?.findNodesByName("alias") ?? []).flatMap(allStringArguments).filter((part) => part.startsWith("-")).map(cleanFlagSpelling)
      : [];
    const spellings = [...new Set([...syntaxSpellings, ...aliasSpellings])];
    const canonicalSpelling = spellings.find((part) => part.startsWith("--")) ?? spellings[0] ?? "";
    const key = kind === "flag" ? canonicalSpelling.replace(/^-+/u, "") : cleanArgumentName(valueSyntax);
    const choiceNodes = [
      node.children?.findNodeByName("choices"),
      childArg?.children?.findNodeByName("choices"),
    ].filter((choice): choice is KDLNode => choice !== undefined);
    const choices = [...new Set(choiceNodes.flatMap(allStringArguments))];
    const choicesEnv = choiceNodes.map((choice) => choice.getProperty("env")).find((value) => typeof value === "string");
    const defaultValue = node.hasProperty("default")
      ? node.getProperty("default")
      : childArg?.hasProperty("default") ? childArg.getProperty("default") : undefined;
    const min = numberProperty(childArg ?? node, "var_min") ?? numberProperty(node, "var_min");
    const max = numberProperty(childArg ?? node, "var_max") ?? numberProperty(node, "var_max");
    const flagRepeatable = kind === "flag" && (node.getProperty("var") === true || syntax.split(/\s+/u).some((part) => part.startsWith("-") && part.endsWith("...")));
    const valueVariadic = valueSyntax.endsWith("...") || childArg?.getProperty("var") === true || (kind === "arg" && node.getProperty("var") === true);
    return {
      key,
      kind,
      spelling: kind === "flag" ? canonicalSpelling : "",
      spellings,
      takesValue: kind === "arg" || valueSyntax !== "",
      variadic: valueVariadic,
      count: node.getProperty("count") === true,
      repeatable: flagRepeatable,
      env: stringProperty(node, "env") ?? stringProperty(childArg, "env"),
      overrides: typeof node.getProperty("overrides") === "string" ? String(node.getProperty("overrides")).split(/[ ,]+/).filter(Boolean) : [],
      doubleDash: typeof node.getProperty("double_dash") === "string" ? String(node.getProperty("double_dash")) : undefined,
      choicesEnv: typeof choicesEnv === "string" ? choicesEnv : undefined,
      choices,
      required: node.getProperty("required") === true || (kind === "arg" && /^<[^>]+>/.test(syntax)),
      requiredIf: stringProperty(node, "required_if"),
      requiredUnless: stringProperty(node, "required_unless"),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      negate: typeof node.getProperty("negate") === "string" ? String(node.getProperty("negate")) : undefined,
      global: node.getProperty("global") === true,
      help: stringPropertyOrChild(node, "help"),
    };
  });
}

class AmbiguousCommandSpellingError extends Error {}

function resolveCommand(
  root: Command,
  ref: string,
): { command: Command; selectedPath: string[]; canonicalPath: string[] } {
  const segments = ref === "" ? [] : ref.split(" ");
  if (segments.some((segment) => segment === "")) {
    throw new Error(`usage ref ${JSON.stringify(ref)} is malformed: command-path segments are separated by single spaces`);
  }
  let current = root;
  const inherited: Field[] = root.fields.filter((field) => field.global);
  const selectedPath: string[] = [];
  const canonicalPath: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const matches = current.commands.filter((command) => command.name === segment || command.aliases.includes(segment));
    if (matches.length === 0) throw new Error(`usage ref segment ${JSON.stringify(segment)} does not resolve`);
    if (matches.length > 1) {
      throw new AmbiguousCommandSpellingError(
        `usage ref segment ${JSON.stringify(segment)} matches ${matches.length} sibling commands (USAGE-D-03)`,
      );
    }
    const next = matches[0]!;
    current = next;
    selectedPath.push(segment);
    canonicalPath.push(next.name);
    if (index < segments.length - 1) inherited.push(...current.fields.filter((field) => field.global));
  }
  if (current !== root) current = { ...current, fields: [...inherited, ...current.fields] };
  return { command: current, selectedPath, canonicalPath };
}

interface PlannedProcess { request: ProcessRequest; cleanup(): Promise<void> }

async function planProcess(
  descriptor: Descriptor,
  command: Command,
  selectedPath: string[],
  input: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  encoders: Record<string, (value: unknown) => string | Uint8Array>,
  signal: AbortSignal,
): Promise<PlannedProcess> {
  const cfg = contextConfiguration(context);
  const configuredTarget = cfg["target"];
  const target = typeof configuredTarget === "string" && configuredTarget !== "" ? configuredTarget : descriptor.bin!;
  const environment = { ...contextEnvironment(context) };
  const route = isRecord(cfg["route"]) ? cfg["route"] : {};
  const encode = isRecord(cfg["encode"]) ? cfg["encode"] : {};
  const argv = [target, ...selectedPath];
  let stdin: string | Uint8Array | undefined;
  const temporaryDirectories: string[] = [];
  const flagContributions = new Map<string, string[]>();
  const routedOperands = new Map<string, string>();

  const supplied = new Set(Object.keys(input));
  const identities = new Set<string>();
  for (const field of command.fields) {
    if (identities.has(field.key)) throw new Error(`canonical field identity ${JSON.stringify(field.key)} collides on the effective command surface`);
    identities.add(field.key);
    if (field.repeatable && field.variadic) throw new Error(`field ${field.key} is both repeatable and variadic; revision 1 refuses the ambiguous multiplicity`);
    if (!supplied.has(field.key)) {
      const envSatisfied = field.env !== undefined && Object.hasOwn(environment, field.env);
      if (field.required && !envSatisfied && field.defaultValue === undefined) throw new Error(`required field ${field.key} has no caller, environment, or default value`);
      if (envSatisfied) validateChoices(field, environment[field.env!], environment);
      else if (field.defaultValue !== undefined) validateChoices(field, field.defaultValue, environment);
    }
  }
  for (const name of supplied) {
    if (!identities.has(name)) throw new Error(`input field ${name} is not declared by the selected usage command`);
  }
  validateConditionalRequirements(command.fields, supplied, environment);
  for (const field of command.fields) {
    if (!supplied.has(field.key)) continue;
    for (const overridden of field.overrides) {
      const other = resolveFieldReference(command.fields, overridden);
      if (other && supplied.has(other.key)) throw new Error(`supplied fields ${field.key} and ${other.key} override each other without occurrence order`);
    }
    const value = input[field.key];
    validateChoices(field, value, environment);
    const routeCandidate = route[field.key];
    const fieldRoute: Record<string, unknown> = isRecord(routeCandidate) ? routeCandidate : {};
    const routeKind = fieldRoute.kind;
    if (routeKind === "environment") {
      if (!field.env) throw new Error(`field ${field.key} declares no environment-variable carriage`);
      if (field.count || field.repeatable || field.variadic) throw new Error(`field ${field.key} cannot preserve its occurrence structure in one environment value`);
      const encoded = field.takesValue ? encodeToken(value, encode[field.key], encoders) : booleanEnvironment(field, value);
      if (Object.hasOwn(environment, field.env) && environment[field.env] !== encoded) throw new Error(`environment route for ${field.key} conflicts with configured ${field.env}`);
      environment[field.env] = encoded;
      continue;
    }
    if (routeKind === "stdin") {
      if (stdin !== undefined) throw new Error("two supplied fields target the single stdin channel");
      if (field.repeatable || field.variadic || field.count || !field.takesValue && field.kind === "flag") throw new Error(`field ${field.key} has no single value-bearing occurrence for stdin routing`);
      stdin = encodeBytes(value, encode[field.key], encoders);
      const operand = fieldRoute.operand;
      if (operand === "dash") routedOperands.set(field.key, "-");
      else if (operand !== "pure") throw new Error(`stdin route for ${field.key} must select operand "dash" or "pure"`);
      else if (field.required) throw new Error(`pure stdin routing would leave required field ${field.key} unsatisfied`);
      continue;
    }
    if (routeKind === "file") {
      if (field.repeatable || field.variadic || field.count || !field.takesValue && field.kind === "flag") throw new Error(`field ${field.key} has no single value-bearing occurrence for file routing`);
      const directory = await mkdtemp(join(tmpdir(), "openbindings-usage-"));
      temporaryDirectories.push(directory);
      const path = join(directory, "value");
      await writeFile(path, encodeBytes(value, encode[field.key], encoders), { mode: 0o600 });
      routedOperands.set(field.key, path);
      continue;
    }
    if (routeKind !== undefined && routeKind !== "argv") throw new Error(`unknown route kind ${JSON.stringify(routeKind)} for field ${field.key}`);
    if (field.kind === "flag") {
      const contribution: string[] = [];
      appendFlag(contribution, field, value, encode[field.key], encoders);
      flagContributions.set(field.key, contribution);
    }
  }
  for (const field of command.fields) {
    if (field.kind !== "flag") continue;
    const operand = routedOperands.get(field.key);
    if (operand !== undefined) appendRoutedOperand(argv, field, operand);
    else argv.push(...(flagContributions.get(field.key) ?? []));
  }
  let delimiterInserted = false;
  for (const field of command.fields) {
    if (field.kind !== "arg" || !supplied.has(field.key)) continue;
    const routeCandidate = route[field.key];
    const fieldRoute: Record<string, unknown> = isRecord(routeCandidate) ? routeCandidate : {};
    if (fieldRoute.kind === "environment") continue;
    if (fieldRoute.kind === "stdin" && fieldRoute.operand === "pure") continue;
    const routedOperand = routedOperands.get(field.key);
    const values = routedOperand !== undefined ? [routedOperand] : field.variadic ? asArray(input[field.key]) : [input[field.key]];
    enforceCount(field, values.length);
    if (!delimiterInserted && delimiterPresent(field, cfg["delimiter"])) {
      argv.push("--");
      delimiterInserted = true;
    }
    for (const value of values) argv.push(routedOperand !== undefined ? String(value) : encodeToken(value, encode[field.key], encoders));
  }
  return {
    request: { argv, environment, ...(stdin !== undefined ? { stdin } : {}), signal },
    async cleanup() { await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true }))); },
  };
}

function appendFlag(
  argv: string[], field: Field, value: unknown, encoderName: unknown,
  encoders: Record<string, (value: unknown) => string | Uint8Array>,
): void {
  if (field.count) {
    if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`count flag ${field.key} requires a non-negative integer`);
    for (let i = 0; i < Number(value); i++) argv.push(field.spelling);
    return;
  }
  if (!field.takesValue) {
    if (value === true) argv.push(field.spelling);
    else if (value === false && field.negate) argv.push(field.negate);
    else if (value !== false) throw new Error(`boolean flag ${field.key} requires a boolean`);
    return;
  }
  const values = field.repeatable || field.variadic ? asArray(value) : [value];
  enforceCount(field, values.length);
  if (field.variadic) {
    argv.push(field.spelling);
    for (const item of values) argv.push(encodeToken(item, encoderName, encoders));
  } else for (const item of values) argv.push(field.spelling, encodeToken(item, encoderName, encoders));
}

function encodeToken(
  value: unknown,
  encoderName: unknown,
  encoders: Record<string, (value: unknown) => string | Uint8Array>,
): string {
  const encoded = configuredEncoding(value, encoderName, encoders);
  if (encoded !== undefined) {
    if (typeof encoded !== "string") throw new Error("argv and environment encoders must produce exactly one string token");
    return encoded;
  }
  if (typeof value === "string") return value;
  throw new Error("non-string value has no artifact-defined token encoding; select an encode configuration");
}

function encodeBytes(
  value: unknown,
  encoderName: unknown,
  encoders: Record<string, (value: unknown) => string | Uint8Array>,
): string | Uint8Array {
  const encoded = configuredEncoding(value, encoderName, encoders);
  if (encoded !== undefined) return encoded;
  if (typeof value === "string") return value;
  throw new Error("non-string value has no artifact-defined byte encoding; select an encode configuration");
}

function configuredEncoding(
  value: unknown,
  encoderName: unknown,
  encoders: Record<string, (value: unknown) => string | Uint8Array>,
): string | Uint8Array | undefined {
  if (encoderName === undefined) return undefined;
  if (typeof encoderName !== "string" || !encoders[encoderName]) {
    throw new Error(`unknown encode configuration ${JSON.stringify(encoderName)}`);
  }
  return encoders[encoderName](value);
}

function validateChoices(field: Field, value: unknown, environment: Record<string, string>): void {
  let choices = [...field.choices];
  if (field.choicesEnv && Object.hasOwn(environment, field.choicesEnv)) {
    choices.push(...environment[field.choicesEnv]!.split(/[,\s]+/u).filter(Boolean));
  }
  choices = [...new Set(choices)];
  if (!field.choicesEnv && choices.length === 0) return;
  const values = field.repeatable || field.variadic ? asArray(value) : [value];
  for (const item of values) {
    if (typeof item !== "string" || !choices.includes(item)) {
      throw new Error(`field ${field.key} value ${JSON.stringify(item)} is outside its artifact-declared choices`);
    }
  }
}

function validateConditionalRequirements(
  fields: Field[],
  supplied: Set<string>,
  environment: Record<string, string>,
): void {
  const present = (field: Field): boolean => supplied.has(field.key)
    || field.env !== undefined && Object.hasOwn(environment, field.env)
    || field.defaultValue !== undefined;
  for (const field of fields) {
    if (present(field)) continue;
    const requiredIf = requirementTargets(fields, field, field.requiredIf);
    if (requiredIf.some(present)) {
      throw new Error(`field ${field.key} is required because ${requiredIf.filter(present).map((target) => target.key).join(", ")} is present`);
    }
    const requiredUnless = requirementTargets(fields, field, field.requiredUnless);
    if (requiredUnless.length > 0 && !requiredUnless.some(present)) {
      throw new Error(`field ${field.key} is required unless one of ${requiredUnless.map((target) => target.key).join(", ")} is present`);
    }
  }
}

function requirementTargets(fields: Field[], owner: Field, declaration: string | undefined): Field[] {
  if (!declaration) return [];
  return declaration.split(/[ ,]+/u).filter(Boolean).map((reference) => {
    const target = resolveFieldReference(fields, reference);
    if (!target) throw new Error(`field ${owner.key} requirement names unknown flag ${JSON.stringify(reference)}`);
    return target;
  });
}

function resolveFieldReference(fields: Field[], reference: string): Field | undefined {
  const normalized = cleanFlagSpelling(reference);
  return fields.find((field) => field.key === normalized.replace(/^-+/u, "") || field.spellings.includes(normalized));
}

function booleanEnvironment(field: Field, value: unknown): string {
  if (value === true) return "true";
  if (value === false) return "false";
  throw new Error(`boolean flag ${field.key} requires a boolean`);
}

function appendRoutedOperand(argv: string[], field: Field, operand: string): void {
  if (field.kind === "flag") argv.push(field.spelling, operand);
  else argv.push(operand);
}

function enforceCount(field: Field, count: number): void {
  if (field.min !== undefined && count < field.min) throw new Error(`field ${field.key} requires at least ${field.min} occurrences`);
  if (field.max !== undefined && count > field.max) throw new Error(`field ${field.key} permits at most ${field.max} occurrences`);
}

function delimiterPresent(field: Field, configured: unknown): boolean {
  const mode = field.doubleDash;
  if (mode === undefined || mode === "automatic" || mode === "preserve") return false;
  if (mode === "required") return true;
  if (mode !== "optional") throw new Error(`field ${field.key} declares unknown double_dash mode ${JSON.stringify(mode)}`);
  const selected = isRecord(configured) ? configured[field.key] : configured;
  if (selected === undefined || selected === "present" || selected === true) return true;
  if (selected === "absent" || selected === false) return false;
  throw new Error(`delimiter configuration for ${field.key} must select present or absent`);
}

function parseExecAddress(location: string): string[] {
  const value = location.slice("exec:".length);
  if (!value || value.includes("  ")) throw new Error("malformed exec address");
  return value.split(" ");
}

async function executeProcess(request: ProcessRequest): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.argv[0]!, request.argv.slice(1), {
      env: request.environment,
      stdio: ["pipe", "pipe", "pipe"],
      signal: request.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode: code ?? -1,
      ...(signal ? { signal } : {}),
    }));
    child.stdin.end(request.stdin);
  });
}

function usageProcessDetails(result: ProcessResult): Record<string, unknown> {
  return {
    exitCode: result.exitCode,
    usage: { process: {
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      stdout: capturedProcessBytes(result.stdout, result.stdoutTruncated),
      stderr: capturedProcessBytes(result.stderr, result.stderrTruncated),
    } },
  };
}

function usageProcessTrailer(result: ProcessResult): Record<string, string[]> {
  const stderr = capturedProcessBytes(result.stderr, result.stderrTruncated);
  return {
    "x-exit-code": [String(result.exitCode)],
    ...(result.signal ? { "x-signal": [result.signal] } : {}),
    "x-stderr-base64": [stderr.base64],
    "x-stderr-byte-length": [String(stderr.byteLength)],
    ...(stderr.truncated ? { "x-stderr-truncated": ["true"] } : {}),
  };
}

function capturedProcessBytes(
  value: string | Uint8Array | undefined,
  truncated = false,
): { base64: string; byteLength: number; truncated?: true } {
  const bytes = outputBytes(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return {
    base64: btoa(binary),
    byteLength: bytes.byteLength,
    ...(truncated ? { truncated: true } : {}),
  };
}

async function firstInput(iterable: AsyncIterable<unknown>): Promise<unknown | undefined> {
  for await (const value of iterable) return value;
  return undefined;
}

function stringArgument(node: KDLNode | undefined): string | undefined {
  const value = node?.getArgument(0);
  return typeof value === "string" ? value : undefined;
}

function allStringArguments(node: KDLNode): string[] {
  const output: string[] = [];
  for (let index = 0; ; index++) {
    const value = node.getArgument(index);
    if (value === undefined) return output;
    if (typeof value === "string") output.push(value);
  }
}

function stringProperty(node: KDLNode | undefined, name: string): string | undefined {
  const value = node?.getProperty(name);
  return typeof value === "string" ? value : undefined;
}

function stringPropertyOrChild(node: KDLNode, name: string): string | undefined {
  return stringProperty(node, name) ?? stringArgument(node.children?.findNodeByName(name));
}

function cleanFlagSpelling(value: string): string {
  return value.endsWith("...") ? value.slice(0, -3) : value;
}

function cleanArgumentName(value: string): string {
  return value.replace(/\.\.\.$/u, "").replace(/^[<[\s]+|[>\]\s]+$/gu, "");
}

function numberProperty(node: KDLNode, name: string): number | undefined {
  const value = node.getProperty(name);
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function compareVersions(a: string, b: string): number {
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const difference = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("variadic/repeatable field requires an array");
  return value;
}

function outputBytes(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array();
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function diagnostic(value: string | Uint8Array | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function stripTrailingLineEndings(value: string): string {
  while (value.endsWith("\n")) value = value.slice(0, -1).replace(/\r$/, "");
  return value;
}

function compare(a: string, b: string): number {
  const aa = [...a], bb = [...b];
  for (let index = 0; index < Math.min(aa.length, bb.length); index++) {
    const delta = aa[index]!.codePointAt(0)! - bb[index]!.codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return aa.length - bb.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
