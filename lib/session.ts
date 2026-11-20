import { getAuth } from "./auth";

export async function requireSession(request: Request) {
  const { response, headers } = await getAuth().api.getSession({
    headers: request.headers,
    returnHeaders: true
  });
  const sessionHeaders = new Headers();
  for (const cookie of headers.getSetCookie()) sessionHeaders.append("Set-Cookie", cookie);
  return { session: response?.user ? response : null, sessionHeaders };
}

export function withSessionCookies(response: Response, sessionHeaders: Headers): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Vary", "Cookie");
  for (const cookie of sessionHeaders.getSetCookie()) headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}
