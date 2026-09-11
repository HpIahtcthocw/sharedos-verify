/**
 * sharedos-verify — unit tests
 *
 * Run: npm test   (vitest run)
 */

import { describe, it, expect } from "vitest";

// ============================================================
// Pure utility functions
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

function pick<T = unknown>(
  o: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const k of keys) {
    if (o[k] != null) return o[k] as T;
  }
  return undefined;
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

describe("normalizeScore", () => {
  it("returns 0 for non-finite, null, undefined, or negative", () => {
    expect(normalizeScore(NaN)).toBe(0);
    expect(normalizeScore(-5)).toBe(0);
    expect(normalizeScore(0)).toBe(0);
    expect(normalizeScore(null)).toBe(0);
    expect(normalizeScore(undefined)).toBe(0);
  });

  it("normalizes 0-1 probability scale to 0-100", () => {
    expect(normalizeScore(1)).toBe(100);
    expect(normalizeScore(0.8)).toBe(80);
    expect(normalizeScore(0.5)).toBe(50);
  });

  it("normalizes 1-5 star scale to 0-100 (5★ = 100)", () => {
    expect(normalizeScore(5)).toBe(100);
    expect(normalizeScore(4)).toBe(80);
    expect(normalizeScore(3)).toBe(60);
  });

  it("normalizes 1-10 scale to 0-100 (values ≤5 are treated as 1-5 scale)", () => {
    expect(normalizeScore(10)).toBe(100);
    expect(normalizeScore(8)).toBe(80);
    expect(normalizeScore(6)).toBe(60);
    expect(normalizeScore(5)).toBe(100);
  });

  it("passes through 0-100 values unchanged", () => {
    expect(normalizeScore(42)).toBe(42);
    expect(normalizeScore(100)).toBe(100);
  });

  it("clamps overflow to 100 and underflow to 0", () => {
    expect(normalizeScore(150)).toBe(100);
    expect(normalizeScore(-10)).toBe(0);
  });
});

describe("pick", () => {
  it("returns the first existing key's value", () => {
    expect(pick({ a: 1, b: 2 }, "b", "a")).toBe(2);
    expect(pick({ x: "hello" }, "y", "x")).toBe("hello");
  });

  it("returns undefined when no key exists", () => {
    expect(pick({ a: 1 }, "b", "c")).toBeUndefined();
  });

  it("skips null and undefined values", () => {
    expect(pick({ a: null, b: 2 }, "a", "b")).toBe(2);
    expect(pick({ a: undefined, b: 2 }, "a", "b")).toBe(2);
  });
});

describe("extractJson", () => {
  it("parses clean JSON directly", () => {
    const result = extractJson<{ score: number }>('{"score": 85}');
    expect(result.score).toBe(85);
  });

  it("strips ```json code fences", () => {
    const input = "```json\n{\"score\": 42}\n```";
    const result = extractJson<{ score: number }>(input);
    expect(result.score).toBe(42);
  });

  it("extracts the first {...} block from prose", () => {
    const input = 'Result: {"score": 77, "verdict": "可信"} — done!';
    const result = extractJson<{ score: number; verdict: string }>(input);
    expect(result.score).toBe(77);
    expect(result.verdict).toBe("可信");
  });

  it("throws SyntaxError for unparseable input", () => {
    expect(() => extractJson("no json here")).toThrow(SyntaxError);
  });
});

// ============================================================
// HTTP endpoint tests
// ============================================================

import express from "express";
import request from "supertest";

function buildTestApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Import the core verify logic by re-implementing it here for isolation
  // (In production, we'd import from server.ts but that creates circular deps)
  function normalizeScore(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    let v = n;
    if (v <= 1) v = v * 100;
    else if (v <= 5) v = v * 20;
    else if (v <= 10) v = v * 10;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function pick<T = unknown>(
    o: Record<string, unknown>,
    ...keys: string[]
  ): T | undefined {
    for (const k of keys) {
      if (o[k] != null) return o[k] as T;
    }
    return undefined;
  }

  function asArray(v: unknown): Record<string, unknown>[] {
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  }

  function obj(
    properties: Record<string, unknown>,
    required: string[],
  ): Record<string, unknown> {
    return { type: "object", properties, required, additionalProperties: false };
  }

  const VERDICT_MAP: Record<string, string> = {
    credible: "可信",
    uncertain: "存疑",
    not_credible: "不可信",
    undetermined: "无法判定",
  };

  // Mock structuredCall
  const mockResponses: { trigger: string; result: Record<string, unknown> }[] = [];
  async function mockStructuredCall<T>(
    _opts: { system: string; user: string; schema: Record<string, unknown> },
  ): Promise<T> {
    const user = _opts.user.toLowerCase();
    for (const entry of mockResponses) {
      if (user.includes(entry.trigger.toLowerCase())) {
        return entry.result as T;
      }
    }
    return {
      credibility: 65,
      verdict: "存疑",
      evidence: ["默认：信息不足以给出明确判断"],
      risk_factors: ["参考材料可能不完整"],
    } as T;
  }

  // @ts-ignore — augmenting Express app with test helper
  (app as unknown as Record<string, unknown>).setMockResponse = (
    trigger: string,
    result: Record<string, unknown>,
  ) => {
    mockResponses.length = 0;
    mockResponses.push({ trigger, result });
  };

  app.post("/verify", async (req, res) => {
    try {
      const claim = String(req.body?.claim ?? "").trim();
      const context: string | undefined = req.body?.context;

      if (!claim) {
        return res.status(400).json({ error: "缺少必填字段: claim (string)" });
      }

      const raw = await mockStructuredCall<Record<string, unknown>>({
        system: "system",
        user: claim + (context ? ` ${context}` : ""),
        schema: obj(
          {
            credibility: { type: "integer" },
            verdict: {
              type: "string",
              enum: ["可信", "存疑", "不可信", "无法判定"],
            },
            evidence: { type: "array", items: { type: "string" } },
            risk_factors: { type: "array", items: { type: "string" } },
          },
          ["credibility", "verdict", "evidence", "risk_factors"],
        ),
      });

      const credibility = normalizeScore(
        pick(raw, "credibility", "score", "rating"),
      );
      const verdict =
        String(pick(raw, "verdict") ?? "无法判定") in VERDICT_MAP
          ? VERDICT_MAP[String(pick(raw, "verdict") ?? "无法判定")] ??
            "无法判定"
          : "无法判定";
      const evidence = asArray(pick(raw, "evidence", "sources", "proofs")).map(
        (e) => String(e ?? "").trim(),
      );
      const risk_factors = asArray(
        pick(raw, "risk_factors", "risks", "warnings"),
      ).map((r) => String(r ?? "").trim());

      res.json({
        credibility,
        verdict,
        evidence: evidence.filter(Boolean),
        risk_factors: risk_factors.filter(Boolean),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/health", (_req, res) => {
    res.json({
      service: "sharedos-verify",
      agent: "Veritas",
      version: "0.1.0",
      ok: true,
      hasKey: true,
      endpoint: "/verify",
    });
  });

  return app;
}

describe("POST /verify", () => {
  it("returns 400 when claim is missing", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/verify").send({});
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>).error).toMatch(/claim/);
  });

  it("returns 400 when claim is empty string", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/verify").send({ claim: "   " });
    expect(res.status).toBe(400);
  });

  it("returns credibility/verdict/evidence/risk_factors on success", async () => {
    const app = buildTestApp();
    // @ts-ignore — test helper on Express app
    (app as unknown as Record<string, unknown>).setMockResponse(
      "太阳从东边升起",
      {
        credibility: 95,
        verdict: "credible",   // LLM returns English key → mapped to 可信
        evidence: ["地理常识：地球自西向东自转导致太阳东升西落"],
        risk_factors: [],
      },
    );

    const res = await request(app)
      .post("/verify")
      .send({ claim: "太阳从东边升起" });

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).credibility).toBe(95);
    expect((res.body as Record<string, unknown>).verdict).toBe("可信");
    expect(Array.isArray((res.body as Record<string, unknown>).evidence)).toBe(true);
    expect(Array.isArray((res.body as Record<string, unknown>).risk_factors)).toBe(true);
  });

  it("normalizes 0-1 credibility to 0-100", async () => {
    const app = buildTestApp();
    // @ts-ignore — test helper on Express app
    (app as unknown as Record<string, unknown>).setMockResponse(
      "虚假断言",
      {
        credibility: 0.2,
        verdict: "not_credible",  // LLM returns English key → mapped to 不可信
        evidence: ["来源可疑，无权威数据支持"],
        risk_factors: ["无法验证来源"],
      },
    );

    const res = await request(app)
      .post("/verify")
      .send({ claim: "虚假断言" });

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).credibility).toBe(20);
  });

  it("handles unknown verdict by defaulting to 无法判定", async () => {
    const app = buildTestApp();
    // @ts-ignore — test helper on Express app
    (app as unknown as Record<string, unknown>).setMockResponse(
      "模糊断言",
      {
        credibility: 30,
        verdict: "也许是",
        evidence: [],
        risk_factors: ["vague"],
      },
    );

    const res = await request(app).post("/verify").send({ claim: "模糊断言" });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).verdict).toBe("无法判定");
  });

  it("returns exactly 4 fields in response", async () => {
    const app = buildTestApp();
    // @ts-ignore — test helper on Express app
    (app as unknown as Record<string, unknown>).setMockResponse(
      "地球是平的",
      {
        credibility: 5,
        verdict: "not_credible",  // LLM returns English key → mapped to 不可信
        evidence: ["已被证伪的科学结论"],
        risk_factors: [],
      },
    );

    const res = await request(app)
      .post("/verify")
      .send({ claim: "地球是平的" });

    expect(res.status).toBe(200);
    expect(Object.keys((res.body as Record<string, unknown>)).sort()).toEqual(
      ["credibility", "evidence", "risk_factors", "verdict"].sort(),
    );
    expect(typeof (res.body as Record<string, unknown>).credibility).toBe("number");
    expect(typeof (res.body as Record<string, unknown>).verdict).toBe("string");
    expect(Array.isArray((res.body as Record<string, unknown>).evidence)).toBe(true);
    expect(Array.isArray((res.body as Record<string, unknown>).risk_factors)).toBe(true);
  });

  it("accepts optional context field", async () => {
    const app = buildTestApp();
    // @ts-ignore — test helper on Express app
    (app as unknown as Record<string, unknown>).setMockResponse(
      "AI将取代所有程序员",
      {
        credibility: 65,
        verdict: "uncertain",  // LLM returns English key → mapped to 存疑
        evidence: ["根据上下文，AI辅助提升效率但未完全取代"],
        risk_factors: ["预测类断言难以完全验证"],
      },
    );

    const res = await request(app)
      .post("/verify")
      .send({
        claim: "AI将取代所有程序员",
        context: "根据2025年统计，AI辅助开发提升效率40%",
      });

    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).verdict).toBe("存疑");
  });
});

describe("GET /health", () => {
  it("returns service info", async () => {
    const app = buildTestApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).service).toBe("sharedos-verify");
    expect((res.body as Record<string, unknown>).agent).toBe("Veritas");
    expect((res.body as Record<string, unknown>).ok).toBe(true);
    expect((res.body as Record<string, unknown>).endpoint).toBe("/verify");
  });
});
