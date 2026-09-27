// The static pages' header behaviour (SiteHeader.astro): the account slot and
// the nav's "More" menu. Loaded as a classic, blocking <script src> straight
// after the header markup, so it runs at the same point in the parse as the
// inline script it replaced and the account slot still settles before paint.
// A file rather than inline so the CSP can stay `script-src 'self'`
// (public/_headers).
/**
 * WAI-ARIA menu-button behaviour for a trigger/panel pair: click and arrow
 * keys to open, arrows to walk, Escape / click-away / tab-away to close.
 * Two menus in this header need it — the account slot and the nav's "More"
 * — so it is written once here rather than twice below.
 *
 * The items are re-read on every use rather than captured: "More" holds an
 * entry per nav link and hides the ones still visible in the row, so which
 * of them the arrow keys walk changes with the width of the window.
 */
function menuButton(root, trigger, panel) {
  function items() {
    return Array.prototype.slice.call(
      panel.querySelectorAll('[role="menuitem"]:not([hidden])')
    );
  }

  function isOpen() {
    return !panel.hidden;
  }

  /** focus: "first" | "last" | undefined (leave focus on the trigger). */
  function open(focus) {
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    var list = items();
    if (!focus || !list.length) return;
    list[focus === "last" ? list.length - 1 : 0].focus();
  }

  function close(refocus) {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (refocus) trigger.focus();
  }

  trigger.addEventListener("click", function () {
    if (isOpen()) close();
    else open();
  });

  // Arrow keys open the menu onto an end item, per the WAI-ARIA menu-button
  // pattern (Down → first, Up → last).
  trigger.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    // Don't let this reach the container's arrow handler below — the menu is
    // open by then, so it would read the same keypress a second time and
    // step straight past the item we just focused.
    e.stopPropagation();
    open(e.key === "ArrowUp" ? "last" : "first");
  });

  root.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      close(true);
      return;
    }
    if (!isOpen() || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    var list = items();
    var i = list.indexOf(document.activeElement);
    var next = e.key === "ArrowDown" ? i + 1 : i - 1;
    list[(next + list.length) % list.length].focus();
  });

  // Click or tab away closes it. focusout fires before the new element takes
  // focus, so check on the next tick.
  document.addEventListener("pointerdown", function (e) {
    if (isOpen() && !root.contains(e.target)) close();
  });
  root.addEventListener("focusout", function () {
    setTimeout(function () {
      if (isOpen() && !root.contains(document.activeElement)) close();
    }, 0);
  });

  return { isOpen: isOpen, open: open, close: close };
}

// Account slot: pick "Sign in" vs the account menu without a server render.
//
// The hint (localStorage `glidecomp:account`, written by the SPA in
// auth/client.ts) is what makes this flash-free in both directions: a
// signed-in visitor gets their avatar on first paint, a signed-out one keeps
// the prerendered pill and costs us no request. The hint is only ever a
// guess about a session — it authorises nothing — so we confirm it against
// /api/auth/me and correct the header if the session has since expired.
(function () {
  var root = document.querySelector("[data-account]");
  if (!root) return;
  var signinLink = root.querySelector("[data-account-signin]");
  var menu = root.querySelector("[data-account-menu]");
  var trigger = root.querySelector("[data-account-trigger]");
  var panel = root.querySelector("[data-account-panel]");
  var nameEl = root.querySelector("[data-account-name]");
  var menuCtl = menuButton(root, trigger, panel);

  function read(storage, key) {
    try {
      return storage.getItem(key);
    } catch (e) {
      return null; // Storage blocked (Safari private mode).
    }
  }

  function initials(name) {
    var parts = String(name).split(/\s+/).filter(Boolean).slice(0, 2);
    var s = parts
      .map(function (w) {
        return w[0];
      })
      .join("")
      .toUpperCase();
    return s || "?";
  }

  /** null = signed out (show the pill); a name = show the account menu. */
  function render(name) {
    if (name) {
      trigger.textContent = initials(name);
      nameEl.textContent = name;
    } else {
      menuCtl.close();
    }
    signinLink.hidden = !!name;
    menu.hidden = !name;
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

  root.querySelector("[data-account-signout]").addEventListener("click", function () {
    // Better Auth's own endpoint, the one the SPA's signOut() wraps. It
    // rejects a POST without this Content-Type (415) — the header would
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
        // header keeps telling them so instead of quietly lying.
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
        // Session gone (expired or signed out elsewhere) — fix the header.
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

/*
 * Priority+overflow nav (issue #639) — the vanilla twin of the SPA's
 * react/rac/priority-nav.tsx. Keep the two in step; the reasoning for the
 * measurement lives in that file's header comment, and the short version is:
 *
 *  - a folded link is hidden with `visibility`, so it KEEPS its space and
 *    the measurement can never depend on its own result;
 *  - the trigger is absolutely positioned, so it is not in the row's layout
 *    either, and its width is only reserved once something already overflows.
 *
 * Everything the script changes is an inline style or a `hidden` attribute,
 * never a class: these pages are prerendered, and a class name that only
 * exists inside a script string is a class name Tailwind may not have built.
 */
(function () {
  var row = document.querySelector("[data-priority-nav]");
  var triggerWrap = document.querySelector("[data-priority-trigger]");
  if (!row || !triggerWrap) return;
  var items = Array.prototype.slice.call(
    row.querySelectorAll("[data-priority-item]")
  );
  var trigger = triggerWrap.querySelector("[data-priority-nav-trigger]");
  var panel = triggerWrap.querySelector("[data-priority-nav-panel]");
  menuButton(triggerWrap, trigger, panel);

  // Only now, with a script running, does the row stop wrapping: without one
  // every link has to stay reachable, and wrapping is how it does that.
  row.style.flexWrap = "nowrap";
  row.style.overflow = "hidden";
  triggerWrap.hidden = false;
  triggerWrap.style.visibility = "hidden";

  function entry(id) {
    return panel.querySelector('[data-priority-entry="' + id + '"]');
  }

  function measure() {
    var edge = row.getBoundingClientRect().right;
    // Half a pixel of slack: sub-pixel layout reports a link that fits
    // exactly as overflowing by a fraction, and the row would fold one away
    // for nothing.
    var pastEdge = function (el, limit) {
      return el.getBoundingClientRect().right > limit + 0.5;
    };
    var limit = edge;
    if (
      items.some(function (el) {
        return pastEdge(el, edge);
      })
    ) {
      var gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      limit = edge - (triggerWrap.offsetWidth + gap);
    } else {
      limit = Infinity;
    }

    var folded = 0;
    var holdsCurrent = false;
    items.forEach(function (el) {
      var out = pastEdge(el, limit);
      el.style.visibility = out ? "hidden" : "";
      var link = entry(el.getAttribute("data-priority-item"));
      if (link) {
        link.hidden = !out;
        if (out && link.getAttribute("aria-current") === "page") {
          holdsCurrent = true;
        }
      }
      if (out) folded++;
    });
    triggerWrap.style.visibility = folded ? "" : "hidden";
    triggerWrap.setAttribute("data-priority-overflow", String(folded));
    // The row's own marking of the current page goes with the link that
    // folded, so the trigger picks it up.
    if (holdsCurrent) trigger.setAttribute("data-current", "");
    else trigger.removeAttribute("data-current");
  }

  measure();
  window.addEventListener("resize", measure, { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    var observer = new ResizeObserver(measure);
    observer.observe(row);
    // The links too: a web font arriving re-widths every label without
    // resizing the row itself.
    items.forEach(function (el) {
      observer.observe(el);
    });
  }
  // Belt and braces where ResizeObserver is not the one that notices.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(measure).catch(function () {});
  }
})();
