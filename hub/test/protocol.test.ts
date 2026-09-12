import { describe, expect, test } from "bun:test";
import {
  AgentToHubSchema,
  HubToUiSchema,
  InputBodySchema,
  MessageBodySchema,
  ResizeBodySchema,
} from "../src/protocol";

describe("protocol bounds", () => {
  test("message text is bounded to 64k and non-empty", () => {
    expect(MessageBodySchema.safeParse({ text: "" }).success).toBe(false);
    expect(MessageBodySchema.safeParse({ text: "x".repeat(64_000) }).success).toBe(true);
    expect(MessageBodySchema.safeParse({ text: "x".repeat(64_001) }).success).toBe(false);
  });

  test("raw input is bounded to 8k of base64", () => {
    expect(InputBodySchema.safeParse({ data: "a".repeat(8192) }).success).toBe(true);
    expect(InputBodySchema.safeParse({ data: "a".repeat(8193) }).success).toBe(false);
  });

  test("resize dimensions are 2..1000 integers", () => {
    expect(ResizeBodySchema.safeParse({ cols: 1, rows: 24 }).success).toBe(false);
    expect(ResizeBodySchema.safeParse({ cols: 80.5, rows: 24 }).success).toBe(false);
    expect(ResizeBodySchema.safeParse({ cols: 1000, rows: 2 }).success).toBe(true);
    expect(ResizeBodySchema.safeParse({ cols: 1001, rows: 2 }).success).toBe(false);
  });

  test("agent replies are bounded to 256k and unions reject foreign types", () => {
    expect(AgentToHubSchema.safeParse({ type: "reply", text: "x".repeat(256_000) }).success).toBe(true);
    expect(AgentToHubSchema.safeParse({ type: "reply", text: "x".repeat(256_001) }).success).toBe(false);
    expect(AgentToHubSchema.safeParse({ type: "message", id: "1", text: "hub frame" }).success).toBe(false);
    expect(HubToUiSchema.safeParse({ type: "session_removed", id: "s" }).success).toBe(true);
    expect(HubToUiSchema.safeParse({ type: "hello", sessionId: "s" }).success).toBe(false);
  });
});
