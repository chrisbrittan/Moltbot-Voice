#!/usr/bin/env python3
"""
Direct Microsoft Graph API client for Outlook.
Bypasses MCP servers - uses tokens directly.

Requires environment variables or config file for secrets.
"""
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime

# Load account config from file (secrets not in code)
CONFIG_PATH = os.path.expanduser("~/.clawdbot/outlook-accounts.json")

def load_accounts():
    """Load account configuration from file."""
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    # Fallback to environment variables
    return {
        "business": {
            "token_path": os.environ.get("OUTLOOK_BUSINESS_TOKEN_PATH", os.path.expanduser("~/.outlook-business/.outlook-mcp-tokens.json")),
            "client_id": os.environ.get("OUTLOOK_BUSINESS_CLIENT_ID", ""),
            "client_secret": os.environ.get("OUTLOOK_BUSINESS_CLIENT_SECRET", ""),
            "email": "chris@carbonkopi.com"
        },
        "personal": {
            "token_path": os.environ.get("OUTLOOK_PERSONAL_TOKEN_PATH", os.path.expanduser("~/.outlook-personal/.outlook-mcp-tokens.json")),
            "client_id": os.environ.get("OUTLOOK_PERSONAL_CLIENT_ID", ""),
            "client_secret": os.environ.get("OUTLOOK_PERSONAL_CLIENT_SECRET", ""),
            "email": "chris@brittan.co"
        }
    }

ACCOUNTS = load_accounts()

def get_token(account="business"):
    """Get access token, refreshing if needed."""
    cfg = ACCOUNTS.get(account, ACCOUNTS["business"])
    
    with open(cfg["token_path"]) as f:
        tokens = json.load(f)
    
    # Check if token is expired (with 5 min buffer)
    expires_at = tokens.get("expires_at", 0)
    if isinstance(expires_at, int) and expires_at > 1000000000000:
        expires_at = expires_at / 1000  # Convert ms to seconds
    
    if datetime.now().timestamp() > expires_at - 300:
        # Refresh token
        if not cfg.get("client_id") or not cfg.get("client_secret"):
            raise ValueError(f"Missing client_id or client_secret for {account}. Set up {CONFIG_PATH}")
        
        data = urllib.parse.urlencode({
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "refresh_token": tokens["refresh_token"],
            "grant_type": "refresh_token",
            "scope": "offline_access Mail.Read Mail.Send Mail.ReadWrite Calendars.Read Calendars.ReadWrite Contacts.Read"
        }).encode()
        
        req = urllib.request.Request(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        
        with urllib.request.urlopen(req, timeout=30) as resp:
            tokens = json.loads(resp.read())
            tokens["expires_at"] = int(datetime.now().timestamp()) + tokens.get("expires_in", 3600)
            with open(cfg["token_path"], "w") as f:
                json.dump(tokens, f, indent=2)
    
    return tokens["access_token"]

def graph_request(endpoint, account="business", method="GET", body=None):
    """Make a request to Microsoft Graph API."""
    token = get_token(account)
    
    # Handle query parameters properly
    base = "https://graph.microsoft.com/v1.0"
    if "?" in endpoint:
        path, query = endpoint.split("?", 1)
        # URL encode the query parameters
        params = urllib.parse.parse_qs(query, keep_blank_values=True)
        encoded_params = urllib.parse.urlencode({k: v[0] for k, v in params.items()}, safe="$")
        url = f"{base}{path}?{encoded_params}"
    else:
        url = f"{base}{endpoint}"
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "message": e.read().decode()}

def list_emails(account="business", count=10, folder="inbox"):
    """List recent emails."""
    endpoint = f"/me/mailFolders/{folder}/messages?$top={count}&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,isRead,bodyPreview"
    result = graph_request(endpoint, account)
    
    if "error" in result:
        return result
    
    emails = []
    for msg in result.get("value", []):
        emails.append({
            "id": msg["id"],
            "subject": msg.get("subject", "(no subject)"),
            "from": msg.get("from", {}).get("emailAddress", {}).get("address", "unknown"),
            "date": msg.get("receivedDateTime", ""),
            "read": msg.get("isRead", False),
            "preview": msg.get("bodyPreview", "")[:100]
        })
    return {"emails": emails, "count": len(emails)}

def search_emails(query, account="business", count=10):
    """Search emails."""
    encoded_query = urllib.parse.quote(query)
    endpoint = f"/me/messages?$search=%22{encoded_query}%22&$top={count}&$select=id,subject,from,receivedDateTime,bodyPreview"
    result = graph_request(endpoint, account)
    
    if "error" in result:
        return result
    
    emails = []
    for msg in result.get("value", []):
        emails.append({
            "id": msg["id"],
            "subject": msg.get("subject", "(no subject)"),
            "from": msg.get("from", {}).get("emailAddress", {}).get("address", "unknown"),
            "date": msg.get("receivedDateTime", ""),
            "preview": msg.get("bodyPreview", "")[:100]
        })
    return {"emails": emails, "count": len(emails)}

def get_email(email_id, account="business"):
    """Get full email content."""
    result = graph_request(f"/me/messages/{email_id}", account)
    if "error" in result:
        return result
    return {
        "id": result["id"],
        "subject": result.get("subject", "(no subject)"),
        "from": result.get("from", {}).get("emailAddress", {}),
        "to": [r.get("emailAddress", {}) for r in result.get("toRecipients", [])],
        "date": result.get("receivedDateTime", ""),
        "body": result.get("body", {}).get("content", "")
    }

def send_email(to, subject, body, account="business", html=False):
    """Send an email."""
    message = {
        "message": {
            "subject": subject,
            "body": {
                "contentType": "HTML" if html else "Text",
                "content": body
            },
            "toRecipients": [{"emailAddress": {"address": to}}]
        }
    }
    return graph_request("/me/sendMail", account, method="POST", body=message)

def list_calendar_events(account="business", count=10):
    """List upcoming calendar events."""
    endpoint = f"/me/calendar/events?$top={count}&$orderby=start/dateTime&$select=id,subject,start,end,location,organizer"
    result = graph_request(endpoint, account)
    
    if "error" in result:
        return result
    
    events = []
    for evt in result.get("value", []):
        events.append({
            "id": evt["id"],
            "subject": evt.get("subject", "(no subject)"),
            "start": evt.get("start", {}).get("dateTime", ""),
            "end": evt.get("end", {}).get("dateTime", ""),
            "location": evt.get("location", {}).get("displayName", ""),
            "organizer": evt.get("organizer", {}).get("emailAddress", {}).get("address", "")
        })
    return {"events": events, "count": len(events)}

def whoami(account="business"):
    """Get current user info."""
    return graph_request("/me", account)

# CLI interface
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Outlook CLI")
    parser.add_argument("command", choices=["emails", "search", "read", "send", "calendar", "whoami"])
    parser.add_argument("--account", "-a", default="business", choices=["business", "personal", "natalie", "natalie-business"])
    parser.add_argument("--count", "-n", type=int, default=10)
    parser.add_argument("--query", "-q", help="Search query")
    parser.add_argument("--id", help="Email ID")
    parser.add_argument("--to", help="Recipient email")
    parser.add_argument("--subject", "-s", help="Email subject")
    parser.add_argument("--body", "-b", help="Email body")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    
    args = parser.parse_args()
    
    try:
        if args.command == "emails":
            result = list_emails(args.account, args.count)
        elif args.command == "search":
            if not args.query:
                print("Error: --query required for search")
                sys.exit(1)
            result = search_emails(args.query, args.account, args.count)
        elif args.command == "read":
            if not args.id:
                print("Error: --id required for read")
                sys.exit(1)
            result = get_email(args.id, args.account)
        elif args.command == "send":
            if not all([args.to, args.subject, args.body]):
                print("Error: --to, --subject, --body required for send")
                sys.exit(1)
            result = send_email(args.to, args.subject, args.body, args.account)
        elif args.command == "calendar":
            result = list_calendar_events(args.account, args.count)
        elif args.command == "whoami":
            result = whoami(args.account)
        
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
