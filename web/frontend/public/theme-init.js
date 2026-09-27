// Apply the Light/Dark/Auto colour-scheme preference via a `.dark` class on
// <html> (localStorage `glidecomp-theme`; missing = auto, which follows the
// OS). Mirrors src/react/lib/theme.ts. Loaded as a classic, render-blocking
// <script src> in <head> of every page — the static pages (Base.astro) and
// the SPA shell (app.html) — so it runs before paint (no flash).
//
// It is a file rather than an inline <script> so the Content-Security-Policy
// can say `script-src 'self'` without a hash to keep in step (public/_headers).
(function () {
  var q = window.matchMedia("(prefers-color-scheme: dark)");
  var sync = function () {
    var pref = null;
    try {
      pref = localStorage.getItem("glidecomp-theme");
    } catch (e) {
      // Storage blocked: fall through to auto.
    }
    if (pref !== "light" && pref !== "dark" && pref !== "auto") pref = "auto";
    document.documentElement.classList.toggle(
      "dark",
      pref === "dark" || (pref === "auto" && q.matches)
    );
  };
  sync();
  q.addEventListener("change", sync);
  window.addEventListener("storage", function (e) {
    if (e.key === "glidecomp-theme") sync();
  });
})();
