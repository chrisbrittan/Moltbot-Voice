import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  repairToolCallInputs,
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairing,
} from "./session-transcript-repair.js";

describe("sanitizeToolUseResultPairing", () => {
  it("moves tool results directly after tool calls and inserts missing results", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          { type: "toolCall", id: "call_2", name: "exec", arguments: {} },
        ],
      },
      { role: "user", content: "user message that should come after tool use" },
      {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("toolResult");
    expect((out[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(out[2]?.role).toBe("toolResult");
    expect((out[2] as { toolCallId?: string }).toolCallId).toBe("call_2");
    expect(out[3]?.role).toBe("user");
  });

  it("drops duplicate tool results for the same id within a span", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second" }],
        isError: false,
      },
      { role: "user", content: "ok" },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });

  it("drops duplicate tool results for the same id across the transcript", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "first" }],
        isError: false,
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "second (duplicate)" }],
        isError: false,
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    const results = out.filter((m) => m.role === "toolResult") as Array<{
      toolCallId?: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe("call_1");
  });

  it("does not create synthetic results for error-stopped tool calls after input repair", () => {
    // Simulates the real scenario: assistant has a malformed tool call with stopReason "error".
    // After sanitizeToolCallInputs strips it, sanitizeToolUseResultPairing should not see it.
    const input: AgentMessage[] = [
      { role: "user", content: "send a message" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll send that now" },
          {
            type: "toolCall",
            id: "call_broken",
            name: "message",
            arguments: { action: "send", targets: 123 },
          },
        ],
        stopReason: "error",
      } as AgentMessage,
      { role: "user", content: "what happened?" },
    ];

    // First pass: strip broken tool calls
    const repaired = sanitizeToolCallInputs(input);
    // Second pass: should not insert synthetic results for the stripped call
    const paired = sanitizeToolUseResultPairing(repaired);

    expect(paired.some((m) => m.role === "toolResult")).toBe(false);
    expect(paired.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("drops orphan tool results that do not match any tool call", () => {
    const input = [
      { role: "user", content: "hello" },
      {
        role: "toolResult",
        toolCallId: "call_orphan",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeToolUseResultPairing(input);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("sanitizeToolCallInputs", () => {
  it("drops tool calls missing input or arguments", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read" }],
      },
      { role: "user", content: "hello" },
    ];

    const out = sanitizeToolCallInputs(input);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("strips tool calls from assistant messages with stopReason error", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me send that message" },
          {
            type: "toolCall",
            id: "call_broken",
            name: "message",
            arguments: { action: "send", channel: "telegram", targets: 123 },
          },
        ],
        stopReason: "error",
      } as AgentMessage,
    ];

    const report = repairToolCallInputs(input);
    expect(report.droppedToolCalls).toBe(1);
    // Text block preserved, tool call stripped
    const assistant = report.messages[0] as Extract<AgentMessage, { role: "assistant" }>;
    const types = Array.isArray(assistant.content)
      ? assistant.content.map((block) => (block as { type?: unknown }).type)
      : [];
    expect(types).toEqual(["text"]);
  });

  it("drops entire assistant message with stopReason error when only tool calls", () => {
    const input: AgentMessage[] = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_broken",
            name: "message",
            arguments: { action: "send" },
          },
        ],
        stopReason: "error",
      } as AgentMessage,
      { role: "user", content: "hello again" },
    ];

    const report = repairToolCallInputs(input);
    expect(report.droppedToolCalls).toBe(1);
    expect(report.droppedAssistantMessages).toBe(1);
    expect(report.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("keeps valid tool calls and preserves text blocks", () => {
    const input: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "toolUse", id: "call_ok", name: "read", input: { path: "a" } },
          { type: "toolCall", id: "call_drop", name: "read" },
        ],
      },
    ];

    const out = sanitizeToolCallInputs(input);
    const assistant = out[0] as Extract<AgentMessage, { role: "assistant" }>;
    const types = Array.isArray(assistant.content)
      ? assistant.content.map((block) => (block as { type?: unknown }).type)
      : [];
    expect(types).toEqual(["text", "toolUse"]);
  });
});
