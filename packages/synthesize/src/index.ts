export type {
  SynthesizeSource,
  SynthesizeInput,
  SynthesizerWarning,
  SynthesisCoverageScope,
  SynthesisCoverageStatus,
  SynthesisCoverageEntry,
  SynthesisCoverage,
  SynthesisCoverageLimitation,
  SynthesizeResult,
  BindableTarget,
  SourceInspection,
  InspectionLimitation,
} from "./synthesizer-types.js";
export {
  synthesisSkeleton,
  finalizeSynthesis,
  finalizeSynthesisCoverage,
  representedCoverageEntries,
} from "./synthesizer-types.js";

export type {
  InterfaceSynthesizer,
  CoverageSynthesizer,
  SourceInspector,
} from "./synthesizer.js";
export { isInterfaceSynthesizer } from "./synthesizer.js";

export {
  combineSynthesizers,
  combineSourceInspectors,
  type CombinedSynthesizer,
} from "./combiners.js";

export {
  NoSynthesizerError,
  SynthesisCoverageUnsupportedError,
  NoSourcesError,
  MultipleSourcesError,
} from "./errors.js";

export { fetchInterface } from "./fetch.js";
export type { FetchInterfaceOptions, FetchedInterface } from "./fetch.js";

export {
  SYNTHESIS_SCENARIO_FORMAT,
  fixedSynthesizer,
  matchSynthesisScenario,
  normalizeSynthesis,
  parseSynthesisScenarioFile,
  verifySynthesisScenario,
} from "./synthesis-scenarios.js";
export type {
  RefusedScenarioExpected,
  SynthesisSynthesizerFactory,
  SynthesisScenarioFile,
  SynthesisScenario,
  SynthesisScenarioExpected,
  SynthesizedScenarioExpected,
  NormalizedSynthesis,
  SynthesisBindingIdentity,
  NormalizedSynthesisCoverageEntry,
} from "./synthesis-scenarios.js";
