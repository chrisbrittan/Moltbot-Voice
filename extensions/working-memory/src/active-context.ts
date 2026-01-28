/**
 * Active Context Manager
 *
 * Manages current project, task, and session-level decisions.
 * This is the "what we're working on right now" state that survives compaction.
 */

import type { WorkingMemoryStore } from "./store.js";
import type { ActiveContext, Project, Task, Decision, Logger } from "./types.js";

const MAX_DECISIONS_IN_CONTEXT = 10;
const MAX_TOPICS = 5;

export class ActiveContextManager {
  constructor(
    private readonly store: WorkingMemoryStore,
    private readonly logger: Logger
  ) {}

  // ==========================================================================
  // Read Operations
  // ==========================================================================

  async get(): Promise<ActiveContext> {
    return this.store.getActiveContext();
  }

  async getCurrentProject(): Promise<Project | null> {
    const context = await this.get();
    return context.currentProject;
  }

  async getCurrentTask(): Promise<Task | null> {
    const context = await this.get();
    return context.currentTask;
  }

  async getDecisions(): Promise<Decision[]> {
    const context = await this.get();
    return context.decisionsThisSession;
  }

  // ==========================================================================
  // Update Operations
  // ==========================================================================

  async update(updates: Partial<ActiveContext>): Promise<ActiveContext> {
    return this.store.updateActiveContext(updates);
  }

  async setProject(name: string, goal?: string): Promise<ActiveContext> {
    this.logger.info(`active-context: setting project to "${name}"`);
    return this.update({
      currentProject: {
        name,
        goal,
        startedAt: Date.now(),
        status: "in_progress",
      },
    });
  }

  async clearProject(): Promise<ActiveContext> {
    this.logger.info("active-context: clearing project");
    return this.update({
      currentProject: null,
      currentTask: null,
      decisionsThisSession: [],
    });
  }

  async setTask(description: string, files?: string[]): Promise<ActiveContext> {
    this.logger.info(`active-context: setting task to "${description}"`);
    return this.update({
      currentTask: {
        description,
        filesInvolved: files ?? [],
        startedAt: Date.now(),
      },
    });
  }

  async clearTask(): Promise<ActiveContext> {
    this.logger.info("active-context: clearing task");
    return this.update({
      currentTask: null,
    });
  }

  async addDecision(decision: string, reasoning?: string): Promise<ActiveContext> {
    const context = await this.get();
    const decisions = [...context.decisionsThisSession];

    // Keep only recent decisions
    if (decisions.length >= MAX_DECISIONS_IN_CONTEXT) {
      decisions.shift();
    }

    decisions.push({
      decision,
      reasoning,
      timestamp: Date.now(),
    });

    this.logger.info(`active-context: recorded decision`);
    return this.update({
      decisionsThisSession: decisions,
    });
  }

  async addFiles(files: string[]): Promise<ActiveContext> {
    const context = await this.get();
    if (!context.currentTask) {
      return context;
    }

    const existingFiles = new Set(context.currentTask.filesInvolved);
    files.forEach((f) => existingFiles.add(f));

    return this.update({
      currentTask: {
        ...context.currentTask,
        filesInvolved: Array.from(existingFiles),
      },
    });
  }

  async addOpenQuestion(question: string): Promise<ActiveContext> {
    const context = await this.get();
    if (context.openQuestions.includes(question)) {
      return context;
    }
    return this.update({
      openQuestions: [...context.openQuestions, question],
    });
  }

  async resolveOpenQuestion(question: string): Promise<ActiveContext> {
    const context = await this.get();
    return this.update({
      openQuestions: context.openQuestions.filter((q) => q !== question),
    });
  }

  async addBlocker(blocker: string): Promise<ActiveContext> {
    const context = await this.get();
    if (context.blockers.includes(blocker)) {
      return context;
    }
    return this.update({
      blockers: [...context.blockers, blocker],
    });
  }

  async resolveBlocker(blocker: string): Promise<ActiveContext> {
    const context = await this.get();
    return this.update({
      blockers: context.blockers.filter((b) => b !== blocker),
    });
  }

  async addDiscussedTopic(topic: string): Promise<ActiveContext> {
    const context = await this.get();
    const topics = context.recentContext.lastDiscussedTopics.filter((t) => t !== topic);
    topics.unshift(topic);

    // Keep only recent topics
    while (topics.length > MAX_TOPICS) {
      topics.pop();
    }

    return this.update({
      recentContext: {
        ...context.recentContext,
        lastDiscussedTopics: topics,
      },
    });
  }

  async addPendingAction(action: string): Promise<ActiveContext> {
    const context = await this.get();
    return this.update({
      recentContext: {
        ...context.recentContext,
        pendingActions: [...context.recentContext.pendingActions, action],
      },
    });
  }

  async completePendingAction(action: string): Promise<ActiveContext> {
    const context = await this.get();
    return this.update({
      recentContext: {
        ...context.recentContext,
        pendingActions: context.recentContext.pendingActions.filter((a) => a !== action),
      },
    });
  }

  // ==========================================================================
  // Context Formatting
  // ==========================================================================

  /**
   * Format active context for injection into agent context.
   */
  async formatForContext(): Promise<string> {
    const context = await this.get();
    const sections: string[] = [];

    sections.push(`<active-context>`);

    // Current project
    if (context.currentProject) {
      sections.push(`<current-project>`);
      sections.push(`Project: ${context.currentProject.name}`);
      if (context.currentProject.goal) {
        sections.push(`Goal: ${context.currentProject.goal}`);
      }
      sections.push(`Status: ${context.currentProject.status}`);
      sections.push(`</current-project>`);
    }

    // Current task
    if (context.currentTask) {
      sections.push(`<current-task>`);
      sections.push(`Task: ${context.currentTask.description}`);
      if (context.currentTask.filesInvolved.length > 0) {
        sections.push(`Files: ${context.currentTask.filesInvolved.join(", ")}`);
      }
      sections.push(`</current-task>`);
    }

    // Recent decisions (important for continuity)
    if (context.decisionsThisSession.length > 0) {
      sections.push(`<recent-decisions>`);
      context.decisionsThisSession.slice(-5).forEach((d) => {
        const time = new Date(d.timestamp).toLocaleTimeString();
        sections.push(`- [${time}] ${d.decision}`);
        if (d.reasoning) {
          sections.push(`  Reasoning: ${d.reasoning}`);
        }
      });
      sections.push(`</recent-decisions>`);
    }

    // Open questions
    if (context.openQuestions.length > 0) {
      sections.push(`<open-questions>`);
      context.openQuestions.forEach((q) => sections.push(`- ${q}`));
      sections.push(`</open-questions>`);
    }

    // Blockers
    if (context.blockers.length > 0) {
      sections.push(`<blockers>`);
      context.blockers.forEach((b) => sections.push(`- ${b}`));
      sections.push(`</blockers>`);
    }

    // Pending actions
    if (context.recentContext.pendingActions.length > 0) {
      sections.push(`<pending-actions>`);
      context.recentContext.pendingActions.forEach((a) => sections.push(`- ${a}`));
      sections.push(`</pending-actions>`);
    }

    sections.push(`</active-context>`);

    // Only return content if there's actual context
    const hasContent =
      context.currentProject ||
      context.currentTask ||
      context.decisionsThisSession.length > 0 ||
      context.openQuestions.length > 0 ||
      context.blockers.length > 0 ||
      context.recentContext.pendingActions.length > 0;

    if (!hasContent) {
      return "";
    }

    return sections.join("\n");
  }

  /**
   * Estimate token count for active context.
   */
  async estimateTokens(): Promise<number> {
    const formatted = await this.formatForContext();
    // Rough estimate: ~4 chars per token
    return Math.ceil(formatted.length / 4);
  }

  /**
   * Get topics for relevance matching.
   */
  async getTopicsForRelevance(): Promise<string[]> {
    const context = await this.get();
    const topics: string[] = [...context.recentContext.lastDiscussedTopics];

    if (context.currentProject) {
      topics.push(context.currentProject.name);
    }

    if (context.currentTask) {
      // Extract key terms from task description
      const words = context.currentTask.description.toLowerCase().split(/\s+/);
      topics.push(...words.filter((w) => w.length > 4));
    }

    return [...new Set(topics)];
  }
}
