(() => {
  "use strict";
  const form = document.getElementById("passwordForm");
  const status = document.getElementById("formStatus");
  const username = document.getElementById("accountUsername");
  const button = form.querySelector("button[type=submit]");

  fetch("/api/account", { credentials: "same-origin", cache: "no-store" })
    .then((response) => response.ok ? response.json() : Promise.reject())
    .then((account) => { username.textContent = account.username; })
    .catch(() => window.location.replace("/login"));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.className = "form-status";
    status.textContent = "";
    if (!form.reportValidity()) return;
    if (form.newPassword.value !== form.confirmPassword.value) {
      status.textContent = "The new passwords do not match.";
      return;
    }
    button.disabled = true;
    button.textContent = "Changing password…";

    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: form.currentPassword.value,
          newPassword: form.newPassword.value,
          revokeOtherSessions: true
        })
      });
      if (!response.ok) {
        status.textContent = "The password could not be changed. Check your current password.";
        return;
      }
      form.reset();
      status.className = "form-status success";
      status.textContent = "Password changed. Other sessions were revoked.";
    } catch {
      status.textContent = "Tally could not reach the server. Try again.";
    } finally {
      button.disabled = false;
      button.textContent = "Change password";
    }
  });
})();
