// Threads DM backend: reads session from Dia cookies, scrapes CSRF/session
// tokens from the Threads HTML, and talks to the private /api/graphql endpoint.
// No browser required at runtime.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// GraphQL persisted-query doc ids (captured from the live threads.com web app).
export const DOC = {
  inbox: "29390492723918047", // BarcelonaMessagesThreadListMailboxQuery
  thread: "28623612603984520", // BarcelonaMessageListContainerQuery
  sendText: "40526421710289382", // WmiSlideTextMessageMutation
};

// ---- cookie decryption (Chromium/Dia on macOS) --------------------------

function diaCookieDb(profile = "Default") {
  return path.join(
    os.homedir(),
    "Library/Application Support/Dia/User Data",
    profile,
    "Cookies",
  );
}

function safeStorageKey() {
  return execFileSync("security", [
    "find-generic-password",
    "-w",
    "-s",
    "Dia Safe Storage",
  ])
    .toString()
    .trim();
}

function decryptValue(hex, derivedKey) {
  const buf = Buffer.from(hex, "hex");
  const tag = buf.slice(0, 3).toString();
  if (tag !== "v10" && tag !== "v11") return buf.toString("utf8");
  const iv = Buffer.alloc(16, " ");
  const d = crypto.createDecipheriv("aes-128-cbc", derivedKey, iv);
  d.setAutoPadding(false);
  let out = Buffer.concat([d.update(buf.slice(3)), d.final()]);
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.slice(0, out.length - pad);
  // Newer Chromium prepends a 32-byte SHA256 domain hash to the plaintext.
  const printable = out.slice(0, 32).every((b) => b >= 0x20 && b < 0x7f);
  if (!printable && out.length > 32) out = out.slice(32);
  return out.toString("utf8");
}

export function loadCookieHeader(profile = "Default", hostFilter = "threads.com") {
  const db = diaCookieDb(profile);
  const tmp = path.join(os.tmpdir(), `tc-ck-${Date.now()}.db`);
  fs.copyFileSync(db, tmp);
  let rows;
  try {
    rows = execFileSync("sqlite3", [
      tmp,
      "-separator",
      "\t",
      `SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%${hostFilter}'`,
    ])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
  } finally {
    fs.unlinkSync(tmp);
  }
  const derivedKey = crypto.pbkdf2Sync(safeStorageKey(), "saltysalt", 1003, 16, "sha1");
  const pairs = rows.map((line) => {
    const [name, hex] = line.split("\t");
    return `${name}=${decryptValue(hex, derivedKey)}`;
  });
  return pairs.join("; ");
}

// ---- token scraping ------------------------------------------------------

function pick(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

// jazoest is a trivial checksum of fb_dtsg the web app computes client-side.
function jazoest(dtsg) {
  let sum = 0;
  for (const ch of dtsg) sum += ch.charCodeAt(0);
  return "2" + sum;
}

export async function makeSession(profile = "Default") {
  const cookie = loadCookieHeader(profile);
  const res = await fetch("https://www.threads.com/", {
    headers: { cookie, "user-agent": UA },
  });
  const html = await res.text();

  const dtsg =
    pick(html, /"DTSGInitData",\[\],\{"token":"([^"]+)"/) ||
    pick(html, /"dtsg":\{"token":"([^"]+)"/);
  const lsd =
    pick(html, /"LSD",\[\],\{"token":"([^"]+)"/) || pick(html, /"lsd":"([^"]+)"/);
  const rev =
    pick(html, /"__spin_r":(\d+)/) || pick(html, /"rev":(\d{7,})/);
  const av =
    pick(html, /"actorID":"(\d+)"/) ||
    pick(html, /"NON_FACEBOOK_USER_ID":"(\d+)"/);
  const spinT = pick(html, /"__spin_t":(\d+)/) || String(Math.floor(Date.now() / 1000));

  if (!dtsg || !lsd || !av) {
    throw new Error(
      "Not logged in to Threads in Dia (missing tokens). Open threads.com in Dia and sign in.",
    );
  }
  // ds_user_id (Instagram id) identifies "me"; it equals each member's `igid`.
  const dsUserId = (cookie.match(/(?:^|;\s*)ds_user_id=([0-9]+)/) || [])[1] || "";
  return { cookie, dtsg, lsd, rev: rev || "", av, dsUserId, spinT, jazoest: jazoest(dtsg) };
}

// ---- graphql -------------------------------------------------------------

const PROVIDERS_READ = {
  __relay_internal__pv__BarcelonaIsMicgThreadOffProxyEnabledrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagesHasLiveChatMessagingrelayprovider: true,
  __relay_internal__pv__BarcelonaHasWebFaviconsrelayprovider: true,
  __relay_internal__pv__BarcelonaHasLiveChatHostlessUIrelayprovider: true,
  __relay_internal__pv__BarcelonaLiveChatHasPostChatUpsellrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagesHasFastFollowsrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagesHasLiveChatQnArelayprovider: true,
  __relay_internal__pv__BarcelonaMessagesHasSnippetUnreadMessageCountrelayprovider: false,
  __relay_internal__pv__BarcelonaMessagingHasMetaAIBotrelayprovider: true,
};

export async function gql(session, { docId, name, variables }) {
  const body = new URLSearchParams({
    av: session.av,
    __user: "0",
    __a: "1",
    __comet_req: "29",
    dpr: "2",
    fb_dtsg: session.dtsg,
    jazoest: session.jazoest,
    lsd: session.lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: name,
    server_timestamps: "true",
    variables: JSON.stringify(variables),
    doc_id: docId,
  });
  const res = await fetch("https://www.threads.com/api/graphql", {
    method: "POST",
    headers: {
      cookie: session.cookie,
      "user-agent": UA,
      "content-type": "application/x-www-form-urlencoded",
      "x-fb-lsd": session.lsd,
      "x-fb-friendly-name": name,
      origin: "https://www.threads.com",
      referer: "https://www.threads.com/messages",
      "sec-fetch-site": "same-origin",
    },
    body,
  });
  const text = await res.text();
  // Threads prefixes JSON with "for (;;);" sometimes; strip it.
  const clean = text.replace(/^for \(;;\);/, "");
  let json;
  try {
    json = JSON.parse(clean);
  } catch {
    throw new Error(`GraphQL ${name} returned non-JSON (HTTP ${res.status}): ${clean.slice(0, 200)}`);
  }
  if (json.errors) throw new Error(`GraphQL ${name}: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json;
}

// ---- high-level API ------------------------------------------------------

export async function getInbox(session) {
  const json = await gql(session, {
    docId: DOC.inbox,
    name: "BarcelonaMessagesThreadListMailboxQuery",
    variables: {
      device_id_for_iris_subscription: crypto.randomUUID(),
      folder: "INBOX",
      is_filtered: false,
      tags: [],
      ...PROVIDERS_READ,
    },
  });
  const edges =
    json?.data?.get_slide_mailbox_for_iris_subscription?.threads_by_folder?.edges || [];
  return edges.map((e) => {
    const n = e.node;
    const members = (n.members?.nodes || []).map((m) => m.as_micg_interface).filter(Boolean);
    const other =
      members.find((m) => m.igid && m.igid !== session.dsUserId) || members[0] || {};
    return {
      threadId: n.id,
      name: other.name || other.username || "Unknown",
      username: other.username || "",
      avatar: other.profile_pic_uri || "",
      otherIgid: other.igid || "",
      threadType: n.as_micg_interface?.thread_type || "",
      timestampMs: Number(n.as_micg_interface?.timestamp_ms || 0),
      unread: !!n.as_micg_interface?.is_unread,
    };
  });
}

export async function getMessages(session, threadId, minSeqId = 0) {
  const json = await gql(session, {
    docId: DOC.thread,
    name: "BarcelonaMessageListContainerQuery",
    variables: {
      min_uq_seq_id: minSeqId,
      thread_fbid: String(threadId),
      ...PROVIDERS_READ,
    },
  });
  const edges = json?.data?.get_slide_thread?.messages?.edges || [];
  return edges
    .map((e) => e.node)
    .map((n) => {
      const mi = n.as_micg_interface || n;
      const senderIgid = mi.sender?.user_dict?.id || mi.sender?.igid || "";
      return {
        id: n.id,
        type: n.content_type,
        senderName: mi.sender?.name || "",
        text: n.content?.text_body ?? mi.content?.text_body ?? "",
        share: parseShare(n.content || mi.content),
        timestampMs: Number(n.timestamp_ms || mi.timestamp_ms || 0),
        mine: senderIgid === session.dsUserId,
      };
    })
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

// A shared post (content_type TEXT_POST_APP_LINK_XMA) carries a preview card
// in `xma` and the full post in `threads_post_json`.
export function parseShare(c) {
  if (!c?.xma) return null;
  let post = null;
  try { post = JSON.parse(c.threads_post_json || "null"); } catch {}
  const author = c.xma.header_title_text || post?.user?.username || "";
  const url = post?.code && author
    ? `https://www.threads.com/@${author}/post/${post.code}`
    : c.xma.target_url || "";
  return {
    author,
    caption: c.xma.caption_body_text || post?.caption?.text || c.xma.title_text || "",
    subtitle: c.xma.subtitle_text || "",
    // Text-only posts have no preview image; fall back to the author's photo.
    image: c.xma.preview_image?.url || c.xma.header_icon?.url || post?.user?.profile_pic_url || "",
    url,
    note: c.xma_text_body || c.threads_post_share_text_body || "",
  };
}

// Meta offline-threading-id: (timestamp_ms << 22) | 22 random bits.
function offlineThreadingId() {
  const ts = BigInt(Date.now());
  const rand = BigInt(Math.floor(Math.random() * 2 ** 22));
  return ((ts << 22n) | rand).toString();
}

export async function sendText(session, threadId, text) {
  const json = await gql(session, {
    docId: DOC.sendText,
    name: "WmiSlideTextMessageMutation",
    variables: {
      text_body: text,
      recipient_fbids: [],
      thread_fbid: String(threadId),
      offline_threading_id: offlineThreadingId(),
      replied_to_message_id: null,
      forwarded_message_id: null,
      send_silently: false,
      mentioned_users: [],
      logging_data: null,
      __relay_internal__pv__BarcelonaMessagesHasLiveChatQnArelayprovider: true,
    },
  });
  return json;
}
