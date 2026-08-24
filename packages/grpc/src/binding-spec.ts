import { checkBindingSpecs as checkBindingSpecSupport } from "@openbindings/core";
import type { BindingSpecInfo, BindingSpecVerdict } from "@openbindings/core";

export const BINDING_SPEC = "openbindings.grpc@1";

export function grpcBindingSpecs(): BindingSpecInfo[] {
  return [{ bindingSpec: BINDING_SPEC, description: "gRPC via protobuf schemas or server reflection" }];
}

export function checkGrpcBindingSpecs(bindingSpecs: readonly string[]): BindingSpecVerdict[] {
  return checkBindingSpecSupport(bindingSpecs, grpcBindingSpecs());
}
