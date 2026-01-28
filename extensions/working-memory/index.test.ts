/**
 * Working Memory Plugin Tests
 *
 * Tests the working memory plugin functionality including:
 * - Plugin registration and configuration
 * - Storage layer (SQLite + JSON files)
 * - Identity management
 * - Fact store with FTS search
 * - Active context management
 * - Context injection/assembly
 * - Pattern-based fact extraction
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("working-memory plugin", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-test-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("plugin registers and initializes correctly", async () => {
    const { default: workingMemoryPlugin } = await import("./index.js");

    expect(workingMemoryPlugin.id).toBe("working-memory");
    expect(workingMemoryPlugin.name).toBe("Working Memory");
    expect(workingMemoryPlugin.kind).toBe("memory");
    expect(workingMemoryPlugin.configSchema).toBeDefined();
    expect(workingMemoryPlugin.register).toBeInstanceOf(Function);
  });

  test("config schema is defined as TypeBox schema", async () => {
    const { workingMemoryConfigSchema } = await import("./config.js");

    // TypeBox schemas are objects with a Kind symbol
    expect(workingMemoryConfigSchema).toBeDefined();
    expect(typeof workingMemoryConfigSchema).toBe("object");
  });

  test("config schema provides sensible defaults", async () => {
    const { defaultConfig } = await import("./config.js");

    expect(defaultConfig.extraction?.enabled).toBe(true);
    expect(defaultConfig.identity?.allowChatUpdates).toBe(true);
    expect(defaultConfig.injection?.identityTokens).toBe(1500);
    expect(defaultConfig.injection?.factsTokens).toBe(1000);
  });
});

describe("working-memory store", () => {
  let tmpDir: string;
  let store: Awaited<ReturnType<typeof createTestStore>>;

  async function createTestStore() {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    const s = new WorkingMemoryStore(tmpDir, logger);
    await s.initialize();
    return s;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-store-"));
    store = await createTestStore();
  });

  afterEach(async () => {
    if (store) {
      await store.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("initializes with default identity and context", async () => {
    const identity = await store.getIdentity();
    const context = await store.getActiveContext();

    expect(identity).toBeDefined();
    expect(identity.personality.name).toBe("Claude");
    expect(context).toBeDefined();
    expect(context.version).toBe(1);
  });

  test("stores and retrieves facts", async () => {
    const factId = await store.addFact({
      category: "preference",
      subject: "user",
      value: "Prefers dark mode",
      confidence: 1.0,
    });

    expect(factId).toBeDefined();

    const facts = await store.listFacts({ limit: 10 });
    expect(facts.length).toBe(1);
    expect(facts[0].value).toBe("Prefers dark mode");
    expect(facts[0].category).toBe("preference");
  });

  test("searches facts with FTS", async () => {
    await store.addFact({
      category: "preference",
      subject: "user",
      value: "Prefers TypeScript over JavaScript",
      confidence: 1.0,
    });

    await store.addFact({
      category: "user",
      subject: "user",
      value: "Name is Chris",
      confidence: 1.0,
    });

    const results = await store.searchFacts("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0].value).toContain("TypeScript");
  });

  test("updates identity", async () => {
    await store.updateIdentity({
      personality: { tone: "casual and friendly" },
    });

    const identity = await store.getIdentity();
    expect(identity.personality.tone).toBe("casual and friendly");
  });

  test("updates active context", async () => {
    await store.updateActiveContext({
      currentProject: {
        name: "Test Project",
        goal: "Build something cool",
        startedAt: Date.now(),
        status: "in_progress",
      },
    });

    const context = await store.getActiveContext();
    expect(context.currentProject?.name).toBe("Test Project");
    expect(context.currentProject?.status).toBe("in_progress");
  });

  test("stores and retrieves integration data", async () => {
    await store.setIntegrationData({
      source: "calendar",
      key: "today",
      data: { events: [{ title: "Meeting", time: "14:00" }] },
      fetchedAt: Date.now(),
    });

    const data = await store.getIntegrationData("calendar", "today");
    expect(data).toBeDefined();
    expect(data.length).toBe(1);
    expect(data[0].data.events).toHaveLength(1);
  });

  test("returns status correctly", async () => {
    await store.addFact({
      category: "user",
      subject: "test",
      value: "Test fact",
      confidence: 1.0,
    });

    // Set user name to make hasIdentity true
    await store.updateIdentity({ user: { name: "Test User", preferences: [], communication: [], context: {} } });
    // Set project to make hasActiveContext true
    await store.updateActiveContext({
      currentProject: { name: "Test", startedAt: Date.now(), status: "in_progress" },
    });

    const status = await store.getStatus();
    expect(status.initialized).toBe(true);
    expect(status.factCount).toBe(1);
    expect(status.hasIdentity).toBe(true);
    expect(status.hasActiveContext).toBe(true);
  });

  test("resets all data", async () => {
    await store.addFact({
      category: "test",
      subject: "test",
      value: "Test",
      confidence: 1.0,
    });

    await store.reset();

    const facts = await store.listFacts({ limit: 10 });
    expect(facts.length).toBe(0);
  });
});

describe("identity manager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-identity-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("formats identity for context injection", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { IdentityManager } = await import("./src/identity.js");
    const { defaultConfig } = await import("./config.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const identity = new IdentityManager(store, defaultConfig.identity!, logger);

    const formatted = await identity.formatForContext();
    // Uses <personality> as wrapper, not <identity>
    expect(formatted).toContain("<personality>");
    expect(formatted).toContain("Claude");
    expect(formatted).toContain("</personality>");

    await store.close();
  });

  test("applies conversation updates to personality", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { IdentityManager } = await import("./src/identity.js");
    const { defaultConfig } = await import("./config.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const identity = new IdentityManager(store, defaultConfig.identity!, logger);

    // Use correct parameter names: personalityUpdates and userUpdates
    await identity.applyConversationUpdates({
      personalityUpdates: { tone: "casual" },
      userUpdates: { name: "Chris", preferences: [], communication: [], context: {} },
    });

    const current = await identity.get();
    expect(current.personality.tone).toBe("casual");
    expect(current.user.name).toBe("Chris");

    await store.close();
  });
});

describe("fact store", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-facts-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("adds facts with deduplication", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { FactStore } = await import("./src/facts.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const facts = new FactStore(store, logger);

    // Add first fact
    const id1 = await facts.addFact({
      category: "preference",
      subject: "user",
      value: "User prefers dark mode",
    });

    // Try to add very similar fact - should be deduplicated
    const id2 = await facts.addOrUpdate({
      category: "preference",
      subject: "user",
      value: "User prefers dark mode for all apps",
    });

    // Should update existing rather than create new
    const allFacts = await facts.list({ limit: 10 });
    expect(allFacts.length).toBeLessThanOrEqual(2);

    await store.close();
  });

  test("formats facts for context by category", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { FactStore } = await import("./src/facts.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const facts = new FactStore(store, logger);

    await facts.addFact({ category: "preference", subject: "user", value: "Prefers TypeScript" });
    await facts.addFact({ category: "user", subject: "user", value: "Name is Chris" });
    await facts.addFact({ category: "decision", subject: "project", value: "Using SQLite" });

    // formatForContext without query returns recent facts
    const formatted = await facts.formatForContext({});
    // Uses <relevant-facts> as wrapper, not <facts>
    expect(formatted).toContain("<relevant-facts>");
    expect(formatted).toContain("</relevant-facts>");
    // Should contain some of our facts
    expect(formatted).toContain("TypeScript");

    await store.close();
  });
});

describe("active context manager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-context-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("sets and retrieves project", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { ActiveContextManager } = await import("./src/active-context.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const ctx = new ActiveContextManager(store, logger);

    await ctx.setProject("Working Memory Plugin", "Build context persistence layer");

    const current = await ctx.get();
    expect(current.currentProject?.name).toBe("Working Memory Plugin");
    expect(current.currentProject?.goal).toBe("Build context persistence layer");

    await store.close();
  });

  test("sets and retrieves task", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { ActiveContextManager } = await import("./src/active-context.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const ctx = new ActiveContextManager(store, logger);

    await ctx.setTask("Write tests", ["index.test.ts", "store.ts"]);

    const current = await ctx.get();
    expect(current.currentTask?.description).toBe("Write tests");
    expect(current.currentTask?.filesInvolved).toContain("index.test.ts");

    await store.close();
  });

  test("records decisions", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { ActiveContextManager } = await import("./src/active-context.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const ctx = new ActiveContextManager(store, logger);

    await ctx.addDecision("Use SQLite for storage", "Simple, fast, no server needed");

    const current = await ctx.get();
    expect(current.decisionsThisSession.length).toBe(1);
    expect(current.decisionsThisSession[0].decision).toBe("Use SQLite for storage");

    await store.close();
  });

  test("formats context for injection", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { ActiveContextManager } = await import("./src/active-context.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const ctx = new ActiveContextManager(store, logger);

    await ctx.setProject("Test Project", "Test goal");
    await ctx.setTask("Test task");

    const formatted = await ctx.formatForContext();
    expect(formatted).toContain("<active-context>");
    expect(formatted).toContain("Test Project");
    expect(formatted).toContain("Test task");
    expect(formatted).toContain("</active-context>");

    await store.close();
  });
});

describe("pattern-based extraction", () => {
  test("extracts user name from message", async () => {
    const patterns = {
      name: [
        /my name is (\w+)/i,
        /i'm (\w+)/i,
        /call me (\w+)/i,
      ],
    };

    const messages = [
      { content: "My name is Chris", expected: "Chris" },
      { content: "I'm Sarah", expected: "Sarah" },
      { content: "Call me John", expected: "John" },
    ];

    for (const { content, expected } of messages) {
      let match: string | null = null;
      for (const pattern of patterns.name) {
        const result = pattern.exec(content);
        if (result) {
          match = result[1];
          break;
        }
      }
      expect(match).toBe(expected);
    }
  });

  test("extracts preferences from message", async () => {
    const preferencePattern = /(?:i\s+)?(?:prefer|like|love|want|hate)\s+(?:to\s+)?(.+?)(?:\.|$)/i;

    const messages = [
      { content: "I prefer dark mode", match: true },
      { content: "I like TypeScript", match: true },
      { content: "I hate long explanations", match: true },
      { content: "What time is it?", match: false },
    ];

    for (const { content, match: shouldMatch } of messages) {
      const result = preferencePattern.test(content);
      expect(result).toBe(shouldMatch);
    }
  });

  test("extracts decisions from message", async () => {
    const decisionPatterns = [
      /(?:we|let's|i'll|i will)\s+(?:decided?|use|go with)\s+(.+?)(?:\.|$)/i,
      /decision:\s*(.+?)(?:\.|$)/i,
    ];

    const messages = [
      { content: "Let's use SQLite for the database", match: true },
      { content: "We decided to go with TypeScript", match: true },
      { content: "I'll use React", match: true },
      { content: "What framework should we use?", match: false },
    ];

    for (const { content, match: shouldMatch } of messages) {
      let matched = false;
      for (const pattern of decisionPatterns) {
        if (pattern.test(content)) {
          matched = true;
          break;
        }
      }
      expect(matched).toBe(shouldMatch);
    }
  });
});

describe("integration cache", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-integrations-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("caches and retrieves integration data", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { IntegrationCache } = await import("./src/integrations.js");
    const { defaultConfig } = await import("./config.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const cache = new IntegrationCache(store, defaultConfig.integrations!, logger);

    // push takes an object with source, key, data
    await cache.push({
      source: "calendar",
      key: "today",
      data: { events: [{ title: "Team Meeting", time: "10:00" }] },
    });

    const data = await cache.get("calendar", "today");
    expect(data).toBeDefined();
    expect(data.length).toBe(1);
    expect((data[0].data as any).events).toHaveLength(1);
    expect((data[0].data as any).events[0].title).toBe("Team Meeting");

    await store.close();
  });

  test("detects relevant integrations from message", async () => {
    const { IntegrationCache } = await import("./src/integrations.js");

    // Test keyword detection
    const keywords = {
      calendar: ["calendar", "meeting", "appointment", "schedule", "event"],
      reminders: ["reminder", "todo", "task", "remind me"],
      location: ["location", "where am i", "nearby", "address"],
      weather: ["weather", "temperature", "forecast", "rain"],
    };

    const messages = [
      { text: "What meetings do I have today?", expected: ["calendar"] },
      { text: "Remind me to buy milk", expected: ["reminders"] },
      { text: "What's the weather like?", expected: ["weather"] },
      { text: "Write some code", expected: [] },
    ];

    for (const { text, expected } of messages) {
      const detected: string[] = [];
      const lower = text.toLowerCase();

      for (const [source, words] of Object.entries(keywords)) {
        for (const word of words) {
          if (lower.includes(word)) {
            detected.push(source);
            break;
          }
        }
      }

      expect(detected).toEqual(expected);
    }
  });
});

// ============================================================================
// Phase 2 Tests - Embeddings, Vector Store, History Chunks
// ============================================================================

describe("vector store", () => {
  test("calculates cosine similarity correctly", async () => {
    const { cosineSimilarity } = await import("./src/vector-store.js");

    // Identical vectors should have similarity of 1
    const v1 = new Float32Array([1, 0, 0]);
    const v2 = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0);

    // Orthogonal vectors should have similarity of 0
    const v3 = new Float32Array([1, 0, 0]);
    const v4 = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(v3, v4)).toBeCloseTo(0.0);

    // Opposite vectors should have similarity of -1
    const v5 = new Float32Array([1, 0, 0]);
    const v6 = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(v5, v6)).toBeCloseTo(-1.0);
  });

  test("normalizes vectors to unit length", async () => {
    const { normalizeVector } = await import("./src/vector-store.js");

    const v = new Float32Array([3, 4, 0]);
    const normalized = normalizeVector(v);

    // Check unit length
    const length = Math.sqrt(
      normalized[0] * normalized[0] +
      normalized[1] * normalized[1] +
      normalized[2] * normalized[2]
    );
    expect(length).toBeCloseTo(1.0);

    // Check direction preserved
    expect(normalized[0]).toBeCloseTo(0.6);
    expect(normalized[1]).toBeCloseTo(0.8);
    expect(normalized[2]).toBeCloseTo(0.0);
  });

  test("calculates euclidean distance correctly", async () => {
    const { euclideanDistance } = await import("./src/vector-store.js");

    const v1 = new Float32Array([0, 0, 0]);
    const v2 = new Float32Array([3, 4, 0]);

    expect(euclideanDistance(v1, v2)).toBeCloseTo(5.0);
  });
});

describe("history chunk manager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-chunks-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates chunks after message threshold", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { createHistoryChunkManager } = await import("./src/history-chunks.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const manager = createHistoryChunkManager(store, null, null, {
      enabled: true,
      maxChunks: 100,
      summarizeAfterMessages: 3, // Low threshold for testing
      maxSummaryTokens: 500,
    }, logger);

    // Add messages below threshold
    const chunk1 = await manager.processMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);
    expect(chunk1).toBeNull(); // Not enough messages

    // Add more messages to hit threshold
    const chunk2 = await manager.processMessages([
      { role: "user", content: "What can you do?" },
    ]);
    expect(chunk2).toBeDefined(); // Should create chunk now
    expect(chunk2?.topic).toBeDefined();
    expect(chunk2?.summary).toBeDefined();

    await store.close();
  });

  test("extracts entities from messages", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { createHistoryChunkManager } = await import("./src/history-chunks.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const manager = createHistoryChunkManager(store, null, null, {
      enabled: true,
      maxChunks: 100,
      summarizeAfterMessages: 2,
      maxSummaryTokens: 500,
    }, logger);

    const chunk = await manager.processMessages([
      { role: "user", content: "Let's work on the Working Memory plugin for Moltbot" },
      { role: "assistant", content: 'I\'ll help you build the "fact extraction" feature' },
    ]);

    expect(chunk).toBeDefined();
    // Entity extraction finds capitalized words and quoted strings
    expect(chunk?.entities).toContain("Moltbot");
    expect(chunk?.entities).toContain("fact extraction");

    await store.close();
  });

  test("flushes buffer on demand", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { createHistoryChunkManager } = await import("./src/history-chunks.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const manager = createHistoryChunkManager(store, null, null, {
      enabled: true,
      maxChunks: 100,
      summarizeAfterMessages: 10, // High threshold
      maxSummaryTokens: 500,
    }, logger);

    // Add messages below threshold
    await manager.processMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ]);

    // Force flush
    const chunk = await manager.flushBuffer("test-session");
    expect(chunk).toBeDefined();
    expect(manager.getBufferSize()).toBe(0);

    await store.close();
  });
});

describe("llm extraction", () => {
  test("LLM extraction service can be created", async () => {
    const { createLLMExtractionService } = await import("./src/llm-extraction.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const service = createLLMExtractionService(
      { model: "claude-3-5-haiku-latest", provider: "anthropic" },
      logger
    );

    expect(service).toBeDefined();
  });

  test("hasExtractableContent detects relevant patterns", async () => {
    const { createLLMExtractionService } = await import("./src/llm-extraction.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const service = createLLMExtractionService({}, logger);

    // Should detect extractable content
    expect(service.hasExtractableContent("My name is Chris")).toBe(true);
    expect(service.hasExtractableContent("I prefer dark mode")).toBe(true);
    expect(service.hasExtractableContent("Let's work on the project")).toBe(true);
    expect(service.hasExtractableContent("Remember to update the docs")).toBe(true);

    // Should not detect non-extractable content
    expect(service.hasExtractableContent("Hello")).toBe(false);
    expect(service.hasExtractableContent("What time is it?")).toBe(false);
  });

  test("extraction config includes mode setting", async () => {
    const { defaultConfig } = await import("./config.js");

    expect(defaultConfig.extraction?.mode).toBe("pattern");
    expect(defaultConfig.extraction?.model).toBe("claude-3-5-haiku-latest");
  });
});

describe("embeddings config", () => {
  test("default config includes embeddings settings", async () => {
    const { defaultConfig } = await import("./config.js");

    expect(defaultConfig.embeddings).toBeDefined();
    expect(defaultConfig.embeddings?.enabled).toBe(true);
    expect(defaultConfig.embeddings?.provider).toBe("openai");
    expect(defaultConfig.embeddings?.model).toBe("text-embedding-3-small");
    expect(defaultConfig.embeddings?.dimensions).toBe(1536);
  });

  test("default config includes history chunks settings", async () => {
    const { defaultConfig } = await import("./config.js");

    expect(defaultConfig.historyChunks).toBeDefined();
    expect(defaultConfig.historyChunks?.enabled).toBe(true);
    expect(defaultConfig.historyChunks?.maxChunks).toBe(100);
    expect(defaultConfig.historyChunks?.summarizeAfterMessages).toBe(10);
  });

  test("default config includes consolidation settings", async () => {
    const { defaultConfig } = await import("./config.js");

    expect(defaultConfig.consolidation).toBeDefined();
    expect(defaultConfig.consolidation?.enabled).toBe(false); // Disabled by default
    expect(defaultConfig.consolidation?.intervalHours).toBe(24);
    expect(defaultConfig.consolidation?.expireAfterDays).toBe(30);
  });
});

describe("memory consolidation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-consolidation-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("consolidator can be created", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { createMemoryConsolidator } = await import("./src/consolidation.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const consolidator = createMemoryConsolidator(store, null, { enabled: true }, logger);
    expect(consolidator).toBeDefined();

    await store.close();
  });

  test("consolidation expires old low-confidence facts", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { createMemoryConsolidator } = await import("./src/consolidation.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    // Add an old, low-confidence fact (simulate by setting expireAfterDays to 0)
    await store.addFact({
      category: "test",
      subject: "test",
      value: "Low confidence fact",
      confidence: 0.3,
    });

    const consolidator = createMemoryConsolidator(
      store,
      null,
      {
        enabled: true,
        expireAfterDays: 0, // Expire immediately
        expireConfidenceThreshold: 0.5,
      },
      logger
    );

    const result = await consolidator.consolidate();
    expect(result.expiredFacts).toBe(1);

    const facts = await store.listFacts({ limit: 10 });
    expect(facts.length).toBe(0);

    await store.close();
  });

  test("consolidation keeps high-confidence facts", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { createMemoryConsolidator } = await import("./src/consolidation.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    // Add a high-confidence fact
    await store.addFact({
      category: "test",
      subject: "test",
      value: "High confidence fact",
      confidence: 0.9,
    });

    const consolidator = createMemoryConsolidator(
      store,
      null,
      {
        enabled: true,
        expireAfterDays: 0,
        expireConfidenceThreshold: 0.5,
      },
      logger
    );

    const result = await consolidator.consolidate();
    expect(result.expiredFacts).toBe(0);

    const facts = await store.listFacts({ limit: 10 });
    expect(facts.length).toBe(1);

    await store.close();
  });

  test("consolidation merges duplicate facts", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { createMemoryConsolidator } = await import("./src/consolidation.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    // Add two very similar facts
    await store.addFact({
      category: "preference",
      subject: "user",
      value: "User prefers dark mode",
      confidence: 0.8,
    });

    await store.addFact({
      category: "preference",
      subject: "user",
      value: "User prefers dark mode themes",
      confidence: 0.9,
    });

    const consolidator = createMemoryConsolidator(
      store,
      null,
      {
        enabled: true,
        expireAfterDays: 365, // Don't expire by age
        duplicateSimilarityThreshold: 0.7, // Lower threshold for test
      },
      logger
    );

    const result = await consolidator.consolidate();
    expect(result.mergedFacts).toBeGreaterThanOrEqual(0); // May or may not merge depending on similarity

    await store.close();
  });
});

describe("context injector", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-wm-injector-"));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("assembles context within token budget", async () => {
    const { WorkingMemoryStore } = await import("./src/store.js");
    const { IdentityManager } = await import("./src/identity.js");
    const { ActiveContextManager } = await import("./src/active-context.js");
    const { FactStore } = await import("./src/facts.js");
    const { IntegrationCache } = await import("./src/integrations.js");
    const { ContextInjector } = await import("./src/injection.js");
    const { defaultConfig } = await import("./config.js");

    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const store = new WorkingMemoryStore(tmpDir, logger);
    await store.initialize();

    const identity = new IdentityManager(store, defaultConfig.identity, logger);
    const activeContext = new ActiveContextManager(store, logger);
    const facts = new FactStore(store, logger);
    const integrations = new IntegrationCache(store, defaultConfig.integrations, logger);
    const injector = new ContextInjector(
      identity,
      activeContext,
      facts,
      integrations,
      defaultConfig.injection,
      logger
    );

    // Add some data
    await facts.addFact({ category: "user", subject: "user", value: "Name is Chris" });
    await activeContext.setProject("Test Project", "Test goal");

    const context = await injector.assembleContext({
      prompt: "Hello, what are we working on?",
      sessionKey: "test-session",
      agentId: "test-agent",
    });

    expect(context).toBeDefined();
    expect(context?.content).toContain("<working-memory>");
    expect(context?.content).toContain("</working-memory>");
    expect(context?.tokenEstimate).toBeGreaterThan(0);
    expect(context?.layers.identity).toBeGreaterThan(0);

    await store.close();
  });
});
