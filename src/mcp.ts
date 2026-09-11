#!/usr/bin/env node
/**
 * veritas-mcp — SharedOS-compatible MCP wrapper
 *
 * MCP (Model Context Protocol) 是一种标准协议，Claude Desktop / Claude Code /
 * Cursor 等客户端可以直接连接。这个文件把 /verify 能力暴露成 MCP server。
 *
 * 使用方式 1 — stdio（被 MCP client 直接 spawn，指向本地服务）:
 *   node dist/mcp.js
 *
 * 使用方式 2 — 指向远端部署实例:
 *   VERITAS_URL=https://your-app.onrender.com node dist/mcp.js
 *
 * 本实现使用 stdio JSON-RPC，这是 MCP 参考实现的标准形状。
 * 协议细节: https://spec.modelcontextprotocol.io/
 */

import { spawn, spawnSync } from "node:child_process";

const VERITAS_URL = process.env.VERITAS_URL || "http://localhost:4000";

// ============================================================
// MCP Tool definition
// ============================================================

const VERIFY_TOOL = {
  name: "veritas.verify",
  description:
    "Evaluate the credibility of a claim and return a structured verdict " +
    "(credibility score 0-100, verdict, evidence list, risk factors). " +
    "Use this before defending a claim or refuting an opponent's claim in an argument.",
  inputSchema: {
    type: "object",
    properties: {
      claim: {
        type: "string",
        description: "The assertion or claim to verify",
      },
      context: {
        type: "string",
        description: "Optional background material to use as fact-checking source",
      },
    },
    required: ["claim"],
  },
};

const HEALTH_TOOL = {
  name: "veritas.health",
  description: "Check if the Veritas verification service is running and healthy",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

// ============================================================
// MCP Protocol handlers
// ============================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function respond(id: number | string | null, result: unknown): void {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  console.log(JSON.stringify(msg));
}

function error(id: number | string | null, code: number, message: string): void {
  const msg: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  console.log(JSON.stringify(msg));
}

async function callVerify(params: Record<string, unknown>): Promise<unknown> {
  const claim = String(params.claim ?? "").trim();
  const context = params.context as string | undefined;
  const resp = await fetch(`${VERITAS_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim, context }),
  });
  if (!resp.ok) {
    const data = (await resp.json()) as { error?: string };
    throw new Error(data.error ?? `HTTP ${resp.status}`);
  }
  return (await resp.json()) as unknown;
}

async function callHealth(): Promise<unknown> {
  const resp = await fetch(`${VERITAS_URL}/health`);
  return (await resp.json()) as unknown;
}

// ============================================================
// Main loop
// ============================================================

async function main(): Promise<void> {
  const isSSE = process.argv.includes("--sse");

  if (isSSE) {
    // SSE mode — simple HTTP endpoint for SharedOS to call
    // (Minimal implementation; in production use a real SSE library)
    console.error("SSE mode: use stdio mode instead (default)");
    process.exit(1);
    return;
  }

  // stdio mode — read JSON-RPC from stdin, write to stdout
  const stdin = process.stdin as any;
  const reader = stdin.getReader ? stdin.getReader() : stdin;
  const decoder = new TextDecoder();
  let buffer = "";

  // Send initialize response immediately
  const initMsg: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "veritas-mcp",
        version: "0.1.0",
      },
    },
  };
  console.log(JSON.stringify(initMsg));

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;

      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(line) as JsonRpcRequest;
      } catch {
        continue;
      }

      if (msg.jsonrpc !== "2.0") continue;

      const id = msg.id ?? null;

      try {
        switch (msg.method) {
          case "initialize":
            // Already sent above for id=1; handle dynamic id
            respond(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "veritas-mcp", version: "0.1.0" },
            });
            break;

          case "tools/list":
            respond(id, {
              tools: [VERIFY_TOOL, HEALTH_TOOL],
            });
            break;

          case "tools/call": {
            const { name, arguments: args } = (msg.params ?? {}) as {
              name: string;
              arguments?: Record<string, unknown>;
            };
            if (name === "veritas.verify") {
              const result = await callVerify(args ?? {});
              respond(id, {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                  },
                ],
              });
            } else if (name === "veritas.health") {
              const result = await callHealth();
              respond(id, {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                  },
                ],
              });
            } else {
              error(id, -32601, `Unknown tool: ${name}`);
            }
            break;
          }

          case "ping":
            respond(id, {});
            break;

          default:
            error(id, -32601, `Method not found: ${msg.method}`);
            break;
        }
      } catch (err) {
        error(id, -32000, String(err));
      }
    }
  }
}

void main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
