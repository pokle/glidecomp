import { getCurrentUser, signInWithGoogle } from "./auth/client";

// Set up sign-in button immediately so it's always clickable
const btn = document.getElementById("google-signin");
btn?.addEventListener("click", () => {
  signInWithGoogle();
});

// Then check if already authenticated and redirect
getCurrentUser().then((user) => {
  if (user?.username) {
    window.location.href = `/u/${user.username}/`;
  } else if (user) {
    window.location.href = "/onboarding.html";
  }
}).catch(() => {
  // Auth service unavailable — button still works
});
