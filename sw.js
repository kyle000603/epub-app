/* HWP→EPUB 아이폰 홈 화면 앱(PWA)의 서비스 워커. 이 파일은 공개 주소에 그대로 올라가며 앱 내용은 담지 않는다.
 * 잠금을 푼 기기에는 pwa-core.js가 버전별 캐시(hwp-files-<버전>)에 공개 파일과 vault.bin에서 푼 앱 파일을 넣어 둔다.
 * 이 워커는 그 캐시에서 파일을 내준다. 지금 쓰는 버전은 IndexedDB(hwp-pwa/kv의 "active")에 있다.
 * - 앱 주소(…/, index.html, app.html)를 열 때: 설치된 버전이 있으면 첫 화면(app.html), 없으면 잠금 화면(index.html)
 * - 그 밖의 파일(첫 화면 틀 안에서 여는 앱 화면 epub.html 포함): 지금 버전의 캐시, 없으면 인터넷
 * - hwpfresh가 붙은 요청(버전 확인·새 버전 내려받기)은 손대지 않고 인터넷으로 보낸다. */
"use strict";

const SCOPE = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE).pathname;
const CACHE_PREFIX = "hwp-files-";
const INSTALLED_MARK = "installed-version.json";
const PAGE_PATHS = new Set(["", "index.html", "app.html"]);
// 잠금을 풀기 전에도 인터넷 없이 잠금 화면(과 그 안내)이 뜨도록 껍데기만 따로 담아 둔다. 앱 내용은 없다.
const SHELL_CACHE = "hwp-shell";
const SHELL_FILES = ["index.html", "pwa-core.js", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png"];

let activeVersion;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("hwp-pwa", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readActive() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const request = db.transaction("kv", "readonly").objectStore("kv").get("active");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return null;
  }
}

async function installedCache(version) {
  if (!version || !(await caches.has(CACHE_PREFIX + version))) return null;
  const cache = await caches.open(CACHE_PREFIX + version);
  return (await cache.match(SCOPE + INSTALLED_MARK)) ? cache : null;
}

// 앱 화면을 열 때는 늘 저장된 값을 새로 읽는다(업데이트 직후 메시지보다 화면 이동이 먼저 올 수 있다).
// 그 밖의 파일은 기억해 둔 값을 쓰되, 그 버전 캐시가 없으면(업데이트로 지워짐) 다시 읽는다.
async function currentCache(fresh) {
  if (fresh || activeVersion === undefined) activeVersion = await readActive();
  const cache = await installedCache(activeVersion);
  if (cache || fresh) return cache;
  activeVersion = await readActive();
  return installedCache(activeVersion);
}

async function respondPage(request, url) {
  const cache = await currentCache(true);
  if (cache && !url.searchParams.has("unlock")) {
    const app = await cache.match(SCOPE + "app.html");
    if (app) return app;
  }
  // 잠금 화면은 인터넷에서 새로 받고, 안 되거나 오류 응답이면 캐시에 둔 것을 쓴다.
  const cachedLoader = async () =>
    (cache && (await cache.match(SCOPE + "index.html"))) || (await caches.match(SCOPE + "index.html", { cacheName: SHELL_CACHE }));
  try {
    const response = await fetch(request);
    if (response.ok) return response;
    return (await cachedLoader()) || response;
  } catch (error) {
    const loader = await cachedLoader();
    if (loader) return loader;
    throw error;
  }
}

// 비밀번호를 다시 넣는 잠금 화면(?unlock)은 쓰던 버전을 떠나려는 것이므로 잠금 화면 스크립트를 인터넷에서 새로 받는다.
// 쓰던 버전 캐시의 예전 pwa-core.js를 쓰면 잠금 화면 쪽 수정이 이미 설치한 기기에 닿지 않는다(2026-10-29 교차 검토).
async function fromRelockPage(event) {
  if (!event.clientId) return false;
  try {
    const client = await self.clients.get(event.clientId);
    return Boolean(client) && new URL(client.url).searchParams.has("unlock");
  } catch (error) {
    return false;
  }
}

async function respondFile(event, request, rel) {
  if (SHELL_FILES.includes(rel) && (await fromRelockPage(event))) {
    try {
      const fresh = await fetch(request);
      // 오류 응답(404·500 등)은 쓰지 않고 아래에서 캐시로 낸다.
      if (fresh.ok) return fresh;
    } catch (error) {
      // 인터넷이 없으면 아래에서 캐시로 낸다.
    }
  }
  const cache = await currentCache(false);
  if (cache) {
    const hit = await cache.match(SCOPE + rel);
    if (hit) return hit;
  }
  try {
    return await fetch(request);
  } catch (error) {
    const shell = SHELL_FILES.includes(rel) && (await caches.match(SCOPE + rel, { cacheName: SHELL_CACHE }));
    if (shell) return shell;
    throw error;
  }
}

// 껍데기는 되는 대로 담는다. 받지 못해도 워커 설치는 막지 않는다(인터넷이 될 때 잠금 화면은 인터넷에서 받는다).
async function cacheShell() {
  try {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(
      SHELL_FILES.map(async (path) => {
        const response = await fetch(`${SCOPE}${path}?hwpfresh=shell-${Date.now()}`, { cache: "no-store" });
        if (response.ok) await cache.put(SCOPE + path, response);
      }),
    );
  } catch (error) {
    // 무시한다.
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(cacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "hwp-active") activeVersion = data.version || null;
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  if (url.searchParams.has("hwpfresh")) return;
  // 캐시 열쇠는 빌드가 만든 ASCII 경로(…/app/hashed/… 등) 그대로다.
  const rel = url.pathname.slice(SCOPE_PATH.length);
  if (rel === "sw.js" || rel === "version.json") return;
  if (request.mode === "navigate" && PAGE_PATHS.has(rel)) event.respondWith(respondPage(request, url));
  else event.respondWith(respondFile(event, request, rel));
});
