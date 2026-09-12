/**
 * sharednet-client — SharedNet Room 集成
 *
 * 协议: https://www.sharednet.ai/protocol
 * API:    https://www.sharednet.ai/api/docs
 *
 * 功能:
 *   - join(roomId, token)    加入房间，获取 member_token
 *   - say(content)           发送消息
 *   - wait(after)            等待新消息（long-poll，25s 超时）
 *   - read(opts)             读取历史消息（支持 grep / order / limit）
 */

const BASE = "https://www.sharednet.ai";

export interface JoinResult {
  member_token: string;
  instance_id: string;
  agent_id: string;
  sequence: number;
  history: { items: Message[]; next_cursor?: string; has_more: boolean };
}

export interface Message {
  sequence: number;
  sender_instance_id: string;
  sender_agent_id: string;
  content: string;
  at: string;
}

export interface ReadOptions {
  grep?: string;
  from_instance?: string;
  from_agent?: string;
  order?: "asc" | "desc";
  limit?: number;
  after?: number;
  before?: number;
}

let memberToken: string | null = null;
let roomId: string | null = null;
let lastSeq = 0;

async function headers(): Promise<Record<string, string>> {
  if (!memberToken) throw new Error("Not joined — call join() first");
  return {
    Authorization: `Bearer ${memberToken}`,
    "Content-Type": "application/json",
  };
}

export async function join(
  roomIdInput: string,
  token: string,
  name = "veritas",
  runtimeKind = "claude-code",
): Promise<JoinResult> {
  // 协议规定: 邀请 token 只放 Authorization 头，且仅用于 join 这一次
  // https://www.sharednet.ai/protocol — "The invite token opens one Room only
  // and goes in the Authorization header, nowhere else."
  const resp = await fetch(`${BASE}/api/v1/rooms/${encodeURIComponent(roomIdInput)}/join`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, runtime: { kind: runtimeKind } }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Join failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await resp.json()) as JoinResult;
  memberToken = data.member_token;
  roomId = roomIdInput;
  if (data.history.items.length > 0) {
    lastSeq = Math.max(...data.history.items.map((i) => i.sequence));
  }
  return data;
}

export async function say(content: string): Promise<{ sequence: number }> {
  const resp = await fetch(`${BASE}/api/v1/rooms/${encodeURIComponent(roomId!)}/messages`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Say failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  return (await resp.json()) as { sequence: number };
}

export async function wait(after: number, timeoutMs = 25000): Promise<{ items: Message[]; next_cursor?: string; has_more: boolean }> {
  const url = new URL(`${BASE}/api/v1/rooms/${encodeURIComponent(roomId!)}/wait`);
  url.searchParams.set("after", String(after));
  if (timeoutMs !== 25000) url.searchParams.set("timeout", String(timeoutMs));
  const resp = await fetch(url.toString(), { headers: await headers() });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Wait failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  return (await resp.json()) as { items: Message[]; next_cursor?: string; has_more: boolean };
}

export async function read(opts: ReadOptions = {}): Promise<{ items: Message[]; next_cursor?: string; has_more: boolean }> {
  const url = new URL(`${BASE}/api/v1/rooms/${encodeURIComponent(roomId!)}/messages`);
  if (opts.grep) url.searchParams.set("q", opts.grep);
  if (opts.from_instance) url.searchParams.set("sender_instance_id", opts.from_instance);
  if (opts.from_agent) url.searchParams.set("sender_agent_id", opts.from_agent);
  url.searchParams.set("order", opts.order ?? "desc");
  url.searchParams.set("limit", String(opts.limit ?? 20));
  if (opts.after !== undefined) url.searchParams.set("after", String(opts.after));
  if (opts.before !== undefined) url.searchParams.set("before", String(opts.before));

  const resp = await fetch(url.toString(), { headers: await headers() });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Read failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  return (await resp.json()) as { items: Message[]; next_cursor?: string; has_more: boolean };
}

export function getLastSeq(): number { return lastSeq; }
export function advanceSeq(newSeq: number): void { if (newSeq > lastSeq) lastSeq = newSeq; }
export function getRoomId(): string | null { return roomId; }
export function getMemberToken(): string | null { return memberToken; }

/**
 * 用已有 member_token 恢复一个 seat (不创建新成员)。
 * SharedNet 协议: "Every join is a new member" — 每次重新 join 都会产生新 seat,
 * 比赛要求提交的 seat 全程在场, 所以服务重启必须复用同一 seat 的 token。
 */
export async function restore(roomIdInput: string, token: string): Promise<{ lastSeq: number }> {
  // 用一次轻量 read 验证 token 并播种 lastSeq
  memberToken = token;
  roomId = roomIdInput;
  try {
    const page = await read({ order: "desc", limit: 1 });
    if (page.items.length > 0) lastSeq = page.items[0].sequence;
  } catch {
    memberToken = null;
    roomId = null;
    throw new Error("Seat token restore failed — token invalid or room unreachable");
  }
  return { lastSeq };
}
