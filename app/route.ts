import { auth } from "../lib/auth";
import { ownerExists } from "../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirect(request: Request, destination: string): Response {
  return Response.redirect(new URL(destination, request.url), 303);
}

export async function GET(request: Request) {
  try {
    if (!(await ownerExists())) return redirect(request, "/setup");
    const session = await auth.api.getSession({ headers: request.headers });
    return redirect(request, session?.user ? "/tally.html" : "/login");
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
