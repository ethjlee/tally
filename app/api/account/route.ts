import { privateJson } from "../../../lib/http";
import { requireSession } from "../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { session, sessionHeaders } = await requireSession(request);
  if (!session) {
    return privateJson({ authenticated: false }, { status: 401, headers: sessionHeaders });
  }

  const user = session.user as typeof session.user & { username?: string | null };
  return privateJson({
    authenticated: true,
    username: user.username || user.name
  }, { headers: sessionHeaders });
}
