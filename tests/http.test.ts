import assert from "node:assert/strict";
import { test } from "node:test";
import {
  privateJson,
  readLimitedJson,
  sameOrigin
} from "../lib/http";

test("same-origin mutation guard rejects cross-site origins and fetch metadata", () => {
  assert.equal(sameOrigin(new Request("https://tally.example/api/sync", {
    method: "PUT",
    headers: {
      origin: "https://tally.example",
      "sec-fetch-site": "same-origin"
    }
  })), true);

  assert.equal(sameOrigin(new Request("https://tally.example/api/sync", {
    method: "PUT",
    headers: { origin: "https://attacker.example" }
  })), false);

  assert.equal(sameOrigin(new Request("https://tally.example/api/sync", {
    method: "PUT",
    headers: { "sec-fetch-site": "cross-site" }
  })), false);
});

test("private JSON responses cannot be cached", async () => {
  const response = privateJson({ secret: "value" });
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(await response.json(), { secret: "value" });
});

test("private JSON preserves separate session renewal cookies", () => {
  const headers = new Headers();
  headers.append("Set-Cookie", "tally.session_token=new; Path=/; HttpOnly");
  headers.append("Set-Cookie", "tally.session_data=; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  assert.deepEqual(privateJson({}, { headers }).headers.getSetCookie(), headers.getSetCookie());
});

test("limited JSON reads split UTF-8 and stops an oversized stream", async () => {
  const encoded = new TextEncoder().encode('{"value":"🌱"}');
  const request = (body: ReadableStream<Uint8Array>) => new Request("https://tally.example/api/sync", {
    method: "PUT", body, duplex: "half"
  } as RequestInit);
  const split = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  });
  assert.deepEqual(await readLimitedJson(request(split), encoded.length), { value: "🌱" });
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
    },
    cancel() { cancelled = true; }
  });
  await assert.rejects(readLimitedJson(request(oversized), encoded.length - 1), /PAYLOAD_TOO_LARGE/);
  assert.equal(cancelled, true);
});

test("limited JSON reader rejects oversized and malformed payloads", async () => {
  await assert.rejects(
    readLimitedJson(new Request("https://tally.example/api/sync", {
      method: "PUT",
      headers: { "content-length": "1000" },
      body: "{}"
    }), 10),
    /PAYLOAD_TOO_LARGE/
  );

  await assert.rejects(
    readLimitedJson(new Request("https://tally.example/api/sync", {
      method: "PUT",
      body: "{bad"
    }), 100),
    /INVALID_JSON/
  );
});
