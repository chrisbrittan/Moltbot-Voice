/**
 * Context Injector
 *
 * Assembles working memory into context for injection before agent runs.
 * Manages token budgets across layers.
 */

import type { IdentityManager } from "./identity.js";
import type { ActiveContextManager } from "./active-context.js";
import type { FactStore } from "./facts.js";
import type { IntegrationCache } from "./integrations.js";
import type { EmbeddingService } from "./embeddings.js";
import type { VectorStore } from "./vector-store.js";
import type { AssembledContext, HistoryChunk, Logger } from "./types.js";

interface InjectionConfig {
  identityTokens: number;
  activeContextTokens: number;
  factsTokens: number;
  integrationTokens: number;
  historyChunksTokens: number;
}

export class ContextInjector {
  private embeddings: EmbeddingService | null = null;
  private vectorStore: VectorStore | null = null;

  constructor(
    private readonly identity: IdentityManager,
    private readonly activeContext: ActiveContextManager,
    private readonly facts: FactStore,
    private readonly integrations: IntegrationCache,
    private readonly config: InjectionConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Set the embedding service for semantic history retrieval (Phase 2)
   */
  setEmbeddingService(embeddings: EmbeddingService): void {
    this.embeddings = embeddings;
  }

  /**
   * Set the vector store for semantic history retrieval (Phase 2)
   */
  setVectorStore(vectorStore: VectorStore): void {
    this.vectorStore = vectorStore;
  }

  /**
   * Assemble all working memory layers into context for injection.
   */
  async assembleContext(params: {
    prompt: string;
    sessionKey?: string;
    agentId?: string;
  }): Promise<AssembledContext | null> {
    const { prompt } = params;
    const sections: string[] = [];
    const layers = {
      identity: 0,
      activeContext: 0,
      facts: 0,
      integrations: 0,
      historyChunks: 0,
    };

    // Layer 1: Identity (always included)
    const identityContext = await this.assembleIdentity();
    if (identityContext) {
      sections.push(identityContext.content);
      layers.identity = identityContext.tokens;
    }

    // Layer 2: Active Context (always included if present)
    const activeContextContent = await this.assembleActiveContext();
    if (activeContextContent) {
      sections.push(activeContextContent.content);
      layers.activeContext = activeContextContent.tokens;
    }

    // Layer 3: Relevant Facts (retrieved based on prompt)
    const factsContext = await this.assembleFacts(prompt);
    if (factsContext) {
      sections.push(factsContext.content);
      layers.facts = factsContext.tokens;
    }

    // Layer 4: Integration Context (only if relevant to prompt)
    const integrationContext = await this.assembleIntegrations(prompt);
    if (integrationContext) {
      sections.push(integrationContext.content);
      layers.integrations = integrationContext.tokens;
    }

    // Layer 5: History Chunks (semantic retrieval via embeddings - Phase 2)
    const historyContext = await this.assembleHistoryChunks(prompt);
    if (historyContext) {
      sections.push(historyContext.content);
      layers.historyChunks = historyContext.tokens;
    }

    if (sections.length === 0) {
      return null;
    }

    const content = this.wrapContext(sections.join("\n\n"));
    const tokenEstimate = Object.values(layers).reduce((a, b) => a + b, 0);

    return {
      content,
      tokenEstimate,
      layers,
    };
  }

  /**
   * Wrap assembled context with instructions.
   */
  private wrapContext(content: string): string {
    return `<working-memory>
The following is your persistent working memory. This context survives conversation compaction.
Use it to maintain continuity about who you are, who the user is, and what you're working on.

${content}
</working-memory>`;
  }

  // ==========================================================================
  // Layer Assemblers
  // ==========================================================================

  private async assembleIdentity(): Promise<{ content: string; tokens: number } | null> {
    try {
      const content = await this.identity.formatForContext();
      if (!content) return null;

      const tokens = Math.ceil(content.length / 4);
      if (tokens > this.config.identityTokens) {
        this.logger.warn(`injection: identity exceeds budget (${tokens} > ${this.config.identityTokens})`);
        // Still include it, but log the warning
      }

      return { content, tokens };
    } catch (err) {
      this.logger.warn(`injection: failed to assemble identity: ${String(err)}`);
      return null;
    }
  }

  private async assembleActiveContext(): Promise<{ content: string; tokens: number } | null> {
    try {
      const content = await this.activeContext.formatForContext();
      if (!content) return null;

      const tokens = Math.ceil(content.length / 4);
      if (tokens > this.config.activeContextTokens) {
        this.logger.warn(`injection: active context exceeds budget (${tokens} > ${this.config.activeContextTokens})`);
      }

      return { content, tokens };
    } catch (err) {
      this.logger.warn(`injection: failed to assemble active context: ${String(err)}`);
      return null;
    }
  }

  private async assembleFacts(prompt: string): Promise<{ content: string; tokens: number } | null> {
    try {
      // Get topics from active context for better relevance
      const topics = await this.activeContext.getTopicsForRelevance();

      // Build query from prompt + topics
      const queryTerms = [
        prompt.slice(0, 200), // First part of prompt
        ...topics,
      ];
      const query = queryTerms.join(" ");

      // Search for relevant facts
      const relevantFacts = await this.facts.search(query, {
        limit: Math.floor(this.config.factsTokens / 20), // Rough estimate: ~20 tokens per fact
      });

      if (relevantFacts.length === 0) {
        // Fall back to recent facts
        const recentFacts = await this.facts.getRecent(5);
        if (recentFacts.length === 0) return null;

        const content = await this.facts.formatForContext({ limit: 5 });
        const tokens = Math.ceil(content.length / 4);
        return { content, tokens };
      }

      const content = await this.facts.formatForContext({
        query,
        limit: 10,
      });

      if (!content) return null;

      const tokens = Math.ceil(content.length / 4);
      return { content, tokens };
    } catch (err) {
      this.logger.warn(`injection: failed to assemble facts: ${String(err)}`);
      return null;
    }
  }

  private async assembleIntegrations(prompt: string): Promise<{ content: string; tokens: number } | null> {
    try {
      const content = await this.integrations.formatForContext({
        message: prompt,
        maxTokens: this.config.integrationTokens,
      });

      if (!content) return null;

      const tokens = Math.ceil(content.length / 4);
      return { content, tokens };
    } catch (err) {
      this.logger.warn(`injection: failed to assemble integrations: ${String(err)}`);
      return null;
    }
  }

  private async assembleHistoryChunks(prompt: string): Promise<{ content: string; tokens: number } | null> {
    // Skip if embeddings not configured
    if (!this.embeddings || !this.vectorStore || !this.embeddings.isEnabled()) {
      return null;
    }

    try {
      // Generate embedding for the current prompt
      const promptEmbedding = await this.embeddings.embed(prompt);

      // Search for semantically similar history chunks
      const results = await this.vectorStore.search(promptEmbedding.embedding, 5);

      if (results.length === 0) {
        return null;
      }

      // Format chunks for context
      const content = this.formatHistoryChunks(results.map((r) => r.chunk));
      const tokens = Math.ceil(content.length / 4);

      if (tokens > this.config.historyChunksTokens) {
        // Trim to fit budget
        const trimmedResults = this.trimChunksToTokenBudget(
          results.map((r) => r.chunk),
          this.config.historyChunksTokens
        );
        const trimmedContent = this.formatHistoryChunks(trimmedResults);
        return { content: trimmedContent, tokens: Math.ceil(trimmedContent.length / 4) };
      }

      return { content, tokens };
    } catch (err) {
      this.logger.warn(`injection: failed to assemble history chunks: ${String(err)}`);
      return null;
    }
  }

  private formatHistoryChunks(chunks: HistoryChunk[]): string {
    if (chunks.length === 0) return "";

    const formatted = chunks
      .map((chunk) => {
        const age = this.getRelativeAge(chunk.createdAt);
        return `- [${chunk.topic}] (${age}): ${chunk.summary}`;
      })
      .join("\n");

    return `<relevant-history>
Previous conversation context that may be relevant:

${formatted}
</relevant-history>`;
  }

  private trimChunksToTokenBudget(chunks: HistoryChunk[], maxTokens: number): HistoryChunk[] {
    const result: HistoryChunk[] = [];
    let totalTokens = 50; // Overhead for wrapper

    for (const chunk of chunks) {
      const chunkTokens = Math.ceil(chunk.summary.length / 4) + 20; // +20 for metadata
      if (totalTokens + chunkTokens > maxTokens) break;
      result.push(chunk);
      totalTokens += chunkTokens;
    }

    return result;
  }

  private getRelativeAge(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Estimate total token budget used.
   */
  getTotalBudget(): number {
    return (
      this.config.identityTokens +
      this.config.activeContextTokens +
      this.config.factsTokens +
      this.config.integrationTokens +
      this.config.historyChunksTokens
    );
  }

  /**
   * Get budget breakdown.
   */
  getBudgetBreakdown(): InjectionConfig {
    return { ...this.config };
  }
}
