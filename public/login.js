import { bindAuthForm, postJson } from "./auth-form.js";

bindAuthForm(document.getElementById("loginForm"), {
  busyLabel: "Signing in…",
  async submit(form, status) {
    const response = await postJson("/api/auth/sign-in/username", {
      username: form.elements.username.value,
      password: form.elements.password.value,
      rememberMe: true
    });
    if (response.ok) {
      window.location.replace("/");
      return;
    }
    status.textContent = response.status === 429
      ? "Too many attempts. Wait a minute and try again."
      : "The username or password is incorrect.";
  }
});
