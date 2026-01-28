/**
 * Gateway Methods
 *
 * Exposes Working Memory to external clients (iOS app, CLI, web UI) via gateway RPC.
 */

import { Type } from "@sinclair/typebox";
import type { MoltbotPluginApi } from "moltbot/plugin-sdk";

import type { WorkingMemoryStore } from "./store.js";
import type { IdentityManager } from "./identity.js";
import type { ActiveContextManager } from "./active-context.js";
import type { FactStore } from "./facts.js";
import type { IntegrationCache } from "./integrations.js";

interface GatewayContext {
  store: WorkingMemoryStore;
  identity: IdentityManager;
  activeContext: ActiveContextManager;
  facts: FactStore;
  integrations: IntegrationCache;
}

export function registerGatewayMethods(
  api: MoltbotPluginApi,
  ctx: GatewayContext
): void {
  const { store, identity, activeContext, facts, integrations } = ctx;

  // ==========================================================================
  // Status & Overview
  // ==========================================================================

  api.registerGatewayMethod?.({
    name: "working_memory.status",
    description: "Get working memory status and statistics",
    parameters: Type.Object({}),
    async handler() {
      const status = await store.getStatus();
      const factStats = await facts.getStats();
      const integrationStats = await integrations.getStats();

      return {
        ...status,
        facts: factStats,
        integrations: integrationStats,
      };
    },
  });

  // ==========================================================================
  // Identity
  // ==========================================================================

  api.registerGatewayMethod?.({
    name: "working_memory.identity",
    description: "Get current PA identity (personality + user profile)",
    parameters: Type.Object({}),
    async handler() {
      return identity.get();
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.identity.update",
    description: "Update PA identity",
    parameters: Type.Object({
      personality: Type.Optional(
        Type.Object({
          name: Type.Optional(Type.String()),
          tone: Type.Optional(Type.String()),
          communicationStyle: Type.Optional(Type.String()),
          quirks: Type.Optional(Type.Array(Type.String())),
          relationshipHistory: Type.Optional(Type.String()),
        })
      ),
      user: Type.Optional(
        Type.Object({
          name: Type.Optional(Type.String()),
          preferences: Type.Optional(Type.Array(Type.String())),
          communication: Type.Optional(Type.Array(Type.String())),
          context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        })
      ),
    }),
    async handler(params) {
      const { personality, user } = params as {
        personality?: Partial<{
          name: string;
          tone: string;
          communicationStyle: string;
          quirks: string[];
          relationshipHistory: string;
        }>;
        user?: Partial<{
          name: string;
          preferences: string[];
          communication: string[];
          context: Record<string, unknown>;
        }>;
      };

      if (personality) {
        await identity.updatePersonality(personality);
      }
      if (user) {
        await identity.updateUserProfile(user);
      }

      return identity.get();
    },
  });

  // ==========================================================================
  // Active Context
  // ==========================================================================

  api.registerGatewayMethod?.({
    name: "working_memory.context",
    description: "Get current active context (project, task, decisions)",
    parameters: Type.Object({}),
    async handler() {
      return activeContext.get();
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.context.set_project",
    description: "Set current project",
    parameters: Type.Object({
      name: Type.String({ description: "Project name" }),
      goal: Type.Optional(Type.String({ description: "Project goal" })),
    }),
    async handler(params) {
      const { name, goal } = params as { name: string; goal?: string };
      return activeContext.setProject(name, goal);
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.context.set_task",
    description: "Set current task",
    parameters: Type.Object({
      description: Type.String({ description: "Task description" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Files involved" })),
    }),
    async handler(params) {
      const { description, files } = params as { description: string; files?: string[] };
      return activeContext.setTask(description, files);
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.context.add_decision",
    description: "Record a decision",
    parameters: Type.Object({
      decision: Type.String({ description: "The decision" }),
      reasoning: Type.Optional(Type.String({ description: "Reasoning" })),
    }),
    async handler(params) {
      const { decision, reasoning } = params as { decision: string; reasoning?: string };
      return activeContext.addDecision(decision, reasoning);
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.context.clear",
    description: "Clear active context (project and task)",
    parameters: Type.Object({}),
    async handler() {
      return activeContext.clearProject();
    },
  });

  // ==========================================================================
  // Facts
  // ==========================================================================

  api.registerGatewayMethod?.({
    name: "working_memory.facts.list",
    description: "List all facts",
    parameters: Type.Object({
      category: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
    }),
    async handler(params) {
      const { category, limit, offset } = params as {
        category?: string;
        limit?: number;
        offset?: number;
      };
      return facts.list({ category, limit, offset });
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.facts.search",
    description: "Search facts",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      category: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async handler(params) {
      const { query, category, limit } = params as {
        query: string;
        category?: string;
        limit?: number;
      };
      return facts.search(query, { category, limit });
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.facts.add",
    description: "Add a new fact",
    parameters: Type.Object({
      category: Type.String({ description: "Fact category" }),
      subject: Type.String({ description: "What this is about" }),
      value: Type.String({ description: "The fact content" }),
      confidence: Type.Optional(Type.Number()),
    }),
    async handler(params) {
      const { category, subject, value, confidence } = params as {
        category: string;
        subject: string;
        value: string;
        confidence?: number;
      };
      const id = await facts.addFact({ category, subject, value, confidence });
      return { id };
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.facts.delete",
    description: "Delete a fact",
    parameters: Type.Object({
      id: Type.String({ description: "Fact ID" }),
    }),
    async handler(params) {
      const { id } = params as { id: string };
      await facts.deleteFact(id);
      return { success: true };
    },
  });

  // ==========================================================================
  // Integrations (for iOS app to push data)
  // ==========================================================================

  api.registerGatewayMethod?.({
    name: "working_memory.integrations.push",
    description: "Push integration data (from iOS app)",
    parameters: Type.Object({
      source: Type.String({ description: "Integration source (calendar, reminders, etc.)" }),
      key: Type.String({ description: "Data key" }),
      data: Type.Unknown({ description: "Data payload" }),
      ttl: Type.Optional(Type.Number({ description: "TTL in seconds" })),
    }),
    async handler(params) {
      const { source, key, data, ttl } = params as {
        source: string;
        key: string;
        data: unknown;
        ttl?: number;
      };
      await integrations.push({ source, key, data, ttl });
      return { success: true };
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.integrations.push_bulk",
    description: "Push multiple integration entries",
    parameters: Type.Object({
      entries: Type.Array(
        Type.Object({
          source: Type.String(),
          key: Type.String(),
          data: Type.Unknown(),
          ttl: Type.Optional(Type.Number()),
        })
      ),
    }),
    async handler(params) {
      const { entries } = params as {
        entries: Array<{ source: string; key: string; data: unknown; ttl?: number }>;
      };
      await integrations.pushBulk(entries);
      return { success: true, count: entries.length };
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.integrations.get",
    description: "Get cached integration data",
    parameters: Type.Object({
      source: Type.String({ description: "Integration source" }),
      key: Type.Optional(Type.String({ description: "Specific key (optional)" })),
    }),
    async handler(params) {
      const { source, key } = params as { source: string; key?: string };
      return integrations.get(source, key);
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.integrations.clear",
    description: "Clear integration cache for a source",
    parameters: Type.Object({
      source: Type.String({ description: "Integration source to clear" }),
    }),
    async handler(params) {
      const { source } = params as { source: string };
      await integrations.clear(source);
      return { success: true };
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.integrations.status",
    description: "Get integration cache status",
    parameters: Type.Object({}),
    async handler() {
      return integrations.getStats();
    },
  });

  // ==========================================================================
  // Bulk Operations
  // ==========================================================================

  api.registerGatewayMethod?.({
    name: "working_memory.export",
    description: "Export all working memory data",
    parameters: Type.Object({}),
    async handler() {
      const [identityData, contextData, factsData, status] = await Promise.all([
        identity.get(),
        activeContext.get(),
        facts.list({ limit: 1000 }),
        store.getStatus(),
      ]);

      return {
        exportedAt: Date.now(),
        identity: identityData,
        activeContext: contextData,
        facts: factsData,
        status,
      };
    },
  });

  api.registerGatewayMethod?.({
    name: "working_memory.reset",
    description: "Reset all working memory (dangerous!)",
    parameters: Type.Object({
      confirm: Type.Boolean({ description: "Must be true to confirm" }),
    }),
    async handler(params) {
      const { confirm } = params as { confirm: boolean };
      if (!confirm) {
        return { success: false, error: "Must confirm reset" };
      }
      await store.reset();
      return { success: true };
    },
  });
}
