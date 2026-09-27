/**
 * arena.test.ts — Veritas 房间漏斗行为测试
 *
 * 重点测: BUY_INSTRUCTION 正则 / 主动 review / 被质询 AI 辩护回退 / per-sender 冷却 / 进房配置。
 * LLM 通过 mock 全局 fetch 模拟; sharednet 模块整体 stub, 不触网。
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";

// ---- stub sharednet (必须在 import server 之前 hoist) ----
const { sayMock } = vi.hoisted(() => ({ sayMock: vi.fn() }));

vi.mock("../src/sharednet.js", () => ({
  join: vi.fn(async () => ({ history: { items: [] } })),
  restore: vi.fn(async () => ({ lastSeq: 0 })),
  say: (...a: unknown[]) => sayMock(...a),
  wait: vi.fn(async () => ({ items: [] })),
  read: vi.fn(async () => ({ items: [] })),
  getLastSeq: vi.fn(() => 0),
  advanceSeq: vi.fn(),
  getRoomId: vi.fn(),
  getMemberToken: vi.fn(),
  switchRoom: vi.fn(),
  listRooms: vi.fn(async () => []),
  leave: vi.fn(),
  getSelfInstanceId: vi.fn(() => "self-instance-id"),
}));

// 指向临时 audit 目录, 避免测试在仓库里生成 signing-key.json
process.env.AUDIT_DIR = path.join(os.tmpdir(), `veritas-arena-audit-${process.pid}`);

// server 模块在 beforeAll 动态导入
let server: typeof import("../src/server.js");

// ---- fake LLM transport ----
type FakeResp = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};
const fetchMock = vi.fn();

function llmSuccess(payload: unknown): FakeResp {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  };
}
function llmFailure(): FakeResp {
  return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
}
/** 取出某次 fetch 调用的 system prompt */
function systemPrompts(): string[] {
  return fetchMock.mock.calls.map((c) => {
    const body = JSON.parse((c[1] as { body: string }).body) as { messages: { role: string; content: string }[] };
    return body.messages[0].content;
  });
}

beforeAll(async () => {
  server = await import("../src/server.js");
});

beforeEach(() => {
  fetchMock.mockReset();
  sayMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  server.__resetArenaState();
});

// ============================================================
// 1. BUY_INSTRUCTION_PATTERN
// ============================================================
describe("BUY_INSTRUCTION_PATTERN", () => {
  it("does NOT match third-party transfer chatter", () => {
    expect(server.BUY_INSTRUCTION_PATTERN.test("I just completed your transfer to fetchly")).toBe(false);
  });
  it("matches @veritas buy instruction", () => {
    expect(server.BUY_INSTRUCTION_PATTERN.test("@veritas I'll transfer 3cr")).toBe(true);
  });
  it("matches veritas 中文转账", () => {
    expect(server.BUY_INSTRUCTION_PATTERN.test("veritas 我转账给你")).toBe(true);
  });
});

// ============================================================
// 2. 产品介绍 → 主动 review
// ============================================================
describe("proactive product review", () => {
  const PRODUCT_INTRO =
    "Hey everyone! I'm Alex, we just launched a new AI note-taking app that transcribes meetings automatically.";

  it("calls the reviewer LLM and posts a review on a plain product intro", async () => {
    fetchMock.mockResolvedValue(
      llmSuccess({ review: "总评：demo 完整但缺真实数据。批评：没有任何第三方评测对比。建议：补一组 baseline ablation。" }),
    );
    await server.handleRoomMessage({ content: PRODUCT_INTRO, sender_instance_id: "sender-a" });

    const sys = systemPrompts();
    expect(sys.some((s) => s.includes("产品评审员"))).toBe(true);
    expect(sayMock).toHaveBeenCalledTimes(1);
    const posted = String(sayMock.mock.calls[0][0]);
    expect(posted).toContain("@sender-a");
    expect(posted).toContain("demo 完整但缺真实数据");
  });

  it("does NOT review a product intro that mentions @veritas (falls into directed flow)", async () => {
    fetchMock.mockResolvedValue(
      llmSuccess({ reply: "你说得对，无 URL 断言我们标注置信度；带 URL 的实时抓取并返回 sha256 回执。前 3 次免费，欢迎实测。" }),
    );
    await server.handleRoomMessage({
      content: "Hi @veritas, we launched a note app. Why should anyone trust your scores?",
      sender_instance_id: "sender-b",
    });

    const sys = systemPrompts();
    expect(sys.some((s) => s.includes("产品评审员"))).toBe(false); // 没走 review
    expect(sys.some((s) => s.includes("证据验真 Agent"))).toBe(true); // 走了 defense
    expect(sayMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the reviewer LLM fails", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(llmFailure()));
    await server.handleRoomMessage({ content: PRODUCT_INTRO, sender_instance_id: "sender-a2" });
    expect(sayMock).not.toHaveBeenCalled();
  });
});

// ============================================================
// 3. 被 @veritas 质询 → AI 辩护 / 回退固定话术
// ============================================================
describe("@veritas challenge defense", () => {
  const CHALLENGE = "@veritas 你们的评分根本不准，凭什么信你？";

  it("posts the LLM-generated defense on success", async () => {
    fetchMock.mockResolvedValue(
      llmSuccess({ reply: "你说得对，无 URL 断言我们确实依赖模型知识并标注置信度。带 URL 的断言我们实时抓取并返回 sha256 回执，判定书带 Ed25519 签名。前 3 次免费，欢迎拿任意断言实测。" }),
    );
    await server.handleRoomMessage({ content: CHALLENGE, sender_instance_id: "sender-c" });

    expect(sayMock).toHaveBeenCalledTimes(1);
    const posted = String(sayMock.mock.calls[0][0]);
    expect(posted).toContain("@sender-c");
    expect(posted).toContain("你说得对");
  });

  it("falls back to the canned reply when the defense LLM fails", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(llmFailure()));
    await server.handleRoomMessage({ content: CHALLENGE, sender_instance_id: "sender-c2" });

    expect(sayMock).toHaveBeenCalledTimes(1);
    expect(String(sayMock.mock.calls[0][0])).toContain("收到质疑");
  });
});

// ============================================================
// 4. per-sender 10 分钟冷却
// ============================================================
describe("per-sender cooldown", () => {
  it("does not reply twice to the same sender within 10 minutes", async () => {
    fetchMock.mockResolvedValue(llmSuccess({ review: "总评：想法不错。批评：没有数据。建议：加 baseline。" }));
    const msg = {
      content: "Hey everyone! I'm Dora, we built a new CLI tool for deploying side projects.",
      sender_instance_id: "sender-d",
    };
    await server.handleRoomMessage(msg);
    expect(sayMock).toHaveBeenCalledTimes(1);
    await server.handleRoomMessage(msg);
    expect(sayMock).toHaveBeenCalledTimes(1); // 第二条被冷却吞掉
  });
});

// ============================================================
// 5. 进房自我介绍 / 卖点轮换配置
// ============================================================
describe("join / pitch config", () => {
  it("defaults intro delay to 30s and pitch interval to 15min", () => {
    expect(server.JOIN_INTRO_DELAY_MS).toBe(30 * 1000);
    expect(server.PITCH_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("INTRO_MESSAGE covers name, 9 tiers, free-3, channels, seat", () => {
    expect(server.INTRO_MESSAGE).toContain("Veritas");
    expect(server.INTRO_MESSAGE).toContain("selfcheck 0");
    expect(server.INTRO_MESSAGE).toContain("certify 15");
    expect(server.INTRO_MESSAGE).toContain("前 3 次免费");
    expect(server.INTRO_MESSAGE).toContain("/verify");
    expect(server.INTRO_MESSAGE).toContain("MCP");
    expect(server.INTRO_MESSAGE).toContain("CLI");
    expect(server.INTRO_MESSAGE).toContain("i_SDbntoujrL");
  });

  it("ships at least 4 rotating pitches", () => {
    expect(server.PITCHES.length).toBeGreaterThanOrEqual(4);
  });
});
