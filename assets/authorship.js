(function () {
  "use strict";
  var TRIAD = "Human-written. Human-reviewed. AI-assisted web design.";
  var STATEMENT = "Everything you read here is written and reviewed by people. " +
    "We use AI as a tool for building parts of the website, never as a " +
    "substitute for human political thought.";
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
  var card = str(dark ? mix(bg, white, 0.07) : mix(bg, white, 0.55));
  var text = dark ? "rgba(244,240,230,.96)" : "rgba(38,32,22,.96)";
  var muted = dark ? "rgba(244,240,230,.6)" : "rgba(90,80,64,.75)";
  var line = dark ? "rgba(244,240,230,.28)" : "rgba(90,80,64,.32)";
  var cardText = text, cardBorder = dark ? "rgba(244,240,230,.35)" : "rgba(90,80,64,.4)";

  var css = "" +
    ".an-strip{padding:9px 10px 8px;text-align:center;font-family:" + MONO + ";" +
    "font-size:min(10.5px,2.2vw);letter-spacing:.18em;text-indent:.18em;color:" + muted + ";" +
    "white-space:nowrap;overflow:hidden;background:" + str(bg) + ";position:relative;z-index:2147482000}" +
    ".an-strip.an-top{border-bottom:1px solid " + line + "}" +
    ".an-strip.an-foot{border-top:1px solid " + line + "}" +
    "#an-note{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;" +
    "justify-content:center;padding:22px;background:rgba(8,6,3,.55)}" +
    "#an-note[hidden]{display:none}" +
    ".an-card{background:" + card + ";border:1px solid " + cardBorder + ";max-width:480px;" +
    "padding:30px 32px 26px;box-shadow:0 12px 48px rgba(0,0,0,.4)}" +
    ".an-body{font-family:" + SERIF + ";font-size:16.5px;line-height:1.7;color:" + cardText + ";margin:0}" +
    ".an-triad{margin:14px 0 0;white-space:nowrap;font-size:min(13.5px,2.6vw)}" +
    ".an-btns{margin-top:22px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}" +
    ".an-btn{display:inline-block;border:1px solid " + cardBorder + ";background:none;" +
    "color:" + cardText + ";cursor:pointer;text-decoration:none;font-family:" + MONO + ";" +
    "font-size:12.5px;letter-spacing:.08em;padding:10px 20px}" +
    ".an-btn:hover{background:" + cardText + ";color:" + card + "}" +
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
    '<p class="an-body"></p>' +
    '<p class="an-body an-triad"></p>' +
    '<div class="an-btns">' +
    '<a class="an-btn" href="https://www.google.com">Exit site</a>' +
    '<button class="an-btn" type="button">I understand</button>' +
    "</div></div>";
  wrap.querySelector(".an-body").textContent = STATEMENT;
  wrap.querySelector(".an-triad").textContent = TRIAD;
  document.body.appendChild(wrap);
  function close() { wrap.hidden = true; }
  wrap.querySelector("button.an-btn").addEventListener("click", close);
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !wrap.hidden) close();
  });
})();
