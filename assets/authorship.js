(function () {
  "use strict";
  var TRIAD = "Human-written. Human-reviewed. AI-assisted web design.";
  var STATEMENT = "Everything you read here is written and reviewed by people. " +
    "We use AI as a tool for building parts of the website, never as a " +
    "substitute for human political thought.";
  var MONO = '"IBM Plex Mono","Plex Mono",ui-monospace,Menlo,monospace';
  var SERIF = '"Source Serif","Source Serif 4",Georgia,serif';

  var css = "" +
    ".an-strip{padding:9px 10px 8px;text-align:center;font-family:" + MONO + ";" +
    "font-size:min(10.5px,2.2vw);letter-spacing:.18em;text-indent:.18em;color:#6d6353;" +
    "white-space:nowrap;overflow:hidden;background:#efe8d8;position:relative;z-index:2147482000}" +
    ".an-strip.an-top{border-bottom:1px solid rgba(109,99,83,.28)}" +
    ".an-strip.an-foot{border-top:1px solid rgba(109,99,83,.28)}" +
    "#an-note{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;" +
    "justify-content:center;padding:22px;background:rgba(38,32,22,.48)}" +
    "#an-note[hidden]{display:none}" +
    ".an-card{background:#faf6ea;border:1px solid #d9cdb2;max-width:480px;" +
    "padding:30px 32px 26px;box-shadow:0 12px 48px rgba(20,14,6,.35)}" +
    ".an-body{font-family:" + SERIF + ";font-size:16.5px;line-height:1.7;color:#262016;margin:0}" +
    ".an-triad{margin:14px 0 0;white-space:nowrap;font-size:min(13.5px,2.6vw)}" +
    ".an-btns{margin-top:22px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}" +
    ".an-btn{display:inline-block;border:1px solid #6d6353;background:none;" +
    "color:#262016;cursor:pointer;text-decoration:none;font-family:" + MONO + ";" +
    "font-size:12.5px;letter-spacing:.08em;padding:10px 20px}" +
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
