/**
 * Working Memory Plugin Configuration
 */

import { Type, type Static } from "@sinclair/typebox";

/**
 * Configuration schema for the Working Memory plugin
 */
export const workingMemoryConfigSchema = Type.Object({
  // Embeddings settings (Phase 2)
  embeddings: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      provider: Type.Optional(
        Type.String({
          description: "Embedding provider: openai or ollama",
          default: "openai",
        })
      ),
      model: Type.Optional(
        Type.String({
          description: "Embedding model to use",
          default: "text-embedding-3-small",
        })
      ),
      dimensions: Type.Optional(
        Type.Number({
          description: "Embedding dimensions (model-dependent)",
          default: 1536,
        })
      ),
      // Ollama-specific settings
      ollamaBaseUrl: Type.Optional(
        Type.String({
          description: "Ollama base URL for local embeddings",
          default: "http://localhost:11434",
        })
      ),
      // Fallback settings
      fallbackProvider: Type.Optional(
        Type.String({
          description: "Fallback provider if primary fails (e.g., ollama for offline use)",
        })
      ),
      fallbackModel: Type.Optional(
        Type.String({
          description: "Fallback model (e.g., nomic-embed-text for Ollama)",
        })
      ),
    })
  ),

  // Extraction settings
  extraction: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      mode: Type.Optional(
        Type.String({
          description: "Extraction mode: pattern, llm, or hybrid",
          default: "pattern",
        })
      ),
      model: Type.Optional(
        Type.String({
          description: "Model to use for fact extraction (default: claude-3-5-haiku)",
          default: "claude-3-5-haiku-latest",
        })
      ),
      provider: Type.Optional(
        Type.String({
          description: "Provider for extraction model",
          default: "anthropic",
        })
      ),
    })
  ),

  // Identity settings
  identity: Type.Optional(
    Type.Object({
      // Allow chat-driven updates to personality
      allowChatUpdates: Type.Optional(Type.Boolean({ default: true })),
      // Personality traits that cannot be changed via chat
      lockedTraits: Type.Optional(Type.Array(Type.String())),
    })
  ),

  // Context injection settings
  injection: Type.Optional(
    Type.Object({
      // Token budgets for each layer
      identityTokens: Type.Optional(Type.Number({ default: 1500 })),
      activeContextTokens: Type.Optional(Type.Number({ default: 1000 })),
      factsTokens: Type.Optional(Type.Number({ default: 1000 })),
      integrationTokens: Type.Optional(Type.Number({ default: 1000 })),
      historyChunksTokens: Type.Optional(Type.Number({ default: 2000 })),
    })
  ),

  // Integration cache settings
  integrations: Type.Optional(
    Type.Object({
      // Default TTL for cached integration data (seconds)
      defaultTtl: Type.Optional(Type.Number({ default: 300 })),
      // Refresh on mention (when user talks about calendar, refresh calendar cache)
      refreshOnMention: Type.Optional(Type.Boolean({ default: true })),
    })
  ),

  // History chunks settings (Phase 2)
  historyChunks: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
      // Max chunks to keep in storage
      maxChunks: Type.Optional(Type.Number({ default: 100 })),
      // Create a summary chunk after this many messages
      summarizeAfterMessages: Type.Optional(Type.Number({ default: 10 })),
      // Max tokens per chunk summary
      maxSummaryTokens: Type.Optional(Type.Number({ default: 500 })),
    })
  ),

  // Consolidation settings (Phase 2)
  consolidation: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: false })),
      // Run consolidation every N hours
      intervalHours: Type.Optional(Type.Number({ default: 24 })),
      // Expire facts older than N days with low confidence
      expireAfterDays: Type.Optional(Type.Number({ default: 30 })),
      // Confidence threshold for expiration
      expireConfidenceThreshold: Type.Optional(Type.Number({ default: 0.5 })),
    })
  ),

  // Storage settings
  storage: Type.Optional(
    Type.Object({
      // Path to state.db (relative to agent dir, default: working-memory/state.db)
      dbPath: Type.Optional(Type.String({ default: "working-memory/state.db" })),
    })
  ),
});

export type WorkingMemoryConfig = Static<typeof workingMemoryConfigSchema>;

/**
 * Default configuration
 */
export const defaultConfig: WorkingMemoryConfig = {
  embeddings: {
    enabled: true,
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    ollamaBaseUrl: "http://localhost:11434",
  },
  extraction: {
    enabled: true,
    mode: "pattern",
    model: "claude-3-5-haiku-latest",
    provider: "anthropic",
  },
  identity: {
    allowChatUpdates: true,
    lockedTraits: [],
  },
  injection: {
    identityTokens: 1500,
    activeContextTokens: 1000,
    factsTokens: 1000,
    integrationTokens: 1000,
    historyChunksTokens: 2000,
  },
  integrations: {
    defaultTtl: 300,
    refreshOnMention: true,
  },
  historyChunks: {
    enabled: true,
    maxChunks: 100,
    summarizeAfterMessages: 10,
    maxSummaryTokens: 500,
  },
  consolidation: {
    enabled: false,
    intervalHours: 24,
    expireAfterDays: 30,
    expireConfidenceThreshold: 0.5,
  },
  storage: {
    dbPath: "working-memory/state.db",
  },
};
