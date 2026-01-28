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
import type { AssembledContext, Logger } from "./types.js";

interface InjectionConfig {
  identityTokens: number;
  activeContextTokens: number;
  factsTokens: number;
  integrationTokens: number;
  historyChunksTokens: number;
}

export class ContextInjector {
  constructor(
    private readonly identity: IdentityManager,
    private readonly activeContext: ActiveContextManager,
    private readonly facts: FactStore,
    private readonly integrations: IntegrationCache,
    private readonly config: InjectionConfig,
    private readonly logger: Logger
  ) {}

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

    // Layer 5: History Chunks (retrieved based on prompt + active context)
    // TODO: Implement semantic history chunk retrieval
    // For now, this is a placeholder for Phase 2

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
