/**
 * Moltbot Working Memory Plugin
 *
 * Protected context layer for PA brain - ensures the assistant never loses track of:
 * - Identity (personality + user profile)
 * - Active context (current project/task)
 * - Persistent facts (extracted from conversations)
 * - Integration data (calendar, tasks, etc. from external services)
 *
 * Key features:
 * - Global memory shared across all channels
 * - Chat-driven personality evolution
 * - Hybrid integration caching (cache + live query)
 * - Survives compaction - working memory is OUTSIDE the compaction pipeline
 */

import { Type } from "@sinclair/typebox";
import type { MoltbotPluginApi } from "moltbot/plugin-sdk";

import { workingMemoryConfigSchema, defaultConfig, type WorkingMemoryConfig } from "./config.js";
import { WorkingMemoryStore } from "./src/store.js";
import { IdentityManager } from "./src/identity.js";
import { ActiveContextManager } from "./src/active-context.js";
import { FactStore } from "./src/facts.js";
import { IntegrationCache } from "./src/integrations.js";
import { ContextInjector } from "./src/injection.js";
import { FactExtractor } from "./src/extraction.js";
import { registerGatewayMethods } from "./src/gateway.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const workingMemoryPlugin = {
  id: "working-memory",
  name: "Working Memory",
  description: "Protected context layer for PA brain - identity, active context, facts, integrations",
  kind: "memory" as const,
  configSchema: workingMemoryConfigSchema,

  register(api: MoltbotPluginApi) {
    // Parse and merge config with defaults
    const userConfig = api.pluginConfig as Partial<WorkingMemoryConfig>;
    const cfg: WorkingMemoryConfig = {
      ...defaultConfig,
      ...userConfig,
      extraction: { ...defaultConfig.extraction, ...userConfig?.extraction },
      identity: { ...defaultConfig.identity, ...userConfig?.identity },
      injection: { ...defaultConfig.injection, ...userConfig?.injection },
      integrations: { ...defaultConfig.integrations, ...userConfig?.integrations },
      storage: { ...defaultConfig.storage, ...userConfig?.storage },
    };

    // Resolve storage path
    const storagePath = api.resolvePath(cfg.storage?.dbPath ?? "working-memory");

    // Initialize components
    const store = new WorkingMemoryStore(storagePath, api.logger);
    const identity = new IdentityManager(store, cfg.identity!, api.logger);
    const activeContext = new ActiveContextManager(store, api.logger);
    const facts = new FactStore(store, api.logger);
    const integrations = new IntegrationCache(store, cfg.integrations!, api.logger);
    const injector = new ContextInjector(identity, activeContext, facts, integrations, cfg.injection!, api.logger);
    const extractor = new FactExtractor(store, identity, activeContext, facts, cfg.extraction!, api.logger);

    api.logger.info(`working-memory: plugin registered (storage: ${storagePath})`);

    // ========================================================================
    // Before Agent Start - Inject Working Memory into Context
    // ========================================================================

    api.on("before_agent_start", async (event, ctx) => {
      if (!event.prompt) return;

      try {
        const context = await injector.assembleContext({
          prompt: event.prompt,
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
        });

        if (!context) return;

        api.logger.info?.(`working-memory: injecting context (${context.tokenEstimate} tokens)`);

        return {
          prependContext: context.content,
        };
      } catch (err) {
        api.logger.warn(`working-memory: context injection failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // After Agent End - Extract Facts and Update Context (Async)
    // ========================================================================

    api.on("agent_end", async (event, ctx) => {
      if (!event.success) return;

      // Run extraction async - don't block the response
      setImmediate(async () => {
        try {
          await extractor.processConversation({
            messages: event.messages,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
          });
        } catch (err) {
          api.logger.warn(`working-memory: extraction failed: ${String(err)}`);
        }
      });
    });

    // ========================================================================
    // Tools - Allow agent to interact with Working Memory
    // ========================================================================

    // Tool: Update active context (what we're working on)
    api.registerTool(
      {
        name: "working_memory_set_context",
        label: "Set Working Context",
        description:
          "Update the current project or task context. Use when starting new work or switching focus.",
        parameters: Type.Object({
          project: Type.Optional(
            Type.Object({
              name: Type.String({ description: "Project name" }),
              goal: Type.Optional(Type.String({ description: "Project goal" })),
            })
          ),
          task: Type.Optional(
            Type.Object({
              description: Type.String({ description: "Current task" }),
              files: Type.Optional(Type.Array(Type.String(), { description: "Files involved" })),
            })
          ),
          decision: Type.Optional(
            Type.Object({
              decision: Type.String({ description: "Decision made" }),
              reasoning: Type.Optional(Type.String({ description: "Why this decision" })),
            })
          ),
        }),
        async execute(_toolCallId, params) {
          const { project, task, decision } = params as {
            project?: { name: string; goal?: string };
            task?: { description: string; files?: string[] };
            decision?: { decision: string; reasoning?: string };
          };

          const updates: string[] = [];

          if (project) {
            await activeContext.setProject(project.name, project.goal);
            updates.push(`project: ${project.name}`);
          }

          if (task) {
            await activeContext.setTask(task.description, task.files);
            updates.push(`task: ${task.description}`);
          }

          if (decision) {
            await activeContext.addDecision(decision.decision, decision.reasoning);
            updates.push(`decision recorded`);
          }

          return {
            content: [{ type: "text", text: `Working context updated: ${updates.join(", ")}` }],
            details: { updates },
          };
        },
      },
      { name: "working_memory_set_context" }
    );

    // Tool: Remember a fact
    api.registerTool(
      {
        name: "working_memory_remember",
        label: "Remember Fact",
        description:
          "Store an important fact in long-term memory. Use for preferences, decisions, user info.",
        parameters: Type.Object({
          fact: Type.String({ description: "The fact to remember" }),
          category: Type.Optional(
            Type.String({
              description: "Category: user, preference, decision, project, or other",
            })
          ),
          subject: Type.Optional(Type.String({ description: "What/who this is about" })),
        }),
        async execute(_toolCallId, params) {
          const { fact, category = "other", subject = "general" } = params as {
            fact: string;
            category?: string;
            subject?: string;
          };

          const id = await facts.addFact({
            category,
            subject,
            value: fact,
          });

          return {
            content: [{ type: "text", text: `Remembered: "${fact.slice(0, 100)}..."` }],
            details: { id, category, subject },
          };
        },
      },
      { name: "working_memory_remember" }
    );

    // Tool: Search facts
    api.registerTool(
      {
        name: "working_memory_recall",
        label: "Recall Facts",
        description: "Search long-term memory for relevant facts.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          category: Type.Optional(Type.String({ description: "Filter by category" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        }),
        async execute(_toolCallId, params) {
          const { query, category, limit = 10 } = params as {
            query: string;
            category?: string;
            limit?: number;
          };

          const results = await facts.search(query, { category, limit });

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant facts found." }],
              details: { count: 0 },
            };
          }

          const text = results
            .map((r, i) => `${i + 1}. [${r.category}] ${r.value}`)
            .join("\n");

          return {
            content: [{ type: "text", text: `Found ${results.length} facts:\n\n${text}` }],
            details: { count: results.length, facts: results },
          };
        },
      },
      { name: "working_memory_recall" }
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const wm = program
          .command("wm")
          .description("Working Memory plugin commands");

        wm.command("status")
          .description("Show working memory status")
          .action(async () => {
            const status = await store.getStatus();
            console.log(JSON.stringify(status, null, 2));
          });

        wm.command("identity")
          .description("Show current identity")
          .action(async () => {
            const id = await identity.get();
            console.log(JSON.stringify(id, null, 2));
          });

        wm.command("context")
          .description("Show active context")
          .action(async () => {
            const ctx = await activeContext.get();
            console.log(JSON.stringify(ctx, null, 2));
          });

        wm.command("facts")
          .description("List all facts")
          .option("--category <cat>", "Filter by category")
          .option("--limit <n>", "Max results", "50")
          .action(async (opts) => {
            const results = await facts.list({
              category: opts.category,
              limit: parseInt(opts.limit),
            });
            console.log(JSON.stringify(results, null, 2));
          });

        wm.command("search")
          .description("Search facts")
          .argument("<query>", "Search query")
          .action(async (query) => {
            const results = await facts.search(query, { limit: 20 });
            console.log(JSON.stringify(results, null, 2));
          });

        wm.command("reset")
          .description("Reset working memory (dangerous!)")
          .option("--confirm", "Confirm reset")
          .action(async (opts) => {
            if (!opts.confirm) {
              console.log("Use --confirm to reset working memory");
              return;
            }
            await store.reset();
            console.log("Working memory reset");
          });
      },
      { commands: ["wm"] }
    );

    // ========================================================================
    // Gateway Methods (for iOS app integration)
    // ========================================================================

    registerGatewayMethods(api, {
      store,
      identity,
      activeContext,
      facts,
      integrations,
    });

    // ========================================================================
    // Service Lifecycle
    // ========================================================================

    api.registerService({
      id: "working-memory",
      start: async () => {
        await store.initialize();
        api.logger.info(`working-memory: initialized`);
      },
      stop: async () => {
        await store.close();
        api.logger.info("working-memory: stopped");
      },
    });
  },
};

export default workingMemoryPlugin;
