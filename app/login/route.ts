import {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH
} from "../../lib/credentials";
import { redirectTo } from "../../lib/http";
import { requireSession, withSessionCookies } from "../../lib/session";
import { ownerExists } from "../../lib/db";
import { securePage } from "../../lib/pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let sessionHeaders = new Headers();
  try {
    if (!(await ownerExists())) {
      return redirectTo(request, "/setup");
    }
    const result = await requireSession(request);
    sessionHeaders = result.sessionHeaders;
    if (result.session) {
      return withSessionCookies(redirectTo(request, "/"), sessionHeaders);
    }
  } catch {
    // The form will present a generic service error if setup is incomplete.
  }

  return withSessionCookies(securePage({
    title: "Sign in · Tally",
    heading: "Private sign in",
    intro: "Your ledger is available only after the server verifies your account.",
    script: "/login.js",
    body: `
    <form id="loginForm" method="post" novalidate>
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username"
        autocapitalize="none" spellcheck="false" minlength="${MIN_USERNAME_LENGTH}" maxlength="${MAX_USERNAME_LENGTH}" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password"
        autocomplete="current-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required>
      <div class="form-status" id="formStatus" role="alert" aria-live="polite"></div>
      <button class="primary" type="submit" disabled>Sign in</button>
    </form>
    <p class="privacy-note">No public registration. No analytics. Ledger requests are never cached.</p>`
  }), sessionHeaders);
}
