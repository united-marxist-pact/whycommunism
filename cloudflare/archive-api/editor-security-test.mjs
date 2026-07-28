import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../assets/article-editor.js", import.meta.url), "utf8");

function functionSection(name) {
  const plain = "\n  function " + name + "(";
  const asynchronous = "\n  async function " + name + "(";
  let start = source.indexOf(plain);
  if (start < 0) start = source.indexOf(asynchronous);
  assert.notEqual(start, -1, "Missing frontend helper: " + name);
  start += 1;
  const remainder = source.slice(start);
  const next = remainder.slice(1).search(/\n  (?:async )?function [A-Za-z0-9_$]+\(/);
  return next < 0 ? remainder : remainder.slice(0, next + 1);
}

const helperNames = [
  "escapeHtml",
  "safeUrl",
  "archivedAttachmentUrl",
  "proxiedDiscordAvatarUrl",
  "mayAutoLoadPrivateMedia",
  "noReferrerLinkAttributes",
  "externalMediaCard",
  "initials",
  "avatarMarkup",
  "inlineMarkdown",
  "youtubeId",
  "standaloneEmbed",
  "renderMarkdown",
  "renderAttachment",
  "renderRichEmbed",
  "renderReactions"
];
const helperSource = helperNames.map(functionSection).join("\n");
const context = {
  URL,
  location: {
    href: "https://whycommunism.com/guides/example/",
    origin: "https://whycommunism.com"
  }
};
vm.runInNewContext(
  '"use strict";\n' +
  'var API_ORIGIN = "https://archive.whycommunism.com";\n' +
  helperSource + "\n" +
  "globalThis.helpers = {" + helperNames.join(",") + "};",
  context
);
const helpers = context.helpers;

const externalImage = helpers.renderAttachment({
  filename: "outside.png",
  contentType: "image/png",
  sourceUrl: "https://cdn.example/outside.png"
});
assert.doesNotMatch(externalImage, /<img\b/i, "Private source attachments auto-load an external image.");
assert.match(externalImage, /rel="noopener noreferrer"/, "External attachment links do not suppress opener/referrer access.");
assert.match(externalImage, /referrerpolicy="no-referrer"/, "External attachment links can disclose the private page referrer.");

const externalVideo = helpers.renderAttachment({
  filename: "outside.mp4",
  contentType: "video/mp4",
  sourceUrl: "https://cdn.example/outside.mp4"
});
assert.doesNotMatch(externalVideo, /<video\b/i, "Private source attachments auto-load an external video.");

const archivePath = "attachments/example/00000000-0000-4000-8000-000000000000-private.png";
const privateImage = helpers.renderAttachment({
  filename: "private.png",
  contentType: "image/png",
  archivePath
});
assert.match(privateImage, /<img\b/i, "A validated private archive image no longer renders.");
assert.match(privateImage, /archive\.whycommunism\.com\/v2\/topic\/attachment\?file=/, "The private attachment did not use its authenticated archive endpoint.");

const forgedArchiveUrl = helpers.renderAttachment({
  filename: "forged.png",
  contentType: "image/png",
  sourceUrl: "https://archive.whycommunism.com/v2/topic/attachment?file=https%3A%2F%2Fcdn.example%2Foutside.png"
});
assert.doesNotMatch(forgedArchiveUrl, /<img\b/i, "An invalid archive query bypassed the private-media allowlist.");

const markdownImage = helpers.inlineMarkdown("![diagram](https://cdn.example/diagram.png)", true);
assert.doesNotMatch(markdownImage, /<img\b/i, "Private archived Markdown auto-loads external images.");
assert.match(markdownImage, /External image hidden/, "Private archived Markdown does not offer an explicit safe click-through.");

const youtube = helpers.renderMarkdown("https://www.youtube.com/watch?v=abcdefghijk", true);
assert.doesNotMatch(youtube, /<iframe\b/i, "Private archived Markdown auto-loads a YouTube frame.");
assert.match(youtube, /External video hidden/, "Private YouTube media does not render as an explicit click-through.");

const invalidAvatar = helpers.avatarMarkup("https://cdn.discordapp.com/avatars/1/avatar.png", "Archive Member");
assert.doesNotMatch(invalidAvatar.html, /<img\b/i, "An invalid Discord avatar path was auto-loaded.");
assert.match(invalidAvatar.html, /referrerpolicy="no-referrer"/, "The external-avatar click-through lacks a no-referrer policy.");

const avatar = helpers.avatarMarkup(
  "https://cdn.discordapp.com/avatars/123456789012345678/avatarhash.png?size=4096",
  "Archive Member"
);
assert.match(avatar.html, /<img\b/i, "A validated Discord avatar no longer renders.");
assert.match(
  avatar.html,
  /archive\.whycommunism\.com\/v2\/avatar\/avatars\/123456789012345678\/avatarhash\.png/,
  "A Discord avatar bypassed the authenticated archive proxy."
);
assert.doesNotMatch(
  avatar.html,
  /src="https:\/\/cdn\.discordapp\.com/i,
  "A private source avatar still loads directly from Discord."
);

const reactions = helpers.renderReactions({
  reactions: [{
    emoji: { name: "party", url: "https://cdn.discordapp.com/emojis/1.png" },
    count: 2
  }]
});
assert.doesNotMatch(reactions, /<img\b/i, "A private custom emoji auto-loads from Discord.");
assert.match(reactions, /wce-external-emoji/, "An external custom emoji lacks an explicit click-through.");

const richEmbed = helpers.renderRichEmbed({
  title: "External card",
  media: [{
    filename: "card.png",
    contentType: "image/png",
    sourceUrl: "https://cdn.example/card.png"
  }]
});
assert.doesNotMatch(richEmbed, /<img\b/i, "A rich private embed auto-loads external media.");

const sourceContentSection = functionSection("sourceContentHtml");
assert.match(sourceContentSection, /sanitizeRichHtml\(content\.html,\s*true\)/, "Archived rich HTML is not rendered in private-media mode.");
assert.match(sourceContentSection, /renderMarkdown\(sourceContent\(message\),\s*true\)/, "Archived Markdown is not rendered in private-media mode.");
const sanitizeSection = functionSection("sanitizeRichHtml");
assert.match(sanitizeSection, /protectPrivateArchive[\s\S]*!mayAutoLoadPrivateMedia\(imageUrl\)[\s\S]*node\.replaceWith\(imageLink\)/, "Archived rich-HTML images are not replaced with safe click-throughs.");

const signOutSection = functionSection("signOut");
const logoutAwait = signOutSection.indexOf('await apiRequest("/v2/session", { method: "DELETE" })');
const statePurge = signOutSection.indexOf("purgePrivateState()");
const domPurge = signOutSection.indexOf("purgePrivateDom()");
const reload = signOutSection.indexOf("window.location.reload()");
assert(
  logoutAwait >= 0 && statePurge > logoutAwait && domPurge > statePurge && reload > domPurge,
  "Logout does not await cookie deletion before purging private state/DOM and reloading."
);
assert.match(functionSection("purgePrivateState"), /state\.finalDocument = null[\s\S]*state\.sources = \[\][\s\S]*state\.accessList = null|state\.accessList = null[\s\S]*state\.sources = \[\]/, "Logout does not clear all private in-memory collections.");
assert.match(functionSection("purgePrivateDom"), /sourceStream\.replaceChildren\(\)[\s\S]*accessList\.replaceChildren\(\)[\s\S]*finalRender\.replaceChildren\(\)[\s\S]*historyList\.replaceChildren\(\)/, "Logout does not clear every private rendering surface.");
assert.match(source, /modebar\.addEventListener\("click", async function[\s\S]*await signOut\(\)/, "The sign-out UI still fires logout without awaiting it.");

console.log("article-editor security tests passed");
