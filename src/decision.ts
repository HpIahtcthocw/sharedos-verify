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
  /**
   * Jev 新协议 (jev-1.13) criteria:
   *  - score: string[] 刻度描述 (如 ["完全不可信","完全可信"])
   *  - choice/noul: Record<string,string> (选项/真伪 -> 描述)
   * 未提供时由 jevDecide 按类型生成默认。
   */
  criteria?: string[] | Record<string, string>;
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

// ---- Cloudflare Workers AI 免费快判通道 (开源替代, 10000 neurons/day 永久免费) ----
// OpenAI 兼容 chat completions, 用 Llama-3.1-8B 做 System One 式打分。
// 零成本, 无需等待名单; 需 Cloudflare 账号免费创建 API token (Workers AI 权限)。
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_MODEL = process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8";
const CLOUDFLARE_ENDPOINT = (): string =>
  `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`;
const CLOUDFLARE_TIMEOUT_MS = Number(process.env.CLOUDFLARE_TIMEOUT_MS || 8000);

export function jevEnabled(): boolean {
  return Boolean(TYPESAFE_KEY || OPENROUTER_KEY);
}

export function cloudflareEnabled(): boolean {
  return Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN);
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

  // Jev 新协议 (jev-1.13): questions 为 record, 每题 {type, instructions, criteria}
  const qs: Record<string, unknown> = {};
  for (const q of questions) {
    const item: Record<string, unknown> = {
      type: q.type,
      instructions: q.question,
    };
    if (q.criteria) {
      item.criteria = q.criteria;
    } else if (q.type === "score") {
      // 默认 5 点刻度 (0-100 连续映射由调用方完成)
      item.criteria = ["完全不可信(0)", "比较不可信(25)", "不确定(50)", "比较可信(75)", "完全可信(100)"];
    } else if (q.type === "choice" && q.options) {
      const m: Record<string, string> = {};
      for (const o of q.options) m[o] = o;
      item.criteria = m;
    } else if (q.type === "noul") {
      item.criteria = { true: "成立", false: "不成立" };
    }
    qs[q.name] = item;
  }

  const body = {
    state: state.slice(0, 32_000), // 官方 context window 32k token
    model,
    questions: qs,
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
      answers?: Record<
        string,
        {
          type?: string;
          noul?: number;
          choice?: string;
          score?: number;
          confidence?: number;
          probabilities?: Record<string, number>;
        }
      >;
    };
    const answers = data.answers ?? {};
    const out: DecisionResponse = {};
    for (const q of questions) {
      const a = answers[q.name];
      if (!a) continue;
      if (a.type === "noul" && typeof a.noul === "number") {
        // 概率 0-1 -> 布尔值 + 概率 + 置信度(取远离 0.5 的程度)
        out[q.name] = {
          value: a.noul >= 0.5,
          probability: a.noul,
          confidence: Math.max(a.noul, 1 - a.noul),
        };
      } else if (a.type === "score" && typeof a.score === "number") {
        out[q.name] = {
          value: a.score,
          probability: 1,
          confidence: Number(a.confidence ?? 0),
        };
      } else if (a.type === "choice" && typeof a.choice === "string") {
        out[q.name] = {
          value: a.choice,
          probability: Number(a.probabilities?.[a.choice] ?? 0),
          confidence: Number(a.confidence ?? 0),
        };
      }
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
  engine: "jev" | "cloudflare" | "fallback";
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
      question: "根据可用信息评估该断言的可靠性",
      criteria: ["完全不可信(0)", "比较不可信(25)", "不确定(50)", "比较可信(75)", "完全可信(100)"],
    },
    {
      type: "noul",
      name: "credible",
      question: "该断言当前是否可信？",
      criteria: { true: "可信", false: "不可信" },
    },
    {
      type: "noul",
      name: "verifiable",
      question: "该断言是否有可核对的信息来源或证据？",
      criteria: { true: "有", false: "无" },
    },
  ]);
  if (!answers?.credibility) return null;

  // score 为 5 点刻度的连续值 (0-4) -> 映射 0-100
  const raw = (Number(answers.credibility.value) / 4) * 100;
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


// ============================================================
// Cloudflare Workers AI 免费快判 (开源替代通道)
// 零成本近似 Jev: Llama-3.1-8B 只输出 JSON 分数, 不生成证据文本。
// 仅在 Jev 不可用 (未配 key / 失败) 时由调用方使用。
// ============================================================

export async function cloudflareQuickScore(
  claim: string,
  context?: string,
): Promise<CredibilityVerdict | null> {
  if (!cloudflareEnabled()) return null;
  const userMsg = `评估以下断言的可靠性。\n断言: ${claim.slice(0, 2000)}
${
    context ? `可用信息: ${context.slice(0, 6000)}` : "可用信息: (无外部材料)"
  }
\n只输出 JSON, 不要任何其他文字: {"credibility":0到100的整数,"credible":true或false,"verifiable":true或false,"confidence":0到1的小数}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUDFLARE_TIMEOUT_MS);
  try {
    const resp = await fetch(CLOUDFLARE_ENDPOINT(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLOUDFLARE_MODEL,
        messages: [
          {
            role: "system",
            content:
              "你是断言可信度评估器。只输出严格 JSON，不要输出 JSON 以外的任何内容。",
          },
          { role: "user", content: userMsg },
        ],
        max_tokens: 60,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      result?: { choices?: Array<{ message?: { content?: string } }> };
    };
    const content = data.result?.choices?.[0]?.message?.content;
    if (!content) return null;
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as {
      credibility?: number;
      credible?: boolean;
      verifiable?: boolean;
      confidence?: number;
    };
    const raw = Number(parsed.credibility);
    if (!Number.isFinite(raw)) return null;
    const credibility = Math.max(0, Math.min(100, Math.round(raw)));
    const confidence = Number(parsed.confidence ?? 0);
    return {
      credibility,
      verdict: SCORE_TO_VERDICT(credibility),
      confidence,
      has_verifiable_source: Boolean(parsed.verifiable),
      engine: "cloudflare",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
