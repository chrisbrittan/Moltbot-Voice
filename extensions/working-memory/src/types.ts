/**
 * Working Memory Types
 */

// ============================================================================
// Identity Types
// ============================================================================

export interface Personality {
  name: string;
  tone: string;
  communicationStyle: string;
  quirks: string[];
  relationshipHistory: string;
}

export interface UserProfile {
  name: string;
  preferences: string[];
  communication: string[];
  context: {
    role?: string;
    projects?: string[];
    [key: string]: unknown;
  };
}

export interface Identity {
  personality: Personality;
  user: UserProfile;
  updatedAt: number;
}

// ============================================================================
// Active Context Types
// ============================================================================

export interface Project {
  name: string;
  goal?: string;
  startedAt: number;
  status: "in_progress" | "paused" | "completed";
}

export interface Task {
  description: string;
  filesInvolved: string[];
  startedAt: number;
}

export interface Decision {
  decision: string;
  reasoning?: string;
  timestamp: number;
}

export interface ActiveContext {
  version: number;
  updatedAt: number;
  currentProject: Project | null;
  currentTask: Task | null;
  decisionsThisSession: Decision[];
  openQuestions: string[];
  blockers: string[];
  recentContext: {
    lastDiscussedTopics: string[];
    pendingActions: string[];
  };
}

// ============================================================================
// Fact Types
// ============================================================================

export type FactCategory = "user" | "preference" | "decision" | "project" | "entity" | "other";

export interface Fact {
  id: string;
  category: FactCategory | string;
  subject: string;
  predicate?: string;
  value: string;
  confidence: number;
  sourceSession?: string;
  createdAt: number;
  updatedAt: number;
  supersedes?: string;
  expiresAt?: number;
}

export interface FactSearchResult extends Fact {
  relevanceScore?: number;
}

// ============================================================================
// Integration Types
// ============================================================================

export interface IntegrationData {
  source: string;
  key: string;
  data: unknown;
  fetchedAt: number;
  expiresAt?: number;
}

export interface IntegrationProvider {
  id: string;
  source: "ios" | "gateway" | "api";
  cache: {
    ttl: number;
    refreshOnMention: boolean;
  };
  inject: {
    always: boolean;
    onRelevance: string[];
    maxTokens: number;
  };
}

// ============================================================================
// History Chunk Types
// ============================================================================

export interface HistoryChunk {
  id: string;
  topic: string;
  summary: string;
  entities: string[];
  sessionKey?: string;
  channel?: string;
  createdAt: number;
  tokenCount: number;
  embedding?: number[];
}

// ============================================================================
// Store Status
// ============================================================================

export interface StoreStatus {
  initialized: boolean;
  storagePath: string;
  factCount: number;
  chunkCount: number;
  integrationCount: number;
  hasIdentity: boolean;
  hasActiveContext: boolean;
  lastUpdated: number;
}

// ============================================================================
// Context Injection
// ============================================================================

export interface AssembledContext {
  content: string;
  tokenEstimate: number;
  layers: {
    identity: number;
    activeContext: number;
    facts: number;
    integrations: number;
    historyChunks: number;
  };
}

// ============================================================================
// Extraction Results
// ============================================================================

export interface ExtractionResult {
  newFacts: Fact[];
  updatedFacts: Fact[];
  identityUpdates: Partial<Identity> | null;
  contextUpdates: Partial<ActiveContext> | null;
}

// ============================================================================
// Logger Interface
// ============================================================================

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}
