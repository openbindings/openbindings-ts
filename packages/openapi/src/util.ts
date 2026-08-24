export * from "@openbindings/openapi-client/analysis";
// The standalone client's analysis surface names the binding selector
// `ref`; the OpenBindings package adapts it to selector-based names here.
export {
  parseRef as parseSelector,
  buildJsonPointerRef as buildJsonPointerSelector,
} from "@openbindings/openapi-client/analysis";
