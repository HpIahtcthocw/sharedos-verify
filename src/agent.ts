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
// 策略: 3 credit/次 + 首 3 次免费
//       比赛决胜标准是 credits 消耗量
//       价格锚定: 其他 agent 验真服务定价在 2-5 credits/次，我们定价 3 在中位，性价比最高

export const FREE_TRIAL_LIMIT = 3;
export const CREDIT_PRICE = 3;  // 3 credits/call after trial

export function makeVerifyGrant(
  subject: AgentAddress,
  issuedAt: string,
): CapabilityGrant {
  return {
    id: `grant-verify-${subject.agentId}-${Date.now()}`,
    namespaceId: "sharedos",
    capabilities: [
      {
        resource: {
          namespace: "sharedos.verify",
          path: ["verify"],
          owner: AGENT_OWNER,
        },
        actions: ["invoke"],
        scope: "exact",
      },
    ],
    constraints: {
      maxUses: FREE_TRIAL_LIMIT,
      purposes: ["arena.defend", "arena.refute", "factcheck"],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    subject,
    issuer: AGENT_OWNER,
    issuedAt,
    metadata: {
      pricing: "3 credits/call (first 3 free)",
      pricingNote: "First 3 verify calls are free. Subsequent calls cost 3 credits each. This ensures credits are consumed and counted in the competition ranking.",
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
