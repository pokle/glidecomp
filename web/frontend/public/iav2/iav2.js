/*
 * IA v2 mockup runtime — injects the shared chrome (banner, header tabs,
 * footer, role switcher, toasts) and wires the mock interactions. Pure
 * vanilla JS, no dependencies, isolated to /iav2/.
 *
 * Roles: out | pilot | admin | super. Persisted in localStorage and applied
 * as html[data-role]; iav2.css hides .need-auth/.need-admin/.need-super and
 * .only-out elements accordingly.
 */
(function () {
  const ROLES = [
    ["out", "Signed out"],
    ["pilot", "Pilot"],
    ["admin", "Comp admin"],
    ["super", "Super admin"],
  ];
  const WHO = { pilot: "Asha Patel", admin: "Jane Meadows", super: "Tushar Pokle" };

  function getRole() {
    const r = localStorage.getItem("iav2-role");
    return ROLES.some(([k]) => k === r) ? r : "out";
  }
  function setRole(r) {
    localStorage.setItem("iav2-role", r);
    document.documentElement.dataset.role = r;
    document.querySelectorAll("#roles button[data-role]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.role === r));
    });
    const who = document.querySelector(".menu .who");
    if (who && WHO[r]) who.textContent = `Signed in as ${WHO[r]} (mock)`;
    const av = document.querySelector(".avatar-btn");
    if (av && WHO[r]) av.textContent = WHO[r].split(" ").map((w) => w[0]).join("");
  }
  document.documentElement.dataset.role = getRole();

  // ---------- toasts ----------
  window.toast = function (msg) {
    let host = document.getElementById("toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "toasts";
      document.body.appendChild(host);
    }
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  };

  // ---------- chrome ----------
  const body = document.body;
  const page = body.dataset.page || "";
  const chrome = body.dataset.chrome || "tabs";

  const banner =
    '<div class="mock-banner">IA v2 mockup — every link works, all data is fake · ' +
    '<a href="https://github.com/pokle/glidecomp/issues/277" target="_blank" rel="noopener">issue #277</a> · ' +
    '<a href="https://github.com/pokle/glidecomp/pull/285" target="_blank" rel="noopener">PR #285</a></div>';

  if (chrome === "tabs") {
    const header = `
      ${banner}
      <header class="site"><nav aria-label="Main">
        <a href="/iav2/" class="brand">GlideComp</a>
        <a href="/iav2/comp.html" class="navlink" ${page === "comp" ? 'aria-current="page"' : ""}>Competitions</a>
        <a href="/iav2/flights.html" class="navlink" ${page === "flights" ? 'aria-current="page"' : ""}>My Flights</a>
        <div class="nav-right">
          <button type="button" class="btn only-out" data-signin>Sign in</button>
          <button type="button" class="avatar-btn need-auth" data-usermenu aria-label="Account menu">AP</button>
          <div class="menu need-auth" id="usermenu">
            <div class="who">Signed in as Asha Patel (mock)</div>
            <a href="/iav2/settings.html">Settings</a>
            <button type="button" data-signout>Sign out</button>
          </div>
        </div>
      </nav></header>`;
    body.insertAdjacentHTML("afterbegin", header);

    const footer = `
      <footer class="site"><div class="inner">
        <span>GlideComp <a href="https://github.com/pokle/glidecomp" target="_blank" rel="noopener">iav2-mock</a></span>
        <a href="/iav2/static.html?p=About">About</a>
        <a href="/iav2/static.html?p=Scoring">Scoring</a>
        <a href="/iav2/static.html?p=Privacy+%26+Terms">Privacy &amp; Terms</a>
        <a href="https://github.com/pokle/glidecomp" target="_blank" rel="noopener">GitHub</a>
        <a href="/iav2/static.html?p=YouTube">YouTube</a>
      </div></footer>`;
    body.insertAdjacentHTML("beforeend", footer);
  } else if (chrome === "tool") {
    body.insertAdjacentHTML("afterbegin", '<a class="backpill" href="/iav2/comp-corryong.html">&larr; GlideComp</a>');
  } else {
    body.insertAdjacentHTML("afterbegin", banner);
  }

  // ---------- role switcher ----------
  const switcher = document.createElement("div");
  switcher.id = "roles";
  switcher.innerHTML =
    '<span class="lbl">Preview as</span>' +
    ROLES.map(([k, label]) => `<button type="button" data-role="${k}">${label}</button>`).join("");
  document.body.appendChild(switcher);
  switcher.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-role]");
    if (b) {
      setRole(b.dataset.role);
      toast(`Previewing as: ${b.textContent}`);
    }
  });
  setRole(getRole());

  // ---------- shared interactions ----------
  document.addEventListener("click", (e) => {
    const t = e.target;

    const signin = t.closest("[data-signin]");
    if (signin) {
      setRole("pilot");
      toast("Signed in with Google as Asha Patel (mock)");
      return;
    }
    const signout = t.closest("[data-signout]");
    if (signout) {
      setRole("out");
      toast("Signed out (mock)");
      document.getElementById("usermenu")?.classList.remove("open");
      return;
    }
    const um = t.closest("[data-usermenu]");
    const menu = document.getElementById("usermenu");
    if (um && menu) {
      menu.classList.toggle("open");
      return;
    }
    if (menu && !t.closest("#usermenu")) menu.classList.remove("open");

    // open a <dialog> by id
    const opener = t.closest("[data-open]");
    if (opener) {
      if (opener.tagName === "A") e.preventDefault();
      const d = document.getElementById(opener.dataset.open);
      if (d) d.showModal();
      return;
    }
    // close the containing dialog
    const closer = t.closest("[data-close]");
    if (closer) {
      closer.closest("dialog")?.close();
      return;
    }
    // mock action: toast + close containing dialog if any
    const mock = t.closest("[data-toast]");
    if (mock) {
      if (mock.tagName === "A") e.preventDefault();
      toast(mock.dataset.toast);
      mock.closest("dialog")?.close();
      return;
    }
    // rows that act as links
    const row = t.closest("[data-href]");
    if (row && !t.closest("a, button, select, input, label")) {
      window.location.href = row.dataset.href;
    }
  });

  // click on ::backdrop closes dialogs
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    });
  });

  // ---------- tab bars ----------
  document.querySelectorAll(".tabbar").forEach((bar) => {
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-tab]");
      if (!b) return;
      const scope = bar.dataset.scope || "";
      bar.querySelectorAll("button[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      document.querySelectorAll(`.tabpanel[data-scope="${scope}"]`).forEach((p) => {
        p.classList.toggle("active", p.dataset.panel === b.dataset.tab);
      });
    });
  });

  // ---------- task picker (Results by task) ----------
  document.querySelectorAll("[data-taskpicker]").forEach((sel) => {
    sel.addEventListener("change", () => {
      document.querySelectorAll("[data-taskresult]").forEach((p) => {
        p.style.display = p.dataset.taskresult === sel.value ? "" : "none";
      });
    });
  });

  // ---------- whole-page drop target (My Flights) ----------
  if (body.dataset.drop === "1") {
    const overlay = document.createElement("div");
    overlay.id = "dropzone";
    overlay.textContent = "Drop .igc files to upload";
    document.body.appendChild(overlay);
    let depth = 0;
    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      depth++;
      overlay.classList.add("show");
    });
    window.addEventListener("dragleave", () => {
      if (--depth <= 0) {
        depth = 0;
        overlay.classList.remove("show");
      }
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      overlay.classList.remove("show");
      toast("Uploaded 1 track (mock)");
    });
  }
})();
