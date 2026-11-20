import { bindAuthForm, postJson } from "./auth-form.js";

bindAuthForm(document.getElementById("setupForm"), {
  busyLabel: "Creating owner…",
  validate(form) {
    if (form.elements.password.value !== form.elements.confirmPassword.value) return "The passwords do not match.";
  },
  async submit(form, status) {
    const response = await postJson("/api/setup", {
      setupToken: form.elements.setupToken.value,
      username: form.elements.username.value,
      email: form.elements.email.value,
      password: form.elements.password.value
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (result.error === "SETUP_ALREADY_COMPLETE") {
        window.location.replace("/login");
        return;
      }
      status.textContent = result.migrationRequired
        ? "The database is not initialized. Run the migration, then reload."
        : "Setup failed. Check the setup token and fields, then try again.";
      return;
    }
    status.className = "form-status success";
    status.textContent = "Owner created. Redirecting to private sign in…";
    form.reset();
    window.setTimeout(() => window.location.replace("/login"), 500);
  }
});
