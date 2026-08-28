import { InvocationError } from "@openbindings/invoke";
import {
  OpenAPIWireMechanicsError,
  governOpenAPIRequest,
  governOpenAPIResponse,
  normalizeOpenAPIContentCodings,
  prepareOpenAPIUnaryResponseView,
  type OpenAPIContentCodingResult,
  type OpenAPIContentDecoder,
  type OpenAPIContentEncoder,
  type OpenAPIResponseMechanicsModel,
} from "@openbindings/openapi-client/analysis";
import type { OpenAPIOperation } from "./types.js";

export const ACTUAL_CONTENT_TYPE_HEADER = "X-Openbindings-Actual-Content-Type";
export const UNARY_EVENT_STREAM_TYPE = "application/x-openbindings-event-stream-unary";

export type ContentCodingResult = OpenAPIContentCodingResult;
export type ContentEncoder = OpenAPIContentEncoder;
export type ContentDecoder = OpenAPIContentDecoder;
export type MediaGovernanceModel = OpenAPIResponseMechanicsModel;

export function normalizeContentCodings<T>(
  input: Record<string, T> | undefined,
  direction: "request" | "response",
): { codecs: ReadonlyMap<string, T>; defect?: Error } {
  return normalizeOpenAPIContentCodings(input, direction);
}

export async function governRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  model: MediaGovernanceModel,
  codecs: ReadonlyMap<string, ContentEncoder>,
): Promise<{ input: RequestInfo | URL; init: RequestInit | undefined }> {
  try {
    return await governOpenAPIRequest(input, init, model, codecs);
  } catch (error: unknown) {
    throw adapterTransportError(error);
  }
}

export async function governResponse(
  response: Response,
  model: MediaGovernanceModel,
  codecs: ReadonlyMap<string, ContentDecoder>,
): Promise<Response> {
  const nativeModel: OpenAPIResponseMechanicsModel = {
    ...model,
    unaryEventStream: {
      actualContentTypeHeader: ACTUAL_CONTENT_TYPE_HEADER,
      mediaType: UNARY_EVENT_STREAM_TYPE,
    },
  };
  try {
    const result = await governOpenAPIResponse(response, nativeModel, codecs);
    model.emptyResponse = nativeModel.emptyResponse;
    return result;
  } catch (error: unknown) {
    model.emptyResponse = nativeModel.emptyResponse;
    throw adapterTransportError(error);
  }
}

export function prepareEngineResponseView(operation: OpenAPIOperation): void {
  prepareOpenAPIUnaryResponseView(operation, UNARY_EVENT_STREAM_TYPE);
}

function adapterTransportError(error: unknown): unknown {
  if (!(error instanceof OpenAPIWireMechanicsError)) return error;
  if (error.code === "ERR_REFUSED") {
    return new InvocationError(error.code, { message: error.message });
  }
  return new InvocationError(error.code);
}
