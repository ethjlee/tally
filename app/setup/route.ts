import {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH
} from "../../lib/credentials";
import { redirectTo } from "../../lib/http";
import { ownerExists } from "../../lib/db";
import { securePage } from "../../lib/pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (await ownerExists()) {
      return redirectTo(request, "/login");
    }
  } catch {
    // Show setup; its API will explain if the database migration is missing.
  }

  return securePage({
    title: "Owner setup · Tally",
    heading: "Create the one owner",
    intro: "This screen works once. It requires the private setup token stored in Vercel.",
    script: "/setup.js",
    body: `
    <form id="setupForm" method="post" novalidate>
      <label for="setupToken">Setup token</label>
      <input id="setupToken" name="setupToken" type="password"
        autocomplete="off" minlength="32" maxlength="512" required>
      <span class="field-help">Paste TALLY_SETUP_TOKEN from your Vercel environment.</span>

      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username"
        autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9_]+"
        minlength="${MIN_USERNAME_LENGTH}" maxlength="${MAX_USERNAME_LENGTH}" required>

      <label for="email">Private account email</label>
      <input id="email" name="email" type="email" autocomplete="email"
        autocapitalize="none" spellcheck="false" maxlength="254" required>
      <span class="field-help">Stored in the auth database; never shown in the app. Automated email recovery is not configured.</span>

      <label for="password">Password</label>
      <input id="password" name="password" type="password"
        autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required>
      <label for="confirmPassword">Confirm password</label>
      <input id="confirmPassword" name="confirmPassword" type="password"
        autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required>

      <div class="form-status" id="formStatus" role="alert" aria-live="polite"></div>
      <button class="primary" type="submit" disabled>Create owner account</button>
    </form>
    <p class="privacy-note">Save the password in a password manager. After creation, this setup route locks itself.</p>`
  });
}
