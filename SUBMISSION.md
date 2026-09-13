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
2. It calls `veritas.verify` with the claim (and optional context) — via `POST /verify` (direct), `POST /kernel/tools/veritas.verify/invoke` (kernel), CLI, or MCP
3. Veritas evaluates via LLM (DeepSeek/Qwen) with structured output
4. Returns a 4-field response: credibility, verdict, evidence, risk_factors
5. Every kernel call is audited: canonical `AuditEvent` records in `audit/kernel-audit-*.jsonl` (version/type/outcome/actor/purpose/grantId) + optional Discord webhook
6. First 3 calls per agent are free (kernel-enforced trial grant); 3 credits/call thereafter (paid grant — `matchedGrantId` is the billing evidence)

## Technical Architecture

- **SharedOS Kernel**: real `SharedOSKernel` from `@aicoo/sharedos` — `registerTool` + `authorize` + `listTools` + `invokeTool`, deny-by-default, kernel usage store enforces the free trial, kernel audit sink writes canonical events
- **LLM Backend**: DeepSeek (SiliconFlow, default) or Qwen (DashScope)
- **Three deployment shapes**:
  - Self-hosted: `npm start` on localhost
  - Cloud-hosted: Render deployment (free tier)
  - CLI/MCP: `node dist/cli.js verify "..."` or `node dist/mcp.js` (also exposed via package `bin`)
- **Audit**: kernel `AuditEvent` JSONL (`audit/kernel-audit-*.jsonl`) + service verdict log (`audit/audit-*.jsonl`) + optional Discord webhook
- **Grant system**: trial grant (maxUses: 3, purposes: arena.defend/arena.refute/factcheck, 7-day expiry) + paid grant (3 credits/call)

## Reused components

The core verification prompt and structured output logic is adapted from the [Spot the Spin](https://github.com/HpIahtcthocw/spot-the-spin) project (面具与本真), which implements media manipulation detection with the same LLM calling pattern and JSON Schema validation.

## Links

<!-- 部署完成后逐项确认可访问再提交 -->

- **GitHub**: https://github.com/HpIahtcthocw/sharedos-verify <!-- TODO: 建仓 push 后生效 -->
- **Live Demo**: https://sharedos-verify.onrender.com <!-- TODO: Render 部署后生效 -->
- **Agent Card**: https://sharedos-verify.onrender.com/agent/card
- **Health**: https://sharedos-verify.onrender.com/health
- **Kernel usage ledger**: https://sharedos-verify.onrender.com/kernel/usage

## Try it

```bash
curl -X POST https://sharedos-verify.onrender.com/verify \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: <your-agent-id>" \
  -d '{"claim": "The Earth is flat"}'

# Kernel surface (SharedOS authorize → invoke → audit)
curl -X POST https://sharedos-verify.onrender.com/kernel/authorize \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: <your-agent-id>" -H "X-Purpose: arena.defend" \
  -d '{"resource":{"namespace":"sharedos.verify","path":["verify"]},"action":"invoke"}'
```

## SharedNet Seat (比赛上场身份)

- **Seat ID**: `i_vWM2I80p5v` (room `rom_TxTzqEUKyx` "Q & A" — 服务复用此 seat, 重启不变)
- **Principal ID**: `p_aQsk8ubVLk`
- **Agent 地址**: `{ "kind": "agent", "agentId": "veritas" }`
- **Purpose string**: `arena.defend` (primary; also accepts `arena.refute`, `factcheck`)
- **Audit records for organizers**: `audit/kernel-audit-*.jsonl` (canonical SharedOS AuditEvent), also served at `GET /kernel/usage`

## Services (credit-priced)

| Service | What it does | Input | Output | Price |
|---|---|---|---|---|
| `veritas.verify` | Evidence verification: evaluates a claim's credibility — no URL needed | `{ claim, context? }` | `{ credibility: 0-100, verdict, evidence[], risk_factors[] }` | 3 credits/call (first 3 free) |
| `veritas.defend` | Verification + debate kit: also drafts rebuttal points to attack the claim and defense points to hold it | `{ claim, context? }` | verify fields + `rebuttal[]`, `defense[]` | 5 credits/call (first 3 free) |
| `veritas.health` | Service health check | `{}` | `{ service, ok, provider, model }` | free |

Callable via: `POST /verify`, `POST /kernel/tools/veritas.verify/invoke` (or `veritas.defend/invoke`), MCP (`veritas-mcp`), or CLI, or just post a claim in the SharedNet room — the in-room listener answers free-trial verdicts automatically. Responds well within the 5-minute delivery cap (typical latency 3-10s).

## Team

Solo developer + Claude Code (AI teammate)

- **Captain Discord username**: `omcdwai`
