/**
 * The InvocationError classification model: category per code, effects per
 * dispatch path. These tests MUST agree with the Go SDK's classification_test.go
 * (the parity contract) and pin the code→category map to the binding-invoker
 * README registry (the anti-drift guard).
 */
import { describe, it, expect } from "vitest";
import {
  CODE_CATEGORY,
  categoryForCode,
  defaultEffectsForCode,
  httpErrorEffects,
  type Category,
} from "./classification.js";
import { InvocationError } from "./invocation.js";
import { ERR_CONNECT_FAILED, ERR_TIMEOUT, ERR_VALIDATION_FAILED } from "./errcodes.js";

// Transcribed VERBATIM from the binding-invoker README "Standard error codes"
// registry — the independent source of truth. If CODE_CATEGORY drifts from the
// contract, the first test fails.
const README_CATEGORIES: Record<string, Category> = {
  // Normative codes.
  CONTEXT_REQUIRED: "context",
  ERR_PROTOCOL: "protocol",
  ERR_TRANSPORT_CLOSED: "transient",
  ERR_CANCELLED: "cancelled",
  ERR_VALIDATION_FAILED: "validation",
  ERR_BINDING_NOT_FOUND: "permanent",
  // Convention codes.
  ERR_AUTH_REQUIRED: "auth",
  ERR_PERMISSION_DENIED: "auth",
  ERR_INVALID_REF: "permanent",
  ERR_REF_NOT_FOUND: "permanent",
  ERR_SCHEMA_UNRESOLVED: "validation",
  ERR_SOURCE_LOAD_FAILED: "permanent",
  ERR_SOURCE_CONFIG_ERROR: "permanent",
  ERR_CONNECT_FAILED: "transient",
  ERR_EXECUTION_FAILED: "service",
  ERR_RESPONSE_ERROR: "service",
  ERR_STREAM_ERROR: "transient",
  ERR_TIMEOUT: "transient",
  ERR_OPERATION_NOT_FOUND: "permanent",
  ERR_UNKNOWN_SOURCE: "permanent",
  ERR_TRANSFORM_ERROR: "validation",
  ERR_INPUT_CLOSED: "protocol",
  ERR_INVOCATION_CLOSED: "protocol",
  ERR_TOO_MANY_INPUTS: "protocol",
  ERR_MISSING_INPUT: "protocol",
  ERR_ALREADY_CONSUMED: "protocol",
  ERR_EXPECTED_SINGLE: "protocol",
  ERR_TYPE_MISMATCH: "validation",
  ERR_EVENT_LIMIT_EXCEEDED: "permanent",
  ERR_OPERATION_GRAPH_EXIT: "service",
  ERR_UNSUPPORTED_FORMAT_VERSION: "permanent",
  ERR_RUNTIME: "permanent",
};

describe("code→category map", () => {
  it("matches the README registry for every code (anti-drift guard)", () => {
    for (const [code, want] of Object.entries(README_CATEGORIES)) {
      expect(categoryForCode(code), `categoryForCode(${code})`).toBe(want);
    }
  });

  it("has no registry entries beyond the README (only TIMEOUT_EXCEEDED extra)", () => {
    for (const code of Object.keys(CODE_CATEGORY)) {
      if (code in README_CATEGORIES) continue;
      expect(code, `unexpected map entry ${code}`).toBe("TIMEOUT_EXCEEDED");
    }
  });

  it("classifies TIMEOUT_EXCEEDED (the operation-graph promotion) as transient", () => {
    expect(categoryForCode("TIMEOUT_EXCEEDED")).toBe("transient");
  });

  it("defaults unknown / third-party codes to permanent", () => {
    expect(categoryForCode("ERR_SOME_THIRD_PARTY_CODE")).toBe("permanent");
    expect(categoryForCode("")).toBe("permanent");
  });
});

describe("effects at dispatch-aware sites", () => {
  it("connect-failed is none (never dispatched); timeout/stream/transport are possible", () => {
    expect(defaultEffectsForCode("ERR_CONNECT_FAILED")).toBe("none");
    expect(defaultEffectsForCode("ERR_TIMEOUT")).toBe("possible");
    expect(defaultEffectsForCode("ERR_STREAM_ERROR")).toBe("possible");
    expect(defaultEffectsForCode("ERR_TRANSPORT_CLOSED")).toBe("possible");
    expect(defaultEffectsForCode("TIMEOUT_EXCEEDED")).toBe("possible");
  });

  it("carries no default for non-transport codes (omitted => possible)", () => {
    expect(defaultEffectsForCode("ERR_VALIDATION_FAILED")).toBeUndefined();
    expect(defaultEffectsForCode("ERR_AUTH_REQUIRED")).toBeUndefined();
    expect(defaultEffectsForCode("ERR_PROTOCOL")).toBeUndefined();
  });

  it("maps HTTP 429/503 to none (definitively refused), else undefined", () => {
    expect(httpErrorEffects(429)).toBe("none");
    expect(httpErrorEffects(503)).toBe("none");
    expect(httpErrorEffects(500)).toBeUndefined();
    expect(httpErrorEffects(404)).toBeUndefined();
    expect(httpErrorEffects(401)).toBeUndefined();
  });
});

describe("InvocationError constructor", () => {
  it("derives category from code and the transport effects default", () => {
    const conn = new InvocationError(ERR_CONNECT_FAILED, "refused");
    expect(conn.category).toBe("transient");
    expect(conn.effects).toBe("none"); // connect never dispatched → auto-retry safe

    const to = new InvocationError(ERR_TIMEOUT, "deadline");
    expect(to.category).toBe("transient");
    expect(to.effects).toBe("possible"); // dispatched → not auto-retry safe
  });

  it("leaves effects unset for categories where retry is not in question", () => {
    const v = new InvocationError(ERR_VALIDATION_FAILED, "bad input");
    expect(v.category).toBe("validation");
    expect(v.effects).toBeUndefined();
  });

  it("honors an explicit effects argument (HTTP 429/503 → none)", () => {
    const e = new InvocationError("ERR_EXECUTION_FAILED", "HTTP 503", { status: 503 }, httpErrorEffects(503));
    expect(e.category).toBe("service");
    expect(e.effects).toBe("none");
  });

  it("serializes category always, effects when set, into the wire shape", () => {
    const conn = new InvocationError(ERR_CONNECT_FAILED, "refused");
    const wire = { code: conn.code, message: conn.message, category: conn.category, effects: conn.effects };
    expect(wire.category).toBe("transient");
    expect(wire.effects).toBe("none");

    const v = new InvocationError(ERR_VALIDATION_FAILED, "bad");
    expect(v.category).toBe("validation");
    expect(v.effects).toBeUndefined(); // omitted → consumer treats as possible
  });
});
