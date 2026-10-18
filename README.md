# 9Router MIBP Version (Fixed & Hardened)

A local and remote AI routing gateway with intelligent provider fallback, token-saving features, and high-concurrency lifecycle tracking.

This repository is a hardened fork of [decolua/9router](https://github.com/decolua/9router) optimized for modern coding agents (OpenCode, Claude Code, Codex, Grok CLI).

---

## 📊 Upstream vs. 9Router Hardened Comparison

| Feature / Area | Upstream (`decolua/9router`) | 9Router Hardened (This Fork) | Why It Matters for AI Coding Agents |
|---|---|---|---|
| **Claude Fallback Format** | Emits raw OpenAI `chat.completion` JSON on forced SSE-to-JSON fallback. | Automatically converts forced fallback JSON back to native Anthropic `type: "message"`. | **Zero-crash fallback:** OpenCode and Claude Code won't throw `HTTP 200 ... JSON but not a Message` when failing over from Claude to Codex/GPT. |
| **Grok CLI (Grok Build) Tools** | Forwards `additional_tools` in `input[]` history; uses outdated CLI v1.0.46. | Promotes `additional_tools` to root `tools` and strips it from `input[]`; updated to CLI v1.0.52. | **Eliminates HTTP 422:** Upstream xAI Rust serializer (`ModelInput`) no longer fails with `unknown item type: input[0]` during agentic tool use. |
| **Antigravity & Claude 5.5** | Incomplete Claude 5.5 mappings; basic rate-limit retry logic. | Full 8-variant Claude 5.5 catalog, thinking config, MITM aliases, and precise 429/409 `resetAt` quota caching. | Seamless Claude 5.5 access; prevents request flooding on rate-limited accounts until their exact reset window. |
| **Account Concurrency** | Basic round-robin without selection mutex; parallel OAuth refreshes collide. | Per-provider selection queue mutex, single-flight OAuth refresh deduplication, and 160s precommit deadline. | Prevents race conditions and token burning when multiple subagents or background tasks send concurrent requests. |
| **Multi-Instance Docker** | Hardcoded healthcheck port `20128` in Dockerfile. | Dynamic healthcheck using `process.env.PORT \|\| 20128`. | Multi-port VPS deployments (e.g., `9router` on :20128, `10router` on :20129) report accurate `healthy` status. |
| **Dashboard Combo Picker** | Unchecked `.map()` throws `TypeError: reading 'providerAlias'`; hides disconnected compatible nodes. | Null-safe model mapping and surfaces compatible nodes in the LLM picker even without active connections. | UI stability and seamless model combo configuration without frontend crashes. |

---

## 🚀 Key Improvements & Technical Deep-Dive

### 1. Claude Client Format Integrity (Zero-Crash Fallback)
* **Forced SSE to Anthropic Message Conversion:** In upstream 9Router, when an Anthropic/Claude client calls a model combo and triggers non-streaming fallback to OpenAI/Codex upstreams, it returns raw OpenAI `chat.completion` JSON, causing fatal client crashes (`HTTP 200 ... JSON but not a Message`). This fork automatically parses and converts forced SSE/non-streaming responses back to native Anthropic `type: "message"` structures (`open-sse/handlers/chatCore/sseToJsonHandler.js` & `nonStreamingHandler.js`).
* **Adaptive Thinking & Tool Choice Normalization:** Normalizes `reasoning_effort`, handles adaptive thinking downgrades gracefully, and clips token ceilings per provider capabilities (`thinkingUnified.js` & `claude.js`).

### 2. Grok CLI / xAI Compatibility
* **`additional_tools` Promotion (Fix HTTP 422 `unknown item type`):** Coding clients like Codex and OpenCode wrap tool definitions inside conversation history (`input: [{ type: "additional_tools", ... }]`). Upstream xAI Rust backends reject this with a 422 deserialization error. This fork extracts and promotes declared tools to top-level `body.tools` and purges `additional_tools` from the input stream (`open-sse/executors/grok-cli.js`).
* **Client Version Sync:** Updated `x-grok-client-version` to `1.0.52` in `open-sse/config/grokCli.js` to match the latest official binary and prevent rejection.

### 3. Antigravity & Modern Model Catalog
* **Claude 5.5 Support:** Full catalog mappings, thinking configs, pricing tiers, and MITM proxy aliases for Claude 5.5 (`open-sse/providers/registry/antigravity.js`, `capabilities.js`, `pricing.js`, `src/mitm/config.js`).
* **Precise Rate-Limit Handling (429/409):** Parses upstream `resetAt` timestamps and retry delays into a local quota cache to prevent request flooding on locked accounts (`open-sse/executors/antigravity.js`).

### 4. High-Concurrency Request Lifecycle & Locking
* **Per-Provider Selection Queue:** Mutex-based account selection queue preventing race conditions during concurrent account rotation (round-robin / fill-first) (`src/sse/services/selectionQueue.js`).
* **160s Precommit Deadline:** Enforces request deadlines with early termination for stalled upstream streams, automatically triggering failover (`open-sse/utils/requestBudget.js`).
* **Single-Flight OAuth Refresh:** Deduplicates concurrent token refresh calls so only one refresh request hits auth servers per connection (`open-sse/services/tokenRefresh/dedup.js`).

### 5. Multi-Instance Docker Architecture
* **Dynamic Healthcheck Port:** Replaced static port `20128` in Dockerfile with `process.env.PORT || 20128`, enabling multiple parallel instances (e.g., `10router` on port `20129`) to report healthy status.

### 6. UI & Combo Picker Resilience
* **Null-Safe Model Mapping:** Added null guards in `ModelSelectModal.js` to prevent frontend crashes (`reading 'providerAlias'`) and surfaces compatible provider nodes even without active connections.

---

## 📦 Installation & Quick Start

### Option 1: Docker Run

```bash
mkdir -p 9router-data
docker run -d \
  --name 9router \
  -p 20128:20128 \
  -v 9router-data:/app/data \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e NODE_ENV=production \
  -e JWT_SECRET=<generate-with-openssl-rand-hex-32> \
  -e INITIAL_PASSWORD=<your-dashboard-password> \
  -e API_KEY_SECRET=<generate-with-openssl-rand-hex-32> \
  -e MACHINE_ID_SALT=<generate-with-openssl-rand-hex-32> \
  mhiqrambhrng/9router-mibp-version:latest
```

### Option 2: Docker Compose

```bash
cp .env.example .env
# Edit .env and supply your secrets
docker compose up -d
```

Dashboard is available at `http://localhost:20128/dashboard`.

### Option 3: Manual (From Source)

Requirements: Node.js 22 or newer.

```bash
git clone https://github.com/jamaahpees/9router-mibp-version-fixed.git
cd 9router-mibp-version-fixed

cp .env.example .env
npm install
npm run build
npm run start
```

---

## 🔗 References & Upstream

* Upstream Project: [decolua/9router](https://github.com/decolua/9router)
* Architecture Overview: [ARCHITECTURE.md](docs/ARCHITECTURE.md)
* Docker Setup Guide: [DOCKER.md](DOCKER.md)