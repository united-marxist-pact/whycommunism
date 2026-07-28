const ALLOWED_ORIGINS = new Set([
  "https://whycommunism.com",
  "https://www.whycommunism.com"
]);

const PATH_PATTERN = /^\/(?:guides|studies|start-here|research)(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\/$/;
const MAX_BODY_BYTES = 1_850_000;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_MESSAGES = 5_000;
const MAX_PREVIEW_HTML_BYTES = 1_250_000;
const MAX_BATCH_SOURCES = 250;
const GITHUB_API_VERSION = "2022-11-28";
const SESSION_COOKIE = "__Host-wce_session";
const OAUTH_STATE_COOKIE = "__Host-wce_oauth_state";
const SESSION_SECONDS = 60 * 60;
const OAUTH_STATE_SECONDS = 10 * 60;
const MEMBERSHIP_ASSERTION_SECONDS = 5 * 60;
const MAX_PREVIEW_REDIRECTS = 4;
const DISCORD_API = "https://discord.com/api/v10";
const DNS_API = "https://cloudflare-dns.com/dns-query";
const discordMembershipCache = new Map();

function originFor(request) {
  const origin = request.headers.get("Origin") || "";
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin)) return origin;
  return "";
}

function requiresTrustedV2Origin(url, request) {
  if (!url.pathname.startsWith("/v2/")) return false;
  if (url.pathname === "/v2/auth/discord/callback") return false;
  return ["POST", "PUT", "DELETE"].includes(request.method);
}

function responseHeaders(request) {
  const origin = originFor(request);
  const headers = {
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin"
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(request, value, status = 200, additionalHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { ...responseHeaders(request), ...additionalHeaders } });
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) throw new Error("Invalid base64url value.");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function editorUsers(env) {
  let parsed;
  try { parsed = JSON.parse(String(env.EDITOR_USERS_JSON || "")); }
  catch (_) { throw new Error("The editor user credential is not configured correctly."); }
  const values = Array.isArray(parsed) ? parsed : parsed?.users;
  if (!Array.isArray(values)) throw new Error("The editor user credential is not configured correctly.");
  return values.map((entry) => ({
    username: String(entry?.username || "").trim(),
    displayName: String(entry?.displayName || entry?.username || "").trim(),
    salt: String(entry?.salt || ""),
    iterations: Number(entry?.iterations),
    passwordHash: String(entry?.passwordHash || ""),
    role: "admin",
    status: "active",
    bootstrap: true
  })).filter((entry) =>
    entry.username && entry.username.length <= 100 &&
    entry.displayName && entry.displayName.length <= 160 &&
    entry.salt && Number.isInteger(entry.iterations) &&
    entry.iterations >= 1 && entry.iterations <= 2_000_000 &&
    entry.passwordHash
  );
}

async function passcodeMatches(passcode, user) {
  let expected;
  try { expected = base64UrlDecode(user.passwordHash); }
  catch (_) { return false; }
  if (!expected.length) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(passcode || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: base64UrlDecode(user.salt),
    iterations: user.iterations
  }, key, expected.length * 8);
  return timingSafeEqual(new Uint8Array(bits), expected);
}

async function hmac(secret, value) {
  if (!secret) throw new Error("The session signing credential is not configured.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function sessionEncryptionKey(env) {
  if (!env.SESSION_SECRET) throw new Error("The session signing credential is not configured.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("whycommunism-discord-membership-token\0" + String(env.SESSION_SECRET))
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptSessionValue(env, value) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sessionEncryptionKey(env),
    new TextEncoder().encode(String(value || ""))
  );
  return "v1." + base64UrlEncode(iv) + "." + base64UrlEncode(new Uint8Array(ciphertext));
}

async function decryptSessionValue(env, value) {
  const [version, encodedIv, encodedCiphertext, extra] = String(value || "").split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) return "";
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(encodedIv) },
      await sessionEncryptionKey(env),
      base64UrlDecode(encodedCiphertext)
    );
    return new TextDecoder().decode(plaintext);
  } catch (_) {
    return "";
  }
}

async function createSession(env, user) {
  const now = Math.floor(Date.now() / 1000);
  return signedToken(env, {
    v: 1,
    provider: "local",
    username: user.username,
    displayName: user.displayName,
    role: user.role || "editor",
    canReadArchive: true,
    canEdit: true,
    admin: false,
    iat: now,
    exp: now + SESSION_SECONDS
  });
}

async function signedToken(env, claims, context = "session") {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await hmac(env.SESSION_SECRET, context + "." + payload);
  return payload + "." + base64UrlEncode(signature);
}

function cookieValue(request, name) {
  for (const part of String(request.headers.get("Cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

async function sessionUser(request, env) {
  const token = cookieValue(request, SESSION_COOKIE);
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  let provided;
  try { provided = base64UrlDecode(signature); }
  catch (_) { return null; }
  const expected = await hmac(env.SESSION_SECRET, "session." + payload);
  if (!timingSafeEqual(provided, expected)) return null;
  let claims;
  try { claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))); }
  catch (_) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims?.exp) || claims.exp <= now || !claims.displayName) return null;
  if (claims.v === 2 && claims.provider === "discord" && /^\d{5,30}$/.test(String(claims.discordId || ""))) {
    const discordId = String(claims.discordId);
    try {
      if (await discordUserDenied(env, discordId)) return null;
      if (!await discordMembershipCurrent(env, discordId, claims)) return null;
    } catch (_) {
      return null;
    }
    return {
      provider: "discord",
      discordId,
      username: String(claims.username || ""),
      displayName: String(claims.displayName),
      avatar: String(claims.avatar || ""),
      roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
      canReadArchive: Boolean(claims.canReadArchive),
      canEdit: Boolean(claims.canEdit),
      // Administrator authority is deliberately recomputed from the Worker
      // environment on every request. A signed session never grants it.
      admin: csvSet(env.DISCORD_ADMIN_USER_IDS).has(discordId)
    };
  }
  if (claims?.v !== 1 || claims.provider !== "local" || env.ENABLE_LOCAL_AUTH !== "true" || !claims.username) return null;
  let configured;
  try { configured = (await configuredUsers(env)).find((user) => user.username === claims.username); }
  catch (_) { return null; }
  if (!configured || configured.status !== "active" || configured.displayName !== claims.displayName) return null;
  return {
    provider: "local",
    username: configured.username,
    displayName: configured.displayName,
    role: configured.role || "editor",
    canReadArchive: true,
    canEdit: true,
    admin: false,
    bootstrap: Boolean(configured.bootstrap)
  };
}

function sessionCookie(value, maximumAge = SESSION_SECONDS) {
  return [
    SESSION_COOKIE + "=" + value,
    "Path=/",
    "Max-Age=" + maximumAge,
    "HttpOnly",
    "Secure",
    "SameSite=Strict"
  ].join("; ");
}

function sessionPayload(user) {
  return {
    authenticated: Boolean(user),
    user: user ? {
      provider: user.provider,
      ...(user.discordId ? { discordId: user.discordId } : {}),
      username: user.username,
      displayName: user.displayName,
      ...(user.avatar ? { avatar: user.avatar } : {}),
      ...(Array.isArray(user.roles) ? { roles: user.roles } : {}),
      canReadArchive: Boolean(user.canReadArchive),
      canEdit: Boolean(user.canEdit),
      admin: Boolean(user.admin)
    } : null
  };
}

async function requireUser(request, env, capability = "read") {
  const user = await sessionUser(request, env);
  if (!user) return { response: json(request, { error: "Authentication required." }, 401), user: null };
  if (capability === "read" && !user.canReadArchive) {
    return { response: json(request, { error: "Your Discord account does not have archive access." }, 403), user: null };
  }
  if (capability === "edit" && !user.canEdit) {
    return { response: json(request, { error: "Your Discord account does not have editor access." }, 403), user: null };
  }
  if (capability === "admin" && (user.provider !== "discord" || !user.admin)) {
    return { response: json(request, { error: "Administrator access is required." }, 403), user: null };
  }
  return { response: null, user };
}

async function configuredUsers(env) {
  const bootstrap = editorUsers(env);
  if (!env.GITHUB_TOKEN) return bootstrap;
  const current = await currentJsonFile(env, "auth/users.json");
  const dynamic = Array.isArray(current.document?.users) ? current.document.users : [];
  const bootstrapNames = new Set(bootstrap.map((user) => user.username));
  return [
    ...bootstrap,
    ...dynamic.filter((user) => !bootstrapNames.has(String(user?.username || ""))).map((user) => ({
      ...user,
      username: String(user?.username || ""),
      displayName: String(user?.displayName || user?.username || ""),
      role: user?.role === "admin" ? "admin" : "editor",
      status: String(user?.status || "pending"),
      iterations: Number(user?.iterations),
      bootstrap: false
    }))
  ];
}

async function discordUserDenied(env, discordId) {
  // The denylist is an authorization control, not an optional archive feature.
  // Until it has a separately verified D1 mirror, an unavailable canonical
  // source must invalidate Discord sessions instead of silently allowing them.
  if (!env.GITHUB_TOKEN) {
    throw new Error("The Discord access denylist is unavailable.");
  }
  const current = await currentJsonFile(env, "auth/denylist.json");
  const document = current.document;
  if (!document) return false;
  const containers = [
    Array.isArray(document) ? document : null,
    document.discordIds,
    document.ids,
    document.users,
    document.denylist,
    document.records && typeof document.records === "object" ? Object.values(document.records) : null
  ].filter(Array.isArray);
  return containers.some((entries) => entries.some((entry) => {
    if (typeof entry === "string" || typeof entry === "number") return String(entry) === discordId;
    const id = String(entry?.discordId || entry?.id || entry?.userId || "");
    const status = String(entry?.status || "denied").toLocaleLowerCase("en-US");
    return id === discordId && !["active", "allowed", "removed"].includes(status);
  }));
}

function normalizedDenylistRecords(document) {
  const records = new Map();
  function add(entry) {
    const discordId = typeof entry === "string" || typeof entry === "number"
      ? String(entry)
      : String(entry?.discordId || entry?.id || entry?.userId || "");
    if (!/^\d{5,30}$/.test(discordId)) return;
    const status = String(typeof entry === "object" ? entry?.status || "denied" : "denied").toLocaleLowerCase("en-US");
    if (["active", "allowed", "removed"].includes(status)) return;
    records.set(discordId, {
      discordId,
      status: "denied",
      note: String(typeof entry === "object" ? entry?.note || entry?.reason || "" : "").trim().slice(0, 240),
      updatedAt: typeof entry === "object" ? entry?.updatedAt || entry?.addedAt || null : null,
      updatedBy: typeof entry === "object" ? entry?.updatedBy || entry?.addedBy || null : null,
      updatedByDiscordId: typeof entry === "object" ? entry?.updatedByDiscordId || null : null
    });
  }
  if (Array.isArray(document)) document.forEach(add);
  if (document && typeof document === "object") {
    [document.discordIds, document.ids, document.users, document.denylist].filter(Array.isArray).forEach((entries) => entries.forEach(add));
    if (document.records && typeof document.records === "object") Object.values(document.records).forEach(add);
  }
  return records;
}

function publicDenylist(current) {
  const records = Array.from(normalizedDenylistRecords(current.document).values())
    .sort((left, right) => left.discordId.localeCompare(right.discordId));
  return {
    format: "whycommunism-discord-denylist-v1",
    records,
    sha: current.sha || "",
    updatedAt: current.document?.updatedAt || null,
    updatedBy: current.document?.updatedBy || null
  };
}

async function getDenylist(request, env) {
  return json(request, publicDenylist(await currentJsonFile(env, "auth/denylist.json")));
}

async function updateDenylist(request, env, user) {
  const body = await parseBody(request, 32_000);
  const discordId = String(body.discordId || "").trim();
  if (!/^\d{5,30}$/.test(discordId)) return json(request, { error: "Enter a valid Discord user ID." }, 400);
  const denied = body.denied !== false && String(body.action || "deny").toLocaleLowerCase("en-US") !== "allow";
  if (denied && discordId === String(user.discordId || "")) {
    return json(request, { error: "You cannot block your own administrator account." }, 400);
  }
  const current = await currentJsonFile(env, "auth/denylist.json");
  if (current.sha !== String(body.baseSha || "")) return conflictResponse(request, current, "The access list changed somewhere else.");
  const records = normalizedDenylistRecords(current.document);
  const now = new Date().toISOString();
  if (denied) {
    records.set(discordId, {
      discordId,
      status: "denied",
      note: String(body.note || "").trim().slice(0, 240),
      updatedAt: now,
      ...actorFields(user)
    });
  } else {
    records.delete(discordId);
  }
  const document = {
    format: "whycommunism-discord-denylist-v1",
    records: Object.fromEntries(Array.from(records.entries()).sort(([left], [right]) => left.localeCompare(right))),
    updatedAt: now,
    ...actorFields(user)
  };
  const action = denied ? "Block " : "Restore ";
  const result = await saveJsonFile(env, current, document, commitMessage("access", action + discordId, user));
  return json(request, {
    ok: true,
    ...publicDenylist({ document, sha: result.content?.sha || "" }),
    commit: result.commit?.sha || ""
  });
}

async function getDenylistHistory(request, env) {
  const file = "auth/denylist.json";
  const commits = await github(env,
    "/commits?sha=" + encodeURIComponent(env.GITHUB_BRANCH) + "&path=" + encodeURIComponent(file) + "&per_page=40"
  );
  return json(request, {
    versions: commits.map((item) => {
      const message = String(item.commit?.message || "Access list updated");
      return {
        sha: item.sha,
        note: message.replace(/^access:\s*/i, "").replace(/\s+\(by [^)]+\)\s*$/, ""),
        savedAt: item.commit?.author?.date || item.commit?.committer?.date || null,
        updatedBy: message.match(/\s+\(by ([^)]+)\)\s*$/)?.[1] || item.commit?.author?.name || null
      };
    })
  });
}

function previewUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch (_) { throw new Error("Invalid preview URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Invalid preview URL.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".invalid")
  ) {
    throw new Error("That preview address is not allowed.");
  }
  url.hostname = host.includes(":") ? "[" + host + "]" : host;
  url.hash = "";
  return url;
}

function ipv4Bytes(value) {
  const match = String(value || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const bytes = match.slice(1).map(Number);
  return bytes.some((byte) => byte > 255) ? null : bytes;
}

function publicIpv4(value) {
  const bytes = ipv4Bytes(value);
  if (!bytes) return null;
  const [a, b, c] = bytes;
  return !(
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Bytes(value) {
  let input = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!input.includes(":") || input.includes("%")) return null;
  let ipv4Tail = null;
  const tail = input.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    ipv4Tail = ipv4Bytes(tail[1]);
    if (!ipv4Tail) return null;
    input = input.slice(0, -tail[1].length) +
      ((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16) + ":" +
      ((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16);
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (
    left.concat(right).some((group) => !/^[a-f0-9]{1,4}$/.test(group)) ||
    (halves.length === 1 && left.length !== 8) ||
    (halves.length === 2 && left.length + right.length >= 8)
  ) {
    return null;
  }
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) {
    const number = Number.parseInt(group, 16);
    bytes.push(number >> 8, number & 255);
  }
  return bytes;
}

function publicIpv6(value) {
  const bytes = ipv6Bytes(value);
  if (!bytes) return null;
  const mappedIpv4 = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255;
  if (mappedIpv4) return publicIpv4(bytes.slice(12).join("."));
  // Only globally routable unicast space is accepted. Explicitly exclude
  // transition/documentation blocks that can obscure another destination.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01) {
    if (bytes[2] === 0x00 && bytes[3] === 0x00) return false; // Teredo.
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return false; // Documentation.
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 6to4.
  return true;
}

function publicIpAddress(value) {
  const ipv4 = publicIpv4(value);
  if (ipv4 !== null) return ipv4;
  return publicIpv6(value);
}

async function dnsJson(host, type, signal) {
  const endpoint = new URL(DNS_API);
  endpoint.searchParams.set("name", host);
  endpoint.searchParams.set("type", type);
  const response = await fetch(endpoint, {
    redirect: "error",
    signal,
    headers: { "Accept": "application/dns-json" }
  });
  if (!response.ok) throw new Error("That website address could not be verified.");
  const payload = await response.json().catch(() => null);
  if (!payload || Number(payload.Status) !== 0) throw new Error("That website address could not be verified.");
  return Array.isArray(payload.Answer) ? payload.Answer : [];
}

async function verifyPublicPreviewTarget(url, signal) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const literal = publicIpAddress(host);
  if (literal !== null) {
    if (!literal) throw new Error("That preview address is not allowed.");
    return;
  }
  const answers = (await Promise.all([
    dnsJson(host, "A", signal),
    dnsJson(host, "AAAA", signal)
  ])).flat();
  const addresses = answers
    .filter((answer) => Number(answer?.type) === 1 || Number(answer?.type) === 28)
    .map((answer) => String(answer.data || "").trim())
    .filter(Boolean);
  if (!addresses.length || addresses.some((address) => publicIpAddress(address) !== true)) {
    throw new Error("That preview address is not allowed.");
  }
}

function redirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchPreviewPage(requested, signal) {
  let current = requested;
  for (let redirects = 0; redirects <= MAX_PREVIEW_REDIRECTS; redirects += 1) {
    await verifyPublicPreviewTarget(current, signal);
    const response = await fetch(current, {
      redirect: "manual",
      signal,
      headers: { "Accept": "text/html,application/xhtml+xml", "User-Agent": "WhyCommunismLinkPreview/1.0" }
    });
    if (!redirectStatus(response.status)) return { response, finalUrl: current };
    if (redirects === MAX_PREVIEW_REDIRECTS) throw new Error("That website redirected too many times.");
    const location = response.headers.get("Location");
    if (!location) throw new Error("That website returned an invalid redirect.");
    current = previewUrl(new URL(location, current).toString());
  }
  throw new Error("That website redirected too many times.");
}

async function limitedResponseText(response, maximum) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximum) throw new Error("That page is too large to preview.");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("That page is too large to preview.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([a-f0-9]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

function pageMetadata(html) {
  const metadata = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = {};
    for (const attr of match[0].matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) attrs[attr[1].toLowerCase()] = attr[3];
    const key = String(attrs.property || attrs.name || "").toLowerCase();
    if (key && attrs.content && !metadata.has(key)) metadata.set(key, decodeEntities(attrs.content));
  }
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return {
    title: metadata.get("og:title") || metadata.get("twitter:title") || decodeEntities(titleMatch?.[1] || ""),
    description: metadata.get("og:description") || metadata.get("twitter:description") || metadata.get("description") || "",
    image: metadata.get("og:image:secure_url") || metadata.get("og:image") || metadata.get("twitter:image") || "",
    site: metadata.get("og:site_name") || ""
  };
}

async function getLinkPreview(request, rawUrl) {
  if (!originFor(request)) return json(request, { error: "Link previews are available only to Why Communism." }, 403);
  const requested = previewUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  let result;
  let html;
  try {
    result = await fetchPreviewPage(requested, controller.signal);
    if (!result.response.ok) throw new Error("That website did not provide a preview.");
    if (!String(result.response.headers.get("Content-Type") || "").toLowerCase().includes("text/html")) throw new Error("That link is not an HTML page.");
    const length = Number(result.response.headers.get("Content-Length") || 0);
    if (length > MAX_PREVIEW_HTML_BYTES) throw new Error("That page is too large to preview.");
    html = await limitedResponseText(result.response, MAX_PREVIEW_HTML_BYTES);
  } finally { clearTimeout(timeout); }
  const { finalUrl } = result;
  const metadata = pageMetadata(html);
  let image = "";
  if (metadata.image) {
    try { image = previewUrl(new URL(metadata.image, finalUrl).toString()).toString(); }
    catch (_) {}
  }
  const headers = responseHeaders(request);
  headers["Cache-Control"] = "private, no-store";
  return new Response(JSON.stringify({
    url: finalUrl.toString(),
    host: finalUrl.hostname.replace(/^www\./, ""),
    site: metadata.site.slice(0, 120),
    title: (metadata.title || finalUrl.hostname).slice(0, 240),
    description: metadata.description.slice(0, 420),
    image
  }), { headers });
}

function validPath(value) {
  return typeof value === "string" && value.length <= 240 && PATH_PATTERN.test(value);
}

function archiveFile(path) {
  return "article-archives/" + path.replace(/^\/+|\/+$/g, "").replace(/\//g, "--") + ".json";
}

function articleKey(path) {
  return path.replace(/^\/+|\/+$/g, "").replace(/\//g, "--");
}

function cleanFilename(value) {
  const cleaned = String(value || "file").normalize("NFKC").replace(/[^a-zA-Z0-9._ -]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "file").slice(-140);
}

function attachmentType(filename, proposed) {
  const extension = (filename.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || "";
  const types = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    odt: "application/vnd.oasis.opendocument.text", xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  const resolved = types[extension] || "";
  if (!resolved) throw new Error("That file type is not supported. Use an image, PDF, text, Markdown, CSV, Word, spreadsheet, or presentation file.");
  if (String(proposed || "").startsWith("image/") && !resolved.startsWith("image/")) throw new Error("The attachment type does not match its filename.");
  return resolved;
}

function utcTimestamp(value, fallback = true) {
  const date = new Date(String(value || ""));
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return fallback ? new Date().toISOString() : "";
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) throw new Error("Invalid message collection.");
  return value.map((message, index) => {
    if (!message || typeof message !== "object") throw new Error("Invalid message at position " + (index + 1) + ".");
    const content = String(message.content || "");
    if (!content.trim() || content.length > 200_000) throw new Error("Invalid message content at position " + (index + 1) + ".");
    return {
      id: String(message.id || crypto.randomUUID()).slice(0, 120),
      sourceId: String(message.sourceId || "").slice(0, 240),
      author: String(message.author || "User").trim().slice(0, 100) || "User",
      timestamp: utcTimestamp(message.timestamp),
      content,
      replyTo: String(message.replyTo || "").slice(0, 120),
      replyAuthor: String(message.replyAuthor || "").slice(0, 100),
      replyExcerpt: String(message.replyExcerpt || "").slice(0, 280),
      editedAt: message.editedAt ? utcTimestamp(message.editedAt, false) : ""
    };
  });
}

async function parseBody(request, maximum = MAX_BODY_BYTES) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maximum) throw new Error("This request is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximum) throw new Error("This request is too large.");
  return JSON.parse(text);
}

function githubHeaders(env) {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": "Bearer " + env.GITHUB_TOKEN,
    "User-Agent": "whycommunism-archive-editor",
    "X-GitHub-Api-Version": GITHUB_API_VERSION
  };
}

function githubUrl(env, endpoint) {
  return "https://api.github.com/repos/" + encodeURIComponent(env.GITHUB_OWNER) + "/" + encodeURIComponent(env.GITHUB_REPO) + endpoint;
}

async function github(env, endpoint, options = {}) {
  const response = await fetch(githubUrl(env, endpoint), {
    ...options,
    headers: { ...githubHeaders(env), ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "GitHub could not complete this request.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function decodeContent(value) {
  const binary = atob(String(value || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeContent(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(String(value || "").replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function currentFile(env, path, ref = env.GITHUB_BRANCH) {
  const file = archiveFile(path);
  return currentJsonFile(env, file, ref);
}

async function currentJsonFile(env, file, ref = env.GITHUB_BRANCH) {
  try {
    const payload = await github(env, "/contents/" + file.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(ref));
    if (payload.content && payload.encoding !== "none") {
      return { file, sha: payload.sha, document: decodeContent(payload.content) };
    }
    // GitHub omits `content` from the Contents response for files over 1 MB.
    // Source shards are intentionally larger, so recover the exact blob by SHA.
    if (payload.sha) {
      const blob = await github(env, "/git/blobs/" + encodeURIComponent(payload.sha));
      if (blob.content) {
        return { file, sha: payload.sha, document: decodeContent(blob.content) };
      }
    }
    throw new Error("GitHub returned the archive file without readable content.");
  } catch (error) {
    if (error.status === 404) return { file, sha: "", document: null };
    throw error;
  }
}

function actorFields(user) {
  return {
    updatedBy: user.displayName,
    ...(user.provider ? { updatedByProvider: user.provider } : {}),
    ...(user.discordId ? { updatedByDiscordId: user.discordId } : {}),
    ...(user.username ? { updatedByUsername: user.username } : {}),
    ...(user.avatar ? { updatedByAvatar: user.avatar } : {})
  };
}

function commitMessage(prefix, note, user) {
  return prefix + ": " + String(note || "Update").trim().slice(0, 160) + " (by " + user.displayName + ")";
}

async function saveJsonFile(env, current, document, message) {
  return github(env, "/contents/" + current.file.split("/").map(encodeURIComponent).join("/"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: encodeContent(document),
      branch: env.GITHUB_BRANCH,
      ...(current.sha ? { sha: current.sha } : {})
    })
  });
}

async function saveArchiveEvent(env, type, payload, user, now = new Date().toISOString()) {
  const eventId = crypto.randomUUID();
  const date = now.slice(0, 10).replace(/-/g, "/");
  const stamp = now.replace(/[-:.TZ]/g, "").slice(0, 17);
  const file = "events/" + date + "/" + stamp + "-" + eventId + ".json";
  const document = {
    format: "whycommunism-archive-event-v1",
    eventId,
    type,
    createdAt: now,
    ...actorFields(user),
    payload
  };
  const result = await saveJsonFile(
    env,
    { file, sha: "", document: null },
    document,
    commitMessage("event", type.replace(/[-_]+/g, " "), user)
  );
  return {
    eventId,
    file,
    sha: result.content?.sha || "",
    commit: result.commit?.sha || "",
    document
  };
}

function conflictResponse(request, current, message = "This record changed somewhere else.") {
  return json(request, { error: message, conflict: true, sha: current.sha }, 409);
}

function dataFile(prefix, path) {
  const normalized = String(path || "").normalize("NFC");
  return prefix + "/" + base64UrlEncode(new TextEncoder().encode(normalized)) + ".json";
}

function publicDocument(path, current) {
  const document = current.document || {};
  return {
    path,
    title: document.title || "",
    messages: Array.isArray(document.messages) ? document.messages : [],
    sha: current.sha || "",
    updatedAt: document.updatedAt || null
  };
}

async function getArchive(request, env, path) {
  return json(request, publicDocument(path, await currentFile(env, path)));
}

async function saveArchive(request, env, path, checkpointOnly = false) {
  if (!originFor(request)) return json(request, { error: "Writes are accepted only from Why Communism." }, 403);
  const body = await parseBody(request);
  const current = await currentFile(env, path);
  const baseSha = String(body.baseSha || "");
  if (current.sha !== baseSha) {
    return json(request, { error: "This article changed somewhere else.", conflict: true, sha: current.sha }, 409);
  }
  const messages = checkpointOnly
    ? normalizeMessages(current.document?.messages || [])
    : normalizeMessages(body.messages);
  const now = new Date().toISOString();
  const title = String(body.title || current.document?.title || "Untitled article").trim().slice(0, 240) || "Untitled article";
  const note = String(body.note || (checkpointOnly ? "Manual checkpoint" : "Update article archive")).trim().slice(0, 160);
  const document = {
    format: "whycommunism-article-archive-v1",
    path,
    title,
    messages,
    updatedAt: now,
    checkpointAt: checkpointOnly ? now : (current.document?.checkpointAt || null)
  };
  const commit = await github(env, "/contents/" + current.file.split("/").map(encodeURIComponent).join("/"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "archive: " + note,
      content: encodeContent(document),
      branch: env.GITHUB_BRANCH,
      ...(current.sha ? { sha: current.sha } : {})
    })
  });
  return json(request, { ok: true, sha: commit.content?.sha || "", commit: commit.commit?.sha || "", updatedAt: now });
}

async function getHistory(request, env, path) {
  const file = archiveFile(path);
  const commits = await github(env,
    "/commits?sha=" + encodeURIComponent(env.GITHUB_BRANCH) + "&path=" + encodeURIComponent(file) + "&per_page=80"
  );
  return json(request, {
    path,
    versions: commits.map((item) => ({
      sha: item.sha,
      note: String(item.commit?.message || "Saved archive version").replace(/^archive:\s*/i, ""),
      savedAt: item.commit?.author?.date || item.commit?.committer?.date || null,
      githubAuthor: item.author?.login || item.commit?.author?.name || "Why Communism"
    }))
  });
}

async function getVersion(request, env, path, sha) {
  if (!/^[a-f0-9]{40}$/i.test(sha || "")) return json(request, { error: "Invalid Git revision." }, 400);
  const current = await currentFile(env, path, sha);
  if (!current.document) return json(request, { error: "That version was not found." }, 404);
  return json(request, { ...publicDocument(path, current), commit: sha });
}

async function storePrivateAttachment(env, path, input, user) {
  const filename = cleanFilename(input?.filename);
  const contentType = attachmentType(filename, input?.contentType);
  const base64 = String(input?.base64 || "").replace(/\s/g, "");
  const bytes = decodeBase64(base64);
  if (!bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attachments must be between 1 byte and 8 MB.");
  const file = "attachments/" + articleKey(path) + "/" + crypto.randomUUID() + "-" + filename;
  const result = await github(env, "/contents/" + file.split("/").map(encodeURIComponent).join("/"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: user ? commitMessage("attachment", "Add " + filename, user) : "attachment: " + filename,
      content: base64,
      branch: env.GITHUB_BRANCH
    })
  });
  return {
    filename,
    contentType,
    bytes: bytes.byteLength,
    archivePath: file,
    sha: result.content?.sha || "",
    private: true
  };
}

async function uploadAttachment(request, env, path) {
  if (!originFor(request)) return json(request, { error: "Uploads are accepted only from Why Communism." }, 403);
  const body = await parseBody(request, MAX_ATTACHMENT_REQUEST_BYTES);
  const stored = await storePrivateAttachment(env, path, body);
  const url = new URL(request.url);
  url.pathname = "/v1/attachment";
  url.search = "?file=" + encodeURIComponent(stored.archivePath);
  return json(request, { ok: true, filename: stored.filename, contentType: stored.contentType, bytes: stored.bytes, sha: stored.sha, url: url.toString() });
}

async function getAttachment(request, env, file) {
  if (!/^attachments\/[a-z0-9-]+\/[a-f0-9-]{36}-[a-zA-Z0-9._-]+$/.test(file || "")) return json(request, { error: "Invalid attachment path." }, 400);
  const metadata = await github(env, "/contents/" + file.split("/").map(encodeURIComponent).join("/") + "?ref=" + encodeURIComponent(env.GITHUB_BRANCH));
  const blob = await github(env, "/git/blobs/" + encodeURIComponent(metadata.sha));
  const bytes = decodeBase64(blob.content);
  const filename = file.split("/").pop().replace(/^[a-f0-9-]{37}/, "");
  const contentType = attachmentType(filename, "");
  const inline = contentType.startsWith("image/") || contentType.startsWith("application/pdf");
  return new Response(bytes, {
    headers: {
      ...(originFor(request) ? { "Access-Control-Allow-Origin": originFor(request) } : {}),
      "Access-Control-Allow-Credentials": "true",
      "Cache-Control": "private, no-store",
      "Content-Disposition": (inline ? "inline" : "attachment") + '; filename="' + filename.replace(/["\\]/g, "-") + '"',
      "Content-Length": String(bytes.byteLength),
      "Content-Type": contentType,
      "Cross-Origin-Resource-Policy": "same-site",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Vary": "Origin"
    }
  });
}

function csvSet(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function oauthStateCookie(value, maximumAge = OAUTH_STATE_SECONDS) {
  return [
    OAUTH_STATE_COOKIE + "=" + value,
    "Path=/",
    "Max-Age=" + maximumAge,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function safeReturnUrl(value) {
  try {
    const url = new URL(String(value || "https://whycommunism.com/"), "https://whycommunism.com/");
    if (!ALLOWED_ORIGINS.has(url.origin)) return "https://whycommunism.com/";
    return url.toString();
  } catch (_) {
    return "https://whycommunism.com/";
  }
}

async function readSignedToken(env, token, context) {
  const [payload, signature, extra] = String(token || "").split(".");
  if (!payload || !signature || extra) return null;
  let provided;
  try { provided = base64UrlDecode(signature); }
  catch (_) { return null; }
  const expected = await hmac(env.SESSION_SECRET, context + "." + payload);
  if (!timingSafeEqual(provided, expected)) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (!Number.isFinite(claims?.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch (_) {
    return null;
  }
}

async function beginDiscordAuth(request, env, url) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_REDIRECT_URI || !env.SESSION_SECRET) {
    return json(request, { error: "Discord authentication is not configured." }, 503);
  }
  const random = new Uint8Array(24);
  crypto.getRandomValues(random);
  const now = Math.floor(Date.now() / 1000);
  const state = await signedToken(env, {
    v: 1,
    nonce: base64UrlEncode(random),
    returnTo: safeReturnUrl(url.searchParams.get("returnTo")),
    iat: now,
    exp: now + OAUTH_STATE_SECONDS
  }, "oauth-state");
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", env.DISCORD_REDIRECT_URI);
  authorize.searchParams.set("scope", "identify guilds.members.read");
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      ...responseHeaders(request),
      "Content-Type": "text/plain; charset=utf-8",
      "Location": authorize.toString(),
      "Set-Cookie": oauthStateCookie(state)
    }
  });
}

async function discordJson(endpoint, accessToken) {
  const response = await fetch(DISCORD_API + endpoint, {
    headers: { "Accept": "application/json", "Authorization": "Bearer " + accessToken }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "Discord could not verify this account.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function discordMembershipCurrent(env, discordId, claims) {
  if (claims.memberPending === true) return false;
  const now = Math.floor(Date.now() / 1000);
  const assertedAt = Number(claims.membershipVerifiedAt);
  if (Number.isFinite(assertedAt) && assertedAt <= now && now - assertedAt <= MEMBERSHIP_ASSERTION_SECONDS) {
    return true;
  }
  const cached = discordMembershipCache.get(discordId);
  if (cached && cached.checkedAt <= now && now - cached.checkedAt <= MEMBERSHIP_ASSERTION_SECONDS) {
    return cached.active;
  }
  const accessToken = await decryptSessionValue(env, claims.membershipToken);
  if (!accessToken) return false;
  const guildId = String(env.DISCORD_GUILD_ID || "898568341499838514");
  const [discordUser, member] = await Promise.all([
    discordJson("/users/@me", accessToken),
    discordJson("/users/@me/guilds/" + encodeURIComponent(guildId) + "/member", accessToken)
  ]);
  const active = String(discordUser?.id || "") === discordId && member?.pending !== true;
  discordMembershipCache.set(discordId, { active, checkedAt: now });
  return active;
}

function discordAvatar(user, member, guildId) {
  if (member?.avatar) return "https://cdn.discordapp.com/guilds/" + guildId + "/users/" + user.id + "/avatars/" + member.avatar + ".png?size=128";
  if (user?.avatar) return "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=128";
  const index = user?.discriminator && user.discriminator !== "0"
    ? Number(user.discriminator) % 5
    : Number((BigInt(user.id) >> 22n) % 6n);
  return "https://cdn.discordapp.com/embed/avatars/" + index + ".png";
}

async function finishDiscordAuth(request, env, url) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_REDIRECT_URI || !env.SESSION_SECRET) {
    return json(request, { error: "Discord authentication is not configured." }, 503);
  }
  const state = url.searchParams.get("state") || "";
  const cookieState = cookieValue(request, OAUTH_STATE_COOKIE);
  const sameState = timingSafeEqual(new TextEncoder().encode(state), new TextEncoder().encode(cookieState));
  const claims = sameState ? await readSignedToken(env, state, "oauth-state") : null;
  if (!claims?.nonce) return json(request, { error: "The Discord sign-in state is invalid or expired." }, 400, { "Set-Cookie": oauthStateCookie("", 0) });
  const code = url.searchParams.get("code") || "";
  if (!code || code.length > 2_000) return json(request, { error: "Discord did not provide an authorization code." }, 400);
  const tokenResponse = await fetch(DISCORD_API + "/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      redirect_uri: env.DISCORD_REDIRECT_URI
    }).toString()
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.access_token) return json(request, { error: "Discord could not complete sign-in." }, 502, { "Set-Cookie": oauthStateCookie("", 0) });
  const guildId = String(env.DISCORD_GUILD_ID || "898568341499838514");
  const [discordUser, member] = await Promise.all([
    discordJson("/users/@me", token.access_token),
    discordJson("/users/@me/guilds/" + encodeURIComponent(guildId) + "/member", token.access_token)
  ]);
  if (!/^\d{5,30}$/.test(String(discordUser.id || ""))) throw new Error("Discord returned an invalid user identity.");
  if (member?.pending === true) {
    const error = new Error("Complete the Discord server membership screening before opening the private archive.");
    error.status = 403;
    throw error;
  }
  const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
  const adminUsers = csvSet(env.DISCORD_ADMIN_USER_IDS);
  const admin = adminUsers.has(String(discordUser.id));
  const denied = await discordUserDenied(env, String(discordUser.id));
  const canReadArchive = !denied;
  const canEdit = !denied;
  const displayName = String(member.nick || discordUser.global_name || discordUser.username || "Discord member").trim().slice(0, 160);
  const now = Math.floor(Date.now() / 1000);
  const membershipToken = await encryptSessionValue(env, token.access_token);
  discordMembershipCache.set(String(discordUser.id), { active: true, checkedAt: now });
  const session = await signedToken(env, {
    v: 2,
    provider: "discord",
    discordId: String(discordUser.id),
    username: String(discordUser.username || "").slice(0, 100),
    displayName,
    avatar: discordAvatar(discordUser, member, guildId),
    roles,
    canReadArchive,
    canEdit,
    memberPending: false,
    membershipVerifiedAt: now,
    membershipToken,
    admin,
    iat: now,
    exp: now + SESSION_SECONDS
  });
  const headers = new Headers(responseHeaders(request));
  headers.set("Location", safeReturnUrl(claims.returnTo));
  headers.append("Set-Cookie", sessionCookie(session));
  headers.append("Set-Cookie", oauthStateCookie("", 0));
  return new Response(null, { status: 302, headers });
}

async function sessionRoute(request, env) {
  if (request.method === "GET") return json(request, sessionPayload(await sessionUser(request, env)));
  if (!originFor(request)) return json(request, { error: "Sessions are available only to Why Communism." }, 403);
  if (request.method === "DELETE") {
    return json(request, sessionPayload(null), 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (request.method !== "POST") return json(request, { error: "Method not allowed." }, 405);
  if (env.ENABLE_LOCAL_AUTH !== "true") {
    return json(request, { error: "Use Discord to sign in.", authorizationUrl: "/v2/auth/discord" }, 405);
  }
  let body;
  try { body = await parseBody(request, 32_000); }
  catch (error) { return json(request, { error: error.message || "Invalid login request." }, 400); }
  const username = String(body?.username || "").trim();
  const passcode = String(body?.passcode || "");
  let users;
  try { users = editorUsers(env); }
  catch (error) { return json(request, { error: error.message }, 503); }
  const user = users.find((candidate) => candidate.username.toLocaleLowerCase("en-US") === username.toLocaleLowerCase("en-US"));
  let matches = false;
  try {
    if (user && passcode.length <= 1_000) matches = await passcodeMatches(passcode, user);
  } catch (_) {}
  if (!matches) return json(request, { error: "Invalid username or passcode.", ...sessionPayload(null) }, 401);
  let token;
  try { token = await createSession(env, user); }
  catch (error) { return json(request, { error: error.message }, 503); }
  const publicUser = {
    provider: "local",
    username: user.username,
    displayName: user.displayName,
    canReadArchive: true,
    canEdit: true,
    admin: false
  };
  return json(request, sessionPayload(publicUser), 200, { "Set-Cookie": sessionCookie(token) });
}

function normalizeCitations(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 1_000) throw new Error("Invalid citation collection.");
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 600_000) throw new Error("The citation collection is too large.");
  return JSON.parse(serialized);
}

function finalDocument(path, current) {
  const document = current.document || {};
  return {
    format: document.format || "whycommunism-final-argument-v1",
    path,
    title: String(document.title || ""),
    bodyMarkdown: String(document.bodyMarkdown || ""),
    citations: Array.isArray(document.citations) ? document.citations : [],
    sha: current.sha || "",
    updatedAt: document.updatedAt || null,
    updatedBy: document.updatedBy || null
  };
}

function publicFinalDocument(document) {
  return {
    ...document,
    citations: (document.citations || []).map((citation) => {
      if (String(citation?.type || "").toLocaleLowerCase("en-US") !== "discord") {
        return citation;
      }
      return {
        id: String(citation?.id || ""),
        type: "discord",
        title: "United Marxist Pact source archive (members only)",
        private: true
      };
    })
  };
}

async function getFinal(request, env, path) {
  const document = finalDocument(
    path,
    await currentJsonFile(env, dataFile("final-arguments", path))
  );
  const user = await sessionUser(request, env);
  return json(
    request,
    user?.canReadArchive ? document : publicFinalDocument(document)
  );
}

async function saveFinal(request, env, path, user, checkpointOnly = false) {
  const body = await parseBody(request);
  const current = await currentJsonFile(env, dataFile("final-arguments", path));
  if (current.sha !== String(body.baseSha || "")) return conflictResponse(request, current, "This final argument changed somewhere else.");
  const now = new Date().toISOString();
  const previous = current.document || {};
  const title = String(body.title ?? previous.title ?? "").trim();
  const bodyMarkdown = String(body.bodyMarkdown ?? previous.bodyMarkdown ?? "");
  const citations = normalizeCitations(body.citations ?? previous.citations ?? []);
  if (!title || title.length > 240) throw new Error("The final argument title is required and must be at most 240 characters.");
  if (new TextEncoder().encode(bodyMarkdown).byteLength > MAX_BODY_BYTES) throw new Error("The final argument is too large.");
  const note = String(body.note || (checkpointOnly ? "Manual checkpoint" : "Update final argument")).trim().slice(0, 160);
  const document = {
    ...previous,
    format: "whycommunism-final-argument-v1",
    path,
    title,
    bodyMarkdown,
    citations,
    updatedAt: now,
    ...actorFields(user),
    ...(checkpointOnly ? { checkpointAt: now } : {})
  };
  const result = await saveJsonFile(env, current, document, commitMessage("final", note, user));
  return json(request, {
    ok: true,
    ...finalDocument(path, { document, sha: result.content?.sha || "" }),
    commit: result.commit?.sha || ""
  });
}

async function getFinalHistory(request, env, path) {
  const file = dataFile("final-arguments", path);
  const commits = await github(env,
    "/commits?sha=" + encodeURIComponent(env.GITHUB_BRANCH) + "&path=" + encodeURIComponent(file) + "&per_page=80"
  );
  return json(request, {
    path,
    versions: commits.map((item) => {
      const message = String(item.commit?.message || "Saved final argument");
      const actor = message.match(/\s+\(by ([^)]+)\)\s*$/)?.[1] || item.commit?.author?.name || null;
      return {
        sha: item.sha,
        note: message.replace(/^final:\s*/i, "").replace(/\s+\(by [^)]+\)\s*$/, ""),
        savedAt: item.commit?.author?.date || item.commit?.committer?.date || null,
        updatedBy: actor,
        githubAuthor: item.author?.login || item.commit?.author?.name || "Why Communism"
      };
    })
  });
}

async function getFinalVersion(request, env, path, sha) {
  if (!/^[a-f0-9]{40}$/i.test(sha || "")) return json(request, { error: "Invalid Git revision." }, 400);
  const current = await currentJsonFile(env, dataFile("final-arguments", path), sha);
  if (!current.document) return json(request, { error: "That version was not found." }, 404);
  return json(request, { ...finalDocument(path, current), commit: sha });
}

async function restoreFinalVersion(request, env, path, user) {
  const body = await parseBody(request, 32_000);
  const commit = String(body.commit || body.sha || "").trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) return json(request, { error: "Choose a valid saved revision." }, 400);
  const file = dataFile("final-arguments", path);
  const [current, selected] = await Promise.all([
    currentJsonFile(env, file),
    currentJsonFile(env, file, commit)
  ]);
  if (!selected.document) return json(request, { error: "That saved revision was not found." }, 404);
  if (current.sha !== String(body.baseSha || "")) return conflictResponse(request, current, "The final argument changed somewhere else.");
  const restored = finalDocument(path, selected);
  if (!restored.title || restored.title.length > 240 || new TextEncoder().encode(restored.bodyMarkdown).byteLength > MAX_BODY_BYTES) {
    return json(request, { error: "That saved revision is not a valid final argument." }, 422);
  }
  const now = new Date().toISOString();
  const note = String(body.note || "Restore " + commit.slice(0, 7)).trim().slice(0, 160);
  const document = {
    ...selected.document,
    format: "whycommunism-final-argument-v1",
    path,
    title: restored.title,
    bodyMarkdown: restored.bodyMarkdown,
    citations: normalizeCitations(restored.citations),
    updatedAt: now,
    restoredFromCommit: commit,
    ...actorFields(user)
  };
  const result = await saveJsonFile(env, current, document, commitMessage("final", note, user));
  return json(request, {
    ok: true,
    restoredFromCommit: commit,
    ...finalDocument(path, { document, sha: result.content?.sha || "" }),
    commit: result.commit?.sha || ""
  });
}

function sourceRecordId(record) {
  return String(record?.id || record?.recordId || record?.sourceId || record?.messageId || "");
}

function sourceShardPath(value) {
  let file = String(value || "").trim();
  if (!file) return "";
  file = file.replace(/^\/+/, "");
  if (file.startsWith("source-records/discord-shards/")) {
    // Already canonical.
  } else if (file.startsWith("discord-shards/")) {
    file = "source-records/" + file;
  } else {
    file = "source-records/discord-shards/" + file;
  }
  if (!file.endsWith(".json")) file += ".json";
  return /^source-records\/discord-shards\/[a-zA-Z0-9._-]+\.json$/.test(file) ? file : "";
}

function indexContainers(document) {
  if (!document || typeof document !== "object") return [];
  return [
    document,
    document.records,
    document.manualRecords,
    document.byId,
    document.index,
    document.sourceIndex,
    document.messages
  ].filter((value) => value && typeof value === "object");
}

function indexEntry(document, id) {
  for (const container of indexContainers(document)) {
    if (!Array.isArray(container) && Object.prototype.hasOwnProperty.call(container, id)) return container[id];
    if (Array.isArray(container)) {
      const match = container.find((entry) => sourceRecordId(entry) === id);
      if (match) return match;
    }
  }
  for (const shard of Array.isArray(document?.shards) ? document.shards : []) {
    const ids = shard?.ids || shard?.recordIds || shard?.records;
    if (Array.isArray(ids) && ids.map(String).includes(id)) return shard;
  }
  return null;
}

function shardFromEntry(entry) {
  if (typeof entry === "string") return sourceShardPath(entry);
  return sourceShardPath(entry?.shard || entry?.file || entry?.path || entry?.shardFile);
}

function recordsInShard(document) {
  if (Array.isArray(document)) return document;
  for (const key of ["records", "items", "messages", "sources"]) {
    if (Array.isArray(document?.[key])) return document[key];
    if (document?.[key] && typeof document[key] === "object") return Object.values(document[key]);
  }
  if (document && typeof document === "object") return Object.values(document).filter((value) => value && typeof value === "object");
  return [];
}

function recordFromShard(document, id) {
  if (document && typeof document === "object" && !Array.isArray(document)) {
    for (const key of ["records", "items", "messages", "sources"]) {
      const container = document[key];
      if (container && !Array.isArray(container) && sourceRecordId(container[id] || {}) === id) return container[id];
      if (container && !Array.isArray(container) && container[id]) return container[id];
    }
    if (document[id]) return document[id];
  }
  return recordsInShard(document).find((record) => sourceRecordId(record) === id) || null;
}

async function sourceContext(env, cache = new Map()) {
  if (!cache.has("index")) cache.set("index", await currentJsonFile(env, "source-index/discord.json"));
  return { cache, index: cache.get("index") };
}

async function sha256Text(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)))
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readSourceRecord(env, id, cache = new Map()) {
  const context = await sourceContext(env, cache);
  const entry = indexEntry(context.index.document, id);
  if (entry && typeof entry === "object" && sourceRecordId(entry) === id && !shardFromEntry(entry)) return entry;
  let shardPath = shardFromEntry(entry);
  if (!shardPath && String(id).startsWith("discord:")) {
    const shard = (await sha256Text(id)).slice(0, 1);
    shardPath = sourceShardPath(shard);
  }
  if (shardPath) {
    if (!cache.has(shardPath)) cache.set(shardPath, await currentJsonFile(env, shardPath));
    const record = recordFromShard(cache.get(shardPath).document, id);
    if (record) return record;
  }
  if (!shardPath) {
    const fallback = sourceShardPath("manual-" + id.replace(/[^a-zA-Z0-9._-]/g, "-"));
    const fallbackFile = await currentJsonFile(env, fallback);
    if (fallbackFile.document) {
      cache.set(fallback, fallbackFile);
      return recordFromShard(fallbackFile.document, id);
    }
    return null;
  }
  return null;
}

async function allSourceIdsWithShards(env, index, cache) {
  const ids = new Set(allSourceIds(index.document));
  for (const shard of Array.isArray(index.document?.shards) ? index.document.shards : []) {
    const shardPath = sourceShardPath(shard?.file || shard?.prefix);
    if (!shardPath) continue;
    if (!cache.has(shardPath)) cache.set(shardPath, await currentJsonFile(env, shardPath));
    for (const record of recordsInShard(cache.get(shardPath).document)) {
      const id = sourceRecordId(record);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function allSourceIds(index) {
  const ids = new Set();
  for (const container of indexContainers(index)) {
    if (Array.isArray(container)) {
      for (const entry of container) {
        const id = sourceRecordId(entry);
        if (id) ids.add(id);
      }
    } else {
      for (const [key, entry] of Object.entries(container)) {
        if (key !== "format" && key !== "updatedAt" && key !== "shards") {
          if (shardFromEntry(entry) || typeof entry === "string" || sourceRecordId(entry)) ids.add(sourceRecordId(entry) || key);
        }
      }
    }
  }
  for (const shard of Array.isArray(index?.shards) ? index.shards : []) {
    for (const id of shard?.ids || shard?.recordIds || []) ids.add(String(id));
  }
  return [...ids];
}

function assignmentMap(document) {
  if (!document || typeof document !== "object") return {};
  for (const key of ["assignments", "classifications", "records"]) {
    const value = document[key];
    if (value && !Array.isArray(value) && typeof value === "object") return value;
    if (Array.isArray(value)) return Object.fromEntries(value.map((entry) => [sourceRecordId(entry), entry]).filter(([id]) => id));
  }
  return {};
}

function canonicalClassificationDocument(existing, records, now, user) {
  const document = { ...(existing || {}) };
  delete document.assignments;
  delete document.classifications;
  document.format = document.format || "whycommunism-discord-classifications-v1";
  document.records = records;
  document.updatedAt = now;
  return { ...document, ...actorFields(user) };
}

function topicRecordIds(document) {
  const values = [
    document?.recordIds,
    document?.sourceIds,
    document?.references,
    document?.records
  ].filter(Array.isArray).flat();
  return [...new Set(values.map((entry) => typeof entry === "string" ? entry : sourceRecordId(entry)).filter(Boolean))];
}

function topicReferenceEntries(document) {
  const values = [
    document?.references,
    document?.recordIds,
    document?.sourceIds,
    document?.records
  ].filter(Array.isArray).flat();
  const entries = values.map((entry) => (
    typeof entry === "string" ? { recordId: entry } : { ...entry, recordId: sourceRecordId(entry) }
  )).filter((entry) => entry.recordId);
  return [...new Map(entries.map((entry) => [entry.recordId, entry])).values()];
}

function topicReferenceDocument(existing, path, recordId, reference, now, user) {
  const document = { ...(existing || {}) };
  const references = topicReferenceEntries(document).filter((entry) => entry.recordId !== recordId);
  if (reference) references.push(reference);
  delete document.recordIds;
  delete document.sourceIds;
  delete document.records;
  document.format = document.format || "whycommunism-topic-references-v1";
  document.path = path;
  document.references = references;
  document.updatedAt = now;
  return { ...document, ...actorFields(user) };
}

function d1ReadSelected(env) {
  if (!env.ARCHIVE_DB) return false;
  const backend = String(env.READ_BACKEND || "d1").trim().toLocaleLowerCase("en-US");
  return backend === "d1";
}

async function d1BindingReady(env) {
  if (!env.ARCHIVE_DB) return false;
  const row = await env.ARCHIVE_DB.prepare(
    "SELECT value FROM archive_meta WHERE key = 'runtime_ready'"
  ).first();
  return String(row?.value || "") === "1";
}

async function d1RuntimeReady(env) {
  return d1ReadSelected(env) && await d1BindingReady(env);
}

async function tryD1Read(env, operation) {
  if (!d1ReadSelected(env)) return { used: false, value: null };
  try {
    if (!await d1RuntimeReady(env)) return { used: false, value: null };
    return { used: true, value: await operation(env.ARCHIVE_DB) };
  } catch (error) {
    console.warn("D1 archive read failed; using canonical GitHub fallback.", error);
    return { used: false, value: null };
  }
}

async function mirrorD1IfReady(env, operation) {
  if (!env.ARCHIVE_DB) return false;
  try {
    if (!await d1BindingReady(env)) return false;
    await operation(env.ARCHIVE_DB);
    return true;
  } catch (error) {
    // GitHub has already accepted the canonical mutation at this point. Do not
    // invite a duplicate retry; report the runtime lag and let a rebuild repair
    // the disposable D1 read model.
    console.error("D1 archive mirror failed after the canonical GitHub write.", error);
    return false;
  }
}

async function useD1Writes(env) {
  if (!d1ReadSelected(env)) return false;
  try { return await d1BindingReady(env); }
  catch (_) { return false; }
}

function parseStoredJson(value, fallback = null) {
  try { return JSON.parse(String(value || "")); }
  catch (_) { return fallback; }
}

function readLimit(url, fallback, maximum = 1_000) {
  const requested = Number.parseInt(url.searchParams.get("limit") || "", 10);
  return Number.isFinite(requested) ? Math.max(1, Math.min(maximum, requested)) : fallback;
}

function archiveCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(String(value))));
    const createdAt = utcTimestamp(decoded?.createdAt, false);
    const recordId = String(decoded?.recordId || "");
    if (!createdAt || !recordId || recordId.length > 240) return null;
    return { createdAt, recordId };
  } catch (_) {
    return null;
  }
}

function encodeArchiveCursor(createdAt, recordId) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    createdAt: utcTimestamp(createdAt),
    recordId: String(recordId || "")
  })));
}

function d1Assignment(row) {
  return parseStoredJson(row?.assignment_json, null);
}

function isWebsiteContribution(record) {
  return Boolean(
    record &&
    String(sourceRecordId(record)).startsWith("manual:") &&
    String(record?.source?.kind || record?.sourceKind || "") === "whycommunism-member-contribution" &&
    String(record?.messageType || "") === "website-contribution"
  );
}

function sourceAuthorDiscordId(record) {
  return String(record?.author?.discordId || record?.author?.id || record?.authorId || "");
}

function sourceContentValues(record) {
  const content = record?.content;
  if (content && typeof content === "object") {
    return {
      text: String(content.text ?? content.markdown ?? ""),
      markdown: String(content.markdown ?? content.text ?? "")
    };
  }
  return { text: String(content || ""), markdown: String(content || "") };
}

function applyMessageOverlay(record, overlayValue) {
  if (!record || !overlayValue) return record;
  const overlay = typeof overlayValue === "string"
    ? parseStoredJson(overlayValue, null)
    : overlayValue;
  if (!overlay || String(overlay.recordId || "") !== sourceRecordId(record)) return record;
  const originalContent = record.content && typeof record.content === "object" ? record.content : {};
  const content = {
    ...originalContent,
    text: String(overlay?.content?.text ?? overlay.contentText ?? originalContent.text ?? ""),
    markdown: String(overlay?.content?.markdown ?? overlay.contentMarkdown ?? overlay?.content?.text ?? originalContent.markdown ?? originalContent.text ?? "")
  };
  // Sanitized export HTML belongs to the immutable original. Once a member
  // edits their website contribution, render the edited Markdown instead.
  delete content.html;
  return {
    ...record,
    content,
    editedAt: String(overlay.editedAt || ""),
    editedBy: String(overlay.editedBy || ""),
    editedByDiscordId: String(overlay.editedByDiscordId || ""),
    currentRevision: {
      version: Number(overlay.version || 0),
      editedAt: String(overlay.editedAt || ""),
      editedBy: String(overlay.editedBy || "")
    },
    revisionCount: Number(overlay.version || 0)
  };
}

async function d1ImmutableSourceRecord(db, id) {
  const row = await db.prepare(
    "SELECT record_json FROM archive_records WHERE record_id = ?"
  ).bind(id).first();
  return parseStoredJson(row?.record_json, null);
}

async function d1SourceRecord(db, id) {
  const row = await db.prepare(
    "SELECT ar.record_json, mo.overlay_json " +
    "FROM archive_records ar LEFT JOIN message_overlays mo ON mo.record_id = ar.record_id " +
    "WHERE ar.record_id = ?"
  ).bind(id).first();
  return applyMessageOverlay(parseStoredJson(row?.record_json, null), row?.overlay_json);
}

async function githubMessageOverlay(env, id, cache = new Map()) {
  const file = dataFile("message-overlays", id);
  const key = "overlay:" + id;
  if (!cache.has(key)) cache.set(key, await currentJsonFile(env, file));
  return cache.get(key);
}

async function immutableSourceRecord(env, id, cache = new Map()) {
  const runtime = await tryD1Read(env, (db) => d1ImmutableSourceRecord(db, id));
  if (runtime.used) return runtime.value;
  return readSourceRecord(env, id, cache);
}

async function resolvedSourceRecord(env, id, cache = new Map()) {
  const runtime = await tryD1Read(env, (db) => d1SourceRecord(db, id));
  if (runtime.used) return runtime.value;
  const record = await readSourceRecord(env, id, cache);
  if (!isWebsiteContribution(record)) return record;
  const overlay = await githubMessageOverlay(env, id, cache);
  return applyMessageOverlay(record, overlay.document);
}

async function d1Sources(db, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(
    "SELECT ar.record_id, ar.record_json, mo.overlay_json FROM archive_records ar " +
    "LEFT JOIN message_overlays mo ON mo.record_id = ar.record_id " +
    "WHERE ar.record_id IN (" + placeholders + ")"
  ).bind(...ids).all();
  const byId = new Map((result.results || []).map((row) => [
    String(row.record_id),
    applyMessageOverlay(parseStoredJson(row.record_json, null), row.overlay_json)
  ]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function d1Topic(db, request, path) {
  const url = new URL(request.url);
  const limit = readLimit(url, 1_000);
  const cursor = archiveCursor(url.searchParams.get("cursor"));
  const parameters = [path];
  let after = "";
  if (cursor) {
    after = " AND (tr.record_created_at > ? OR (tr.record_created_at = ? AND tr.record_id > ?))";
    parameters.push(cursor.createdAt, cursor.createdAt, cursor.recordId);
  }
  const [metadata, totalRow, page] = await Promise.all([
    db.prepare(
      "SELECT title, filters_json, notes FROM topic_metadata WHERE topic_path = ?"
    ).bind(path).first(),
    db.prepare(
      "SELECT COUNT(*) AS total FROM topic_references WHERE topic_path = ?"
    ).bind(path).first(),
    db.prepare(
      "SELECT tr.record_id, tr.record_created_at, ar.record_json, mo.overlay_json, c.assignment_json " +
      "FROM topic_references tr " +
      "JOIN archive_records ar ON ar.record_id = tr.record_id " +
      "LEFT JOIN message_overlays mo ON mo.record_id = tr.record_id " +
      "LEFT JOIN classifications c ON c.record_id = tr.record_id " +
      "WHERE tr.topic_path = ?" + after + " " +
      "ORDER BY tr.record_created_at, tr.record_id LIMIT ?"
    ).bind(...parameters, limit + 1).all()
  ]);
  const rows = page.results || [];
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const records = selected.map((row) => (
    applyMessageOverlay(parseStoredJson(row.record_json, null), row.overlay_json)
  )).filter(Boolean);
  const assignments = Object.fromEntries(selected.map((row) => [
    String(row.record_id),
    d1Assignment(row)
  ]).filter(([, assignment]) => assignment));
  const last = selected[selected.length - 1];
  const output = {
    path,
    title: String(metadata?.title || ""),
    records,
    assignments,
    sha: "d1",
    referencesSha: "d1",
    backend: "d1",
    limit,
    total: Number(totalRow?.total || 0),
    hasMore,
    nextCursor: hasMore && last
      ? encodeArchiveCursor(last.record_created_at, last.record_id)
      : null
  };
  const filters = parseStoredJson(metadata?.filters_json, null);
  if (filters != null) output.filters = filters;
  if (metadata?.notes != null) output.notes = metadata.notes;
  return output;
}

async function d1Inbox(db, url) {
  const limit = readLimit(url, 50, 250);
  const cursor = archiveCursor(url.searchParams.get("cursor"));
  const pageNumber = Math.max(1, Math.min(10_000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const status = String(url.searchParams.get("status") || "").trim().toLocaleLowerCase("en-US");
  const query = String(url.searchParams.get("query") || "").trim().toLocaleLowerCase("en-US").slice(0, 240);
  const channel = String(url.searchParams.get("channel") || "").trim().toLocaleLowerCase("en-US").slice(0, 240);
  const conditions = [];
  const parameters = [];
  if (status && status !== "all") {
    if (status === "unclassified") conditions.push("c.record_id IS NULL");
    else if (status === "classified") conditions.push("c.record_id IS NOT NULL");
    else {
      conditions.push("LOWER(COALESCE(c.review_status, 'unclassified')) = ?");
      parameters.push(status);
    }
  }
  if (channel) {
    conditions.push("LOWER(COALESCE(ar.channel_id, '') || ' ' || COALESCE(ar.channel_name, '')) LIKE ?");
    parameters.push("%" + channel + "%");
  }
  if (query) {
    conditions.push(
      "LOWER(COALESCE(ar.content_text, '') || ' ' || COALESCE(ar.author_name, '') || ' ' || COALESCE(ar.channel_name, '')) LIKE ?"
    );
    parameters.push("%" + query + "%");
  }
  const baseWhere = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const pageConditions = [...conditions];
  const pageParameters = [...parameters];
  if (cursor) {
    pageConditions.push("(ar.created_at > ? OR (ar.created_at = ? AND ar.record_id > ?))");
    pageParameters.push(cursor.createdAt, cursor.createdAt, cursor.recordId);
  }
  const pageWhere = pageConditions.length ? " WHERE " + pageConditions.join(" AND ") : "";
  const offset = cursor ? 0 : (pageNumber - 1) * limit;
  const [totalRow, result] = await Promise.all([
    db.prepare(
      "SELECT COUNT(*) AS total FROM archive_records ar LEFT JOIN classifications c ON c.record_id = ar.record_id" + baseWhere
    ).bind(...parameters).first(),
    db.prepare(
      "SELECT ar.record_id, ar.created_at, ar.record_json, mo.overlay_json, c.assignment_json " +
      "FROM archive_records ar " +
      "LEFT JOIN message_overlays mo ON mo.record_id = ar.record_id " +
      "LEFT JOIN classifications c ON c.record_id = ar.record_id" +
      pageWhere + " ORDER BY ar.created_at, ar.record_id LIMIT ? OFFSET ?"
    ).bind(...pageParameters, limit + 1, offset).all()
  ]);
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const records = selected.map((row) => (
    applyMessageOverlay(parseStoredJson(row.record_json, null), row.overlay_json)
  )).filter(Boolean);
  const assignments = Object.fromEntries(selected.map((row) => [
    String(row.record_id),
    d1Assignment(row)
  ]).filter(([, assignment]) => assignment));
  const last = selected[selected.length - 1];
  return {
    records,
    assignments,
    page: pageNumber,
    pageSize: limit,
    limit,
    total: Number(totalRow?.total || 0),
    hasMore,
    nextCursor: hasMore && last ? encodeArchiveCursor(last.created_at, last.record_id) : null,
    sha: "d1",
    backend: "d1"
  };
}

async function d1Classification(db, recordId) {
  const row = await db.prepare(
    "SELECT assignment_json FROM classifications WHERE record_id = ?"
  ).bind(recordId).first();
  return d1Assignment(row);
}

function d1RecordFields(record, importedAt) {
  const channel = record?.channel && typeof record.channel === "object" ? record.channel : {};
  const guild = record?.guild && typeof record.guild === "object" ? record.guild : {};
  const author = record?.author && typeof record.author === "object" ? record.author : {};
  const content = record?.content && typeof record.content === "object"
    ? String(record.content.text || record.content.markdown || "")
    : String(record?.content || "");
  return [
    sourceRecordId(record),
    String(record?.immutableHash || ""),
    JSON.stringify(record),
    String(record?.messageId || ""),
    String(record?.source?.kind || record?.sourceKind || "whycommunism-member-contribution"),
    String(guild.id || record?.guildId || ""),
    String(channel.id || record?.channelId || ""),
    String(channel.name || record?.channelName || ""),
    String(channel.parent || ""),
    String(author.id || ""),
    String(author.displayName || author.name || author.username || ""),
    content,
    utcTimestamp(record?.createdAt || record?.timestamp),
    record?.editedAt ? utcTimestamp(record.editedAt, false) : null,
    String(record?.source?.kind || "").includes("member-contribution") || String(record?.id || "").startsWith("manual:") ? 1 : 0,
    importedAt
  ];
}

function d1AssetRows(record) {
  const groups = [
    ["attachment", record?.attachments],
    ["media", record?.media]
  ];
  const rows = [];
  for (const [kind, values] of groups) {
    if (!Array.isArray(values)) continue;
    values.forEach((asset, index) => {
      if (!asset || typeof asset !== "object") return;
      rows.push([
        sourceRecordId(record) + ":" + kind + ":" + index,
        sourceRecordId(record),
        String(asset.kind || kind),
        String(asset.filename || asset.name || ""),
        String(asset.contentType || asset.content_type || ""),
        Number.isFinite(Number(asset.size || asset.byteSize)) ? Number(asset.size || asset.byteSize) : null,
        String(asset.sourceUrl || asset.url || ""),
        String(asset.archivePath || asset.path || ""),
        JSON.stringify(asset),
        record?.createdAt ? utcTimestamp(record.createdAt) : null
      ]);
    });
  }
  return rows;
}

function d1ClassificationFields(assignment) {
  return [
    String(assignment.recordId || ""),
    assignment.primaryTopic || null,
    JSON.stringify(Array.isArray(assignment.secondaryTopics) ? assignment.secondaryTopics : []),
    Number(assignment.confidence?.score || 0),
    String(assignment.confidence?.label || ""),
    assignment.relevance || null,
    String(assignment.reviewStatus || "unreviewed"),
    String(assignment.note || assignment.rationale || ""),
    JSON.stringify(assignment),
    utcTimestamp(assignment.updatedAt),
    String(assignment.updatedBy || ""),
    String(assignment.updatedByDiscordId || "")
  ];
}

function d1ClassificationStatement(db, assignment) {
  return db.prepare(
    "INSERT INTO classifications (" +
      "record_id, primary_topic, secondary_topics_json, confidence_score, confidence_label, relevance, " +
      "review_status, note, assignment_json, updated_at, updated_by, updated_by_discord_id" +
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(record_id) DO UPDATE SET " +
      "primary_topic = excluded.primary_topic, secondary_topics_json = excluded.secondary_topics_json, " +
      "confidence_score = excluded.confidence_score, confidence_label = excluded.confidence_label, " +
      "relevance = excluded.relevance, review_status = excluded.review_status, note = excluded.note, " +
      "assignment_json = excluded.assignment_json, updated_at = excluded.updated_at, " +
      "updated_by = excluded.updated_by, updated_by_discord_id = excluded.updated_by_discord_id"
  ).bind(...d1ClassificationFields(assignment));
}

function d1TopicReferenceStatement(db, path, recordId, role, assignment) {
  const score = Number(assignment.confidence?.score || 0);
  const confidence = String(assignment.confidence?.label || (score >= 0.75 ? "high" : score >= 0.4 ? "medium" : "low"));
  return db.prepare(
    "INSERT INTO topic_references (" +
      "topic_path, record_id, role, score, confidence_label, record_created_at, updated_at" +
    ") SELECT ?, record_id, ?, ?, ?, created_at, ? FROM archive_records WHERE record_id = ? " +
    "ON CONFLICT(topic_path, record_id) DO UPDATE SET " +
      "role = excluded.role, score = excluded.score, confidence_label = excluded.confidence_label, " +
      "record_created_at = excluded.record_created_at, updated_at = excluded.updated_at"
  ).bind(path, role, score, confidence, utcTimestamp(assignment.updatedAt), recordId);
}

function d1RevisionEventStatement(db, event) {
  return db.prepare(
    "INSERT OR IGNORE INTO revision_events (" +
      "event_id, entity_type, entity_id, action, event_json, created_at, actor_name, actor_discord_id" +
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    String(event?.eventId || crypto.randomUUID()),
    String(event?.type === "classification-updated" ? "classification" : "source-record"),
    String(event?.payload?.recordId || ""),
    String(event?.type || "updated"),
    JSON.stringify(event || {}),
    utcTimestamp(event?.createdAt),
    String(event?.updatedBy || ""),
    String(event?.updatedByDiscordId || "")
  );
}

async function d1MirrorMemberPost(db, record, assignment, path, event = null) {
  const now = utcTimestamp(assignment.updatedAt || record.createdAt);
  const statements = [
    db.prepare(
      "INSERT OR IGNORE INTO archive_records (" +
        "record_id, immutable_hash, record_json, message_id, source_kind, guild_id, channel_id, channel_name, " +
        "channel_parent, author_id, author_name, content_text, created_at, edited_at, is_manual, imported_at" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(...d1RecordFields(record, now)),
    d1ClassificationStatement(db, assignment),
    d1TopicReferenceStatement(db, path, sourceRecordId(record), "primary", assignment)
  ];
  if (event) statements.push(d1RevisionEventStatement(db, event));
  for (const asset of d1AssetRows(record)) {
    statements.push(db.prepare(
      "INSERT OR IGNORE INTO archive_assets (" +
        "asset_id, record_id, kind, filename, content_type, byte_size, source_url, archive_path, metadata_json, created_at" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(...asset));
  }
  await db.batch(statements);
}

async function d1MessageOverlay(db, recordId) {
  const row = await db.prepare(
    "SELECT overlay_json FROM message_overlays WHERE record_id = ?"
  ).bind(recordId).first();
  return parseStoredJson(row?.overlay_json, null);
}

function d1MessageOverlayStatement(db, overlay) {
  return db.prepare(
    "INSERT INTO message_overlays (" +
      "record_id, content_text, content_markdown, attachments_json, overlay_json, version, " +
      "edited_at, edited_by, edited_by_discord_id" +
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(record_id) DO UPDATE SET " +
      "content_text = excluded.content_text, content_markdown = excluded.content_markdown, " +
      "attachments_json = excluded.attachments_json, overlay_json = excluded.overlay_json, " +
      "version = excluded.version, edited_at = excluded.edited_at, edited_by = excluded.edited_by, " +
      "edited_by_discord_id = excluded.edited_by_discord_id"
  ).bind(
    String(overlay.recordId || ""),
    String(overlay?.content?.text ?? ""),
    String(overlay?.content?.markdown ?? overlay?.content?.text ?? ""),
    overlay.attachments == null ? null : JSON.stringify(overlay.attachments),
    JSON.stringify(overlay),
    Number(overlay.version || 0),
    utcTimestamp(overlay.editedAt),
    String(overlay.editedBy || ""),
    String(overlay.editedByDiscordId || "")
  );
}

async function d1MirrorMessageEdit(db, overlay, event) {
  await db.batch([
    d1MessageOverlayStatement(db, overlay),
    d1RevisionEventStatement(db, event)
  ]);
}

async function d1MessageEditEvents(db, recordId) {
  const result = await db.prepare(
    "SELECT event_json FROM revision_events " +
    "WHERE entity_type = 'source-record' AND entity_id = ? AND action = 'member-message-edited' " +
    "ORDER BY created_at, event_id"
  ).bind(recordId).all();
  return (result.results || []).map((row) => parseStoredJson(row.event_json, null)).filter(Boolean);
}

async function d1MirrorClassification(db, assignment, event = null) {
  const statements = [
    d1ClassificationStatement(db, assignment),
    db.prepare("DELETE FROM topic_references WHERE record_id = ?").bind(assignment.recordId)
  ];
  if (event) statements.push(d1RevisionEventStatement(db, event));
  if (assignment.primaryTopic) {
    statements.push(d1TopicReferenceStatement(db, assignment.primaryTopic, assignment.recordId, "primary", assignment));
  }
  for (const path of Array.isArray(assignment.secondaryTopics) ? assignment.secondaryTopics : []) {
    statements.push(d1TopicReferenceStatement(db, path, assignment.recordId, "secondary", assignment));
  }
  await db.batch(statements);
}

async function d1MirrorTopicMetadata(db, document) {
  await db.prepare(
    "INSERT INTO topic_metadata (topic_path, title, filters_json, notes, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(topic_path) DO UPDATE SET title = excluded.title, filters_json = excluded.filters_json, " +
    "notes = excluded.notes, updated_at = excluded.updated_at"
  ).bind(
    String(document.path || ""),
    String(document.title || ""),
    document.filters == null ? null : JSON.stringify(document.filters),
    document.notes ?? document.editorialNotes ?? null,
    utcTimestamp(document.updatedAt)
  ).run();
}

async function getTopic(request, env, path) {
  const runtime = await tryD1Read(env, (db) => d1Topic(db, request, path));
  if (runtime.used) return json(request, runtime.value);
  const [references, classifications] = await Promise.all([
    currentJsonFile(env, dataFile("topic-references", path)),
    currentJsonFile(env, "classifications/discord.json")
  ]);
  const ids = topicRecordIds(references.document || {});
  const cache = new Map();
  const records = [];
  for (const id of ids) {
    const record = await resolvedSourceRecord(env, id, cache);
    if (record) records.push(record);
  }
  const allAssignments = assignmentMap(classifications.document);
  const assignments = Object.fromEntries(ids.filter((id) => allAssignments[id]).map((id) => [id, allAssignments[id]]));
  const output = {
    path,
    title: String(references.document?.title || ""),
    records,
    assignments,
    sha: classifications.sha || "",
    referencesSha: references.sha || ""
  };
  if (references.document?.filters != null) output.filters = references.document.filters;
  if (references.document?.notes != null || references.document?.editorialNotes != null) {
    output.notes = references.document.notes ?? references.document.editorialNotes;
  }
  return json(request, output);
}

async function saveTopicNotes(request, env, path, user) {
  const body = await parseBody(request);
  const current = await currentJsonFile(env, dataFile("topic-references", path));
  if (current.sha !== String(body.baseSha || "")) return conflictResponse(request, current, "These topic notes changed somewhere else.");
  const notes = body.notes ?? body.editorialNotes;
  if (typeof notes !== "string" || notes.length > 100_000) throw new Error("Invalid topic editorial notes.");
  const now = new Date().toISOString();
  const document = {
    ...(current.document || {}),
    format: current.document?.format || "whycommunism-topic-references-v1",
    path,
    ...(body.title != null ? { title: String(body.title).trim().slice(0, 240) } : {}),
    notes,
    updatedAt: now,
    ...actorFields(user)
  };
  const result = await saveJsonFile(env, current, document, commitMessage("topic", body.note || "Update editorial notes", user));
  const runtimeMirrored = await mirrorD1IfReady(env, (db) => d1MirrorTopicMetadata(db, document));
  return json(request, {
    ok: true,
    path,
    notes,
    sha: result.content?.sha || "",
    commit: result.commit?.sha || "",
    updatedAt: now,
    updatedBy: user.displayName,
    runtimeMirrored
  });
}

async function getSource(request, env, id) {
  if (!id || id.length > 240) return json(request, { error: "Invalid source record id." }, 400);
  const runtime = await tryD1Read(env, (db) => d1SourceRecord(db, id));
  if (runtime.used) {
    return runtime.value ? json(request, runtime.value) : json(request, { error: "That source record was not found." }, 404);
  }
  const record = await resolvedSourceRecord(env, id);
  return record ? json(request, record) : json(request, { error: "That source record was not found." }, 404);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

async function immutableHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function putSource(request, env, id, user) {
  const body = await parseBody(request);
  const record = body?.record && typeof body.record === "object" ? body.record : body;
  const recordId = id || sourceRecordId(record);
  if (!recordId || recordId.length > 240 || sourceRecordId(record) !== recordId) throw new Error("The source record id is invalid or does not match.");
  const existing = await readSourceRecord(env, recordId);
  if (existing) {
    if (JSON.stringify(stableValue(existing)) === JSON.stringify(stableValue(record))) {
      return json(request, { ok: true, id: recordId, created: false, idempotent: true });
    }
    return json(request, { error: "Source records are immutable.", immutable: true }, 409);
  }
  const shard = sourceShardPath("manual-" + recordId.replace(/[^a-zA-Z0-9._-]/g, "-"));
  const shardCurrent = await currentJsonFile(env, shard);
  const shardDocument = shardCurrent.document || { format: "whycommunism-discord-source-shard-v1", records: [] };
  const shardRecords = recordsInShard(shardDocument);
  const document = { ...shardDocument, records: [...shardRecords, record] };
  const shardResult = await saveJsonFile(env, shardCurrent, document, commitMessage("source", "Import " + recordId, user));
  const index = await currentJsonFile(env, "source-index/discord.json");
  const indexDocument = index.document || { format: "whycommunism-discord-source-index-v1", records: {} };
  const records = indexDocument.records && !Array.isArray(indexDocument.records) ? { ...indexDocument.records } : {};
  records[recordId] = { shard: shard.replace(/^source-records\//, "") };
  const now = new Date().toISOString();
  const result = await saveJsonFile(env, index, {
    ...indexDocument,
    records,
    updatedAt: now,
    ...actorFields(user)
  }, commitMessage("source-index", "Index " + recordId, user));
  return json(request, {
    ok: true,
    id: recordId,
    created: true,
    idempotent: false,
    sha: shardResult.content?.sha || "",
    indexSha: result.content?.sha || ""
  }, 201);
}

async function postTopicMessage(request, env, path, user) {
  if (!originFor(request)) return json(request, { error: "Messages are accepted only from Why Communism." }, 403);
  const body = await parseBody(request, MAX_ATTACHMENT_REQUEST_BYTES);
  const content = String(body?.content || "").replace(/\r\n?/g, "\n");
  const requestedAttachments = body?.attachments == null ? [] : body.attachments;
  if (!Array.isArray(requestedAttachments) || requestedAttachments.length > 4) {
    return json(request, { error: "A message can include up to four files." }, 400);
  }
  let totalAttachmentBytes = 0;
  for (const attachment of requestedAttachments) {
    if (!attachment || typeof attachment !== "object") return json(request, { error: "That attachment is invalid." }, 400);
    const filename = cleanFilename(attachment.filename);
    attachmentType(filename, attachment.contentType);
    const bytes = decodeBase64(String(attachment.base64 || "").replace(/\s/g, ""));
    if (!bytes.byteLength) return json(request, { error: "Attachments cannot be empty." }, 400);
    totalAttachmentBytes += bytes.byteLength;
  }
  if (totalAttachmentBytes > MAX_ATTACHMENT_BYTES) {
    return json(request, { error: "Files in one message must total 8 MB or less." }, 400);
  }
  if ((!content.trim() && !requestedAttachments.length) || content.length > 100_000) {
    return json(request, { error: "Write a message or add a file. Message text can be up to 100,000 characters." }, 400);
  }
  const requestedReply = String(body?.replyTo || "").trim();
  if (requestedReply.length > 240) return json(request, { error: "That reply target is invalid." }, 400);
  let replyTo = null;
  if (requestedReply) {
    const parent = await resolvedSourceRecord(env, requestedReply);
    if (!parent) return json(request, { error: "The message you are replying to was not found." }, 404);
    replyTo = {
      recordId: requestedReply,
      ...(parent.messageId ? { messageId: String(parent.messageId) } : {})
    };
  }

  const now = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const recordId = "manual:" + String(env.DISCORD_GUILD_ID || "ump") + ":" + messageId;
  const attachments = [];
  for (const attachment of requestedAttachments) {
    const stored = await storePrivateAttachment(env, path, attachment, user);
    attachments.push({
      id: "website-attachment:" + crypto.randomUUID(),
      filename: stored.filename,
      contentType: stored.contentType,
      size: stored.bytes,
      archivePath: stored.archivePath,
      sha: stored.sha,
      kind: stored.contentType.startsWith("image/") ? "image" : "document",
      private: true,
      uploadedAt: now,
      uploadedByDiscordId: String(user.discordId || "")
    });
  }
  const recordWithoutHash = {
    format: "whycommunism-discord-source-v1",
    id: recordId,
    sourceKey: recordId,
    messageId,
    messageType: "website-contribution",
    guild: {
      id: String(env.DISCORD_GUILD_ID || ""),
      name: "United Marxist Pact"
    },
    channel: {
      id: "whycommunism-source-archive",
      name: "website-contributions",
      parent: "Why Communism?",
      topicPath: path
    },
    author: {
      id: String(user.discordId || ""),
      username: String(user.username || ""),
      displayName: String(user.displayName || user.username || "UMP member"),
      avatar: user.avatar ? {
        name: "Avatar",
        sourceUrl: String(user.avatar),
        downloaded: false,
        kind: "avatar"
      } : null
    },
    createdAt: now,
    editedAt: "",
    content: {
      text: content,
      markdown: content
    },
    replyTo,
    attachments,
    media: [],
    embeds: [],
    reactions: [],
    poll: null,
    source: {
      kind: "whycommunism-member-contribution",
      topicPath: path,
      createdVia: "source-archive"
    },
    losses: {
      reactionUsersUnavailable: false,
      pollDetailsUnavailable: false,
      priorEditVersionsUnavailable: false,
      mediaDownloadsIncomplete: false
    }
  };
  const record = { ...recordWithoutHash, immutableHash: await immutableHash(recordWithoutHash) };

  // A new file per contribution keeps the source record immutable and prevents
  // concurrent member posts from competing for the same shard SHA.
  const shard = sourceShardPath("manual-" + messageId);
  const shardCurrent = await currentJsonFile(env, shard);
  if (shardCurrent.document) return json(request, { error: "That generated source id already exists." }, 409);
  const shardResult = await saveJsonFile(env, shardCurrent, {
    format: "whycommunism-discord-source-shard-v1",
    records: [record],
    createdAt: now,
    ...actorFields(user)
  }, commitMessage("source", "Post member contribution " + messageId, user));

  const assignment = {
    recordId,
    primaryTopic: path,
    secondaryTopics: [],
    confidence: { score: 1, label: "manual" },
    reviewStatus: "unreviewed",
    state: "classified",
    rationale: "Posted directly to this topic by a verified UMP member.",
    updatedAt: now,
    ...actorFields(user)
  };

  // Once the D1 runtime is ready, GitHub stores one small immutable source file
  // and one small append-only event. Rewriting the multi-megabyte generated
  // classification/index snapshots for every message would be both slow and
  // conflict-prone. Those snapshots remain available only as a cutover fallback.
  if (await useD1Writes(env)) {
    const event = await saveArchiveEvent(env, "member-message-created", {
      recordId,
      topicPath: path,
      sourceFile: shard,
      sourceSha: shardResult.content?.sha || "",
      immutableHash: record.immutableHash,
      assignment,
      attachmentPaths: attachments.map((attachment) => attachment.archivePath)
    }, user, now);
    const runtimeMirrored = await mirrorD1IfReady(
      env,
      (db) => d1MirrorMemberPost(db, record, assignment, path, event.document)
    );
    return json(request, {
      ok: true,
      record,
      assignment,
      sourceSha: shardResult.content?.sha || "",
      eventId: event.eventId,
      eventFile: event.file,
      eventSha: event.sha,
      commit: event.commit,
      createdAt: now,
      createdBy: user.displayName,
      runtimeMirrored
    }, 201);
  }

  const index = await currentJsonFile(env, "source-index/discord.json");
  const indexDocument = index.document || { format: "whycommunism-discord-source-index-v1", manualRecords: {} };
  const manualRecords = indexDocument.manualRecords && !Array.isArray(indexDocument.manualRecords) ? { ...indexDocument.manualRecords } : {};
  manualRecords[recordId] = {
    shard: shard.replace(/^source-records\/discord-shards\//, "").replace(/\.json$/, ""),
    messageId,
    channelId: "whycommunism-source-archive",
    createdAt: now,
    immutableHash: record.immutableHash,
    manual: true
  };
  const indexResult = await saveJsonFile(env, index, {
    ...indexDocument,
    manualRecords,
    manualRecordCount: Object.keys(manualRecords).length,
    recordCount: Number.isFinite(Number(indexDocument.recordCount)) ? Number(indexDocument.recordCount) + 1 : Object.keys(manualRecords).length,
    updatedAt: now,
    ...actorFields(user)
  }, commitMessage("source-index", "Index member contribution " + messageId, user));

  const classifications = await currentJsonFile(env, "classifications/discord.json");
  const records = { ...assignmentMap(classifications.document), [recordId]: assignment };
  const classificationsResult = await saveJsonFile(env, classifications, {
    ...canonicalClassificationDocument(classifications.document, records, now, user)
  }, commitMessage("classification", "Classify member contribution " + messageId, user));

  const references = await currentJsonFile(env, dataFile("topic-references", path));
  const referencesDocument = references.document || {
    format: "whycommunism-topic-references-v1",
    path,
    references: []
  };
  const reference = { recordId, role: "primary", score: 1, confidence: "manual" };
  const updatedReferences = { ...referencesDocument, path, updatedAt: now, ...actorFields(user) };
  if (Array.isArray(referencesDocument.recordIds)) {
    updatedReferences.recordIds = [...new Set([...referencesDocument.recordIds.map(String), recordId])];
  } else if (Array.isArray(referencesDocument.sourceIds)) {
    updatedReferences.sourceIds = [...new Set([...referencesDocument.sourceIds.map(String), recordId])];
  } else if (Array.isArray(referencesDocument.references)) {
    updatedReferences.references = [
      ...referencesDocument.references.filter((entry) => sourceRecordId(entry) !== recordId),
      reference
    ];
  } else if (Array.isArray(referencesDocument.records)) {
    updatedReferences.records = [
      ...referencesDocument.records.filter((entry) => sourceRecordId(entry) !== recordId),
      reference
    ];
  } else {
    updatedReferences.references = [reference];
  }
  const referencesResult = await saveJsonFile(env, references, updatedReferences, commitMessage("topic", "Add member contribution " + messageId, user));
  const runtimeMirrored = await mirrorD1IfReady(
    env,
    (db) => d1MirrorMemberPost(db, record, assignment, path)
  );

  return json(request, {
    ok: true,
    record,
    assignment,
    sourceSha: shardResult.content?.sha || "",
    indexSha: indexResult.content?.sha || "",
    classificationsSha: classificationsResult.content?.sha || "",
    referencesSha: referencesResult.content?.sha || "",
    commit: referencesResult.commit?.sha || "",
    createdAt: now,
    createdBy: user.displayName,
    runtimeMirrored
  }, 201);
}

function messageEditVersion(event) {
  const payload = event?.payload || {};
  const after = payload.after || {};
  const content = after.content && typeof after.content === "object"
    ? after.content
    : { text: after.contentText || "", markdown: after.contentMarkdown || after.contentText || "" };
  return {
    version: Number(payload.version || after.version || 0),
    content: {
      text: String(content.text ?? content.markdown ?? ""),
      markdown: String(content.markdown ?? content.text ?? "")
    },
    note: String(payload.note || ""),
    editedAt: String(event?.createdAt || after.editedAt || ""),
    editedBy: String(event?.updatedBy || after.editedBy || ""),
    editedByDiscordId: String(event?.updatedByDiscordId || after.editedByDiscordId || ""),
    eventId: String(event?.eventId || ""),
    eventFile: String(payload.eventFile || "")
  };
}

async function updateTopicMessage(request, env, path, user) {
  const body = await parseBody(request, 256_000);
  const recordId = String(body?.recordId || "").trim();
  if (!recordId || recordId.length > 240) return json(request, { error: "A valid source message id is required." }, 400);

  const original = await immutableSourceRecord(env, recordId);
  if (!original) return json(request, { error: "That source message was not found." }, 404);
  if (!isWebsiteContribution(original)) {
    return json(request, {
      error: "Imported Discord records are immutable and cannot be edited here.",
      immutable: true
    }, 409);
  }
  if (
    user.provider !== "discord" ||
    !user.discordId ||
    sourceAuthorDiscordId(original) !== String(user.discordId)
  ) {
    return json(request, { error: "Only the member who posted this message can edit it." }, 403);
  }

  const content = String(body?.content ?? "").replace(/\r\n?/g, "\n");
  if (content.length > 100_000) return json(request, { error: "Message text can be up to 100,000 characters." }, 400);
  if (!content.trim() && !(Array.isArray(original.attachments) && original.attachments.length)) {
    return json(request, { error: "A message without an attachment cannot be empty." }, 400);
  }
  const note = String(body?.note || "").trim().slice(0, 160);
  const baseVersion = Number(body?.baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 0) {
    return json(request, { error: "A valid base message version is required." }, 400);
  }

  if (!env.GITHUB_TOKEN) {
    return json(request, { error: "The canonical revision ledger is not configured." }, 503);
  }
  const overlayCurrent = await githubMessageOverlay(env, recordId);
  let currentOverlay = overlayCurrent.document;
  if (!currentOverlay && env.ARCHIVE_DB) {
    try { currentOverlay = await d1MessageOverlay(env.ARCHIVE_DB, recordId); }
    catch (_) { currentOverlay = null; }
  }
  const currentVersion = Number(currentOverlay?.version || 0);
  if (baseVersion !== currentVersion) {
    return json(request, {
      error: "This message changed somewhere else. Reload its latest version before saving.",
      conflict: true,
      version: currentVersion
    }, 409);
  }
  const previous = currentOverlay?.content && typeof currentOverlay.content === "object"
    ? {
        text: String(currentOverlay.content.text ?? currentOverlay.content.markdown ?? ""),
        markdown: String(currentOverlay.content.markdown ?? currentOverlay.content.text ?? "")
      }
    : sourceContentValues(original);
  if (content === previous.markdown && content === previous.text) {
    return json(request, {
      ok: true,
      idempotent: true,
      record: applyMessageOverlay(original, currentOverlay),
      version: currentVersion
    });
  }

  const now = new Date().toISOString();
  const version = currentVersion + 1;
  const event = await saveArchiveEvent(env, "member-message-edited", {
    recordId,
    topicPath: String(original?.source?.topicPath || original?.channel?.topicPath || path),
    originalImmutableHash: String(original.immutableHash || ""),
    version,
    note,
    before: { version: currentVersion, content: previous },
    after: {
      version,
      content: { text: content, markdown: content },
      editedAt: now,
      editedBy: user.displayName,
      editedByDiscordId: user.discordId
    }
  }, user, now);
  const overlay = {
    format: "whycommunism-message-overlay-v1",
    recordId,
    originalImmutableHash: String(original.immutableHash || ""),
    version,
    content: { text: content, markdown: content },
    editedAt: now,
    editedBy: user.displayName,
    editedByDiscordId: String(user.discordId),
    editedByUsername: String(user.username || ""),
    eventFiles: [
      ...(Array.isArray(currentOverlay?.eventFiles) ? currentOverlay.eventFiles.map(String) : []),
      event.file
    ]
  };
  const overlayResult = await saveJsonFile(
    env,
    overlayCurrent,
    overlay,
    commitMessage("message-overlay", note || "Edit member message", user)
  );
  const runtimeMirrored = await mirrorD1IfReady(
    env,
    (db) => d1MirrorMessageEdit(db, overlay, event.document)
  );
  return json(request, {
    ok: true,
    idempotent: false,
    record: applyMessageOverlay(original, overlay),
    version,
    overlaySha: overlayResult.content?.sha || "",
    eventId: event.eventId,
    eventFile: event.file,
    eventSha: event.sha,
    commit: overlayResult.commit?.sha || event.commit,
    runtimeMirrored
  });
}

async function getTopicMessageHistory(request, env, recordId, user) {
  if (!recordId || recordId.length > 240) return json(request, { error: "A valid source message id is required." }, 400);
  const original = await immutableSourceRecord(env, recordId);
  if (!original) return json(request, { error: "That source message was not found." }, 404);
  if (!isWebsiteContribution(original)) {
    return json(request, {
      error: "Imported Discord records do not have website edit history.",
      immutable: true
    }, 409);
  }
  const isAuthor = user.provider === "discord" &&
    String(user.discordId || "") === sourceAuthorDiscordId(original);
  if (!isAuthor && !user.admin) {
    return json(request, { error: "Only the message author or an administrator can view this history." }, 403);
  }

  let events = [];
  const runtime = await tryD1Read(env, (db) => d1MessageEditEvents(db, recordId));
  if (runtime.used) {
    events = runtime.value;
  } else {
    const overlay = await githubMessageOverlay(env, recordId);
    for (const file of Array.isArray(overlay.document?.eventFiles) ? overlay.document.eventFiles : []) {
      const current = await currentJsonFile(env, String(file));
      if (
        current.document?.type === "member-message-edited" &&
        String(current.document?.payload?.recordId || "") === recordId
      ) events.push(current.document);
    }
  }
  events.sort((left, right) => (
    String(left?.createdAt || "").localeCompare(String(right?.createdAt || "")) ||
    String(left?.eventId || "").localeCompare(String(right?.eventId || ""))
  ));
  const originalContent = sourceContentValues(original);
  return json(request, {
    recordId,
    canEdit: isAuthor,
    originalImmutableHash: String(original.immutableHash || ""),
    versions: [
      {
        version: 0,
        content: originalContent,
        editedAt: String(original.createdAt || ""),
        editedBy: String(original?.author?.displayName || original?.author?.username || ""),
        editedByDiscordId: sourceAuthorDiscordId(original),
        original: true
      },
      ...events.map(messageEditVersion)
    ]
  });
}

async function getSources(request, env) {
  const body = await parseBody(request, 128_000);
  if (!Array.isArray(body?.ids) || body.ids.length > MAX_BATCH_SOURCES) throw new Error("Provide at most " + MAX_BATCH_SOURCES + " source ids.");
  const ids = [...new Set(body.ids.map(String).filter((id) => id && id.length <= 240))];
  const runtime = await tryD1Read(env, (db) => d1Sources(db, ids));
  if (runtime.used) {
    const found = new Set(runtime.value.map(sourceRecordId));
    return json(request, {
      records: runtime.value,
      missingIds: ids.filter((id) => !found.has(id)),
      backend: "d1"
    });
  }
  const records = [];
  const missingIds = [];
  const cache = new Map();
  for (const id of ids) {
    const record = await resolvedSourceRecord(env, id, cache);
    if (record) records.push(record);
    else missingIds.push(id);
  }
  return json(request, { records, missingIds });
}

async function getClassification(request, env, recordId) {
  if (!recordId || recordId.length > 240) return json(request, { error: "A valid source record id is required." }, 400);
  const runtime = await tryD1Read(env, (db) => d1Classification(db, recordId));
  if (runtime.used) {
    return runtime.value
      ? json(request, { assignment: runtime.value, sha: "d1", backend: "d1" })
      : json(request, { error: "That classification was not found." }, 404);
  }
  const current = await currentJsonFile(env, "classifications/discord.json");
  const assignment = assignmentMap(current.document)[recordId] || null;
  return assignment
    ? json(request, { assignment, sha: current.sha || "", backend: "github" })
    : json(request, { error: "That classification was not found." }, 404);
}

async function saveClassification(request, env, user) {
  const body = await parseBody(request, 256_000);
  const recordId = String(body.recordId || "");
  if (!recordId || recordId.length > 240) throw new Error("A valid source record id is required.");
  if (!await resolvedSourceRecord(env, recordId)) return json(request, { error: "That source record was not found." }, 404);
  const primaryTopic = body.primaryTopic == null || body.primaryTopic === "" ? null : String(body.primaryTopic);
  const secondaryTopics = Array.isArray(body.secondaryTopics)
    ? [...new Set(body.secondaryTopics.map(String))].filter((path) => path !== primaryTopic)
    : null;
  if ((primaryTopic && !validPath(primaryTopic)) || !secondaryTopics || secondaryTopics.length > 50 || secondaryTopics.some((path) => !validPath(path))) {
    throw new Error("Invalid topic classification.");
  }
  const score = Number(body.confidence?.score);
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("Invalid confidence score.");
  const confidence = { score, label: String(body.confidence?.label || "").trim().slice(0, 80) };
  const relevance = body.relevance == null || body.relevance === ""
    ? null
    : String(body.relevance).trim().toLocaleLowerCase("en-US");
  if (relevance && !["high", "medium", "low"].includes(relevance)) throw new Error("Invalid relevance.");
  const reviewStatus = String(body.reviewStatus || "").trim();
  if (!/^[a-z0-9][a-z0-9 _-]{0,79}$/i.test(reviewStatus)) throw new Error("Invalid review status.");
  const note = String(body.note || "");
  if (note.length > 100_000) throw new Error("The classification note is too long.");
  const now = new Date().toISOString();

  if (await useD1Writes(env)) {
    const previousAssignment = await d1Classification(env.ARCHIVE_DB, recordId) || {};
    const assignment = {
      recordId,
      primaryTopic,
      secondaryTopics,
      confidence,
      reviewStatus,
      ...(relevance ? { relevance } : previousAssignment.relevance ? { relevance: previousAssignment.relevance } : {}),
      note,
      updatedAt: now,
      ...actorFields(user)
    };
    const event = await saveArchiveEvent(env, "classification-updated", {
      recordId,
      previousTopics: [
        previousAssignment.primaryTopic,
        ...(Array.isArray(previousAssignment.secondaryTopics) ? previousAssignment.secondaryTopics : [])
      ].filter(Boolean),
      assignment
    }, user, now);
    const runtimeMirrored = await mirrorD1IfReady(
      env,
      (db) => d1MirrorClassification(db, assignment, event.document)
    );
    return json(request, {
      ok: true,
      assignment,
      sha: "d1",
      commit: event.commit,
      eventId: event.eventId,
      eventFile: event.file,
      eventSha: event.sha,
      referenceShas: Object.fromEntries(
        [primaryTopic, ...secondaryTopics].filter(Boolean).map((path) => [path, "d1"])
      ),
      updatedAt: now,
      updatedBy: user.displayName,
      runtimeMirrored
    });
  }

  const current = await currentJsonFile(env, "classifications/discord.json");
  if (body.baseSha != null && current.sha !== String(body.baseSha)) return conflictResponse(request, current, "The classifications changed somewhere else.");
  const existing = current.document || {};
  const previousAssignment = assignmentMap(existing)[recordId] || {};
  const assignment = {
    recordId,
    primaryTopic,
    secondaryTopics,
    confidence,
    reviewStatus,
    ...(relevance ? { relevance } : previousAssignment.relevance ? { relevance: previousAssignment.relevance } : {}),
    note,
    updatedAt: now,
    ...actorFields(user)
  };
  const records = { ...assignmentMap(existing), [recordId]: assignment };
  const document = canonicalClassificationDocument(existing, records, now, user);
  const result = await saveJsonFile(env, current, document, commitMessage("classification", "Classify " + recordId, user));

  // Topic-reference files are derived indexes. Keep the classification document
  // as the source of truth, then update every old or new topic so a moved record
  // cannot remain displayed under a stale topic.
  const desired = new Map();
  for (const path of secondaryTopics) desired.set(path, "secondary");
  if (primaryTopic) desired.set(primaryTopic, "primary");
  const affected = new Set([
    previousAssignment.primaryTopic,
    ...(Array.isArray(previousAssignment.secondaryTopics) ? previousAssignment.secondaryTopics : []),
    primaryTopic,
    ...secondaryTopics
  ].filter((path) => validPath(path)));
  const referenceFiles = await Promise.all([...affected].map(async (path) => ({
    path,
    current: await currentJsonFile(env, dataFile("topic-references", path))
  })));
  const referenceShas = {};
  for (const item of referenceFiles) {
    const role = desired.get(item.path);
    const reference = role ? {
      recordId,
      role,
      score,
      confidence: confidence.label || (score >= 0.75 ? "high" : score >= 0.4 ? "medium" : "low")
    } : null;
    const referenceResult = await saveJsonFile(
      env,
      item.current,
      topicReferenceDocument(item.current.document, item.path, recordId, reference, now, user),
      commitMessage("topic", (role ? "Index " : "Remove ") + recordId, user)
    );
    referenceShas[item.path] = referenceResult.content?.sha || "";
  }
  const runtimeMirrored = await mirrorD1IfReady(
    env,
    (db) => d1MirrorClassification(db, assignment)
  );
  return json(request, {
    ok: true,
    assignment,
    sha: result.content?.sha || "",
    commit: result.commit?.sha || "",
    referenceShas,
    updatedAt: now,
    updatedBy: user.displayName,
    runtimeMirrored
  });
}

function recordChannel(record) {
  return String(record?.channelId || record?.channel?.id || record?.channelName || record?.channel?.name || "");
}

async function getInbox(request, env, url) {
  const runtime = await tryD1Read(env, (db) => d1Inbox(db, url));
  if (runtime.used) return json(request, runtime.value);
  const index = await currentJsonFile(env, "source-index/discord.json");
  const classifications = await currentJsonFile(env, "classifications/discord.json");
  const assignments = assignmentMap(classifications.document);
  const status = String(url.searchParams.get("status") || "").trim().toLocaleLowerCase("en-US");
  const query = String(url.searchParams.get("query") || "").trim().toLocaleLowerCase("en-US").slice(0, 240);
  const channel = String(url.searchParams.get("channel") || "").trim().toLocaleLowerCase("en-US").slice(0, 240);
  const page = Math.max(1, Math.min(10_000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const pageSize = 50;
  const cache = new Map([["index", index]]);
  const records = [];
  const sourceIds = await allSourceIdsWithShards(env, index, cache);
  for (const id of sourceIds.slice(0, 20_000)) {
    const assignment = assignments[id];
    const assignmentStatus = String(assignment?.reviewStatus || (assignment ? "classified" : "unclassified")).toLocaleLowerCase("en-US");
    if (status && status !== "all" && assignmentStatus !== status) continue;
    const record = await resolvedSourceRecord(env, id, cache);
    if (!record) continue;
    if (channel && !recordChannel(record).toLocaleLowerCase("en-US").includes(channel)) continue;
    if (query && !JSON.stringify(record).toLocaleLowerCase("en-US").includes(query)) continue;
    records.push(record);
  }
  const start = (page - 1) * pageSize;
  const selected = records.slice(start, start + pageSize);
  return json(request, {
    records: selected,
    assignments: Object.fromEntries(selected.map((record) => sourceRecordId(record)).filter((id) => assignments[id]).map((id) => [id, assignments[id]])),
    page,
    pageSize,
    total: records.length,
    hasMore: start + selected.length < records.length,
    sha: classifications.sha || ""
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request) });
    const url = new URL(request.url);
    if (requiresTrustedV2Origin(url, request) && !originFor(request)) {
      return json(request, { error: "This request is accepted only from Why Communism." }, 403);
    }
    if (url.pathname === "/health" && request.method === "GET") return json(request, { ok: true, service: "whycommunism-github-archive" });
    try {
      if (url.pathname === "/v2/auth/discord" && request.method === "GET") return await beginDiscordAuth(request, env, url);
      if (url.pathname === "/v2/auth/discord/callback" && request.method === "GET") return await finishDiscordAuth(request, env, url);
      if (url.pathname === "/v2/session") return await sessionRoute(request, env);
    } catch (error) {
      return json(request, { error: error.message || "Authentication could not be completed." }, error.status === 403 ? 403 : error.status === 404 ? 404 : 500);
    }
    if (url.pathname === "/v1/link-preview" && request.method === "GET") {
      try {
        const auth = await requireUser(request, env, "read");
        if (auth.response) return auth.response;
        return await getLinkPreview(request, url.searchParams.get("url") || "");
      }
      catch (error) { return json(request, { error: error.name === "AbortError" ? "That website took too long to preview." : (error.message || "That website could not be previewed.") }, 422); }
    }
    if (!env.GITHUB_TOKEN && !d1ReadSelected(env)) {
      return json(request, { error: "The private archive runtime is not configured." }, 503);
    }
    if (url.pathname === "/v1/attachment" && request.method === "GET") {
      try {
        const auth = await requireUser(request, env, "read");
        if (auth.response) return auth.response;
        return await getAttachment(request, env, url.searchParams.get("file") || "");
      }
      catch (error) { return json(request, { error: error.message || "The attachment could not be loaded." }, error.status === 404 ? 404 : 500); }
    }
    try {
      if (url.pathname === "/v2/source" && (request.method === "GET" || request.method === "PUT")) {
        const auth = await requireUser(request, env, request.method === "PUT" ? "admin" : "read");
        if (auth.response) return auth.response;
        const id = String(url.searchParams.get("id") || "");
        return request.method === "GET" ? await getSource(request, env, id) : await putSource(request, env, id, auth.user);
      }
      if (url.pathname === "/v2/sources" && request.method === "POST") {
        const auth = await requireUser(request, env, "read");
        if (auth.response) return auth.response;
        return await getSources(request, env);
      }
      if (url.pathname === "/v2/classification" && (request.method === "GET" || request.method === "PUT")) {
        const auth = await requireUser(request, env, request.method === "PUT" ? "admin" : "read");
        if (auth.response) return auth.response;
        return request.method === "GET"
          ? await getClassification(request, env, String(url.searchParams.get("id") || ""))
          : await saveClassification(request, env, auth.user);
      }
      if (url.pathname === "/v2/inbox" && request.method === "GET") {
        const auth = await requireUser(request, env, "read");
        if (auth.response) return auth.response;
        return await getInbox(request, env, url);
      }
      if (url.pathname === "/v2/admin/denylist" && (request.method === "GET" || request.method === "PUT")) {
        const auth = await requireUser(request, env, "admin");
        if (auth.response) return auth.response;
        return request.method === "GET"
          ? await getDenylist(request, env)
          : await updateDenylist(request, env, auth.user);
      }
      if (url.pathname === "/v2/admin/denylist/history" && request.method === "GET") {
        const auth = await requireUser(request, env, "admin");
        if (auth.response) return auth.response;
        return await getDenylistHistory(request, env);
      }
      if (url.pathname === "/v2/topic/attachment" && request.method === "GET") {
        const auth = await requireUser(request, env, "read");
        if (auth.response) return auth.response;
        return await getAttachment(request, env, url.searchParams.get("file") || "");
      }
      const path = url.searchParams.get("path") || "";
      if (!validPath(path)) return json(request, { error: "Invalid article path." }, 400);
      if (url.pathname === "/v2/final" && request.method === "GET") return await getFinal(request, env, path);
      if (url.pathname === "/v2/final" && request.method === "PUT") {
        const auth = await requireUser(request, env, "edit");
        if (auth.response) return auth.response;
        return await saveFinal(request, env, path, auth.user, false);
      }
      if (url.pathname === "/v2/final/checkpoint" && request.method === "POST") {
        const auth = await requireUser(request, env, "edit");
        if (auth.response) return auth.response;
        return await saveFinal(request, env, path, auth.user, true);
      }
      if (url.pathname === "/v2/final/history" && request.method === "GET") {
        const auth = await requireUser(request, env, "read");
        if (auth.response) return auth.response;
        return await getFinalHistory(request, env, path);
      }
      if (url.pathname === "/v2/final/version" && request.method === "GET") {
        const auth = await requireUser(request, env, "read");
        if (auth.response) return auth.response;
        return await getFinalVersion(request, env, path, url.searchParams.get("sha"));
      }
      if (url.pathname === "/v2/final/restore" && request.method === "POST") {
        const auth = await requireUser(request, env, "admin");
        if (auth.response) return auth.response;
        return await restoreFinalVersion(request, env, path, auth.user);
      }
      if (url.pathname === "/v2/topic/message/history" && request.method === "GET") {
        const auth = await requireUser(request, env, "read");
        if (auth.response) return auth.response;
        return await getTopicMessageHistory(request, env, String(url.searchParams.get("id") || ""), auth.user);
      }
      if (url.pathname === "/v2/topic/message" && (request.method === "POST" || request.method === "PUT")) {
        const auth = await requireUser(request, env, "edit");
        if (auth.response) return auth.response;
        return request.method === "POST"
          ? await postTopicMessage(request, env, path, auth.user)
          : await updateTopicMessage(request, env, path, auth.user);
      }
      if (url.pathname === "/v2/topic" && (request.method === "GET" || request.method === "PUT")) {
        const auth = await requireUser(request, env, request.method === "PUT" ? "edit" : "read");
        if (auth.response) return auth.response;
        return request.method === "GET" ? await getTopic(request, env, path) : await saveTopicNotes(request, env, path, auth.user);
      }
      if (url.pathname === "/v1/archive" && request.method === "GET") {
        const auth = await requireUser(request, env, "read");
        return auth.response || await getArchive(request, env, path);
      }
      if (url.pathname === "/v1/archive" && request.method === "PUT") {
        const auth = await requireUser(request, env, "edit");
        return auth.response || await saveArchive(request, env, path, false);
      }
      if (url.pathname === "/v1/checkpoint" && request.method === "POST") {
        const auth = await requireUser(request, env, "edit");
        return auth.response || await saveArchive(request, env, path, true);
      }
      if (url.pathname === "/v1/history" && request.method === "GET") {
        const auth = await requireUser(request, env, "read");
        return auth.response || await getHistory(request, env, path);
      }
      if (url.pathname === "/v1/version" && request.method === "GET") {
        const auth = await requireUser(request, env, "read");
        return auth.response || await getVersion(request, env, path, url.searchParams.get("sha"));
      }
      if (url.pathname === "/v1/attachment" && request.method === "POST") {
        const auth = await requireUser(request, env, "edit");
        return auth.response || await uploadAttachment(request, env, path);
      }
      return json(request, { error: "Not found." }, 404);
    } catch (error) {
      const status = error.status === 404 ? 404 : error.status === 409 ? 409 : error.status === 403 ? 403 : 500;
      return json(request, { error: error.message || "The GitHub archive could not complete this request." }, status);
    }
  }
};
