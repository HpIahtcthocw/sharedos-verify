# Veritas — A2A Evidence Verification Agent

**SharedOS Weekly Hackathon 2026 · Arena Submission** (Sep 11–13, 2026)

Veritas is an evidence verification agent that evaluates the credibility of claims and returns structured verdicts with supporting evidence and risk factors. Built for the SharedOS Arena, where agents argue, defend, and refute — and need a cheap, fast way to fact-check before they speak.

## Quick Start

```bash
# Clone
git clone https://github.com/HpIahtcthocw/sharedos-verify.git
cd sharedos-verify

# Install
npm install

# Configure (copy .env.example to .env and add your DashScope key)
cp .env.example .env
# Edit .env: set DEEPSEEK_API_KEY=sk-xxx (get from https://siliconflow.cn)

# Run
npm run dev        # local dev with hot reload
# or
npm start          # production (after npm run build)
```

## Three Ways to Use

### 1. HTTP API (direct)

```bash
# Verify a claim
curl -X POST http://localhost:4000/verify \
  -H "Content-Type: application/json" \
  -d '{"claim": "火星上有液态水", "context": "NASA 2024年确认火星南极有液态水湖"}'

# Response
{
  "credibility": 85,
  "verdict": "可信",
  "evidence": [
    "NASA 2024年研究通过雷达探测确认火星南极地下存在液态水湖",
    "该发现发表在《Science》期刊上"
  ],
  "risk_factors": [
    "液态水湖的具体大小和稳定性仍有争议"
  ]
}

# Health check
curl http://localhost:4000/health
```

### 2. CLI

```bash
# Direct verify
npx veritas verify "AI将取代所有程序员" \
  --context "根据2025年BLS统计，AI辅助开发提升效率40%"

# Health check
npx veritas health
```

### 3. MCP (Model Context Protocol)

```bash
# Start MCP server (stdio)
npx veritas-mcp

# Or connect from Claude Desktop:
# In claude_desktop_config.json:
# {
#   "mcpServers": {
#     "veritas": {
#       "command": "node",
#       "args": ["/path/to/sharedos-verify/dist/mcp.js"]
#     }
#   }
# }
```

## SharedOS Kernel Integration

This service runs a **real `SharedOSKernel`** from `@aicoo/sharedos` (verified on Node 22). Every call through `/kernel/*` completes the kernel's authorize → invoke → audit loop:

- **Registers tools**: `kernel.registerTool()` for `veritas.verify` and `veritas.health`
- **Real authorization**: `POST /kernel/authorize` → `kernel.authorize()` — deny-by-default; unknown callers, unlisted purposes, or foreign resources are refused with `no_matching_grant`
- **Capability discovery**: `GET /kernel/tools` → `kernel.listTools()` — callers without a matching grant cannot even see the tools
- **Audited invocation**: `POST /kernel/tools/:name/invoke` → `kernel.invokeTool()` — usage metering (`maxUses`) and canonical audit events written by the kernel to `audit/kernel-audit-*.jsonl`
- **Issues grants**: each caller gets a trial grant (`maxUses: 3`, enforced by the kernel usage store) plus a paid grant (`3 credits/call`) — `matchedGrantId` in the audit ledger distinguishes free from billable calls
- **Publishes agent card**: `GET /agent/card` for SharedNet discovery
- **Usage ledger**: `GET /kernel/usage`

### Grant System

```
First 3 calls: free (trial grant, kernel-enforced maxUses)
Subsequent calls: 3 credits each (paid grant — matchedGrantId = billable)

Grant purposes: arena.defend, arena.refute, factcheck (anything else → denied)
Grant expiry: 7 days
```

### Why Not 100% Free?

Top Earner ($2,200) ranks by credits others spend buying YOUR service.
Free = 0 income. The 3-credit price keeps every call countable while the
3 free trials lower the barrier to try.

## Deployment

### Render (free tier)

1. Push to GitHub
2. Connect Render to your repo
3. Set environment variables:
   - `DEEPSEEK_API_KEY` = your SiliconFlow key (https://siliconflow.cn)
   - `PROVIDER` = `deepseek` (default)
   - `PORT` = `10000`
4. Deploy

### Self-hosted

```bash
npm run build
PORT=4000 npm start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | Yes* | — | SiliconFlow API key (DeepSeek) — https://siliconflow.cn |
| `PROVIDER` | No | `deepseek` | Model provider: `deepseek` (default) or `qwen` |
| `DEEPSEEK_MODEL` | No | `deepseek-ai/DeepSeek-V2.5` | Model name for DeepSeek |
| `DASHSCOPE_API_KEY` | Yes** | — | Required only if PROVIDER=qwen (DashScope) |
| `MASK_MODEL` | No | `qwen-plus` | Model name for Qwen (DashScope) |
| `PORT` | No | `4000` | Service port |
| `AUDIT_DIR` | No | `./audit` | Audit log directory |
| `DISCORD_AUDIT_WEBHOOK` | No | — | Optional Discord webhook for call logging |

*Required for production use (default provider).  
**Required only when using PROVIDER=qwen.

## Project Structure

```
sharedos-verify/
├── src/
│   ├── server.ts      # Express + SharedOS kernel integration
│   ├── agent.ts       # Veritas persona + grant definitions
│   ├── audit.ts       # File-based audit logging + optional Discord
│   ├── cli.ts         # CLI entry point (npx veritas)
│   └── mcp.ts         # MCP stdio server
├── test/
│   └── server.test.ts # Unit tests (vitest)
├── render.yaml        # Render deployment config
├── package.json
├── tsconfig.json
└── README.md
```

## Tech Stack

- **Runtime**: Node.js 20.11+ (SDK requirement), TypeScript
- **LLM**: DeepSeek (SiliconFlow) or Qwen (DashScope)
- **Framework**: Express
- **Agent Platform**: SharedOS SDK (`@aicoo/sharedos`) — real kernel integration
- **Testing**: Vitest
- **Deployment**: Render (free tier)

## License

Apache-2.0
