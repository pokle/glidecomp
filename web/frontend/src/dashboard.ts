import { getCurrentUser, signOut, deleteAccount } from "./auth/client";

async function init() {
  const user = await getCurrentUser();

  // Guard: not authenticated
  if (!user) {
    window.location.href = "/login.html";
    return;
  }

  // Guard: no username yet
  if (!user.username) {
    window.location.href = "/onboarding.html";
    return;
  }

  // Show dashboard
  const container = document.getElementById("dashboard")!;
  container.classList.remove("hidden");

  document.getElementById("display-name")!.textContent = user.name;

  // Sign out
  document.getElementById("signout-btn")?.addEventListener("click", async () => {
    await signOut();
    window.location.href = "/";
  });

  // Delete account
  const deleteDialog = document.getElementById("delete-account-dialog") as HTMLDialogElement;

  document.getElementById("delete-account-btn")?.addEventListener("click", () => {
    deleteDialog.showModal();
  });

  document.getElementById("delete-cancel-btn")?.addEventListener("click", () => {
    deleteDialog.close();
  });

  document.getElementById("delete-confirm-btn")?.addEventListener("click", async (e) => {
    const btn = e.target as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Deleting...";

    const result = await deleteAccount();
    if (result.success) {
      localStorage.clear();
      indexedDB.deleteDatabase("taskscore");
      window.location.href = "/";
    } else {
      btn.disabled = false;
      btn.textContent = "Delete my account";
      alert(result.error || "Failed to delete account. Please try again.");
    }
  });
}

init();
