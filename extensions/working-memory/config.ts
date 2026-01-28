/**
 * Working Memory Plugin Configuration
 */

import { Type, type Static } from "@sinclair/typebox";

/**
 * Configuration schema for the Working Memory plugin
 */
export const workingMemoryConfigSchema = Type.Object({
  // Extraction settings
  extraction: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ default: true })),
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
  extraction: {
    enabled: true,
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
  storage: {
    dbPath: "working-memory/state.db",
  },
};
