import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { OBInterface } from "@openbindings/core";
import type { SynthesisCoverageEntry } from "@openbindings/synthesize";
import type { MCPDiscovery } from "./synthesize.js";
import { BINDING_SPEC, DEFAULT_SOURCE_NAME } from "./constants.js";

/** Accounts for every entity in the pagination-exhausted MCP listing. */
export function mcpSynthesisCoverage(
  disc: MCPDiscovery | undefined,
  iface: OBInterface,
): SynthesisCoverageEntry[] {
  if (!disc) return [];
	const bindingSpec = iface.sources?.[DEFAULT_SOURCE_NAME]?.bindingSpec ?? BINDING_SPEC;
  const represented = new Map<string, { operationKey: string; bindingRef: string }>();
  for (const binding of Object.values(iface.bindings ?? {})) {
    if (binding.ref) represented.set(binding.ref, { operationKey: binding.operation, bindingRef: binding.ref });
  }
  const counts = (values: string[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  };
  const toolCounts = counts(disc.tools.map((entity) => entity.name));
  const resourceCounts = counts(disc.resources.map((entity) => entity.uri));
  const templateCounts = counts(disc.resourceTemplates.map((entity) => entity.uriTemplate));
  const promptCounts = counts(disc.prompts.map((entity) => entity.name));
  const entries: SynthesisCoverageEntry[] = [];

  const add = (
    family: string,
    value: string,
    index: number,
    count: number,
    disposition?: { status: "invalid" | "excluded"; reasonCode: string; rule?: string; message: string },
  ): void => {
    const ref = `${family}/${value}`;
    const sourceRef = count > 1 || value === "" ? `${ref}#listing-index=${index}` : ref;
    if (disposition) {
      entries.push({
        sourceIndex: 0,
        sourceRef,
        scope: "target",
        ...disposition,
      });
      return;
    }
    const identity = represented.get(ref);
    if (!identity) {
      entries.push({
        sourceIndex: 0,
        sourceRef,
        scope: "target",
        status: "implementation-unsupported",
        reasonCode: "mcp.missing_emitted_binding",
        message: "the synthesizer returned without emitting this resolvable listed entity",
      });
      return;
    }
    entries.push({
      sourceIndex: 0,
      sourceRef,
      scope: "target",
      status: "represented",
      operationKey: identity.operationKey,
      bindingRef: identity.bindingRef,
    });
  };

  disc.tools.forEach((entity, index) => {
    const count = toolCounts.get(entity.name) ?? 0;
    if (!entity.name) add("tools", "", index, count, { status: "invalid", reasonCode: "mcp.invalid_entity", message: "tool name is empty" });
    else if (count > 1) add("tools", entity.name, index, count, { status: "excluded", reasonCode: "mcp.ambiguous_identity", rule: "MCP-P-02", message: "more than one listed tool has this ref identity" });
    else if (entity.taskSupport === "required") add("tools", entity.name, index, count, { status: "excluded", reasonCode: "mcp.required_task", rule: "MCP-P-08", message: "the tool requires task augmentation, which this binding revision excludes" });
    else if (bindingSpec === BINDING_SPEC && entity.outputSchema === undefined) add("tools", entity.name, index, count, { status: "excluded", reasonCode: "mcp.missing_application_output_schema", rule: "MCP-P-04", message: "the tool listing does not declare an application outputSchema" });
    else add("tools", entity.name, index, count);
  });
  disc.resources.forEach((entity, index) => {
    const count = resourceCounts.get(entity.uri) ?? 0;
    if (!entity.uri) add("resources", "", index, count, { status: "invalid", reasonCode: "mcp.invalid_entity", message: "resource URI is absent" });
    else if (count > 1) add("resources", entity.uri, index, count, { status: "excluded", reasonCode: "mcp.ambiguous_identity", rule: "MCP-P-02", message: "more than one listed resource has this ref identity" });
    else if (bindingSpec === BINDING_SPEC) add("resources", entity.uri, index, count, { status: "excluded", reasonCode: "mcp.no_application_output_contract", rule: "MCP-P-04", message: "MCP resource listings do not declare an application output schema" });
    else add("resources", entity.uri, index, count);
  });
  disc.resourceTemplates.forEach((entity, index) => {
    const count = templateCounts.get(entity.uriTemplate) ?? 0;
    if (!entity.uriTemplate) add("resourceTemplates", "", index, count, { status: "invalid", reasonCode: "mcp.invalid_entity", message: "resource template identity is absent" });
    else if (count > 1) add("resourceTemplates", entity.uriTemplate, index, count, { status: "excluded", reasonCode: "mcp.ambiguous_identity", rule: "MCP-P-02", message: "more than one listed resource template has this ref identity" });
    else {
      try {
        new UriTemplate(entity.uriTemplate);
        if (bindingSpec === BINDING_SPEC) add("resourceTemplates", entity.uriTemplate, index, count, { status: "excluded", reasonCode: "mcp.no_application_output_contract", rule: "MCP-P-04", message: "MCP resource-template listings do not declare an application output schema" });
        else add("resourceTemplates", entity.uriTemplate, index, count);
      } catch (error: unknown) {
        add("resourceTemplates", entity.uriTemplate, index, count, {
          status: "invalid",
          reasonCode: "mcp.invalid_entity",
          message: `resource template is not valid RFC 6570: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  });
  disc.prompts.forEach((entity, index) => {
    const count = promptCounts.get(entity.name) ?? 0;
    if (!entity.name) add("prompts", "", index, count, { status: "invalid", reasonCode: "mcp.invalid_entity", message: "prompt name is empty" });
    else if (count > 1) add("prompts", entity.name, index, count, { status: "excluded", reasonCode: "mcp.ambiguous_identity", rule: "MCP-P-02", message: "more than one listed prompt has this ref identity" });
    else if (bindingSpec === BINDING_SPEC) add("prompts", entity.name, index, count, { status: "excluded", reasonCode: "mcp.no_application_output_contract", rule: "MCP-P-04", message: "MCP prompt listings do not declare an application output schema" });
    else add("prompts", entity.name, index, count);
  });
  return entries;
}
