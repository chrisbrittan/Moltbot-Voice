# Moltbot-Voice - Claude Code Instructions

> ⚠️ **READ THIS ENTIRE FILE BEFORE DOING ANYTHING**
> Global rules (session logging, feature workflow, sub-agents) are in `~/CLAUDE.md` - read that too.

---

## 🔍 Project Detection

**You are working on: Moltbot-Voice** (Personal AI assistant fork with voice capabilities)

Verify by checking current directory contains:
- `moltbot.mjs` - Main CLI entry point
- `extensions/voice-call/` - Voice call extension
- `src/tts/` - Text-to-speech module

---

## 🚨 MANDATORY FIRST STEPS (Every Session)

1. **Read Obsidian docs:** 
   - Mac: `~/Library/CloudStorage/OneDrive-Brittan/GRNLR_Vault/1 - Projects/Moltbot-Voice/00 - Overview.md`
   - Windows: Check OneDrive path

2. **Check dev log:** `1 - Projects/Moltbot-Voice/Development Log.md`

3. **Check upstream changes:**
   ```bash
   git fetch upstream
   git log HEAD..upstream/main --oneline | head -10
   ```

---

## 📍 Environment Reference

| Machine | Role | Project Path | Notes |
|---------|------|--------------|-------|
| **MacBook** | Primary Dev | `~/Documents/Development/Moltbot-Voice` | Main development |
| **TALLULAH** | Windows Dev | `D:\Development\Moltbot-Voice` | If cloned |

---

## 🛠️ Tech Stack

- **Runtime:** Node.js ≥22 (TypeScript)
- **Package Manager:** pnpm
- **Build:** tsc, esbuild, rolldown
- **Testing:** Vitest
- **Desktop Apps:** Swift (macOS), Kotlin (Android)
- **Voice:** node-edge-tts, sherpa-onnx

---

## ✅ Standing Permissions (Project-Specific)

| ✅ Can Do | ❌ Must Ask |
|-----------|-------------|
| Run `pnpm build` | Push to main |
| Run tests (`pnpm test`) | Create releases |
| Git commit & push (feature branches) | Merge PRs |
| Modify local config | Modify gateway tokens/auth |
| Install dev dependencies | Run gateway in production mode |

---

## 🔧 Common Commands

### Development (MacBook)
```bash
cd ~/Documents/Development/Moltbot-Voice

# Build
pnpm build

# Run CLI directly
node moltbot.mjs --help
node moltbot.mjs gateway --port 18789 --verbose

# Run tests
pnpm test              # All tests
pnpm test:unit         # Unit tests only
pnpm vitest run [file] # Specific test

# Lint & format
pnpm lint
pnpm format
```

### First-Time Setup
```bash
# Run onboarding wizard
node moltbot.mjs onboard --install-daemon

# Or configure manually
node moltbot.mjs doctor         # Check setup
node moltbot.mjs channels login # Configure channels
```

### Sync with Upstream
```bash
git fetch upstream
git merge upstream/main
# Resolve conflicts if any
pnpm install  # In case deps changed
pnpm build
```

---

## 📁 Key Directories

```
Moltbot-Voice/
├── src/                    # Core source (TypeScript)
│   ├── agents/             # Agent runner
│   ├── channels/           # Channel base classes
│   ├── cli/                # CLI commands
│   ├── gateway/            # Gateway server
│   ├── tts/                # Text-to-speech ← Voice focus
│   └── tui/                # Terminal UI
├── extensions/             # Plugin extensions
│   ├── voice-call/         # ← Voice calling extension
│   ├── whatsapp/           
│   ├── telegram/           
│   └── ...
├── skills/                 # Built-in skills
│   ├── voice-call/         # ← Voice call skill
│   └── ...
├── apps/                   # Native apps
│   ├── ios/                
│   ├── macos/              
│   └── android/            
├── docs/                   # Documentation
└── ui/                     # Web UI
```

---

## 🎤 Voice-Specific Files

| Purpose | Path |
|---------|------|
| Voice Call Extension | `extensions/voice-call/` |
| Voice Call Skill | `skills/voice-call/` |
| TTS Engine | `src/tts/` |
| macOS Speech | `src/macos/` |
| Sherpa ONNX Skill | `skills/sherpa-onnx-tts/` |

---

## 📚 Documentation Index

| Topic | Location |
|-------|----------|
| Obsidian Overview | `1 - Projects/Moltbot-Voice/00 - Overview.md` |
| Obsidian Dev Log | `1 - Projects/Moltbot-Voice/Development Log.md` |
| Upstream Docs | `docs/` folder or https://clawd.bot |
| TTS Docs | `docs/tts.md` |
| Voice Call Docs | `docs/tools/voice-call.md` (if exists) |

---

## ⚠️ Common Mistakes

1. **Forgetting to build** - Always `pnpm build` after source changes before testing
2. **Wrong Node version** - Requires Node ≥22, check with `node --version`
3. **Missing pnpm** - Use pnpm not npm (`npm install -g pnpm` if missing)
4. **Config location** - Config is at `~/.clawdbot/moltbot.json`, not in project dir
5. **Credentials** - Never commit tokens/credentials (stored in `~/.clawdbot/credentials`)

---

## 🔗 Useful Links

- **Fork:** https://github.com/chrisbrittan/Moltbot-Voice
- **Upstream:** https://github.com/moltbot/moltbot
- **Docs:** https://clawd.bot
- **ClawdHub:** https://clawdhub.com
- **Discord:** Check upstream README for invite

---

*Last updated: 2026-01-28*
