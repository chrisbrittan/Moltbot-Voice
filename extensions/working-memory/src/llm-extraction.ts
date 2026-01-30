/**
 * LLM-Based Fact Extraction
 *
 * Uses a cheap LLM (Haiku) to intelligently extract facts from conversations.
 * Provides smarter extraction than pattern matching at ~$0.001/turn.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface LLMExtractionConfig {
  model: string;
  provider: "anthropic" | "openai";
  maxTokens?: number;
  apiKey?: string;
}

export interface ExtractedFact {
  category: "user" | "preference" | "decision" | "project" | "entity" | "other";
  subject: string;
  value: string;
  confidence: number;
}

export interface IdentityUpdates {
  userName: string | null;
  userPreferences: string[];
  personalityTone: string | null;
  personalityCommunicationStyle: string | null;
}

export interface ContextUpdates {
  projectName: string | null;
  projectGoal: string | null;
  taskDescription: string | null;
  filesInvolved: string[];
  decisions: string[];
}

export interface LLMExtractionResult {
  facts: ExtractedFact[];
  identityUpdates: IdentityUpdates;
  contextUpdates: ContextUpdates;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ============================================================================
// LLM Extraction Service
// ============================================================================

export class LLMExtractionService {
  private extractPromptTemplate: string | null = null;

  constructor(
    private readonly config: LLMExtractionConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Extract facts from a conversation using LLM
   */
  async extract(messages: Array<{ role: string; content: string }>): Promise<LLMExtractionResult> {
    // Load prompt template if not cached
    if (!this.extractPromptTemplate) {
      this.extractPromptTemplate = await this.loadPromptTemplate("extract-facts.md");
    }

    // Format conversation for the prompt
    const conversationText = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    // Build the prompt
    const prompt = this.extractPromptTemplate.replace("{{CONVERSATION}}", conversationText);

    // Call LLM
    const response = await this.callLLM(prompt);

    // Parse response
    return this.parseResponse(response);
  }

  /**
   * Check if a message contains extractable content (quick pre-filter)
   */
  hasExtractableContent(text: string): boolean {
    // Quick patterns that suggest extractable content
    const quickPatterns = [
      /my name is/i,
      /i('m| am) /i,
      /i (prefer|like|hate|love|want|need)/i,
      /remember/i,
      /decided|decision/i,
      /working on/i,
      /project/i,
      /be more|be less/i,
      /always|never/i,
    ];

    return quickPatterns.some((p) => p.test(text));
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async loadPromptTemplate(filename: string): Promise<string> {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const promptPath = path.join(__dirname, "..", "prompts", filename);

    try {
      return await fs.readFile(promptPath, "utf-8");
    } catch (err) {
      this.logger.error(`Failed to load prompt template ${filename}: ${String(err)}`);
      throw new Error(`Prompt template not found: ${filename}`);
    }
  }

  private async callLLM(prompt: string): Promise<string> {
    if (this.config.provider === "anthropic") {
      return this.callAnthropic(prompt);
    }
    throw new Error(`Unsupported LLM provider: ${this.config.provider}`);
  }

  private async callAnthropic(prompt: string): Promise<string> {
    const apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("Anthropic API key not provided in config and ANTHROPIC_API_KEY environment variable is not set");
    }

    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: prompt,
      },
    ];

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 1024,
        messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as AnthropicResponse;

    this.logger.info?.(
      `llm-extraction: used ${data.usage.input_tokens} input, ${data.usage.output_tokens} output tokens`
    );

    // Extract text from response
    const textContent = data.content.find((c) => c.type === "text");
    if (!textContent) {
      throw new Error("No text content in Anthropic response");
    }

    return textContent.text;
  }

  private parseResponse(response: string): LLMExtractionResult {
    // Try to extract JSON from the response
    // The model might include markdown code blocks or extra text
    let jsonStr = response.trim();

    // Remove markdown code block if present
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to find JSON object
    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      jsonStr = objectMatch[0];
    }

    try {
      const parsed = JSON.parse(jsonStr) as Partial<LLMExtractionResult>;

      // Validate and normalize the response
      return {
        facts: this.normalizeFacts(parsed.facts ?? []),
        identityUpdates: this.normalizeIdentityUpdates(parsed.identityUpdates),
        contextUpdates: this.normalizeContextUpdates(parsed.contextUpdates),
      };
    } catch (err) {
      this.logger.warn(`llm-extraction: failed to parse response: ${String(err)}`);
      this.logger.warn(`llm-extraction: raw response: ${response.slice(0, 500)}`);

      // Return empty result on parse failure
      return {
        facts: [],
        identityUpdates: {
          userName: null,
          userPreferences: [],
          personalityTone: null,
          personalityCommunicationStyle: null,
        },
        contextUpdates: {
          projectName: null,
          projectGoal: null,
          taskDescription: null,
          filesInvolved: [],
          decisions: [],
        },
      };
    }
  }

  private normalizeFacts(facts: unknown[]): ExtractedFact[] {
    if (!Array.isArray(facts)) return [];

    return facts
      .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
      .map((f) => ({
        category: this.normalizeCategory(f.category),
        subject: String(f.subject ?? "unknown"),
        value: String(f.value ?? ""),
        confidence: typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.8,
      }))
      .filter((f) => f.value.length > 0);
  }

  private normalizeCategory(
    cat: unknown
  ): "user" | "preference" | "decision" | "project" | "entity" | "other" {
    const valid = ["user", "preference", "decision", "project", "entity", "other"];
    const catStr = String(cat ?? "other").toLowerCase();
    return valid.includes(catStr) ? (catStr as ExtractedFact["category"]) : "other";
  }

  private normalizeIdentityUpdates(updates: unknown): IdentityUpdates {
    if (!updates || typeof updates !== "object") {
      return {
        userName: null,
        userPreferences: [],
        personalityTone: null,
        personalityCommunicationStyle: null,
      };
    }

    const u = updates as Record<string, unknown>;

    return {
      userName: typeof u.userName === "string" ? u.userName : null,
      userPreferences: Array.isArray(u.userPreferences)
        ? u.userPreferences.filter((p): p is string => typeof p === "string")
        : [],
      personalityTone: typeof u.personalityTone === "string" ? u.personalityTone : null,
      personalityCommunicationStyle:
        typeof u.personalityCommunicationStyle === "string" ? u.personalityCommunicationStyle : null,
    };
  }

  private normalizeContextUpdates(updates: unknown): ContextUpdates {
    if (!updates || typeof updates !== "object") {
      return {
        projectName: null,
        projectGoal: null,
        taskDescription: null,
        filesInvolved: [],
        decisions: [],
      };
    }

    const u = updates as Record<string, unknown>;

    return {
      projectName: typeof u.projectName === "string" ? u.projectName : null,
      projectGoal: typeof u.projectGoal === "string" ? u.projectGoal : null,
      taskDescription: typeof u.taskDescription === "string" ? u.taskDescription : null,
      filesInvolved: Array.isArray(u.filesInvolved)
        ? u.filesInvolved.filter((f): f is string => typeof f === "string")
        : [],
      decisions: Array.isArray(u.decisions)
        ? u.decisions.filter((d): d is string => typeof d === "string")
        : [],
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createLLMExtractionService(
  config?: Partial<LLMExtractionConfig>,
  logger?: Logger
): LLMExtractionService {
  const fullConfig: LLMExtractionConfig = {
    model: config?.model ?? "claude-3-5-haiku-latest",
    provider: config?.provider ?? "anthropic",
    maxTokens: config?.maxTokens ?? 1024,
    apiKey: config?.apiKey,
  };

  return new LLMExtractionService(
    fullConfig,
    logger ?? { info: () => {}, warn: () => {}, error: () => {} }
  );
}
