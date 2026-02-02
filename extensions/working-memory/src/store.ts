/**
 * Working Memory Store
 *
 * Persistent storage layer using SQLite for facts/chunks and JSON files for identity/context.
 * Provides atomic operations and handles migrations.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  Identity,
  ActiveContext,
  Fact,
  FactCategory,
  HistoryChunk,
  IntegrationData,
  StoreStatus,
  Logger,
} from "./types.js";

const SCHEMA_VERSION = 1;

const DEFAULT_IDENTITY: Identity = {
  personality: {
    name: "Claude",
    tone: "warm, professional, helpful",
    communicationStyle: "concise but thorough",
    quirks: [],
    relationshipHistory: "",
  },
  user: {
    name: "",
    preferences: [],
    communication: [],
    context: {},
  },
  updatedAt: Date.now(),
};

const DEFAULT_ACTIVE_CONTEXT: ActiveContext = {
  version: 1,
  updatedAt: Date.now(),
  currentProject: null,
  currentTask: null,
  decisionsThisSession: [],
  openQuestions: [],
  blockers: [],
  recentContext: {
    lastDiscussedTopics: [],
    pendingActions: [],
  },
};

export class WorkingMemoryStore {
  private db: DatabaseSync | null = null;
  private initialized = false;

  constructor(
    private readonly storagePath: string,
    private readonly logger: Logger
  ) {}

  // ==========================================================================
  // Initialization
  // ==========================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure storage directory exists
    await fs.mkdir(this.storagePath, { recursive: true });

    // Open SQLite database
    const dbPath = path.join(this.storagePath, "state.db");
    this.db = new DatabaseSync(dbPath);

    // Create schema
    this.createSchema();

    // Initialize default files if they don't exist
    await this.ensureIdentityFile();
    await this.ensureActiveContextFile();

    this.initialized = true;
    this.logger.info(`working-memory store initialized at ${this.storagePath}`);
  }

  private createSchema(): void {
    if (!this.db) throw new Error("Database not initialized");

    // Schema version tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // Check and run migrations
    const versionRow = this.db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

    if (currentVersion < SCHEMA_VERSION) {
      this.runMigrations(currentVersion);
    }

    // Facts table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT,
        value TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        source_session TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        supersedes TEXT,
        expires_at INTEGER
      )
    `);

    // Fact indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at DESC)`);

    // History chunks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history_chunks (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        summary TEXT NOT NULL,
        entities TEXT,
        session_key TEXT,
        channel TEXT,
        created_at INTEGER NOT NULL,
        token_count INTEGER,
        embedding BLOB
      )
    `);

    // Chunk indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_topic ON history_chunks(topic)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_created ON history_chunks(created_at DESC)`);

    // Integration cache table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_cache (
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        data TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (source, key)
      )
    `);

    // Full-text search for facts
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        value,
        subject,
        content='facts',
        content_rowid='rowid'
      )
    `);

    // Update schema version
    this.db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION)
    );
  }

  private runMigrations(fromVersion: number): void {
    this.logger.info(`running migrations from version ${fromVersion} to ${SCHEMA_VERSION}`);
    // Add migrations here as schema evolves
    // if (fromVersion < 2) { ... }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  async reset(): Promise<void> {
    await this.close();
    await fs.rm(this.storagePath, { recursive: true, force: true });
    await this.initialize();
  }

  // ==========================================================================
  // Identity (JSON file)
  // ==========================================================================

  private get identityPath(): string {
    return path.join(this.storagePath, "identity.json");
  }

  private async ensureIdentityFile(): Promise<void> {
    try {
      await fs.access(this.identityPath);
    } catch {
      await fs.writeFile(this.identityPath, JSON.stringify(DEFAULT_IDENTITY, null, 2));
    }
  }

  async getIdentity(): Promise<Identity> {
    const content = await fs.readFile(this.identityPath, "utf-8");
    return JSON.parse(content) as Identity;
  }

  async setIdentity(identity: Identity): Promise<void> {
    identity.updatedAt = Date.now();
    await fs.writeFile(this.identityPath, JSON.stringify(identity, null, 2));
  }

  async updateIdentity(updates: Partial<Identity>): Promise<Identity> {
    const current = await this.getIdentity();
    const updated: Identity = {
      ...current,
      ...updates,
      personality: { ...current.personality, ...updates.personality },
      user: { ...current.user, ...updates.user },
      updatedAt: Date.now(),
    };
    await this.setIdentity(updated);
    return updated;
  }

  // ==========================================================================
  // Active Context (JSON file)
  // ==========================================================================

  private get activeContextPath(): string {
    return path.join(this.storagePath, "active-context.json");
  }

  private async ensureActiveContextFile(): Promise<void> {
    try {
      await fs.access(this.activeContextPath);
    } catch {
      await fs.writeFile(this.activeContextPath, JSON.stringify(DEFAULT_ACTIVE_CONTEXT, null, 2));
    }
  }

  async getActiveContext(): Promise<ActiveContext> {
    const content = await fs.readFile(this.activeContextPath, "utf-8");
    return JSON.parse(content) as ActiveContext;
  }

  async setActiveContext(context: ActiveContext): Promise<void> {
    context.updatedAt = Date.now();
    await fs.writeFile(this.activeContextPath, JSON.stringify(context, null, 2));
  }

  async updateActiveContext(updates: Partial<ActiveContext>): Promise<ActiveContext> {
    const current = await this.getActiveContext();
    const updated: ActiveContext = {
      ...current,
      ...updates,
      recentContext: { ...current.recentContext, ...updates.recentContext },
      updatedAt: Date.now(),
    };
    await this.setActiveContext(updated);
    return updated;
  }

  // ==========================================================================
  // Facts (SQLite)
  // ==========================================================================

  async addFact(fact: Omit<Fact, "id" | "createdAt" | "updatedAt">): Promise<string> {
    if (!this.db) throw new Error("Database not initialized");

    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO facts (id, category, subject, predicate, value, confidence, source_session, created_at, updated_at, supersedes, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        fact.category,
        fact.subject,
        fact.predicate ?? null,
        fact.value,
        fact.confidence ?? 1.0,
        fact.sourceSession ?? null,
        now,
        now,
        fact.supersedes ?? null,
        fact.expiresAt ?? null
      );

    // Update FTS
    this.db.prepare("INSERT INTO facts_fts (rowid, value, subject) SELECT rowid, value, subject FROM facts WHERE id = ?").run(id);

    return id;
  }

  async getFact(id: string): Promise<Fact | null> {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    return this.rowToFact(row);
  }

  async updateFact(id: string, updates: Partial<Fact>): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.value !== undefined) {
      sets.push("value = ?");
      values.push(updates.value);
    }
    if (updates.confidence !== undefined) {
      sets.push("confidence = ?");
      values.push(updates.confidence);
    }
    if (updates.supersedes !== undefined) {
      sets.push("supersedes = ?");
      values.push(updates.supersedes);
    }
    if (updates.expiresAt !== undefined) {
      sets.push("expires_at = ?");
      values.push(updates.expiresAt);
    }

    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    this.db.prepare(`UPDATE facts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  async deleteFact(id: string): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");
    this.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
  }

  async listFacts(options: { category?: string; limit?: number; offset?: number } = {}): Promise<Fact[]> {
    if (!this.db) throw new Error("Database not initialized");

    let sql = "SELECT * FROM facts WHERE 1=1";
    const params: unknown[] = [];

    if (options.category) {
      sql += " AND category = ?";
      params.push(options.category);
    }

    sql += " ORDER BY updated_at DESC";

    if (options.limit) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    if (options.offset) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToFact(row));
  }

  async searchFacts(query: string, options: { category?: string; limit?: number } = {}): Promise<Fact[]> {
    if (!this.db) throw new Error("Database not initialized");

    // Sanitize query for FTS5 - escape special characters
    // FTS5 special chars: " * ( ) : ^ - [ ] + AND OR NOT NEAR
    const sanitizedQuery = this.sanitizeFtsQuery(query);

    // If query is empty after sanitization, fall back to recent facts
    if (!sanitizedQuery.trim()) {
      return this.getRecentFacts(options.limit ?? 10);
    }

    // Use FTS for search
    let sql = `
      SELECT facts.*, bm25(facts_fts) as rank
      FROM facts
      JOIN facts_fts ON facts.rowid = facts_fts.rowid
      WHERE facts_fts MATCH ?
    `;
    const params: unknown[] = [sanitizedQuery];

    if (options.category) {
      sql += " AND facts.category = ?";
      params.push(options.category);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(options.limit ?? 10);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToFact(row));
  }

  async getRecentFacts(limit = 20): Promise<Fact[]> {
    return this.listFacts({ limit });
  }

  async getFactsBySubject(subject: string, limit = 10): Promise<Fact[]> {
    if (!this.db) throw new Error("Database not initialized");

    const rows = this.db
      .prepare("SELECT * FROM facts WHERE subject LIKE ? ORDER BY updated_at DESC LIMIT ?")
      .all(`%${subject}%`, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToFact(row));
  }

  private rowToFact(row: Record<string, unknown>): Fact {
    return {
      id: row.id as string,
      category: row.category as FactCategory,
      subject: row.subject as string,
      predicate: row.predicate as string | undefined,
      value: row.value as string,
      confidence: row.confidence as number,
      sourceSession: row.source_session as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      supersedes: row.supersedes as string | undefined,
      expiresAt: row.expires_at as number | undefined,
    };
  }

  /**
   * Sanitize a query string for FTS5 MATCH.
   * FTS5 has special syntax characters that can cause "syntax error" if not escaped.
   * We extract alphanumeric words and join them with spaces for a simple prefix search.
   */
  private sanitizeFtsQuery(query: string): string {
    // Extract words (alphanumeric sequences), filter out very short ones
    const words = query
      .split(/[^\p{L}\p{N}]+/u)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2);

    if (words.length === 0) {
      return "";
    }

    // Join with OR for broader matching, wrap each word for safety
    // Use prefix matching with * for partial matches
    return words.map((w) => `"${w}"*`).join(" OR ");
  }

  // ==========================================================================
  // History Chunks (SQLite)
  // ==========================================================================

  async addHistoryChunk(chunk: Omit<HistoryChunk, "id" | "createdAt">): Promise<string> {
    if (!this.db) throw new Error("Database not initialized");

    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO history_chunks (id, topic, summary, entities, session_key, channel, created_at, token_count, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        chunk.topic,
        chunk.summary,
        JSON.stringify(chunk.entities),
        chunk.sessionKey ?? null,
        chunk.channel ?? null,
        now,
        chunk.tokenCount,
        chunk.embedding ? Buffer.from(new Float32Array(chunk.embedding).buffer) : null
      );

    return id;
  }

  async searchHistoryChunks(query: string, limit = 5): Promise<HistoryChunk[]> {
    if (!this.db) throw new Error("Database not initialized");

    // Simple text search for now - can be enhanced with vector search
    const rows = this.db
      .prepare(
        `SELECT * FROM history_chunks
         WHERE topic LIKE ? OR summary LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToChunk(row));
  }

  async getRecentChunks(limit = 10): Promise<HistoryChunk[]> {
    if (!this.db) throw new Error("Database not initialized");

    const rows = this.db
      .prepare("SELECT * FROM history_chunks ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToChunk(row));
  }

  private rowToChunk(row: Record<string, unknown>): HistoryChunk {
    return {
      id: row.id as string,
      topic: row.topic as string,
      summary: row.summary as string,
      entities: JSON.parse((row.entities as string) || "[]"),
      sessionKey: row.session_key as string | undefined,
      channel: row.channel as string | undefined,
      createdAt: row.created_at as number,
      tokenCount: row.token_count as number,
      embedding: row.embedding ? Array.from(new Float32Array((row.embedding as Buffer).buffer)) : undefined,
    };
  }

  /**
   * Update an existing chunk's embedding
   */
  async updateChunkEmbedding(id: string, embedding: Float32Array): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    this.db
      .prepare("UPDATE history_chunks SET embedding = ? WHERE id = ?")
      .run(Buffer.from(embedding.buffer), id);
  }

  /**
   * Get chunks that don't have embeddings yet
   */
  async getChunksWithoutEmbeddings(limit = 50): Promise<HistoryChunk[]> {
    if (!this.db) throw new Error("Database not initialized");

    const rows = this.db
      .prepare(
        `SELECT * FROM history_chunks
         WHERE embedding IS NULL
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToChunk(row));
  }

  /**
   * Get chunks with embeddings for vector search
   */
  async getChunksWithEmbeddings(limit = 100): Promise<HistoryChunk[]> {
    if (!this.db) throw new Error("Database not initialized");

    const rows = this.db
      .prepare(
        `SELECT * FROM history_chunks
         WHERE embedding IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToChunk(row));
  }

  /**
   * Delete old chunks beyond the limit
   */
  async pruneOldChunks(maxChunks: number): Promise<number> {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db
      .prepare(
        `DELETE FROM history_chunks
         WHERE id NOT IN (
           SELECT id FROM history_chunks
           ORDER BY created_at DESC
           LIMIT ?
         )`
      )
      .run(maxChunks);

    return result.changes;
  }

  // ==========================================================================
  // Integration Cache (SQLite)
  // ==========================================================================

  async setIntegrationData(data: IntegrationData): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    this.db
      .prepare(
        `INSERT OR REPLACE INTO integration_cache (source, key, data, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(data.source, data.key, JSON.stringify(data.data), data.fetchedAt, data.expiresAt ?? null);
  }

  async getIntegrationData(source: string, key?: string): Promise<IntegrationData[]> {
    if (!this.db) throw new Error("Database not initialized");

    let sql = "SELECT * FROM integration_cache WHERE source = ?";
    const params: unknown[] = [source];

    if (key) {
      sql += " AND key = ?";
      params.push(key);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      source: row.source as string,
      key: row.key as string,
      data: JSON.parse(row.data as string),
      fetchedAt: row.fetched_at as number,
      expiresAt: row.expires_at as number | undefined,
    }));
  }

  async clearExpiredIntegrations(): Promise<number> {
    if (!this.db) throw new Error("Database not initialized");

    const result = this.db
      .prepare("DELETE FROM integration_cache WHERE expires_at IS NOT NULL AND expires_at < ?")
      .run(Date.now());

    return result.changes;
  }

  // ==========================================================================
  // Status
  // ==========================================================================

  async getStatus(): Promise<StoreStatus> {
    if (!this.db) {
      return {
        initialized: false,
        storagePath: this.storagePath,
        factCount: 0,
        chunkCount: 0,
        integrationCount: 0,
        hasIdentity: false,
        hasActiveContext: false,
        lastUpdated: 0,
      };
    }

    const factCount = (this.db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number }).c;
    const chunkCount = (this.db.prepare("SELECT COUNT(*) as c FROM history_chunks").get() as { c: number }).c;
    const integrationCount = (this.db.prepare("SELECT COUNT(*) as c FROM integration_cache").get() as { c: number }).c;

    let hasIdentity = false;
    let hasActiveContext = false;
    let lastUpdated = 0;

    try {
      const identity = await this.getIdentity();
      hasIdentity = !!identity.user.name;
      lastUpdated = Math.max(lastUpdated, identity.updatedAt);
    } catch {
      // File doesn't exist
    }

    try {
      const context = await this.getActiveContext();
      hasActiveContext = !!context.currentProject || !!context.currentTask;
      lastUpdated = Math.max(lastUpdated, context.updatedAt);
    } catch {
      // File doesn't exist
    }

    return {
      initialized: this.initialized,
      storagePath: this.storagePath,
      factCount,
      chunkCount,
      integrationCount,
      hasIdentity,
      hasActiveContext,
      lastUpdated,
    };
  }
}
