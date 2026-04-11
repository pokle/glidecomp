import { getCurrentUser, signOut, signInWithGoogle } from "./auth/client";
import type { AuthUser } from "./auth/client";

type NavActive = "flights" | "competitions" | "profile";

function navAttrs(isActive: boolean, extraClasses: string = ""): string {
  const cls = [
    isActive ? "btn btn-secondary btn-sm text-xs font-bold" : "btn btn-ghost btn-sm text-xs font-bold",
    extraClasses,
  ].filter(Boolean).join(" ");
  const style = isActive ? ' style="outline: 3px solid #BCC817; outline-offset: 3px;"' : "";
  return `class="${cls}"${style}`;
}

function buildNavHTML(active?: NavActive): string {
  return `<header class="border-b border-border/50 backdrop-blur-sm bg-background/80 sticky top-0 z-10">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
    <a id="nav-logo" href="/" class="inline-flex items-center gap-2 text-lg font-bold tracking-tight text-foreground hover:text-primary transition-colors" style="font-family: 'Alte Haas Grotesk', sans-serif;">
      <img src="/icon.svg" alt="GlideComp logo" class="w-6 h-6" />
      GlideComp
    </a>
    <div class="flex items-center gap-1">
      <a id="nav-my-flights" href="/u/me/" ${navAttrs(active === "flights")}>My Flights</a>
      <a href="/comp" ${navAttrs(active === "competitions")}>Competitions</a>
      <a href="/profile" id="nav-profile-link" ${navAttrs(active === "profile", "hidden")}>My Profile</a>
      <button id="signin-btn" class="hidden btn btn-ghost btn-sm text-xs font-bold">Sign in</button>
    </div>
  </div>
</header>`;
}

function buildFooterHTML(): string {
  return `<footer class="border-t border-border/30 py-6">
  <div class="max-w-3xl mx-auto px-4 sm:px-6 flex items-center justify-between text-xs text-muted-foreground/60">
    <span>GlideComp</span>
    <div class="flex items-center gap-4">
      <a href="https://github.com/pokle/glidecomp" target="_blank" rel="noopener noreferrer" class="hover:text-foreground transition-colors inline-flex items-center gap-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
        GitHub
      </a>
      <a href="https://www.youtube.com/@poklet" target="_blank" rel="noopener noreferrer" class="hover:text-foreground transition-colors inline-flex items-center gap-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
        YouTube
      </a>
      <a href="/theme-editor" class="hover:text-foreground transition-colors">Theme Editor</a>
      <a href="/legal.html" class="hover:text-foreground transition-colors">Privacy &amp; Terms</a>
      <button id="signout-btn" class="hidden hover:text-foreground transition-colors cursor-pointer">Sign out</button>
    </div>
  </div>
</footer>`;
}

/**
 * Injects the shared navbar and footer, wires up auth state, and returns
 * the current user (or null if not logged in). Callers avoid a second
 * getCurrentUser() call by using the returned value directly.
 */
export async function initNav(options?: { active?: NavActive }): Promise<AuthUser | null> {
  const navRoot = document.getElementById("app-nav")!;
  navRoot.outerHTML = buildNavHTML(options?.active);

  const footerRoot = document.getElementById("app-footer");
  if (footerRoot) footerRoot.outerHTML = buildFooterHTML();

  const user = await getCurrentUser();
  if (user) {
    (document.getElementById("nav-logo") as HTMLAnchorElement).href = `/u/${user.username}/`;
    (document.getElementById("nav-my-flights") as HTMLAnchorElement).href = `/u/${user.username}/`;
    document.getElementById("nav-profile-link")!.classList.remove("hidden");
    document.getElementById("signout-btn")!.classList.remove("hidden");
    document.getElementById("signout-btn")!.addEventListener("click", async () => {
      await signOut();
      window.location.href = "/";
    });
  } else {
    document.getElementById("signin-btn")!.classList.remove("hidden");
    document.getElementById("signin-btn")!.addEventListener("click", () => signInWithGoogle());
  }
  return user;
}
