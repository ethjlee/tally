export function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export function bindAuthForm(form, {
  busyLabel,
  validate,
  submit,
  networkError = "Tally could not reach the server. Check your connection and try again."
}) {
  const status = form.querySelector('[role="alert"]');
  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (button.disabled) return;
    status.className = "form-status";
    status.textContent = "";
    if (!form.reportValidity()) return;
    const error = validate?.(form);
    if (error) {
      status.textContent = error;
      return;
    }

    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await submit(form, status);
    } catch {
      status.textContent = networkError;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  button.disabled = false;
}
