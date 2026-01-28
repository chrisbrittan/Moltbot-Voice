/**
 * Vector Store
 *
 * In-memory vector similarity search using cosine similarity.
 * Backed by SQLite storage for persistence.
 */

import type { HistoryChunk, Logger } from "./types.js";
import type { WorkingMemoryStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface VectorSearchResult {
  chunk: HistoryChunk;
  similarity: number;
}

export interface VectorStoreConfig {
  // Maximum chunks to keep in memory for fast search
  maxInMemoryChunks: number;
  // Similarity threshold (0-1) below which results are filtered
  similarityThreshold: number;
}

// ============================================================================
// Vector Math Utilities
// ============================================================================

/**
 * Calculate cosine similarity between two vectors
 * Returns value between -1 and 1, where 1 is identical
 */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimensions don't match: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Calculate Euclidean distance between two vectors
 */
export function euclideanDistance(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimensions don't match: ${a.length} vs ${b.length}`);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Normalize a vector to unit length
 */
export function normalizeVector(v: Float32Array | number[]): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);

  const normalized = new Float32Array(v.length);
  if (norm === 0) return normalized;

  for (let i = 0; i < v.length; i++) {
    normalized[i] = v[i] / norm;
  }
  return normalized;
}

// ============================================================================
// Vector Store
// ============================================================================

export class VectorStore {
  private inMemoryChunks: Map<string, { chunk: HistoryChunk; embedding: Float32Array }> = new Map();

  constructor(
    private readonly store: WorkingMemoryStore,
    private readonly config: VectorStoreConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Search for similar chunks by embedding
   */
  async search(queryEmbedding: Float32Array, limit: number = 5): Promise<VectorSearchResult[]> {
    // Ensure in-memory index is populated
    await this.ensureIndex();

    const results: VectorSearchResult[] = [];

    for (const { chunk, embedding } of this.inMemoryChunks.values()) {
      const similarity = cosineSimilarity(queryEmbedding, embedding);

      if (similarity >= this.config.similarityThreshold) {
        results.push({ chunk, similarity });
      }
    }

    // Sort by similarity (highest first) and limit
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * Add a chunk with its embedding to the index
   */
  async addChunk(chunk: HistoryChunk, embedding: Float32Array): Promise<void> {
    // Add to in-memory index
    this.inMemoryChunks.set(chunk.id, { chunk, embedding });

    // Prune if over limit (remove oldest by createdAt)
    if (this.inMemoryChunks.size > this.config.maxInMemoryChunks) {
      this.pruneIndex();
    }

    this.logger.info?.(`vector-store: added chunk ${chunk.id} (total: ${this.inMemoryChunks.size})`);
  }

  /**
   * Remove a chunk from the index
   */
  removeChunk(chunkId: string): void {
    this.inMemoryChunks.delete(chunkId);
  }

  /**
   * Get the number of indexed chunks
   */
  size(): number {
    return this.inMemoryChunks.size;
  }

  /**
   * Clear the in-memory index (will be rebuilt on next search)
   */
  clearIndex(): void {
    this.inMemoryChunks.clear();
  }

  /**
   * Rebuild the index from the database
   */
  async rebuildIndex(): Promise<void> {
    this.clearIndex();
    await this.ensureIndex();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async ensureIndex(): Promise<void> {
    if (this.inMemoryChunks.size > 0) {
      return; // Index already populated
    }

    // Load recent chunks with embeddings from database
    const chunks = await this.store.getRecentChunks(this.config.maxInMemoryChunks);

    for (const chunk of chunks) {
      if (chunk.embedding && chunk.embedding.length > 0) {
        const embedding = new Float32Array(chunk.embedding);
        this.inMemoryChunks.set(chunk.id, { chunk, embedding });
      }
    }

    this.logger.info?.(`vector-store: loaded ${this.inMemoryChunks.size} chunks into memory`);
  }

  private pruneIndex(): void {
    // Get all chunks sorted by createdAt (oldest first)
    const sorted = Array.from(this.inMemoryChunks.entries()).sort(
      (a, b) => a[1].chunk.createdAt - b[1].chunk.createdAt
    );

    // Remove oldest until we're under limit
    const toRemove = sorted.length - this.config.maxInMemoryChunks;
    for (let i = 0; i < toRemove; i++) {
      this.inMemoryChunks.delete(sorted[i][0]);
    }

    this.logger.info?.(`vector-store: pruned ${toRemove} old chunks`);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createVectorStore(
  store: WorkingMemoryStore,
  config?: Partial<VectorStoreConfig>,
  logger?: Logger
): VectorStore {
  const fullConfig: VectorStoreConfig = {
    maxInMemoryChunks: config?.maxInMemoryChunks ?? 100,
    similarityThreshold: config?.similarityThreshold ?? 0.3,
  };

  return new VectorStore(
    store,
    fullConfig,
    logger ?? { info: () => {}, warn: () => {}, error: () => {} }
  );
}
