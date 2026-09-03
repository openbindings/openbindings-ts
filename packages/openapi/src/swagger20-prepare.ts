import { contextConfiguration, contextSatisfies, type ContextRequiredDetails, type ContextRequirement } from "@openbindings/invoke";
import {
  swagger20ConfigurationRequirement,
  swagger20CredentialRequirement,
  type Swagger20SynthesisOperation,
  type Swagger20SynthesisSecurityAlternative,
} from "@openbindings/openapi-client/engine";

/**
 * The side-effect-free preflight for the Swagger 2.0 lane (the `prepareBinding`
 * operation of the openbindings.binding-invoker role). It derives the selected
 * target's declared configuration and credential needs from the synthesis
 * model — the same model the invocation's own challenge is built from — so the
 * advisory answer and the authoritative one name the same points with the same
 * boundaries. `target` is the client's own asserted scope
 * (`PreparedSwagger20Operation.contextTarget()`): the resolved server base once
 * it resolves, else the source location, the same two scopes the 3.x preflight
 * asserts.
 *
 * `parameterConversion`, `requestContentCodings` and `responseContentCodings`
 * are deliberately absent from the credential/config challenge an INVOCATION
 * raises: those are runtime capabilities, not values an invocation context can
 * carry. They stay here because preflight is advisory and a tool may still want
 * to know the operation would need them.
 */
export function swagger20ConfigurationRequirements(
  operation: Swagger20SynthesisOperation,
  context: Record<string, unknown> | undefined,
  capabilities: { parameterConversion: boolean; requestContentCodings: boolean; responseContentCodings: boolean },
  target: string,
): ContextRequiredDetails | null {
  const configured = contextConfiguration(context) ?? {};
  const requirements: ContextRequirement[] = [];
  for (const declared of operation.requirements) {
    const point = declared.startsWith("configuration.") ? declared.slice("configuration.".length) : declared;
    switch (point) {
      case "server":
      case "security":
      case "requestMedia":
      case "emptyValueForm":
        if (Object.hasOwn(configured, point)) continue;
        break;
      case "propertyMedia": {
        const propertyMedia = asRecord(configured[point]) ?? {};
        for (const parameter of operation.parameters) {
          if (parameter.in !== "formData" || !parameter.required || parameter.schema.type !== "file") continue;
          if (propertyMedia[parameter.name] != null) continue;
          requirements.push(swagger20ConfigurationRequirement(point, `/${escapePointer(parameter.name)}`));
        }
        continue;
      }
      case "parameterConversion":
        if (capabilities.parameterConversion) continue;
        break;
      case "requestContentCodings":
        if (capabilities.requestContentCodings) continue;
        break;
      case "responseContentCodings":
        if (capabilities.responseContentCodings) continue;
        break;
      default:
        continue;
    }
    requirements.push(swagger20ConfigurationRequirement(point, ""));
  }
  return requirements.length === 0 ? null : { target, alternatives: [{ requirements }] };
}

/**
 * The credentials one selected security alternative needs. Selection itself is
 * reported by {@link swagger20ConfigurationRequirements}; credentials are
 * discoverable only after the caller chooses one complete alternative, never
 * volunteered or combined across alternatives (least privilege).
 */
export function swagger20SecurityRequirements(
  operation: Swagger20SynthesisOperation,
  selected: number | undefined,
  context: Record<string, unknown> | undefined,
  target: string,
): ContextRequiredDetails | null {
  const alternatives: Swagger20SynthesisSecurityAlternative[] = operation.security;
  if (alternatives.length === 0) return null;
  const index = selected ?? (alternatives.length === 1 ? 0 : -1);
  if (index === -1) return null;
  const alternative = alternatives[index];
  if (!alternative || !alternative.usable) throw new Error("selected Swagger 2.0 security alternative is unusable");
  if (alternative.anonymous) return null;
  const requirements: ContextRequirement[] = [];
  for (const scheme of alternative.schemes) {
    const requirement = swagger20CredentialRequirement(scheme.type ?? "", scheme.name, scheme.scopes);
    if (requirement === undefined) throw new Error(`unknown Swagger 2.0 security scheme type ${JSON.stringify(scheme.type)}`);
    requirements.push(requirement);
  }
  if (requirements.length === 0) return null;
  const details: ContextRequiredDetails = { target, alternatives: [{ requirements }] };
  return context && contextSatisfies(context, details) ? null : details;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
