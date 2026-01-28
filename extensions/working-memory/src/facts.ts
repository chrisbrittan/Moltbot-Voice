/**
 * Fact Store
 *
 * Manages persistent facts extracted from conversations.
 * Supports categories, search, and temporal tracking.
 */

import type { WorkingMemoryStore } from "./store.js";
import type { Fact, FactCategory, FactSearchResult, Logger } from "./types.js";

export class FactStore {
  constructor(
    private readonly store: WorkingMemoryStore,
    private readonly logger: Logger
  ) {}

  // ==========================================================================
  // CRUD Operations
  // ==========================================================================

  async addFact(params: {
    category: string;
    subject: string;
    predicate?: string;
    value: string;
    confidence?: number;
    sourceSession?: string;
    supersedes?: string;
    expiresAt?: number;
  }): Promise<string> {
    const id = await this.store.addFact({
      category: params.category as FactCategory,
      subject: params.subject,
      predicate: params.predicate,
      value: params.value,
      confidence: params.confidence ?? 1.0,
      sourceSession: params.sourceSession,
      supersedes: params.supersedes,
      expiresAt: params.expiresAt,
    });

    this.logger.info(`facts: added fact [${params.category}] ${params.subject}: ${params.value.slice(0, 50)}...`);
    return id;
  }

  async getFact(id: string): Promise<Fact | null> {
    return this.store.getFact(id);
  }

  async updateFact(id: string, updates: Partial<Fact>): Promise<void> {
    await this.store.updateFact(id, updates);
    this.logger.info(`facts: updated fact ${id}`);
  }

  async deleteFact(id: string): Promise<void> {
    await this.store.deleteFact(id);
    this.logger.info(`facts: deleted fact ${id}`);
  }

  // ==========================================================================
  // Query Operations
  // ==========================================================================

  async list(options: { category?: string; limit?: number; offset?: number } = {}): Promise<Fact[]> {
    return this.store.listFacts(options);
  }

  async search(query: string, options: { category?: string; limit?: number } = {}): Promise<FactSearchResult[]> {
    const results = await this.store.searchFacts(query, options);
    return results.map((fact) => ({
      ...fact,
      relevanceScore: 1.0, // FTS doesn't provide a normalized score easily
    }));
  }

  async getRecent(limit = 20): Promise<Fact[]> {
    return this.store.getRecentFacts(limit);
  }

  async getBySubject(subject: string, limit = 10): Promise<Fact[]> {
    return this.store.getFactsBySubject(subject, limit);
  }

  async getByCategory(category: string, limit = 50): Promise<Fact[]> {
    return this.store.listFacts({ category, limit });
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  async addUserFact(subject: string, value: string): Promise<string> {
    return this.addFact({
      category: "user",
      subject,
      value,
    });
  }

  async addPreference(preference: string): Promise<string> {
    return this.addFact({
      category: "preference",
      subject: "user",
      value: preference,
    });
  }

  async addDecision(decision: string, context?: string): Promise<string> {
    return this.addFact({
      category: "decision",
      subject: context ?? "general",
      value: decision,
    });
  }

  async addProjectFact(project: string, fact: string): Promise<string> {
    return this.addFact({
      category: "project",
      subject: project,
      value: fact,
    });
  }

  async addEntityFact(entity: string, fact: string): Promise<string> {
    return this.addFact({
      category: "entity",
      subject: entity,
      value: fact,
    });
  }

  // ==========================================================================
  // Deduplication
  // ==========================================================================

  /**
   * Check if a similar fact already exists.
   * Returns the existing fact if found, null otherwise.
   */
  async findSimilar(value: string, category?: string): Promise<Fact | null> {
    // Simple text search for now
    const results = await this.search(value, { category, limit: 1 });
    if (results.length > 0) {
      // Check if it's actually similar (not just contains a common word)
      const existing = results[0];
      const similarity = this.textSimilarity(value, existing.value);
      if (similarity > 0.8) {
        return existing;
      }
    }
    return null;
  }

  /**
   * Add fact only if no similar fact exists.
   * If similar exists, optionally update it.
   */
  async addOrUpdate(params: {
    category: string;
    subject: string;
    value: string;
    confidence?: number;
    updateIfExists?: boolean;
  }): Promise<{ id: string; action: "created" | "updated" | "skipped" }> {
    const existing = await this.findSimilar(params.value, params.category);

    if (existing) {
      if (params.updateIfExists) {
        await this.updateFact(existing.id, {
          value: params.value,
          confidence: params.confidence,
        });
        return { id: existing.id, action: "updated" };
      }
      return { id: existing.id, action: "skipped" };
    }

    const id = await this.addFact(params);
    return { id, action: "created" };
  }

  /**
   * Simple text similarity using Jaccard index.
   */
  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));

    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  // ==========================================================================
  // Context Formatting
  // ==========================================================================

  /**
   * Format relevant facts for injection into agent context.
   */
  async formatForContext(options: {
    query?: string;
    categories?: string[];
    limit?: number;
  } = {}): Promise<string> {
    let facts: Fact[];

    if (options.query) {
      facts = await this.search(options.query, { limit: options.limit ?? 10 });
    } else {
      facts = await this.getRecent(options.limit ?? 10);
    }

    if (options.categories) {
      facts = facts.filter((f) => options.categories!.includes(f.category));
    }

    if (facts.length === 0) {
      return "";
    }

    const sections: string[] = [];
    sections.push(`<relevant-facts>`);

    // Group by category for readability
    const byCategory = new Map<string, Fact[]>();
    for (const fact of facts) {
      const existing = byCategory.get(fact.category) ?? [];
      existing.push(fact);
      byCategory.set(fact.category, existing);
    }

    for (const [category, categoryFacts] of byCategory) {
      sections.push(`[${category}]`);
      for (const fact of categoryFacts) {
        sections.push(`- ${fact.subject}: ${fact.value}`);
      }
    }

    sections.push(`</relevant-facts>`);
    return sections.join("\n");
  }

  /**
   * Estimate token count for facts context.
   */
  estimateTokens(facts: Fact[]): number {
    const text = facts.map((f) => `${f.subject}: ${f.value}`).join("\n");
    return Math.ceil(text.length / 4);
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  async getStats(): Promise<{
    total: number;
    byCategory: Record<string, number>;
    recentCount: number;
  }> {
    const all = await this.list({ limit: 10000 });
    const byCategory: Record<string, number> = {};

    for (const fact of all) {
      byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1;
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentCount = all.filter((f) => f.createdAt > dayAgo).length;

    return {
      total: all.length,
      byCategory,
      recentCount,
    };
  }
}
