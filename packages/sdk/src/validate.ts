import type { OBInterface, Transform } from "./types.js";
import { isTransformRef } from "./types.js";
import { isSupportedVersion, MIN_SUPPORTED_VERSION, MAX_TESTED_VERSION } from "./version.js";
import { isFormatToken, isValidFormatName } from "./format-token.js";
import { ValidationError } from "./errors.js";

export interface ValidateOptions {
  rejectUnknownTypedFields?: boolean;
  requireSupportedVersion?: boolean;
}

const SEMVERISH = /^\d+\.\d+\.\d+$/;

const KNOWN_INTERFACE_FIELDS = new Set([
  "openbindings", "name", "version", "description",
  "schemas", "operations", "roles",
  "sources", "bindings", "transforms", "security",
]);

const KNOWN_OPERATION_FIELDS = new Set([
  "description", "deprecated", "tags", "aliases", "satisfies",
  "idempotent", "input", "output", "examples",
]);

const KNOWN_SOURCE_FIELDS = new Set(["format", "location", "content", "description", "priority"]);
const KNOWN_BINDING_FIELDS = new Set([
  "operation", "source", "ref", "priority", "description", "deprecated",
  "inputTransform", "outputTransform", "security",
]);
const KNOWN_TRANSFORM_FIELDS = new Set(["type", "expression"]);
const KNOWN_SATISFIES_FIELDS = new Set(["role", "operation"]);
const KNOWN_EXAMPLE_FIELDS = new Set(["description", "input", "output"]);

/**
 * Performs shape-level validation checks on an OBInterface.
 * Throws {@link ValidationError} if problems are found.
 */
export function validateInterface(
  iface: OBInterface,
  opts: ValidateOptions = {},
): void {
  const errs: string[] = [];

  const ver = (iface.openbindings ?? "").trim();
  if (!ver) {
    errs.push("openbindings: required");
  } else if (!SEMVERISH.test(ver)) {
    errs.push("openbindings: must be MAJOR.MINOR.PATCH (e.g. 0.1.0)");
  } else if (opts.requireSupportedVersion) {
    if (!isSupportedVersion(ver)) {
      errs.push(
        `openbindings: unsupported version "${ver}" (supported ${MIN_SUPPORTED_VERSION}-${MAX_TESTED_VERSION})`,
      );
    }
  }

  if (iface.roles) {
    for (const [k, v] of Object.entries(iface.roles)) {
      if (!(v ?? "").trim()) {
        errs.push(`roles["${k}"]: value must be non-empty`);
      }
    }
  }

  if (!iface.operations) {
    errs.push("operations: required");
  }

  const opKeys = Object.keys(iface.operations ?? {}).sort();
  const aliasOwner = new Map<string, string>();
  const opKeySet = new Set(opKeys);

  for (const k of opKeys) {
    const op = iface.operations[k];

    for (const a of op.aliases ?? []) {
      if (!a.trim()) {
        errs.push(`operations["${k}"].aliases: must not contain empty strings`);
        continue;
      }
      if (opKeySet.has(a) && a !== k) {
        errs.push(`operations["${k}"].aliases: "${a}" conflicts with operation key "${a}"`);
        continue;
      }
      const owner = aliasOwner.get(a);
      if (owner && owner !== k) {
        errs.push(`operations["${k}"].aliases: "${a}" is also an alias of "${owner}"`);
        continue;
      }
      aliasOwner.set(a, k);
    }

    for (let idx = 0; idx < (op.satisfies ?? []).length; idx++) {
      const s = op.satisfies![idx];
      if (!(s.role ?? "").trim()) {
        errs.push(`operations["${k}"].satisfies[${idx}].role: required`);
      } else if (!iface.roles?.[s.role]) {
        errs.push(
          `operations["${k}"].satisfies[${idx}].role: references unknown role "${s.role}"`,
        );
      }
      if (!(s.operation ?? "").trim()) {
        errs.push(`operations["${k}"].satisfies[${idx}].operation: required`);
      }
    }

    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `operations["${k}"]`, op, KNOWN_OPERATION_FIELDS);
      for (let idx = 0; idx < (op.satisfies ?? []).length; idx++) {
        appendUnknown(errs, `operations["${k}"].satisfies[${idx}]`, op.satisfies![idx], KNOWN_SATISFIES_FIELDS);
      }
      for (const [ek, ex] of Object.entries(op.examples ?? {})) {
        appendUnknown(errs, `operations["${k}"].examples["${ek}"]`, ex, KNOWN_EXAMPLE_FIELDS);
      }
    }
  }

  for (const k of Object.keys(iface.sources ?? {}).sort()) {
    const src = iface.sources![k];
    const fmtVal = (src.format ?? "").trim();
    if (!fmtVal) {
      errs.push(`sources["${k}"].format: required`);
    } else if (!isFormatToken(fmtVal) && !isValidFormatName(fmtVal)) {
      errs.push(`sources["${k}"].format: invalid format "${src.format}"`);
    }
    const hasLoc = !!(src.location ?? "").trim();
    const hasCnt = src.content != null;
    if (hasLoc && hasCnt) errs.push(`sources["${k}"]: cannot have both location and content`);
    if (!hasLoc && !hasCnt) errs.push(`sources["${k}"]: must have location or content`);
    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `sources["${k}"]`, src, KNOWN_SOURCE_FIELDS);
    }
  }

  for (const k of Object.keys(iface.transforms ?? {}).sort()) {
    const tr = iface.transforms![k];
    validateInlineTransform(errs, `transforms["${k}"]`, tr);
    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `transforms["${k}"]`, tr, KNOWN_TRANSFORM_FIELDS);
    }
  }

  for (const k of Object.keys(iface.bindings ?? {}).sort()) {
    const b = iface.bindings![k];
    if (!(b.operation ?? "").trim()) {
      errs.push(`bindings["${k}"].operation: required`);
    } else if (!iface.operations?.[b.operation]) {
      errs.push(`bindings["${k}"].operation: references unknown operation "${b.operation}"`);
    }
    if (!(b.source ?? "").trim()) {
      errs.push(`bindings["${k}"].source: required`);
    } else if (!iface.sources?.[b.source]) {
      errs.push(`bindings["${k}"].source: references unknown source "${b.source}"`);
    }

    if (b.security != null && (b.security ?? "").trim()) {
      if (!iface.security?.[b.security]) {
        errs.push(`bindings["${k}"].security: references unknown security "${b.security}"`);
      }
    }

    if (b.inputTransform && isTransformRef(b.inputTransform)) {
      validateTransformRef(errs, `bindings["${k}"].inputTransform.$ref`, b.inputTransform.$ref, iface.transforms);
    }
    if (b.outputTransform && isTransformRef(b.outputTransform)) {
      validateTransformRef(errs, `bindings["${k}"].outputTransform.$ref`, b.outputTransform.$ref, iface.transforms);
    }
    if (b.inputTransform && !isTransformRef(b.inputTransform) && (b.inputTransform.type || b.inputTransform.expression)) {
      validateInlineTransform(errs, `bindings["${k}"].inputTransform`, b.inputTransform as Transform);
    }
    if (b.outputTransform && !isTransformRef(b.outputTransform) && (b.outputTransform.type || b.outputTransform.expression)) {
      validateInlineTransform(errs, `bindings["${k}"].outputTransform`, b.outputTransform as Transform);
    }

    if (opts.rejectUnknownTypedFields) {
      appendUnknown(errs, `bindings["${k}"]`, b, KNOWN_BINDING_FIELDS);
    }
  }

  if (opts.rejectUnknownTypedFields) {
    appendUnknown(errs, "", iface, KNOWN_INTERFACE_FIELDS);
  }

  if (errs.length > 0) throw new ValidationError(errs);
}

function appendUnknown(
  errs: string[],
  prefix: string,
  obj: Record<string, unknown>,
  known: Set<string>,
): void {
  const unknown = Object.keys(obj).filter(
    (k) => !known.has(k) && !k.startsWith("x-"),
  );
  if (unknown.length === 0) return;
  unknown.sort();
  const msg = `unknown fields: ${unknown.join(", ")}`;
  errs.push(prefix ? `${prefix}: ${msg}` : msg);
}

function validateTransformRef(
  errs: string[],
  prefix: string,
  ref: string,
  transforms?: Record<string, Transform>,
): void {
  const pfx = "#/transforms/";
  if (!ref.startsWith(pfx)) {
    errs.push(`${prefix}: must start with "${pfx}"`);
    return;
  }
  const name = ref.slice(pfx.length);
  if (!name) {
    errs.push(`${prefix}: transform name is empty`);
    return;
  }
  if (!transforms?.[name]) {
    errs.push(`${prefix}: references unknown transform "${name}"`);
  }
}

function validateInlineTransform(
  errs: string[],
  prefix: string,
  tr: Transform,
): void {
  if (!(tr.type ?? "").trim()) {
    errs.push(`${prefix}.type: required`);
  } else if (tr.type !== "jsonata") {
    errs.push(`${prefix}.type: must be "jsonata" (got "${tr.type}")`);
  }
  if (!(tr.expression ?? "").trim()) {
    errs.push(`${prefix}.expression: required`);
  }
}
