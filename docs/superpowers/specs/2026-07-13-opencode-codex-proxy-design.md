# OpenCode Codex OAuth Proxy - Design Specification

> 2026-07-13 | Node.js | Independent local proxy, no CC Switch dependency

## 1. Purpose

A local Node.js HTTP proxy that lets OpenCode use a ChatGPT Plus/Pro subscription
through OpenAI's Codex backend. The proxy handles OAuth login, token refresh, and
protocol forwarding independently—no dependency on CC Switch.

## 2. Architecture

```text
OpenCode (@ai-sdk/openai)
  ↓ POST /v1/responses, GET /v1/models
Proxy 127.0.0.1:15722 (Express/Node)
  ├─ /v1/models      → fetch from Codex backend
  ├─ /v1/responses   → forward with OAuth token
  ├─ /login          → start device-code OAuth flow
  └─ /status         → check login state
        ↓ (Bearer token + ChatGPT-Account-Id)
https://chatgpt.com/backend-api/codex
```

The proxy runs on `127.0.0.1:15722` (not 15721 to avoid colliding with CC Switch).
All OAuth credentials stay local; no external network exposure.

## 3. OAuth Flow

### Device Code (same as official Codex CLI)
- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Device code endpoint: `POST https://auth.openai.com/api/accounts/deviceauth/usercode`
- Body: `client_id`, `scope=openid profile email`
- Response: `{user_code, device_code, verification_uri, expires_in}`
- Verification URL: `https://auth.openai.com/codex/device`

### Polling for Token
- Poll endpoint: `POST https://auth.openai.com/api/accounts/deviceauth/token`
- Body: `client_id`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`
- Max poll attempts: 60 (poll every 5s, ~5 min total)

### Token Exchange
- Token endpoint: `POST https://auth.openai.com/oauth/token`
- Body: `grant_type=authorization_code`, `code`, `client_id`, `code_verifier`, `redirect_uri=https://auth.openai.com/deviceauth/callback`

### Identity Extraction
- Parse the `id_token` JWT to extract `chatgpt_account_id` (try `chatgpt_account_id` claim, then `organizations` array)

### Refresh
- Same token endpoint, grant_type=refresh_token
- Sent as `application/x-www-form-urlencoded`
- Refresh when <60s until expiry (access tokens decoded from JWT or from expires_in)
- If a new refresh_token is returned, replace the stored one

### Token Storage
- File: `./data/auth.json` (mode 0600 on Unix, stored in project root)
- JSON schema:
  ```json
  {
    "account_id": "chatgpt-...",
    "email": "user@example.com",
    "refresh_token": "...",
    "access_token": "..."
  }
  ```
- No encryption—user's machine, single-user proxy.

## 4. API Endpoints

### `GET /v1/models`
- Fetch from `https://chatgpt.com/backend-api/codex/models`
- Headers: `Authorization: Bearer <token>`, `ChatGPT-Account-Id: <id>`, `originator: opencode-codex-bridge`
- Parse the response (handle `data`, `models`, or `items` wrapper arrays)
- Return OpenAI-compatible: `{object: "list", data: [{id, owned_by}, ...]}`

### `POST /v1/responses`
- Accept standard OpenAI Responses API request
- Normalize body: force `stream: true`, `store: false`, add `include: ["reasoning.encrypted_content"]`, add `parallel_tool_calls: false`, remove `max_output_tokens`/`temperature`/`top_p`
- Forward to `https://chatgpt.com/backend-api/codex/responses`
- Headers: `Authorization: Bearer <token>`, `ChatGPT-Account-Id: <id>`, `originator: opencode-codex-bridge`, `Content-Type: application/json`
- Stream SSE responses back to client (both streaming and non-streaming clients)

### `POST /login`
- Start device-code flow, return `{user_code, verification_uri, message}`
- User opens browser at verification_uri, enters user_code
- Uses SSE to stream status back to a simple CLI/curl caller

### `POST /login/status`
- Return `{authenticated: bool, account_id?: string, email?: string}`

### `GET /health`
- Return `{status: "ok"}`

## 5. Model Mapping

No model name mapping needed. The proxy passes model names through verbatim.
OpenCode sends `gpt-5-codex`, `gpt-5.3-codex`, etc., and the Codex backend
returns whatever models the subscription actually has access to.

OpenCode config example:
```json
{
  "provider": {
    "codex-local": {
      "npm": "@ai-sdk/openai",
      "options": {
        "baseURL": "http://127.0.0.1:15722/v1",
        "apiKey": "PROXY_MANAGED"
      },
      "models": {}
    }
  }
}
```

## 6. Error Handling

| Scenario | Response |
|----------|----------|
| Not authenticated | 401 with `{error: "not_authenticated", message: "Run /login first"}` |
| Token expired, refresh failed | 401 with prompt to re-login |
| Codex upstream error | Pass through with original status code |
| Codex rate limit / quota | Pass through 429/403 with upstream message |

## 7. Startup & Lifecycle

- Start: `npm start` (reads auth.json, auto-refreshes if needed, starts server)
- Login: `curl -X POST http://127.0.0.1:15722/login` → follow device code instructions
- Stop: Ctrl+C (graceful shutdown)
- Auto-start: Not in v1. User starts manually before using OpenCode.

## 8. Tech Stack

- Runtime: Node.js 22 (already available on machine)
- Framework: Express.js
- HTTP client: node-fetch or built-in fetch (Node 22 has native fetch)
- SSE parsing: eventsource-parser or manual
- JWT parsing: no library needed, just base64 decode the payload
- No database, no external dependencies beyond npm packages

## 9. Security

- Binds to 127.0.0.1 only (no LAN access)
- Token file stored in project directory, not in home directory
- No CORS headers (same-machine access only)
- No HTTPS (localhost only)
- Placeholder API key `PROXY_MANAGED` used by OpenCode; real token never visible to OpenCode

## 10. Non-Goals (v1)

- No multi-account support (single ChatGPT account)
- No automatic startup (manual)
- No quota/usage display
- No web UI
- No Claude Code / Gemini / other tool support
- No model catalog caching beyond per-request forwarding
- No request caching or prompt caching configuration
- No tool call format conversion (Responses in, Responses out)

## 11. Verification

1. `npm start` → proxy starts, health check passes
2. `curl -X POST http://127.0.0.1:15722/login` → device code URL shown
3. Open URL, enter code, authorize
4. `curl http://127.0.0.1:15722/v1/models` → returns Codex model list
5. Configure OpenCode with the provider config above
6. OpenCode sends a chat message → receives streaming response
7. OpenCode uses a tool (e.g. read_file) → tool call works, result returned
8. Multi-turn conversation with tool calls → works correctly
