# Veritas — SharedOS Hackathon Submission

## Project Name

Veritas — Evidence Verification Agent for SharedOS Arena

## Tagline

An A2A agent that evaluates claim credibility and returns structured verdicts with evidence. Your safety net when defending or refuting in the Arena.

## What it does

Veritas is a SharedOS-native agent that other agents can call to fact-check claims before arguing. Given any assertion, it returns:

- A **credibility score** (0-100)
- A **verdict** (可信/存疑/不可信/无法判定)
- **Evidence** supporting the verdict
- **Risk factors** that threaten credibility

It runs on the SharedOS kernel, issues capability grants to callers, audits every invocation, and exposes tools via both direct HTTP and the kernel's tool catalog.

## How it works

1. An agent in the Arena needs to defend a claim or refute an opponent
2. It calls `veritas.verify` with the claim (and optional context)
3. Veritas evaluates via LLM (Qwen/Claude) with structured output
4. Returns a 4-field response: credibility, verdict, evidence, risk_factors
5. Every call is audited (file-based JSONL + optional Discord webhook)
6. First 3 calls per agent are free; 3 credits/call thereafter

## Technical Architecture

- **SharedOS Kernel**: Full integration with `@aicoo/sharedos` — grant source, audit sink, tool registry, agent card
- **LLM Backend**: Qwen (DashScope) or Claude, with JSON Schema structured output
- **Three deployment shapes**:
  - Self-hosted: `npm start` on localhost
  - Cloud-hosted: Render deployment (free tier)
  - CLI/MCP: `npx veritas verify` or `npx veritas-mcp`
- **Audit**: File-based JSONL + optional Discord webhook
- **Grant system**: First 3 calls free/agent, then 1 credit/call, 7-day expiry

## Reused components

The core verification prompt and structured output logic is adapted from the [Spot the Spin](https://github.com/HpIahtcthocw/spot-the-spin) project (面具与本真), which implements media manipulation detection with the same LLM calling pattern and JSON Schema validation.

## Links

- **GitHub**: https://github.com/HpIahtcthocw/sharedos-verify
- **Live Demo**: https://sharedos-verify.onrender.com
- **Agent Card**: https://sharedos-verify.onrender.com/agent/card
- **Health**: https://sharedos-verify.onrender.com/health

## Try it

```bash
curl -X POST https://sharedos-verify.onrender.com/verify \
  -H "Content-Type: application/json" \
  -d '{"claim": "The Earth is flat"}'
```

## Agent Node ID

`veritas` (registered on SharedNet via /agent/card)

## Team

Solo developer + Claude Code (AI teammate)
