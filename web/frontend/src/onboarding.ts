import { getCurrentUser, setUsername } from "./auth/client";

async function init() {
  const user = await getCurrentUser();

  // Guard: not authenticated
  if (!user) {
    window.location.href = "/u/me/";
    return;
  }

  // Guard: already has username
  if (user.username) {
    window.location.href = `/u/${user.username}/`;
    return;
  }

  // Show onboarding UI
  const container = document.getElementById("onboarding")!;
  container.classList.remove("hidden");

  // Populate user info
  document.getElementById("user-name")!.textContent = user.name;
  if (user.image) {
    const avatar = document.getElementById("user-avatar")!;
    const img = document.createElement("img");
    img.src = user.image;
    img.alt = user.name;
    img.className = "w-full h-full object-cover";
    avatar.appendChild(img);
  }

  // Handle form submission
  const form = document.getElementById("username-form") as HTMLFormElement;
  const input = document.getElementById("username") as HTMLInputElement;
  const errorEl = document.getElementById("username-error")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");

    const username = input.value.trim();
    const result = await setUsername(username);

    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.classList.remove("hidden");
      return;
    }

    window.location.href = `/u/${result.username}/`;
  });
}

init();
