#!/usr/bin/env node
/**
 * veritas-cli — 本地命令行调用 verify
 *
 * 使用:
 *   npx veritas verify "火星上有液态水"
 *   npx veritas verify "AI将取代所有程序员" --context "根据2025年统计..."
 *   npx veritas health
 *
 * 依赖: 本服务必须已在本机跑在 VERITAS_URL (默认 http://localhost:4000)
 */

import { spawn } from "node:child_process";

const VERITAS_URL = process.env.VERITAS_URL || "http://localhost:4000";

async function postVerify(claim: string, context?: string): Promise<void> {
  const resp = await fetch(`${VERITAS_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim, context }),
  });
  const data = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    console.error(`❌ Error (${resp.status}): ${data.error ?? resp.statusText}`);
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function getHealth(): Promise<void> {
  const resp = await fetch(`${VERITAS_URL}/health`);
  const data = (await resp.json()) as Record<string, unknown>;
  console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "verify": {
      const claim = args[1];
      if (!claim) {
        console.error("Usage: veritas verify <claim> [--context <context>]");
        process.exit(1);
      }
      const ctxIdx = args.indexOf("--context");
      const context = ctxIdx >= 0 ? args[ctxIdx + 1] : undefined;
      await postVerify(claim, context);
      break;
    }
    case "health":
      await getHealth();
      break;
    default:
      console.log(`
Veritas CLI — evidence verification agent

Commands:
  veritas verify <claim> [--context <context>]   Verify a claim
  veritas health                                  Show service health

Environment:
  VERITAS_URL   Base URL of the service (default: http://localhost:4000)
`);
      break;
  }
}

void main();
