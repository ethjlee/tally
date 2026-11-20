import { redirectTo } from "../lib/http";
import { requireSession, withSessionCookies } from "../lib/session";
import { ownerExists } from "../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (!(await ownerExists())) return redirectTo(request, "/setup");
    const { session, sessionHeaders } = await requireSession(request);
    return withSessionCookies(redirectTo(request, session ? "/tally.html" : "/login"), sessionHeaders);
  } catch {
    return new Response(
      "Tally is not initialized yet. Run the database migration, then reload.",
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8"
        }
      }
    );
  }
}
