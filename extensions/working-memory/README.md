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
          "extraction": {
            "enabled": true,
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
            "integrationTokens": 1000
          },
          "integrations": {
            "defaultTtl": 300,
            "refreshOnMention": true
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
│  └── agent_end → Fact Extraction (async)                    │
├─────────────────────────────────────────────────────────────┤
│  Managers                                                    │
│  ├── IdentityManager      (personality, user profile)       │
│  ├── ActiveContextManager (project, task, decisions)        │
│  ├── FactStore           (CRUD, FTS search)                 │
│  └── IntegrationCache    (TTL-based caching)                │
├─────────────────────────────────────────────────────────────┤
│  Storage                                                     │
│  ├── SQLite              (facts, chunks, integrations)      │
│  └── JSON Files          (identity, active-context)         │
└─────────────────────────────────────────────────────────────┘
```

## Future: Phase 2

Planned enhancements:
- Semantic history chunks with embeddings
- Vector search for relevant context
- LLM-based fact extraction (vs pattern matching)
- Cross-session memory consolidation
