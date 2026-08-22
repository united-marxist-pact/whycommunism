(function () {
  "use strict";
  var SCRIPT = document.currentScript;
  function copy(name, fallback) {
    return SCRIPT && SCRIPT.getAttribute(name) || fallback;
  }
  var TRIAD = copy("data-triad", "Human-written. Human-reviewed. AI-assisted web design.");
  var STATEMENT1 = copy("data-statement-1", "Everything you read and hear here is written and reviewed by people.");
  var STATEMENT2 = copy("data-statement-2", "We use AI as a tool for building parts of the website. " +
    "Our political thought is entirely human.");
  var MONO = '"IBM Plex Mono","Plex Mono",ui-monospace,Menlo,monospace';
  var SERIF = '"Source Serif","Source Serif 4",Georgia,serif';

  function parseColor(c) {
    var m = /rgba?\(([^)]+)\)/.exec(c || "");
    if (!m) return null;
    var p = m[1].split(",").map(parseFloat);
    if (p.length > 3 && p[3] === 0) return null;
    return { r: p[0], g: p[1], b: p[2] };
  }
  function pageBg() {
    return parseColor(getComputedStyle(document.body).backgroundColor) ||
      parseColor(getComputedStyle(document.documentElement).backgroundColor) ||
      { r: 239, g: 232, b: 216 };
  }
  function mix(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
  }
  function str(c) { return "rgb(" + Math.round(c.r) + "," + Math.round(c.g) + "," + Math.round(c.b) + ")"; }

  var bg = pageBg();
  var lum = (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) / 255;
  var dark = lum < 0.5;
  var white = { r: 255, g: 255, b: 255 }, black = { r: 24, g: 20, b: 14 };
  var card = "#faf6ea";
  var text = dark ? "rgba(244,240,230,.96)" : "rgba(38,32,22,.96)";
  var muted = dark ? "rgba(244,240,230,.6)" : "rgba(90,80,64,.75)";
  var line = dark ? "rgba(244,240,230,.28)" : "rgba(90,80,64,.32)";
  var cardText = "rgba(38,32,22,.96)", cardBorder = "rgba(90,80,64,.45)";

  var css = "" +
    ".an-strip{padding:9px 10px 8px;text-align:center;font-family:" + MONO + ";" +
    "font-size:min(10.5px,2.2vw);letter-spacing:.18em;text-indent:.18em;color:" + muted + ";" +
    "white-space:nowrap;overflow:hidden;background:" + str(bg) + ";position:relative;z-index:1}" +
    ".an-strip.an-top{border-bottom:1px solid " + line + "}" +
    ".an-strip.an-foot{border-top:1px solid " + line + "}" +
    "#an-note{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;" +
    "justify-content:center;padding:22px;background:rgba(8,6,3,.55)}" +
    "#an-note[hidden]{display:none}" +
    ".an-card{background:" + card + ";border:1px solid " + cardBorder + ";max-width:480px;min-width:0;" +
    "padding:30px 32px 26px;box-shadow:0 12px 48px rgba(0,0,0,.4)}" +
    ".an-body{font-family:" + SERIF + ";font-size:16.5px;line-height:1.7;color:" + cardText + ";margin:0}" +
    ".an-triad{margin:14px 0 0;text-align:center;font-size:min(13.5px,2.6vw);white-space:nowrap}" +
    ".an-triad+.an-body{margin-top:14px}" +
    ".an-btns{margin-top:22px;display:flex;gap:min(12px,2.4vw);justify-content:center}" +
    ".an-btn{display:inline-block;border:1px solid " + cardBorder + ";background:none;" +
    "color:" + cardText + ";cursor:pointer;text-decoration:none;font-family:" + MONO + ";" +
    "font-size:min(12.5px,3.3vw);letter-spacing:.08em;padding:10px min(20px,3vw);white-space:nowrap}" +
    ".an-btn:hover{color:#a5231d;border-color:#a5231d}" +
    ".an-btn:focus,.an-btn:focus-visible{outline:none;box-shadow:none}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  function strip(cls) {
    var p = document.createElement("p");
    p.className = "an-strip " + cls;
    p.textContent = TRIAD;
    return p;
  }
  document.body.insertBefore(strip("an-top"), document.body.firstChild);
  document.body.appendChild(strip("an-foot"));

  var wrap = document.createElement("div");
  wrap.id = "an-note";
  wrap.setAttribute("role", "dialog");
  wrap.setAttribute("aria-modal", "true");
  wrap.innerHTML =
    '<div class="an-card">' +
    '<p class="an-body an-s1"></p>' +
    '<p class="an-body an-triad"></p>' +
    '<p class="an-body an-s2"></p>' +
    '<div class="an-btns">' +
    '<a class="an-btn" href="https://www.google.com">Exit site</a>' +
    '<button class="an-btn" type="button">I understand</button>' +
    "</div></div>";
  wrap.querySelector(".an-s1").textContent = STATEMENT1;
  wrap.querySelector(".an-triad").textContent = TRIAD;
  wrap.querySelector(".an-s2").textContent = STATEMENT2;
  document.body.appendChild(wrap);
  /* Keep every copy of the triad on a single line. The stylesheet sizes are only a
     starting point: measure the rendered text, tighten the tracking first (down to
     MIN_TRACK), then scale the type until it fits the width its container really has. */
  var TRACK = 0.18, MIN_TRACK = 0.04;
  function lineWidth(el) {
    var r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().width;
  }
  function fitLine(el, tracked) {
    el.style.fontSize = "";
    el.style.letterSpacing = "";
    el.style.textIndent = "";
    var cs = getComputedStyle(el);
    var avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (!(avail > 0)) return;
    var size = parseFloat(cs.fontSize);
    var slots = el.textContent.length + 1;   // spacing after each glyph, plus the matching indent
    var track = tracked ? TRACK : 0;
    var width = lineWidth(el) + track * size;
    if (width <= avail) return;
    if (tracked) {
      var glyphs = width - slots * track * size;
      track = Math.max(MIN_TRACK, Math.min(TRACK, (avail - glyphs) / (slots * size)));
      el.style.letterSpacing = track + "em";
      el.style.textIndent = track + "em";
      width = lineWidth(el) + track * size;
      if (width <= avail) return;
    }
    size = size * avail / width;
    for (var i = 0; i < 4; i++) {
      el.style.fontSize = (Math.floor(size * 100) / 100) + "px";
      size = parseFloat(getComputedStyle(el).fontSize);
      width = lineWidth(el) + track * size;
      if (width <= avail) return;
      size *= 0.985;
    }
  }
  function fitAll() {
    var strips = document.querySelectorAll(".an-strip");
    for (var i = 0; i < strips.length; i++) fitLine(strips[i], true);
    fitLine(wrap.querySelector(".an-triad"), false);
    var top = document.querySelector(".an-strip.an-top");
    if (top) document.documentElement.style.setProperty("--an-top-h", top.offsetHeight + "px");
  }
  var raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; fitAll(); });
  }
  fitAll();
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.addEventListener("load", schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);

  function close() { wrap.hidden = true; }
  wrap.querySelector("button.an-btn").addEventListener("click", close);
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !wrap.hidden) close();
  });
})();
