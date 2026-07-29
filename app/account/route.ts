import { auth } from "../../lib/auth";
import { pageResponse, securePage } from "../../lib/pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return Response.redirect(new URL("/login", request.url), 303);
  }

  return pageResponse(
    securePage({
      title: "Account security · Tally",
      heading: "Account security",
      intro: "Change your password or return to your private ledger.",
      script: "/account.js",
      body: `
      <p class="signed-in">Signed in as <strong id="accountUsername">…</strong></p>
      <form id="passwordForm" novalidate>
        <label for="currentPassword">Current password</label>
        <input id="currentPassword" name="currentPassword" type="password"
          autocomplete="current-password" maxlength="128" required>
        <label for="newPassword">New password</label>
        <input id="newPassword" name="newPassword" type="password"
          autocomplete="new-password" minlength="14" maxlength="128" required>
        <label for="confirmPassword">Confirm new password</label>
        <input id="confirmPassword" name="confirmPassword" type="password"
          autocomplete="new-password" minlength="14" maxlength="128" required>
        <div class="form-status" id="formStatus" role="alert" aria-live="polite"></div>
        <button class="primary" type="submit">Change password</button>
      </form>
      <div class="secondary-actions">
        <a class="button-link" href="/">Return to Tally</a>
      </div>
      <p class="privacy-note">Changing the password revokes your other sessions. Your separate data-encryption key remains unchanged.</p>`
    })
  );
}
