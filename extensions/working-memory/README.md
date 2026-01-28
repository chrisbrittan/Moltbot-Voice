# Working Memory Plugin

A protected context layer for Moltbot that ensures the assistant never loses track of important information during long sessions.

## Overview

Working Memory solves the problem of context loss during conversation compaction. It stores critical information **outside** the compaction pipeline:

- **Identity** - Personality traits and user profile
- **Active Context** - Current project, task, and decisions
- **Facts** - Persistent facts extracted from conversations
- **Integrations** - Cached data from external services (calendar, reminders, etc.)

## Installation

The plugin is included in the Moltbot workspace. Enable it via CLI:

```bash
moltbot plugins enable working-memory
```

Or add to your config (`~/.moltbot/moltbot.json`):

```json
{
  "plugins": {
    "entries": {
      "working-memory": {
        "enabled": true
      }
    }
  }
}
```

## CLI Commands

```bash
# Show plugin status
moltbot wm status

# View current identity (personality + user profile)
moltbot wm identity

# View active context (project/task)
moltbot wm context

# List all stored facts
moltbot wm facts
moltbot wm facts --category preference
moltbot wm facts --limit 20

# Search facts
moltbot wm search "typescript"

# List recent history chunks (Phase 2)
moltbot wm chunks
moltbot wm chunks --limit 20

# Check embeddings status (Phase 2)
moltbot wm embeddings-status

# Generate embeddings for chunks that don't have them (Phase 2)
moltbot wm backfill-embeddings
moltbot wm backfill-embeddings --limit 100

# Reset all data (dangerous!)
moltbot wm reset --confirm
```

## How It Works

### Context Injection (before_agent_start)

Before each agent turn, Working Memory injects relevant context into the prompt:

```xml
<working-memory>
  <personality>
    Name: Claude
    Tone: warm, professional, helpful
    ...
  </personality>

  <user-profile>
    Name: Chris
    Preferences:
    - Prefers TypeScript
    - Likes concise responses
  </user-profile>

  <active-context>
    Project: Working Memory Plugin
    Task: Write documentation
    Recent Decisions:
    - Use SQLite for storage
  </active-context>

  <relevant-facts>
    [preference] user: Prefers dark mode
    [decision] project: Using SQLite for database
  </relevant-facts>
</working-memory>
```

### Fact Extraction (agent_end)

After each conversation turn, the plugin asynchronously extracts facts using pattern matching:

- User name mentions ("My name is Chris")
- Preferences ("I prefer TypeScript")
- Decisions ("Let's use SQLite")
- Project context ("Working on the voice assistant")

### Chat-Driven Personality Updates

Users can update the assistant's personality through conversation:

- "Be more casual" → Updates tone
- "I prefer concise responses" → Adds to user preferences
- "My name is Chris" → Updates user profile

## Configuration

```json
{
  "plugins": {
    "entries": {
      "working-memory": {
        "enabled": true,
        "config": {
          "embeddings": {
            "enabled": true,
            "provider": "openai",
            "model": "text-embedding-3-small",
            "dimensions": 1536,
            "ollamaBaseUrl": "http://localhost:11434",
            "fallbackProvider": "ollama",
            "fallbackModel": "nomic-embed-text"
          },
          "extraction": {
            "enabled": true,
            "mode": "pattern",
            "model": "claude-3-5-haiku-latest"
          },
          "identity": {
            "allowChatUpdates": true,
            "lockedTraits": ["name"]
          },
          "injection": {
            "identityTokens": 1500,
            "activeContextTokens": 1000,
            "factsTokens": 1000,
            "integrationTokens": 1000,
            "historyChunksTokens": 2000
          },
          "integrations": {
            "defaultTtl": 300,
            "refreshOnMention": true
          },
          "historyChunks": {
            "enabled": true,
            "maxChunks": 100,
            "summarizeAfterMessages": 10,
            "maxSummaryTokens": 500
          },
          "consolidation": {
            "enabled": false,
            "intervalHours": 24,
            "expireAfterDays": 30,
            "expireConfidenceThreshold": 0.5
          },
          "storage": {
            "dbPath": "working-memory"
          }
        }
      }
    }
  }
}
```

### Embedding Providers

| Provider | Model | Dimensions | Cost | Notes |
|----------|-------|------------|------|-------|
| OpenAI | text-embedding-3-small | 1536 | $0.02/1M | Default, best quality/cost |
| OpenAI | text-embedding-3-large | 3072 | $0.13/1M | Higher quality |
| Ollama | nomic-embed-text | 768 | Free | Local, offline capable |

Set `OPENAI_API_KEY` environment variable for OpenAI embeddings.

## Gateway Methods (for iOS/External Apps)

The plugin exposes RPC methods for external integration:

### Identity
- `working_memory.identity` - Get current identity
- `working_memory.identity.update` - Update identity

### Context
- `working_memory.context` - Get active context
- `working_memory.context.set_project` - Set current project
- `working_memory.context.set_task` - Set current task
- `working_memory.context.add_decision` - Record a decision
- `working_memory.context.clear` - Clear context

### Facts
- `working_memory.facts.list` - List all facts
- `working_memory.facts.search` - Search facts (FTS)
- `working_memory.facts.add` - Add a fact
- `working_memory.facts.delete` - Delete a fact

### Integrations
- `working_memory.integrations.push` - Push data from external source
- `working_memory.integrations.push_bulk` - Bulk push
- `working_memory.integrations.get` - Get cached data
- `working_memory.integrations.clear` - Clear cache
- `working_memory.integrations.status` - Cache status

### Admin
- `working_memory.status` - Full status
- `working_memory.export` - Export all data
- `working_memory.reset` - Reset (requires confirm: true)

## Agent Tools

The plugin registers tools the agent can use:

- `working_memory_set_context` - Update project/task/decisions
- `working_memory_remember` - Store a fact
- `working_memory_recall` - Search facts

## Storage

Data is stored in the agent directory:

```
~/.moltbot/agents/default/working-memory/
├── state.db          # SQLite (facts, history chunks, integrations)
├── identity.json     # Personality + user profile
└── active-context.json  # Current project/task
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Working Memory Plugin                     │
├─────────────────────────────────────────────────────────────┤
│  Hooks                                                       │
│  ├── before_agent_start → Context Injection                 │
│  │   └── Semantic history retrieval (via embeddings)        │
│  └── agent_end → Fact Extraction + History Chunks (async)   │
├─────────────────────────────────────────────────────────────┤
│  Phase 1 Managers                                            │
│  ├── IdentityManager      (personality, user profile)       │
│  ├── ActiveContextManager (project, task, decisions)        │
│  ├── FactStore           (CRUD, FTS search)                 │
│  └── IntegrationCache    (TTL-based caching)                │
├─────────────────────────────────────────────────────────────┤
│  Phase 2 Components                                          │
│  ├── EmbeddingService    (OpenAI/Ollama embeddings)         │
│  ├── VectorStore         (cosine similarity search)         │
│  └── HistoryChunkManager (conversation summarization)       │
├─────────────────────────────────────────────────────────────┤
│  Storage                                                     │
│  ├── SQLite              (facts, chunks+embeddings, cache)  │
│  └── JSON Files          (identity, active-context)         │
└─────────────────────────────────────────────────────────────┘
```

## Phase 2 Features

### Phase 2.1: Embeddings Infrastructure ✅

- **EmbeddingService**: Generate embeddings via OpenAI or Ollama
  - OpenAI `text-embedding-3-small` (default)
  - Ollama fallback for offline use
  - In-memory caching with TTL
  - Batch embedding support

- **VectorStore**: Semantic similarity search
  - Cosine similarity calculation
  - Configurable similarity threshold
  - Automatic index management

- **HistoryChunkManager**: Conversation summarization
  - Automatic chunking after N messages
  - Entity extraction from conversations
  - Embedding generation for chunks
  - Pruning of old chunks

### Phase 2.2: Semantic History (In Progress)

- Context injection includes semantically relevant history
- Vector search retrieves chunks similar to current prompt
- History chunks formatted with age indicators

### Phase 2.3: LLM Extraction (Planned)

- Replace pattern matching with LLM-based fact extraction
- Hybrid mode: pattern first, LLM for complex cases
- Configurable extraction model (Haiku recommended)

### Phase 2.4: Consolidation (Planned)

- Periodic consolidation of duplicate facts
- Expiration of old, low-confidence facts
- Cross-session memory merging
