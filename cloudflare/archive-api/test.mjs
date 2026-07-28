import worker from "./src/index.js";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const files = new Map();
const blobs = new Map();
const commitFiles = new Map();
const commits = [];
let sequence = 0;
let discordMemberPending = false;
let discordMemberAvailable = true;
let discordMembershipFetches = 0;
let privatePreviewTargetFetches = 0;
let previewRedirectMode = "";
const SESSION_COOKIE = "__Host-wce_session";
const OAUTH_STATE_COOKIE = "__Host-wce_oauth_state";

function apiResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

globalThis.fetch = async function (input, options = {}) {
  const url = new URL(input);
  const method = options.method || "GET";
  if (url.hostname === "discord.com" && url.pathname === "/api/v10/oauth2/token" && method === "POST") {
    return apiResponse({ access_token: "short-lived-discord-token", token_type: "Bearer" });
  }
  if (url.hostname === "discord.com" && url.pathname === "/api/v10/users/@me" && method === "GET") {
    return apiResponse({ id: "123456789012345678", username: "rosa", global_name: "Rosa Luxemburg", avatar: "avatarhash", discriminator: "0" });
  }
  if (url.hostname === "discord.com" && url.pathname === "/api/v10/users/@me/guilds/898568341499838514/member" && method === "GET") {
    discordMembershipFetches += 1;
    return discordMemberAvailable
      ? apiResponse({ nick: "Rosa L.", roles: ["ordinary-member-role"], pending: discordMemberPending })
      : apiResponse({ message: "Unknown Member" }, 404);
  }
  if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") {
    const host = url.searchParams.get("name");
    const type = url.searchParams.get("type");
    const address = host === "private.example"
      ? "10.0.0.7"
      : (type === "A" ? "93.184.216.34" : "");
    return apiResponse({
      Status: 0,
      Answer: address ? [{ name: host + ".", type: type === "A" ? 1 : 28, data: address }] : []
    });
  }
  if (url.hostname === "redirect.example") {
    previewRedirectMode = String(options.redirect || "");
    return new Response(null, {
      status: 302,
      headers: { Location: "http://169.254.169.254/latest/meta-data/" }
    });
  }
  if (url.hostname === "private.example") {
    privatePreviewTargetFetches += 1;
    return new Response("<html><title>Internal service</title></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" }
    });
  }
  if (url.hostname === "example.com") {
    return new Response('<html><head><meta property="og:site_name" content="Example"><meta property="og:title" content="A useful page"><meta property="og:description" content="A clear description."><meta property="og:image" content="/card.jpg"></head></html>', {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": "231" }
    });
  }
  const contentMatch = url.pathname.match(/\/contents\/(.+)$/);
  if (contentMatch && method === "GET") {
    const file = decodeURIComponent(contentMatch[1]);
    const ref = url.searchParams.get("ref");
    const entry = commitFiles.get(ref + ":" + file) || files.get(file);
    if (!entry) return apiResponse({ message: "Not Found" }, 404);
    return entry.omitContent
      ? apiResponse({ sha: entry.sha, encoding: "none" })
      : apiResponse({ sha: entry.sha, encoding: "base64", content: entry.content });
  }
  if (contentMatch && method === "PUT") {
    const file = decodeURIComponent(contentMatch[1]);
    const body = JSON.parse(options.body);
    const current = files.get(file);
    if ((current?.sha || "") !== (body.sha || "")) return apiResponse({ message: "Conflict" }, 409);
    const sha = (++sequence).toString(16).padStart(40, "0");
    const commit = (sequence + 1000).toString(16).padStart(40, "0");
    files.set(file, { sha, content: body.content });
    blobs.set(sha, body.content);
    commitFiles.set(commit + ":" + file, { sha, content: body.content });
    commits.unshift({
      file,
      sha: commit,
      commit: { message: body.message, author: { date: new Date().toISOString(), name: "Test" } },
      author: { login: "test-user" }
    });
    return apiResponse({ content: { sha }, commit: { sha: commit } });
  }
  const blobMatch = url.pathname.match(/\/git\/blobs\/([a-f0-9]{40})$/);
  if (blobMatch && method === "GET") return blobs.has(blobMatch[1]) ? apiResponse({ sha: blobMatch[1], encoding: "base64", content: blobs.get(blobMatch[1]) }) : apiResponse({ message: "Not Found" }, 404);
  if (url.pathname.endsWith("/commits") && method === "GET") {
    const file = url.searchParams.get("path");
    return apiResponse(file ? commits.filter((commit) => commit.file === file) : commits);
  }
  return apiResponse({ message: "Unexpected GitHub request" }, 500);
};

const env = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "united-marxist-pact",
  GITHUB_REPO: "whycommunism-archives",
  GITHUB_BRANCH: "main",
  DISCORD_CLIENT_ID: "discord-client",
  DISCORD_CLIENT_SECRET: "discord-secret",
  DISCORD_REDIRECT_URI: "https://archive.whycommunism.com/v2/auth/discord/callback",
  DISCORD_GUILD_ID: "898568341499838514",
  DISCORD_ADMIN_USER_IDS: "",
  SESSION_SECRET: "test-session-secret-that-is-long-enough"
};
const origin = "https://whycommunism.com";
const path = "/guides/how-society-changes/overview/";
const movedPath = "/guides/how-society-changes/materialism-and-idealism/";
const endpoint = "https://archive.whycommunism.com/v1/archive?path=" + encodeURIComponent(path);

function request(url, options = {}) {
  return new Request(url, {
    ...options,
    headers: { Origin: origin, "Content-Type": "application/json", ...(options.headers || {}) }
  });
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8").toString("base64");
}

function seedJson(file, value) {
  const sha = (++sequence).toString(16).padStart(40, "0");
  const content = encodedJson(value);
  files.set(file, { sha, content });
  blobs.set(sha, content);
  return sha;
}

function seedLargeJson(file, value) {
  const sha = seedJson(file, value);
  files.get(file).omitContent = true;
  return sha;
}

function pathKey(value) {
  return Buffer.from(value.normalize("NFC"), "utf8").toString("base64url");
}

function storedJson(file) {
  return JSON.parse(Buffer.from(files.get(file).content, "base64").toString("utf8"));
}

function responseCookie(response, name) {
  return (String(response.headers.get("Set-Cookie") || "").match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;,]+)")) || [])[1];
}

function cookieHeader(name, value) {
  return name + "=" + value;
}

function tamperSignature(token) {
  const [payload, signature] = String(token || "").split(".");
  const bytes = Buffer.from(signature, "base64url");
  bytes[0] ^= 1;
  return payload + "." + bytes.toString("base64url");
}

async function discordLogin(returnTo = "https://whycommunism.com/editor/") {
  let response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/auth/discord?returnTo=" + encodeURIComponent(returnTo)
  ), env);
  const state = new URL(response.headers.get("Location")).searchParams.get("state");
  const stateCookieHeader = String(response.headers.get("Set-Cookie") || "");
  const stateCookie = responseCookie(response, OAUTH_STATE_COOKIE);
  assert(
    stateCookieHeader.includes(OAUTH_STATE_COOKIE + "=") &&
    /(?:^|;\s*)Path=\//.test(stateCookieHeader) &&
    !/(?:^|;\s*)Domain=/i.test(stateCookieHeader),
    "The OAuth state cookie was not host-only with a root path."
  );
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/auth/discord/callback?code=oauth-code&state=" + encodeURIComponent(state),
    { headers: { Cookie: cookieHeader(OAUTH_STATE_COOKIE, stateCookie) } }
  ), env);
  assert(response.status === 302, "Discord test login did not complete.");
  const sessionCookieHeader = String(response.headers.get("Set-Cookie") || "");
  assert(
    sessionCookieHeader.includes(SESSION_COOKIE + "=") &&
    /(?:^|;\s*)Path=\//.test(sessionCookieHeader) &&
    !/(?:^|;\s*)Domain=/i.test(sessionCookieHeader),
    "The session cookie was not host-only with a root path."
  );
  return responseCookie(response, SESSION_COOKIE);
}

try {
  const legacySessionCookie = await discordLogin();
  const legacyAuthHeaders = { Cookie: cookieHeader(SESSION_COOKIE, legacySessionCookie) };

  let response = await worker.fetch(request("https://archive.whycommunism.com/v1/link-preview?url=" + encodeURIComponent("https://example.com/article")), env);
  let payload = await response.json();
  assert(response.status === 401, "Link previewing was exposed without archive authentication.");
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v1/link-preview?url=" + encodeURIComponent("https://example.com/article"),
    { headers: legacyAuthHeaders }
  ), env);
  payload = await response.json();
  assert(
    response.status === 200 &&
    response.headers.get("Cache-Control") === "private, no-store" &&
    payload.title === "A useful page" &&
    payload.image === "https://example.com/card.jpg",
    "Authenticated website preview metadata was not created privately."
  );
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v1/link-preview?url=" + encodeURIComponent("http://127.0.0.1/admin"),
    { headers: legacyAuthHeaders }
  ), env);
  assert(response.status === 422, "A literal loopback preview target was accepted.");
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v1/link-preview?url=" + encodeURIComponent("http://[::ffff:127.0.0.1]/admin"),
    { headers: legacyAuthHeaders }
  ), env);
  assert(response.status === 422, "An IPv4-mapped IPv6 loopback preview target was accepted.");
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v1/link-preview?url=" + encodeURIComponent("https://private.example/admin"),
    { headers: legacyAuthHeaders }
  ), env);
  assert(response.status === 422 && privatePreviewTargetFetches === 0, "A hostname resolving to a private address reached the preview fetch.");
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v1/link-preview?url=" + encodeURIComponent("https://redirect.example/article"),
    { headers: legacyAuthHeaders }
  ), env);
  assert(
    response.status === 422 && previewRedirectMode === "manual",
    "A public preview redirect was not manually revalidated before following it."
  );

  response = await worker.fetch(request(endpoint), env);
  assert(response.status === 401, "The legacy archive was exposed without authentication.");
  response = await worker.fetch(request(endpoint, { headers: legacyAuthHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.sha === "" && payload.messages.length === 0, "Empty archive did not load.");

  response = await worker.fetch(request(endpoint, {
    method: "PUT",
    body: JSON.stringify({ title: "Unauthorized", baseSha: "", messages: [{ content: "No" }] })
  }), env);
  assert(response.status === 401, "A legacy archive mutation was accepted without authentication.");

  response = await worker.fetch(request(endpoint, {
    method: "PUT",
    headers: legacyAuthHeaders,
    body: JSON.stringify({
      title: "Materialism",
      baseSha: "",
      note: "First message",
      messages: [
        { id: "one", author: "User", timestamp: "2026-07-22T08:00:00+08:00", content: "**Hello**" },
        { id: "two", author: "Reader", timestamp: "2026-07-22T00:01:00Z", content: "A reply", replyTo: "one", replyAuthor: "User", replyExcerpt: "Hello" }
      ]
    })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && /^[a-f0-9]{40}$/.test(payload.sha), "Archive was not created.");
  const firstSha = payload.sha;

  response = await worker.fetch(request(endpoint, { headers: legacyAuthHeaders }), env);
  payload = await response.json();
  assert(payload.messages[1].replyTo === "one" && payload.messages[1].replyAuthor === "User", "Reply relationships were not preserved.");
  assert(payload.messages[0].timestamp === "2026-07-22T00:00:00.000Z", "Timezone offsets were not normalized to UTC.");

  response = await worker.fetch(request(endpoint, {
    method: "PUT",
    headers: legacyAuthHeaders,
    body: JSON.stringify({ title: "Materialism", baseSha: "", messages: [{ content: "Conflict" }] })
  }), env);
  payload = await response.json();
  assert(response.status === 409 && payload.conflict && payload.sha === firstSha, "Concurrent edit was not rejected.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v1/checkpoint?path=" + encodeURIComponent(path), {
    method: "POST",
    headers: legacyAuthHeaders,
    body: JSON.stringify({ title: "Materialism", baseSha: firstSha, note: "Manual checkpoint" })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.sha !== firstSha, "Checkpoint did not create a version.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v1/history?path=" + encodeURIComponent(path)), env);
  assert(response.status === 401, "Legacy archive history was exposed without authentication.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v1/history?path=" + encodeURIComponent(path), { headers: legacyAuthHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.versions.length === 2, "History did not return both versions.");
  const legacyVersionSha = payload.versions[0].sha;
  response = await worker.fetch(request("https://archive.whycommunism.com/v1/version?path=" + encodeURIComponent(path) + "&sha=" + legacyVersionSha), env);
  assert(response.status === 401, "A legacy archive version was exposed without authentication.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v1/version?path=" + encodeURIComponent(path) + "&sha=" + legacyVersionSha, { headers: legacyAuthHeaders }), env);
  assert(response.status === 200, "A verified member could not read a legacy archive version.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v1/attachment?path=" + encodeURIComponent(path), {
    method: "POST",
    headers: legacyAuthHeaders,
    body: JSON.stringify({ filename: "diagram.png", contentType: "image/png", base64: btoa("test-image") })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.filename === "diagram.png" && payload.url.includes("%2F"), "Attachment was not uploaded.");

  const legacyAttachmentUrl = payload.url;
  response = await worker.fetch(request(legacyAttachmentUrl), env);
  assert(response.status === 401, "A legacy attachment was exposed without authentication.");
  response = await worker.fetch(request(legacyAttachmentUrl, { headers: legacyAuthHeaders }), env);
  assert(response.status === 200 && response.headers.get("Content-Type") === "image/png" && await response.text() === "test-image", "Attachment could not be downloaded.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final?path=" + encodeURIComponent(path)), env);
  payload = await response.json();
  assert(response.status === 200 && payload.bodyMarkdown === "" && payload.sha === "", "A public empty final argument did not load.");
  assert(response.headers.get("Access-Control-Allow-Credentials") === "true", "Credentialed CORS was not enabled.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final?path=" + encodeURIComponent(path), {
    method: "PUT",
    body: JSON.stringify({ title: "Private write", bodyMarkdown: "No", citations: [], baseSha: "" })
  }), env);
  assert(response.status === 401, "An unauthenticated final argument write was accepted.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/auth/discord?returnTo=" + encodeURIComponent("https://whycommunism.com/editor/")), env);
  assert(response.status === 302 && response.headers.get("Location").startsWith("https://discord.com/oauth2/authorize"), "Discord authorization did not redirect.");
  const oauthCookies = response.headers.get("Set-Cookie") || "";
  const state = new URL(response.headers.get("Location")).searchParams.get("state");
  const stateCookie = responseCookie(response, OAUTH_STATE_COOKIE);
  assert(state && stateCookie === state, "Discord OAuth state was not stored in the signed state cookie.");
  assert(!/(?:^|;\s*)Domain=/i.test(oauthCookies) && /(?:^|;\s*)Path=\//.test(oauthCookies), "The OAuth state cookie was scoped above its host.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/auth/discord/callback?code=oauth-code&state=" + encodeURIComponent(state + "tampered"), {
    headers: { Cookie: cookieHeader(OAUTH_STATE_COOKIE, stateCookie) }
  }), env);
  assert(response.status === 400, "A mismatched Discord OAuth state was accepted.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/auth/discord/callback?code=oauth-code&state=" + encodeURIComponent(state), {
    headers: { Cookie: cookieHeader(OAUTH_STATE_COOKIE, stateCookie) }
  }), env);
  assert(response.status === 302 && response.headers.get("Location") === "https://whycommunism.com/editor/", "Discord OAuth callback did not return to Why Communism.");
  const sessionCookie = responseCookie(response, SESSION_COOKIE);
  assert(sessionCookie, "Discord OAuth callback did not create a session cookie.");
  assert(!/(?:^|;\s*)Domain=/i.test(response.headers.get("Set-Cookie") || ""), "The session cookie was scoped above its host.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/session", {
    headers: { Cookie: cookieHeader(SESSION_COOKIE, sessionCookie) }
  }), env);
  payload = await response.json();
  assert(payload.authenticated && payload.user.discordId === "123456789012345678" && payload.user.canEdit, "A verified guild member did not receive archive edit access.");
  const signedClaims = JSON.parse(Buffer.from(sessionCookie.split(".")[0], "base64url").toString("utf8"));
  assert(
    Number.isFinite(signedClaims.membershipVerifiedAt) &&
    signedClaims.membershipToken &&
    !signedClaims.membershipToken.includes("short-lived-discord-token"),
    "The short membership assertion did not preserve an encrypted live-verification credential."
  );

  discordMemberPending = true;
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/auth/discord?returnTo=" + encodeURIComponent("https://whycommunism.com/editor/")
  ), env);
  const pendingState = new URL(response.headers.get("Location")).searchParams.get("state");
  const pendingStateCookie = responseCookie(response, OAUTH_STATE_COOKIE);
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/auth/discord/callback?code=oauth-code&state=" + encodeURIComponent(pendingState),
    { headers: { Cookie: cookieHeader(OAUTH_STATE_COOKIE, pendingStateCookie) } }
  ), env);
  assert(response.status === 403 && !responseCookie(response, SESSION_COOKIE), "A pending Discord guild member received a private session.");
  discordMemberPending = false;

  const membershipFetchesBeforeStaleCheck = discordMembershipFetches;
  const membershipClock = originalDateNow();
  Date.now = () => membershipClock + 6 * 60 * 1000;
  discordMemberAvailable = false;
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/session", {
    headers: { Cookie: cookieHeader(SESSION_COOKIE, sessionCookie) }
  }), env);
  payload = await response.json();
  assert(
    !payload.authenticated && discordMembershipFetches > membershipFetchesBeforeStaleCheck,
    "A stale membership assertion was not rechecked against Discord after the member left."
  );
  discordMemberAvailable = true;
  Date.now = () => membershipClock + 12 * 60 * 1000;
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/session", {
    headers: { Cookie: cookieHeader(SESSION_COOKIE, sessionCookie) }
  }), env);
  payload = await response.json();
  assert(payload.authenticated, "A current Discord member could not recover through live membership verification.");
  Date.now = originalDateNow;

  const tamperedSession = tamperSignature(sessionCookie);
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/session", {
    headers: { Cookie: cookieHeader(SESSION_COOKIE, tamperedSession) }
  }), env);
  payload = await response.json();
  assert(response.status === 200 && !payload.authenticated, "A session with an invalid signature was accepted.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/session", {
    headers: { Cookie: "wce_session=" + sessionCookie }
  }), env);
  payload = await response.json();
  assert(!payload.authenticated, "The retired domain-scoped cookie name was still accepted.");

  const noDenylistEnv = { ...env, GITHUB_TOKEN: "" };
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/session", {
    headers: { Cookie: cookieHeader(SESSION_COOKIE, sessionCookie) }
  }), noDenylistEnv);
  payload = await response.json();
  assert(!payload.authenticated, "Discord authorization failed open when the canonical denylist was unavailable.");

  const authHeaders = { Cookie: cookieHeader(SESSION_COOKIE, sessionCookie) };
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/session", {
    method: "DELETE",
    headers: authHeaders
  }), env);
  const logoutCookie = String(response.headers.get("Set-Cookie") || "");
  assert(
    response.status === 200 &&
    logoutCookie.includes(SESSION_COOKIE + "=") &&
    logoutCookie.includes("Max-Age=0") &&
    /(?:^|;\s*)Path=\//.test(logoutCookie) &&
    !/(?:^|;\s*)Domain=/i.test(logoutCookie),
    "Logout did not expire the host-only session cookie."
  );
  response = await worker.fetch(new Request("https://archive.whycommunism.com/v2/final?path=" + encodeURIComponent(path), {
    method: "PUT",
    headers: { Cookie: cookieHeader(SESSION_COOKIE, sessionCookie), "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Cross-site write", bodyMarkdown: "No", citations: [], baseSha: "" })
  }), env);
  assert(response.status === 403, "A v2 mutation without a trusted Why Communism origin was accepted.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final?path=" + encodeURIComponent(path), {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      title: "The final argument",
      bodyMarkdown: "Workers can govern production for use.",
      citations: [{
        id: "citation-1",
        type: "discord",
        sourceId: "discord-1",
        title: "Discussion",
        excerpt: "Private source excerpt"
      }],
      note: "Publish first argument",
      baseSha: ""
    })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.updatedBy === "Rosa L." && payload.sha, "An authenticated final argument was not saved with its actor.");
  const finalSha = payload.sha;
  const finalFile = "final-arguments/" + pathKey(path) + ".json";
  const savedFinal = storedJson(finalFile);
  assert(savedFinal.updatedByDiscordId === "123456789012345678" && commits[0].commit.message.includes("(by Rosa L.)"), "The Discord audit actor was not stamped in data and Git history.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final?path=" + encodeURIComponent(path)), env);
  payload = await response.json();
  assert(response.status === 200 && payload.bodyMarkdown.includes("production for use") && payload.updatedBy === "Rosa L.", "The published final argument was not publicly readable.");
  assert(
    payload.citations[0].private && !payload.citations[0].sourceId && !JSON.stringify(payload).includes("Private source excerpt"),
    "A public final argument leaked its private Discord citation."
  );
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final?path=" + encodeURIComponent(path), { headers: authHeaders }), env);
  payload = await response.json();
  assert(payload.citations[0].sourceId === "discord-1" && payload.citations[0].excerpt === "Private source excerpt", "A verified member could not see the full Discord citation.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final/checkpoint?path=" + encodeURIComponent(path), {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ note: "Reviewed wording", baseSha: finalSha })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.sha !== finalSha, "An authenticated final checkpoint was not saved.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final/history?path=" + encodeURIComponent(path)), env);
  assert(response.status === 401, "Final history was exposed without authentication.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final/history?path=" + encodeURIComponent(path), { headers: authHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.versions.length === 2 && payload.versions[0].updatedBy === "Rosa L.", "Final history did not preserve its named audit actor.");
  const firstFinalCommit = payload.versions[1].sha;
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final/version?path=" + encodeURIComponent(path) + "&sha=" + firstFinalCommit, { headers: authHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.commit === firstFinalCommit && payload.bodyMarkdown.includes("production for use"), "A named final argument version could not be retrieved.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final/restore?path=" + encodeURIComponent(path), {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ commit: firstFinalCommit, baseSha: payload.sha })
  }), env);
  assert(response.status === 403, "A non-admin member was allowed to restore a final argument revision.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/admin/denylist", { headers: authHeaders }), env);
  assert(response.status === 403, "A non-admin member was allowed to inspect the access list.");

  const source = { id: "discord-1", channelId: "theory", author: { name: "Member" }, content: "A source discussion" };
  seedJson("source-index/discord.json", {
    format: "whycommunism-discord-source-index-v1",
    records: {
      "discord-1": { shard: "discord-shards/0001.json" },
      "large-1": { shard: "discord-shards/large.json" }
    }
  });
  seedJson("source-records/discord-shards/0001.json", {
    format: "whycommunism-discord-source-shard-v1",
    records: [source]
  });
  seedLargeJson("source-records/discord-shards/large.json", {
    format: "whycommunism-discord-source-shard-v1",
    records: [{ id: "large-1", channelId: "large-channel", content: "Recovered from GitHub's blob API" }]
  });
  const classificationSha = seedJson("classifications/discord.json", {
    format: "whycommunism-discord-classifications-v1",
    assignments: {
      "discord-1": {
        recordId: "discord-1",
        primaryTopic: path,
        secondaryTopics: [],
        confidence: { score: 0.4, label: "medium" },
        reviewStatus: "unreviewed"
      }
    }
  });
  seedJson("topic-references/" + pathKey(path) + ".json", {
    format: "whycommunism-topic-references-v1",
    path,
    title: "Materialism",
    recordIds: ["discord-1"],
    filters: { channel: "theory" }
  });

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/source?id=discord-1"), env);
  assert(response.status === 401, "A raw source record was exposed without authentication.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/source?id=discord-1", { headers: authHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.content === source.content, "A canonical source record could not be read.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/source?id=large-1", { headers: authHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.content.includes("blob API"), "A source shard over the GitHub Contents API limit was not recovered through its blob SHA.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/source?id=discord-1", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify(source)
  }), env);
  assert(response.status === 403, "A non-admin member was allowed to use the arbitrary immutable-source import endpoint.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/classification", {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      recordId: "discord-1",
      primaryTopic: movedPath,
      secondaryTopics: [],
      confidence: { score: 0.95, label: "high" },
      relevance: "high",
      reviewStatus: "reviewed",
      note: "Ordinary members should be able to write without classifying the archive.",
      baseSha: classificationSha
    })
  }), env);
  assert(response.status === 403, "A non-admin member was allowed to change source classifications.");

  env.DISCORD_ADMIN_USER_IDS = "123456789012345678";
  const adminSessionCookie = await discordLogin();
  const adminAuthHeaders = { Cookie: cookieHeader(SESSION_COOKIE, adminSessionCookie) };
  env.DISCORD_ADMIN_USER_IDS = "";
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/admin/denylist", { headers: adminAuthHeaders }), env);
  assert(response.status === 403, "A signed session retained administrator power after removal from DISCORD_ADMIN_USER_IDS.");
  env.DISCORD_ADMIN_USER_IDS = "123456789012345678";

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/admin/denylist", { headers: adminAuthHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.records.length === 0 && payload.sha === "", "An administrator could not open the empty access list.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/admin/denylist", {
    method: "PUT",
    headers: adminAuthHeaders,
    body: JSON.stringify({ discordId: "987654321098765432", denied: true, note: "Access review", baseSha: payload.sha })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.records[0].discordId === "987654321098765432" && payload.records[0].updatedBy === "Rosa L.", "An administrator could not block a Discord ID with an attributed Git revision.");
  const blockedSha = payload.sha;
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/admin/denylist", {
    method: "PUT",
    headers: adminAuthHeaders,
    body: JSON.stringify({ discordId: "987654321098765432", denied: false, baseSha: blockedSha })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.records.length === 0, "An administrator could not restore a Discord account's access.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/admin/denylist/history", { headers: adminAuthHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.versions.length === 2 && payload.versions.every((item) => item.updatedBy === "Rosa L."), "Access-list Git history did not preserve its administrator actor.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final?path=" + encodeURIComponent(path), { headers: adminAuthHeaders }), env);
  payload = await response.json();
  const preRestoreFinalSha = payload.sha;
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final/restore?path=" + encodeURIComponent(path), {
    method: "POST",
    headers: adminAuthHeaders,
    body: JSON.stringify({ commit: firstFinalCommit, baseSha: preRestoreFinalSha, note: "Restore reviewed revision" })
  }), env);
  payload = await response.json();
  assert(
    response.status === 200 &&
    payload.restoredFromCommit === firstFinalCommit &&
    payload.sha !== preRestoreFinalSha &&
    payload.updatedBy === "Rosa L.",
    "An administrator could not restore a previewed final argument revision as a new attributed version."
  );
  assert(storedJson(finalFile).restoredFromCommit === firstFinalCommit, "The restored final argument did not retain its source revision.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/source?id=discord-1", {
    method: "PUT",
    headers: adminAuthHeaders,
    body: JSON.stringify(source)
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.idempotent, "An identical immutable source retry was not idempotent.");
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/source?id=discord-1", {
    method: "PUT",
    headers: adminAuthHeaders,
    body: JSON.stringify({ ...source, content: "Changed source" })
  }), env);
  payload = await response.json();
  assert(response.status === 409 && payload.immutable, "An immutable source record was overwritten.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/topic?path=" + encodeURIComponent(path), { headers: authHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.records[0].id === "discord-1" && payload.filters.channel === "theory", "The topic archive did not resolve canonical source records.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/classification", {
    method: "PUT",
    headers: adminAuthHeaders,
    body: JSON.stringify({
      recordId: "discord-1",
      primaryTopic: movedPath,
      secondaryTopics: [],
      confidence: { score: 0.95, label: "high" },
      relevance: "high",
      reviewStatus: "reviewed",
      note: "Fits the materialism discussion.",
      baseSha: classificationSha
    })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.assignment.updatedBy === "Rosa L.", "Classification mutation was not stamped with the verified actor.");
  const savedClassifications = storedJson("classifications/discord.json");
  assert(
    savedClassifications.records["discord-1"].updatedByDiscordId === "123456789012345678" &&
    savedClassifications.records["discord-1"].relevance === "high" &&
    !savedClassifications.assignments && !savedClassifications.classifications,
    "Classification data was not standardized or did not retain its Discord actor and relevance."
  );
  assert(
    !storedJson("topic-references/" + pathKey(path) + ".json").references.some((entry) => entry.recordId === "discord-1"),
    "Moving a classification left a stale reference in the old topic."
  );
  assert(
    storedJson("topic-references/" + pathKey(movedPath) + ".json").references.some((entry) => entry.recordId === "discord-1" && entry.role === "primary"),
    "Moving a classification did not add a reference to the new topic."
  );

  const movedClassificationSha = payload.sha;
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/classification", {
    method: "PUT",
    headers: adminAuthHeaders,
    body: JSON.stringify({
      recordId: "discord-1",
      primaryTopic: movedPath,
      secondaryTopics: [],
      confidence: { score: 95, label: "invalid-percent" },
      reviewStatus: "reviewed",
      baseSha: movedClassificationSha
    })
  }), env);
  assert(response.status !== 200, "A percentage confidence score outside the canonical 0–1 range was accepted.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/sources", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ ids: ["discord-1", "missing"] })
  }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.records.length === 1 && payload.missingIds[0] === "missing", "Batch source retrieval did not report records and misses.");
  response = await worker.fetch(new Request("https://archive.whycommunism.com/v2/sources", {
    method: "POST",
    headers: { Cookie: cookieHeader(SESSION_COOKIE, sessionCookie), "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["discord-1"] })
  }), env);
  assert(response.status === 403, "A private POST source read without a trusted Why Communism origin was accepted.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/inbox?status=reviewed&channel=theory&page=1", { headers: authHeaders }), env);
  payload = await response.json();
  assert(response.status === 200 && payload.records.length === 1 && payload.total === 1, "The authenticated source inbox filters did not work.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/topic/message?path=" + encodeURIComponent(path), {
    method: "POST",
    body: JSON.stringify({ content: "An unauthenticated contribution" })
  }), env);
  assert(response.status === 401, "An unauthenticated member contribution was accepted.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/topic/message?path=" + encodeURIComponent(path), {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      id: "forged-source-id",
      author: { id: "forged-user", displayName: "Forged Name" },
      createdAt: "1999-01-01T00:00:00Z",
      content: "A **member contribution** grounded in the source discussion.",
      replyTo: "discord-1",
      attachments: [{
        filename: "meeting-note.png",
        contentType: "image/png",
        base64: btoa("private-member-image")
      }]
    })
  }), env);
  payload = await response.json();
  assert(response.status === 201 && payload.record && payload.assignment, "A verified guild member could not post to the topic archive.");
  const manualRecord = payload.record;
  assert(manualRecord.id !== "forged-source-id" && manualRecord.id.startsWith("manual:898568341499838514:"), "The client was allowed to choose the immutable source id.");
  assert(manualRecord.author.id === "123456789012345678" && manualRecord.author.displayName === "Rosa L." && manualRecord.author.username === "rosa", "The contribution was not stamped from the verified Discord session.");
  assert(manualRecord.author.avatar.sourceUrl.includes("cdn.discordapp.com") && manualRecord.createdAt !== "1999-01-01T00:00:00Z", "The client was allowed to spoof avatar or timestamp.");
  assert(manualRecord.replyTo.recordId === "discord-1" && manualRecord.content.markdown.includes("member contribution"), "The canonical message did not preserve its Markdown content or reply.");
  assert(
    manualRecord.attachments.length === 1 &&
    manualRecord.attachments[0].filename === "meeting-note.png" &&
    manualRecord.attachments[0].private === true &&
    manualRecord.attachments[0].uploadedByDiscordId === "123456789012345678" &&
    manualRecord.attachments[0].archivePath.startsWith("attachments/") &&
    !manualRecord.attachments[0].url &&
    !manualRecord.attachments[0].sourceUrl,
    "The member attachment was not privately associated with the immutable source message."
  );
  assert(/^[a-f0-9]{64}$/.test(manualRecord.immutableHash), "The member contribution did not receive an immutable content hash.");
  assert(
    manualRecord.losses.reactionUsersUnavailable === false &&
    manualRecord.losses.pollDetailsUnavailable === false &&
    manualRecord.losses.priorEditVersionsUnavailable === false &&
    manualRecord.losses.mediaDownloadsIncomplete === false,
    "The member contribution did not use the canonical archive loss flags."
  );

  const manualIndex = storedJson("source-index/discord.json");
  const manualIndexEntry = manualIndex.manualRecords[manualRecord.id];
  assert(manualIndexEntry && manualIndexEntry.manual && manualIndexEntry.immutableHash === manualRecord.immutableHash, "The manual source record was not added to the canonical index.");
  const manualShardFile = "source-records/discord-shards/" + manualIndexEntry.shard + ".json";
  const manualShard = storedJson(manualShardFile);
  assert(manualShard.records.length === 1 && manualShard.records[0].id === manualRecord.id, "The member contribution was not written to its immutable manual shard.");

  const manualClassifications = storedJson("classifications/discord.json");
  const manualAssignment = manualClassifications.records[manualRecord.id];
  assert(manualAssignment.primaryTopic === path && manualAssignment.confidence.label === "manual" && manualAssignment.reviewStatus === "unreviewed", "The member contribution was not classified into its current topic.");
  assert(manualAssignment.updatedByDiscordId === "123456789012345678", "The classification did not preserve its verified Discord audit actor.");
  assert(!manualClassifications.assignments && !manualClassifications.classifications, "Posting a member message recreated a duplicate classification container.");
  const manualReferences = storedJson("topic-references/" + pathKey(path) + ".json");
  assert(manualReferences.references.some((entry) => entry.recordId === manualRecord.id), "The topic reference list did not include the new contribution.");

  const manualAttachmentUrl = "https://archive.whycommunism.com/v2/topic/attachment?file=" + encodeURIComponent(manualRecord.attachments[0].archivePath);
  response = await worker.fetch(request(manualAttachmentUrl), env);
  assert(response.status === 401, "A private member attachment was exposed without authentication.");
  response = await worker.fetch(request(manualAttachmentUrl, { headers: authHeaders }), env);
  assert(
    response.status === 200 &&
    response.headers.get("Content-Type") === "image/png" &&
    response.headers.get("Cache-Control") === "private, no-store" &&
    await response.text() === "private-member-image",
    "A verified member could not load the private source attachment."
  );

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/topic?path=" + encodeURIComponent(path), { headers: authHeaders }), env);
  payload = await response.json();
  assert(payload.records.some((record) => record.id === manualRecord.id) && payload.assignments[manualRecord.id].confidence.label === "manual", "The new contribution was not immediately available from the topic archive.");

  response = await worker.fetch(request("https://archive.whycommunism.com/v2/final?path=" + encodeURIComponent("/start-here/")), env);
  assert(response.status === 200, "An existing start-here route was rejected by path validation.");

  seedJson("auth/denylist.json", { discordIds: ["123456789012345678"] });
  response = await worker.fetch(request("https://archive.whycommunism.com/v2/source?id=discord-1", { headers: authHeaders }), env);
  assert(response.status === 401, "A denylisted Discord user retained archive access.");

  console.log("archive-api tests passed");
} finally {
  Date.now = originalDateNow;
  globalThis.fetch = originalFetch;
}
