// The static pages' bar behaviour (SiteHeader.astro): its menus and the
// account rows. Loaded as a classic, blocking <script src> straight after the
// bar's markup, so the account rows settle before paint. A file rather than
// inline so the CSP can stay `script-src 'self'` (public/_headers).

/*
 * The bar's menus are native <details>, so they open and close with no script
 * at all. This adds what a disclosure does not do by itself: Escape closes it
 * and gives focus back to its control, and a click outside or focus going
 * elsewhere closes it.
 */
(function () {
  var menus = Array.prototype.slice.call(document.querySelectorAll("[data-bar-menu]"));
  if (!menus.length) return;

  function close(menu, refocus) {
    if (!menu.open) return;
    menu.open = false;
    if (refocus) {
      var summary = menu.querySelector("summary");
      if (summary) summary.focus();
    }
  }

  menus.forEach(function (menu) {
    menu.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !menu.open) return;
      e.preventDefault();
      close(menu, true);
    });
    // focusout fires before the new element takes focus, so look on the next
    // tick. A press on the panel's own padding moves focus to nothing, and
    // must not close the menu under the finger: only focus that has gone to
    // another element counts.
    menu.addEventListener("focusout", function () {
      setTimeout(function () {
        var active = document.activeElement;
        if (active && active !== document.body && !menu.contains(active)) close(menu);
      }, 0);
    });
  });

  document.addEventListener("pointerdown", function (e) {
    menus.forEach(function (menu) {
      if (!menu.contains(e.target)) close(menu);
    });
  });

  // Back to a page the browser kept whole: its menu must not still be open.
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    menus.forEach(function (menu) {
      close(menu);
    });
  });
})();

// Account rows: pick "Sign in" or the account rows without a server render.
//
// The hint (localStorage `glidecomp:account`, written by the SPA in
// auth/client.ts) is what makes this flash-free in both directions: a
// signed-in visitor has no "Sign in" on first paint, a signed-out one keeps
// the prerendered markup and costs us no request. The hint is only ever a
// guess about a session — it authorises nothing — so we confirm it against
// /api/auth/me and correct the bar if the session has since expired.
(function () {
  var all = function (selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  };
  var signins = all("[data-account-signin]");
  var menus = all("[data-account-menu]");
  var names = all("[data-account-name]");
  if (!signins.length && !menus.length) return;

  function read(storage, key) {
    try {
      return storage.getItem(key);
    } catch (e) {
      return null; // Storage blocked (Safari private mode).
    }
  }

  /** null = signed out (show "Sign in"); a name = show the account rows. */
  function render(name) {
    names.forEach(function (el) {
      el.textContent = name || "";
    });
    signins.forEach(function (el) {
      el.hidden = !!name;
    });
    menus.forEach(function (el) {
      el.hidden = !name;
    });
  }

  function hint() {
    // The SPA's superadmin "Preview as: signed out" is presentation-only,
    // but it should hold across the static pages too or the preview lies.
    if (read(sessionStorage, "glidecomp:preview-role") === "out") return null;
    var raw = read(localStorage, "glidecomp:account");
    if (!raw) return null;
    try {
      return JSON.parse(raw).name || null;
    } catch (e) {
      return null;
    }
  }

  all("[data-account-signout]").forEach(function (button) {
    button.addEventListener("click", function () {
      // Better Auth's own endpoint, the one the SPA's signOut() wraps. It
      // rejects a POST without this Content-Type (415) — the bar would
      // otherwise *look* signed out while the session stayed alive.
      fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        credentials: "include",
      })
        .then(function (res) {
          // Only drop the hint once the session is really gone. If the request
          // failed the pilot is still signed in, and keeping the hint means the
          // bar keeps telling them so instead of quietly lying.
          if (!res.ok) return;
          try {
            localStorage.removeItem("glidecomp:account");
          } catch (err) {
            /* storage blocked */
          }
        })
        .catch(function () {})
        .then(function () {
          window.location.assign("/");
        });
    });
  });

  /* ---- Decide what to show ---- */
  var guess = hint();
  render(guess);
  // Only a visitor we believe is signed in costs an API round trip; for
  // everyone else the prerendered "Sign in" is already correct.
  if (!guess) return;
  fetch("/api/auth/me", { credentials: "include" })
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .then(function (data) {
      var user = data && data.user;
      if (user) {
        var name = user.name || user.email;
        try {
          localStorage.setItem("glidecomp:account", JSON.stringify({ name: name }));
        } catch (e) {
          /* storage blocked */
        }
        render(name);
      } else {
        // Session gone (expired or signed out elsewhere) — fix the bar.
        try {
          localStorage.removeItem("glidecomp:account");
        } catch (e) {
          /* storage blocked */
        }
        render(null);
      }
    })
    .catch(function () {
      // Offline or the API is down: leave the optimistic render alone rather
      // than telling a signed-in pilot they're signed out.
    });
})();
