declare module "core-js-pure/actual/json/parse.js" {
  const parse: (text: string, reviver?: (key: string, value: unknown, context: {source?: string}) => unknown) => unknown;
  export default parse;
}
declare module "core-js-pure/actual/json/stringify.js" {
  const stringify: (value: unknown, replacer?: (key: string, value: unknown) => unknown, space?: number | string) => string | undefined;
  export default stringify;
}
declare module "core-js-pure/actual/json/raw-json.js" {
  const rawJSON: (text: string) => unknown;
  export default rawJSON;
}
declare module "core-js-pure/actual/json/is-raw-json.js" {
  const isRawJSON: (value: unknown) => boolean;
  export default isRawJSON;
}
