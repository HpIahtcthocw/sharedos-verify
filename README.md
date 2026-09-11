# Veritas — A2A Evidence Verification Agent

**SharedOS Hackathon 2025 · Arena Submission**

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
# Edit .env: set DASHSCOPE_API_KEY=sk-xxx

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

This service runs on the SharedOS kernel. It:

- **Registers tools**: `veritas.verify` and `veritas.health`
- **Issues grants**: First 3 verify calls free, then 1 credit/call (competition pricing)
- **Audits every call**: JSONL file + optional Discord webhook
- **Publishes agent card**: `GET /agent/card` for SharedNet discovery

### Grant System

```
First 3 calls: free (trial)
Subsequent calls: 1 credit each

Why paid after trial?
- Competition ranks by credits CONSUMED (not earned)
- Free = 0 income = eliminated from top prize
- Low barrier to try, then paid calls generate real consumption

Grant purposes: arena.defend, arena.refute, factcheck
Grant expiry: 7 days
```

### Why Not 100% Free?

The competition has two prize tracks:
1. **Top Earner** ($2,220) — ranks by credits others spend buying YOUR service
2. **Credit Race** — ranks by total credits consumed

Free = 0 credit consumption = 0 points in both tracks. The 1 credit/call pricing ensures
every call counts toward the ranking while the first 3 free trials lower the barrier to try.

## Deployment

### Render (free tier)

1. Push to GitHub
2. Connect Render to your repo
3. Set environment variables:
   - `DASHSCOPE_API_KEY` = your DashScope key
   - `PROVIDER` = `qwen`
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
| `DASHSCOPE_API_KEY` | Yes* | — | DashScope API key (Qwen) |
| `PROVIDER` | No | `qwen` | Model provider: `qwen` or `claude` |
| `MASK_MODEL` | No | `qwen-plus` | Model name for Qwen |
| `ANTHROPIC_API_KEY` | Yes** | — | Required if PROVIDER=claude |
| `PORT` | No | `4000` | Service port |
| `AUDIT_DIR` | No | `./audit` | Audit log directory |
| `DISCORD_AUDIT_WEBHOOK` | No | — | Optional Discord webhook for call logging |

*Required for production use.  
**Required only when using Claude provider.

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

- **Runtime**: Node.js 18+, TypeScript
- **LLM**: Qwen (DashScope) or Claude (Anthropic)
- **Framework**: Express
- **Agent Platform**: SharedOS SDK (`@aicoo/sharedos`)
- **Testing**: Vitest
- **Deployment**: Render (free tier)

## License

Apache-2.0
