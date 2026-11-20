import { bindAuthForm, postJson } from "./auth-form.js";

fetch("/api/account", { credentials: "same-origin", cache: "no-store" })
  .then(response => response.ok ? response.json() : Promise.reject())
  .then(account => { document.getElementById("accountUsername").textContent = account.username; })
  .catch(() => window.location.replace("/login"));

bindAuthForm(document.getElementById("passwordForm"), {
  busyLabel: "Changing password…",
  networkError: "Tally could not reach the server. Try again.",
  validate(form) {
    if (form.elements.newPassword.value !== form.elements.confirmPassword.value) return "The new passwords do not match.";
  },
  async submit(form, status) {
    const response = await postJson("/api/auth/change-password", {
      currentPassword: form.elements.currentPassword.value,
      newPassword: form.elements.newPassword.value,
      revokeOtherSessions: true
    });
    if (!response.ok) {
      status.textContent = "The password could not be changed. Check your current password.";
      return;
    }
    form.reset();
    status.className = "form-status success";
    status.textContent = "Password changed. Other sessions were revoked.";
  }
});
