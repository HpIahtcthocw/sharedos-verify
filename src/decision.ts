/**
 * decision.ts — 决策引擎抽象 + Jev Provider（System One 结构化决策）
 *
 * 借鉴 TypeSafe Jev 的协议设计（Choice / Score / Noul 三类原子化输出，
 * 一次请求并行返回多个判断，每个答案带概率与置信度），以及开源复现
 * （Nimble / Verdict / Laya）"只选择、不生成"的思路：
 *   - 快：一次前向 70-500ms，替代"让 LLM 生成一段判定文本"的开销
 *   - 省：输入 $0.042/M token、输出免费，单次判定成本≈0
 *   - 诚：不生成证据文本，杜绝模型编造"页面说……"的伪引用
 *
 * 降级策略：Jev 不可用 / 置信度不足时，调用方回退到 LLM 深判
 * （现有 structuredCall 路径），保证服务永不因引擎不可用而失败。
 */

// ============================================================
// Jev 协议类型（TypeSafe System One）
// ============================================================

export type QuestionType = "choice" | "score" | "noul";

export interface DecisionQuestion {
  type: QuestionType;
  name: string;
  /** 问题本身（对 noul 必填，对 choice/score 可选但建议写） */
  question: string;
  /** choice: 候选选项（至多 255 个） */
  options?: string[];
  /** score: 打分量表 [min, max]，默认 [0, 100] */
  scale?: [number, number];
}

export interface DecisionAnswer {
  /** choice -> string；score -> number；noul -> boolean */
  value: string | number | boolean;
  /** 该答案的概率分布权重 */
  probability: number;
  /** 模型对该答案的置信度 0-1 */
  confidence: number;
}

export type DecisionResponse = Record<string, DecisionAnswer>;

// ============================================================
// Provider 配置
// ============================================================

const TYPESAFE_KEY = process.env.TYPESAFE_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
const OPENROUTER_MODEL = "typesafe/jev-1.13";
const TYPESAFE_MODEL = process.env.JEV_MODEL || "jev-latest";

const JEV_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 4000);

export function jevEnabled(): boolean {
  return Boolean(TYPESAFE_KEY || OPENROUTER_KEY);
}

// ============================================================
// 一次调用多个问题（并行返回，官方与 OpenRouter 协议同形）
// ============================================================

/**
 * 调用 Jev 决策模型。返回 null 表示不可用/失败（调用方应降级到 LLM）。
 * 支持两个传输：
 *  1) TypeSafe 官方（TYPESAFE_API_KEY）
 *  2) OpenRouter 网关（OPENROUTER_API_KEY）——协议相同，换 baseURL 与模型名
 */
export async function jevDecide(
  state: string,
  questions: DecisionQuestion[],
): Promise<DecisionResponse | null> {
  if (!jevEnabled() || questions.length === 0) return null;

  const useOpenRouter = Boolean(!TYPESAFE_KEY && OPENROUTER_KEY);
  const endpoint = useOpenRouter ? OPENROUTER_ENDPOINT : TYPESAFE_ENDPOINT;
  const model = useOpenRouter ? OPENROUTER_MODEL : TYPESAFE_MODEL;
  const apiKey = useOpenRouter ? OPENROUTER_KEY : TYPESAFE_KEY;

  const body = {
    state: state.slice(0, 32_000), // 官方 context window 32k token
    model,
    questions: questions.map((q) => ({
      type: q.type,
      name: q.name,
      question: q.question,
      ...(q.options ? { options: q.options } : {}),
      ...(q.scale ? { scale: q.scale } : {}),
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      answers?: Record<string, { value?: unknown; probability?: unknown; confidence?: unknown }>;
    };
    const answers = data.answers ?? {};
    const out: DecisionResponse = {};
    for (const q of questions) {
      const a = answers[q.name];
      if (!a || a.value === undefined || a.value === null) continue;
      out[q.name] = {
        value: a.value as string | number | boolean,
        probability: Number(a.probability ?? 0),
        confidence: Number(a.confidence ?? 0),
      };
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 高层封装：可信度评分 + 二值判断 + 归因（一次请求并行完成）
// ============================================================

export interface CredibilityVerdict {
  /** 0-100 可信度 */
  credibility: number;
  /** 可信 / 存疑 / 不可信 / 无法判定 */
  verdict: string;
  /** Jev 对判断的置信度 0-1 */
  confidence: number;
  /** 是否有可核对的依据（URL 抓取 / 调用方 context） */
  has_verifiable_source: boolean;
  engine: "jev" | "fallback";
}

const SCORE_TO_VERDICT = (s: number): string =>
  s >= 80 ? "可信" : s >= 60 ? "存疑" : s >= 30 ? "不可信" : "无法判定";

/**
 * Jev 快判：给一段状态（claim + 可选材料），一次并行返回
 * credibility(score 0-100) / credible(noul 布尔) / verifiable(noul)。
 * confidence < 阈值时返回 null（调用方降级 LLM 深判）。
 */
export async function jevCredibility(
  state: string,
  opts: { minConfidence?: number } = {},
): Promise<CredibilityVerdict | null> {
  const minC = opts.minConfidence ?? 0.45;
  const answers = await jevDecide(state, [
    {
      type: "score",
      name: "credibility",
      question: "根据可用信息评估该断言的可靠性，0 完全不可信，100 完全可信",
      scale: [0, 100],
    },
    {
      type: "noul",
      name: "credible",
      question: "该断言当前是否可信？",
    },
    {
      type: "noul",
      name: "verifiable",
      question: "该断言是否有可核对的信息来源或证据？",
    },
  ]);
  if (!answers?.credibility) return null;

  const raw = Number(answers.credibility.value);
  const confidence = Number(answers.credibility.confidence ?? 0);
  if (!Number.isFinite(raw) || confidence < minC) return null;

  const credibility = Math.max(0, Math.min(100, Math.round(raw)));
  const noul = answers.credible;
  const verifiable = answers.verifiable;

  let verdict = SCORE_TO_VERDICT(credibility);
  // Noul 与 Score 冲突仲裁：score 落在"存疑/不可信"边界而 noul 明确可信，采信 noul
  if (noul && typeof noul.value === "boolean") {
    const p = Number(noul.probability ?? 0);
    if (noul.value === true && p >= 0.6 && credibility < 50) verdict = "存疑";
    if (noul.value === false && p >= 0.6 && credibility > 60) verdict = "存疑";
  }

  return {
    credibility,
    verdict,
    confidence,
    has_verifiable_source: Boolean(verifiable && verifiable.value === true),
    engine: "jev",
  };
}
