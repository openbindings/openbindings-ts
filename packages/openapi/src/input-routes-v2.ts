import type { ProjectionInputCorrespondence } from "@openbindings/openapi-client/provider";
import { codePointCompare } from "./util.js";

const JSONATA_UNDEFINED = '$lookup({},"__openbindings_absent")';

function quotedJSONata(value: string): string {
  return JSON.stringify(value);
}

function jsonataLookup(field: string): string {
  return `$lookup($,${quotedJSONata(field)})`;
}

function jsonataObject(fields: Record<string, string>): string {
  const pairs = Object.keys(fields).sort(codePointCompare).map(
    (key) => `${quotedJSONata(key)}:${jsonataLookup(fields[key]!)}`,
  );
  return `{${pairs.join(",")}}`;
}

/** Renders native correspondence facts into the Core JSONata boundary. */
export function projectionInputTransform(routes: ProjectionInputCorrespondence): string {
  const parameterFields: Record<string, string> = {};
  for (const route of routes.parameters) parameterFields[route.callerKey] = route.field;
  const parametersExpression = jsonataObject(parameterFields);
  let bodyExpression = jsonataObject(routes.bodyProperties);
  const bodyPresence = Object.values(routes.bodyProperties).map(
    (field) => `$exists(${jsonataLookup(field)})`,
  );
  const excluded = new Set<string>();
  for (const route of routes.parameters) excluded.add(route.field);
  for (const field of Object.values(routes.bodyProperties)) excluded.add(field);
  if (routes.wholeBodyField) excluded.add(routes.wholeBodyField);

  if (routes.openBody) {
    const conditions = [...excluded].sort(codePointCompare).map(
      (key) => `$key != ${quotedJSONata(key)}`,
    );
    const passthrough = `$sift($,function($value,$key){${conditions.length ? conditions.join(" and ") : "true"}})`;
    bodyExpression = Object.keys(routes.bodyProperties).length > 0
      ? `$merge([${passthrough},${bodyExpression}])`
      : passthrough;
    bodyPresence.push(`$count($keys(${passthrough})) > 0`);
  }
  if (routes.bodyRequired && !routes.wholeBodyField) bodyPresence.push("true");

  const parameterValue = `$count($keys($parameters)) > 0 ? $parameters : ${JSONATA_UNDEFINED}`;
  let bodyValue = JSONATA_UNDEFINED;
  if (Object.keys(routes.bodyProperties).length > 0 || routes.openBody || routes.bodyRequired) {
    bodyValue = `(${bodyPresence.length ? bodyPresence.join(" or ") : "false"}) ? $bodyObject : ${JSONATA_UNDEFINED}`;
  }
  if (routes.wholeBodyField) {
    const whole = jsonataLookup(routes.wholeBodyField);
    bodyValue = `$exists(${whole}) ? ${whole} : (${bodyValue})`;
  }
  return `($parameters := ${parametersExpression}; $bodyObject := ${bodyExpression}; {"parameters":${parameterValue},"body":${bodyValue}})`;
}
