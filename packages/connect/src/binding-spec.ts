import { checkBindingSpecs as checkBindingSpecSupport } from "@openbindings/core";
import type { BindingSpecInfo, BindingSpecVerdict } from "@openbindings/core";

export const BINDING_SPEC = "openbindings.connect@1";

export function connectBindingSpecs(): BindingSpecInfo[] {
  return [{ bindingSpec: BINDING_SPEC, description: "Connect protocol with JSON codec" }];
}

export function checkConnectBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
  return checkBindingSpecSupport(bindingSpecs, connectBindingSpecs());
}
