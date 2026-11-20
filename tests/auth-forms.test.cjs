const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { buildSync } = require("esbuild");
const { JSDOM } = require("jsdom");

const cases = [
  {
    page: "login", formId: "loginForm", endpoint: "/api/auth/sign-in/username",
    fields: { username: "owner", password: "test password" },
    payload: { username: "owner", password: "test password", rememberMe: true },
    code: 429, message: "Too many attempts. Wait a minute and try again."
  },
  {
    page: "setup", formId: "setupForm", endpoint: "/api/setup",
    fields: { setupToken: "setup", username: "owner", email: "owner@example.test", password: "new", confirmPassword: "new" },
    payload: { setupToken: "setup", username: "owner", email: "owner@example.test", password: "new" },
    code: 403, message: "Setup failed. Check the setup token and fields, then try again."
  },
  {
    page: "account", formId: "passwordForm", endpoint: "/api/auth/change-password",
    fields: { currentPassword: "old", newPassword: "new", confirmPassword: "new" },
    payload: { currentPassword: "old", newPassword: "new", revokeOtherSessions: true },
    code: 200, message: "Password changed. Other sessions were revoked."
  }
];

for (const scenario of cases) {
  test(`${scenario.page} submits the expected account request and restores the form`, async () => {
    const source = readFileSync(`app/${scenario.page}/route.ts`, "utf8");
    const markup = source.match(/<form\b[\s\S]*?<\/form>/)[0];
    const dom = new JSDOM(`<span id="accountUsername"></span>${markup}`, { runScripts: "outside-only" });
    try {
      const { window } = dom;
      const form = window.document.getElementById(scenario.formId);
      const button = form.querySelector('button[type="submit"]');
      const label = button.textContent;
      assert.equal(form.method, "post");
      assert.equal(button.disabled, true);
      const status = form.querySelector('[role="alert"]');
      const requests = [];
      let finishRequest;
      window.fetch = (url, options) => {
        if (url === "/api/account") return Promise.resolve(Response.json({ username: "owner" }));
        requests.push({ url, options });
        return new Promise(resolve => { finishRequest = resolve; });
      };
      const { outputFiles } = buildSync({
        entryPoints: [`public/${scenario.page}.js`], bundle: true, format: "iife", write: false
      });
      window.eval(outputFiles[0].text);
      assert.equal(button.disabled, false);
      for (const [key, value] of Object.entries(scenario.fields)) form.elements[key].value = value;
      const submit = () => form.dispatchEvent(new window.Event("submit", { cancelable: true }));
      if (form.elements.confirmPassword) {
        form.elements.confirmPassword.value = "mismatch";
        submit();
        assert.match(status.textContent, /passwords do not match/);
        assert.equal(requests.length, 0);
        form.elements.confirmPassword.value = scenario.fields.confirmPassword;
      }
      submit();
      submit();
      assert.equal(button.disabled, true);
      assert.equal(requests.length, 1);
      const [{ url, options }] = requests;
      assert.equal(url, scenario.endpoint);
      assert.equal(options.method, "POST");
      assert.equal(options.credentials, "same-origin");
      assert.deepEqual(JSON.parse(options.body), scenario.payload);
      finishRequest(Response.json({}, { status: scenario.code }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(status.textContent, scenario.message);
      assert.equal(button.disabled, false);
      assert.equal(button.textContent, label);
    } finally {
      dom.window.close();
    }
  });
}
