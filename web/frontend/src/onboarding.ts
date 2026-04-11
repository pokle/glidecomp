import './theme';
import { getCurrentUser, setUsername } from "./auth/client";
import { api } from "./comp/api";

async function init() {
  const user = await getCurrentUser();

  // Guard: not authenticated
  if (!user) {
    window.location.href = "/u/me/";
    return;
  }

  // Guard: already has username (onboarding is complete)
  if (user.username) {
    window.location.href = `/u/${user.username}/`;
    return;
  }

  // Show onboarding UI
  const container = document.getElementById("onboarding")!;
  container.classList.remove("hidden");

  // Populate user info: avatar + greeting + pre-filled name
  const firstName = user.name.split(" ")[0] || user.name;
  document.getElementById("user-greeting")!.textContent = firstName;
  if (user.image) {
    const avatar = document.getElementById("user-avatar")!;
    const img = document.createElement("img");
    img.src = user.image;
    img.alt = user.name;
    img.className = "w-full h-full object-cover";
    avatar.appendChild(img);
  }

  const nameInput = document.getElementById("onboarding-name") as HTMLInputElement;
  const usernameInput = document.getElementById("username") as HTMLInputElement;
  const civlInput = document.getElementById("onboarding-civl") as HTMLInputElement;
  const safaInput = document.getElementById("onboarding-safa") as HTMLInputElement;
  const usernameErrorEl = document.getElementById("username-error")!;
  const generalErrorEl = document.getElementById("onboarding-error")!;
  const submitBtn = document.getElementById("onboarding-submit") as HTMLButtonElement;
  const form = document.getElementById("onboarding-form") as HTMLFormElement;

  // Pre-fill full name from auth user.name so most pilots can just tab past.
  nameInput.value = user.name;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    usernameErrorEl.classList.add("hidden");
    generalErrorEl.classList.add("hidden");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving...";

    const username = usernameInput.value.trim();
    const name = nameInput.value.trim();
    const civlId = civlInput.value.trim();
    const safaId = safaInput.value.trim();

    /**
     * Onboarding commits two things in order:
     *   1. Username via Better Auth's set-username endpoint. This is the
     *      gate — if it fails (e.g. taken), we abort before writing the
     *      pilot profile so the user can retry without creating a
     *      half-formed pilot row.
     *   2. Pilot profile via PATCH /api/comp/pilot. This creates the
     *      pilot row if it doesn't exist yet. Adding a CIVL or SAFA ID
     *      here also immediately triggers the signup linker (Iteration
     *      8g), so any admin-pre-registered comp entries get claimed.
     */
    const usernameResult = await setUsername(username);
    if (usernameResult.error) {
      usernameErrorEl.textContent = usernameResult.error;
      usernameErrorEl.classList.remove("hidden");
      submitBtn.disabled = false;
      submitBtn.textContent = "Continue";
      return;
    }

    try {
      const res = await api.api.comp.pilot.$patch({
        json: {
          name,
          civl_id: civlId === "" ? null : civlId,
          safa_id: safaId === "" ? null : safaId,
        } as never,
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        generalErrorEl.textContent =
          err.error || "Could not save profile. You can update it later on your profile page.";
        generalErrorEl.classList.remove("hidden");
        // Username is already saved, so proceed to the dashboard anyway
        // after a short delay so the user sees the message.
        setTimeout(() => {
          window.location.href = `/u/${usernameResult.username}/`;
        }, 2000);
        return;
      }
    } catch {
      // Profile save failed (likely network). Username is already set, so
      // continue to the dashboard — the user can fill in profile details
      // later from the /profile page.
      generalErrorEl.textContent =
        "Could not save pilot details right now. You can add them later on your profile page.";
      generalErrorEl.classList.remove("hidden");
      setTimeout(() => {
        window.location.href = `/u/${usernameResult.username}/`;
      }, 2000);
      return;
    }

    window.location.href = `/u/${usernameResult.username}/`;
  });
}

init();
