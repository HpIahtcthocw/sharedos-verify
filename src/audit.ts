/**
 * Audit log — 每次 verify 调用的不可变记录
 *
 * 设计原则:
 *   - 无外部依赖（不接数据库、不接 Discord webhook 作为硬依赖）
 *   - 文件追加写 (JSONL)，进程崩溃不丢已刷盘的数据
 *   - 可选 webhook: 如果环境变量有 DISCORD_AUDIT_WEBHOOK，异步发一条
 */

import fs from "node:fs";
import path from "node:path";

export interface AuditRecord {
  id: string;
  timestamp: string;
  caller: { kind: string; id: string } | null;
  claim: string;
  claimHash: string;
  verdict: string;
  credibility: number;
  evidenceCount: number;
  riskFactorsCount: number;
  durationMs: number;
  modelProvider: string;
  modelName: string;
  error?: string;
}

const AUDIT_DIR =
  process.env.AUDIT_DIR || path.resolve(process.cwd(), "audit");
const AUDIT_FILE = path.join(AUDIT_DIR, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
// 内核 canonical 审计事件单独落盘 — 组织者核查 "Built on SharedOS" 看这个文件
const KERNEL_AUDIT_FILE = path.join(AUDIT_DIR, `kernel-audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
const DISCORD_WEBHOOK = process.env.DISCORD_AUDIT_WEBHOOK || "";

let fileReady = false;

function ensureFile(): void {
  if (fileReady) return;
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  } catch {
    // ignore
  }
  fileReady = true;
}

function sha256Hex(input: string): string {
  // 轻量 hash，不引入 crypto 之外的依赖
  // 用简单的 FNV-1a 做 claim fingerprint（非密码学用途）
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h.toString(16).padStart(8, "0");
}

export function createAuditRecord(input: {
  caller: { kind: string; id: string } | null;
  claim: string;
  verdict: string;
  credibility: number;
  evidenceCount: number;
  riskFactorsCount: number;
  durationMs: number;
  modelProvider: string;
  modelName: string;
  error?: string;
}): AuditRecord {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...input,
    claimHash: sha256Hex(input.claim),
  };
}

export function writeAudit(record: AuditRecord): void {
  ensureFile();
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // 磁盘写失败不影响主流程
  }
  // 可选：异步发 Discord
  if (DISCORD_WEBHOOK) {
    void sendDiscord(record);
  }
}

/**
 * 内核 AuditEvent 原样落盘 (canonical SharedOS 审计形状)。
 * 每条记录带 version/type/outcome/actor/authority/owner/purpose/
 * grantId/authorityHash — 供组织者与 SharedOS 工具直接解析。
 * 拒绝事件额外镜像到 Discord, 便于实时观察滥用。
 */
export function writeKernelEvent(event: unknown): void {
  ensureFile();
  try {
    fs.appendFileSync(KERNEL_AUDIT_FILE, JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // 磁盘写失败不影响主流程
  }
  const e = event as {
    type?: string; outcome?: string; tool?: string; reason?: string;
    actor?: { kind?: string; agentId?: string; userId?: string; serviceId?: string };
    purpose?: string;
  };
  if (DISCORD_WEBHOOK && e.outcome === "denied") {
    void sendKernelDenial(e);
  }
}

async function sendKernelDenial(e: {
  type?: string; tool?: string; reason?: string;
  actor?: { kind?: string; agentId?: string; userId?: string };
  purpose?: string;
}): Promise<void> {
  try {
    const who = e.actor?.agentId ?? e.actor?.userId ?? e.actor?.kind ?? "unknown";
    const content = `🚫 Veritas kernel DENIED — ${e.type ?? "unknown"} ${e.tool ?? ""} actor=${who} purpose=${e.purpose ?? "-"} reason=${e.reason ?? "-"}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 静默
  }
}

async function sendDiscord(record: AuditRecord): Promise<void> {
  try {
    const color = record.error ? 0xff4444 : record.credibility >= 80 ? 0x44ff44 : record.credibility >= 60 ? 0xffaa44 : 0xff6644;
    const body = {
      embeds: [
        {
          title: `🔍 Veritas Verify — ${record.verdict}`,
          description: record.claim.length > 200 ? record.claim.slice(0, 200) + "…" : record.claim,
          color,
          fields: [
            { name: "Credibility", value: String(record.credibility), inline: true },
            { name: "Evidence", value: String(record.evidenceCount), inline: true },
            { name: "Risk factors", value: String(record.riskFactorsCount), inline: true },
            { name: "Caller", value: record.caller ? `${record.caller.kind}:${record.caller.id}` : "anonymous", inline: true },
            { name: "Model", value: `${record.modelProvider}/${record.modelName}`, inline: true },
            { name: "Duration", value: `${record.durationMs}ms`, inline: true },
          ],
          footer: { text: `Veritas · ${record.id}` },
          timestamp: record.timestamp,
        },
      ],
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Discord webhook 失败静默吞掉
  }
}
