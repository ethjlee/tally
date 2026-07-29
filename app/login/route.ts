import { auth } from "../../lib/auth";
import { ownerExists } from "../../lib/db";
import { pageResponse, securePage } from "../../lib/pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (!(await ownerExists())) {
      return Response.redirect(new URL("/setup", request.url), 303);
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (session?.user) {
      return Response.redirect(new URL("/", request.url), 303);
    }
  } catch {
    // The form will present a generic service error if setup is incomplete.
  }

  return pageResponse(
    securePage({
      title: "Sign in · Tally",
      heading: "Private sign in",
      intro: "Your ledger is available only after the server verifies your account.",
      script: "/login.js",
      body: `
      <form id="loginForm" novalidate>
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username"
          autocapitalize="none" spellcheck="false" minlength="3" maxlength="30" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password"
          autocomplete="current-password" minlength="14" maxlength="128" required>
        <div class="form-status" id="formStatus" role="alert" aria-live="polite"></div>
        <button class="primary" type="submit">Sign in</button>
      </form>
      <p class="privacy-note">No public registration. No analytics. Ledger requests are never cached.</p>`
    })
  );
}
