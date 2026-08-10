import type { OBInterface, OperationRequirement } from "@openbindings/sdk";
import type { OpenAPIClient } from "@openbindings/openapi-client";
import type { OpenAPIInvoker } from "@openbindings/openapi";
import type { AsyncAPIInvoker } from "@openbindings/asyncapi";
import type { MCPInvoker } from "@openbindings/mcp";
import type { GrpcInvoker } from "@openbindings/grpc";
import type { ConnectInvoker } from "@openbindings/connect";
import type { UsageInvoker } from "@openbindings/usage";
import type { GraphQLInvoker } from "@openbindings/graphql";
import type { OperationGraphInvoker } from "@openbindings/operationgraph";

type PackedSurface = [
  OBInterface,
  OperationRequirement<unknown, unknown>,
  OpenAPIClient,
  OpenAPIInvoker,
  AsyncAPIInvoker,
  MCPInvoker,
  GrpcInvoker,
  ConnectInvoker,
  UsageInvoker,
  GraphQLInvoker,
  OperationGraphInvoker,
];

declare const surface: PackedSurface;
void surface;
