import type {
  BindingProvider,
  OBInterface,
  OpenBindingsRuntime,
  OperationRequirement,
} from "@openbindings/sdk";
import type { OpenAPIClient } from "@openbindings/openapi-client";
import type { AsyncAPIClient } from "@openbindings/asyncapi-client";
import type { OpenAPIAdapter, OpenAPIInvoker } from "@openbindings/openapi";
import type { AsyncAPIInvoker } from "@openbindings/asyncapi";
import type { MCPInvoker } from "@openbindings/mcp";
import type { GrpcInvoker } from "@openbindings/grpc";
import type { ConnectInvoker } from "@openbindings/connect";
import type { UsageInvoker } from "@openbindings/usage";
import type { GraphQLInvoker } from "@openbindings/graphql";
import type { OperationGraphInvoker } from "@openbindings/operationgraph";
import { OpenBindingsRuntime as Runtime } from "@openbindings/sdk";
import { OpenAPIAdapter as Adapter, decimalParameterConversion } from "@openbindings/openapi";
import jsonata from "jsonata";

// Type-check the explicit evaluator setup shown in the SDK quick start.
const runtime = new Runtime({
  providers: [new Adapter({ parameterConversion: decimalParameterConversion })],
  transformEvaluator: {
    evaluate: (expression, data) => jsonata(expression).evaluate(data),
  },
});
void runtime;

type PackedSurface = [
  OBInterface,
  BindingProvider,
  OpenBindingsRuntime,
  OperationRequirement<unknown, unknown>,
  OpenAPIClient,
  OpenAPIAdapter,
  AsyncAPIClient,
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
