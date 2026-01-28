/**
 * Identity Manager
 *
 * Manages PA personality and user profile.
 * Supports chat-driven updates (user says "be more casual" → personality updates).
 *
 * Identity is split into two parts:
 * - Bot identity (name, emoji) comes from Moltbot config
 * - User identity (name, preferences, tone) stored in Working Memory
 */

import type { WorkingMemoryStore } from "./store.js";
import type { Identity, Personality, UserProfile, Logger } from "./types.js";

interface IdentityConfig {
  allowChatUpdates: boolean;
  lockedTraits: string[];
}

/**
 * Moltbot's agent identity from config (bot name, emoji, avatar)
 */
export interface MoltbotIdentityConfig {
  name?: string;
  emoji?: string;
  avatar?: string;
  theme?: string;
}

export class IdentityManager {
  private moltbotIdentity: MoltbotIdentityConfig | null = null;

  constructor(
    private readonly store: WorkingMemoryStore,
    private readonly config: IdentityConfig,
    private readonly logger: Logger
  ) {}

  /**
   * Set the Moltbot identity config (bot name, emoji from moltbot.json).
   * This is called during plugin initialization.
   */
  setMoltbotIdentity(identity: MoltbotIdentityConfig | null): void {
    this.moltbotIdentity = identity;
    if (identity?.name) {
      this.logger.info(`identity: using bot name from Moltbot config: ${identity.name}`);
    }
  }

  /**
   * Get the bot's display name (from Moltbot config, or fallback to Working Memory)
   */
  getBotName(): string {
    return this.moltbotIdentity?.name ?? "Assistant";
  }

  /**
   * Get the bot's emoji (from Moltbot config)
   */
  getBotEmoji(): string | undefined {
    return this.moltbotIdentity?.emoji;
  }

  // ==========================================================================
  // Read Operations
  // ==========================================================================

  async get(): Promise<Identity> {
    return this.store.getIdentity();
  }

  async getPersonality(): Promise<Personality> {
    const identity = await this.get();
    return identity.personality;
  }

  async getUserProfile(): Promise<UserProfile> {
    const identity = await this.get();
    return identity.user;
  }

  // ==========================================================================
  // Update Operations
  // ==========================================================================

  async update(updates: Partial<Identity>): Promise<Identity> {
    return this.store.updateIdentity(updates);
  }

  async updatePersonality(updates: Partial<Personality>): Promise<Identity> {
    // Check for locked traits
    if (this.config.lockedTraits.length > 0) {
      for (const trait of this.config.lockedTraits) {
        if (trait in updates) {
          this.logger.warn(`identity: attempted to update locked trait: ${trait}`);
          delete (updates as Record<string, unknown>)[trait];
        }
      }
    }

    const current = await this.get();
    return this.store.updateIdentity({
      personality: {
        ...current.personality,
        ...updates,
      },
    });
  }

  async updateUserProfile(updates: Partial<UserProfile>): Promise<Identity> {
    const current = await this.get();
    return this.store.updateIdentity({
      user: {
        ...current.user,
        ...updates,
        context: {
          ...current.user.context,
          ...updates.context,
        },
      },
    });
  }

  // ==========================================================================
  // Chat-Driven Updates
  // ==========================================================================

  /**
   * Apply updates detected from conversation.
   * Only works if allowChatUpdates is enabled.
   */
  async applyConversationUpdates(updates: {
    personalityUpdates?: Partial<Personality>;
    userUpdates?: Partial<UserProfile>;
  }): Promise<Identity | null> {
    if (!this.config.allowChatUpdates) {
      this.logger.info("identity: chat updates disabled, ignoring");
      return null;
    }

    const { personalityUpdates, userUpdates } = updates;

    if (!personalityUpdates && !userUpdates) {
      return null;
    }

    const current = await this.get();
    const updated: Partial<Identity> = {};

    if (personalityUpdates) {
      // Filter out locked traits
      const filteredPersonality = { ...personalityUpdates };
      for (const trait of this.config.lockedTraits) {
        delete (filteredPersonality as Record<string, unknown>)[trait];
      }

      if (Object.keys(filteredPersonality).length > 0) {
        updated.personality = {
          ...current.personality,
          ...filteredPersonality,
        };
        this.logger.info(`identity: updating personality from conversation`);
      }
    }

    if (userUpdates) {
      updated.user = {
        ...current.user,
        ...userUpdates,
        context: {
          ...current.user.context,
          ...userUpdates.context,
        },
      };
      this.logger.info(`identity: updating user profile from conversation`);
    }

    if (Object.keys(updated).length === 0) {
      return null;
    }

    return this.store.updateIdentity(updated);
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  async setUserName(name: string): Promise<Identity> {
    return this.updateUserProfile({ name });
  }

  async addUserPreference(preference: string): Promise<Identity> {
    const current = await this.getUserProfile();
    if (current.preferences.includes(preference)) {
      return this.get();
    }
    return this.updateUserProfile({
      preferences: [...current.preferences, preference],
    });
  }

  async removeUserPreference(preference: string): Promise<Identity> {
    const current = await this.getUserProfile();
    return this.updateUserProfile({
      preferences: current.preferences.filter((p) => p !== preference),
    });
  }

  async addPersonalityQuirk(quirk: string): Promise<Identity> {
    const current = await this.getPersonality();
    if (current.quirks.includes(quirk)) {
      return this.get();
    }
    return this.updatePersonality({
      quirks: [...current.quirks, quirk],
    });
  }

  async setTone(tone: string): Promise<Identity> {
    return this.updatePersonality({ tone });
  }

  async setCommunicationStyle(style: string): Promise<Identity> {
    return this.updatePersonality({ communicationStyle: style });
  }

  // ==========================================================================
  // Context Formatting
  // ==========================================================================

  /**
   * Format identity for injection into agent context.
   * Bot name comes from Moltbot config, everything else from Working Memory.
   */
  async formatForContext(): Promise<string> {
    const identity = await this.get();
    const { personality, user } = identity;

    const sections: string[] = [];

    // Bot personality section
    // Name comes from Moltbot config (if set), fallback to Working Memory
    const botName = this.moltbotIdentity?.name ?? personality.name;
    const botEmoji = this.moltbotIdentity?.emoji;

    sections.push(`<personality>`);
    sections.push(`Name: ${botName}${botEmoji ? ` ${botEmoji}` : ""}`);
    sections.push(`Tone: ${personality.tone}`);
    sections.push(`Communication Style: ${personality.communicationStyle}`);
    if (personality.quirks.length > 0) {
      sections.push(`Behavioral Notes:`);
      personality.quirks.forEach((q) => sections.push(`- ${q}`));
    }
    if (personality.relationshipHistory) {
      sections.push(`Relationship: ${personality.relationshipHistory}`);
    }
    sections.push(`</personality>`);

    // User section (only if we know something about them)
    if (user.name || user.preferences.length > 0 || user.communication.length > 0) {
      sections.push(`<user-profile>`);
      if (user.name) {
        sections.push(`Name: ${user.name}`);
      }
      if (user.context.role) {
        sections.push(`Role: ${user.context.role}`);
      }
      if (user.preferences.length > 0) {
        sections.push(`Preferences:`);
        user.preferences.forEach((p) => sections.push(`- ${p}`));
      }
      if (user.communication.length > 0) {
        sections.push(`Communication Notes:`);
        user.communication.forEach((c) => sections.push(`- ${c}`));
      }
      if (user.context.projects && user.context.projects.length > 0) {
        sections.push(`Known Projects: ${user.context.projects.join(", ")}`);
      }
      sections.push(`</user-profile>`);
    }

    return sections.join("\n");
  }

  /**
   * Estimate token count for identity context.
   */
  async estimateTokens(): Promise<number> {
    const formatted = await this.formatForContext();
    // Rough estimate: ~4 chars per token
    return Math.ceil(formatted.length / 4);
  }
}
