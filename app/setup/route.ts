import { ownerExists } from "../../lib/db";
import { pageResponse, securePage } from "../../lib/pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (await ownerExists()) {
      return Response.redirect(new URL("/login", request.url), 303);
    }
  } catch {
    // Show setup; its API will explain if the database migration is missing.
  }

  return pageResponse(
    securePage({
      title: "Owner setup · Tally",
      heading: "Create the one owner",
      intro: "This screen works once. It requires the private setup token stored in Vercel.",
      script: "/setup.js",
      body: `
      <form id="setupForm" novalidate>
        <label for="setupToken">Setup token</label>
        <input id="setupToken" name="setupToken" type="password"
          autocomplete="off" minlength="32" maxlength="512" required>
        <span class="field-help">Paste TALLY_SETUP_TOKEN from your Vercel environment.</span>

        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username"
          autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9_]+"
          minlength="3" maxlength="30" required>

        <label for="email">Private account email</label>
        <input id="email" name="email" type="email" autocomplete="email"
          autocapitalize="none" spellcheck="false" maxlength="254" required>
        <span class="field-help">Stored in the auth database; never shown in the app. Automated email recovery is not configured.</span>

        <label for="password">Password</label>
        <input id="password" name="password" type="password"
          autocomplete="new-password" minlength="14" maxlength="128" required>
        <label for="confirmPassword">Confirm password</label>
        <input id="confirmPassword" name="confirmPassword" type="password"
          autocomplete="new-password" minlength="14" maxlength="128" required>

        <div class="form-status" id="formStatus" role="alert" aria-live="polite"></div>
        <button class="primary" type="submit">Create owner account</button>
      </form>
      <p class="privacy-note">Save the password in a password manager. After creation, this setup route locks itself.</p>`
    })
  );
}
