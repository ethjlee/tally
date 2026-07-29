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
