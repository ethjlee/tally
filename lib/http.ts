export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Cookie"
} as const;

export function privateJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(PRIVATE_HEADERS);
  if (init.headers) {
    const extra = new Headers(init.headers);
    extra.forEach((value, key) => {
      if (key !== "set-cookie") headers.set(key, value);
    });
    for (const cookie of extra.getSetCookie()) headers.append("Set-Cookie", cookie);
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
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_JSON");
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error("PAYLOAD_TOO_LARGE");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(chunks.join(""));
  } catch {
    throw new Error("INVALID_JSON");
  }
}
