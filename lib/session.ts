import { auth } from "./auth";

export async function requireSession(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ? session : null;
}
