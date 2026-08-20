/** Thrown when no synthesizer matches the requested binding specification. */
export class NoSynthesizerError extends Error {
  constructor(bindingSpec: string) {
    super(`openbindings: no synthesizer for format: ${bindingSpec}`);
    this.name = "NoSynthesizerError";
  }
}

/** Thrown when the selected synthesizer has no durable coverage capability. */
export class SynthesisCoverageUnsupportedError extends Error {
  constructor(bindingSpec: string) {
    super(`openbindings: synthesis coverage unsupported for format: ${bindingSpec}`);
    this.name = "SynthesisCoverageUnsupportedError";
  }
}

/** Thrown when an operation requires sources but none were provided. */
export class NoSourcesError extends Error {
  constructor() {
    super("openbindings: no sources provided");
    this.name = "NoSourcesError";
  }
}

/** Thrown by single-source synthesizers handed a multi-source input.
 * Multi-source composition is implementation-defined; answering for a
 * subset silently is never legitimate — synthesize per source and merge,
 * or use a multi-source synthesizer. */
export class MultipleSourcesError extends Error {
  constructor() {
    super("openbindings: this synthesizer composes one source per call; synthesize per source and merge, or use a multi-source synthesizer");
    this.name = "MultipleSourcesError";
  }
}
