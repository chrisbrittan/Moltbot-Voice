---
name: outlook
description: Access Outlook email and calendar for chris@carbonkopi.com (business) and chris@brittan.co (personal) via direct Microsoft Graph API
metadata:
  {
    "openclaw": {
      "emoji": "📧",
      "requires": { "bins": ["python3"] }
    }
  }
---

# Outlook Access

Direct Microsoft Graph API client for Chris's Outlook accounts. No MCP server dependency.

## Accounts
- **business**: chris@carbonkopi.com (Carbon Kopi)
- **personal**: chris@brittan.co

## Usage

```bash
# List recent emails (default: business account)
python3 skills/outlook/outlook.py emails --count 5

# List emails from personal account  
python3 skills/outlook/outlook.py emails --account personal --count 5

# Search emails
python3 skills/outlook/outlook.py search --query "from:amazon" --count 10

# Read specific email (use ID from email list)
python3 skills/outlook/outlook.py read --id "AAMk..."

# Send email
python3 skills/outlook/outlook.py send --to "someone@example.com" --subject "Hello" --body "Message body"

# List calendar events
python3 skills/outlook/outlook.py calendar --count 10

# Check account info
python3 skills/outlook/outlook.py whoami
python3 skills/outlook/outlook.py whoami --account personal
```

## Commands

| Command | Description |
|---------|-------------|
| `emails` | List recent emails from inbox |
| `search` | Search emails by query |
| `read` | Get full email content by ID |
| `send` | Send a new email |
| `calendar` | List calendar events |
| `whoami` | Get current user info |

## Options

| Option | Description |
|--------|-------------|
| `--account`, `-a` | Account: `business` (default) or `personal` |
| `--count`, `-n` | Number of items to return (default: 10) |
| `--query`, `-q` | Search query (for search command) |
| `--id` | Email ID (for read command) |
| `--to` | Recipient (for send command) |
| `--subject`, `-s` | Subject (for send command) |
| `--body`, `-b` | Body text (for send command) |

## Token Management

Tokens auto-refresh every 30 minutes via LaunchAgent. Manual refresh:
```bash
python3 ~/.clawdbot/scripts/refresh-outlook-tokens.py
```

## Token Locations
- Business: `~/.outlook-business/.outlook-mcp-tokens.json`
- Personal: `~/.outlook-personal/.outlook-mcp-tokens.json`
