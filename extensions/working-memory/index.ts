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

import type { MoltbotPluginApi } from "moltbot/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { workingMemoryConfigSchema, defaultConfig, type WorkingMemoryConfig } from "./config.js";
import { ActiveContextManager } from "./src/active-context.js";
import { createMemoryConsolidator, type MemoryConsolidator } from "./src/consolidation.js";
import { createEmbeddingService, type EmbeddingService } from "./src/embeddings.js";
import { FactExtractor } from "./src/extraction.js";
import { FactStore } from "./src/facts.js";
import { registerGatewayMethods } from "./src/gateway.js";
import { createHistoryChunkManager, type HistoryChunkManager } from "./src/history-chunks.js";
import { IdentityManager } from "./src/identity.js";
import { ContextInjector } from "./src/injection.js";
import { IntegrationCache } from "./src/integrations.js";
import { WorkingMemoryStore } from "./src/store.js";
import { createVectorStore, type VectorStore } from "./src/vector-store.js";

// ============================================================================
// Plugin Definition
// ============================================================================

const workingMemoryPlugin = {
  id: "working-memory",
  name: "Working Memory",
  description:
    "Protected context layer for PA brain - identity, active context, facts, integrations",
  configSchema: workingMemoryConfigSchema,

  register(api: MoltbotPluginApi) {
    // Parse and merge config with defaults
    const userConfig = api.pluginConfig as Partial<WorkingMemoryConfig>;
    const cfg: WorkingMemoryConfig = {
      ...defaultConfig,
      ...userConfig,
      embeddings: { ...defaultConfig.embeddings, ...userConfig?.embeddings },
      extraction: { ...defaultConfig.extraction, ...userConfig?.extraction },
      identity: { ...defaultConfig.identity, ...userConfig?.identity },
      injection: { ...defaultConfig.injection, ...userConfig?.injection },
      integrations: { ...defaultConfig.integrations, ...userConfig?.integrations },
      historyChunks: { ...defaultConfig.historyChunks, ...userConfig?.historyChunks },
      consolidation: { ...defaultConfig.consolidation, ...userConfig?.consolidation },
      storage: { ...defaultConfig.storage, ...userConfig?.storage },
    };

    // Resolve API key for LLM extraction from main config if not provided
    if (
      cfg.extraction &&
      (cfg.extraction.mode === "llm" || cfg.extraction.mode === "hybrid") &&
      !cfg.extraction.apiKey
    ) {
      const provider = cfg.extraction.provider ?? "anthropic";
      // Try to get API key from models.providers config
      const providerConfig = api.config.models?.providers?.[provider] as
        | { apiKey?: string }
        | undefined;
      if (providerConfig?.apiKey) {
        cfg.extraction.apiKey = providerConfig.apiKey;
        api.logger.info(`working-memory: using ${provider} API key from models.providers config`);
      }
    }

    // Resolve storage path
    const storagePath = api.resolvePath(cfg.storage?.dbPath ?? "working-memory");

    // Initialize core components
    const store = new WorkingMemoryStore(storagePath, api.logger);
    const identity = new IdentityManager(store, cfg.identity!, api.logger);
    const activeContext = new ActiveContextManager(store, api.logger);

    // Pass Moltbot's agent identity to the IdentityManager
    // This allows Working Memory to use the bot name/emoji from Moltbot config
    const agentList = api.config.agents?.list;
    const defaultAgent = agentList?.find((a) => a.default) ?? agentList?.[0];
    if (defaultAgent?.identity) {
      identity.setMoltbotIdentity({
        name: defaultAgent.identity.name,
        emoji: defaultAgent.identity.emoji,
        avatar: defaultAgent.identity.avatar,
        theme: defaultAgent.identity.theme,
      });
    }
    const facts = new FactStore(store, api.logger);
    const integrations = new IntegrationCache(store, cfg.integrations!, api.logger);
    const injector = new ContextInjector(
      identity,
      activeContext,
      facts,
      integrations,
      cfg.injection!,
      api.logger,
    );
    const extractor = new FactExtractor(
      store,
      identity,
      activeContext,
      facts,
      cfg.extraction!,
      api.logger,
    );

    // Initialize Phase 2 components (embeddings & vector search)
    let embeddings: EmbeddingService | null = null;
    let vectorStore: VectorStore | null = null;
    let historyChunks: HistoryChunkManager | null = null;

    if (cfg.embeddings?.enabled) {
      embeddings = createEmbeddingService(cfg.embeddings, api.logger);
      vectorStore = createVectorStore(
        store,
        { maxInMemoryChunks: cfg.historyChunks?.maxChunks ?? 100 },
        api.logger,
      );

      // Wire up to injector for semantic retrieval
      injector.setEmbeddingService(embeddings);
      injector.setVectorStore(vectorStore);

      api.logger.info(
        `working-memory: embeddings enabled (${cfg.embeddings.provider}/${cfg.embeddings.model})`,
      );
    }

    // Initialize history chunk manager (Phase 2)
    if (cfg.historyChunks?.enabled) {
      historyChunks = createHistoryChunkManager(
        store,
        embeddings,
        vectorStore,
        cfg.historyChunks,
        api.logger,
      );

      api.logger.info(
        `working-memory: history chunks enabled (summarize after ${cfg.historyChunks.summarizeAfterMessages} messages)`,
      );
    }

    // Initialize memory consolidator (Phase 2.4)
    const consolidator = createMemoryConsolidator(store, embeddings, cfg.consolidation, api.logger);

    if (cfg.consolidation?.enabled) {
      api.logger.info(
        `working-memory: consolidation enabled (every ${cfg.consolidation.intervalHours}h, expire after ${cfg.consolidation.expireAfterDays}d)`,
      );
    }

    api.logger.info(`working-memory: plugin registered (storage: ${storagePath})`);

    // ========================================================================
    // Before Agent Start - Inject Working Memory into Context
    // ========================================================================

    api.on("before_agent_start", async (event, ctx) => {
      if (!event.prompt) return;

      try {
        // Ensure store is initialized before using injector
        await store.initialize();

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
    // After Agent End - Extract Facts, Update Context, Process History (Async)
    // ========================================================================

    api.on("agent_end", async (event, ctx) => {
      if (!event.success) return;

      // Run extraction async - don't block the response
      setImmediate(async () => {
        try {
          // Ensure store is initialized before extraction
          await store.initialize();

          await extractor.processConversation({
            messages: event.messages,
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
          });
        } catch (err) {
          api.logger.warn(`working-memory: extraction failed: ${String(err)}`);
        }

        // Process messages for history chunks (Phase 2)
        if (historyChunks && event.messages) {
          try {
            // Convert messages to the format expected by HistoryChunkManager
            const conversationMessages = event.messages.map((msg) => ({
              role: msg.role as "user" | "assistant" | "system",
              content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
              timestamp: Date.now(),
            }));

            await historyChunks.processMessages(
              conversationMessages,
              ctx.sessionKey,
              ctx.channelId,
            );
          } catch (err) {
            api.logger.warn(`working-memory: history chunk processing failed: ${String(err)}`);
          }
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
            }),
          ),
          task: Type.Optional(
            Type.Object({
              description: Type.String({ description: "Current task" }),
              files: Type.Optional(Type.Array(Type.String(), { description: "Files involved" })),
            }),
          ),
          decision: Type.Optional(
            Type.Object({
              decision: Type.String({ description: "Decision made" }),
              reasoning: Type.Optional(Type.String({ description: "Why this decision" })),
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          // Ensure store is initialized
          await store.initialize();

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
      { name: "working_memory_set_context" },
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
            }),
          ),
          subject: Type.Optional(Type.String({ description: "What/who this is about" })),
        }),
        async execute(_toolCallId, params) {
          // Ensure store is initialized
          await store.initialize();

          const {
            fact,
            category = "other",
            subject = "general",
          } = params as {
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
      { name: "working_memory_remember" },
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
          // Ensure store is initialized
          await store.initialize();

          const {
            query,
            category,
            limit = 10,
          } = params as {
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

          const text = results.map((r, i) => `${i + 1}. [${r.category}] ${r.value}`).join("\n");

          return {
            content: [{ type: "text", text: `Found ${results.length} facts:\n\n${text}` }],
            details: { count: results.length, facts: results },
          };
        },
      },
      { name: "working_memory_recall" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    // Helper to ensure store is initialized for CLI commands
    const ensureInit = async () => {
      await store.initialize();
    };

    api.registerCli(
      ({ program }) => {
        const wm = program.command("wm").description("Working Memory plugin commands");

        wm.command("status")
          .description("Show working memory status")
          .action(async () => {
            await ensureInit();
            const status = await store.getStatus();
            console.log(JSON.stringify(status, null, 2));
          });

        wm.command("identity")
          .description("Show current identity")
          .action(async () => {
            await ensureInit();
            const id = await identity.get();
            console.log(JSON.stringify(id, null, 2));
          });

        wm.command("context")
          .description("Show active context")
          .action(async () => {
            await ensureInit();
            const ctx = await activeContext.get();
            console.log(JSON.stringify(ctx, null, 2));
          });

        wm.command("facts")
          .description("List all facts")
          .option("--category <cat>", "Filter by category")
          .option("--limit <n>", "Max results", "50")
          .action(async (opts) => {
            await ensureInit();
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
            await ensureInit();
            const results = await facts.search(query, { limit: 20 });
            console.log(JSON.stringify(results, null, 2));
          });

        wm.command("reset")
          .description("Reset working memory (dangerous!)")
          .option("--confirm", "Confirm reset")
          .action(async (opts) => {
            await ensureInit();
            if (!opts.confirm) {
              console.log("Use --confirm to reset working memory");
              return;
            }
            await store.reset();
            console.log("Working memory reset");
          });

        // Phase 2: History chunks commands
        wm.command("chunks")
          .description("List recent history chunks")
          .option("--limit <n>", "Max results", "10")
          .action(async (opts) => {
            await ensureInit();
            const chunks = await store.getRecentChunks(parseInt(opts.limit));
            console.log(JSON.stringify(chunks, null, 2));
          });

        wm.command("embeddings-status")
          .description("Show embeddings status")
          .action(async () => {
            await ensureInit();
            const withEmbeddings = await store.getChunksWithEmbeddings(1000);
            const withoutEmbeddings = await store.getChunksWithoutEmbeddings(1000);
            console.log(
              JSON.stringify(
                {
                  embeddingsEnabled: cfg.embeddings?.enabled ?? false,
                  provider: cfg.embeddings?.provider ?? "none",
                  model: cfg.embeddings?.model ?? "none",
                  chunksWithEmbeddings: withEmbeddings.length,
                  chunksWithoutEmbeddings: withoutEmbeddings.length,
                  vectorStoreSize: vectorStore?.size() ?? 0,
                },
                null,
                2,
              ),
            );
          });

        wm.command("backfill-embeddings")
          .description("Generate embeddings for chunks that don't have them")
          .option("--limit <n>", "Max chunks to process", "50")
          .action(async (opts) => {
            await ensureInit();
            if (!historyChunks) {
              console.log("History chunks not enabled");
              return;
            }
            const count = await historyChunks.backfillEmbeddings(parseInt(opts.limit));
            console.log(`Backfilled ${count} embeddings`);
          });

        wm.command("extraction-status")
          .description("Show extraction mode and configuration")
          .action(async () => {
            console.log(
              JSON.stringify(
                {
                  enabled: cfg.extraction?.enabled ?? true,
                  mode: cfg.extraction?.mode ?? "pattern",
                  model: cfg.extraction?.model ?? "claude-3-5-haiku-latest",
                  provider: cfg.extraction?.provider ?? "anthropic",
                  modes: {
                    pattern: "Fast regex-based extraction (free, ~1ms)",
                    llm: "LLM-based extraction using Haiku (~$0.001/turn, ~500ms)",
                    hybrid: "Pattern first, LLM for complex cases",
                  },
                },
                null,
                2,
              ),
            );
          });

        wm.command("consolidate")
          .description("Run memory consolidation (merge duplicates, expire old facts)")
          .action(async () => {
            await ensureInit();
            console.log("Starting consolidation...");
            const result = await consolidator.consolidate();
            console.log(
              JSON.stringify(
                {
                  status: "complete",
                  duration: `${result.duration}ms`,
                  mergedFacts: result.mergedFacts,
                  expiredFacts: result.expiredFacts,
                  supersededFacts: result.supersededFacts,
                  prunedChunks: result.prunedChunks,
                },
                null,
                2,
              ),
            );
          });

        wm.command("consolidation-status")
          .description("Show consolidation configuration and status")
          .action(async () => {
            const nextRun = consolidator.getNextConsolidationTime();
            console.log(
              JSON.stringify(
                {
                  enabled: cfg.consolidation?.enabled ?? false,
                  intervalHours: cfg.consolidation?.intervalHours ?? 24,
                  expireAfterDays: cfg.consolidation?.expireAfterDays ?? 30,
                  expireConfidenceThreshold: cfg.consolidation?.expireConfidenceThreshold ?? 0.5,
                  isRunning: consolidator.isConsolidating(),
                  nextRunAt: nextRun ? new Date(nextRun).toISOString() : null,
                },
                null,
                2,
              ),
            );
          });
      },
      { commands: ["wm"] },
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
