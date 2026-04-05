import { getCurrentUser, signInWithGoogle, signOut } from "./auth/client";
import { api } from "./comp/api";

// ── Types ────────────────────────────────────────────────────────────────────

interface Comp {
  comp_id: string;
  name: string;
  category: string;
  creation_date: string;
  pilot_classes: string[];
  is_admin: boolean;
  test: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function categoryLabel(cat: string): string {
  return cat === "hg" ? "HG" : "PG";
}

function createCompCard(comp: Comp): HTMLElement {
  const a = document.createElement("a");
  a.href = `/comp/${comp.comp_id}`;
  a.className =
    "flex items-center justify-between rounded-lg border border-border/50 px-4 py-3 hover:bg-muted/50 transition-colors";

  const badges: string[] = [];
  badges.push(
    `<span class="inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
      comp.category === "hg"
        ? "bg-amber-500/10 text-amber-500"
        : "bg-sky-500/10 text-sky-500"
    }">${categoryLabel(comp.category)}</span>`
  );
  if (comp.test) {
    badges.push(
      `<span class="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">Test</span>`
    );
  }

  a.innerHTML = `
    <div class="flex-1 min-w-0">
      <div class="font-medium text-sm text-foreground truncate">${escapeHtml(comp.name)}</div>
      <div class="flex items-center gap-2 mt-1">
        ${badges.join("")}
        <span class="text-xs text-muted-foreground">${escapeHtml(comp.pilot_classes.join(", "))}</span>
        <span class="text-xs text-muted-foreground/60">${formatDate(comp.creation_date)}</span>
      </div>
    </div>
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground/40 shrink-0">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  `;
  return a;
}

function escapeHtml(str: string): string {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

// ── Main init ────────────────────────────────────────────────────────────────

async function init() {
  const user = await getCurrentUser();

  if (!user) {
    signInWithGoogle();
    return;
  }

  if (!user.username) {
    window.location.href = "/onboarding.html";
    return;
  }

  // Show page
  const page = document.getElementById("comp-page")!;
  page.classList.remove("hidden");

  // Header
  document.getElementById("user-name")!.textContent = user.name;
  document.getElementById("signout-btn")?.addEventListener("click", async () => {
    await signOut();
    window.location.href = "/";
  });

  // DOM refs
  const adminCompsEl = document.getElementById("admin-comps")!;
  const adminEmptyEl = document.getElementById("admin-empty")!;
  const publicCompsEl = document.getElementById("public-comps")!;
  const publicEmptyEl = document.getElementById("public-empty")!;
  const createDialog = document.getElementById("create-comp-dialog") as HTMLDialogElement;
  const createForm = document.getElementById("create-comp-form") as HTMLFormElement;
  const nameInput = document.getElementById("comp-name") as HTMLInputElement;
  const pilotClassesInput = document.getElementById("pilot-classes") as HTMLInputElement;
  const testCheckbox = document.getElementById("comp-test") as HTMLInputElement;
  const submitBtn = document.getElementById("create-submit-btn") as HTMLButtonElement;

  // ── Load competitions ─────────────────────────────────────────────────────

  async function loadComps() {
    const res = await api.api.comp.$get();
    if (!res.ok) return;
    const data = await res.json();
    const comps = data.comps as unknown as Comp[];

    const adminComps = comps.filter((c) => c.is_admin);
    const publicComps = comps.filter((c) => !c.is_admin);

    adminCompsEl.innerHTML = "";
    if (adminComps.length > 0) {
      adminEmptyEl.classList.add("hidden");
      adminComps.forEach((c) => adminCompsEl.appendChild(createCompCard(c)));
    } else {
      adminEmptyEl.classList.remove("hidden");
    }

    publicCompsEl.innerHTML = "";
    if (publicComps.length > 0) {
      publicEmptyEl.classList.add("hidden");
      publicComps.forEach((c) => publicCompsEl.appendChild(createCompCard(c)));
    } else {
      publicEmptyEl.classList.remove("hidden");
    }
  }

  await loadComps();

  // ── Create competition ────────────────────────────────────────────────────

  document.getElementById("create-comp-btn")!.addEventListener("click", () => {
    nameInput.value = "";
    pilotClassesInput.value = "open";
    testCheckbox.checked = false;
    (createForm.querySelector('input[name="category"][value="hg"]') as HTMLInputElement).checked = true;
    createDialog.showModal();
  });

  document.getElementById("create-cancel-btn")!.addEventListener("click", () => {
    createDialog.close();
  });

  createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating...";

    const name = nameInput.value.trim();
    const category = (createForm.querySelector('input[name="category"]:checked') as HTMLInputElement).value as "hg" | "pg";
    const pilotClasses = pilotClassesInput.value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const test = testCheckbox.checked;

    try {
      const res = await api.api.comp.$post({
        json: {
          name,
          category,
          pilot_classes: pilotClasses.length > 0 ? pilotClasses : ["open"],
          test,
        },
      });

      if (!res.ok) {
        const err = await res.json();
        alert((err as { error?: string }).error || "Failed to create competition");
        return;
      }

      const data = await res.json();
      createDialog.close();
      // Navigate to the new competition
      window.location.href = `/comp/${(data as { comp_id: string }).comp_id}`;
    } catch {
      alert("Network error. Please try again.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
    }
  });
}

init();
