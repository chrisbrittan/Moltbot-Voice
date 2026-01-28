/**
 * Embedding Service
 *
 * Generates embeddings for text using OpenAI or Ollama providers.
 * Supports fallback to local Ollama for offline use.
 */

import type { Logger } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingConfig {
  enabled: boolean;
  provider: "openai" | "ollama";
  model: string;
  dimensions: number;
  ollamaBaseUrl?: string;
  fallbackProvider?: "openai" | "ollama";
  fallbackModel?: string;
}

export interface EmbeddingResult {
  embedding: Float32Array;
  model: string;
  provider: string;
  tokenCount?: number;
}

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

// ============================================================================
// Embedding Service
// ============================================================================

export class EmbeddingService {
  private cache = new Map<string, { embedding: Float32Array; timestamp: number }>();
  private readonly cacheTtl = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly config: EmbeddingConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Generate embedding for a single text input
   */
  async embed(text: string): Promise<EmbeddingResult> {
    if (!this.config.enabled) {
      throw new Error("Embeddings are disabled");
    }

    // Check cache first
    const cacheKey = this.getCacheKey(text);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      return {
        embedding: cached.embedding,
        model: this.config.model,
        provider: this.config.provider,
      };
    }

    try {
      const result = await this.generateEmbedding(text, this.config.provider, this.config.model);

      // Cache the result
      this.cache.set(cacheKey, { embedding: result.embedding, timestamp: Date.now() });

      return result;
    } catch (err) {
      // Try fallback if configured
      if (this.config.fallbackProvider && this.config.fallbackModel) {
        this.logger.warn(
          `Primary embedding failed, trying fallback: ${this.config.fallbackProvider}/${this.config.fallbackModel}`
        );
        return this.generateEmbedding(text, this.config.fallbackProvider, this.config.fallbackModel);
      }
      throw err;
    }
  }

  /**
   * Generate embeddings for multiple texts (batched for efficiency)
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.config.enabled) {
      throw new Error("Embeddings are disabled");
    }

    // For OpenAI, we can batch requests
    if (this.config.provider === "openai") {
      return this.batchEmbedOpenAI(texts);
    }

    // For Ollama, process sequentially (no batch API)
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  /**
   * Get embedding dimensions for the current model
   */
  getDimensions(): number {
    return this.config.dimensions;
  }

  /**
   * Check if embeddings are enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Clear the embedding cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async generateEmbedding(
    text: string,
    provider: "openai" | "ollama",
    model: string
  ): Promise<EmbeddingResult> {
    if (provider === "openai") {
      return this.embedOpenAI(text, model);
    } else if (provider === "ollama") {
      return this.embedOllama(text, model);
    }
    throw new Error(`Unknown embedding provider: ${provider}`);
  }

  private async embedOpenAI(text: string, model: string): Promise<EmbeddingResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        dimensions: this.config.dimensions,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI embedding failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;

    return {
      embedding: new Float32Array(data.data[0].embedding),
      model: data.model,
      provider: "openai",
      tokenCount: data.usage.prompt_tokens,
    };
  }

  private async batchEmbedOpenAI(texts: string[]): Promise<EmbeddingResult[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts,
        dimensions: this.config.dimensions,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI batch embedding failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;

    // Sort by index to maintain order
    const sorted = data.data.sort((a, b) => a.index - b.index);

    return sorted.map((item) => ({
      embedding: new Float32Array(item.embedding),
      model: data.model,
      provider: "openai",
      tokenCount: Math.floor(data.usage.prompt_tokens / texts.length),
    }));
  }

  private async embedOllama(text: string, model: string): Promise<EmbeddingResult> {
    const baseUrl = this.config.ollamaBaseUrl || "http://localhost:11434";

    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama embedding failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as OllamaEmbeddingResponse;

    return {
      embedding: new Float32Array(data.embedding),
      model,
      provider: "ollama",
    };
  }

  private getCacheKey(text: string): string {
    // Simple hash for cache key
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `${this.config.provider}:${this.config.model}:${hash}`;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createEmbeddingService(config: Partial<EmbeddingConfig>, logger: Logger): EmbeddingService {
  const fullConfig: EmbeddingConfig = {
    enabled: config.enabled ?? true,
    provider: (config.provider as "openai" | "ollama") ?? "openai",
    model: config.model ?? "text-embedding-3-small",
    dimensions: config.dimensions ?? 1536,
    ollamaBaseUrl: config.ollamaBaseUrl ?? "http://localhost:11434",
    fallbackProvider: config.fallbackProvider as "openai" | "ollama" | undefined,
    fallbackModel: config.fallbackModel,
  };

  return new EmbeddingService(fullConfig, logger);
}
