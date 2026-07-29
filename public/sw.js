"use strict";

const CACHE_NAME = "tally-shell-v1";
const SHELL_ASSETS = [
  "/tally.html",
  "/tally.css",
  "/tally.js",
  "/manifest.webmanifest",
  "/icons/tally.svg",
  "/icons/tally-192.png",
  "/icons/tally-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || mustNeverCache(url)) return;

  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match(url.pathname)))
    );
  }
});
