import fs from "node:fs";
import { createHmac, webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "./src/index.js";

globalThis.crypto ??= webcrypto;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class BoundD1Statement {
  constructor(database, sql, parameters) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  first() {
    return this.database.prepare(this.sql).get(...this.parameters) || null;
  }

  all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.parameters) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.parameters);
    return { success: true, meta: { changes: Number(result.changes || 0) } };
  }
}

class D1Mock {
  constructor(migration) {
    this.database = new DatabaseSync(":memory:");
    this.database.exec(migration);
  }

  prepare(sql) {
    return {
      bind: (...parameters) => new BoundD1Statement(this.database, sql, parameters),
      first: () => new BoundD1Statement(this.database, sql, []).first(),
      all: () => new BoundD1Statement(this.database, sql, []).all(),
      run: () => new BoundD1Statement(this.database, sql, []).run()
    };
  }

  batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function discordSession(secret, overrides = {}) {
  const claims = {
    v: 2,
    provider: "discord",
    discordId: "123456789012345678",
    username: "rosa",
    displayName: "Rosa L.",
    avatar: "https://cdn.discordapp.com/embed/avatars/1.png",
    roles: [],
    canReadArchive: true,
    canEdit: true,
    memberPending: false,
    membershipVerifiedAt: Math.floor(Date.now() / 1000),
    admin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  };
  const payload = base64Url(JSON.stringify({ ...claims, ...overrides }));
  const signature = createHmac("sha256", secret).update("session." + payload).digest("base64url");
  return payload + "." + signature;
}

const migration = fs.readFileSync(new URL("./migrations/0001_archive.sql", import.meta.url), "utf8");
const d1 = new D1Mock(migration);
const database = d1.database;
const path = "/guides/how-society-changes/materialism-and-idealism/";
const movedPath = "/guides/how-society-changes/history/";
const source = {
  format: "whycommunism-discord-source-v1",
  id: "discord:898568341499838514:10:100",
  messageId: "100",
  guild: { id: "898568341499838514", name: "United Marxist Pact" },
  channel: { id: "10", name: "theory", parent: "Library" },
  author: { id: "20", username: "member", displayName: "Member" },
  createdAt: "2026-07-01T00:00:00.000Z",
  content: { text: "Material life gives rise to ideas." },
  immutableHash: "a".repeat(64),
  source: { kind: "discord-export" }
};
const assignment = {
  recordId: source.id,
  primaryTopic: path,
  secondaryTopics: [],
  confidence: { score: 0.8, label: "high" },
  relevance: "high",
  reviewStatus: "reviewed",
  note: "",
  updatedAt: "2026-07-02T00:00:00.000Z",
  updatedBy: "Archive import"
};

database.prepare(
  "INSERT INTO archive_records (" +
  "record_id, immutable_hash, record_json, message_id, source_kind, guild_id, channel_id, channel_name, " +
  "channel_parent, author_id, author_name, content_text, created_at, edited_at, is_manual, imported_at" +
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
).run(
  source.id, source.immutableHash, JSON.stringify(source), source.messageId, "discord-export",
  source.guild.id, source.channel.id, source.channel.name, source.channel.parent,
  source.author.id, source.author.displayName, source.content.text, source.createdAt, null, 0,
  "2026-07-03T00:00:00.000Z"
);
database.prepare(
  "INSERT INTO classifications (" +
  "record_id, primary_topic, secondary_topics_json, confidence_score, confidence_label, relevance, " +
  "review_status, note, assignment_json, updated_at, updated_by, updated_by_discord_id" +
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
).run(
  source.id, path, "[]", 0.8, "high", "high", "reviewed", "", JSON.stringify(assignment),
  assignment.updatedAt, assignment.updatedBy, ""
);
database.prepare(
  "INSERT INTO topic_references " +
  "(topic_path, record_id, role, score, confidence_label, record_created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?)"
).run(path, source.id, "primary", 0.8, "high", source.createdAt, assignment.updatedAt);
database.prepare(
  "INSERT INTO topic_metadata (topic_path, title, filters_json, notes, updated_at) VALUES (?, ?, ?, ?, ?)"
).run(path, "Materialism and Idealism", JSON.stringify({ channel: "theory" }), "Read closely.", assignment.updatedAt);
database.prepare(
  "INSERT OR REPLACE INTO archive_meta (key, value, updated_at) VALUES ('runtime_ready', '1', ?)"
).run(new Date().toISOString());

const githubFiles = new Map();
const writtenPaths = [];
let shaCounter = 1;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== "api.github.com") return new Response("not found", { status: 404 });
  const marker = "/contents/";
  const index = url.pathname.indexOf(marker);
  if (index < 0) return Response.json({ message: "Not Found" }, { status: 404 });
  const file = url.pathname.slice(index + marker.length).split("/").map(decodeURIComponent).join("/");
  if (request.method === "GET") {
    if (!githubFiles.has(file)) return Response.json({ message: "Not Found" }, { status: 404 });
    const stored = githubFiles.get(file);
    return Response.json({ sha: stored.sha, encoding: "base64", content: Buffer.from(stored.text).toString("base64") });
  }
  if (request.method === "PUT") {
    const body = await request.json();
    const text = Buffer.from(body.content, "base64").toString("utf8");
    const sha = String(shaCounter++).padStart(40, "0");
    githubFiles.set(file, { sha, text });
    writtenPaths.push(file);
    return Response.json({ content: { sha }, commit: { sha: String(shaCounter++).padStart(40, "0") } });
  }
  return Response.json({ message: "Method Not Allowed" }, { status: 405 });
};

const env = {
  ARCHIVE_DB: d1,
  READ_BACKEND: "d1",
  GITHUB_TOKEN: "test",
  GITHUB_OWNER: "united-marxist-pact",
  GITHUB_REPO: "whycommunism-archives",
  GITHUB_BRANCH: "main",
  SESSION_SECRET: "d1-test-session-secret",
  DISCORD_GUILD_ID: "898568341499838514",
  DISCORD_ADMIN_USER_IDS: ""
};
const cookie = "__Host-wce_session=" + discordSession(env.SESSION_SECRET);
function request(url, options = {}) {
  return new Request(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://whycommunism.com",
      "Cookie": cookie,
      ...(options.headers || {})
    }
  });
}

try {
  let response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic?path=" + encodeURIComponent(path)
  ), env);
  let payload = await response.json();
  assert(response.status === 200 && payload.backend === "d1", "Topic read did not use D1.");
  assert(payload.records.length === 1 && payload.records[0].id === source.id, "D1 topic record was not returned.");
  assert(payload.assignments[source.id].reviewStatus === "reviewed", "D1 topic classification was not joined.");
  assert(payload.title === "Materialism and Idealism" && payload.notes === "Read closely.", "D1 topic metadata was not returned.");

  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/source?id=" + encodeURIComponent(source.id)
  ), env);
  payload = await response.json();
  assert(response.status === 200 && payload.immutableHash === source.immutableHash, "D1 source read failed.");

  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/classification?id=" + encodeURIComponent(source.id)
  ), env);
  payload = await response.json();
  assert(response.status === 200 && payload.backend === "d1" && payload.assignment.primaryTopic === path, "D1 classification read failed.");

  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/inbox?status=reviewed&channel=theory&limit=1"
  ), env);
  payload = await response.json();
  assert(response.status === 200 && payload.backend === "d1" && payload.records[0].id === source.id, "D1 inbox read or filters failed.");

  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic/message?path=" + encodeURIComponent(path),
    {
      method: "POST",
      body: JSON.stringify({
        content: "A member contribution from the website.",
        replyTo: source.id,
        attachments: [{
          filename: "meeting-notes.txt",
          contentType: "text/plain",
          base64: btoa("private meeting notes")
        }]
      })
    }
  ), env);
  payload = await response.json();
  assert(response.status === 201 && payload.runtimeMirrored, "Member post was not accepted and mirrored.");
  const manualId = payload.record.id;
  assert(database.prepare("SELECT COUNT(*) AS n FROM archive_records WHERE record_id = ?").get(manualId).n === 1, "Member source was not mirrored into D1.");
  assert(database.prepare("SELECT primary_topic FROM classifications WHERE record_id = ?").get(manualId).primary_topic === path, "Member classification was not mirrored.");
  assert(
    database.prepare("SELECT COUNT(*) AS n FROM archive_assets WHERE record_id = ? AND archive_path <> ''").get(manualId).n === 1,
    "The member attachment was not privately mirrored into D1."
  );
  assert(database.prepare("SELECT COUNT(*) AS n FROM revision_events WHERE entity_id = ?").get(manualId).n === 1, "Member event was not mirrored.");
  assert(writtenPaths.some((file) => file.startsWith("source-records/discord-shards/manual-")), "Canonical member source file was not written.");
  assert(writtenPaths.some((file) => file.startsWith("events/")), "Canonical member event was not written.");
  assert(!writtenPaths.includes("classifications/discord.json") && !writtenPaths.includes("source-index/discord.json"), "D1 post rewrote a generated aggregate.");

  const immutableMemberRecord = database.prepare(
    "SELECT record_json FROM archive_records WHERE record_id = ?"
  ).get(manualId).record_json;
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic/message?path=" + encodeURIComponent(path),
    {
      method: "PUT",
      body: JSON.stringify({
        recordId: manualId,
        content: "The member has **clarified** this contribution.",
        note: "Clarified the point.",
        baseVersion: 0
      })
    }
  ), env);
  payload = await response.json();
  assert(response.status === 200 && payload.version === 1 && payload.runtimeMirrored, "The author could not edit their website contribution.");
  assert(payload.record.content.markdown.includes("clarified") && payload.record.editedBy === "Rosa L.", "The edited overlay was not returned with its verified author.");
  assert(
    database.prepare("SELECT record_json FROM archive_records WHERE record_id = ?").get(manualId).record_json === immutableMemberRecord,
    "Editing a member contribution mutated its canonical source record."
  );
  const savedOverlay = database.prepare(
    "SELECT overlay_json, version, edited_by_discord_id FROM message_overlays WHERE record_id = ?"
  ).get(manualId);
  assert(
    savedOverlay.version === 1 &&
    savedOverlay.edited_by_discord_id === "123456789012345678" &&
    JSON.parse(savedOverlay.overlay_json).content.markdown.includes("clarified"),
    "The current member-message overlay was not stored in D1."
  );
  assert(
    database.prepare(
      "SELECT COUNT(*) AS n FROM revision_events WHERE entity_id = ? AND action = 'member-message-edited'"
    ).get(manualId).n === 1,
    "The member edit did not append a D1 revision event."
  );
  assert(writtenPaths.some((file) => file.startsWith("message-overlays/")), "The GitHub fallback overlay was not written.");
  assert(
    writtenPaths.filter((file) => file.startsWith("events/")).length === 2,
    "The member edit did not append a canonical GitHub audit event."
  );

  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic/message/history?path=" + encodeURIComponent(path) +
    "&id=" + encodeURIComponent(manualId)
  ), env);
  payload = await response.json();
  assert(
    response.status === 200 &&
    payload.canEdit === true &&
    payload.versions.length === 2 &&
    payload.versions[0].original &&
    payload.versions[1].content.markdown.includes("clarified"),
    "The author could not read the preserved original and edit history."
  );

  const otherCookie = "__Host-wce_session=" + discordSession(env.SESSION_SECRET, {
    discordId: "999999999999999999",
    username: "other",
    displayName: "Another Member"
  });
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic/message?path=" + encodeURIComponent(path),
    {
      method: "PUT",
      headers: { Cookie: otherCookie },
      body: JSON.stringify({
        recordId: manualId,
        content: "Someone else tried to replace it.",
        baseVersion: 1
      })
    }
  ), env);
  assert(response.status === 403, "A different verified member was allowed to edit the author’s message.");
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic/message/history?path=" + encodeURIComponent(path) +
    "&id=" + encodeURIComponent(manualId),
    { headers: { Cookie: otherCookie } }
  ), env);
  assert(response.status === 403, "A different member was allowed to inspect private message revisions.");

  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic/message?path=" + encodeURIComponent(path),
    {
      method: "PUT",
      body: JSON.stringify({
        recordId: source.id,
        content: "Imported records must stay immutable.",
        baseVersion: 0
      })
    }
  ), env);
  assert(response.status === 409, "An imported Discord source record was accepted by the website-message editor.");

  env.DISCORD_ADMIN_USER_IDS = "777777777777777777";
  const adminCookie = "__Host-wce_session=" + discordSession(env.SESSION_SECRET, {
    discordId: "777777777777777777",
    username: "admin",
    displayName: "Archive Admin",
    admin: true
  });
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic/message?path=" + encodeURIComponent(path),
    {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: JSON.stringify({
        recordId: manualId,
        content: "An administrator still cannot impersonate the author.",
        baseVersion: 1
      })
    }
  ), env);
  assert(response.status === 403, "Administrator status bypassed the author-only message-edit rule.");
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic/message/history?path=" + encodeURIComponent(path) +
    "&id=" + encodeURIComponent(manualId),
    { headers: { Cookie: adminCookie } }
  ), env);
  assert(response.status === 200, "An administrator could not inspect message history for moderation.");
  env.DISCORD_ADMIN_USER_IDS = "";

  response = await worker.fetch(new Request(
    "https://archive.whycommunism.com/v2/topic/message?path=" + encodeURIComponent(path),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Origin": "https://whycommunism.com" },
      body: JSON.stringify({ recordId: manualId, content: "Public overwrite", baseVersion: 1 })
    }
  ), env);
  assert(response.status === 401, "A public visitor was allowed to edit a private source message.");
  response = await worker.fetch(new Request(
    "https://archive.whycommunism.com/v2/topic/message/history?path=" + encodeURIComponent(path) +
    "&id=" + encodeURIComponent(manualId),
    { headers: { Origin: "https://whycommunism.com" } }
  ), env);
  assert(response.status === 401, "A public visitor was allowed to read private message history.");

  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic?path=" + encodeURIComponent(path) + "&limit=1"
  ), env);
  payload = await response.json();
  assert(payload.records.length === 1 && payload.hasMore && payload.nextCursor, "D1 topic cursor was not issued.");
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/topic?path=" + encodeURIComponent(path) +
    "&limit=1&cursor=" + encodeURIComponent(payload.nextCursor)
  ), env);
  const secondPage = await response.json();
  assert(secondPage.records.length === 1 && secondPage.records[0].id !== payload.records[0].id, "D1 topic cursor did not advance.");

  const before = database.prepare("SELECT record_json FROM archive_records WHERE record_id = ?").get(source.id).record_json;
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/classification",
    {
      method: "PUT",
      body: JSON.stringify({
        recordId: source.id,
        primaryTopic: movedPath,
        secondaryTopics: [path],
        confidence: { score: 0.95, label: "high" },
        relevance: "high",
        reviewStatus: "reviewed",
        note: "Ordinary members should not have to classify the archive.",
        baseSha: "d1"
      })
    }
  ), env);
  assert(response.status === 403, "An ordinary verified member was allowed to change source classifications.");

  env.DISCORD_ADMIN_USER_IDS = "123456789012345678";
  response = await worker.fetch(request(
    "https://archive.whycommunism.com/v2/classification",
    {
      method: "PUT",
      body: JSON.stringify({
        recordId: source.id,
        primaryTopic: movedPath,
        secondaryTopics: [path],
        confidence: { score: 0.95, label: "high" },
        relevance: "high",
        reviewStatus: "reviewed",
        note: "Moved after member review.",
        baseSha: "d1"
      })
    }
  ), env);
  payload = await response.json();
  assert(response.status === 200 && payload.runtimeMirrored && payload.assignment.updatedBy === "Rosa L.", "D1 reclassification failed.");
  const saved = JSON.parse(database.prepare("SELECT assignment_json FROM classifications WHERE record_id = ?").get(source.id).assignment_json);
  assert(saved.primaryTopic === movedPath && saved.secondaryTopics[0] === path, "D1 assignment did not move topics.");
  assert(database.prepare("SELECT role FROM topic_references WHERE topic_path = ? AND record_id = ?").get(movedPath, source.id).role === "primary", "New primary topic reference is missing.");
  assert(database.prepare("SELECT role FROM topic_references WHERE topic_path = ? AND record_id = ?").get(path, source.id).role === "secondary", "Old topic was not retained as the requested secondary reference.");
  assert(database.prepare("SELECT record_json FROM archive_records WHERE record_id = ?").get(source.id).record_json === before, "Reclassification mutated the immutable source record.");
  assert(database.prepare("SELECT COUNT(*) AS n FROM revision_events WHERE entity_id = ? AND action = 'classification-updated'").get(source.id).n === 1, "Classification revision event is missing.");
  assert(writtenPaths.filter((file) => file.startsWith("events/")).length === 3, "Reclassification did not append a canonical event.");
  assert(!writtenPaths.includes("classifications/discord.json"), "D1 reclassification rewrote the aggregate classification file.");
  env.DISCORD_ADMIN_USER_IDS = "";

  console.log("archive-api D1 tests passed");
} finally {
  globalThis.fetch = originalFetch;
  database.close();
}
