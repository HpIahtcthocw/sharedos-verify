/**
 * sharednet-client — SharedNet Room 集成（多房间版）
 *
 * 协议: https://www.sharednet.ai/protocol
 * API:    https://www.sharednet.ai/api/docs
 *
 * 功能:
 *   - join(roomId, token)        加入房间，获取 member_token
 *   - restore(roomId, token)     复用已有 seat（跨重启保持同一 instance）
 *   - say(content, roomId?)      发送消息（默认当前活动房间）
 *   - wait(after, timeoutMs, roomId?)  等待新消息（long-poll）
 *   - read(opts, roomId?)        读取历史消息
 *   - listRooms() / switchRoom() / leave()   多房间管理
 *
 * 多房间设计：一个进程可同时监听多个房间（Map<roomId, RoomState>），
 * 换房/加房走 API 动态切换——不再需要改环境变量 + 重新部署。
 */

const BASE = "https://www.sharednet.ai";

import { randomUUID } from "node:crypto";

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

interface RoomState {
  memberToken: string;
  lastSeq: number;
  selfInstanceId?: string;
}

const rooms = new Map<string, RoomState>();
let activeRoomId: string | null = null;

async function headers(roomIdInput?: string): Promise<Record<string, string>> {
  const rid = roomIdInput ?? activeRoomId;
  const state = rid ? rooms.get(rid) : undefined;
  if (!rid || !state) throw new Error(`Not joined — call join() first (room=${rid ?? "<none>"})`);
  return {
    Authorization: `Bearer ${state.memberToken}`,
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
  const resp = await fetch(`${BASE}/api/v1/rooms/${encodeURIComponent(roomIdInput)}/join`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({ name, runtime: { kind: runtimeKind } }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Join failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await resp.json()) as JoinResult;
  let lastSeq = 0;
  if (data.history.items.length > 0) {
    lastSeq = Math.max(...data.history.items.map((i) => i.sequence));
  }
  rooms.set(roomIdInput, {
    memberToken: data.member_token,
    lastSeq,
    selfInstanceId: data.instance_id,
  });
  activeRoomId = roomIdInput;
  return data;
}

export async function say(content: string, roomIdInput?: string): Promise<{ sequence: number }> {
  const rid = roomIdInput ?? activeRoomId;
  if (!rid) throw new Error("Not joined — call join() first");
  const resp = await fetch(`${BASE}/api/v1/rooms/${encodeURIComponent(rid)}/messages`, {
    method: "POST",
    headers: {
      ...(await headers(rid)),
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Say failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  return (await resp.json()) as { sequence: number };
}

export async function wait(
  after: number,
  timeoutMs = 25000,
  roomIdInput?: string,
): Promise<{ items: Message[]; next_cursor?: string; has_more: boolean }> {
  const rid = roomIdInput ?? activeRoomId;
  if (!rid) throw new Error("Not joined — call join() first");
  const url = new URL(`${BASE}/api/v1/rooms/${encodeURIComponent(rid)}/wait`);
  url.searchParams.set("after", String(after));
  if (timeoutMs !== 25000) url.searchParams.set("timeout", String(timeoutMs));
  const resp = await fetch(url.toString(), { headers: await headers(rid) });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Wait failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  return (await resp.json()) as { items: Message[]; next_cursor?: string; has_more: boolean };
}

export async function read(
  opts: ReadOptions = {},
  roomIdInput?: string,
): Promise<{ items: Message[]; next_cursor?: string; has_more: boolean }> {
  const rid = roomIdInput ?? activeRoomId;
  if (!rid) throw new Error("Not joined — call join() first");
  const url = new URL(`${BASE}/api/v1/rooms/${encodeURIComponent(rid)}/messages`);
  if (opts.grep) url.searchParams.set("q", opts.grep);
  if (opts.from_instance) url.searchParams.set("sender_instance_id", opts.from_instance);
  if (opts.from_agent) url.searchParams.set("sender_agent_id", opts.from_agent);
  url.searchParams.set("order", opts.order ?? "desc");
  url.searchParams.set("limit", String(opts.limit ?? 20));
  if (opts.after !== undefined) url.searchParams.set("after", String(opts.after));
  if (opts.before !== undefined) url.searchParams.set("before", String(opts.before));

  const resp = await fetch(url.toString(), { headers: await headers(rid) });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Read failed (${resp.status}): ${detail.slice(0, 300)}`);
  }
  return (await resp.json()) as { items: Message[]; next_cursor?: string; has_more: boolean };
}

// ---- 多房间管理 ----

export function listRooms(): string[] {
  return Array.from(rooms.keys());
}

export function switchRoom(roomIdInput: string): boolean {
  if (!rooms.has(roomIdInput)) return false;
  activeRoomId = roomIdInput;
  return true;
}

export function leave(roomIdInput: string): boolean {
  const existed = rooms.delete(roomIdInput);
  if (activeRoomId === roomIdInput) {
    activeRoomId = rooms.keys().next().value ?? null;
  }
  return existed;
}

export function getLastSeq(roomIdInput?: string): number {
  const rid = roomIdInput ?? activeRoomId;
  return rid ? (rooms.get(rid)?.lastSeq ?? 0) : 0;
}
export function advanceSeq(newSeq: number, roomIdInput?: string): void {
  const rid = roomIdInput ?? activeRoomId;
  if (rid) {
    const st = rooms.get(rid);
    if (st && newSeq > st.lastSeq) st.lastSeq = newSeq;
  }
}
export function getRoomId(): string | null { return activeRoomId; }
export function getMemberToken(roomIdInput?: string): string | null {
  const rid = roomIdInput ?? activeRoomId;
  return rid ? (rooms.get(rid)?.memberToken ?? null) : null;
}
export function getSelfInstanceId(roomIdInput?: string): string | undefined {
  const rid = roomIdInput ?? activeRoomId;
  return rid ? rooms.get(rid)?.selfInstanceId : undefined;
}

/**
 * 用已有 member_token 恢复一个 seat (不创建新成员)。
 * SharedNet 协议: "Every join is a new member" — 每次重新 join 都会产生新 seat,
 * 比赛要求提交的 seat 全程在场, 所以服务重启必须复用同一 seat 的 token。
 */
export async function restore(roomIdInput: string, token: string): Promise<{ lastSeq: number }> {
  rooms.set(roomIdInput, { memberToken: token, lastSeq: 0 });
  activeRoomId = roomIdInput;
  try {
    const page = await read({ order: "desc", limit: 1 }, roomIdInput);
    if (page.items.length > 0) {
      const st = rooms.get(roomIdInput);
      if (st) st.lastSeq = page.items[0].sequence;
    }
  } catch {
    rooms.delete(roomIdInput);
    activeRoomId = rooms.keys().next().value ?? null;
    throw new Error("Seat token restore failed — token invalid or room unreachable");
  }
  return { lastSeq: rooms.get(roomIdInput)?.lastSeq ?? 0 };
}
