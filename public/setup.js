(() => {
  "use strict";
  const form = document.getElementById("setupForm");
  const status = document.getElementById("formStatus");
  const button = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.className = "form-status";
    status.textContent = "";
    if (!form.reportValidity()) return;
    if (form.password.value !== form.confirmPassword.value) {
      status.textContent = "The passwords do not match.";
      return;
    }
    button.disabled = true;
    button.textContent = "Creating owner…";

    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setupToken: form.setupToken.value,
          username: form.username.value,
          email: form.email.value,
          password: form.password.value
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
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
    } catch {
      status.textContent = "Tally could not reach the server. Check your connection and try again.";
    } finally {
      button.disabled = false;
      button.textContent = "Create owner account";
    }
  });
})();
