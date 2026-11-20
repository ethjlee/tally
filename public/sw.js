"use strict";

const CACHE_NAME = "tally-shell-v12";
const PAGE_PATH = "/tally.html";
const CACHED_PAGE_PATH = "/tally-v12.html";
const SHELL_ASSETS = [
  CACHED_PAGE_PATH,
  "/tally.css",
  "/tally-v12.js",
  "/manifest.webmanifest",
  "/icons/tally.svg",
  "/icons/tally-192.png",
  "/icons/tally-512.png"
];

function cacheShell(cache) {
  return cache.addAll(SHELL_ASSETS.map(path => new Request(path, { cache: "reload" })));
}

self.addEventListener("install", (event) => {
  // Let pages using the previous shell close before replacing their cache.
  event.waitUntil(caches.open(CACHE_NAME).then(cacheShell));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith("tally-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

function mustNeverCache(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/" ||
    url.pathname === "/login" ||
    url.pathname === "/setup" ||
    url.pathname === "/account"
  );
}

async function cachedShellAsset(path) {
  const cache = await caches.open(CACHE_NAME);
  const cachePath = path === PAGE_PATH ? CACHED_PAGE_PATH : path;
  const cached = await cache.match(cachePath);
  if (cached || path !== PAGE_PATH) return cached;

  // Signing out can clear the shell while this worker stays active. Fill the
  // whole cache again on the next app launch so the assets stay matched.
  await cacheShell(cache);
  return cache.match(cachePath);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || mustNeverCache(url)) return;

  if (url.pathname === PAGE_PATH || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      cachedShellAsset(url.pathname)
        .catch(() => undefined)
        .then(cached => cached || fetch(request))
    );
  }
});
