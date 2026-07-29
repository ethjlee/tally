export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Cookie"
} as const;

export function privateJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(PRIVATE_HEADERS);
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function sameOrigin(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (origin && origin !== requestOrigin) return false;
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}

export async function readLimitedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("INVALID_JSON");
  }
}
