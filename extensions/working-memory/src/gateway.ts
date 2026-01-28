/**
 * Gateway Methods
 *
 * Exposes Working Memory to external clients (iOS app, CLI, web UI) via gateway RPC.
 */

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

type GatewayRequest = {
  params: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown) => void;
};

export function registerGatewayMethods(
  api: MoltbotPluginApi,
  ctx: GatewayContext
): void {
  const { store, identity, activeContext, facts, integrations } = ctx;

  // Helper to wrap async handlers
  const wrapHandler = (fn: (params: Record<string, unknown>) => Promise<unknown>) => {
    return async ({ params, respond }: GatewayRequest) => {
      try {
        const result = await fn(params ?? {});
        respond(true, result);
      } catch (err) {
        respond(false, { error: err instanceof Error ? err.message : String(err) });
      }
    };
  };

  // ==========================================================================
  // Status & Overview
  // ==========================================================================

  api.registerGatewayMethod("working_memory.status", wrapHandler(async () => {
    const status = await store.getStatus();
    const factStats = await facts.getStats();
    const integrationStats = await integrations.getStats();

    return {
      ...status,
      facts: factStats,
      integrations: integrationStats,
    };
  }));

  // ==========================================================================
  // Identity
  // ==========================================================================

  api.registerGatewayMethod("working_memory.identity", wrapHandler(async () => {
    return identity.get();
  }));

  api.registerGatewayMethod("working_memory.identity.update", wrapHandler(async (params) => {
    const personality = params.personality as Record<string, unknown> | undefined;
    const user = params.user as Record<string, unknown> | undefined;

    if (personality) {
      await identity.updatePersonality(personality);
    }
    if (user) {
      await identity.updateUserProfile(user);
    }

    return identity.get();
  }));

  // ==========================================================================
  // Active Context
  // ==========================================================================

  api.registerGatewayMethod("working_memory.context", wrapHandler(async () => {
    return activeContext.get();
  }));

  api.registerGatewayMethod("working_memory.context.set_project", wrapHandler(async (params) => {
    const name = String(params.name ?? "");
    const goal = params.goal ? String(params.goal) : undefined;
    if (!name) throw new Error("name required");
    return activeContext.setProject(name, goal);
  }));

  api.registerGatewayMethod("working_memory.context.set_task", wrapHandler(async (params) => {
    const description = String(params.description ?? "");
    const files = Array.isArray(params.files) ? params.files.map(String) : undefined;
    if (!description) throw new Error("description required");
    return activeContext.setTask(description, files);
  }));

  api.registerGatewayMethod("working_memory.context.add_decision", wrapHandler(async (params) => {
    const decision = String(params.decision ?? "");
    const reasoning = params.reasoning ? String(params.reasoning) : undefined;
    if (!decision) throw new Error("decision required");
    return activeContext.addDecision(decision, reasoning);
  }));

  api.registerGatewayMethod("working_memory.context.clear", wrapHandler(async () => {
    return activeContext.clearProject();
  }));

  // ==========================================================================
  // Facts
  // ==========================================================================

  api.registerGatewayMethod("working_memory.facts.list", wrapHandler(async (params) => {
    const category = params.category ? String(params.category) : undefined;
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const offset = typeof params.offset === "number" ? params.offset : undefined;
    return facts.list({ category, limit, offset });
  }));

  api.registerGatewayMethod("working_memory.facts.search", wrapHandler(async (params) => {
    const query = String(params.query ?? "");
    if (!query) throw new Error("query required");
    const category = params.category ? String(params.category) : undefined;
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    return facts.search(query, { category, limit });
  }));

  api.registerGatewayMethod("working_memory.facts.add", wrapHandler(async (params) => {
    const category = String(params.category ?? "other");
    const subject = String(params.subject ?? "general");
    const value = String(params.value ?? "");
    if (!value) throw new Error("value required");
    const confidence = typeof params.confidence === "number" ? params.confidence : undefined;
    const id = await facts.addFact({ category, subject, value, confidence });
    return { id };
  }));

  api.registerGatewayMethod("working_memory.facts.delete", wrapHandler(async (params) => {
    const id = String(params.id ?? "");
    if (!id) throw new Error("id required");
    await facts.deleteFact(id);
    return { success: true };
  }));

  // ==========================================================================
  // Integrations (for iOS app to push data)
  // ==========================================================================

  api.registerGatewayMethod("working_memory.integrations.push", wrapHandler(async (params) => {
    const source = String(params.source ?? "");
    const key = String(params.key ?? "");
    if (!source || !key) throw new Error("source and key required");
    const data = params.data;
    const ttl = typeof params.ttl === "number" ? params.ttl : undefined;
    await integrations.push({ source, key, data, ttl });
    return { success: true };
  }));

  api.registerGatewayMethod("working_memory.integrations.push_bulk", wrapHandler(async (params) => {
    const entries = params.entries;
    if (!Array.isArray(entries)) throw new Error("entries array required");
    const normalized = entries.map((e: unknown) => {
      const entry = e as Record<string, unknown>;
      return {
        source: String(entry.source ?? ""),
        key: String(entry.key ?? ""),
        data: entry.data,
        ttl: typeof entry.ttl === "number" ? entry.ttl : undefined,
      };
    });
    await integrations.pushBulk(normalized);
    return { success: true, count: normalized.length };
  }));

  api.registerGatewayMethod("working_memory.integrations.get", wrapHandler(async (params) => {
    const source = String(params.source ?? "");
    if (!source) throw new Error("source required");
    const key = params.key ? String(params.key) : undefined;
    return integrations.get(source, key);
  }));

  api.registerGatewayMethod("working_memory.integrations.clear", wrapHandler(async (params) => {
    const source = String(params.source ?? "");
    if (!source) throw new Error("source required");
    await integrations.clear(source);
    return { success: true };
  }));

  api.registerGatewayMethod("working_memory.integrations.status", wrapHandler(async () => {
    return integrations.getStats();
  }));

  // ==========================================================================
  // Bulk Operations
  // ==========================================================================

  api.registerGatewayMethod("working_memory.export", wrapHandler(async () => {
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
  }));

  api.registerGatewayMethod("working_memory.reset", wrapHandler(async (params) => {
    const confirm = params.confirm === true;
    if (!confirm) {
      throw new Error("Must confirm reset with confirm: true");
    }
    await store.reset();
    return { success: true };
  }));
}
