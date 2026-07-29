(() => {
  "use strict";
  const form = document.getElementById("loginForm");
  const status = document.getElementById("formStatus");
  const button = form.querySelector("button[type=submit]");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    if (!form.reportValidity()) return;
    button.disabled = true;
    button.textContent = "Signing in…";

    try {
      const response = await fetch("/api/auth/sign-in/username", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.username.value,
          password: form.password.value,
          rememberMe: true
        })
      });
      if (!response.ok) {
        status.textContent = response.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "The username or password is incorrect.";
        return;
      }
      window.location.replace("/");
    } catch {
      status.textContent = "Tally could not reach the server. Check your connection and try again.";
    } finally {
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });
})();
