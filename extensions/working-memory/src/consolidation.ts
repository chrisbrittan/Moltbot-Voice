/**
 * Memory Consolidation
 *
 * Periodically consolidates and cleans up working memory:
 * - Merges duplicate facts
 * - Expires old, low-confidence facts
 * - Marks superseded facts
 * - Prunes old history chunks
 */

import type { WorkingMemoryStore } from "./store.js";
import type { EmbeddingService } from "./embeddings.js";
import type { Fact, Logger } from "./types.js";
import { cosineSimilarity } from "./vector-store.js";

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationConfig {
  enabled: boolean;
  intervalHours: number;
  expireAfterDays: number;
  expireConfidenceThreshold: number;
  // Similarity threshold for duplicate detection (0-1)
  duplicateSimilarityThreshold?: number;
}

export interface ConsolidationResult {
  mergedFacts: number;
  expiredFacts: number;
  supersededFacts: number;
  prunedChunks: number;
  duration: number;
}

interface FactWithEmbedding {
  fact: Fact;
  embedding?: Float32Array;
}

// ============================================================================
// Memory Consolidator
// ============================================================================

export class MemoryConsolidator {
  private lastConsolidation = 0;
  private isRunning = false;

  constructor(
    private readonly store: WorkingMemoryStore,
    private readonly embeddings: EmbeddingService | null,
    private readonly config: ConsolidationConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Run consolidation if enough time has passed since last run
   */
  async maybeConsolidate(): Promise<ConsolidationResult | null> {
    if (!this.config.enabled) return null;
    if (this.isRunning) return null;

    const now = Date.now();
    const intervalMs = this.config.intervalHours * 60 * 60 * 1000;

    if (now - this.lastConsolidation < intervalMs) {
      return null;
    }

    return this.consolidate();
  }

  /**
   * Force consolidation regardless of interval
   */
  async consolidate(): Promise<ConsolidationResult> {
    if (this.isRunning) {
      throw new Error("Consolidation already in progress");
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.info("consolidation: starting...");

      const result: ConsolidationResult = {
        mergedFacts: 0,
        expiredFacts: 0,
        supersededFacts: 0,
        prunedChunks: 0,
        duration: 0,
      };

      // Step 1: Expire old, low-confidence facts
      result.expiredFacts = await this.expireOldFacts();

      // Step 2: Find and merge duplicate facts
      const { merged, superseded } = await this.mergeDuplicates();
      result.mergedFacts = merged;
      result.supersededFacts = superseded;

      // Step 3: Prune old history chunks (already handled by historyChunks manager)
      // This is just a safety check
      result.prunedChunks = await this.pruneChunks();

      result.duration = Date.now() - startTime;
      this.lastConsolidation = Date.now();

      this.logger.info(
        `consolidation: complete in ${result.duration}ms ` +
          `(expired: ${result.expiredFacts}, merged: ${result.mergedFacts}, superseded: ${result.supersededFacts})`
      );

      return result;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get time until next scheduled consolidation
   */
  getNextConsolidationTime(): number | null {
    if (!this.config.enabled) return null;

    const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
    return this.lastConsolidation + intervalMs;
  }

  /**
   * Check if consolidation is currently running
   */
  isConsolidating(): boolean {
    return this.isRunning;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Expire facts that are old and have low confidence
   */
  private async expireOldFacts(): Promise<number> {
    const facts = await this.store.listFacts({ limit: 1000 });
    const now = Date.now();
    const expireThresholdMs = this.config.expireAfterDays * 24 * 60 * 60 * 1000;

    let expiredCount = 0;

    for (const fact of facts) {
      const age = now - fact.createdAt;
      const isOld = age > expireThresholdMs;
      const isLowConfidence = fact.confidence < this.config.expireConfidenceThreshold;

      if (isOld && isLowConfidence) {
        await this.store.deleteFact(fact.id);
        expiredCount++;
        this.logger.info?.(`consolidation: expired fact "${fact.value.slice(0, 50)}..."`);
      }
    }

    return expiredCount;
  }

  /**
   * Find and merge duplicate facts
   */
  private async mergeDuplicates(): Promise<{ merged: number; superseded: number }> {
    const facts = await this.store.listFacts({ limit: 1000 });

    if (facts.length < 2) {
      return { merged: 0, superseded: 0 };
    }

    // Group facts by category for faster comparison
    const byCategory = new Map<string, Fact[]>();
    for (const fact of facts) {
      const existing = byCategory.get(fact.category) || [];
      existing.push(fact);
      byCategory.set(fact.category, existing);
    }

    let merged = 0;
    let superseded = 0;
    const processedIds = new Set<string>();

    for (const [_category, categoryFacts] of byCategory) {
      // Get embeddings for facts if available
      const factsWithEmbeddings = await this.getFactsWithEmbeddings(categoryFacts);

      // Compare each pair of facts
      for (let i = 0; i < factsWithEmbeddings.length; i++) {
        const factA = factsWithEmbeddings[i];

        if (processedIds.has(factA.fact.id)) continue;

        for (let j = i + 1; j < factsWithEmbeddings.length; j++) {
          const factB = factsWithEmbeddings[j];

          if (processedIds.has(factB.fact.id)) continue;

          // Check if facts are similar
          const similarity = this.calculateSimilarity(factA, factB);
          const threshold = this.config.duplicateSimilarityThreshold ?? 0.85;

          if (similarity >= threshold) {
            // Merge: keep the one with higher confidence, or more recent if equal
            const [keep, remove] = this.selectFactToKeep(factA.fact, factB.fact);

            // Mark the removed fact as superseded
            await this.store.updateFact(remove.id, { supersedes: keep.id });
            await this.store.deleteFact(remove.id);

            // Update confidence of kept fact if the removed one had higher
            if (remove.confidence > keep.confidence) {
              await this.store.updateFact(keep.id, { confidence: remove.confidence });
            }

            processedIds.add(remove.id);
            superseded++;
            merged++;

            this.logger.info?.(
              `consolidation: merged "${remove.value.slice(0, 30)}..." into "${keep.value.slice(0, 30)}..."`
            );
          }
        }
      }
    }

    return { merged, superseded };
  }

  /**
   * Get facts with their embeddings (if embedding service available)
   */
  private async getFactsWithEmbeddings(facts: Fact[]): Promise<FactWithEmbedding[]> {
    if (!this.embeddings || !this.embeddings.isEnabled()) {
      return facts.map((fact) => ({ fact }));
    }

    const results: FactWithEmbedding[] = [];

    for (const fact of facts) {
      try {
        const embeddingResult = await this.embeddings.embed(fact.value);
        results.push({ fact, embedding: embeddingResult.embedding });
      } catch {
        results.push({ fact });
      }
    }

    return results;
  }

  /**
   * Calculate similarity between two facts
   */
  private calculateSimilarity(a: FactWithEmbedding, b: FactWithEmbedding): number {
    // If we have embeddings, use cosine similarity
    if (a.embedding && b.embedding) {
      return cosineSimilarity(a.embedding, b.embedding);
    }

    // Fall back to text-based similarity
    return this.textSimilarity(a.fact.value, b.fact.value);
  }

  /**
   * Simple text similarity using Jaccard index
   */
  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));

    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  /**
   * Select which fact to keep when merging duplicates
   */
  private selectFactToKeep(a: Fact, b: Fact): [keep: Fact, remove: Fact] {
    // Prefer higher confidence
    if (a.confidence !== b.confidence) {
      return a.confidence > b.confidence ? [a, b] : [b, a];
    }

    // If equal confidence, prefer more recent
    return a.updatedAt > b.updatedAt ? [a, b] : [b, a];
  }

  /**
   * Prune old history chunks beyond the configured limit
   */
  private async pruneChunks(): Promise<number> {
    // This uses the store's existing method
    // Default to 100 chunks max
    return this.store.pruneOldChunks(100);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createMemoryConsolidator(
  store: WorkingMemoryStore,
  embeddings: EmbeddingService | null,
  config?: Partial<ConsolidationConfig>,
  logger?: Logger
): MemoryConsolidator {
  const fullConfig: ConsolidationConfig = {
    enabled: config?.enabled ?? false,
    intervalHours: config?.intervalHours ?? 24,
    expireAfterDays: config?.expireAfterDays ?? 30,
    expireConfidenceThreshold: config?.expireConfidenceThreshold ?? 0.5,
    duplicateSimilarityThreshold: config?.duplicateSimilarityThreshold ?? 0.85,
  };

  return new MemoryConsolidator(
    store,
    embeddings,
    fullConfig,
    logger ?? { info: () => {}, warn: () => {}, error: () => {} }
  );
}
