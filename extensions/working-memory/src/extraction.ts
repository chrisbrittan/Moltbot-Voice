/**
 * Fact Extractor
 *
 * Extracts facts, identity updates, and context updates from conversations.
 * Runs async after each agent turn using a cheap model (Haiku/GPT-4o-mini).
 */

import type { WorkingMemoryStore } from "./store.js";
import type { IdentityManager } from "./identity.js";
import type { ActiveContextManager } from "./active-context.js";
import type { FactStore } from "./facts.js";
import type { ExtractionResult, Logger } from "./types.js";

interface ExtractionConfig {
  enabled: boolean;
  model: string;
  provider: string;
}

// Patterns that indicate extractable content
const FACT_PATTERNS = [
  /my name is (\w+)/i,
  /i('m| am) (\w+)/i,
  /call me (\w+)/i,
  /i prefer/i,
  /i like/i,
  /i hate/i,
  /i don't like/i,
  /remember (that |this |)/i,
  /always/i,
  /never/i,
  /important/i,
  /decided/i,
  /we('ll| will) use/i,
  /let's (use|go with)/i,
];

const PERSONALITY_PATTERNS = [
  /be more (\w+)/i,
  /be less (\w+)/i,
  /you should be/i,
  /i want you to be/i,
  /can you be/i,
  /try to be/i,
  /stop being/i,
  /don't be so/i,
];

const PROJECT_PATTERNS = [
  /working on/i,
  /let's (work on|build|create|implement)/i,
  /project/i,
  /task/i,
  /we need to/i,
  /our goal is/i,
];

export class FactExtractor {
  constructor(
    private readonly store: WorkingMemoryStore,
    private readonly identity: IdentityManager,
    private readonly activeContext: ActiveContextManager,
    private readonly facts: FactStore,
    private readonly config: ExtractionConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Process a conversation to extract facts and updates.
   * This runs async after each agent turn.
   */
  async processConversation(params: {
    messages: unknown[];
    sessionKey?: string;
    agentId?: string;
  }): Promise<ExtractionResult> {
    if (!this.config.enabled) {
      return {
        newFacts: [],
        updatedFacts: [],
        identityUpdates: null,
        contextUpdates: null,
      };
    }

    const { messages, sessionKey } = params;

    // Extract text content from messages
    const texts = this.extractTexts(messages);
    if (texts.length === 0) {
      return {
        newFacts: [],
        updatedFacts: [],
        identityUpdates: null,
        contextUpdates: null,
      };
    }

    const result: ExtractionResult = {
      newFacts: [],
      updatedFacts: [],
      identityUpdates: null,
      contextUpdates: null,
    };

    // Process each message for patterns
    for (const text of texts) {
      // Check for fact patterns
      await this.extractFacts(text, sessionKey, result);

      // Check for personality updates
      await this.extractPersonalityUpdates(text, result);

      // Check for project/task context
      await this.extractContextUpdates(text, result);
    }

    // Apply identity updates if found
    if (result.identityUpdates) {
      await this.identity.applyConversationUpdates({
        personalityUpdates: result.identityUpdates.personality,
        userUpdates: result.identityUpdates.user,
      });
    }

    // Apply context updates if found
    if (result.contextUpdates) {
      if (result.contextUpdates.currentProject) {
        await this.activeContext.setProject(
          result.contextUpdates.currentProject.name,
          result.contextUpdates.currentProject.goal
        );
      }
      if (result.contextUpdates.currentTask) {
        await this.activeContext.setTask(
          result.contextUpdates.currentTask.description,
          result.contextUpdates.currentTask.filesInvolved
        );
      }
    }

    if (result.newFacts.length > 0) {
      this.logger.info(`extraction: extracted ${result.newFacts.length} new facts`);
    }

    return result;
  }

  /**
   * Extract text content from messages.
   */
  private extractTexts(messages: unknown[]): string[] {
    const texts: string[] = [];

    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const msgObj = msg as Record<string, unknown>;

      // Only process user messages (facts come from what user says)
      const role = msgObj.role;
      if (role !== "user") continue;

      const content = msgObj.content;

      if (typeof content === "string") {
        texts.push(content);
        continue;
      }

      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            "type" in block &&
            (block as Record<string, unknown>).type === "text" &&
            "text" in block &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            texts.push((block as Record<string, unknown>).text as string);
          }
        }
      }
    }

    return texts;
  }

  /**
   * Extract facts from text using pattern matching.
   * For MVP, uses simple patterns. Can be enhanced with LLM extraction later.
   */
  private async extractFacts(
    text: string,
    sessionKey: string | undefined,
    result: ExtractionResult
  ): Promise<void> {
    // Skip very short or very long texts
    if (text.length < 10 || text.length > 1000) return;

    // Skip if it looks like injected context
    if (text.includes("<working-memory>") || text.includes("<relevant-")) return;

    // Check for fact patterns
    const hasFactPattern = FACT_PATTERNS.some((p) => p.test(text));
    if (!hasFactPattern) return;

    // Extract specific fact types

    // Name extraction
    const nameMatch = text.match(/my name is (\w+)/i) || text.match(/call me (\w+)/i);
    if (nameMatch) {
      const name = nameMatch[1];
      // Update user profile directly
      result.identityUpdates = result.identityUpdates || { personality: undefined, user: undefined };
      result.identityUpdates.user = result.identityUpdates.user || {};
      (result.identityUpdates.user as { name?: string }).name = name;
      this.logger.info(`extraction: detected user name: ${name}`);
    }

    // Preference extraction
    const prefMatch = text.match(/i (prefer|like|love|want|need) (.+?)(?:\.|$)/i);
    if (prefMatch) {
      const preference = prefMatch[2].trim();
      const { id, action } = await this.facts.addOrUpdate({
        category: "preference",
        subject: "user",
        value: `Prefers: ${preference}`,
      });
      if (action === "created") {
        const fact = await this.facts.getFact(id);
        if (fact) result.newFacts.push(fact);
      }
    }

    // Dislike extraction
    const dislikeMatch = text.match(/i (hate|don't like|dislike|can't stand) (.+?)(?:\.|$)/i);
    if (dislikeMatch) {
      const dislike = dislikeMatch[2].trim();
      const { id, action } = await this.facts.addOrUpdate({
        category: "preference",
        subject: "user",
        value: `Dislikes: ${dislike}`,
      });
      if (action === "created") {
        const fact = await this.facts.getFact(id);
        if (fact) result.newFacts.push(fact);
      }
    }

    // Decision extraction
    const decisionMatch = text.match(/(?:decided|let's use|we'll use|going with) (.+?)(?:\.|$)/i);
    if (decisionMatch) {
      const decision = decisionMatch[1].trim();
      const { id, action } = await this.facts.addOrUpdate({
        category: "decision",
        subject: "session",
        value: decision,
        updateIfExists: true,
      });
      if (action === "created") {
        const fact = await this.facts.getFact(id);
        if (fact) result.newFacts.push(fact);
      }
      // Also add to active context decisions
      await this.activeContext.addDecision(decision);
    }

    // Explicit "remember" requests
    const rememberMatch = text.match(/remember (?:that |this )?(.+?)(?:\.|$)/i);
    if (rememberMatch) {
      const toRemember = rememberMatch[1].trim();
      const { id, action } = await this.facts.addOrUpdate({
        category: "other",
        subject: "user-requested",
        value: toRemember,
      });
      if (action === "created") {
        const fact = await this.facts.getFact(id);
        if (fact) result.newFacts.push(fact);
      }
    }
  }

  /**
   * Extract personality update requests from text.
   */
  private async extractPersonalityUpdates(
    text: string,
    result: ExtractionResult
  ): Promise<void> {
    const hasPattern = PERSONALITY_PATTERNS.some((p) => p.test(text));
    if (!hasPattern) return;

    // "be more X" pattern
    const moreMatch = text.match(/be more (\w+)/i);
    if (moreMatch) {
      const trait = moreMatch[1].toLowerCase();
      result.identityUpdates = result.identityUpdates || { personality: undefined, user: undefined };
      result.identityUpdates.personality = result.identityUpdates.personality || {};

      // Map common traits to personality fields
      if (["casual", "formal", "friendly", "professional", "warm", "direct"].includes(trait)) {
        (result.identityUpdates.personality as { tone?: string }).tone = trait;
        this.logger.info(`extraction: detected personality update - tone: ${trait}`);
      } else if (["concise", "verbose", "detailed", "brief"].includes(trait)) {
        (result.identityUpdates.personality as { communicationStyle?: string }).communicationStyle = trait;
        this.logger.info(`extraction: detected personality update - style: ${trait}`);
      }
    }

    // "be less X" pattern
    const lessMatch = text.match(/be less (\w+)/i);
    if (lessMatch) {
      const trait = lessMatch[1].toLowerCase();
      result.identityUpdates = result.identityUpdates || { personality: undefined, user: undefined };
      result.identityUpdates.personality = result.identityUpdates.personality || {};

      // Invert the trait
      const inverseMap: Record<string, string> = {
        formal: "casual",
        verbose: "concise",
        cold: "warm",
        distant: "friendly",
      };

      if (inverseMap[trait]) {
        (result.identityUpdates.personality as { tone?: string }).tone = inverseMap[trait];
        this.logger.info(`extraction: detected personality update - tone: ${inverseMap[trait]} (less ${trait})`);
      }
    }
  }

  /**
   * Extract project/task context from text.
   */
  private async extractContextUpdates(
    text: string,
    result: ExtractionResult
  ): Promise<void> {
    const hasPattern = PROJECT_PATTERNS.some((p) => p.test(text));
    if (!hasPattern) return;

    // Project detection
    const projectMatch = text.match(/(?:working on|let's work on|build|create) (?:a |the |)?(.+?)(?:\.|$)/i);
    if (projectMatch) {
      const projectName = projectMatch[1].trim();
      // Only update if it looks like a project name (not too long)
      if (projectName.length < 100 && projectName.split(" ").length < 10) {
        result.contextUpdates = result.contextUpdates || {};
        result.contextUpdates.currentProject = {
          name: projectName,
          startedAt: Date.now(),
          status: "in_progress",
        };
        this.logger.info(`extraction: detected project: ${projectName}`);
      }
    }

    // Goal detection
    const goalMatch = text.match(/(?:our goal is|we need to|the goal is) (.+?)(?:\.|$)/i);
    if (goalMatch && result.contextUpdates?.currentProject) {
      result.contextUpdates.currentProject.goal = goalMatch[1].trim();
    }

    // Task detection
    const taskMatch = text.match(/(?:task|let's|need to|should) (.+?)(?:\.|$)/i);
    if (taskMatch) {
      const taskDesc = taskMatch[1].trim();
      if (taskDesc.length < 200) {
        result.contextUpdates = result.contextUpdates || {};
        result.contextUpdates.currentTask = {
          description: taskDesc,
          filesInvolved: [],
          startedAt: Date.now(),
        };
      }
    }

    // File detection (code files mentioned)
    const fileMatches = text.matchAll(/(?:file|in|edit|modify|look at) [`"]?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)[`"]?/gi);
    const files = Array.from(fileMatches).map((m) => m[1]);
    if (files.length > 0 && result.contextUpdates?.currentTask) {
      result.contextUpdates.currentTask.filesInvolved = files;
    }

    // Add discussed topics
    const topics = this.extractTopics(text);
    for (const topic of topics) {
      await this.activeContext.addDiscussedTopic(topic);
    }
  }

  /**
   * Extract key topics from text.
   */
  private extractTopics(text: string): string[] {
    const topics: string[] = [];

    // Extract capitalized words (likely proper nouns/project names)
    const capitalizedMatch = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b/g);
    if (capitalizedMatch) {
      topics.push(...capitalizedMatch.slice(0, 3));
    }

    // Extract quoted terms
    const quotedMatch = text.match(/["'`]([^"'`]+)["'`]/g);
    if (quotedMatch) {
      topics.push(
        ...quotedMatch
          .map((q) => q.slice(1, -1))
          .filter((q) => q.length < 30)
          .slice(0, 2)
      );
    }

    return [...new Set(topics)];
  }
}
