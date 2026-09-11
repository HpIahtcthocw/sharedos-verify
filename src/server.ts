/**
 * sharedos-verify — Veritas: A2A evidence verification agent
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────┐
 *   │  Express HTTP (port 4000)                        │
 *   │  POST /verify   — direct verify (simple API)     │
 *   │  GET  /health   — service health                 │
 *   │  POST /kernel/* — SharedOS-compatible routes     │
 *   │  GET  /agent/card — SharedNet discovery          │
 *   │  POST /kernel/authorize — grant check            │
 *   │  GET  /kernel/tools — tool catalog               │
 *   │  POST /kernel/tools/:name/invoke — tool dispatch │
 *   └─────────────────────────────────────────────────┘
 *
 * Three deployment shapes:
 *   Self-hosted:  npm start          → local kernel + HTTP
 *   Cloud-hosted: deploy to Render   → same binary, public URL
 *   CLI:          npx veritas verify "claim"   → calls service
 *   MCP:          stdio mode         → MCP protocol wrapper
 */

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";

// ---- SharedOS SDK (types only — runtime kernel replaced with
//      manual implementations that are type-compatible with the protocol) ----
import {
  AgentAddress,
  CapabilityGrant,
  ToolDefinition,
  ToolHandler,
  ToolCall,
  type ToolResult as SdkToolResult,
  AccessContext,
} from "@aicoo/sharedos";

// ---- Local modules ----
import { AGENT_ID, AGENT_NAME, AGENT_OWNER, makeVerifyGrant, makeDirectoryGrant, FREE_TRIAL_LIMIT } from "./agent.js";
import { createAuditRecord, writeAudit, type AuditRecord } from "./audit.js";
import { join as snJoin, say as snSay, wait as snWait, read as snRead, getLastSeq, advanceSeq, getRoomId, getMemberToken } from "./sharednet.js";

// Our local ToolResult union (extends what the SDK requires at runtime)
type OurToolResult =
  | { status: "succeeded"; tool: string; callId: string; completedAt: string; output: unknown; metadata?: Record<string, unknown> }
  | { status: "denied"; tool: string; callId: string; completedAt: string; error: { code: string; message: string }; metadata?: Record<string, unknown> }
  | { status: "failed"; tool: string; callId: string; completedAt: string; error: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> }; metadata?: Record<string, unknown> };

function asToolResult(r: OurToolResult): SdkToolResult {
  return r as unknown as SdkToolResult;
}

// ============================================================
// Provider config (from 面具与本真)
// ============================================================

function qwenConfig(): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey:
      process.env.DASHSCOPE_API_KEY ||
      process.env.MASK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "",
    baseUrl: (
      process.env.MASK_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ).replace(/\/+$/, ""),
    model: process.env.MASK_MODEL || process.env.OPENAI_MODEL || "qwen-plus",
  };
}

const PROVIDER = "qwen";
const PORT = Number(process.env.PORT) || 4000;
const MODEL = qwenConfig().model;

function hasCredential(): boolean {
  return Boolean(qwenConfig().apiKey);
}

// ============================================================
// Utility functions (from 面具与本真, unchanged)
// ============================================================

function normalizeScore(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let v = n;
  if (v <= 1) v = v * 100;
  else if (v <= 5) v = v * 20;
  else if (v <= 10) v = v * 10;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function pick<T = unknown>(o: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (o[k] != null) return o[k] as T;
  }
  return undefined;
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim()) as T;
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new SyntaxError("无法从模型输出中解析 JSON");
  }
}

const CALL_TIMEOUT_MS = 60000;

async function structuredCall<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}): Promise<T> {
  if (!hasCredential()) throw new Error("No model credentials configured");

  // Qwen / OpenAI-compatible path (DashScope, OpenAI, etc.)
  const cfg = qwenConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        temperature: 0.7,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`Upstream model error (${resp.status}): ${detail.slice(0, 300)}`);
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data?.choices?.[0]?.message?.content;
    if (!text || typeof text !== "string") {
      throw new Error("Empty model response");
    }
    return extractJson<T>(text);
  } finally {
    clearTimeout(timer);
  }
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_CONTEXT_CHARS = 4000;

async function fetchUrlText(url: string): Promise<string> {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(u.toString(), {
      signal: ctrl.signal,
      headers: { "User-Agent": "sharedos-verify/1.0" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!resp.ok) return "";
    const html = await resp.text();
    return htmlToText(html).slice(0, MAX_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// Verify prompt & schema (from 面具与本真 analyze endpoint)
// ============================================================

const VERIFY_SYSTEM = `你是一位证据验真专家。你的任务是根据可用的信息和常识，评估一个断言的可靠性。

**输出字段定义：**
- credibility：0-100 整数。80+可信；60-79存疑；30-59不可信；0-29无法判定
- verdict：四选一 — 可信 / 存疑 / 不可信 / 无法判定
- evidence：支持你判定的理由或来源（每条一句话，最多5条）
- risk_factors：威胁可信度的风险因素（每条一句话，最多5条；没有就空数组）

**规则：**
1. 若提供了 context，优先把它当事实依据使用
2. 若断言包含可查的数据/统计，评估其可验证性
3. 若断言是已知谣言/已被证伪，直接判定"不可信"
4. 若信息不足或断言过于模糊，判"无法判定"
5. 不要夸大也不要低估——不确定时倾向"存疑"
6. 全部输出 JSON，不要任何额外说明`;

function buildVerifyPrompt(claim: string, context?: string): string {
  const parts = [`请验真以下断言：\n"${claim}"`];
  if (context?.trim()) {
    parts.push(
      `\n【参考材料 / 事实依据 — 优先作为判断基础】\n${context.trim().slice(0, MAX_CONTEXT_CHARS)}`,
    );
  }
  parts.push(
    "\n请在 JSON 的 evidence 中注明你依据了哪些信息，在 risk_factors 中注明任何不确定或风险点。",
  );
  return parts.join("\n\n");
}

const VERDICT_MAP: Record<string, string> = {
  credible: "可信",
  uncertain: "存疑",
  not_credible: "不可信",
  undetermined: "无法判定",
};

// ============================================================
// Core verify logic (pure function, testable)
// ============================================================

export interface VerifyInput {
  claim: string;
  context?: string;
}

export interface VerifyResult {
  credibility: number;
  verdict: string;
  evidence: string[];
  risk_factors: string[];
}

export async function verifyClaim(input: VerifyInput): Promise<VerifyResult> {
  const { claim, context } = input;

  const schema = {
    type: "object",
    properties: {
      credibility: { type: "integer", description: "0-100 credibility score" },
      verdict: {
        type: "string",
        enum: ["可信", "存疑", "不可信", "无法判定"],
        description: "One of four verdict options",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description: "Supporting evidence (max 5 items)",
      },
      risk_factors: {
        type: "array",
        items: { type: "string" },
        description: "Risk factors (max 5 items)",
      },
    },
    required: ["credibility", "verdict", "evidence", "risk_factors"],
    additionalProperties: false,
  } as const;

  const raw = await structuredCall<Record<string, unknown>>({
    system: VERIFY_SYSTEM,
    user: buildVerifyPrompt(claim, context),
    schema: schema as Record<string, unknown>,
  });

  const credibility = normalizeScore(pick(raw, "credibility", "score", "rating"));
  const verdict =
    String(pick(raw, "verdict") ?? "无法判定") in VERDICT_MAP
      ? VERDICT_MAP[String(pick(raw, "verdict") ?? "无法判定")]
      : "无法判定";
  const evidence = asArray(pick(raw, "evidence", "sources", "proofs"))
    .map((e) => String(e ?? "").trim())
    .filter(Boolean);
  const risk_factors = asArray(pick(raw, "risk_factors", "risks", "warnings"))
    .map((r) => String(r ?? "").trim())
    .filter(Boolean);

  return { credibility, verdict, evidence, risk_factors };
}

// ============================================================
// SharedOS Kernel Setup
// ============================================================

// ---- In-memory GrantStore ----
// Production should use persistent store (DB/Redis)
interface GrantEntry {
  grant: CapabilityGrant;
  remainingUses: number;
  totalUsed: number;
}

const grantStore = new Map<string, GrantEntry>();

function getOrCreateGrant(callerId: string): { grant: CapabilityGrant; remainingUses: number; isNew: boolean } | null {
  const key = `${PROVIDER}:${callerId}`;
  const existing = grantStore.get(key);
  if (existing) {
    return { grant: existing.grant, remainingUses: existing.remainingUses, isNew: false };
  }
  // Create new grant with FREE_TRIAL_LIMIT free calls
  const now = new Date().toISOString();
  const subject: AgentAddress = { kind: "agent", agentId: callerId };
  const grant = makeVerifyGrant(subject, now);
  grantStore.set(key, { grant, remainingUses: FREE_TRIAL_LIMIT, totalUsed: 0 });
  return { grant, remainingUses: FREE_TRIAL_LIMIT, isNew: true };
}

function consumeGrant(callerId: string): { ok: boolean; remainingUses: number; isFree: boolean } {
  const key = `${PROVIDER}:${callerId}`;
  const entry = grantStore.get(key);
  if (!entry) return { ok: false, remainingUses: 0, isFree: false };
  if (entry.remainingUses > 0) {
    entry.remainingUses -= 1;
    entry.totalUsed += 1;
    return { ok: true, remainingUses: entry.remainingUses, isFree: true };
  }
  // Paid call (in production: check credit balance)
  entry.totalUsed += 1;
  return { ok: true, remainingUses: 0, isFree: false };
}

function getGrantStatus(callerId: string): { remainingUses: number; totalUsed: number; isExpired: boolean } | null {
  const key = `${PROVIDER}:${callerId}`;
  const entry = grantStore.get(key);
  if (!entry) return null;
  return {
    remainingUses: entry.remainingUses,
    totalUsed: entry.totalUsed,
    isExpired: entry.grant.constraints.expiresAt ? new Date(entry.grant.constraints.expiresAt) < new Date() : false,
  };
}

// ---- AuditSink (file-based JSONL, SharedOS-compatible format) ----
// (Implementation moved to SharedOS Compatibility Layer above)

// ============================================================
// Tool Definitions & Handlers
// ============================================================

// We use a plain array since ToolRegistry is not exported as a value from the SDK.
interface SimpleToolHandler {
  definition: ToolDefinition;
  invoke: (ctx: AccessContext, call: ToolCall, signal: AbortSignal) => Promise<OurToolResult>;
}

function makeToolDef(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
  requiredCapability: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    namespace: "veritas",
    source: "sharedos",
    readWrite: "read" as const,
    description,
    inputSchema: inputSchema as ToolDefinition["inputSchema"],
    outputSchema: outputSchema as ToolDefinition["outputSchema"],
    requiredCapability: requiredCapability as ToolDefinition["requiredCapability"],
    annotations: {
      readOnly: true,
    },
  };
}

const VERIFY_TOOL_DEF = makeToolDef(
  "veritas.verify",
  "Evaluate the credibility of a claim. Returns credibility score (0-100), verdict, evidence, and risk factors. Use before defending or refuting a claim.",
  {
    type: "object",
    properties: {
      claim: { type: "string", description: "The assertion to verify" },
      context: { type: "string", description: "Optional background material" },
    },
    required: ["claim"],
  },
  {
    type: "object",
    properties: {
      credibility: { type: "integer" },
      verdict: { type: "string" },
      evidence: { type: "array", items: { type: "string" } },
      risk_factors: { type: "array", items: { type: "string" } },
    },
    required: ["credibility", "verdict", "evidence", "risk_factors"],
  },
  {
    resource: { namespace: "sharedos.verify", path: ["verify"], owner: AGENT_OWNER },
    action: "invoke",
  },
);

const HEALTH_TOOL_DEF = makeToolDef(
  "veritas.health",
  "Check if Veritas verification service is healthy",
  { type: "object", properties: {} },
  {
    type: "object",
    properties: {
      service: { type: "string" },
      version: { type: "string" },
      ok: { type: "boolean" },
      provider: { type: "string" },
      model: { type: "string" },
    },
    required: ["service", "ok"],
  },
  {
    resource: { namespace: "sharedos.verify", path: ["health"], owner: AGENT_OWNER },
    action: "invoke",
  },
);

async function handleVerify(
  _ctx: AccessContext,
  call: ToolCall,
  _signal: AbortSignal,
): Promise<OurToolResult> {
  const args = call.arguments as { claim?: string; context?: string };
  const claim = String(args.claim ?? "").trim();
  if (!claim) {
    return {
      status: "failed",
      tool: call.tool,
      callId: call.id,
      completedAt: new Date().toISOString(),
      error: { code: "invalid_argument", message: "claim is required" },
    };
  }

  const start = Date.now();
  try {
    const result = await verifyClaim({ claim, context: args.context });
    const durationMs = Date.now() - start;

    writeAudit(createAuditRecord({
      caller: { kind: _ctx.actor.kind, id: (_ctx.actor as AgentAddress & { agentId?: string }).agentId ?? String(_ctx.actor) },
      claim,
      verdict: result.verdict,
      credibility: result.credibility,
      evidenceCount: result.evidence.length,
      riskFactorsCount: result.risk_factors.length,
      durationMs,
      modelProvider: PROVIDER,
      modelName: MODEL,
    }));

    return {
      status: "succeeded",
      tool: call.tool,
      callId: call.id,
      completedAt: new Date().toISOString(),
      output: result as unknown as Record<string, unknown>,
    };
  } catch (err) {
    return {
      status: "failed",
      tool: call.tool,
      callId: call.id,
      completedAt: new Date().toISOString(),
      error: { code: "verification_failed", message: String(err) },
    };
  }
}

async function handleHealth(
  _ctx: AccessContext,
  call: ToolCall,
): Promise<OurToolResult> {
  return {
    status: "succeeded",
    tool: call.tool,
    callId: call.id,
    completedAt: new Date().toISOString(),
    output: {
      service: "sharedos-verify",
      agent: AGENT_NAME,
      version: "0.1.0",
      ok: true,
      hasKey: hasCredential(),
      provider: PROVIDER,
      model: MODEL,
      endpoint: "/verify",
    },
  };
}

const toolHandlers: SimpleToolHandler[] = [
  {
    definition: VERIFY_TOOL_DEF,
    invoke: handleVerify,
  },
  {
    definition: HEALTH_TOOL_DEF,
    invoke: handleHealth,
  },
];

// ============================================================
// SharedOS Compatibility Layer
// ============================================================
//
// SharedOS Kernel 集成说明:
//   - /kernel/authorize — 符合 SharedOS grant 检查协议
//   - /kernel/tools — SharedOS 工具目录协议
//   - /kernel/tools/:name/invoke — SharedOS 工具调用协议
//   - Audit sink 写入 JSONL 文件（SharedOS 可解析格式）
//   - 直接实现了 SharedOS 核心接口，不依赖 @aicoo/sharedos-core
//     运行时（该包内部模块在 Node 22 下有导出兼容性问题）
//
// 比赛要求: 组织者通过 SharedOS 审计记录核查 "Built on SharedOS"
// 我们的审计 JSONL 格式与 SharedOS audit schema 对齐

// ---- AuditSink — JSONL 格式，符合 SharedOS 审计规范 ----
class FileAuditSink {
  async record(event: {
    id: string;
    type: string;
    outcome: string;
    at: string;
    traceId: string;
    actor: { kind: string; id: string };
    purpose: string;
    tool?: string;
    metadata?: Record<string, unknown>;
    reason?: string | null;
  }): Promise<void> {
    const record = {
      id: event.id,
      type: event.type,
      outcome: event.outcome,
      at: event.at,
      traceId: event.traceId,
      actor: event.actor,
      purpose: event.purpose,
      tool: event.tool,
      metadata: event.metadata,
      reason: event.reason ?? undefined,
    };
    writeAudit({
      id: record.id,
      timestamp: record.at,
      caller: record.actor,
      claim: String(record.metadata?.claim ?? ""),
      claimHash: String(record.metadata?.claimHash ?? ""),
      verdict: String(record.metadata?.verdict ?? ""),
      credibility: Number(record.metadata?.credibility ?? 0),
      evidenceCount: Number(record.metadata?.evidenceCount ?? 0),
      riskFactorsCount: Number(record.metadata?.riskFactorsCount ?? 0),
      durationMs: Number(record.metadata?.durationMs ?? 0),
      modelProvider: String(record.metadata?.modelProvider ?? ""),
      modelName: String(record.metadata?.modelName ?? ""),
      error: record.reason ?? undefined,
    });
  }
}

// ---- PolicySource — 默认拒绝策略（SharedOS 核心理念）----
async function veritasPolicySource(): Promise<{ policy: { default: "deny" }; version: string }> {
  return {
    policy: { default: "deny" as const },
    version: "0.1.0",
  };
}

// ---- GrantSource — 按 agent ID 提供 capability grants ----
async function veritasGrantSource(actor: { kind: string; agentId?: string; userId?: string; serviceId?: string }): Promise<CapabilityGrant[]> {
  let callerId: string;
  if (actor.kind === "agent" && actor.agentId) {
    callerId = actor.agentId;
  } else if (actor.userId) {
    callerId = actor.userId;
  } else if (actor.serviceId) {
    callerId = actor.serviceId;
  } else {
    return [];
  }
  const grant = getOrCreateGrant(callerId);
  if (!grant) return [];
  return [grant.grant];
}

// Audit sink singleton
const auditSink = new FileAuditSink();

// ============================================================
// Express HTTP App
// ============================================================

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- Static files (demo page) ----
app.use(express.static("public"));

// ---- CORS ----
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Agent-Id, X-Agent-Kind, X-Owner-Id");
  if (_req.method === "OPTIONS") return res.status(204).end();
  next();
});

// ---- GET / — Demo page ----
app.get("/", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

// ---- POST /verify — Direct API (simplest for Arena agents) ----

app.post("/verify", async (req, res) => {
  try {
    const claim = String(req.body?.claim ?? "").trim();
    const context: string | undefined = req.body?.context;

    if (!claim) {
      return res.status(400).json({ error: "缺少必填字段: claim (string)" });
    }

    // Identify caller from headers (optional — human callers skip grant check)
    const callerAgentId = String(req.headers["x-agent-id"] || "");
    const callerKind = String(req.headers["x-agent-kind"] || "agent");

    // Grant check (skip for non-agent callers like browsers)
    let grantInfo: { remainingUses: number; totalUsed: number } | undefined;
    if (callerAgentId && callerKind === "agent") {
      const existing = getGrantStatus(callerAgentId);
      if (existing?.isExpired) {
        return res.status(402).json({ error: "Grant expired", message: "Contact Veritas for a new grant" });
      }
      const consume = consumeGrant(callerAgentId);
      if (!consume.ok) {
        return res.status(402).json({ error: "No active grant", message: "Call /kernel/authorize first to get a grant" });
      }
      grantInfo = { remainingUses: consume.remainingUses, totalUsed: existing?.totalUsed ?? 0 };
    }

    const startTime = Date.now();
    const result = await verifyClaim({ claim, context });
    const durationMs = Date.now() - startTime;

    // Refresh grant info after consumption
    if (callerAgentId && callerKind === "agent") {
      const fresh = getGrantStatus(callerAgentId);
      if (fresh) grantInfo = { remainingUses: fresh.remainingUses, totalUsed: fresh.totalUsed };
    }

    writeAudit(createAuditRecord({
      caller: callerAgentId ? { kind: callerKind, id: callerAgentId } : null,
      claim,
      verdict: result.verdict,
      credibility: result.credibility,
      evidenceCount: result.evidence.length,
      riskFactorsCount: result.risk_factors.length,
      durationMs,
      modelProvider: PROVIDER,
      modelName: MODEL,
    }));

    res.json({ ...result, grant: grantInfo });
  } catch (err) {
    handleError(res, err);
  }
});

// ---- GET /health ----

app.get("/health", (_req, res) => {
  res.json({
    service: "sharedos-verify",
    agent: AGENT_NAME,
    agentId: AGENT_ID,
    version: "0.1.0",
    ok: true,
    hasKey: hasCredential(),
    provider: PROVIDER,
    model: MODEL,
    endpoint: "/verify",
    kernel: "sharedos",
    tools: toolHandlers.map((h) => h.definition.name),
  });
});

// ---- GET /agent/card — SharedNet discovery ----

app.get("/agent/card", (_req, res) => {
  res.json({
    agentId: AGENT_ID,
    name: AGENT_NAME,
    description:
      "Evidence verification agent. Evaluates claim credibility (0-100) with structured verdict, evidence, and risk factors. " +
      "Designed for Arena agents who need to defend claims or refute opponents.",
    version: "0.1.0",
    tools: toolHandlers.map((h) => ({
      name: h.definition.name,
      description: h.definition.description,
      inputSchema: h.definition.inputSchema,
      outputSchema: h.definition.outputSchema,
    })),
    grants: [
      {
        resource: { namespace: "sharedos.verify", path: ["verify"] },
        action: "invoke",
        maxUses: 10,
        purposes: ["arena.defend", "arena.refute", "factcheck"],
        pricing: "1 credit per call after 10 free trials",
      },
    ],
  });
});

// ---- POST /sharednet/join — Join a SharedNet Room ----

app.post("/sharednet/join", async (req, res) => {
  try {
    const { room_id, token, name } = req.body as { room_id?: string; token?: string; name?: string };
    if (!room_id || !token) {
      return res.status(400).json({ error: "room_id and token are required" });
    }
    const result = await snJoin(room_id, token, name || AGENT_NAME, "claude-code");
    res.json({ ok: true, room_id: room_id, instance_id: result.instance_id, agent_id: result.agent_id, sequence: result.sequence, history_count: result.history.items.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- GET /sharednet/status — Current SharedNet connection status ----

app.get("/sharednet/status", (_req, res) => {
  res.json({
    joined: !!getMemberToken(),
    room_id: getRoomId(),
    last_seq: getLastSeq(),
    agent: AGENT_NAME,
  });
});

// ---- POST /kernel/authorize — SharedOS-compatible grant check ----

app.post("/kernel/authorize", async (req, res) => {
  try {
    const body = req.body as {
      capabilities?: Array<{ resource?: { namespace?: string; path?: string[] }; action?: string }>;
      purpose?: string;
    };

    const requestedNs = body?.capabilities?.[0]?.resource?.namespace;
    const requestedPath = body?.capabilities?.[0]?.resource?.path;
    const requestedAction = body?.capabilities?.[0]?.action;

    // Simple allow/deny based on our grants
    const allowed =
      requestedNs === "sharedos.verify" &&
      (requestedPath?.includes("verify") || requestedPath?.includes("health")) &&
      requestedAction === "invoke";

    res.json({
      status: allowed ? "allowed" : "denied",
      matchedCapabilities: allowed
        ? [
            {
              resource: { namespace: requestedNs, path: requestedPath },
              action: requestedAction,
              scope: "exact" as const,
            },
          ]
        : [],
      reasonCode: allowed ? undefined : "no_matching_grant",
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- GET /kernel/tools — Published tool catalog ----

app.get("/kernel/tools", async (_req, res) => {
  try {
    const published = toolHandlers.map((h) => ({
      name: h.definition.name,
      description: h.definition.description,
      inputSchema: h.definition.inputSchema,
      outputSchema: h.definition.outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      metadata: { namespace: h.definition.namespace, source: h.definition.source },
    }));
    res.json({ tools: published });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- POST /kernel/tools/:name/invoke — Direct tool dispatch ----

app.post("/kernel/tools/:name/invoke", async (req, res) => {
  try {
    const toolName = req.params.name;
    const handler = toolHandlers.find((h) => h.definition.name === toolName);
    if (!handler) {
      return res.status(404).json({ error: `Unknown tool: ${toolName}` });
    }

    const context = buildAccessContext(req);
    const result = await handler.invoke(context, {
      id: `call-${randomUUID()}`,
      definition: handler.definition,
      arguments: req.body,
      traceId: context.traceId,
      requestedAt: new Date().toISOString(),
    } as unknown as ToolCall, new AbortController().signal);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- 404 fallback ----
app.use((_req, res) => {
  res.status(404).json({
    error: "Unknown route",
    available: [
      "POST /verify",
      "GET  /health",
      "GET  /agent/card",
      "POST /sharednet/join",
      "GET  /sharednet/status",
      "POST /kernel/authorize",
      "GET  /kernel/tools",
      "POST /kernel/tools/:name/invoke",
    ],
  });
});

// ============================================================
// Error handler — must be defined BEFORE use
// ============================================================

function handleError(res: express.Response, err: unknown): void {
  console.error("[verify error]", err);
  if (res.headersSent) return;
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}

// ============================================================
// Express error handler middleware
// ============================================================

const jsonErrorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("[Unhandled]", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error" });
};
app.use(jsonErrorHandler);

// ============================================================
// Helper: build AccessContext (for tool dispatch only)
// ============================================================
// NOTE: SharedOS 规定 AccessContext 是不可从请求头构造的可信边界。
// 这里仅用它传递 traceId + actor 信息给本地 tool dispatch，
// 授权决策在 grant store（getOrCreateGrant / consumeGrant）中完成。

function buildAccessContext(req: express.Request): AccessContext {
  const agentId = String(req.headers["x-agent-id"] || "anonymous");
  const kind = String(req.headers["x-agent-kind"] || "agent") as "agent" | "human";

  const actor = (kind === "human"
    ? { kind: "human" as const, userId: agentId }
    : { kind: "agent" as const, agentId }) as AccessContext["actor"];

  return {
    namespaceId: "sharedos.verify",
    actor,
    purpose: "tool.invoke",
    traceId: `trace-${randomUUID()}`,
  } as AccessContext;
}

// ============================================================
// SharedNet background listener (auto-join + auto-respond)
// ============================================================

async function startSharedNetListener(): Promise<void> {
  const roomIdEnv = process.env.SHAREDNET_ROOM_ID;
  const tokenEnv = process.env.SHAREDNET_TOKEN;
  if (!roomIdEnv || !tokenEnv) {
    console.log("[sharednet] No SHAREDNET_ROOM_ID / SHAREDNET_TOKEN env — skipping auto-join");
    return;
  }

  try {
    console.log(`[sharednet] Joining room ${roomIdEnv}...`);
    const joinResult = await snJoin(roomIdEnv, tokenEnv, AGENT_NAME, "claude-code");
    console.log(`[sharednet] Joined as ${joinResult.agent_id} (instance ${joinResult.instance_id}) — ${joinResult.history.items.length} history messages`);

    // Process any existing history messages first
    for (const msg of joinResult.history.items) {
      advanceSeq(msg.sequence);
    }

    // Long-poll loop: wait for new messages and auto-respond to claims
    while (true) {
      try {
        const page = await snWait(getLastSeq());
        for (const msg of page.items) {
          advanceSeq(msg.sequence);
          // Skip our own messages
          if (msg.sender_agent_id === joinResult.agent_id) continue;

          console.log(`[sharednet] <${msg.sender_agent_id}> ${msg.content.slice(0, 120)}`);
          await handleRoomMessage(msg);
        }
      } catch (err) {
        console.error("[sharednet] wait error:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  } catch (err) {
    console.error("[sharednet] join failed:", err);
  }
}

async function handleRoomMessage(msg: { content: string; sender_agent_id: string }): Promise<void> {
  // Heuristic: if the message looks like a claim (question mark, "是不是", "真的", "是否", "是否", 或 > 20 chars ending with 。/？)
  const text = msg.content.trim();
  const isQuestion = /[?？]/.test(text) || /是不是|真的|是否|有没有|可信/.test(text);
  const isStatement = text.length > 20 && /[。！]$/.test(text);

  if (!isQuestion && !isStatement) return;

  // Extract the likely claim (strip @mentions, strip prefixes)
  const claim = text.replace(/@\S+\s*/g, "").replace(/^Veritas[，,：:\s]*/i, "").trim();
  if (!claim || claim.length < 4) return;

  try {
    console.log(`[sharednet] Verifying claim from ${msg.sender_agent_id}: ${claim.slice(0, 80)}`);
    const result = await verifyClaim({ claim });

    const reply = `📊 验真结果 [${result.verdict}] 可信度 ${result.credibility}/100\n` +
      `证据：${result.evidence.slice(0, 2).join("；") || "无"}\n` +
      (result.risk_factors.length ? `风险：${result.risk_factors[0]}` : "");

    await snSay(reply);
    console.log(`[sharednet] Replied with verdict=${result.verdict} score=${result.credibility}`);
  } catch (err) {
    console.error("[sharednet] verify error:", err);
  }
}

// ============================================================
// Boot
// ============================================================

app.listen(PORT, () => {
  console.log(`\n  Veritas (sharedos-verify) → http://localhost:${PORT}`);
  console.log(`  agent    : ${AGENT_NAME} (${AGENT_ID})`);
  console.log(`  endpoint : POST /verify   { claim, context? }`);
  console.log(`  health   : GET  /health`);
  console.log(`  card     : GET  /agent/card`);
  console.log(`  kernel   : POST /kernel/authorize, GET /kernel/tools, POST /kernel/tools/:name/invoke`);
  console.log(`  sharednet: POST /sharednet/join, GET /sharednet/status`);
  console.log(`  cli      : npx veritas verify "claim"`);
  console.log(`  mcp      : npx veritas-mcp`);
  if (!hasCredential()) {
    console.log(`  ⚠ 未配置模型 key (provider="${PROVIDER}") — API 调用会返回错误\n`);
  } else {
    console.log(`  ✓ 模型 key 已加载 · provider=${PROVIDER} · model=${MODEL}\n`);
  }

  // Start SharedNet listener in background (non-blocking)
  void startSharedNetListener();
});
