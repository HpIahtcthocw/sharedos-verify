/**
 * Agent Veritas — persona & SharedOS identity
 *
 * SharedOS SDK 要求:
 *   - 一个 agent 有 agentId (kind: "agent")
 *   - 有 name, description 等身份信息
 *   - 通过 capability grant 声明可被谁调用
 *
 * 本模块只定义静态身份和默认 grant，不依赖任何外部服务。
 */

import { type AgentAddress, type CapabilityGrant } from "@aicoo/sharedos-contracts";

// ============================================================
// Agent Identity
// ============================================================

export const AGENT_ID = "veritas";
export const AGENT_NAME = "Veritas";
export const AGENT_DESCRIPTION =
  "An evidence verification agent that evaluates the credibility of claims " +
  "and returns structured verdicts with supporting evidence and risk factors. " +
  "Use me when you need to fact-check an assertion before defending it in an argument.";

export const AGENT_VERSION = "0.1.0";

// Agent card owner = agent itself
export const AGENT_OWNER: AgentAddress = {
  kind: "agent",
  agentId: AGENT_ID,
};

// ============================================================
// Grants — who can call what
// ============================================================
//
// 定价阶梯 (对齐 Arena 房间行情: ground.check 1cr / Yuzu assay 3cr):
//   veritas.verify  3 credits — 完整验真 (评分+判定+证据+风险)
//   veritas.defend  5 credits — 验真 + 反驳稿 (辩论刚需, 全场独一份)
//   免费试用: 每 caller 3 次 (内核 usage store 强制)

export const FREE_TRIAL_LIMIT = 3;
export const CREDIT_PRICE = 3;       // veritas.verify
export const DEFEND_PRICE = 5;       // veritas.defend
export const CROSS_PRICE = 2;        // veritas.cross (质询/拱火, 低价冲动档)

const VERIFY_CAPABILITIES = [
  {
    resource: {
      namespace: "sharedos.verify",
      path: ["verify"],
      owner: AGENT_OWNER,
    },
    actions: ["invoke"],
    scope: "exact" as const,
  },
  {
    resource: {
      namespace: "sharedos.verify",
      path: ["defend"],
      owner: AGENT_OWNER,
    },
    actions: ["invoke"],
    scope: "exact" as const,
  },
  {
    resource: {
      namespace: "sharedos.verify",
      path: ["cross"],
      owner: AGENT_OWNER,
    },
    actions: ["invoke"],
    scope: "exact" as const,
  },
];

function baseConstraints(extra: Record<string, unknown> = {}) {
  return {
    purposes: ["arena.defend", "arena.refute", "factcheck"],
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...extra,
  };
}

// 体验 grant: maxUses 由内核 usage store 强制执行, 用完自动落到付费 grant
export function makeVerifyGrant(
  subject: AgentAddress,
  issuedAt: string,
): CapabilityGrant {
  return {
    id: `grant-verify-${subject.agentId}-${Date.now()}`,
    namespaceId: "sharedos",
    capabilities: VERIFY_CAPABILITIES,
    constraints: baseConstraints({ maxUses: FREE_TRIAL_LIMIT }),
    subject,
    issuer: AGENT_OWNER,
    issuedAt,
    metadata: {
      pricing: "free trial",
      pricingNote: `First ${FREE_TRIAL_LIMIT} calls (verify or defend) are free. Subsequent calls are billed via the paid grant (verify ${CREDIT_PRICE}cr / defend ${DEFEND_PRICE}cr).`,
    },
  };
}

// 付费 grant: 无 maxUses — 内核 authorize 命中它即代表该次调用应计费,
// matchedGrantId 就是计费依据 (audit ledger)
export function makePaidVerifyGrant(
  subject: AgentAddress,
  issuedAt: string,
): CapabilityGrant {
  return {
    id: `grant-verify-paid-${subject.agentId}-${Date.now()}`,
    namespaceId: "sharedos",
    capabilities: VERIFY_CAPABILITIES,
    constraints: baseConstraints(),
    subject,
    issuer: AGENT_OWNER,
    issuedAt,
    metadata: {
      pricing: `verify ${CREDIT_PRICE} credits/call, defend ${DEFEND_PRICE} credits/call`,
      pricingNote: "Billed via SharedNet settlement. Every billed call has a kernel audit record (matchedGrantId = this grant).",
    },
  };
}

export function makeDirectoryGrant(
  reader: AgentAddress,
  issuedAt: string,
): CapabilityGrant {
  return {
    id: `grant-dir-${reader.agentId}-${Date.now()}`,
    namespaceId: "sharedos",
    capabilities: [
      {
        resource: {
          namespace: "sharedos",
          path: ["directory", AGENT_ID],
        },
        actions: ["read"],
        scope: "exact",
      },
    ],
    constraints: {
      purposes: ["discovery"],
    },
    subject: reader,
    issuer: AGENT_OWNER,
    issuedAt,
  };
}
