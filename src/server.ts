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

// ---- SharedOS SDK — 真内核 (SharedOSKernel 在 Node 22 下经伞形包导入验证可用) ----
import {
  AgentAddress,
  CapabilityGrant,
  ToolDefinition,
  ToolCall,
  type ToolResult as SdkToolResult,
  type JsonValue,
  type JsonObject,
  AccessContext,
  type AuditEvent,
  type AuditSink,
  type ToolHandler,
  SharedOSKernel,
  CapabilityAuthorizer,
  InMemoryGrantUsageStore,
} from "@aicoo/sharedos";

// ---- Local modules ----
import { AGENT_ID, AGENT_NAME, AGENT_OWNER, makeVerifyGrant, makePaidVerifyGrant, makeDirectoryGrant, FREE_TRIAL_LIMIT, CREDIT_PRICE } from "./agent.js";
import { createAuditRecord, writeAudit, writeKernelEvent, type AuditRecord } from "./audit.js";
import { join as snJoin, say as snSay, wait as snWait, read as snRead, getLastSeq, advanceSeq, getRoomId, getMemberToken } from "./sharednet.js";

// Our local ToolResult union — 字段与 SDK ToolResult schema 对齐 (output 为 JSON 值)
type OurToolResult =
  | { status: "succeeded"; tool: string; callId: string; completedAt: string; output: JsonValue; metadata?: JsonObject }
  | { status: "denied"; tool: string; callId: string; completedAt: string; error: { code: string; message: string }; metadata?: JsonObject }
  | { status: "failed"; tool: string; callId: string; completedAt: string; error: { code: string; message: string; retryable?: boolean; details?: JsonObject }; metadata?: JsonObject };

// ============================================================
// Provider config
// ============================================================
//
// 默认: DeepSeek via SiliconFlow (国内平台，免费额度充足)
// 备选: Qwen via DashScope (阿里云，需充值)
// 环境变量覆盖: PROVIDER / DEEPSEEK_API_KEY / DASHSCOPE_API_KEY 等

function deepseekConfig(): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.SILICONFLOW_API_KEY || "",
    baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/+$/, ""),
    model: process.env.DEEPSEEK_MODEL || "deepseek-ai/DeepSeek-V2.5",
  };
}

function qwenConfig(): { apiKey: string; baseUrl: string; model: string } {
  return {
    apiKey: process.env.DASHSCOPE_API_KEY || process.env.MASK_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl: (process.env.MASK_BASE_URL || process.env.OPENAI_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, ""),
    model: process.env.MASK_MODEL || process.env.OPENAI_MODEL || "qwen-plus",
  };
}

const PROVIDER = process.env.PROVIDER || "deepseek";
const PORT = Number(process.env.PORT) || 4000;

function providerConfig(): { apiKey: string; baseUrl: string; model: string; provider: string } {
  if (PROVIDER === "qwen") {
    const c = qwenConfig();
    return { ...c, provider: "qwen" };
  }
  const c = deepseekConfig();
  return { ...c, provider: "deepseek" };
}

const { apiKey: API_KEY, baseUrl: BASE_URL, model: MODEL } = providerConfig();

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
  if (!API_KEY) throw new Error(`No ${PROVIDER} API key configured — set ${PROVIDER.toUpperCase()}_API_KEY env var`);

  // DeepSeek / Qwen / OpenAI-compatible path
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
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
// 模型按系统提示词直接输出中文 verdict; 英文键做兼容映射
const VALID_VERDICTS = new Set(["可信", "存疑", "不可信", "无法判定"]);

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
  const rawVerdict = String(pick(raw, "verdict") ?? "无法判定").trim();
  const verdict =
    rawVerdict in VERDICT_MAP
      ? VERDICT_MAP[rawVerdict]
      : VALID_VERDICTS.has(rawVerdict)
        ? rawVerdict
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
  trial: CapabilityGrant;   // maxUses = FREE_TRIAL_LIMIT, 内核 usage store 强制
  paid: CapabilityGrant;    // 无 maxUses, 命中即计费
  remainingUses: number;    // /verify 直连路径的本地配额簿记
  totalUsed: number;
}

const grantStore = new Map<string, GrantEntry>();

// ---- IP-based rate limiting ----
// Prevents grant abuse: same IP can't create unlimited fake agent IDs
// to exhaust free trial quota.
function ipHash(req: express.Request): string {
  const ip = (req.headers["x-forwarded-for"] as string) || req.socket?.remoteAddress || "unknown";
  // Simple hash (not cryptographic — just enough to group same IPs)
  let h = 0;
  for (let i = 0; i < ip.length; i++) {
    h = ((h << 5) - h + ip.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function grantKey(callerId: string, ip: string): string {
  // Key = callerId + IP hash — same agent from same IP = same grant
  // Different agents from same IP get different grants (limited by IP below)
  return `${PROVIDER}:${callerId}:${ip}`;
}

// Track IP addresses to limit total grants per IP
const ipGrantCount = new Map<string, number>();
const MAX_GRANTS_PER_IP = 5;

function getOrCreateGrant(callerId: string, ip: string, issuedAt?: string): { grants: CapabilityGrant[]; remainingUses: number; isNew: boolean } | null {
  const key = grantKey(callerId, ip);

  // Check IP limit first
  const ipCount = ipGrantCount.get(ip) || 0;
  if (ipCount >= MAX_GRANTS_PER_IP && !grantStore.has(key)) {
    return null; // IP has exhausted grant creation limit
  }

  const existing = grantStore.get(key);
  if (existing) {
    return { grants: [existing.trial, existing.paid], remainingUses: existing.remainingUses, isNew: false };
  }

  // New grant — check IP limit
  const newIpCount = ipGrantCount.get(ip) || 0;
  if (newIpCount >= MAX_GRANTS_PER_IP) {
    return null;
  }
  ipGrantCount.set(ip, newIpCount + 1);

  // Create trial grant (maxUses enforced by kernel usage store) + paid grant.
  // issuedAt 必须用请求上下文的 now (而非当前时钟): 内核校验 issuedAt <= context.now,
  // 而 grant 恰好在本请求的 load 阶段铸造, 用当前时钟会晚于已冻结的 context.now,
  // 导致首个请求被误判 no_matching_grant。
  const mintedAt = issuedAt ?? new Date().toISOString();
  const subject: AgentAddress = { kind: "agent", agentId: callerId };
  grantStore.set(key, {
    trial: makeVerifyGrant(subject, mintedAt),
    paid: makePaidVerifyGrant(subject, mintedAt),
    remainingUses: FREE_TRIAL_LIMIT,
    totalUsed: 0,
  });
  const entry = grantStore.get(key)!;
  return { grants: [entry.trial, entry.paid], remainingUses: FREE_TRIAL_LIMIT, isNew: true };
}

function consumeGrant(callerId: string, ip: string): { ok: boolean; remainingUses: number; isFree: boolean } {
  const key = grantKey(callerId, ip);
  const entry = grantStore.get(key);
  if (!entry) return { ok: false, remainingUses: 0, isFree: false };
  if (entry.remainingUses > 0) {
    entry.remainingUses -= 1;
    entry.totalUsed += 1;
    return { ok: true, remainingUses: entry.remainingUses, isFree: true };
  }
  // Paid call (in production: check credit balance with SharedOS ledger)
  entry.totalUsed += 1;
  return { ok: true, remainingUses: 0, isFree: false };
}

function getGrantStatus(callerId: string, ip: string): { remainingUses: number; totalUsed: number; isExpired: boolean } | null {
  const key = grantKey(callerId, ip);
  const entry = grantStore.get(key);
  if (!entry) return null;
  return {
    remainingUses: entry.remainingUses,
    totalUsed: entry.totalUsed,
    isExpired: entry.trial.constraints.expiresAt ? new Date(entry.trial.constraints.expiresAt) < new Date() : false,
  };
}

// ---- KernelAuditBridge — 内核审计事件 → JSONL 落盘 (组织者核查的文件) ----
// 事件保持 SDK AuditEvent 的原始 canonical 形状 (version/type/outcome/actor/
// authority/owner/purpose/grantId/authorityHash/metadata), 不做降级映射。
class KernelAuditBridge {
  async record(event: AuditEvent): Promise<void> {
    writeKernelEvent(event);
  }
}

// ---- GrantSource — SDK 接口形状: load(context, signal) → grants ----
// 返回 [体验grant, 付费grant]: 内核先尝试体验 grant (maxUses 由 usage store
// 强制), 耗尽后自动落到付费 grant — matchedGrantId 即计费依据。
const veritasGrantSource = {
  async load(ctx: AccessContext, _signal: AbortSignal): Promise<CapabilityGrant[]> {
    const actor = ctx.actor as { kind: string; agentId?: string; userId?: string; serviceId?: string };
    let callerId: string;
    if (actor.kind === "agent" && actor.agentId) {
      callerId = actor.agentId;
    } else if (actor.kind === "human" && actor.userId) {
      callerId = actor.userId;
    } else if (actor.kind === "service" && actor.serviceId) {
      callerId = actor.serviceId;
    } else {
      return []; // 未知身份 → 无 grant → 内核默认拒绝
    }
    const entry = getOrCreateGrant(callerId, "kernel", ctx.now);
    if (!entry) return [];
    return entry.grants;
  },
};

// ---- PolicySource: 故意不装 ----
// 上个版本返回 { allowAll: true } — 与 "默认拒绝" 理念相反, 已删除。
// 无 policySource 时授权完全由 grant 能力集决定: grant 未覆盖的一律拒绝。

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
      output: result as unknown as JsonValue,
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
      hasKey: Boolean(API_KEY),
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
// SharedOS Kernel — 真内核集成
// ============================================================
//
// 比赛硬性要求: "Built on SharedOS" = agent 的调用在 SharedOSKernel 上
// 完成 authorize → invoke → audit 闭环, 组织者核查内核审计记录。
//
//   - /kernel/authorize   → kernel.authorize()   (真实授权决策)
//   - /kernel/tools       → kernel.listTools()   (能力发现, 看不见即不可用)
//   - /kernel/tools/:name/invoke → kernel.invokeTool() (授权内联执行)
//   - 内核审计事件原样落盘 kernel-audit-*.jsonl (canonical AuditEvent 形状)
//
// 免费额度与计费: 体验 grant (maxUses=3) 由内核 usage store 强制,
// 耗尽后授权自动落到付费 grant, matchedGrantId 就是计费依据。

let kernel: SharedOSKernel | undefined;
try {
  kernel = new SharedOSKernel({
    grantSource: veritasGrantSource,
    authorizer: new CapabilityAuthorizer({ usageStore: new InMemoryGrantUsageStore() }),
    audit: new KernelAuditBridge(),
  });
  kernel.registerTool(asKernelTool(VERIFY_TOOL_DEF, handleVerify));
  kernel.registerTool(asKernelTool(HEALTH_TOOL_DEF, handleHealth));
  console.log("[kernel] SharedOSKernel active — tools: veritas.verify, veritas.health");
} catch (err) {
  // 大声失败: 内核不可用时 /kernel/* 返回 503, /verify 直连仍可用
  console.error("[kernel] SharedOSKernel init FAILED — /kernel/* will 503:", err);
}

// 把本地 handler 适配成 SDK ToolHandler (definition + parseArguments + invoke)
function asKernelTool(
  definition: ToolDefinition,
  handler: (ctx: AccessContext, call: ToolCall, signal: AbortSignal) => Promise<SdkToolResult>,
): ToolHandler {
  return {
    definition,
    parseArguments: (raw) => (raw && typeof raw === "object" ? raw : {}),
    invoke: (ctx, call, signal) => handler(ctx, call, signal),
  };
}

export function getKernel(): SharedOSKernel | undefined {
  return kernel;
}

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
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Agent-Id, X-Agent-Kind, X-Owner-Id, X-Purpose");
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
    const callerIp = ipHash(req);

    // Grant check (skip for non-agent callers like browsers)
    let grantInfo: { remainingUses: number; totalUsed: number } | undefined;
    if (callerAgentId && callerKind === "agent") {
      const existing = getGrantStatus(callerAgentId, callerIp);
      if (existing?.isExpired) {
        return res.status(402).json({ error: "Grant expired", message: "Contact Veritas for a new grant" });
      }
      const consume = consumeGrant(callerAgentId, callerIp);
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
      const fresh = getGrantStatus(callerAgentId, callerIp);
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

    res.json({
      ...result,
      grant: grantInfo ? { ...grantInfo, creditPrice: CREDIT_PRICE, freeTrialLimit: FREE_TRIAL_LIMIT } : undefined,
    });
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
    hasKey: Boolean(API_KEY),
    provider: PROVIDER,
    model: MODEL,
    endpoint: "/verify",
    kernel: kernel ? "active" : "unavailable",
    pricing: `${CREDIT_PRICE} credit/call, first ${FREE_TRIAL_LIMIT} free`,
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
        maxUses: FREE_TRIAL_LIMIT,
        purposes: ["arena.defend", "arena.refute", "factcheck"],
        pricing: `${CREDIT_PRICE} credits per call after ${FREE_TRIAL_LIMIT} free trial calls`,
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

// ---- POST /kernel/authorize — 真内核授权决策 ----
// 请求体: { resource: { namespace, path?, owner? }, action }
//     或 SharedOS 客户端形状: { capabilities: [{ resource, action }] }
// purpose 经 X-Purpose 头传入 (缺省 factcheck), 必须命中 grant constraints.purposes

app.post("/kernel/authorize", async (req, res) => {
  try {
    if (!kernel) return res.status(503).json({ error: "SharedOS kernel unavailable" });
    const body = req.body as {
      resource?: { namespace?: string; path?: string[] | string };
      action?: string;
      capabilities?: Array<{ resource?: { namespace?: string; path?: string[] | string }; action?: string }>;
    };
    const cap = body.capabilities?.[0] ?? body;
    const ns = cap?.resource?.namespace;
    const action = cap?.action;
    if (!ns || !action) {
      return res.status(400).json({ error: "resource.namespace and action are required" });
    }
    const rawPath = cap?.resource?.path;
    const path = Array.isArray(rawPath) ? rawPath : rawPath ? [rawPath] : [];

    const context = buildAccessContext(req);
    const decision = await kernel.authorize(context, {
      resource: { namespace: ns, path, owner: AGENT_OWNER },
      action,
    });
    // 兼容字段: status (allowed/denied); 内核 canonical 字段原样保留
    res.json({ ...decision, status: decision.allowed ? "allowed" : "denied" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- GET /kernel/tools — 内核能力目录 (看不见即不可用) ----

app.get("/kernel/tools", async (req, res) => {
  try {
    if (!kernel) return res.status(503).json({ error: "SharedOS kernel unavailable" });
    const tools = await kernel.listTools(buildAccessContext(req));
    res.json({ tools });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- POST /kernel/tools/:name/invoke — 内核授权内联执行 ----
// 授权、用量扣减 (maxUses)、审计全部由内核完成; 未授权时返回 status:"denied" ToolResult

app.post("/kernel/tools/:name/invoke", async (req, res) => {
  try {
    if (!kernel) return res.status(503).json({ error: "SharedOS kernel unavailable" });
    const context = buildAccessContext(req);
    const call: ToolCall = {
      id: `call-${randomUUID()}`,
      tool: req.params.name,
      arguments: JSON.parse(JSON.stringify(req.body ?? {})) as JsonObject,
      traceId: context.traceId,
      requestedAt: new Date().toISOString(),
    };
    const result = await kernel.invokeTool(context, call);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- GET /kernel/usage — 计费台账摘要 ----
// matchedGrantId 以 grant-verify-paid- 开头 = 计费调用; grant-verify- = 免费体验

app.get("/kernel/usage", (_req, res) => {
  const callers = [...grantStore.entries()].map(([key, e]) => ({
    caller: key,
    trialGrantId: e.trial.id,
    paidGrantId: e.paid.id,
    remainingFreeUses: e.remainingUses,
    totalCalls: e.totalUsed,
    trialExpiresAt: e.trial.constraints.expiresAt,
  }));
  res.json({
    pricing: `${CREDIT_PRICE} credit/call, first ${FREE_TRIAL_LIMIT} free`,
    callerCount: callers.length,
    callers,
    note: "Authoritative per-call ledger = kernel-audit-*.jsonl (matchedGrantId per invocation)",
  });
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
      "GET  /kernel/usage",
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
// Helper: build AccessContext (内核可信边界, 由本服务作为 host 构造)
// ============================================================
// SharedOS 规定 AccessContext 是 host 创建的可信输入, 不能伪造请求体字段。
// 本服务是唯一 host: 从已验证的 HTTP 头解析 caller 身份, authority/owner
// 固定为本 agent (资源所有者), purpose 缺省 factcheck。
// 内核据此加载 grant (subject=actor) 并做出默认拒绝的授权决策。

function buildAccessContext(req: express.Request): AccessContext {
  const agentId = String(req.headers["x-agent-id"] || "anonymous");
  const kind = String(req.headers["x-agent-kind"] || "agent");
  const purpose = String(req.headers["x-purpose"] || "factcheck");

  const actor: AccessContext["actor"] =
    kind === "human"
      ? { kind: "human", userId: agentId }
      : kind === "service"
        ? { kind: "service", serviceId: agentId }
        : { kind: "agent", agentId };

  return {
    namespaceId: "sharedos",
    actor,
    authority: AGENT_OWNER,
    owner: AGENT_OWNER,
    purpose,
    now: new Date().toISOString(),
    traceId: `trace-${randomUUID()}`,
    enabledToolNamespaces: ["veritas"],
  };
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

// Veritas 自身的调用也走内核 — 自调用同样产生 authorize/invoke 审计记录,
// 即 "自有 loop 在内核内跑 turn" 的形态; 内核不可用时回退直连。
async function selfVerify(claim: string, context?: string): Promise<VerifyResult> {
  if (kernel) {
    const selfCtx: AccessContext = {
      namespaceId: "sharedos",
      actor: AGENT_OWNER,
      authority: AGENT_OWNER,
      owner: AGENT_OWNER,
      purpose: "factcheck",
      now: new Date().toISOString(),
      traceId: `trace-${randomUUID()}`,
      enabledToolNamespaces: ["veritas"],
    };
    const result = await kernel.invokeTool(selfCtx, {
      id: `call-${randomUUID()}`,
      tool: "veritas.verify",
      arguments: { claim, ...(context ? { context } : {}) },
      traceId: selfCtx.traceId,
      requestedAt: selfCtx.now,
    });
    if (result.status === "succeeded") {
      return result.output as unknown as VerifyResult;
    }
    throw new Error(`kernel refused self-verify: ${result.error.code}`);
  }
  return verifyClaim({ claim, context });
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
    const result = await selfVerify(claim);

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
  console.log(`  kernel   : ${kernel ? "ACTIVE" : "UNAVAILABLE"} — POST /kernel/authorize, GET /kernel/tools, POST /kernel/tools/:name/invoke, GET /kernel/usage`);
  console.log(`  sharednet: POST /sharednet/join, GET /sharednet/status`);
  console.log(`  cli      : npx veritas verify "claim"`);
  console.log(`  mcp      : npx veritas-mcp`);
  if (!API_KEY) {
    console.log(`  ⚠ 未配置模型 key (provider="${PROVIDER}") — API 调用会返回错误\n`);
  } else {
    console.log(`  ✓ 模型 key 已加载 · provider=${PROVIDER} · model=${MODEL}\n`);
  }

  // Start SharedNet listener in background (non-blocking)
  void startSharedNetListener();
});
