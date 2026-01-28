/**
 * History Chunk Manager
 *
 * Creates semantic history chunks from conversations, generates embeddings,
 * and stores them for later retrieval via vector search.
 */

import type { WorkingMemoryStore } from "./store.js";
import type { EmbeddingService } from "./embeddings.js";
import type { VectorStore } from "./vector-store.js";
import type { HistoryChunk, Logger } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface HistoryChunkConfig {
  enabled: boolean;
  maxChunks: number;
  summarizeAfterMessages: number;
  maxSummaryTokens: number;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
}

interface ChunkSummary {
  topic: string;
  summary: string;
  entities: string[];
  tokenCount: number;
}

// ============================================================================
// History Chunk Manager
// ============================================================================

export class HistoryChunkManager {
  private messageBuffer: ConversationMessage[] = [];
  private lastChunkAt = 0;

  constructor(
    private readonly store: WorkingMemoryStore,
    private readonly embeddings: EmbeddingService | null,
    private readonly vectorStore: VectorStore | null,
    private readonly config: HistoryChunkConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Process messages and create a chunk if needed
   */
  async processMessages(
    messages: ConversationMessage[],
    sessionKey?: string,
    channel?: string
  ): Promise<HistoryChunk | null> {
    if (!this.config.enabled) return null;

    // Add new messages to buffer
    this.messageBuffer.push(...messages);

    // Check if we should create a chunk
    if (this.messageBuffer.length < this.config.summarizeAfterMessages) {
      return null;
    }

    // Create chunk from buffer
    const chunk = await this.createChunk(this.messageBuffer, sessionKey, channel);

    // Clear buffer
    this.messageBuffer = [];
    this.lastChunkAt = Date.now();

    // Prune old chunks if needed
    await this.pruneOldChunks();

    return chunk;
  }

  /**
   * Force creation of a chunk from current buffer (e.g., at session end)
   */
  async flushBuffer(sessionKey?: string, channel?: string): Promise<HistoryChunk | null> {
    if (this.messageBuffer.length === 0) return null;

    const chunk = await this.createChunk(this.messageBuffer, sessionKey, channel);
    this.messageBuffer = [];
    return chunk;
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.messageBuffer.length;
  }

  /**
   * Backfill embeddings for chunks that don't have them
   */
  async backfillEmbeddings(limit = 50): Promise<number> {
    if (!this.embeddings || !this.vectorStore) {
      this.logger.warn("history-chunks: cannot backfill - embeddings not configured");
      return 0;
    }

    const chunksWithoutEmbeddings = await this.store.getChunksWithoutEmbeddings(limit);
    let count = 0;

    for (const chunk of chunksWithoutEmbeddings) {
      try {
        const embeddingResult = await this.embeddings.embed(chunk.summary);
        await this.store.updateChunkEmbedding(chunk.id, embeddingResult.embedding);
        await this.vectorStore.addChunk(
          { ...chunk, embedding: Array.from(embeddingResult.embedding) },
          embeddingResult.embedding
        );
        count++;
      } catch (err) {
        this.logger.warn(`history-chunks: failed to embed chunk ${chunk.id}: ${String(err)}`);
      }
    }

    this.logger.info(`history-chunks: backfilled ${count} embeddings`);
    return count;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async createChunk(
    messages: ConversationMessage[],
    sessionKey?: string,
    channel?: string
  ): Promise<HistoryChunk> {
    // Create summary from messages
    const summary = this.summarizeMessages(messages);

    // Generate embedding if available
    let embedding: number[] | undefined;
    if (this.embeddings && this.embeddings.isEnabled()) {
      try {
        const embeddingResult = await this.embeddings.embed(summary.summary);
        embedding = Array.from(embeddingResult.embedding);
      } catch (err) {
        this.logger.warn(`history-chunks: failed to generate embedding: ${String(err)}`);
      }
    }

    // Store the chunk
    const id = await this.store.addHistoryChunk({
      topic: summary.topic,
      summary: summary.summary,
      entities: summary.entities,
      sessionKey,
      channel,
      tokenCount: summary.tokenCount,
      embedding,
    });

    const chunk: HistoryChunk = {
      id,
      topic: summary.topic,
      summary: summary.summary,
      entities: summary.entities,
      sessionKey,
      channel,
      createdAt: Date.now(),
      tokenCount: summary.tokenCount,
      embedding,
    };

    // Add to vector store if we have an embedding
    if (embedding && this.vectorStore) {
      await this.vectorStore.addChunk(chunk, new Float32Array(embedding));
    }

    this.logger.info(`history-chunks: created chunk "${summary.topic}" (${summary.tokenCount} tokens)`);

    return chunk;
  }

  private summarizeMessages(messages: ConversationMessage[]): ChunkSummary {
    // Extract key information from messages
    const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
    const assistantMessages = messages.filter((m) => m.role === "assistant").map((m) => m.content);

    // Generate topic from first user message (simplified - could use LLM later)
    const topic = this.extractTopic(userMessages[0] || "General discussion");

    // Generate summary (simplified - could use LLM later)
    const summary = this.generateSummary(messages);

    // Extract entities (simplified - could use NER or LLM later)
    const entities = this.extractEntities(messages);

    // Estimate token count
    const tokenCount = Math.ceil(summary.length / 4);

    return { topic, summary, entities, tokenCount };
  }

  private extractTopic(firstMessage: string): string {
    // Simple topic extraction - take first sentence or first 50 chars
    const firstSentence = firstMessage.split(/[.!?]/)[0];
    const topic = firstSentence.slice(0, 50).trim();
    return topic || "Discussion";
  }

  private generateSummary(messages: ConversationMessage[]): string {
    // Simple summary generation - concatenate key points
    // In Phase 2.3, this would use an LLM for proper summarization
    const parts: string[] = [];

    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    if (userMessages.length > 0) {
      const userTopics = userMessages
        .slice(0, 3)
        .map((m) => m.content.slice(0, 100))
        .join("; ");
      parts.push(`User asked about: ${userTopics}`);
    }

    if (assistantMessages.length > 0) {
      // Look for decisions or key actions
      const keyPoints = assistantMessages
        .map((m) => {
          // Look for indicators of decisions/actions
          const content = m.content;
          if (content.includes("decided") || content.includes("will") || content.includes("created")) {
            return content.slice(0, 150);
          }
          return null;
        })
        .filter(Boolean)
        .slice(0, 2);

      if (keyPoints.length > 0) {
        parts.push(`Key outcomes: ${keyPoints.join("; ")}`);
      }
    }

    // Limit total summary length
    const summary = parts.join(" ").slice(0, this.config.maxSummaryTokens * 4);
    return summary || "Conversation about various topics.";
  }

  private extractEntities(messages: ConversationMessage[]): string[] {
    const entities = new Set<string>();
    const allContent = messages.map((m) => m.content).join(" ");

    // Extract capitalized words (simple NER)
    const capitalizedWords = allContent.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (capitalizedWords) {
      for (const word of capitalizedWords.slice(0, 10)) {
        if (word.length > 2 && !["The", "This", "That", "What", "When", "Where", "How"].includes(word)) {
          entities.add(word);
        }
      }
    }

    // Extract quoted strings
    const quoted = allContent.match(/"([^"]+)"/g);
    if (quoted) {
      for (const q of quoted.slice(0, 5)) {
        const clean = q.replace(/"/g, "").slice(0, 30);
        if (clean.length > 2) {
          entities.add(clean);
        }
      }
    }

    // Extract code-like terms (camelCase, snake_case)
    const codeTerms = allContent.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b/g);
    if (codeTerms) {
      for (const term of codeTerms.slice(0, 10)) {
        entities.add(term);
      }
    }

    return Array.from(entities).slice(0, 15);
  }

  private async pruneOldChunks(): Promise<void> {
    const pruned = await this.store.pruneOldChunks(this.config.maxChunks);
    if (pruned > 0) {
      this.logger.info(`history-chunks: pruned ${pruned} old chunks`);

      // Rebuild vector store index after pruning
      if (this.vectorStore) {
        await this.vectorStore.rebuildIndex();
      }
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createHistoryChunkManager(
  store: WorkingMemoryStore,
  embeddings: EmbeddingService | null,
  vectorStore: VectorStore | null,
  config?: Partial<HistoryChunkConfig>,
  logger?: Logger
): HistoryChunkManager {
  const fullConfig: HistoryChunkConfig = {
    enabled: config?.enabled ?? true,
    maxChunks: config?.maxChunks ?? 100,
    summarizeAfterMessages: config?.summarizeAfterMessages ?? 10,
    maxSummaryTokens: config?.maxSummaryTokens ?? 500,
  };

  return new HistoryChunkManager(
    store,
    embeddings,
    vectorStore,
    fullConfig,
    logger ?? { info: () => {}, warn: () => {}, error: () => {} }
  );
}
