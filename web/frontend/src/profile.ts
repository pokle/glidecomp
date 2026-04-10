import { signInWithGoogle } from "./auth/client";
import { initNav } from "./nav";
import { api } from "./comp/api";

interface PilotProfile {
  name: string;
  civl_id: string | null;
  safa_id: string | null;
  ushpa_id: string | null;
  bhpa_id: string | null;
  dhv_id: string | null;
  ffvl_id: string | null;
  fai_id: string | null;
  phone: string | null;
  glider: string | null;
}

const PROFILE_FIELDS = [
  { key: "name", el: "profile-name" },
  { key: "civl_id", el: "profile-civl" },
  { key: "safa_id", el: "profile-safa" },
  { key: "ushpa_id", el: "profile-ushpa" },
  { key: "bhpa_id", el: "profile-bhpa" },
  { key: "dhv_id", el: "profile-dhv" },
  { key: "ffvl_id", el: "profile-ffvl" },
  { key: "fai_id", el: "profile-fai" },
  { key: "phone", el: "profile-phone" },
  { key: "glider", el: "profile-glider" },
] as const;

async function init() {
  const user = await initNav({ active: "profile" });
  document.getElementById("profile-page")!.classList.remove("hidden");

  if (!user) {
    document.getElementById("profile-loading")!.classList.add("hidden");
    document.getElementById("profile-signed-out")!.classList.remove("hidden");
    document.getElementById("profile-signin-btn")!.addEventListener("click", () => signInWithGoogle());
    return;
  }

  document.title = `GlideComp - Profile`;

  // Load profile
  let profile: PilotProfile;
  try {
    const res = await api.api.comp.pilot.$get();
    if (!res.ok) {
      showError("Failed to load profile");
      return;
    }
    profile = (await res.json()) as PilotProfile;
  } catch {
    showError("Network error loading profile");
    return;
  }

  // Populate form
  for (const field of PROFILE_FIELDS) {
    const el = document.getElementById(field.el) as HTMLInputElement;
    el.value = (profile[field.key] as string | null) ?? "";
  }

  document.getElementById("profile-loading")!.classList.add("hidden");
  document.getElementById("profile-content")!.classList.remove("hidden");

  // Wire save
  const form = document.getElementById("profile-form") as HTMLFormElement;
  const saveBtn = document.getElementById("profile-save-btn") as HTMLButtonElement;
  const statusEl = document.getElementById("profile-status")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    statusEl.classList.add("hidden");

    /**
     * Build a sparse PATCH payload: every field is sent (the server treats
     * missing fields as unchanged). Empty-string inputs are normalised to
     * null so cleared IDs are persisted as nulls rather than empty strings.
     */
    const payload: Record<string, string | null> = {};
    for (const field of PROFILE_FIELDS) {
      const el = document.getElementById(field.el) as HTMLInputElement;
      const value = el.value.trim();
      payload[field.key] = value === "" ? null : value;
    }
    // Name is required — don't send null
    if (payload.name === null) {
      showStatus("Display name is required", "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save profile";
      return;
    }

    try {
      const res = await api.api.comp.pilot.$patch({
        json: payload as never,
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        showStatus(err.error || "Failed to save profile", "error");
        return;
      }
      showStatus(
        "Profile saved. Any matching competition registrations have been linked to this account.",
        "success"
      );
    } catch {
      showStatus("Network error. Please try again.", "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save profile";
    }
  });

  function showStatus(message: string, kind: "success" | "error") {
    statusEl.textContent = message;
    statusEl.classList.remove("hidden", "bg-destructive/10", "text-destructive", "bg-green-500/10", "text-green-500");
    if (kind === "error") {
      statusEl.classList.add("bg-destructive/10", "text-destructive");
    } else {
      statusEl.classList.add("bg-green-500/10", "text-green-500");
    }
  }
}

function showError(message: string) {
  document.getElementById("profile-loading")!.classList.add("hidden");
  const empty = document.getElementById("profile-signed-out")!;
  empty.classList.remove("hidden");
  empty.querySelector("p")!.textContent = message;
}

init();
