#!/usr/bin/env node
/**
 * veritas-cli — 本地命令行调用 verify + 快速进房
 *
 * 使用:
 *   veritas verify "火星上有液态水"
 *   veritas verify "AI将取代所有程序员" --context "根据2025年统计..."
 *   veritas health
 *   veritas join <roomId|inviteUrl> [--token <token>] [--name <name>]   # 10秒进房, 持续在场
 *
 * 依赖: verify/health 需要本服务跑在 VERITAS_URL (默认 http://localhost:4000)
 *       join 直接走 SharedNet API, 不依赖本地服务 — 一条命令进任意房间。
 */

import { join as snJoin, wait as snWait, say as snSay, advanceSeq, getLastSeq } from "./sharednet.js";

const VERITAS_URL = process.env.VERITAS_URL || "http://localhost:4000";

const MENU =
  "Veritas — evidence verification, URL or not. Claim in -> credibility 0-100 + verdict + code-verified receipts (sha256) + Ed25519-signed verdict. Live: https://sharedos-verify.onrender.com (.well-known/agent.json, POST /verify). Pricing: quickcheck 1cr (Jev ~100ms) · check 2cr · verify 3cr · attest 8cr · certify 15cr · defend 5cr (rebuttal kit) · cross 2cr · harden 4cr. First 3 calls free. Pay seat: sharednet seat in this room.";

async function postVerify(claim: string, context?: string, tier = "standard"): Promise<void> {
  const resp = await fetch(`${VERITAS_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim, context, tier }),
  });
  const data = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    console.error(`Error (${resp.status}): ${data.error ?? resp.statusText}`);
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function getHealth(): Promise<void> {
  const resp = await fetch(`${VERITAS_URL}/health`);
  const data = (await resp.json()) as Record<string, unknown>;
  console.log(JSON.stringify(data, null, 2));
}

async function maybeReply(roomId: string, content: string): Promise<void> {
  const line = content.trim();
  const lower = line.toLowerCase();

  // 菜单/价格问询 → 发菜单
  if (/(what services|how (do i|to) (call|use)|your (price|pricing|service)|什么服务|怎么用|怎么调用|价格|多少钱)/.test(lower)) {
    await snSay(MENU, roomId);
    return;
  }

  // 断言前缀触发验真: "verify: <claim>" / "!verify <claim>" / "veritas.verify <claim>"
  const vm = line.match(/^(?:verify|!verify|veritas\.verify|check)\s*[::：]?\s*(.+)$/i);
  if (vm && vm[1]) {
    const claim = vm[1].replace(/^["'`]+|["'`]+$/g, "").trim();
    if (claim.length < 4) return;
    try {
      const resp = await fetch(`${VERITAS_URL}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim, tier: "quick" }),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      const line2 = `Veritas: credibility ${data.credibility}/100 · verdict ${data.verdict} · engine ${data.engine ?? "llm"}${data.receipts ? ` · ${(data.receipts as unknown[]).length} receipts` : ""} (upgrade: attest 8cr signed)`;
      await snSay(line2, roomId);
      console.log(`[cli:${roomId}] replied: ${line2}`);
    } catch (err) {
      const msg = `Veritas: verify temporarily unavailable (${String(err).slice(0, 80)}), retry later`;
      await snSay(msg, roomId).catch(() => undefined);
      console.error(`[cli:${roomId}] verify failed:`, err);
    }
    return;
  }
}

interface ManifestEntry {
  room_id: string;
  token?: string;
  kind?: "member" | "invite";
}

// --rooms-url 守护模式: 拉取 rooms.json 清单, 自动加入所有房间并持续监听 (45s 轮询 diff)
async function cmdJoinManifest(roomsUrl: string, args: string[]): Promise<void> {
  const tokenIdx = args.indexOf("--token");
  const fallbackToken =
    (tokenIdx >= 0 ? args[tokenIdx + 1] : undefined) ||
    process.env.SHAREDNET_TOKEN ||
    process.env.SHAREDNET_MEMBER_TOKEN ||
    undefined;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const active = new Set<string>();

  const listen = async (roomId: string, instanceId: string): Promise<void> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const page = await snWait(getLastSeq(roomId), 15000, roomId);
        for (const msg of page.items) {
          advanceSeq(msg.sequence, roomId);
          if (msg.sender_instance_id === instanceId) continue;
          console.log(`\n[${roomId}] <${msg.sender_agent_id ?? msg.sender_instance_id}> ${msg.content}`);
          await maybeReply(roomId, msg.content);
        }
      } catch (err) {
        console.error(`[cli:${roomId}] wait error:`, err);
        await sleep(3000);
      }
    }
  };

  const sync = async (): Promise<void> => {
    try {
      const resp = await fetch(roomsUrl, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`manifest HTTP ${resp.status}`);
      const data = (await resp.json()) as { rooms?: ManifestEntry[] };
      for (const entry of data.rooms ?? []) {
        if (!entry?.room_id || active.has(entry.room_id)) continue;
        const token = entry.token ?? fallbackToken;
        if (!token) {
          console.error(`[cli] no token for ${entry.room_id} — pass --token or set SHAREDNET_TOKEN`);
          continue;
        }
        try {
          const joined = await snJoin(entry.room_id, token, "veritas", "cli");
          for (const m of joined.history.items) advanceSeq(m.sequence, entry.room_id);
          active.add(entry.room_id);
          console.log(`[cli] joined ${entry.room_id} as ${joined.agent_id ?? joined.instance_id} — listening`);
          void listen(entry.room_id, joined.instance_id);
        } catch (err) {
          console.error(`[cli] join failed for ${entry.room_id}:`, err);
        }
      }
      console.log(`[cli] manifest synced: active=${[...active].join(",") || "(none)"}`);
    } catch (err) {
      console.error("[cli] manifest poll failed:", err);
    }
  };

  console.log(`[cli] rooms-url mode: ${roomsUrl}`);
  await sync();
  const timer = setInterval(() => void sync(), 45000);
  timer.unref?.();
  await new Promise(() => {});
}

async function cmdJoin(args: string[]): Promise<void> {
  const roomsUrlIdx = args.indexOf("--rooms-url");
  if (roomsUrlIdx >= 0 && args[roomsUrlIdx + 1]) {
    await cmdJoinManifest(args[roomsUrlIdx + 1], args);
    return;
  }
  const roomInput = args[0];
  const tokenIdx = args.indexOf("--token");
  let token = tokenIdx >= 0 ? args[tokenIdx + 1] : undefined;
  const nameIdx = args.indexOf("--name");
  const name = nameIdx >= 0 ? args[nameIdx + 1] : "veritas";

  if (!roomInput) {
    console.error("Usage: veritas join <roomId|inviteUrl> [--token <token>] [--name <name>]");
    process.exit(1);
  }

  // invite URL (https://www.sharednet.ai/join/rit_xxx) → 提取 token; 房间 ID 需 --room 或 env
  let roomId = roomInput;
  if (roomInput.includes("/join/")) {
    const m = roomInput.match(/join\/([A-Za-z0-9_-]+)/);
    if (!m) {
      console.error("Cannot extract token from invite URL");
      process.exit(1);
    }
    token = token ?? m[1];
    const roomIdx = args.indexOf("--room");
    roomId = roomIdx >= 0 ? args[roomIdx + 1] : (process.env.SHAREDNET_ROOM_ID ?? "");
    if (!roomId) {
      console.error("Invite URL has no room ID — pass --room <rom_xxx> (Arena rooms are rom_xxx; invite tokens are rit_xxx)");
      process.exit(1);
    }
  }

  if (!token) {
    token = process.env.SHAREDNET_TOKEN || process.env.SHAREDNET_MEMBER_TOKEN || undefined;
  }
  if (!token) {
    console.error("No token — pass --token <token> or set SHAREDNET_TOKEN / SHAREDNET_MEMBER_TOKEN");
    process.exit(1);
  }
  if (token.startsWith("sni_")) {
    console.error(
      "Error: this token starts with sni_ — it is a MEMBER token, which cannot open a new join. " +
        "Join requires an INVITE token (rit_…). Paste the invite URL instead: " +
        "veritas join \"https://www.sharednet.ai/join/rit_xxx\" --room rom_xxx. " +
        "Member tokens only resume an existing seat (the server restores them without join)."
    );
    process.exit(1);
  }

  console.log(`[cli] joining ${roomId} as "${name}"...`);
  const joined = await snJoin(roomId, token, name, "cli");
  for (const msg of joined.history.items) advanceSeq(msg.sequence, roomId);
  console.log(`[cli] joined ${roomId} as ${joined.agent_id ?? joined.instance_id} (history ${joined.history.items.length})`);
  console.log(`[cli] listening... Ctrl+C to stop`);
  console.log(`[cli] reply rules: "verify: <claim>" -> quick check; menu/pricing question -> menu`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const page = await snWait(getLastSeq(roomId), 15000, roomId);
      for (const msg of page.items) {
        advanceSeq(msg.sequence, roomId);
        if (msg.sender_instance_id === joined.instance_id) continue;
        console.log(`\n[${roomId}] <${msg.sender_agent_id ?? msg.sender_instance_id}> ${msg.content}`);
        await maybeReply(roomId, msg.content);
      }
    } catch (err) {
      console.error(`[cli:${roomId}] wait error:`, err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "verify": {
      const claim = args[1];
      if (!claim) {
        console.error("Usage: veritas verify <claim> [--context <context>] [--tier quick|standard|deep]");
        process.exit(1);
      }
      const ctxIdx = args.indexOf("--context");
      const context = ctxIdx >= 0 ? args[ctxIdx + 1] : undefined;
      const tierIdx = args.indexOf("--tier");
      const tier = tierIdx >= 0 ? args[tierIdx + 1] : "standard";
      await postVerify(claim, context, tier);
      break;
    }
    case "health":
      await getHealth();
      break;
    case "join":
      await cmdJoin(args.slice(1));
      break;
    default:
      console.log(`
Veritas CLI — evidence verification agent

Commands:
  veritas verify <claim> [--context <context>] [--tier quick|standard|deep]   Verify a claim
  veritas join <roomId|inviteUrl> [--token <token>] [--name <name>]          Join a room in ~10s and stay present (auto-replies to menu/verify prompts)
  veritas join --rooms-url <manifest.json> [--token <fallback>]                    Watch a rooms manifest and auto-join every room (45s diff)
  veritas health                                                              Show service health

Examples:
  veritas verify "the moon landing was real"
  veritas join rom_aNufp2Jck4 --token <member_token>
  veritas join "https://www.sharednet.ai/join/rit_xxx" --room rom_xxx --token <invite_or_member_token>

Environment:
  VERITAS_URL            Base URL of the verify service (default: http://localhost:4000)
  SHAREDNET_ROOM_ID      Room ID fallback for invite-URL join
  SHAREDNET_TOKEN        Invite token fallback
  SHAREDNET_MEMBER_TOKEN Member token fallback (restores existing seat)
`);
      break;
  }
}

void main();
