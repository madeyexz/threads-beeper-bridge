// Threads <-> Beeper (Matrix) bridge.
//
// This is a minimal Matrix application service. `bbctl proxy` connects it to
// your Beeper account's hungryserv over a websocket and forwards Matrix events
// to this process over localhost HTTP. We:
//   - mirror each Threads DM conversation into a Matrix "portal" room,
//   - stream Threads messages in as ghost users (@sh-threads_<igid>:beeper.local),
//   - relay messages you type in Beeper back to Threads via the private API.
//
// Reads/sends on the Threads side reuse src/threads.mjs (Dia session, no browser).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSession, getInbox, getMessages, sendText } from "./src/threads.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PROFILE = opt("profile", process.env.DIA_PROFILE || "Default");
const PORT = Number(opt("port", process.env.BRIDGE_PORT || 29337));
const SYNC_MS = Number(opt("sync", 4000));
const ONLY = opt("only", ""); // restrict to a single threadId (for testing)

// ---- config from bbctl registration + login -----------------------------
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "registration.json"), "utf8"));
const HS = reg.homeserver_url; // https://matrix.beeper.com/_hungryserv/<username>
const AS_TOKEN = reg.registration.as_token;
const HS_TOKEN = reg.registration.hs_token;
const GHOST_DOMAIN = reg.homeserver_domain; // beeper.local
const BOT = `@${reg.registration.sender_localpart}:${GHOST_DOMAIN}`;
const USER_ID = reg.your_user_id; // @<username>:beeper.com
const bbctlCfg = JSON.parse(
  fs.readFileSync(path.join(process.env.HOME, "Library/Application Support/bbctl/config.json"), "utf8"),
);
const USER_TOKEN = bbctlCfg.environments.prod.access_token; // acts as you (double puppet)
// Room-scoped calls (join/send) go through the hungryserv path (HS). User-global
// data like m.direct must go to the root homeserver instead.
const USER_API_BASE = HS.replace(/\/_hungryserv\/[^/]+$/, "");

const ghostId = (igid) => `@sh-threads_${igid}:${GHOST_DOMAIN}`;

// ---- persistent state ----------------------------------------------------
const STATE_PATH = path.join(ROOT, "bridge-state.json");
let state = { rooms: {}, ghosts: {} }; // rooms[threadId]={roomId,ghost,watermarkTs}; ghosts[igid]={name}
try { state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch {}
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)), 200);
}
const roomToThread = () => Object.fromEntries(Object.entries(state.rooms).map(([t, r]) => [r.roomId, t]));

// echoes of messages we just relayed Beeper->Threads, to avoid re-injecting them
const recentlySent = []; // {threadId, text, at}

// ---- Matrix client-server helpers ---------------------------------------
async function mx(method, apiPath, { token = AS_TOKEN, user, query = {}, body, raw, base = HS } = {}) {
  const q = new URLSearchParams(query);
  if (user) q.set("user_id", user);
  const url = `${base}${apiPath}${q.toString() ? "?" + q : ""}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(raw ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${apiPath} -> ${res.status} ${json.errcode || ""} ${json.error || text.slice(0, 120)}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

// act as a ghost
const asGhost = (ghost, method, p, o = {}) => mx(method, p, { ...o, token: AS_TOKEN, user: ghost });
// act as you, on the hungryserv (room-scoped: join, send)
const asUser = (method, p, o = {}) => mx(method, p, { ...o, token: USER_TOKEN });
// act as you, on the root homeserver (user-global: account data)
const asUserRoot = (method, p, o = {}) => mx(method, p, { ...o, token: USER_TOKEN, base: USER_API_BASE });

// mark a room as a direct 1:1 chat so Beeper lists it under DMs (idempotent)
async function markDirect(entry) {
  if (entry.dmMarked) return;
  const p = `/_matrix/client/v3/user/${encodeURIComponent(USER_ID)}/account_data/m.direct`;
  let map = {};
  try {
    map = await asUserRoot("GET", p);
  } catch (e) {
    if (e.status !== 404) { log("m.direct get", e.message); return; } // avoid clobbering other bridges' DMs
  }
  if (!map || typeof map !== "object" || map._raw) map = {};
  if ((map[entry.ghost] || []).includes(entry.roomId)) { entry.dmMarked = true; saveState(); return; }
  map[entry.ghost] = Array.from(new Set([...(map[entry.ghost] || []), entry.roomId]));
  try {
    await asUserRoot("PUT", p, { body: map });
    entry.dmMarked = true;
    saveState();
  } catch (e) { log("m.direct put", e.message); }
}

async function registerGhost(igid) {
  // appservice user registration; idempotent (M_USER_IN_USE means already done)
  try {
    await mx("POST", "/_matrix/client/v3/register", {
      body: { type: "m.login.application_service", username: `sh-threads_${igid}` },
    });
  } catch (e) {
    if (!/M_USER_IN_USE|already in use/i.test(e.message)) log("register ghost", e.message);
  }
}

async function ensureGhost(igid, name, avatarUrl) {
  const ghost = ghostId(igid);
  const g = state.ghosts[igid] || {};
  if (!g.registered) { await registerGhost(igid); g.registered = true; state.ghosts[igid] = g; }
  if (g.name !== name) {
    try {
      await mx("PUT", `/_matrix/client/v3/profile/${encodeURIComponent(ghost)}/displayname`, {
        user: ghost, body: { displayname: name },
      });
      g.name = name;
    } catch (e) { log("displayname", e.message); }
  }
  if (!g.avatar && avatarUrl) {
    const mxc = await uploadAvatarTyped(ghost, avatarUrl);
    if (mxc) {
      try {
        await mx("PUT", `/_matrix/client/v3/profile/${encodeURIComponent(ghost)}/avatar_url`, {
          user: ghost, body: { avatar_url: mxc },
        });
        g.avatar = mxc;
      } catch (e) { log("avatar", e.message); }
    }
  }
  state.ghosts[igid] = g;
  saveState();
  return ghost;
}

// upload with correct image content-type
async function uploadAvatarTyped(ghost, url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    const res = await fetch(
      `${HS}/_matrix/media/v3/upload?filename=avatar.jpg&user_id=${encodeURIComponent(ghost)}`,
      { method: "POST", headers: { Authorization: "Bearer " + AS_TOKEN, "content-type": ct }, body: buf },
    );
    if (!res.ok) return null;
    return (await res.json()).content_uri || null;
  } catch { return null; }
}

// m.bridge content in the shape Beeper's own bridges use. Beeper Desktop links a
// chat to an account through channel["fi.mau.receiver"], and shows it as a 1:1
// chat when com.beeper.room_type is "dm".
const bridgeStateKey = (thread) => `threads://${thread.threadId}`;
function bridgeInfo(thread) {
  return {
    bridgebot: BOT,
    creator: BOT,
    protocol: { id: "sh-threads", displayname: "Threads", external_url: "https://www.threads.com" },
    channel: { id: thread.threadId, displayname: thread.name, "fi.mau.receiver": session?.dsUserId || "" },
    "com.beeper.bridge_name": "sh-threads",
    "com.beeper.room_type": thread.threadType === "ONE_TO_ONE" ? "dm" : "group",
    "com.beeper.room_type.v2": thread.threadType === "ONE_TO_ONE" ? "dm" : "group",
  };
}

// Tell Beeper the Threads login is connected. Beeper drops the state after
// `ttl` seconds, so this repeats on a timer.
async function reportConnected() {
  const s = session;
  if (!s) return;
  try {
    const r = await fetch(`https://api.beeper.com/bridgebox/${USER_ID.slice(1).split(":")[0]}/bridge/sh-threads/bridge_remote_state`, {
      method: "POST",
      headers: { Authorization: "Bearer " + AS_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({
        state_event: "CONNECTED", timestamp: Math.floor(Date.now() / 1000), ttl: 3600, source: "bridge",
        user_id: USER_ID, remote_id: s.dsUserId, remote_name: "Threads",
      }),
    });
    if (!r.ok) log("bridge state", r.status, (await r.text()).slice(0, 120));
  } catch (e) { log("bridge state", e.message); }
}

async function ensureRoom(thread) {
  const igid = thread.otherIgid || thread.threadId;
  const ghost = await ensureGhost(igid, thread.name, thread.avatar);
  let entry = state.rooms[thread.threadId];
  if (entry && entry.roomId) {
    await markDirect(entry);
    if (!entry.bridgeInfoV2) {
      try {
        await asGhost(entry.ghost, "PUT",
          `/_matrix/client/v3/rooms/${encodeURIComponent(entry.roomId)}/state/m.bridge/${encodeURIComponent(bridgeStateKey(thread))}`,
          { body: bridgeInfo(thread) });
        entry.bridgeInfoV2 = true;
        saveState();
      } catch (e) { log("update m.bridge", e.message); }
    }
    return entry;
  }
  const created = await mx("POST", "/_matrix/client/v3/createRoom", {
    user: ghost,
    body: {
      is_direct: true,
      preset: "trusted_private_chat",
      invite: [USER_ID],
      // No room name or topic: Beeper then names a DM after the other person and
      // draws it as a 1:1 chat. A named room renders with the group avatar style.
      creation_content: { "m.federate": false },
      initial_state: [
        { type: "m.bridge", state_key: bridgeStateKey(thread), content: bridgeInfo(thread) },
      ],
    },
  });
  const roomId = created.room_id;
  entry = { roomId, ghost, igid, watermarkTs: 0 };
  state.rooms[thread.threadId] = entry;
  saveState();
  // join as you, and mark as a direct chat so Beeper shows it as a 1:1
  try { await asUser("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`); } catch (e) { log("self-join", e.message); }
  await markDirect(entry);
  log("created room", roomId, "for", thread.name);
  return entry;
}

const BRIDGED_KEY = "dev.threads-bridge.message_id";
const sanitizeTxn = (s) => "thr-" + String(s).replace(/[^a-zA-Z0-9]/g, "_");

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// A shared Threads post becomes a message with just the post link (plus any note
// the sender added), and a com.beeper.linkpreviews card that shows the author,
// text, counts and image. Without a link, the post text goes in the body instead.
async function shareContent(s) {
  const head = s.author ? `@${s.author}` : "Threads post";
  if (!s.url) {
    return { msgtype: "m.text", body: [s.note, `${head}: ${s.caption}`.trim(), s.subtitle].filter(Boolean).join("\n") };
  }
  const content = {
    msgtype: "m.text",
    body: [s.note, s.url].filter(Boolean).join("\n"),
    format: "org.matrix.custom.html",
    formatted_body: (s.note ? `${escapeHtml(s.note)}<br>` : "") + `<a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a>`,
  };
  {
    const preview = {
      matched_url: s.url,
      "og:url": s.url,
      "og:title": `${head} on Threads`,
      "og:description": [s.caption.slice(0, 300), s.subtitle].filter(Boolean).join("\n\n"),
    };
    const img = s.image ? await uploadMedia(BOT, s.image) : null;
    if (img) {
      preview["og:image"] = img.mxc;
      preview["og:image:type"] = img.type;
      preview["matrix:image:size"] = img.size;
    }
    content["com.beeper.linkpreviews"] = [preview];
  }
  return content;
}

async function uploadMedia(user, url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    const res = await fetch(
      `${HS}/_matrix/media/v3/upload?filename=preview.jpg&user_id=${encodeURIComponent(user)}`,
      { method: "POST", headers: { Authorization: "Bearer " + AS_TOKEN, "content-type": type }, body: buf },
    );
    if (!res.ok) return null;
    return { mxc: (await res.json()).content_uri, type, size: buf.length };
  } catch { return null; }
}

async function injectMessage(entry, thread, m) {
  const content = m.text
    ? { msgtype: "m.text", body: m.text }
    : m.share
      ? await shareContent(m.share)
      : { msgtype: "m.notice", body: `[${(m.type || "attachment").toLowerCase()} — open in Threads]` };
  // Marks events that came from Threads, so handleEvent never sends them back.
  content[BRIDGED_KEY] = m.id;
  const txn = sanitizeTxn(m.id);
  if (m.mine) {
    // your own message (sent from Threads app or the web client) -> show as you
    // skip if this is the echo of something you just sent from Beeper
    const echo = recentlySent.find(
      (r) => r.threadId === thread.threadId && r.text === m.text && m.timestampMs >= r.at - 1000,
    );
    if (echo) return;
    // Double puppet like official bridges: the AS token acting as you, tagged so
    // Beeper doesn't wait for the bridge to deliver it, with the real timestamp.
    content["fi.mau.double_puppet_source"] = "sh-threads";
    try {
      await mx("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(entry.roomId)}/send/m.room.message/${txn}`, {
        user: USER_ID, body: content, query: { ts: String(m.timestampMs || Date.now()) },
      });
    } catch (e) { log("send(me)", e.message); }
  } else {
    try {
      await asGhost(entry.ghost, "PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(entry.roomId)}/send/m.room.message/${txn}`, {
        body: content, query: { ts: String(m.timestampMs || Date.now()) },
      });
    } catch (e) { log("send(them)", e.message); }
  }
}

// ---- Threads session (auto-refresh) -------------------------------------
let session = null, sessionAt = 0;
async function getSession(force = false) {
  if (force || !session || Date.now() - sessionAt > 20 * 60 * 1000) {
    session = await makeSession(PROFILE);
    sessionAt = Date.now();
  }
  return session;
}
async function withSession(fn) {
  try { return await fn(await getSession()); }
  catch { return await fn(await getSession(true)); }
}

// ---- sync loop -----------------------------------------------------------
let syncing = false;
let rateLimitedUntil = 0;
let rateLimitBackoff = 0;
let lastRebuildAt = 0;

// Messages keep the timestamp they were sent with, so rooms copied with wrong
// times can only be fixed by copying them again into a new room. Rooms marked
// `rebuild` get a new room with the real times; the old room is then removed.
async function rebuildRoom(thread, old, msgs) {
  delete state.rooms[thread.threadId];
  const fresh = await ensureRoom(thread);
  for (const m of msgs) await injectMessage(fresh, thread, m);
  if (msgs.length) fresh.watermarkTs = Math.max(...msgs.map((m) => m.timestampMs));
  fresh.backfilled = true;
  fresh.bridgeInfoV2 = true;
  saveState();
  await retireRoom(old);
  log("rebuilt room for", thread.name, old.roomId, "->", fresh.roomId);
}

async function retireRoom(old) {
  const room = encodeURIComponent(old.roomId);
  try { await mx("POST", `/_matrix/client/v3/rooms/${room}/leave`, { user: USER_ID, body: {} }); } catch (e) { log("leave(me)", e.message); }
  try { await mx("POST", `/_matrix/client/v3/rooms/${room}/forget`, { user: USER_ID, body: {} }); } catch (e) { log("forget", e.message); }
  try { await asGhost(old.ghost, "POST", `/_matrix/client/v3/rooms/${room}/leave`, { body: {} }); } catch (e) { log("leave(ghost)", e.message); }
  // drop the old room from m.direct; on a read error, leave the map alone
  const p = `/_matrix/client/v3/user/${encodeURIComponent(USER_ID)}/account_data/m.direct`;
  try {
    const map = await asUserRoot("GET", p);
    if (map[old.ghost]) {
      map[old.ghost] = map[old.ghost].filter((r) => r !== old.roomId);
      await asUserRoot("PUT", p, { body: map });
    }
  } catch (e) { log("m.direct cleanup", e.message); }
}

async function syncOnce() {
  if (syncing) return;
  syncing = true;
  try {
    let inbox = await withSession((s) => getInbox(s));
    if (ONLY) inbox = inbox.filter((t) => t.threadId === ONLY);
    for (const thread of inbox) {
      const entry = await ensureRoom(thread);
      // Only fetch a thread's messages when it has new activity. The inbox's
      // per-thread timestamp already tells us that, so steady state costs one
      // inbox call per cycle instead of a full history fetch per conversation.
      // (Threads rate-limits the message query hard: code 1675004.)
      // A room with an existing watermark was already backfilled in a prior run.
      const needBackfill = !entry.backfilled && !(entry.watermarkTs > 0);
      const hasNewActivity = (thread.timestampMs || 0) > (entry.watermarkTs || 0);
      const rebuild = entry.rebuild && Date.now() - lastRebuildAt > 60000; // one room per minute
      if (!needBackfill && !hasNewActivity && !rebuild) { entry.backfilled = true; continue; }
      if (Date.now() < rateLimitedUntil) continue; // cooling off; retry next cycle
      let msgs;
      try {
        msgs = await withSession((s) => getMessages(s, thread.threadId, 0));
      } catch (e) {
        if (/Rate limit|1675004/.test(e.message)) {
          // Retrying while still limited extends the penalty, so back off exponentially.
          rateLimitBackoff = Math.min((rateLimitBackoff || 30000) * 2, 60 * 60 * 1000);
          rateLimitedUntil = Date.now() + rateLimitBackoff;
          log(`rate limited by Threads; pausing message fetches ${rateLimitBackoff / 1000}s`);
          break;
        }
        throw e;
      }
      rateLimitBackoff = 0;
      if (rebuild) {
        lastRebuildAt = Date.now();
        await rebuildRoom(thread, entry, msgs);
        continue;
      }
      const newMsgs = msgs.filter((m) => m.timestampMs > (entry.watermarkTs || 0));
      for (const m of newMsgs) await injectMessage(entry, thread, m);
      if (msgs.length) {
        entry.watermarkTs = Math.max(entry.watermarkTs || 0, ...msgs.map((m) => m.timestampMs));
      }
      entry.backfilled = true;
      saveState();
    }
    // prune old echo records
    const cutoff = Date.now() - 120000;
    for (let i = recentlySent.length - 1; i >= 0; i--) if (recentlySent[i].at < cutoff) recentlySent.splice(i, 1);
  } catch (e) {
    log("sync error:", e.message);
  } finally {
    syncing = false;
  }
}

// ---- outgoing: Matrix event (you typed in Beeper) -> Threads -------------
async function handleEvent(ev) {
  if (ev.type !== "m.room.message") return;
  if (ev.sender !== USER_ID) return; // only relay your own messages
  const threadId = roomToThread()[ev.room_id];
  if (!threadId) return;
  const content = ev.content || {};
  if (content["m.relates_to"] && content["m.relates_to"]["rel_type"] === "m.replace") return; // ignore edits
  const text = content.body;
  if (!text || content.msgtype === "m.notice") return;
  // The bridge also posts as you (your Threads messages). Skip those: they already exist on Threads.
  if (content[BRIDGED_KEY] || content["fi.mau.double_puppet_source"]) return;
  try {
    recentlySent.push({ threadId, text, at: Date.now() });
    await withSession((s) => sendText(s, threadId, text));
    log("relayed to Threads:", threadId, JSON.stringify(text).slice(0, 40));
    await sendStatus(ev.room_id, ev.event_id, "SUCCESS");
    setTimeout(syncOnce, 800);
  } catch (e) {
    log("relay error:", e.message);
    await sendStatus(ev.room_id, ev.event_id, "FAIL_RETRIABLE", e.message);
  }
}

// Report delivery of a Beeper message, so Beeper shows it as sent (or failed).
async function sendStatus(roomId, eventId, status, message) {
  const body = {
    "m.relates_to": { rel_type: "m.reference", event_id: eventId },
    network: "sh-threads", status, ...(message ? { message } : {}),
  };
  try {
    await mx("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/com.beeper.message_send_status/st-${Date.now()}-${Math.random().toString(36).slice(2)}`, { user: BOT, body });
  } catch (e) { log("send status", e.message); }
}

// ---- appservice HTTP server ---------------------------------------------
function readBody(req) {
  return new Promise((resolve) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => resolve(s)); });
}
function reqToken(req, url) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return url.searchParams.get("access_token") || "";
}

const seenTxns = new Set();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const ok = (obj = {}) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    // transaction push (modern + legacy paths)
    const txMatch = p.match(/\/(?:_matrix\/app\/v1\/)?transactions\/([^/]+)$/);
    if (req.method === "PUT" && txMatch) {
      if (reqToken(req, url) !== HS_TOKEN) { res.writeHead(403); return res.end(JSON.stringify({ errcode: "M_FORBIDDEN" })); }
      const txnId = decodeURIComponent(txMatch[1]);
      const raw = await readBody(req);
      if (!seenTxns.has(txnId)) {
        seenTxns.add(txnId);
        if (seenTxns.size > 2000) seenTxns.clear();
        let data = {};
        try { data = JSON.parse(raw || "{}"); } catch {}
        for (const ev of data.events || []) handleEvent(ev).catch((e) => log("handleEvent", e.message));
      }
      return ok({});
    }
    // user / room existence queries -> claim everything in our namespace exists
    if (req.method === "GET" && /\/(?:_matrix\/app\/v1\/)?(users|rooms)\//.test(p)) {
      if (reqToken(req, url) !== HS_TOKEN) { res.writeHead(403); return res.end("{}"); }
      return ok({});
    }
    if (p.endsWith("/ping")) return ok({});
    if (p === "/" || p === "/health") return ok({ ok: true, rooms: Object.keys(state.rooms).length });
    res.writeHead(404); res.end("{}");
  } catch (e) {
    log("http error", e.message);
    res.writeHead(500); res.end(JSON.stringify({ errcode: "M_UNKNOWN", error: e.message }));
  }
});

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

server.listen(PORT, "127.0.0.1", async () => {
  log(`Threads->Beeper bridge on http://localhost:${PORT}`);
  log(`  you=${USER_ID} bot=${BOT} ghosts=@sh-threads_*:${GHOST_DOMAIN}`);
  try {
    await getSession();
    log("Threads session OK (Dia profile", PROFILE + ")");
  } catch (e) {
    log("Threads session FAILED:", e.message, "- open threads.com in Dia and sign in.");
  }
  reportConnected();
  setInterval(reportConnected, 15 * 60 * 1000);
  syncOnce();
  setInterval(syncOnce, SYNC_MS);
});
