(function () {
  "use strict";

  var article = document.querySelector("main.art");
  var hero = document.querySelector("header.hero");
  if (!article || !hero) return;

  var API_ORIGIN = "https://archive.whycommunism.com";
  var articlePath = location.pathname.replace(/\/+$/, "") + "/";
  var heroTitle = hero.querySelector("h1");
  var heroTitleText = heroTitle && (heroTitle.querySelector("b") || heroTitle);
  var heroSubtitle = hero.querySelector(".std");
  var draftTitle = (heroTitle || document.querySelector("title")).textContent.trim();
  var editorTitle = (hero.getAttribute("data-wce-editor-title") || draftTitle).trim();
  var draftDocumentTitle = document.title;
  var state = {
    mode: "final",
    sessionChecked: false,
    authenticated: false,
    canReadArchive: false,
    canEdit: false,
    user: null,
    finalLoaded: false,
    finalEditing: false,
    finalDocument: null,
    finalDraftCitations: [],
    finalHistory: [],
    finalPreviewSha: "",
    accessList: null,
    sourcesLoaded: false,
    sources: [],
    assignments: {},
    archiveSha: "",
    groupByChannel: false,
    pendingMode: "",
    sourceReplyTo: "",
    sourceEditingId: "",
    sourceSending: false,
    sourceFiles: [],
    signingOut: false
  };
  var activeRequests = new Set();

  var modebar = document.createElement("section");
  modebar.className = "wce-modebar";
  modebar.setAttribute("aria-label", "Article workspace");
  modebar.innerHTML =
    '<div class="wce-modebar-main">' +
      '<span class="wce-mode-label">Article workspace</span>' +
      '<div class="wce-mode-tabs" role="tablist" aria-label="Choose article view">' +
        '<button class="wce-mode is-active" type="button" role="tab" data-wce-mode="final" aria-selected="true">Final argument</button>' +
        '<button class="wce-mode" type="button" role="tab" data-wce-mode="sources" aria-selected="false">Source archive</button>' +
        '<button class="wce-mode" type="button" role="tab" data-wce-mode="draft" aria-selected="false">Current draft</button>' +
      "</div>" +
    "</div>" +
    '<div class="wce-account">' +
      '<span class="wce-session-state">Checking access…</span>' +
      '<button type="button" data-wce-action="access-open" hidden>Manage access</button>' +
      '<button type="button" data-wce-action="login-open">Continue with Discord</button>' +
      '<button type="button" data-wce-action="logout" hidden>Sign out</button>' +
    "</div>";

  var loginPanel = document.createElement("section");
  loginPanel.className = "wce-login-panel";
  loginPanel.hidden = true;
  loginPanel.innerHTML =
    '<div class="wce-discord-login">' +
      '<div><span class="wce-eyebrow">Editorial access</span><h2>Continue with Discord</h2><p>Discord verifies that you are a member of United Marxist Pact. Every server member can read the sources. Members with the Tutor role, plus Daemon Sultan, can edit and contribute to the final argument. Everyone else can still read both public article views.</p></div>' +
      '<p class="wce-login-status" role="status" aria-live="polite"></p>' +
      '<div class="wce-login-actions"><button type="button" data-wce-action="login-close">Cancel</button><a class="wce-primary" data-wce-discord-login href="#">Continue with Discord</a></div>' +
    "</div>";

  var accessPanel = document.createElement("section");
  accessPanel.className = "wce-access-panel";
  accessPanel.hidden = true;
  accessPanel.innerHTML =
    '<header><div><span class="wce-eyebrow">Administrator only</span><h2>Member access</h2><p>Block a Discord account from the private archive, or restore access later. Every change can be traced and undone.</p></div><button type="button" data-wce-action="access-close">Close</button></header>' +
    '<form class="wce-access-form"><label>Discord user ID<input name="discordId" inputmode="numeric" autocomplete="off" maxlength="30" required placeholder="123456789012345678"></label><label>Reason, optional<input name="note" maxlength="240" placeholder="Short private note"></label><button class="wce-primary" type="submit">Block account</button></form>' +
    '<p class="wce-access-status" role="status" aria-live="polite"></p>' +
    '<div class="wce-access-list"></div>' +
    '<details class="wce-access-history"><summary>Recent access changes</summary><div></div></details>';

  var finalWorkspace = document.createElement("section");
  finalWorkspace.className = "wce-workspace wce-final";
  finalWorkspace.innerHTML =
    '<header class="wce-workspace-head">' +
      '<div><span class="wce-eyebrow">Public reading copy</span><h2></h2></div>' +
      '<div class="wce-final-actions" hidden>' +
        '<button type="button" data-wce-action="final-edit">Edit argument</button>' +
        '<button type="button" data-wce-action="final-checkpoint">Checkpoint</button>' +
        '<button type="button" data-wce-action="final-history" aria-expanded="false">History</button>' +
      "</div>" +
    "</header>" +
    '<p class="wce-workspace-status" role="status" aria-live="polite">Loading the final argument…</p>' +
    '<article class="wce-final-render wce-preview"></article>' +
    '<section class="wce-final-editor" hidden>' +
      '<div class="wce-word-toolbar" role="toolbar" aria-label="Argument formatting">' +
        '<button type="button" data-command="bold" aria-label="Bold (Ctrl+B)"><b>B</b></button>' +
        '<button type="button" data-command="italic" aria-label="Italic (Ctrl+I)"><i>I</i></button>' +
        '<button type="button" data-command="underline" aria-label="Underline (Ctrl+U)"><u>U</u></button>' +
        '<button type="button" data-command="strike" aria-label="Strikethrough"><s>S</s></button>' +
        '<button type="button" data-command="code" aria-label="Inline code (Ctrl+E)">&lt;/&gt;</button>' +
        '<span class="wce-toolbar-sep" aria-hidden="true"></span>' +
        '<button type="button" data-block="p">Body</button>' +
        '<button type="button" data-block="h2">Heading 2</button>' +
        '<button type="button" data-block="h3">Heading 3</button>' +
        '<button type="button" data-command="insertUnorderedList" aria-label="Bulleted list">• List</button>' +
        '<button type="button" data-command="insertOrderedList" aria-label="Numbered list">1. List</button>' +
        '<button type="button" data-block="blockquote">Quote</button>' +
        '<button type="button" data-command="codeblock" aria-label="Code block">Code block</button>' +
        '<button type="button" data-command="hr" aria-label="Divider">— Divider</button>' +
        '<span class="wce-toolbar-sep" aria-hidden="true"></span>' +
        '<button type="button" data-wce-action="final-link">Link</button>' +
        '<button type="button" data-wce-action="citation-open">Insert citation</button>' +
        '<button type="button" class="wce-preview-toggle" data-wce-action="final-preview" aria-pressed="false">Preview</button>' +
      "</div>" +
      '<textarea class="wce-word-page" rows="24" spellcheck="true" aria-label="Final argument Markdown"></textarea>' +
      '<footer class="wce-final-savebar"><label>Revision note<input class="wce-final-note" type="text" maxlength="160" placeholder="What changed?"></label><span class="wce-final-count"></span><button type="button" data-wce-action="final-cancel">Cancel</button><button class="wce-primary" type="button" data-wce-action="final-save">Save argument</button></footer>' +
    "</section>" +
    '<section class="wce-citation-picker" hidden>' +
      '<header><div><span class="wce-eyebrow">Inline citation</span><h3>Choose a source</h3></div><button type="button" data-wce-action="citation-close">Close</button></header>' +
      '<div class="wce-citation-tabs"><button class="is-active" type="button" data-citation-type="discord">Discord source</button><button type="button" data-citation-type="pdf">PDF / page</button></div>' +
      '<div data-citation-panel="discord"><label>Archived message<select class="wce-citation-source"><option>Loading sources…</option></select></label></div>' +
      '<div data-citation-panel="pdf" hidden><label>Document title<input class="wce-citation-title" type="text" placeholder="Title of document"></label><label>PDF URL<input class="wce-citation-url" type="url" placeholder="https://…"></label><label>Page<input class="wce-citation-page" type="text" placeholder="12 or 12–14"></label></div>' +
      '<footer><span class="wce-citation-status" role="status"></span><button class="wce-primary" type="button" data-wce-action="citation-insert">Insert citation</button></footer>' +
    "</section>" +
    '<section class="wce-final-history" hidden><header><div><span class="wce-eyebrow">Edit history</span><h3>Named revisions</h3></div><button type="button" data-wce-action="history-close">Close</button></header><div class="wce-final-history-list"></div></section>';

  var sourceWorkspace = document.createElement("section");
  sourceWorkspace.className = "wce-workspace wce-source-archive";
  sourceWorkspace.hidden = true;
  sourceWorkspace.innerHTML =
    '<header class="wce-workspace-head">' +
      '<div><span class="wce-eyebrow">Private evidence room</span><h2>Source archive</h2><p>Imported messages stay exactly as collected. Server members can add attributed messages, replies, files, and review notes without altering the original record.</p></div>' +
      '<span class="wce-source-count"></span>' +
    "</header>" +
    '<form class="wce-source-filters" aria-label="Source archive filters">' +
      '<label>Channel<select data-filter="channel"><option value="">All channels</option></select></label>' +
      '<label>Author<select data-filter="author"><option value="">All authors</option></select></label>' +
      '<label>From<input type="date" data-filter="from"></label>' +
      '<label>To<input type="date" data-filter="to"></label>' +
      '<label>Review<select data-filter="review"><option value="">Any review state</option><option value="reviewed">Reviewed</option><option value="unreviewed">Unreviewed</option></select></label>' +
      '<label>Relevance<select data-filter="relevance"><option value="">Any relevance</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>' +
      '<label class="wce-filter-search">Search<input type="search" data-filter="query" placeholder="Message text or note"></label>' +
      '<label class="wce-group-toggle"><input type="checkbox" data-wce-action="group-channel"> Group by channel</label>' +
      '<button type="reset">Clear filters</button>' +
    "</form>" +
    '<p class="wce-workspace-status" role="status" aria-live="polite">Waiting for editor access…</p>' +
    '<div class="wce-source-stream" aria-label="Chronological source messages"></div>' +
    '<form class="wce-source-composer" hidden>' +
      '<div class="wce-source-composer-identity"><span class="wce-source-composer-avatar" aria-hidden="true"></span><div><strong></strong><span>Posting with your verified Discord identity</span></div></div>' +
      '<div class="wce-source-composer-reply" hidden><span>Replying to <strong></strong><i></i></span><button type="button" data-wce-action="source-reply-cancel" aria-label="Cancel reply">×</button></div>' +
      '<textarea rows="4" maxlength="100000" spellcheck="true" placeholder="Message this topic with Markdown…"></textarea>' +
      '<div class="wce-source-pending-files" hidden aria-live="polite"></div>' +
      '<footer><label class="wce-source-file-button" title="Add images or documents"><span aria-hidden="true">＋</span><span class="wce-source-file-label">Add file</span><input type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.doc,.docx,.odt,.xls,.xlsx,.ppt,.pptx,image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.oasis.opendocument.text,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"></label><span class="wce-source-compose-status" role="status" aria-live="polite"></span><span class="wce-source-compose-count">0 words</span><button class="wce-primary" type="submit">Send message</button></footer>' +
    "</form>";

  finalWorkspace.querySelector(".wce-workspace-head h2").textContent = editorTitle;
  hero.insertAdjacentElement("afterend", modebar);
  modebar.insertAdjacentElement("afterend", loginPanel);
  loginPanel.insertAdjacentElement("afterend", accessPanel);
  accessPanel.insertAdjacentElement("afterend", finalWorkspace);
  finalWorkspace.insertAdjacentElement("afterend", sourceWorkspace);

  var sessionState = modebar.querySelector(".wce-session-state");
  var loginButton = modebar.querySelector('[data-wce-action="login-open"]');
  var logoutButton = modebar.querySelector('[data-wce-action="logout"]');
  var accessButton = modebar.querySelector('[data-wce-action="access-open"]');
  var loginStatus = loginPanel.querySelector(".wce-login-status");
  loginPanel.querySelector("[data-wce-discord-login]").href = API_ORIGIN + "/v2/auth/discord?returnTo=" + encodeURIComponent(location.href);
  var finalStatus = finalWorkspace.querySelector(".wce-workspace-status");
  var finalRender = finalWorkspace.querySelector(".wce-final-render");
  var finalEditor = finalWorkspace.querySelector(".wce-final-editor");
  var wordPage = finalWorkspace.querySelector(".wce-word-page");
  var finalCount = finalWorkspace.querySelector(".wce-final-count");
  var finalNote = finalWorkspace.querySelector(".wce-final-note");
  var citationPicker = finalWorkspace.querySelector(".wce-citation-picker");
  var historyPanel = finalWorkspace.querySelector(".wce-final-history");
  var historyList = finalWorkspace.querySelector(".wce-final-history-list");
  var accessForm = accessPanel.querySelector(".wce-access-form");
  var accessStatus = accessPanel.querySelector(".wce-access-status");
  var accessList = accessPanel.querySelector(".wce-access-list");
  var accessHistory = accessPanel.querySelector(".wce-access-history div");
  var sourceStatus = sourceWorkspace.querySelector(".wce-workspace-status");
  var sourceStream = sourceWorkspace.querySelector(".wce-source-stream");
  var sourceFilters = sourceWorkspace.querySelector(".wce-source-filters");
  var sourceComposer = sourceWorkspace.querySelector(".wce-source-composer");
  var sourceComposerText = sourceComposer.querySelector("textarea");
  var sourceComposerReply = sourceComposer.querySelector(".wce-source-composer-reply");
  var sourceComposerStatus = sourceComposer.querySelector(".wce-source-compose-status");
  var sourceComposerCount = sourceComposer.querySelector(".wce-source-compose-count");
  var sourceComposerFileInput = sourceComposer.querySelector('input[type="file"]');
  var sourceComposerPendingFiles = sourceComposer.querySelector(".wce-source-pending-files");

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function safeUrl(value) {
    try {
      var url = new URL(String(value || ""), location.href);
      return /^(https?:)$/.test(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function archivedAttachmentUrl(value) {
    var archivePath = String(value || "");
    return /^attachments\/[a-z0-9-]+\/[a-f0-9-]{36}-[a-zA-Z0-9._-]+$/.test(archivePath)
      ? API_ORIGIN + "/v2/topic/attachment?file=" + encodeURIComponent(archivePath)
      : "";
  }

  function proxiedDiscordAvatarUrl(value) {
    try {
      var source = new URL(String(value || ""));
      var validPath = /^\/avatars\/[0-9]{5,30}\/[a-zA-Z0-9_]+\.(?:png|jpe?g|webp|gif)$/.test(source.pathname) ||
        /^\/guilds\/[0-9]{5,30}\/users\/[0-9]{5,30}\/avatars\/[a-zA-Z0-9_]+\.(?:png|jpe?g|webp|gif)$/.test(source.pathname) ||
        /^\/embed\/avatars\/[0-5]\.png$/.test(source.pathname);
      if (source.protocol !== "https:" || source.hostname !== "cdn.discordapp.com" || source.port || source.username || source.password || !validPath) return "";
      source.search = "";
      source.hash = "";
      return API_ORIGIN + "/v2/avatar" + source.pathname;
    } catch (_) {
      return "";
    }
  }

  function mayAutoLoadPrivateMedia(value) {
    try {
      var url = new URL(String(value || ""), location.href);
      if (url.origin === location.origin) return true;
      var api = new URL(API_ORIGIN);
      if (url.origin !== api.origin) return false;
      if (url.pathname === "/v2/topic/attachment") return Boolean(archivedAttachmentUrl(url.searchParams.get("file")));
      if (url.pathname.startsWith("/v2/avatar/") && !url.search && !url.hash) {
        return Boolean(proxiedDiscordAvatarUrl("https://cdn.discordapp.com" + url.pathname.slice("/v2/avatar".length)));
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function noReferrerLinkAttributes() {
    return ' target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"';
  }

  function externalMediaCard(url, name, kind, archiveLabel) {
    var hostname = "";
    try { hostname = new URL(url).hostname.replace(/^www\./, ""); } catch (_) {}
    return '<a class="wce-source-file wce-external-media-link" href="' + escapeHtml(url) + '"' + noReferrerLinkAttributes() + ">" +
      '<span aria-hidden="true">' + (kind === "video" ? "▷" : "▧") + "</span>" +
      "<strong>" + escapeHtml(name) + "</strong>" +
      "<i>External " + escapeHtml(kind) + " hidden · open ↗</i>" +
      (hostname ? "<small>" + escapeHtml(hostname) + "</small>" : "") +
      (archiveLabel || "") +
    "</a>";
  }

  function avatarMarkup(value, name, fallbackValue) {
    var avatar = value && typeof value === "object" ? value : {};
    var privateUrl = archivedAttachmentUrl(avatar.archivePath);
    var sourceUrl = (typeof value === "string" ? value : avatar.sourceUrl || avatar.url || avatar.proxyUrl || avatar.src) || fallbackValue;
    var url = safeUrl(privateUrl || proxiedDiscordAvatarUrl(sourceUrl) || sourceUrl);
    var fallback = escapeHtml(initials(name));
    if (!url) return { html: fallback, interactive: false };
    if (mayAutoLoadPrivateMedia(url)) {
      return {
        html: '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">',
        interactive: false
      };
    }
    return {
      html: '<a class="wce-external-avatar" href="' + escapeHtml(url) + '"' + noReferrerLinkAttributes() + ' aria-label="Open external avatar for ' + escapeHtml(name) + '">' + fallback + "</a>",
      interactive: true
    };
  }

  function timeLabel(value, dateOnly) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "Unknown date");
    return new Intl.DateTimeFormat(undefined, dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function plainText(html) {
    var element = document.createElement("div");
    element.innerHTML = String(html || "");
    return (element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function initials(value) {
    return String(value || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join("") || "?";
  }

  function sanitizeRichHtml(value, protectPrivateArchive) {
    var template = document.createElement("template");
    template.innerHTML = String(value || "");
    var allowed = new Set(["P", "BR", "H2", "H3", "H4", "STRONG", "B", "EM", "I", "U", "S", "UL", "OL", "LI", "BLOCKQUOTE", "A", "SUP", "SUB", "HR", "CITE", "FIGURE", "FIGCAPTION", "IMG", "CODE", "PRE", "SPAN"]);
    Array.from(template.content.querySelectorAll("*")).forEach(function (node) {
      if (!allowed.has(node.tagName)) {
        node.replaceWith.apply(node, Array.from(node.childNodes));
        return;
      }
      Array.from(node.attributes).forEach(function (attribute) {
        if (!["href", "src", "alt", "title", "class", "data-source-id", "data-page"].includes(attribute.name)) node.removeAttribute(attribute.name);
      });
      if (node.hasAttribute("href") && !safeUrl(node.getAttribute("href"))) node.removeAttribute("href");
      if (node.hasAttribute("src") && !safeUrl(node.getAttribute("src"))) node.removeAttribute("src");
      if (node.tagName === "A" && node.hasAttribute("href")) {
        node.target = "_blank";
        node.rel = "noopener noreferrer";
        node.referrerPolicy = "no-referrer";
      }
      if (node.tagName === "IMG" && node.hasAttribute("src")) {
        var imageUrl = safeUrl(node.getAttribute("src"));
        if (protectPrivateArchive && imageUrl && !mayAutoLoadPrivateMedia(imageUrl)) {
          var imageLink = document.createElement("a");
          imageLink.className = "wce-external-media-link";
          imageLink.href = imageUrl;
          imageLink.target = "_blank";
          imageLink.rel = "noopener noreferrer";
          imageLink.referrerPolicy = "no-referrer";
          imageLink.textContent = "External image hidden · open " + (node.getAttribute("alt") || "image") + " ↗";
          node.replaceWith(imageLink);
        } else {
          node.loading = "lazy";
          node.referrerPolicy = "no-referrer";
        }
      }
    });
    return template.innerHTML;
  }

  function inlineMarkdown(source, protectPrivateArchive) {
    var tokens = [];
    function token(html) {
      var marker = "\u0000WCE" + tokens.length + "\u0000";
      tokens.push(html);
      return marker;
    }
    var text = String(source || "");
    text = text.replace(/`([^`\n]+)`/g, function (_, code) { return token("<code>" + escapeHtml(code) + "</code>"); });
    text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, function (whole, alt, url) {
      var safe = safeUrl(url);
      if (!safe) return whole;
      if (protectPrivateArchive && !mayAutoLoadPrivateMedia(safe)) {
        return token('<a class="wce-external-media-link" href="' + escapeHtml(safe) + '"' + noReferrerLinkAttributes() + ">External image hidden" + (alt ? " · " + escapeHtml(alt) : "") + " ↗</a>");
      }
      return token('<a class="wce-image-attachment" href="' + escapeHtml(safe) + '"' + noReferrerLinkAttributes() + '><img src="' + escapeHtml(safe) + '" alt="' + escapeHtml(alt) + '" loading="lazy" referrerpolicy="no-referrer"></a>');
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (whole, label, url) {
      var safe = safeUrl(url);
      return safe ? token('<a href="' + escapeHtml(safe) + '"' + noReferrerLinkAttributes() + ">" + escapeHtml(label) + "</a>") : whole;
    });
    text = escapeHtml(text);
    text = text.replace(/\|\|([^|\n]+)\|\|/g, function (_, hidden) { return '<span class="wce-spoiler" tabindex="0" role="button" aria-label="Spoiler">' + hidden + "</span>"; });
    text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_\n]+)__/g, "<u>$1</u>");
    text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
    text = text.replace(/https?:\/\/[^\s<\u0000]+/g, function (raw) {
      var trailing = raw.match(/[.,!?;:]+$/);
      var clean = trailing ? raw.slice(0, -trailing[0].length) : raw;
      var safe = safeUrl(clean.replace(/&amp;/g, "&"));
      return safe ? '<a href="' + escapeHtml(safe) + '"' + noReferrerLinkAttributes() + ">" + clean + "</a>" + (trailing ? trailing[0] : "") : raw;
    });
    return text.replace(/\u0000WCE(\d+)\u0000/g, function (_, index) { return tokens[Number(index)]; });
  }

  function youtubeId(value) {
    try {
      var url = new URL(value);
      var host = url.hostname.replace(/^www\./, "");
      var id = host === "youtu.be" ? url.pathname.split("/")[1] : url.searchParams.get("v");
      var youtubeHost = host === "youtube.com" || host.endsWith(".youtube.com");
      if (!id && youtubeHost && /^\/(shorts|embed)\//.test(url.pathname)) id = url.pathname.split("/")[2];
      if (!youtubeHost && host !== "youtu.be") id = "";
      return /^[A-Za-z0-9_-]{6,15}$/.test(id || "") ? id : "";
    } catch (_) {
      return "";
    }
  }

  function standaloneEmbed(value, protectPrivateArchive) {
    var safe = safeUrl(String(value || "").trim());
    if (!safe) return "";
    var youtube = youtubeId(safe);
    var image = /\.(?:png|jpe?g|gif|webp|avif)(?:[?#].*)?$/i.test(safe);
    var video = /\.(?:mp4|webm|ogg|mov)(?:[?#].*)?$/i.test(safe);
    if (protectPrivateArchive && !mayAutoLoadPrivateMedia(safe) && (youtube || image || video)) {
      return externalMediaCard(safe, youtube ? "YouTube video" : (image ? "Source image" : "Source video"), youtube || video ? "video" : "image");
    }
    if (youtube) return '<figure class="wce-embed wce-video"><iframe src="https://www.youtube-nocookie.com/embed/' + escapeHtml(youtube) + '" title="Embedded YouTube video" loading="lazy" referrerpolicy="no-referrer" allowfullscreen></iframe><figcaption><a href="' + escapeHtml(safe) + '"' + noReferrerLinkAttributes() + ">Open on YouTube</a></figcaption></figure>";
    if (image) return '<figure class="wce-embed wce-image"><img src="' + escapeHtml(safe) + '" alt="Source image" loading="lazy" referrerpolicy="no-referrer"><figcaption><a href="' + escapeHtml(safe) + '"' + noReferrerLinkAttributes() + ">Open original image</a></figcaption></figure>";
    if (video) return '<figure class="wce-embed"><video src="' + escapeHtml(safe) + '" controls preload="metadata" referrerpolicy="no-referrer"></video><figcaption><a href="' + escapeHtml(safe) + '"' + noReferrerLinkAttributes() + ">Open video</a></figcaption></figure>";
    return '<a class="wce-link-card" href="' + escapeHtml(safe) + '"' + noReferrerLinkAttributes() + '><span>' + escapeHtml(new URL(safe).hostname.replace(/^www\./, "")) + '</span><strong>' + escapeHtml(safe) + '</strong><i>Open link ↗</i></a>';
  }

  function renderMarkdown(source, protectPrivateArchive) {
    var fences = [];
    var prepared = String(source || "").replace(/\r\n?/g, "\n").replace(/```[^\n`]*\n?([\s\S]*?)```/g, function (_, code) {
      fences.push('<pre class="wce-codeblock"><code>' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
      return "\u0000FENCE" + (fences.length - 1) + "\u0000";
    });
    var lines = prepared.split("\n");
    var output = [];
    var list = "";
    var quote = null;
    var quoteAll = false;
    function closeList() { if (list) output.push("</" + list + ">"); list = ""; }
    function closeQuote() {
      if (quote) output.push("<blockquote>" + quote.map(function (entry) {
        return entry ? "<p>" + entry + "</p>" : '<p class="wce-quote-gap"></p>';
      }).join("") + "</blockquote>");
      quote = null;
    }
    lines.forEach(function (line) {
      var fence = line.match(/^\s*\u0000FENCE(\d+)\u0000\s*$/);
      if (fence) { closeQuote(); closeList(); output.push(fences[Number(fence[1])]); return; }
      if (quoteAll) { quote = quote || []; quote.push(inlineMarkdown(line, protectPrivateArchive)); return; }
      var blockQuoteAll = line.match(/^\s*>>>\s?([\s\S]*)$/);
      if (blockQuoteAll) { closeList(); quoteAll = true; quote = quote || []; quote.push(inlineMarkdown(blockQuoteAll[1], protectPrivateArchive)); return; }
      var quoted = line.match(/^\s*>\s?(.*)$/);
      if (quoted) { closeList(); quote = quote || []; quote.push(inlineMarkdown(quoted[1], protectPrivateArchive)); return; }
      closeQuote();
      if (!line.trim()) { closeList(); return; }
      var heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        closeList();
        var level = Math.max(2, heading[1].length);
        output.push("<h" + level + ">" + inlineMarkdown(heading[2], protectPrivateArchive) + "</h" + level + ">");
        return;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); output.push("<hr>"); return; }
      var subtext = line.match(/^\s*-#\s+(.+)$/);
      if (subtext) { closeList(); output.push('<p class="wce-subtext">' + inlineMarkdown(subtext[1], protectPrivateArchive) + "</p>"); return; }
      var unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      var ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
      if (unordered || ordered) {
        var wanted = unordered ? "ul" : "ol";
        if (list !== wanted) {
          closeList();
          list = wanted;
          output.push(wanted === "ol" && Number(ordered[1]) > 1 ? '<ol start="' + Number(ordered[1]) + '">' : "<" + wanted + ">");
        }
        output.push("<li>" + inlineMarkdown(unordered ? unordered[1] : ordered[2], protectPrivateArchive) + "</li>");
        return;
      }
      closeList();
      output.push(/^\s*https?:\/\/\S+\s*$/.test(line) ? standaloneEmbed(line, protectPrivateArchive) : "<p>" + inlineMarkdown(line, protectPrivateArchive) + "</p>");
    });
    closeQuote();
    closeList();
    return output.join("");
  }

  async function apiRequest(path, options) {
    var method = String(options && options.method || "GET").toUpperCase();
    var logoutRequest = path === "/v2/session" && method === "DELETE";
    if (state.signingOut && !logoutRequest) throw new Error("Signing out…");
    var controller = new AbortController();
    activeRequests.add(controller);
    var timeoutMs = options && Number(options.timeoutMs) || 15000;
    var timeout = setTimeout(function () { controller.abort(); }, timeoutMs);
    var requestOptions = Object.assign({ credentials: "include", signal: controller.signal, headers: { "Content-Type": "application/json" } }, options || {});
    delete requestOptions.timeoutMs;
    try {
      var response = await fetch(API_ORIGIN + path, requestOptions);
      var payload = await response.json().catch(function () { return {}; });
      if (state.signingOut && !logoutRequest) throw new Error("Signing out…");
      if (!response.ok) {
        var error = new Error(payload.error || payload.message || "The editorial service could not complete this request.");
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The editorial service took too long to respond.");
      if (error instanceof TypeError) throw new Error("The editorial service is temporarily unavailable.");
      throw error;
    } finally {
      clearTimeout(timeout);
      activeRequests.delete(controller);
    }
  }

  function query(endpoint) {
    return endpoint + "?path=" + encodeURIComponent(articlePath);
  }

  async function apiFirst(paths, options) {
    var lastError;
    for (var index = 0; index < paths.length; index += 1) {
      try { return await apiRequest(paths[index], options); }
      catch (error) {
        lastError = error;
        if (error.status !== 404) throw error;
      }
    }
    throw lastError || new Error("The editorial service is unavailable.");
  }

  function updateSessionUi() {
    var name = state.user && (state.user.displayName || state.user.name || state.user.username) || "editor";
    sessionState.removeAttribute("title");
    sessionState.textContent = state.authenticated
      ? "Signed in as " + name + (state.canReadArchive && !state.canEdit ? " · Read only" : "")
      : (state.sessionChecked ? "Public reader" : "Checking access…");
    loginButton.hidden = state.authenticated;
    logoutButton.hidden = !state.authenticated;
    accessButton.hidden = !(state.user && state.user.admin);
    if (accessButton.hidden) accessPanel.hidden = true;
    var finalActions = finalWorkspace.querySelector(".wce-final-actions");
    finalActions.hidden = !(state.canReadArchive || state.canEdit);
    finalActions.querySelector('[data-wce-action="final-edit"]').hidden = !state.canEdit;
    finalActions.querySelector('[data-wce-action="final-checkpoint"]').hidden = !state.canEdit;
    finalActions.querySelector('[data-wce-action="final-history"]').hidden = !state.canReadArchive;
    sourceWorkspace.classList.toggle("is-authenticated", state.authenticated);
    sourceComposer.hidden = !state.canEdit;
    var composerAvatar = sourceComposer.querySelector(".wce-source-composer-avatar");
    var avatarValue = state.user && state.user.avatar;
    var renderedAvatar = avatarMarkup(avatarValue, name, state.user && (state.user.avatarUrl || state.user.avatarURL));
    composerAvatar.innerHTML = renderedAvatar.html;
    composerAvatar.toggleAttribute("aria-hidden", !renderedAvatar.interactive);
    sourceComposer.querySelector(".wce-source-composer-identity strong").textContent = name;
  }

  function purgePrivateState() {
    state.mode = "final";
    state.sessionChecked = true;
    state.authenticated = false;
    state.canReadArchive = false;
    state.canEdit = false;
    state.user = null;
    state.finalLoaded = false;
    state.finalEditing = false;
    state.finalDocument = null;
    state.finalDraftCitations = [];
    state.finalHistory = [];
    state.finalPreviewSha = "";
    state.accessList = null;
    state.sourcesLoaded = false;
    state.sources = [];
    state.assignments = {};
    state.archiveSha = "";
    state.groupByChannel = false;
    state.pendingMode = "";
    state.sourceReplyTo = "";
    state.sourceEditingId = "";
    state.sourceSending = false;
    state.sourceFiles = [];
  }

  function purgePrivateDom() {
    sourceStream.replaceChildren();
    sourceWorkspace.querySelector(".wce-source-count").textContent = "";
    sourceStatus.hidden = false;
    sourceStatus.textContent = "Signed out. Private sources have been cleared.";
    sourceFilters.reset();
    Array.from(sourceFilters.querySelectorAll("select")).forEach(function (select) {
      while (select.options.length > 1) select.remove(1);
    });
    sourceFilters.querySelector('[data-wce-action="group-channel"]').checked = false;
    sourceComposerText.value = "";
    sourceComposerFileInput.value = "";
    sourceComposerFileInput.disabled = false;
    sourceComposer.querySelector('[type="submit"]').disabled = false;
    sourceComposerPendingFiles.replaceChildren();
    sourceComposerPendingFiles.hidden = true;
    sourceComposerReply.hidden = true;
    sourceComposerReply.querySelector("strong").textContent = "";
    sourceComposerReply.querySelector("i").textContent = "";
    sourceComposerStatus.textContent = "";
    sourceComposerCount.textContent = "0 words";
    sourceComposer.querySelector(".wce-source-composer-avatar").replaceChildren();
    sourceComposer.querySelector(".wce-source-composer-identity strong").textContent = "";

    accessPanel.hidden = true;
    accessForm.reset();
    accessStatus.textContent = "";
    accessList.replaceChildren();
    accessHistory.replaceChildren();
    accessPanel.querySelector(".wce-access-history").open = false;

    wordPage.value = "";
    finalNote.value = "";
    finalCount.textContent = "";
    finalEditor.hidden = true;
    finalRender.hidden = false;
    finalRender.replaceChildren();
    finalStatus.hidden = false;
    finalStatus.textContent = "Signed out. Reloading the public article…";
    historyPanel.hidden = true;
    historyList.replaceChildren();
    finalWorkspace.querySelector('[data-wce-action="final-history"]').setAttribute("aria-expanded", "false");
    citationPicker.hidden = true;
    citationPicker.querySelector(".wce-citation-source").replaceChildren();
    Array.from(citationPicker.querySelectorAll("input")).forEach(function (input) { input.value = ""; });
    citationPicker.querySelector(".wce-citation-status").textContent = "";

    loginPanel.hidden = true;
    loginStatus.textContent = "";
    sourceWorkspace.hidden = true;
    finalWorkspace.hidden = false;
    article.hidden = true;
    Array.from(modebar.querySelectorAll("[data-wce-mode]")).forEach(function (button) {
      var active = button.dataset.wceMode === "final";
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (heroTitleText) heroTitleText.textContent = editorTitle;
    if (heroSubtitle) heroSubtitle.hidden = true;
    document.title = editorTitle + " — Why Communism?";
  }

  async function signOut() {
    if (state.signingOut) return;
    state.signingOut = true;
    logoutButton.disabled = true;
    sessionState.textContent = "Signing out…";
    try {
      await apiRequest("/v2/session", { method: "DELETE" });
    } catch (error) {
      state.signingOut = false;
      logoutButton.disabled = false;
      updateSessionUi();
      sessionState.textContent = "Sign out failed. Try again.";
      sessionState.title = error.message;
      return;
    }
    activeRequests.forEach(function (controller) { controller.abort(); });
    activeRequests.clear();
    purgePrivateState();
    purgePrivateDom();
    updateSessionUi();
    sessionState.textContent = "Signed out. Reloading…";
    window.location.reload();
  }

  async function checkSession() {
    try {
      var payload = await apiRequest("/v2/session");
      state.authenticated = Boolean(payload.authenticated);
      state.user = payload.user || payload.session && payload.session.user || null;
      state.canReadArchive = Boolean(state.user && state.user.canReadArchive);
      state.canEdit = Boolean(state.user && state.user.canEdit);
    } catch (_) {
      state.authenticated = false;
      state.canReadArchive = false;
      state.canEdit = false;
      state.user = null;
    }
    state.sessionChecked = true;
    updateSessionUi();
  }

  function openLogin(requestedMode) {
    if (requestedMode) state.pendingMode = requestedMode;
    loginPanel.hidden = false;
    loginStatus.textContent = state.authenticated && !state.canReadArchive ? "This Discord account is signed in but is not a verified member of the UMP guild." : (requestedMode === "sources" ? "Continue with Discord to request the private source archive." : "");
    loginPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function setMode(mode) {
    if (mode === "sources" && !state.authenticated) {
      openLogin("sources");
      return;
    }
    state.mode = mode;
    Array.from(modebar.querySelectorAll("[data-wce-mode]")).forEach(function (button) {
      var active = button.dataset.wceMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    finalWorkspace.hidden = mode !== "final";
    sourceWorkspace.hidden = mode !== "sources";
    article.hidden = mode !== "draft";
    var editorialHero = mode !== "draft";
    if (heroTitleText) heroTitleText.textContent = editorialHero ? editorTitle : draftTitle;
    if (heroSubtitle) heroSubtitle.hidden = editorialHero;
    document.title = editorialHero ? editorTitle + " — Why Communism?" : draftDocumentTitle;
    if (mode === "final") loadFinal();
    if (mode === "sources") {
      if (state.canReadArchive) loadSources();
      else {
        sourceStatus.hidden = false;
        sourceStatus.textContent = "Source access requires a verified UMP guild membership.";
        sourceStream.innerHTML = '<div class="wce-unavailable"><strong>Verified guild membership required.</strong><p>No source records have been requested. Continue with the Discord account that belongs to the UMP guild.</p></div>';
      }
    }
  }

  function finalBodyFrom(payload) {
    var documentValue = payload.document || payload.final || payload.argument || payload;
    return String(documentValue.bodyMarkdown || documentValue.markdown || documentValue.content || documentValue.body || documentValue.html || "");
  }

  function normalizedFinal(payload) {
    var documentValue = payload.document || payload.final || payload.argument || payload;
    return {
      markdown: finalBodyFrom(payload),
      citations: Array.isArray(documentValue.citations) ? documentValue.citations : [],
      sha: String(payload.sha || documentValue.sha || ""),
      title: String(documentValue.title || editorTitle),
      updatedAt: documentValue.updatedAt || payload.updatedAt || "",
      updatedBy: documentValue.updatedBy || payload.updatedBy || ""
    };
  }

  function renderFinal() {
    var documentValue = state.finalDocument || { markdown: "" };
    var raw = documentValue.markdown;
    var citations = Array.isArray(documentValue.citations) ? documentValue.citations : [];
    var expanded = raw.replace(/\[\[([A-Za-z0-9._:-]+)\]\]/g, function (whole, id) {
      var index = citations.findIndex(function (citation) { return String(citation.id) === id; });
      if (index < 0) return whole;
      var citation = citations[index];
      var url = safeUrl(citation.url) || (state.canReadArchive && citation.sourceId ? "#source-" + citation.sourceId : "");
      return url ? "[" + (index + 1) + "](" + url + ")" : "[" + (index + 1) + "]";
    });
    finalRender.innerHTML = raw ? renderMarkdown(expanded) : '<div class="wce-unavailable"><strong>The final argument is not available yet.</strong><p>The current draft remains public in the third view.</p></div>';
    if (citations.length) {
      var references = document.createElement("section");
      references.className = "wce-final-references";
      references.innerHTML = "<h2>References</h2><ol>" + citations.map(function (citation) {
        var url = safeUrl(citation.url);
        var label = escapeHtml(citation.title || citation.label || citation.url || "Source");
        return "<li>" + (url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>" : label) + "</li>";
      }).join("") + "</ol>";
      finalRender.appendChild(references);
    }
    finalStatus.textContent = documentValue.updatedAt ? "Published " + timeLabel(documentValue.updatedAt) + (documentValue.updatedBy ? " · " + documentValue.updatedBy : "") : "";
    finalStatus.hidden = !finalStatus.textContent;
  }

  async function loadFinal(force) {
    if (state.finalLoaded && !force) return;
    finalStatus.hidden = false;
    finalStatus.textContent = "Loading the final argument…";
    try {
      var payload = await apiFirst([query("/v2/final"), query("/v2/argument")]);
      state.finalDocument = normalizedFinal(payload);
    } catch (error) {
      state.finalDocument = { markdown: "", citations: [], sha: "", title: editorTitle };
      finalStatus.textContent = error.message + " You can still read the current draft.";
    }
    state.finalLoaded = true;
    renderFinal();
  }

  function updateWordCount() {
    var words = String(wordPage.value || "").trim().split(/\s+/).filter(Boolean).length;
    finalCount.textContent = words.toLocaleString() + " words";
  }

  function beginFinalEdit() {
    if (!state.canEdit) { openLogin(); return; }
    state.finalEditing = true;
    finalRender.hidden = true;
    finalEditor.hidden = false;
    wordPage.value = state.finalDocument && state.finalDocument.markdown || "";
    state.finalDraftCitations = (state.finalDocument && state.finalDocument.citations || []).map(function (citation) { return Object.assign({}, citation); });
    finalNote.value = "";
    updateWordCount();
    wordPage.focus();
  }

  function endFinalEdit() {
    state.finalEditing = false;
    finalEditor.hidden = true;
    finalRender.hidden = false;
    citationPicker.hidden = true;
    state.finalDraftCitations = [];
  }

  function insertAround(before, after, placeholder) {
    wordPage.focus();
    var start = wordPage.selectionStart;
    var end = wordPage.selectionEnd;
    var selected = wordPage.value.slice(start, end) || placeholder || "";
    wordPage.setRangeText(before + selected + after, start, end, "select");
    if (!wordPage.value.slice(start, end)) wordPage.setSelectionRange(start + before.length, start + before.length + selected.length);
    updateWordCount();
  }

  function insertLinePrefix(prefix) {
    var start = wordPage.selectionStart;
    var end = wordPage.selectionEnd;
    var lineStart = wordPage.value.lastIndexOf("\n", start - 1) + 1;
    var selection = wordPage.value.slice(lineStart, end);
    wordPage.setRangeText(selection.split("\n").map(function (line, index) {
      return typeof prefix === "function" ? prefix(index, line) : prefix + line;
    }).join("\n"), lineStart, end, "select");
    wordPage.focus();
    updateWordCount();
  }

  function setBlockPrefix(prefix) {
    var start = wordPage.selectionStart;
    var end = wordPage.selectionEnd;
    var lineStart = wordPage.value.lastIndexOf("\n", start - 1) + 1;
    var selection = wordPage.value.slice(lineStart, end);
    wordPage.setRangeText(selection.split("\n").map(function (line) {
      return prefix + line.replace(/^(?:#{1,3}|>)\s+/, "");
    }).join("\n"), lineStart, end, "select");
    wordPage.focus();
    updateWordCount();
  }

  function toolbarCommand(button) {
    var command = button.dataset.command;
    var block = button.dataset.block;
    if (command === "bold") insertAround("**", "**", "bold text");
    if (command === "italic") insertAround("*", "*", "italic text");
    if (command === "insertUnorderedList") insertLinePrefix("- ");
    if (command === "insertOrderedList") insertLinePrefix(function (index, line) { return (index + 1) + ". " + line; });
    if (command === "underline") insertAround("__", "__", "underlined text");
    if (command === "strike") insertAround("~~", "~~", "struck text");
    if (command === "code") insertAround("`", "`", "code");
    if (command === "codeblock") insertAround("\n```\n", "\n```\n", "code");
    if (command === "hr") { wordPage.setRangeText("\n\n---\n\n", wordPage.selectionStart, wordPage.selectionEnd, "end"); wordPage.focus(); updateWordCount(); }
    if (block === "p") setBlockPrefix("");
    if (block === "h2") setBlockPrefix("## ");
    if (block === "h3") setBlockPrefix("### ");
    if (block === "blockquote") setBlockPrefix("> ");
  }

  async function saveFinal(checkpointOnly) {
    if (!state.canEdit) { openLogin(); return; }
    if (!state.finalDocument) await loadFinal(true);
    if (!state.finalDocument) state.finalDocument = { markdown: "", citations: [], sha: "", title: editorTitle };
    var endpoint = checkpointOnly ? query("/v2/final/checkpoint") : query("/v2/final");
    finalStatus.hidden = false;
    finalStatus.textContent = checkpointOnly ? "Saving checkpoint…" : "Publishing argument…";
    try {
      var body = {
        title: editorTitle,
        bodyMarkdown: state.finalEditing ? wordPage.value : state.finalDocument.markdown,
        citations: state.finalEditing ? state.finalDraftCitations : state.finalDocument.citations || [],
        note: finalNote.value.trim() || (checkpointOnly ? "Manual checkpoint" : "Updated final argument"),
        baseSha: state.finalDocument.sha
      };
      var payload = await apiRequest(endpoint, { method: checkpointOnly ? "POST" : "PUT", body: JSON.stringify(body) });
      state.finalDocument = normalizedFinal(Object.assign({}, body, payload));
      state.finalDocument.markdown = finalBodyFrom(payload) || body.bodyMarkdown;
      state.finalLoaded = true;
      renderFinal();
      endFinalEdit();
      finalStatus.hidden = false;
      finalStatus.textContent = checkpointOnly ? "Checkpoint saved." : "Final argument saved.";
      if (!historyPanel.hidden) loadFinalHistory();
    } catch (error) {
      finalStatus.textContent = error.message;
    }
  }

  function sourceId(message, index) {
    return String(message.id || message.messageId || message.sourceId || "source-" + index);
  }

  function sourceChannel(message) {
    return String(message.channelName || message.channel && (message.channel.name || message.channel.label) || message.channel || "unknown-channel").replace(/^#/, "");
  }

  function sourceThread(message) {
    return String(message.threadName || message.thread && (message.thread.name || message.thread.label) || message.thread || message.channel && typeof message.channel === "object" && (message.channel.threadName || message.channel.thread) || "");
  }

  function sourceParent(message) {
    return String(message.channel && typeof message.channel === "object" && (message.channel.parent || message.channel.parentName) || message.parentChannel || "");
  }

  function sourceAuthor(message) {
    var author = message.author || message.user || {};
    return String(typeof author === "string" ? author : author.displayName || author.globalName || author.username || author.name || "Unknown author");
  }

  function sourceAuthorId(message) {
    var author = message.author || message.user || {};
    return String(typeof author === "object" ? author.discordId || author.id || message.authorId || "" : message.authorId || "");
  }

  function isWebsiteContribution(message) {
    return sourceId(message, state.sources.indexOf(message)).indexOf("manual:") === 0 &&
      String(message.source && message.source.kind || message.sourceKind || "") === "whycommunism-member-contribution" &&
      String(message.messageType || "") === "website-contribution";
  }

  function isOwnSourceMessage(message) {
    return Boolean(
      state.user &&
      state.user.provider === "discord" &&
      state.user.discordId &&
      isWebsiteContribution(message) &&
      String(state.user.discordId) === sourceAuthorId(message)
    );
  }

  function canEditSourceMessage(message) {
    return Boolean(state.canEdit && isOwnSourceMessage(message));
  }

  function canViewSourceHistory(message) {
    return Boolean(
      isWebsiteContribution(message) &&
      state.user &&
      (state.user.admin || isOwnSourceMessage(message))
    );
  }

  function sourceTimestamp(message) {
    return message.timestamp || message.createdAt || message.date || "";
  }

  function sourceContent(message) {
    var content = message.content || message.body || message.text || "";
    if (content && typeof content === "object") return String(content.markdown || content.text || content.html || "");
    return String(content);
  }

  function sourceContentHtml(message) {
    var content = message.content;
    if (content && typeof content === "object") {
      var plain = String(content.markdown || content.text || "");
      if (plain.trim()) return renderMarkdown(plain, true);
      if (content.html) {
        var probe = document.createElement("template");
        probe.innerHTML = String(content.html);
        var flatText = probe.content.textContent || "";
        var alreadyRich = probe.content.querySelector("strong,em,u,s,blockquote,ul,ol,h2,h3,h4,pre,code");
        var looksRaw = /(^|\n)\s*(?:>|#{1,3}\s|[-*+]\s|\d+[.)]\s)|\*\*|__|~~|\|\|/.test(flatText);
        if (!alreadyRich && looksRaw) return renderMarkdown(flatText, true);
        return sanitizeRichHtml(content.html, true);
      }
      return "";
    }
    return renderMarkdown(sourceContent(message), true);
  }

  function sourceLink(message) {
    var direct = safeUrl(message.sourceUrl || message.jumpUrl || message.url || message.permalink);
    if (direct) return direct;
    var guild = message.guildId || message.serverId || message.guild && message.guild.id;
    var channel = message.channelId || message.channel && message.channel.id;
    var id = message.messageId || "";
    if (/^\d+$/.test(String(guild || "")) && /^\d+$/.test(String(channel || "")) && /^\d+$/.test(String(id || ""))) {
      return "https://discord.com/channels/" + encodeURIComponent(guild) + "/" + encodeURIComponent(channel) + "/" + encodeURIComponent(id);
    }
    if (message.source && message.source.driveId) {
      return "https://drive.google.com/open?id=" + encodeURIComponent(message.source.driveId) + (message.source.anchor ? "#" + encodeURIComponent(message.source.anchor) : "");
    }
    return "";
  }

  function sourceMeta(message) {
    var index = state.sources.indexOf(message);
    var classification = state.assignments[sourceId(message, index)] || message.classification || message.editorial || {};
    var confidence = classification.confidence || message.confidence || {};
    return {
      primaryTopic: classification.primaryTopic == null ? "" : String(classification.primaryTopic),
      secondaryTopics: Array.isArray(classification.secondaryTopics) ? classification.secondaryTopics : [],
      type: classification.primaryTopic ? "primary" : (classification.secondaryTopics && classification.secondaryTopics.length ? "secondary" : "unclassified"),
      confidence: String(typeof confidence === "string" ? confidence : confidence.label || "medium").toLowerCase(),
      confidenceScore: Number(typeof confidence === "object" ? confidence.score : 0.5),
      status: String(classification.reviewStatus || classification.status || message.status || "unreviewed").toLowerCase(),
      reviewed: Boolean(classification.reviewed || message.reviewed || !["", "unreviewed", "pending"].includes(String(classification.reviewStatus || classification.status || "").toLowerCase())),
      relevance: String(classification.relevance || message.relevance || "medium").toLowerCase(),
      note: String(classification.note || message.reviewNote || message.note || "")
    };
  }

  function sourceAttachments(message) {
    var values = [];
    [message.attachments, message.media, message.images, message.videos, message.documents].forEach(function (collection) {
      if (Array.isArray(collection)) values = values.concat(collection);
    });
    return values;
  }

  function normalizeSources(payload) {
    var values = payload.records || payload.sources || payload.messages || payload.archive && payload.archive.messages || payload.items || [];
    state.assignments = payload.assignments && typeof payload.assignments === "object" ? payload.assignments : {};
    state.archiveSha = String(payload.sha || payload.archive && payload.archive.sha || "");
    return (Array.isArray(values) ? values : []).slice().sort(function (a, b) {
      return new Date(sourceTimestamp(a) || 0).getTime() - new Date(sourceTimestamp(b) || 0).getTime();
    });
  }

  async function loadSources(force) {
    if (!state.canReadArchive) { openLogin("sources"); return; }
    if (state.sourcesLoaded && !force) { renderSources(); return; }
    sourceStatus.hidden = false;
    sourceStatus.textContent = "Loading the private source archive…";
    try {
      var payload = await apiRequest(query("/v2/topic") + "&limit=1000");
      var records = payload.records || payload.sources || payload.messages || payload.archive && payload.archive.messages || payload.items || [];
      if (!Array.isArray(records)) records = [];
      var assignments = Object.assign({}, payload.assignments || {});
      var nextCursor = payload.nextCursor;
      var pageCount = 1;
      while (payload.hasMore && nextCursor && pageCount < 50) {
        sourceStatus.textContent = "Loading the private source archive… " +
          (Array.isArray(records) ? records.length.toLocaleString() : "0") +
          (payload.total ? " of " + Number(payload.total).toLocaleString() : "");
        payload = await apiRequest(query("/v2/topic") + "&limit=1000&cursor=" + encodeURIComponent(nextCursor));
        records = records.concat(payload.records || payload.sources || payload.messages || payload.items || []);
        Object.assign(assignments, payload.assignments || {});
        nextCursor = payload.nextCursor;
        pageCount += 1;
      }
      state.assignments = assignments;
      state.archiveSha = String(payload.sha || payload.archive && payload.archive.sha || "");
      state.sources = records.slice().sort(function (a, b) {
        return new Date(sourceTimestamp(a) || 0).getTime() - new Date(sourceTimestamp(b) || 0).getTime();
      });
      state.sourcesLoaded = true;
      populateFilters();
      renderSources();
      sourceStatus.hidden = true;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        state.authenticated = false;
        state.canReadArchive = false;
        state.canEdit = false;
        state.sourceFiles = [];
        state.sourceReplyTo = "";
        sourceComposerText.value = "";
        sourceComposerFileInput.value = "";
        updateSourceComposer();
        updateSessionUi();
        setMode("final");
        openLogin("sources");
        loginStatus.textContent = "Your session expired. Sign in again to read the source archive.";
      } else {
        sourceStatus.textContent = error.message;
        sourceStream.innerHTML = '<div class="wce-unavailable"><strong>The source archive could not be loaded.</strong><p>No canonical records were exposed.</p></div>';
      }
    }
  }

  function populateFilters() {
    [["channel", sourceChannel], ["author", sourceAuthor]].forEach(function (definition) {
      var select = sourceFilters.querySelector('[data-filter="' + definition[0] + '"]');
      var current = select.value;
      var labels = Array.from(new Set(state.sources.map(definition[1]).filter(Boolean))).sort(function (a, b) { return a.localeCompare(b); });
      while (select.options.length > 1) select.remove(1);
      labels.forEach(function (label) { select.add(new Option((definition[0] === "channel" ? "# " : "") + label, label)); });
      select.value = current;
    });
  }

  function filterValue(name) {
    return sourceFilters.querySelector('[data-filter="' + name + '"]').value;
  }

  function filteredSources() {
    var channel = filterValue("channel");
    var author = filterValue("author");
    var from = filterValue("from");
    var to = filterValue("to");
    var review = filterValue("review");
    var relevance = filterValue("relevance");
    var queryValue = filterValue("query").toLowerCase().trim();
    return state.sources.filter(function (message) {
      var meta = sourceMeta(message);
      var timestamp = String(sourceTimestamp(message) || "").slice(0, 10);
      if (channel && sourceChannel(message) !== channel) return false;
      if (author && sourceAuthor(message) !== author) return false;
      if (from && timestamp && timestamp < from) return false;
      if (to && timestamp && timestamp > to) return false;
      if (review === "reviewed" && !meta.reviewed) return false;
      if (review === "unreviewed" && meta.reviewed) return false;
      if (relevance && meta.relevance !== relevance) return false;
      if (queryValue && (sourceContent(message) + " " + meta.note + " " + sourceAuthor(message)).toLowerCase().indexOf(queryValue) === -1) return false;
      return true;
    });
  }

  function renderAttachment(item) {
    var attachment = typeof item === "string" ? { url: item } : item || {};
    var archivePath = String(attachment.archivePath || "");
    var privateUrl = archivedAttachmentUrl(archivePath);
    var url = safeUrl(privateUrl || attachment.sourceUrl || attachment.url || attachment.proxyUrl || attachment.src || attachment.href || attachment.video && (attachment.video.sourceUrl || attachment.video.url) || attachment.image && (attachment.image.sourceUrl || attachment.image.url) || attachment.thumbnail && (attachment.thumbnail.sourceUrl || attachment.thumbnail.url));
    var name = String(attachment.filename || attachment.name || attachment.title || (url ? url.split("/").pop() : archivePath.split("/").pop()) || "Attachment");
    var type = String(attachment.contentType || attachment.type || attachment.kind || "");
    var archiveLabel = archivePath ? '<small title="' + escapeHtml(archivePath) + '">Archived copy recorded</small>' : "";
    if (!url) return archivePath ? '<div class="wce-source-file is-unavailable"><span aria-hidden="true">▧</span><strong>' + escapeHtml(name) + '</strong><i>Archived file unavailable here</i>' + archiveLabel + "</div>" : "";
    var normalizedType = type.toLowerCase();
    var image = normalizedType === "image" || normalizedType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(url);
    var video = normalizedType === "video" || normalizedType.startsWith("video/") || /\.(mp4|webm|ogg|mov)(?:[?#]|$)/i.test(url);
    if ((image || video) && !mayAutoLoadPrivateMedia(url)) return externalMediaCard(url, name, video ? "video" : "image", archiveLabel);
    if (image) return '<a class="wce-source-media" href="' + escapeHtml(url) + '"' + noReferrerLinkAttributes() + '><img src="' + escapeHtml(url) + '" alt="' + escapeHtml(attachment.alt || name) + '" loading="lazy" referrerpolicy="no-referrer"><span>' + escapeHtml(name) + archiveLabel + "</span></a>";
    if (video) return '<figure class="wce-source-media"><video src="' + escapeHtml(url) + '" controls preload="metadata" referrerpolicy="no-referrer"></video><figcaption><a href="' + escapeHtml(url) + '"' + noReferrerLinkAttributes() + ">" + escapeHtml(name) + "</a>" + archiveLabel + "</figcaption></figure>";
    if (youtubeId(url)) return standaloneEmbed(url, true);
    return '<a class="wce-source-file" href="' + escapeHtml(url) + '"' + noReferrerLinkAttributes() + '><span aria-hidden="true">▧</span><strong>' + escapeHtml(name) + '</strong><i>' + escapeHtml(type || "Document / link") + " ↗</i>" + archiveLabel + "</a>";
  }

  function renderRichEmbed(embed) {
    if (!embed || typeof embed !== "object") return "";
    var url = safeUrl(embed.url || embed.href);
    var providerUrl = safeUrl(embed.providerUrl);
    var authorUrl = safeUrl(embed.authorUrl);
    var provider = String(embed.provider && (embed.provider.name || embed.provider) || "");
    var author = String(embed.author && (embed.author.name || embed.author) || "");
    var title = String(embed.title || "");
    var description = String(embed.description || "");
    var fields = Array.isArray(embed.fields) ? embed.fields : [];
    var media = Array.isArray(embed.media) ? embed.media : [];
    var videoUrl = safeUrl(embed.videoUrl || embed.video && (embed.video.sourceUrl || embed.video.url));
    var colour = /^#[0-9a-f]{3,8}$/i.test(String(embed.color || "")) ? String(embed.color) : "";
    var heading = title
      ? (url ? '<a class="wce-discord-embed-title" href="' + escapeHtml(url) + '"' + noReferrerLinkAttributes() + ">" + escapeHtml(title) + "</a>" : '<strong class="wce-discord-embed-title">' + escapeHtml(title) + "</strong>")
      : "";
    var providerMarkup = provider ? (providerUrl ? '<a href="' + escapeHtml(providerUrl) + '"' + noReferrerLinkAttributes() + ">" + escapeHtml(provider) + "</a>" : escapeHtml(provider)) : "";
    var authorMarkup = author ? (authorUrl ? '<a href="' + escapeHtml(authorUrl) + '"' + noReferrerLinkAttributes() + ">" + escapeHtml(author) + "</a>" : escapeHtml(author)) : "";
    var fieldMarkup = fields.map(function (field) {
      var fieldName = String(field.name || field.title || "");
      var fieldValue = String(field.value || field.text || "");
      return '<div class="wce-discord-embed-field"><strong>' + escapeHtml(fieldName) + '</strong><div>' + renderMarkdown(fieldValue, true) + "</div></div>";
    }).join("");
    var mediaMarkup = media.slice(0, 1).map(function (item) { return renderAttachment(item); }).join("");
    if (!mediaMarkup && videoUrl && !youtubeId(videoUrl)) mediaMarkup = renderAttachment({ sourceUrl: videoUrl, name: title || "Embedded video", contentType: "video" });
    if (!providerMarkup && !authorMarkup && !heading && !description && !fieldMarkup && !mediaMarkup) return url ? standaloneEmbed(url, true) : "";
    return '<section class="wce-discord-embed"' + (colour ? ' style="--embed-colour:' + escapeHtml(colour) + '"' : "") + ">" +
      (providerMarkup ? '<div class="wce-discord-embed-provider">' + providerMarkup + "</div>" : "") +
      (authorMarkup ? '<div class="wce-discord-embed-author">' + authorMarkup + "</div>" : "") +
      heading +
      (description ? '<div class="wce-discord-embed-description">' + renderMarkdown(description, true) + "</div>" : "") +
      (fieldMarkup ? '<div class="wce-discord-embed-fields">' + fieldMarkup + "</div>" : "") +
      mediaMarkup +
      (embed.footer ? '<small class="wce-discord-embed-footer">' + escapeHtml(embed.footer.text || embed.footer) + "</small>" : "") +
    "</section>";
  }

  function renderRichEmbeds(message) {
    return (Array.isArray(message.embeds) ? message.embeds : []).map(renderRichEmbed).join("");
  }

  function renderReactions(message) {
    if (!Array.isArray(message.reactions) || !message.reactions.length) return "";
    return '<div class="wce-reactions" aria-label="Reactions">' + message.reactions.map(function (reaction) {
      var emojiObject = typeof reaction === "object" && reaction.emoji && typeof reaction.emoji === "object" ? reaction.emoji : {};
      var emoji = typeof reaction === "string" ? reaction : emojiObject.name || reaction.emoji || reaction.name || "•";
      var count = typeof reaction === "object" ? reaction.count || reaction.total || "" : "";
      var imageObject = typeof reaction === "object" && (reaction.image || emojiObject.image || emojiObject) || {};
      var privateUrl = archivedAttachmentUrl(imageObject.archivePath);
      var image = safeUrl(privateUrl || (typeof imageObject === "string" ? imageObject : imageObject.sourceUrl || imageObject.url || imageObject.imageUrl || imageObject.animatedUrl));
      var customName = String(emoji).match(/^<a?:([^:]+):\d+>$/);
      var label = customName ? customName[1] : String(emoji);
      var imageMarkup = "";
      if (image && mayAutoLoadPrivateMedia(image)) {
        imageMarkup = '<img src="' + escapeHtml(image) + '" alt="' + escapeHtml(label) + '" loading="lazy" referrerpolicy="no-referrer">';
      } else if (image) {
        imageMarkup = '<a class="wce-external-emoji" href="' + escapeHtml(image) + '"' + noReferrerLinkAttributes() + ' aria-label="Open external custom emoji ' + escapeHtml(label) + '">:' + escapeHtml(label) + ":</a>";
      } else {
        imageMarkup = escapeHtml(emoji);
      }
      return "<span>" + imageMarkup + (count ? " " + escapeHtml(count) : "") + "</span>";
    }).join("") + "</div>";
  }

  function renderPoll(message) {
    var poll = message.poll;
    if (!poll) return "";
    var question = poll.question && (poll.question.text || poll.question) || poll.title || "Poll";
    var answers = poll.answers || poll.options || [];
    return '<section class="wce-poll"><strong>' + escapeHtml(question) + "</strong>" + answers.map(function (answer) {
      var text = answer.text || answer.pollMedia && answer.pollMedia.text || answer.label || answer;
      var votes = answer.votes || answer.voteCount || "";
      return '<div><span>' + escapeHtml(text) + '</span><i>' + (votes === "" ? "" : escapeHtml(votes) + " votes") + "</i></div>";
    }).join("") + "</section>";
  }

  function renderEditHistory(message) {
    var edits = message.edits || message.editHistory || message.revisions || [];
    if (!Array.isArray(edits) || !edits.length) {
      return message.editedAt
        ? '<span class="wce-source-edited" title="Edited ' + escapeHtml(timeLabel(message.editedAt)) + '">edited</span>'
        : "";
    }
    return '<details class="wce-source-edits"><summary>' + edits.length + (edits.length === 1 ? " edit" : " edits") + '</summary><ol>' + edits.map(function (edit) {
      return "<li><strong>" + escapeHtml(edit.editorName || edit.editedBy || edit.author || "Unknown editor") + "</strong><span>" + escapeHtml(timeLabel(edit.editedAt || edit.timestamp || edit.date)) + "</span>" + (edit.note ? "<p>" + escapeHtml(edit.note) + "</p>" : "") + "</li>";
    }).join("") + "</ol></details>";
  }

  function sourceMessageEditor(message, index) {
    if (!canEditSourceMessage(message)) return "";
    var id = sourceId(message, index);
    var version = Number(message.currentRevision && message.currentRevision.version || message.revisionCount || 0);
    return '<form class="wce-source-inline-editor" data-source-message-editor="' + escapeHtml(id) + '" data-base-version="' + version + '" hidden>' +
      '<label>Edit your message<textarea rows="5" maxlength="100000" spellcheck="true">' + escapeHtml(sourceContent(message)) + '</textarea></label>' +
      '<label class="wce-source-edit-note">Revision note <span>optional</span><input type="text" maxlength="160" placeholder="What changed?"></label>' +
      '<footer><span role="status" aria-live="polite"></span><button type="button" data-cancel-source-edit="' + escapeHtml(id) + '">Cancel</button><button class="wce-primary" type="submit">Save edit</button></footer>' +
    "</form>";
  }

  function sourceMessageHistory(message, index) {
    if (!canViewSourceHistory(message)) return "";
    return '<section class="wce-source-message-history" data-source-message-history="' + escapeHtml(sourceId(message, index)) + '" hidden><p role="status">Loading version history…</p><div></div></section>';
  }

  function renderClassificationChips(meta) {
    var chips = [];
    function topicChip(kind, chipName, topic) {
      var label = escapeHtml(kind + " · " + topic);
      if (/^\//.test(topic)) return '<a data-chip="' + chipName + '" href="' + escapeHtml(topic) + '">' + label + "</a>";
      return '<span data-chip="' + chipName + '">' + label + "</span>";
    }
    chips.push(meta.primaryTopic ? topicChip("primary", "type", meta.primaryTopic) : '<span data-chip="type">primary · none</span>');
    meta.secondaryTopics.forEach(function (topic) { chips.push(topicChip("secondary", "secondary", topic)); });
    chips.push('<span data-chip="confidence">' + escapeHtml(meta.confidence) + " confidence</span>");
    chips.push('<span data-chip="relevance">' + escapeHtml(meta.relevance) + " relevance</span>");
    chips.push('<span data-chip="status">' + escapeHtml(meta.status) + "</span>");
    if (meta.reviewed) chips.push('<span data-chip="reviewed">reviewed</span>');
    return chips.join("");
  }

  function sourceCitation(message) {
    var excerpt = sourceContent(message).replace(/\s+/g, " ").trim();
    if (excerpt.length > 120) excerpt = excerpt.slice(0, 119) + "…";
    return sourceAuthor(message) + ', “' + excerpt + ',” #' + sourceChannel(message) + ", " + timeLabel(sourceTimestamp(message), true) + (sourceLink(message) ? ", " + sourceLink(message) : "");
  }

  function classificationEditor(message, index) {
    var meta = sourceMeta(message);
    var id = sourceId(message, index);
    return '<details class="wce-classification-editor" data-source-editor="' + escapeHtml(id) + '"><summary>Edit review metadata</summary><div class="wce-classification-grid">' +
      '<label>Primary topic<input type="text" data-meta="primaryTopic" value="' + escapeHtml(meta.primaryTopic) + '" placeholder="Topic or blank"></label>' +
      '<label>Secondary topics<input type="text" data-meta="secondaryTopics" value="' + escapeHtml(meta.secondaryTopics.join(", ")) + '" placeholder="Comma-separated topics"></label>' +
      '<label>Confidence<select data-meta="confidence"><option value="manual"' + (meta.confidence === "manual" ? " selected" : "") + '>Manual</option><option value="high"' + (meta.confidence === "high" ? " selected" : "") + '>High</option><option value="medium"' + (meta.confidence === "medium" ? " selected" : "") + '>Medium</option><option value="low"' + (meta.confidence === "low" ? " selected" : "") + '>Low</option></select></label>' +
      '<label>Relevance<select data-meta="relevance"><option value="high"' + (meta.relevance === "high" ? " selected" : "") + '>High</option><option value="medium"' + (meta.relevance === "medium" ? " selected" : "") + '>Medium</option><option value="low"' + (meta.relevance === "low" ? " selected" : "") + '>Low</option></select></label>' +
      '<label>Status<select data-meta="status"><option value="unreviewed"' + (meta.status === "unreviewed" ? " selected" : "") + '>Unreviewed</option><option value="verified"' + (meta.status === "verified" ? " selected" : "") + '>Verified</option><option value="disputed"' + (meta.status === "disputed" ? " selected" : "") + '>Disputed</option><option value="excluded"' + (meta.status === "excluded" ? " selected" : "") + '>Excluded</option></select></label>' +
      '<label class="wce-source-note">Editorial note<textarea data-meta="note" rows="3">' + escapeHtml(meta.note) + '</textarea></label>' +
      '</div><footer><span role="status"></span><button class="wce-primary" type="button" data-save-source="' + escapeHtml(id) + '">Save metadata</button></footer></details>';
  }

  function createSourceCard(message, index) {
    var id = sourceId(message, index);
    var meta = sourceMeta(message);
    var card = document.createElement("article");
    card.className = "wce-source-message";
    card.id = "source-" + id;
    card.dataset.sourceId = id;
    var channel = sourceChannel(message);
    var thread = sourceThread(message);
    var parentChannel = sourceParent(message);
    var link = sourceLink(message);
    var authorObject = message.author && typeof message.author === "object" ? message.author : {};
    var avatarValue = authorObject.avatar;
    var renderedAvatar = avatarMarkup(avatarValue, sourceAuthor(message), authorObject.avatarUrl || authorObject.avatarURL);
    var replyReference = message.replyTo || message.reference || "";
    var parentId = String(typeof replyReference === "object" ? replyReference.recordId || replyReference.id || replyReference.messageId || "" : replyReference);
    var parentMessageId = String(typeof replyReference === "object" ? replyReference.messageId || "" : replyReference);
    var parent = (parentId || parentMessageId) && state.sources.find(function (candidate, candidateIndex) {
      return sourceId(candidate, candidateIndex) === parentId || String(candidate.messageId || "") === parentMessageId;
    });
    card.innerHTML =
      '<div class="wce-source-avatar"' + (renderedAvatar.interactive ? "" : ' aria-hidden="true"') + ">" + renderedAvatar.html + "</div>" +
      '<div class="wce-source-main">' +
        '<div class="wce-origin-badge">' + (parentChannel ? "<i>" + escapeHtml(parentChannel) + "</i><b aria-hidden=\"true\">›</b>" : "") + '<span># ' + escapeHtml(channel) + "</span>" + (thread ? "<i>thread</i><span>" + escapeHtml(thread) + "</span>" : "") + (message.channel && message.channel.part ? "<i>part " + escapeHtml(message.channel.part) + "</i>" : "") + "</div>" +
        (parent ? '<button type="button" class="wce-source-reply" data-jump-source="' + escapeHtml(sourceId(parent, state.sources.indexOf(parent))) + '">↳ <strong>' + escapeHtml(sourceAuthor(parent)) + "</strong> " + escapeHtml(sourceContent(parent).replace(/\s+/g, " ").slice(0, 120)) + "</button>" : "") +
        '<header><strong>' + escapeHtml(sourceAuthor(message)) + '</strong><time datetime="' + escapeHtml(sourceTimestamp(message)) + '">' + escapeHtml(timeLabel(sourceTimestamp(message))) + "</time>" + renderEditHistory(message) + "</header>" +
        '<div class="wce-source-body">' + sourceContentHtml(message) + "</div>" +
        sourceAttachments(message).map(renderAttachment).join("") +
        renderRichEmbeds(message) +
        renderPoll(message) + renderReactions(message) +
        '<div class="wce-source-chips">' + renderClassificationChips(meta) + "</div>" +
        (meta.note ? '<p class="wce-editorial-note"><strong>Editorial note</strong>' + escapeHtml(meta.note) + "</p>" : "") +
        '<footer class="wce-source-actions">' + (link ? '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">Exact source ↗</a>' : '<span>' + (isWebsiteContribution(message) ? "Website contribution" : "Exact source link unavailable") + '</span>') + '<button type="button" data-cite-source="' + escapeHtml(id) + '">Copy citation</button>' + (state.canEdit ? '<button type="button" data-reply-source="' + escapeHtml(id) + '">Reply</button>' : "") + (canEditSourceMessage(message) ? '<button type="button" data-edit-source-message="' + escapeHtml(id) + '">Edit</button>' : "") + (canViewSourceHistory(message) ? '<button type="button" data-source-message-history-open="' + escapeHtml(id) + '">History</button>' : "") + "</footer>" +
        sourceMessageEditor(message, index) +
        sourceMessageHistory(message, index) +
        (state.user && state.user.admin ? classificationEditor(message, index) : "") +
      "</div>";
    return card;
  }

  function sourceFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function sourceFileBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.addEventListener("load", function () {
        var value = String(reader.result || "");
        resolve(value.slice(value.indexOf(",") + 1));
      });
      reader.addEventListener("error", function () { reject(new Error("The file “" + file.name + "” could not be read.")); });
      reader.readAsDataURL(file);
    });
  }

  function renderSourcePendingFiles() {
    sourceComposerPendingFiles.hidden = !state.sourceFiles.length;
    sourceComposerPendingFiles.innerHTML = state.sourceFiles.map(function (file, index) {
      return '<div><span aria-hidden="true">' + (String(file.type || "").startsWith("image/") ? "▧" : "▤") + '</span><strong>' + escapeHtml(file.name) + '</strong><i>' + escapeHtml(sourceFileSize(file.size)) + '</i><button type="button" data-remove-source-file="' + index + '" aria-label="Remove ' + escapeHtml(file.name) + '">×</button></div>';
    }).join("");
  }

  function addSourceFiles(fileList) {
    var incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    var allowed = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|docx?|odt|xlsx?|pptx?)$/i;
    var next = state.sourceFiles.slice();
    for (var index = 0; index < incoming.length; index += 1) {
      var file = incoming[index];
      if (!allowed.test(file.name)) {
        sourceComposerStatus.textContent = "“" + file.name + "” is not a supported image or document.";
        continue;
      }
      if (next.length >= 4) {
        sourceComposerStatus.textContent = "A message can include up to four files.";
        break;
      }
      if (next.reduce(function (total, item) { return total + item.size; }, 0) + file.size > 8 * 1024 * 1024) {
        sourceComposerStatus.textContent = "Files in one message must total 8 MB or less.";
        continue;
      }
      next.push(file);
    }
    state.sourceFiles = next;
    sourceComposerFileInput.value = "";
    renderSourcePendingFiles();
    updateSourceComposer();
  }

  function updateSourceComposer() {
    var parent = state.sourceReplyTo && state.sources.find(function (candidate, index) {
      return sourceId(candidate, index) === state.sourceReplyTo;
    });
    sourceComposerReply.hidden = !parent;
    if (parent) {
      sourceComposerReply.querySelector("strong").textContent = sourceAuthor(parent);
      sourceComposerReply.querySelector("i").textContent = sourceContent(parent).replace(/\s+/g, " ").slice(0, 150);
    } else {
      sourceComposerReply.querySelector("strong").textContent = "";
      sourceComposerReply.querySelector("i").textContent = "";
      state.sourceReplyTo = "";
    }
    var words = sourceComposerText.value.trim().match(/\S+/g);
    var fileLabel = state.sourceFiles.length ? " · " + state.sourceFiles.length + (state.sourceFiles.length === 1 ? " file" : " files") : "";
    sourceComposerCount.textContent = (words ? words.length : 0).toLocaleString() + " words" + fileLabel;
    renderSourcePendingFiles();
  }

  function beginSourceReply(id) {
    state.sourceReplyTo = id;
    updateSourceComposer();
    sourceComposer.scrollIntoView({ behavior: "smooth", block: "end" });
    setTimeout(function () { sourceComposerText.focus(); }, 250);
  }

  function clearSourceReply() {
    state.sourceReplyTo = "";
    updateSourceComposer();
    sourceComposerText.focus();
  }

  async function postSourceMessage() {
    if (state.sourceSending || !state.canEdit) return;
    var content = sourceComposerText.value;
    if (!content.trim() && !state.sourceFiles.length) {
      sourceComposerStatus.textContent = "Write a message or add a file first.";
      sourceComposerText.focus();
      return;
    }
    state.sourceSending = true;
    sourceComposer.querySelector('[type="submit"]').disabled = true;
    sourceComposerFileInput.disabled = true;
    sourceComposerStatus.textContent = state.sourceFiles.length ? "Preparing files…" : "Sending…";
    try {
      var attachments = [];
      for (var fileIndex = 0; fileIndex < state.sourceFiles.length; fileIndex += 1) {
        var file = state.sourceFiles[fileIndex];
        attachments.push({
          filename: file.name,
          contentType: file.type || "",
          base64: await sourceFileBase64(file)
        });
      }
      sourceComposerStatus.textContent = "Sending…";
      var payload = await apiRequest(query("/v2/topic/message"), {
        method: "POST",
        timeoutMs: 120000,
        body: JSON.stringify({ content: content, replyTo: state.sourceReplyTo || null, attachments: attachments })
      });
      var record = payload.record;
      if (!record || !sourceId(record, state.sources.length)) throw new Error("The server did not return the new source message.");
      state.sources.push(record);
      state.sources.sort(function (a, b) {
        return new Date(sourceTimestamp(a) || 0).getTime() - new Date(sourceTimestamp(b) || 0).getTime();
      });
      if (payload.assignment) state.assignments[sourceId(record, state.sources.indexOf(record))] = payload.assignment;
      state.archiveSha = String(payload.classificationsSha || state.archiveSha);
      sourceComposerText.value = "";
      state.sourceReplyTo = "";
      state.sourceFiles = [];
      sourceComposerFileInput.value = "";
      sourceFilters.reset();
      state.groupByChannel = false;
      sourceFilters.querySelector('[data-wce-action="group-channel"]').checked = false;
      updateSourceComposer();
      populateFilters();
      renderSources();
      var newId = sourceId(record, state.sources.indexOf(record));
      var newCard = document.getElementById("source-" + newId);
      if (newCard) {
        newCard.classList.add("is-new");
        newCard.scrollIntoView({ behavior: "smooth", block: "end" });
        setTimeout(function () { newCard.classList.remove("is-new"); }, 2400);
      }
      sourceComposerStatus.textContent = "Sent as " + sourceAuthor(record) + ".";
    } catch (error) {
      sourceComposerStatus.textContent = error.message;
    } finally {
      state.sourceSending = false;
      sourceComposer.querySelector('[type="submit"]').disabled = false;
      sourceComposerFileInput.disabled = false;
    }
  }

  function beginSourceEdit(id) {
    if (state.sourceEditingId && state.sourceEditingId !== id) {
      var previous = sourceStream.querySelector('[data-source-message-editor="' + CSS.escape(state.sourceEditingId) + '"]');
      if (previous) previous.hidden = true;
    }
    var editor = sourceStream.querySelector('[data-source-message-editor="' + CSS.escape(id) + '"]');
    if (!editor) return;
    state.sourceEditingId = id;
    editor.hidden = false;
    var textarea = editor.querySelector("textarea");
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  }

  function cancelSourceEdit(id) {
    var editor = sourceStream.querySelector('[data-source-message-editor="' + CSS.escape(id) + '"]');
    var message = state.sources.find(function (candidate, index) { return sourceId(candidate, index) === id; });
    if (!editor) return;
    if (message) editor.querySelector("textarea").value = sourceContent(message);
    editor.querySelector('input[type="text"]').value = "";
    editor.querySelector('[role="status"]').textContent = "";
    editor.hidden = true;
    if (state.sourceEditingId === id) state.sourceEditingId = "";
  }

  async function saveSourceEdit(editor) {
    var id = editor.dataset.sourceMessageEditor;
    var messageIndex = state.sources.findIndex(function (candidate, index) { return sourceId(candidate, index) === id; });
    var message = messageIndex >= 0 ? state.sources[messageIndex] : null;
    if (!message || !canEditSourceMessage(message)) return;
    var status = editor.querySelector('[role="status"]');
    var save = editor.querySelector('[type="submit"]');
    var content = editor.querySelector("textarea").value;
    var note = editor.querySelector('input[type="text"]').value.trim();
    var card = editor.closest(".wce-source-message");
    var beforeTop = card ? card.getBoundingClientRect().top : 0;
    save.disabled = true;
    status.textContent = "Saving…";
    try {
      var payload = await apiRequest(query("/v2/topic/message"), {
        method: "PUT",
        body: JSON.stringify({
          recordId: id,
          content: content,
          note: note,
          baseVersion: Number(editor.dataset.baseVersion || 0)
        })
      });
      if (!payload.record) throw new Error("The server did not return the edited message.");
      state.sources[messageIndex] = payload.record;
      state.sourceEditingId = "";
      var replacement = createSourceCard(payload.record, messageIndex);
      card.replaceWith(replacement);
      var afterTop = replacement.getBoundingClientRect().top;
      if (Math.abs(afterTop - beforeTop) > 0.5) window.scrollBy(0, afterTop - beforeTop);
      replacement.classList.add("is-new");
      setTimeout(function () { replacement.classList.remove("is-new"); }, 1600);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  }

  async function loadSourceMessageHistory(id, button) {
    var panel = sourceStream.querySelector('[data-source-message-history="' + CSS.escape(id) + '"]');
    if (!panel) return;
    if (!panel.hidden) {
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      return;
    }
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    var status = panel.querySelector('[role="status"]');
    var list = panel.querySelector("div");
    status.textContent = "Loading version history…";
    list.replaceChildren();
    try {
      var payload = await apiRequest(
        query("/v2/topic/message/history") + "&id=" + encodeURIComponent(id)
      );
      var versions = Array.isArray(payload.versions) ? payload.versions.slice().reverse() : [];
      status.textContent = versions.length > 1
        ? (versions.length - 1) + ((versions.length - 1) === 1 ? " saved edit" : " saved edits")
        : "No edits yet. The original is preserved.";
      list.innerHTML = versions.map(function (version) {
        var content = version.content && (version.content.markdown || version.content.text) || "";
        var label = version.original ? "Original message" : "Version " + Number(version.version || 0);
        return '<details class="wce-source-version"' + (!version.original && Number(version.version) === Number(payload.versions[payload.versions.length - 1].version) ? " open" : "") + "><summary><strong>" + escapeHtml(label) + "</strong><span>" + escapeHtml(timeLabel(version.editedAt)) + " · " + escapeHtml(version.editedBy || "Unknown member") + "</span></summary>" + (version.note ? '<p class="wce-source-version-note">' + escapeHtml(version.note) + "</p>" : "") + "<pre>" + escapeHtml(content) + "</pre></details>";
      }).join("");
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function sourceDayLabel(value) {
    var date = new Date(value);
    if (isNaN(date)) return "";
    return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  function sourceDayDivider(label) {
    var divider = document.createElement("div");
    divider.className = "wce-day-divider";
    divider.setAttribute("role", "separator");
    divider.innerHTML = "<span>" + escapeHtml(label) + "</span>";
    return divider;
  }

  function renderSources() {
    sourceStream.replaceChildren();
    var shown = filteredSources();
    sourceWorkspace.querySelector(".wce-source-count").textContent = shown.length.toLocaleString() + " of " + state.sources.length.toLocaleString() + " messages · oldest first";
    if (!shown.length) {
      sourceStream.innerHTML = '<div class="wce-unavailable"><strong>No sources match these filters.</strong><p>Clear one or more filters to restore the chronological stream.</p></div>';
      return;
    }
    if (state.groupByChannel) {
      var groups = new Map();
      shown.forEach(function (message) {
        var key = sourceChannel(message);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(message);
      });
      groups.forEach(function (group, channel) {
        var section = document.createElement("section");
        section.className = "wce-channel-group";
        var heading = document.createElement("h3");
        heading.textContent = "# " + channel;
        section.appendChild(heading);
        var groupDay = "";
        group.forEach(function (message) {
          var label = sourceDayLabel(sourceTimestamp(message));
          if (label && label !== groupDay) { section.appendChild(sourceDayDivider(label)); groupDay = label; }
          section.appendChild(createSourceCard(message, state.sources.indexOf(message)));
        });
        sourceStream.appendChild(section);
      });
    } else {
      var streamDay = "";
      shown.forEach(function (message) {
        var label = sourceDayLabel(sourceTimestamp(message));
        if (label && label !== streamDay) { sourceStream.appendChild(sourceDayDivider(label)); streamDay = label; }
        sourceStream.appendChild(createSourceCard(message, state.sources.indexOf(message)));
      });
    }
  }

  async function saveSourceMetadata(id, button) {
    if (!state.user || !state.user.admin) return;
    var message = state.sources.find(function (candidate, index) { return sourceId(candidate, index) === id; });
    var editor = sourceStream.querySelector('[data-source-editor="' + CSS.escape(id) + '"]');
    if (!message || !editor) return;
    var status = editor.querySelector('[role="status"]');
    var confidenceLabel = editor.querySelector('[data-meta="confidence"]').value;
    var metadata = {
      primaryTopic: editor.querySelector('[data-meta="primaryTopic"]').value.trim() || null,
      secondaryTopics: editor.querySelector('[data-meta="secondaryTopics"]').value.split(",").map(function (value) { return value.trim(); }).filter(Boolean),
      confidence: { label: confidenceLabel, score: confidenceLabel === "manual" ? 1 : (confidenceLabel === "high" ? 0.9 : (confidenceLabel === "low" ? 0.3 : 0.6)) },
      relevance: editor.querySelector('[data-meta="relevance"]').value,
      reviewStatus: editor.querySelector('[data-meta="status"]').value,
      note: editor.querySelector('[data-meta="note"]').value.trim()
    };
    button.disabled = true;
    status.textContent = "Saving…";
    try {
      var payload = await apiRequest("/v2/classification", {
        method: "PUT",
        body: JSON.stringify(Object.assign({ recordId: id, baseSha: state.archiveSha }, metadata))
      });
      state.assignments[id] = payload.assignment || payload.classification || metadata;
      state.archiveSha = String(payload.sha || state.archiveSha);
      status.textContent = "Saved by " + (state.user && (state.user.displayName || state.user.name || state.user.username) || "editor") + ".";
      setTimeout(renderSources, 700);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function renderAccessList() {
    var records = state.accessList && Array.isArray(state.accessList.records) ? state.accessList.records : [];
    accessList.replaceChildren();
    if (!records.length) {
      accessList.innerHTML = '<p class="wce-history-empty">No Discord accounts are blocked.</p>';
      return;
    }
    records.forEach(function (record) {
      var row = document.createElement("article");
      row.className = "wce-access-row";
      row.innerHTML =
        '<div><strong>' + escapeHtml(record.discordId) + '</strong><span>' +
        escapeHtml(record.note || "No reason added") +
        (record.updatedAt ? " · " + escapeHtml(timeLabel(record.updatedAt)) : "") +
        (record.updatedBy ? " · " + escapeHtml(record.updatedBy) : "") +
        '</span></div><button type="button">Restore access</button>';
      row.querySelector("button").addEventListener("click", function () {
        if (!confirm("Restore archive access for Discord user " + record.discordId + "?")) return;
        changeAccess(record.discordId, false, "");
      });
      accessList.appendChild(row);
    });
  }

  async function loadAccess() {
    if (!(state.user && state.user.admin)) return;
    accessStatus.textContent = "Loading access list…";
    try {
      state.accessList = await apiRequest("/v2/admin/denylist");
      renderAccessList();
      accessStatus.textContent = "";
    } catch (error) {
      accessStatus.textContent = error.message;
    }
  }

  async function changeAccess(discordId, denied, note) {
    if (!(state.user && state.user.admin)) return;
    accessStatus.textContent = denied ? "Blocking account…" : "Restoring access…";
    try {
      state.accessList = await apiRequest("/v2/admin/denylist", {
        method: "PUT",
        body: JSON.stringify({
          discordId: discordId,
          denied: denied,
          note: note || "",
          baseSha: state.accessList && state.accessList.sha || ""
        })
      });
      renderAccessList();
      accessStatus.textContent = denied ? "Account blocked." : "Access restored.";
      accessForm.reset();
      if (accessPanel.querySelector(".wce-access-history").open) loadAccessHistory();
    } catch (error) {
      accessStatus.textContent = error.message;
      if (error.status === 409) await loadAccess();
    }
  }

  async function loadAccessHistory() {
    if (!(state.user && state.user.admin)) return;
    accessHistory.innerHTML = '<p class="wce-history-empty">Loading changes…</p>';
    try {
      var payload = await apiRequest("/v2/admin/denylist/history");
      var versions = payload.versions || [];
      accessHistory.innerHTML = versions.length ? versions.map(function (version) {
        return '<p><strong>' + escapeHtml(version.note || "Access list updated") + '</strong><span>' +
          escapeHtml(timeLabel(version.savedAt)) + " · " + escapeHtml(version.updatedBy || "Administrator") +
          "</span></p>";
      }).join("") : '<p class="wce-history-empty">No access changes yet.</p>';
    } catch (error) {
      accessHistory.innerHTML = '<p class="wce-history-empty">' + escapeHtml(error.message) + "</p>";
    }
  }

  async function restoreFinal(commit) {
    if (!(state.user && state.user.admin) || state.finalPreviewSha !== commit) return;
    if (!confirm("Restore the previewed revision as the current final argument? The present version will remain in history.")) return;
    finalStatus.hidden = false;
    finalStatus.textContent = "Restoring previewed revision…";
    try {
      var payload = await apiRequest(query("/v2/final/restore"), {
        method: "POST",
        body: JSON.stringify({
          commit: commit,
          baseSha: state.finalDocument && state.finalDocument.sha || "",
          note: "Restore revision " + commit.slice(0, 7)
        })
      });
      state.finalDocument = normalizedFinal(payload);
      state.finalPreviewSha = "";
      renderFinal();
      historyPanel.hidden = true;
      finalStatus.hidden = false;
      finalStatus.textContent = "Revision restored. The replaced version remains in history.";
    } catch (error) {
      finalStatus.hidden = false;
      finalStatus.textContent = error.message;
    }
  }

  async function loadFinalHistory() {
    historyList.innerHTML = '<p class="wce-history-empty">Loading revisions…</p>';
    try {
      var payload = await apiFirst([query("/v2/final/history"), query("/v2/argument/history")]);
      var versions = payload.versions || payload.history || payload.items || [];
      historyList.replaceChildren();
      if (!versions.length) {
        historyList.innerHTML = '<p class="wce-history-empty">No saved revisions yet.</p>';
        return;
      }
      versions.forEach(function (version) {
        var row = document.createElement("article");
        row.className = "wce-version";
        var canRestore = Boolean(state.user && state.user.admin && version.sha);
        row.innerHTML = "<div><strong>" + escapeHtml(version.note || version.title || "Saved revision") + "</strong><span>" + escapeHtml(timeLabel(version.savedAt || version.updatedAt || version.timestamp)) + " · " + escapeHtml(version.editorName || version.updatedBy || version.author || "Unknown editor") + (version.sha ? " · " + escapeHtml(String(version.sha).slice(0, 7)) : "") + '</span></div><div class="wce-version-actions"><button type="button" data-preview>Preview</button>' + (canRestore ? '<button type="button" data-restore disabled>Restore this version</button>' : "") + "</div>";
        row.querySelector("[data-preview]").addEventListener("click", async function () {
          try {
            var versionPayload = version.bodyMarkdown || version.markdown || version.content || version.body ? version : await apiRequest(query("/v2/final/version") + "&sha=" + encodeURIComponent(version.sha));
            var versionDocument = normalizedFinal(versionPayload);
            finalRender.innerHTML = renderMarkdown(versionDocument.markdown);
            state.finalPreviewSha = String(version.sha || "");
            Array.from(historyList.querySelectorAll("[data-restore]")).forEach(function (button) {
              button.disabled = button.closest(".wce-version") !== row;
            });
            finalStatus.hidden = false;
            finalStatus.textContent = "Previewing revision by " + (version.editorName || version.updatedBy || version.author || "Unknown editor") + (canRestore ? " · administrators can now restore it from history." : " · edit to return to the latest.");
            finalRender.scrollIntoView({ behavior: "smooth", block: "start" });
          } catch (error) {
            finalStatus.hidden = false;
            finalStatus.textContent = error.message;
          }
        });
        var restoreButton = row.querySelector("[data-restore]");
        if (restoreButton) restoreButton.addEventListener("click", function () { restoreFinal(version.sha); });
        historyList.appendChild(row);
      });
    } catch (error) {
      historyList.innerHTML = '<p class="wce-history-empty">' + escapeHtml(error.message) + "</p>";
    }
  }

  async function openCitationPicker() {
    citationPicker.hidden = false;
    if (!state.sourcesLoaded) await loadSources();
    var select = citationPicker.querySelector(".wce-citation-source");
    select.replaceChildren();
    state.sources.forEach(function (message, index) {
      var option = new Option("#" + sourceChannel(message) + " · " + sourceAuthor(message) + " · " + sourceContent(message).replace(/\s+/g, " ").slice(0, 75), sourceId(message, index));
      select.add(option);
    });
    if (!state.sources.length) select.add(new Option("No archived Discord sources available", ""));
  }

  function insertCitation() {
    var type = citationPicker.querySelector("[data-citation-type].is-active").dataset.citationType;
    var href = "";
    var title = "";
    var sourceIdValue = "";
    var page = "";
    if (type === "discord") {
      sourceIdValue = citationPicker.querySelector(".wce-citation-source").value;
      var message = state.sources.find(function (candidate, index) { return sourceId(candidate, index) === sourceIdValue; });
      if (!message) { citationPicker.querySelector(".wce-citation-status").textContent = "Choose an archived message."; return; }
      href = "";
      title = "United Marxist Pact source archive (members only)";
    } else {
      title = citationPicker.querySelector(".wce-citation-title").value.trim();
      href = safeUrl(citationPicker.querySelector(".wce-citation-url").value);
      page = citationPicker.querySelector(".wce-citation-page").value.trim();
      if (!title || !href) { citationPicker.querySelector(".wce-citation-status").textContent = "Add a document title and valid PDF URL."; return; }
      if (page) title += ", p. " + page;
    }
    var citation = { id: "citation-" + Date.now().toString(36), type: type, title: title, url: href, sourceId: sourceIdValue || null, page: page || null, private: type === "discord" };
    state.finalDraftCitations.push(citation);
    insertAround("", "", "[[" + citation.id + "]]");
    citationPicker.hidden = true;
  }

  modebar.addEventListener("click", async function (event) {
    var mode = event.target.closest("[data-wce-mode]");
    if (mode) setMode(mode.dataset.wceMode);
    if (event.target.closest('[data-wce-action="login-open"]')) openLogin();
    if (event.target.closest('[data-wce-action="access-open"]') && state.user && state.user.admin) {
      accessPanel.hidden = false;
      loadAccess();
      accessPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (event.target.closest('[data-wce-action="logout"]')) {
      await signOut();
    }
  });

  loginPanel.addEventListener("click", function (event) {
    if (event.target.closest('[data-wce-action="login-close"]')) {
      loginPanel.hidden = true;
      state.pendingMode = "";
    }
  });

  accessPanel.addEventListener("click", function (event) {
    if (event.target.closest('[data-wce-action="access-close"]')) accessPanel.hidden = true;
  });

  accessPanel.querySelector(".wce-access-history").addEventListener("toggle", function (event) {
    if (event.currentTarget.open) loadAccessHistory();
  });

  accessForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var data = new FormData(accessForm);
    changeAccess(String(data.get("discordId") || "").trim(), true, String(data.get("note") || "").trim());
  });

  finalWorkspace.addEventListener("click", function (event) {
    var action = event.target.closest("[data-wce-action]");
    if (!action) return;
    var name = action.dataset.wceAction;
    if (name === "final-edit") beginFinalEdit();
    if (name === "final-cancel") endFinalEdit();
    if (name === "final-save") saveFinal(false);
    if (name === "final-checkpoint") saveFinal(true);
    if (name === "final-history") {
      historyPanel.hidden = !historyPanel.hidden;
      action.setAttribute("aria-expanded", historyPanel.hidden ? "false" : "true");
      if (!historyPanel.hidden) loadFinalHistory();
    }
    if (name === "history-close") historyPanel.hidden = true;
    if (name === "final-preview") toggleFinalPreview(action);
    if (name === "final-link") {
      var url = prompt("Paste the link address:");
      if (safeUrl(url)) {
        var start = wordPage.selectionStart;
        var end = wordPage.selectionEnd;
        var label = wordPage.value.slice(start, end) || "link text";
        wordPage.setRangeText("[" + label + "](" + safeUrl(url) + ")", start, end, "select");
        updateWordCount();
      }
    }
    if (name === "citation-open") openCitationPicker();
    if (name === "citation-close") citationPicker.hidden = true;
    if (name === "citation-insert") insertCitation();
  });

  finalWorkspace.querySelector(".wce-word-toolbar").addEventListener("mousedown", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    event.preventDefault();
    toolbarCommand(button);
  });

  finalWorkspace.querySelector(".wce-citation-tabs").addEventListener("click", function (event) {
    var button = event.target.closest("[data-citation-type]");
    if (!button) return;
    Array.from(citationPicker.querySelectorAll("[data-citation-type]")).forEach(function (item) { item.classList.toggle("is-active", item === button); });
    Array.from(citationPicker.querySelectorAll("[data-citation-panel]")).forEach(function (panel) { panel.hidden = panel.dataset.citationPanel !== button.dataset.citationType; });
  });

  var wordPreview = null;

  function toggleFinalPreview(button) {
    if (!wordPreview) {
      wordPreview = document.createElement("article");
      wordPreview.className = "wce-preview wce-word-preview";
      wordPreview.hidden = true;
      wordPage.insertAdjacentElement("afterend", wordPreview);
    }
    var showing = wordPreview.hidden;
    wordPreview.hidden = !showing;
    wordPage.classList.toggle("is-previewing", showing);
    if (button) button.setAttribute("aria-pressed", showing ? "true" : "false");
    if (showing) wordPreview.innerHTML = renderMarkdown(wordPage.value) || '<p class="wce-subtext">Nothing to preview yet.</p>';
  }

  wordPage.addEventListener("input", function () {
    if (wordPreview && !wordPreview.hidden) wordPreview.innerHTML = renderMarkdown(wordPage.value);
  });

  wordPage.addEventListener("keydown", function (event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    var key = String(event.key || "").toLowerCase();
    if (key === "b") { event.preventDefault(); insertAround("**", "**", "bold text"); }
    if (key === "i") { event.preventDefault(); insertAround("*", "*", "italic text"); }
    if (key === "u") { event.preventDefault(); insertAround("__", "__", "underlined text"); }
    if (key === "e") { event.preventDefault(); insertAround("`", "`", "code"); }
    if (key === "k") {
      event.preventDefault();
      var linkButton = finalWorkspace.querySelector('[data-wce-action="final-link"]');
      if (linkButton) linkButton.click();
    }
  });

  wordPage.addEventListener("input", updateWordCount);

  sourceFilters.addEventListener("input", renderSources);
  sourceFilters.addEventListener("reset", function () { setTimeout(renderSources, 0); });
  sourceFilters.querySelector('[data-wce-action="group-channel"]').addEventListener("change", function (event) {
    state.groupByChannel = event.target.checked;
    renderSources();
  });

  sourceStream.addEventListener("click", async function (event) {
    var jump = event.target.closest("[data-jump-source]");
    if (jump) {
      var target = document.getElementById("source-" + jump.dataset.jumpSource);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    var cite = event.target.closest("[data-cite-source]");
    if (cite) {
      var message = state.sources.find(function (candidate, index) { return sourceId(candidate, index) === cite.dataset.citeSource; });
      if (message) {
        try {
          await navigator.clipboard.writeText(sourceCitation(message));
          cite.textContent = "Citation copied";
          setTimeout(function () { cite.textContent = "Copy citation"; }, 1600);
        } catch (_) {
          cite.textContent = "Copy unavailable";
        }
      }
    }
    var reply = event.target.closest("[data-reply-source]");
    if (reply) beginSourceReply(reply.dataset.replySource);
    var edit = event.target.closest("[data-edit-source-message]");
    if (edit) beginSourceEdit(edit.dataset.editSourceMessage);
    var cancelEdit = event.target.closest("[data-cancel-source-edit]");
    if (cancelEdit) cancelSourceEdit(cancelEdit.dataset.cancelSourceEdit);
    var history = event.target.closest("[data-source-message-history-open]");
    if (history) loadSourceMessageHistory(history.dataset.sourceMessageHistoryOpen, history);
    var save = event.target.closest("[data-save-source]");
    if (save) saveSourceMetadata(save.dataset.saveSource, save);
  });
  sourceStream.addEventListener("submit", function (event) {
    var editor = event.target.closest("[data-source-message-editor]");
    if (!editor) return;
    event.preventDefault();
    saveSourceEdit(editor);
  });

  sourceComposer.addEventListener("submit", function (event) {
    event.preventDefault();
    postSourceMessage();
  });
  sourceComposer.addEventListener("click", function (event) {
    if (event.target.closest('[data-wce-action="source-reply-cancel"]')) clearSourceReply();
    var removeFile = event.target.closest("[data-remove-source-file]");
    if (removeFile) {
      state.sourceFiles.splice(Number(removeFile.dataset.removeSourceFile), 1);
      updateSourceComposer();
    }
  });
  sourceComposerFileInput.addEventListener("change", function () { addSourceFiles(sourceComposerFileInput.files); });
  sourceComposerText.addEventListener("input", updateSourceComposer);
  sourceComposerText.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      postSourceMessage();
    }
  });

  article.hidden = true;
  setMode("final");
  checkSession().then(function () {
    if (state.pendingMode === "sources" && state.canReadArchive) setMode("sources");
  });
}());
