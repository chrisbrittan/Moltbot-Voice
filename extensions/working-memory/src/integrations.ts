/**
 * Integration Cache
 *
 * Manages cached data from external integrations (calendar, tasks, mail, etc.).
 * Supports hybrid mode: cache + live query when stale or explicitly requested.
 */

import type { WorkingMemoryStore } from "./store.js";
import type { IntegrationData, Logger } from "./types.js";

interface IntegrationConfig {
  defaultTtl: number;
  refreshOnMention: boolean;
}

// Keywords that trigger refresh for each integration
const INTEGRATION_KEYWORDS: Record<string, string[]> = {
  calendar: ["calendar", "meeting", "schedule", "appointment", "event", "today", "tomorrow", "this week"],
  reminders: ["reminder", "reminders", "remind me", "todo", "task", "tasks"],
  mail: ["email", "mail", "inbox", "message", "messages"],
  contacts: ["contact", "phone number", "email address", "who is"],
  health: ["health", "steps", "sleep", "workout", "exercise", "heart rate"],
  location: ["where am i", "location", "nearby", "distance", "directions"],
  homekit: ["lights", "home", "thermostat", "temperature", "lock", "door", "smart home"],
  music: ["music", "playing", "song", "playlist", "album", "artist"],
  notes: ["notes", "note", "write down", "jot down"],
  files: ["files", "documents", "download", "attachment"],
  outlook: ["outlook", "office", "microsoft", "teams", "sharepoint", "work email", "work calendar"],
};

export class IntegrationCache {
  constructor(
    private readonly store: WorkingMemoryStore,
    private readonly config: IntegrationConfig,
    private readonly logger: Logger
  ) {}

  // ==========================================================================
  // Cache Operations
  // ==========================================================================

  /**
   * Store integration data in cache.
   */
  async set(source: string, key: string, data: unknown, ttl?: number): Promise<void> {
    const now = Date.now();
    const expiresAt = ttl ? now + ttl * 1000 : now + this.config.defaultTtl * 1000;

    await this.store.setIntegrationData({
      source,
      key,
      data,
      fetchedAt: now,
      expiresAt,
    });

    this.logger.info(`integrations: cached ${source}/${key} (expires in ${ttl ?? this.config.defaultTtl}s)`);
  }

  /**
   * Get cached integration data.
   * Returns null if not found or expired.
   */
  async get(source: string, key?: string): Promise<IntegrationData[]> {
    const results = await this.store.getIntegrationData(source, key);

    // Filter out expired entries
    const now = Date.now();
    return results.filter((r) => !r.expiresAt || r.expiresAt > now);
  }

  /**
   * Check if cache is stale for a source.
   */
  async isStale(source: string): Promise<boolean> {
    const data = await this.get(source);
    if (data.length === 0) return true;

    // Check if any entry is close to expiring (within 10% of TTL)
    const now = Date.now();
    const nearExpiry = data.some((d) => {
      if (!d.expiresAt) return false;
      const remaining = d.expiresAt - now;
      const total = d.expiresAt - d.fetchedAt;
      return remaining < total * 0.1;
    });

    return nearExpiry;
  }

  /**
   * Clear all cached data for a source.
   */
  async clear(source: string): Promise<void> {
    // Get all keys for source and delete
    const data = await this.store.getIntegrationData(source);
    for (const d of data) {
      // Re-set with immediate expiry to effectively delete
      await this.store.setIntegrationData({
        ...d,
        expiresAt: Date.now() - 1,
      });
    }
    this.logger.info(`integrations: cleared cache for ${source}`);
  }

  /**
   * Clear all expired entries.
   */
  async clearExpired(): Promise<number> {
    return this.store.clearExpiredIntegrations();
  }

  // ==========================================================================
  // Relevance Detection
  // ==========================================================================

  /**
   * Detect which integrations are relevant to a message.
   */
  detectRelevantIntegrations(message: string): string[] {
    if (!this.config.refreshOnMention) {
      return [];
    }

    const relevant: string[] = [];
    const lower = message.toLowerCase();

    for (const [source, keywords] of Object.entries(INTEGRATION_KEYWORDS)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        relevant.push(source);
      }
    }

    return relevant;
  }

  /**
   * Check if a message mentions a specific integration.
   */
  mentionsIntegration(message: string, source: string): boolean {
    const keywords = INTEGRATION_KEYWORDS[source] ?? [];
    const lower = message.toLowerCase();
    return keywords.some((kw) => lower.includes(kw));
  }

  // ==========================================================================
  // Data Push (from iOS/external sources)
  // ==========================================================================

  /**
   * Push data from an external source (e.g., iOS app).
   * Replaces existing data for the source/key combination.
   */
  async push(params: {
    source: string;
    key: string;
    data: unknown;
    ttl?: number;
  }): Promise<void> {
    await this.set(params.source, params.key, params.data, params.ttl);
  }

  /**
   * Bulk push multiple entries.
   */
  async pushBulk(entries: Array<{
    source: string;
    key: string;
    data: unknown;
    ttl?: number;
  }>): Promise<void> {
    for (const entry of entries) {
      await this.push(entry);
    }
    this.logger.info(`integrations: bulk pushed ${entries.length} entries`);
  }

  // ==========================================================================
  // Context Formatting
  // ==========================================================================

  /**
   * Format integration data for injection into agent context.
   */
  async formatForContext(options: {
    sources?: string[];
    message?: string;
    maxTokens?: number;
  } = {}): Promise<string> {
    let sources = options.sources ?? [];

    // Auto-detect relevant sources from message
    if (options.message && this.config.refreshOnMention) {
      const detected = this.detectRelevantIntegrations(options.message);
      sources = [...new Set([...sources, ...detected])];
    }

    if (sources.length === 0) {
      return "";
    }

    const sections: string[] = [];
    let totalChars = 0;
    const maxChars = (options.maxTokens ?? 1000) * 4; // Rough token estimate

    for (const source of sources) {
      const data = await this.get(source);
      if (data.length === 0) continue;

      const sourceSection = this.formatSourceData(source, data);
      if (totalChars + sourceSection.length > maxChars) {
        break;
      }

      sections.push(sourceSection);
      totalChars += sourceSection.length;
    }

    if (sections.length === 0) {
      return "";
    }

    return `<integration-context>\n${sections.join("\n")}\n</integration-context>`;
  }

  /**
   * Format data for a specific source.
   */
  private formatSourceData(source: string, data: IntegrationData[]): string {
    const lines: string[] = [`[${source}]`];

    for (const entry of data) {
      const formatted = this.formatEntry(source, entry);
      if (formatted) {
        lines.push(formatted);
      }
    }

    return lines.join("\n");
  }

  /**
   * Format a single integration entry.
   */
  private formatEntry(source: string, entry: IntegrationData): string {
    const { key, data } = entry;

    // Source-specific formatting
    switch (source) {
      case "calendar":
        return this.formatCalendarEntry(key, data);
      case "reminders":
        return this.formatRemindersEntry(key, data);
      case "location":
        return this.formatLocationEntry(key, data);
      case "health":
        return this.formatHealthEntry(key, data);
      case "mail":
        return this.formatMailEntry(key, data);
      case "outlook":
        return this.formatOutlookEntry(key, data);
      default:
        // Generic JSON formatting
        return `  ${key}: ${JSON.stringify(data)}`;
    }
  }

  private formatCalendarEntry(key: string, data: unknown): string {
    if (Array.isArray(data)) {
      const events = data as Array<{ title?: string; start?: string; location?: string }>;
      return events
        .map((e) => `  - ${e.title ?? "Event"} at ${e.start ?? "unknown time"}${e.location ? ` (${e.location})` : ""}`)
        .join("\n");
    }
    return `  ${key}: ${JSON.stringify(data)}`;
  }

  private formatRemindersEntry(key: string, data: unknown): string {
    if (Array.isArray(data)) {
      const reminders = data as Array<{ title?: string; dueDate?: string; priority?: string }>;
      return reminders
        .map((r) => `  - ${r.title ?? "Reminder"}${r.dueDate ? ` (due: ${r.dueDate})` : ""}${r.priority ? ` [${r.priority}]` : ""}`)
        .join("\n");
    }
    return `  ${key}: ${JSON.stringify(data)}`;
  }

  private formatLocationEntry(key: string, data: unknown): string {
    const loc = data as { address?: string; city?: string; lat?: number; lon?: number };
    if (loc.address) {
      return `  Current location: ${loc.address}${loc.city ? `, ${loc.city}` : ""}`;
    }
    if (loc.lat && loc.lon) {
      return `  Current location: ${loc.lat}, ${loc.lon}`;
    }
    return `  ${key}: ${JSON.stringify(data)}`;
  }

  private formatHealthEntry(key: string, data: unknown): string {
    const health = data as Record<string, unknown>;
    const parts: string[] = [];
    if (health.steps) parts.push(`Steps: ${health.steps}`);
    if (health.sleep) parts.push(`Sleep: ${health.sleep}`);
    if (health.heartRate) parts.push(`Heart rate: ${health.heartRate}`);
    if (parts.length > 0) {
      return `  ${parts.join(", ")}`;
    }
    return `  ${key}: ${JSON.stringify(data)}`;
  }

  private formatMailEntry(key: string, data: unknown): string {
    if (Array.isArray(data)) {
      const emails = data as Array<{ from?: string; subject?: string; preview?: string }>;
      return emails
        .slice(0, 5)
        .map((e) => `  - From: ${e.from ?? "unknown"} - ${e.subject ?? "No subject"}`)
        .join("\n");
    }
    return `  ${key}: ${JSON.stringify(data)}`;
  }

  private formatOutlookEntry(key: string, data: unknown): string {
    // Similar to mail/calendar but for Office 365
    if (key === "calendar" && Array.isArray(data)) {
      return this.formatCalendarEntry(key, data);
    }
    if (key === "mail" && Array.isArray(data)) {
      return this.formatMailEntry(key, data);
    }
    return `  ${key}: ${JSON.stringify(data)}`;
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  async getStats(): Promise<{
    sources: string[];
    totalEntries: number;
    staleCount: number;
  }> {
    const allSources = Object.keys(INTEGRATION_KEYWORDS);
    let totalEntries = 0;
    let staleCount = 0;

    for (const source of allSources) {
      const data = await this.store.getIntegrationData(source);
      totalEntries += data.length;

      const now = Date.now();
      staleCount += data.filter((d) => d.expiresAt && d.expiresAt < now).length;
    }

    return {
      sources: allSources,
      totalEntries,
      staleCount,
    };
  }
}
