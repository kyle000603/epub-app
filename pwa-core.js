/* HWP→EPUB 아이폰 홈 화면 앱(PWA)의 잠금·설치·업데이트·Google Drive 저장. 세 화면에서 쓴다.
 * - 잠금 화면(index.html, data-mode="lock")
 * - 첫 화면(app.html, data-mode="home"): 사이트 주소로 열리는 화면. 새 버전 확인·알림·바꾸기를 맡는다. 알림 막대와 작업 확인은
 *   그 화면의 연결 스크립트가 주는 window.HwpMobileHost를 쓴다.
 * - 앱 화면(epub.html, data-mode="app"): EPUB 변환기. 첫 화면의 틀(iframe) 안에서 열리면(embedded) 업데이트는 첫 화면에 맡기고
 *   사용 기록 Drive 백업과 막힌 시작 화면의 '앱 파일 다시 받기'만 한다. 맨 위 창으로 열면 예전처럼 업데이트까지 맡는다.
 * 이 파일은 공개 주소에 그대로 올라가며 앱 내용도 첫 화면 내용도 담지 않는다.
 *
 * 공개 주소에는 잠금 화면, 이 파일, 서비스 워커(sw.js), 오픈소스(Pyodide·파이썬 패키지), 암호문 vault.bin만 둔다.
 * 비밀번호에서 PBKDF2-SHA256으로 만든 열쇠로 vault.bin(AES-256-GCM)을 풀어 앱 파일(화면·엔진·변환기·서식·글꼴)을
 * 이 기기의 Cache Storage(hwp-files-<버전>)에 넣고, 서비스 워커가 거기서 내준다. 그래서 인터넷 없이도 열린다.
 * 열쇠는 IndexedDB(hwp-pwa)에 두어 다음부터는 비밀번호 없이 열리고, 새 버전도 저절로 받아 푼다.
 * 사용 기록은 앱 화면(app-runtime.js)이 따로 IndexedDB(hwp-to-epub-mobile)에 둔다. 이 파일은 그것을 지우지 않고, Drive를
 * 연결한 버전(암호문 속 sync.json)이면 암호화해 사용자 Google Drive에 올리고 새 기기에서 되살린다(아래 '사용 기록 Google Drive 백업').
 * 사용 기록의 표지·부제 이미지도 맨 위 창이 Drive에 올리고, 새 기기의 앱 화면은 '다시 사용' 때 받아 간다('사용 기록 이미지 백업').
 * 첫 화면은 아래 'Google Drive 저장소 도구'(HwpPwa.drive)로 자기 작업 자료를 같은 열쇠로 잠가 Drive에 둔다. Drive 쪽 Apps Script는
 * 종류를 모르는 범용 저장소라, 저장할 자료가 바뀌어도 스크립트는 그대로다(자료의 뜻과 규칙은 모두 이 파일과 home-host.js에 있다). */
(function (global) {
  "use strict";

  const SCRIPT = document.currentScript;
  const MODE = (SCRIPT && SCRIPT.dataset.mode) || "lock";
  const SCOPE = new URL("./", SCRIPT ? SCRIPT.src : location.href).href;

  // 첫 화면(data-mode="home")의 틀 안에서 열린 앱 화면이면 그 첫 화면 창, 아니면 null. 첫 화면 스크립트가 아직 돌지 않았어도
  // 그 문서의 <head>에 있는 표시(script[data-mode="home"])로 안다. 다른 출처의 틀이면 null(맨 위 창처럼 동작).
  function homeWindow() {
    try {
      const parent = global.parent;
      if (!parent || parent === global) return null;
      if (parent.HwpPwa && parent.HwpPwa.mode === "home") return parent;
      return parent.document.querySelector('script[src$="pwa-core.js"][data-mode="home"]') ? parent : null;
    } catch (error) {
      return null;
    }
  }

  const EMBEDDED = MODE === "app" && Boolean(homeWindow());

  // 화면 전체를 다른 주소로 옮긴다. 첫 화면의 틀 안이면 첫 화면(맨 위 창)을 옮긴다.
  function leave(url) {
    ((EMBEDDED && homeWindow()) || global).location.replace(url);
  }
  const CACHE_PREFIX = "hwp-files-";
  const INSTALLED_MARK = "installed-version.json";
  const VAULT_MAGIC = "HWPV1";
  const CHECK_TEXT = "hwp-epub-vault";
  const UPDATE_INTERVAL_MS = 10 * 60 * 1000;
  const NOTICE_RETRY_MS = 15000;
  const OPEN_ATTEMPTS_KEY = "hwp-pwa-open-attempts";
  const ENCODER = new TextEncoder();
  const DECODER = new TextDecoder();
  const IOS_DEVICE = /iP(?:hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const STANDALONE = navigator.standalone === true || (global.matchMedia && global.matchMedia("(display-mode: standalone)").matches);

  // ── IndexedDB(열쇠 "key", 지금 쓰는 버전 "active", 받아 두고 아직 쓰지 않은 버전 "pending") ──
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("hwp-pwa", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbRun(mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("kv", mode);
      const request = action(transaction.objectStore("kv"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  const db = {
    get: (key) => dbRun("readonly", (store) => store.get(key)),
    set: (key, value) => dbRun("readwrite", (store) => store.put(value, key)),
    remove: (key) => dbRun("readwrite", (store) => store.delete(key)),
  };

  // ── 암호 ──
  function base64ToBytes(text) {
    const binary = atob(text || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function sha256Hex(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function normalizePassword(text) {
    return String(text || "").normalize("NFC").trim();
  }

  async function deriveKey(password, vault) {
    const material = await crypto.subtle.importKey("raw", ENCODER.encode(normalizePassword(password)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(vault.salt), iterations: vault.iterations },
      material,
      256,
    );
    return new Uint8Array(bits);
  }

  async function decrypt(keyBytes, iv, data) {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data));
  }

  // 큰 vault.bin을 받기 전에 짧은 확인용 암호문으로 열쇠가 맞는지 본다.
  async function keyMatches(keyBytes, vault) {
    if (!keyBytes || !vault) return false;
    const sealed = base64ToBytes(vault.check);
    try {
      return DECODER.decode(await decrypt(keyBytes, sealed.subarray(0, 12), sealed.subarray(12))) === CHECK_TEXT;
    } catch (error) {
      return false;
    }
  }

  // ── 버전 정보와 설치 ──
  // 연결이 멈춘 채 답이 없으면(공유기 로그인 화면 등) 기다리지 않도록 시간을 둔다.
  async function fetchVersionInfo(timeoutMs = 10000) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    try {
      const response = await fetch(`${SCOPE}version.json?hwpfresh=${Date.now()}`, { cache: "no-store", signal: controller ? controller.signal : undefined });
      if (!response.ok) throw new Error(`버전 정보를 받지 못했습니다(${response.status}).`);
      const info = await response.json();
      if (info.format !== 1 || !info.version || !Array.isArray(info.files) || !info.vault) throw new Error("버전 정보 형식이 다릅니다.");
      return info;
    } finally {
      clearTimeout(timer);
    }
  }

  // 앱 파일을 지우기 전에, 지금 다시 받을 수 있는지(사이트에 닿고 저장된 열쇠가 맞는지) 확인한다.
  // navigator.onLine만으로는 공유기 로그인 화면·멈춘 연결을 가려내지 못한다(2026-10-29 확인 검토).
  async function canReinstall() {
    try {
      const [info, keyBytes] = await Promise.all([fetchVersionInfo(5000), db.get("key")]);
      return keyMatches(keyBytes, info.vault);
    } catch (error) {
      return false;
    }
  }

  async function isInstalled(version) {
    if (!version || !(await caches.has(CACHE_PREFIX + version))) return false;
    const cache = await caches.open(CACHE_PREFIX + version);
    return Boolean((await cache.match(SCOPE + INSTALLED_MARK)) && (await cache.match(SCOPE + "app.html")));
  }

  // 이미 받아 둔 다른 버전의 캐시. 바뀌지 않은 파일(Pyodide 등)은 다시 받지 않고 옮겨 담는다.
  async function reusableCaches(version) {
    const found = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX) || name === CACHE_PREFIX + version) continue;
      const cache = await caches.open(name);
      const mark = await cache.match(SCOPE + INSTALLED_MARK);
      if (!mark) continue;
      try {
        const info = await mark.json();
        found.push({ cache, hashes: new Map(info.files.map((file) => [file.path, file.sha256])) });
      } catch (error) {
        // 표시가 깨진 캐시는 쓰지 않는다.
      }
    }
    return found;
  }

  async function download(file, attempt = 0) {
    const fresh = `${file.sha256.slice(0, 16)}${attempt ? `-${attempt}` : ""}`;
    const response = await fetch(`${SCOPE}${file.path}?hwpfresh=${fresh}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`앱 파일을 받지 못했습니다(${response.status}): ${file.path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if ((await sha256Hex(bytes)) === file.sha256) return bytes;
    // 새 버전을 올린 직후에는 잠시 예전 파일이 올 수 있다. 다른 주소로 다시 받는다.
    if (attempt < 2) return download(file, attempt + 1);
    throw new Error("받은 앱 파일이 올라간 파일과 다릅니다. 잠시 뒤 다시 시도해 주세요.");
  }

  async function openVault(sealed, keyBytes) {
    if (DECODER.decode(sealed.subarray(0, VAULT_MAGIC.length)) !== VAULT_MAGIC) throw new Error("앱 파일 묶음 형식이 다릅니다.");
    const start = VAULT_MAGIC.length;
    let plain;
    try {
      plain = await decrypt(keyBytes, sealed.subarray(start, start + 12), sealed.subarray(start + 12));
    } catch (error) {
      throw new Error("앱 파일 묶음을 풀지 못했습니다. 비밀번호를 다시 넣어 주세요.");
    }
    const headerLength = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, true);
    const header = JSON.parse(DECODER.decode(plain.subarray(4, 4 + headerLength)));
    const base = 4 + headerLength;
    return header.files.map((entry) => ({ ...entry, body: plain.slice(base + entry.offset, base + entry.offset + entry.length) }));
  }

  // 새 버전을 이 기기에 받아 둔다. 끝까지 마쳐야 표시(installed-version.json)를 남기므로, 중간에 끊겨도 쓰던 버전은 그대로다.
  // 같은 버전을 받다 끊겼으면 이미 받아 해시까지 확인해 둔 파일은 다시 받지 않는다(아이폰은 화면을 끄거나 다른 앱으로 가면
  // 받기가 끊기기 쉽다. 2026-10-29 교차 검토).
  // 지금 받고 있는 버전. pruneCaches가 받는 중인 캐시를 지우지 않게 한다.
  let installingVersion = null;

  async function install(info, keyBytes, onProgress) {
    installingVersion = info.version;
    try {
      await installFiles(info, keyBytes, onProgress);
    } finally {
      installingVersion = null;
    }
  }

  async function installFiles(info, keyBytes, onProgress) {
    // 다른 버전을 받다 끊긴 캐시(표시 없음)는 지운다. 같은 버전의 것은 이어 받으려고 남긴다. 쓰는 버전은 건드리지 않는다.
    for (const name of await caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX) || name === CACHE_PREFIX + info.version) continue;
      const other = await caches.open(name);
      if (!(await other.match(SCOPE + INSTALLED_MARK))) await caches.delete(name);
    }
    const cache = await caches.open(CACHE_PREFIX + info.version);
    await cache.delete(SCOPE + INSTALLED_MARK);
    const reusable = await reusableCaches(info.version);
    const plan = [];
    for (const file of info.files) {
      let present = false;
      let reused = null;
      const partial = await cache.match(SCOPE + file.path);
      if (partial && (await sha256Hex(new Uint8Array(await partial.arrayBuffer()))) === file.sha256) present = true;
      for (const candidate of present ? [] : reusable) {
        if (candidate.hashes.get(file.path) !== file.sha256) continue;
        reused = await candidate.cache.match(SCOPE + file.path);
        if (reused) break;
      }
      plan.push({ file, present, reused });
    }
    const total = plan.reduce((sum, item) => sum + (item.present || item.reused ? 0 : item.file.size), 0);
    let done = 0;
    if (onProgress) onProgress(done, total);
    for (const item of plan) {
      if (item.present) continue;
      let response = item.reused;
      if (!response) {
        response = new Response(await download(item.file), { headers: { "Content-Type": item.file.type } });
        done += item.file.size;
        if (onProgress) onProgress(done, total);
      }
      await cache.put(SCOPE + item.file.path, response);
    }
    const vaultResponse = await cache.match(SCOPE + info.vault.path);
    if (!vaultResponse) throw new Error("앱 파일 묶음(vault.bin)이 목록에 없습니다.");
    for (const entry of await openVault(new Uint8Array(await vaultResponse.arrayBuffer()), keyBytes)) {
      await cache.put(SCOPE + entry.path, new Response(entry.body, { headers: { "Content-Type": entry.type } }));
    }
    // 받는 사이 캐시가 지워졌으면(다른 정리 작업) 지워진 캐시에 쓴 것은 남지 않으므로 끝났다고 표시하지 않는다.
    if (!(await caches.has(CACHE_PREFIX + info.version))) throw new Error("앱 파일을 받는 중에 저장소가 지워졌습니다. 다시 받습니다.");
    await cache.put(SCOPE + INSTALLED_MARK, new Response(JSON.stringify(info), { headers: { "Content-Type": "application/json" } }));
  }

  async function activate(version) {
    // 다 받지 않은 버전으로는 바꾸지 않는다. 바꾸면 쓰던 버전 캐시까지 지워 앱이 열리지 않는다.
    if (!(await isInstalled(version))) throw new Error("다 받지 않은 버전입니다.");
    await db.set("active", version);
    await db.remove("pending");
    const registration = await navigator.serviceWorker.getRegistration(SCOPE);
    const worker = registration && (registration.active || registration.waiting || registration.installing);
    if (worker) worker.postMessage({ type: "hwp-active", version });
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: "hwp-active", version });
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_PREFIX + version) await caches.delete(name);
    }
  }

  // 쓰는 버전과 keep 말고 다른 버전 캐시를 지운다(건너뛴 버전이 한 벌에 20MB 넘게 쌓이지 않게).
  async function pruneCaches(keep) {
    const active = await db.get("active");
    for (const name of await caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX)) continue;
      const version = name.slice(CACHE_PREFIX.length);
      if (version !== active && version !== keep && version !== installingVersion) await caches.delete(name);
    }
  }

  // 앱 파일만 지우고 다시 받게 한다(사용 기록과 저장된 열쇠는 그대로). 잠금 화면이 저장된 열쇠로 다시 받는다.
  // 인터넷이 될 때만 부른다. 열리지 않는 앱(시작 화면이 막힘, 앱 화면 열기 반복 실패)을 되살리는 마지막 방법이다.
  async function resetAppFiles() {
    for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX)) await caches.delete(name);
    await db.remove("active");
    await db.remove("pending");
    try {
      sessionStorage.removeItem(OPEN_ATTEMPTS_KEY);
    } catch (error) {
      // 무시한다.
    }
  }

  async function registerWorker() {
    if (!("serviceWorker" in navigator) || !global.caches || !global.crypto || !crypto.subtle) {
      throw new Error("이 브라우저에서는 홈 화면 앱을 쓸 수 없습니다. 아이폰은 Safari(iOS 16.4 이상)에서 열어 주세요.");
    }
    const registration = await navigator.serviceWorker.register(`${SCOPE}sw.js`, { scope: SCOPE });
    await navigator.serviceWorker.ready;
    return registration;
  }

  function formatMegabytes(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1);
  }

  // ── 사용 기록 Google Drive 백업(2026-10-29 사용자 요청) ──
  // 사용자 Google 계정의 Apps Script 웹 앱(mobile/pwa/drive-sync.gs)이 사용자 Drive의 비공개 폴더에 기록 파일을 둔다.
  // 기록은 이 기기에서 sync.json의 열쇠(AES-256-GCM)로 잠가 보내므로 스크립트도 Drive도 내용을 읽지 못한다.
  // 주소·확인 값(token)·열쇠(key)는 암호문(vault.bin) 속 sync.json에만 있다(공개 파일에는 없다).
  // - 올리기: 앱 화면에서 기록이 바뀌면 이 기기의 파일 하나(history-<기기 값>.hwpsync)를 통째로 덮어쓴다.
  // - 되살리기: 기록이 빈 기기(처음 설치, 저장 공간 삭제, 새 아이폰)에서 한 번, 모든 기기의 파일을 원고 이름마다 가장
  //   최근 것으로 합친다. 기록이 있는 기기는 다른 기기의 기록을 섞지 않는다. 되살린 기기는 읽은 파일을 '흡수함'(absorbed)으로
  //   적어 올리므로, 다음에 되살릴 때 그 뒤로 바뀌지 않은 예전 파일은 쓰지 않는다(그사이 지운 기록이 되살아나지 않게).
  //   파일의 저장 시각(savedAt)은 내용이 바뀔 때만 바뀐다. 다만 한 번 되살린 뒤 쓰지 않고 남은 다른 기기(Safari 탭, 아이패드,
  //   시험 브라우저)의 파일은 아무도 흡수하지 않아 계속 합쳐진다. 그 기기가 가진 기록은 다른 기기에서 지워도 되살리기에서 돌아온다.
  const HISTORY_PATHS = ["HwpToEpubWeb/history.json", "HwpToEpubWeb/history.json.bak"];
  const HISTORY_LIMIT = 1000;
  const SYNC_NAME = /^history-([a-z0-9]{8,32})$/;
  const SYNC_TIMEOUT_MS = 20000;
  // 앱을 떠날 때 보내는 요청은 keepalive로 보낸다(브라우저가 이 크기까지만 받는다).
  const KEEPALIVE_LIMIT = 60000;

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  // 앱 화면(app-runtime.js webBridge)이 /persist 파일을 두는 IndexedDB(열쇠는 경로, 값은 바이트).
  async function persistRun(mode, action) {
    const store = await new Promise((resolve, reject) => {
      const request = indexedDB.open("hwp-to-epub-mobile", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("persist");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = store.transaction("persist", mode);
        const result = action(transaction.objectStore("persist"));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      store.close();
    }
  }

  // 데스크톱 load_history_records처럼 history.json을 읽고, 없거나 깨졌으면 .bak을 읽는다.
  // valid가 false면 파일은 있는데 읽지 못한 것이다. 그때는 올리지도 되살리지도 않는다.
  async function readLocalHistory() {
    const requests = await persistRun("readonly", (store) => HISTORY_PATHS.map((path) => store.get(path)));
    let found = false;
    for (const request of requests) {
      if (!request.result) continue;
      found = true;
      try {
        const records = JSON.parse(DECODER.decode(request.result));
        if (Array.isArray(records)) return { records, valid: true };
      } catch (error) {
        // 다음 파일(.bak)을 본다.
      }
    }
    return { records: [], valid: !found };
  }

  async function writeLocalHistory(records) {
    const bytes = ENCODER.encode(JSON.stringify(records, null, 2));
    await persistRun("readwrite", (store) => HISTORY_PATHS.forEach((path) => store.put(bytes, path)));
  }

  // 원고 이름마다 가장 최근(savedAt) 기록 하나를 남긴다(데스크톱 upsert_history_record와 같은 기준). 시각이 같으면 앞의 목록
  // (이 기기)의 것을 남긴다. 최근 순으로 1000개까지.
  function mergeHistory(lists) {
    const savedAt = (record) => Number(record.savedAt) || 0;
    const byName = new Map();
    for (const record of lists.flat()) {
      if (!record || typeof record.id !== "string" || !record.id.trim()) continue;
      if (typeof record.manuscriptName !== "string" || !record.manuscriptName.trim()) continue;
      const name = record.manuscriptName.trim();
      const current = byName.get(name);
      if (!current || savedAt(record) > savedAt(current)) byName.set(name, record);
    }
    return Array.from(byName.values())
      .sort((a, b) => savedAt(b) - savedAt(a))
      .slice(0, HISTORY_LIMIT);
  }

  // 쓰는 버전 캐시에 푼 sync.json. 없으면(Drive를 연결하기 전 버전) 백업하지 않는다.
  async function loadSyncConfig(version) {
    try {
      if (!version || !(await caches.has(CACHE_PREFIX + version))) return null;
      const response = await (await caches.open(CACHE_PREFIX + version)).match(SCOPE + "sync.json");
      const config = response ? await response.json() : null;
      return config && config.url && config.token && config.key ? config : null;
    } catch (error) {
      return null;
    }
  }

  function syncKey(config, usage) {
    return crypto.subtle.importKey("raw", base64ToBytes(config.key), "AES-GCM", false, [usage]);
  }

  // IV(12바이트) + 암호문 + 태그를 base64로. 파일 이름을 덧붙인 자료(additionalData)로 묶어 다른 이름으로 바꿔 넣을 수 없게 한다.
  async function sealBytes(config, name, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const algorithm = { name: "AES-GCM", iv, additionalData: ENCODER.encode(name) };
    const sealed = new Uint8Array(await crypto.subtle.encrypt(algorithm, await syncKey(config, "encrypt"), bytes));
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv);
    out.set(sealed, iv.length);
    return bytesToBase64(out);
  }

  // sealBytes의 반대. 열쇠나 파일 이름이 다르거나 내용이 깨졌으면 오류를 낸다.
  async function openSealed(config, name, data) {
    const bytes = base64ToBytes(data);
    const algorithm = { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: ENCODER.encode(name) };
    return new Uint8Array(await crypto.subtle.decrypt(algorithm, await syncKey(config, "decrypt"), bytes.subarray(12)));
  }

  function sealHistory(config, name, payload) {
    return sealBytes(config, name, ENCODER.encode(JSON.stringify(payload)));
  }

  async function openSealedHistory(config, name, data) {
    const payload = JSON.parse(DECODER.decode(await openSealed(config, name, data)));
    if (!payload || payload.format !== 1 || !Array.isArray(payload.records)) throw new Error("기록 파일 형식이 다릅니다.");
    return payload;
  }

  // Apps Script 웹 앱 호출. 사용자 정의 헤더가 없는 text/plain POST라 브라우저가 사전 확인(OPTIONS) 없이 보내고, Apps Script가
  // 돌려주는 주소 이동(302, script.googleusercontent.com)을 따라가 답(JSON)을 읽는다. 스크립트가 거절하면 그 이유('bad op',
  // 'bad name', 'full', 'conflict', 'denied' 등)를 오류의 code에, 답 전체를 reply에 둔다.
  async function callSync(config, body, keepalive, timeoutMs = SYNC_TIMEOUT_MS) {
    const text = JSON.stringify({ ...body, token: config.token });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: text,
        credentials: "omit",
        redirect: "follow",
        keepalive: Boolean(keepalive) && text.length < KEEPALIVE_LIMIT,
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) throw new Error(`기록 저장소가 답하지 않았습니다(${response.status}).`);
      const reply = await response.json();
      if (!reply || reply.ok !== true) {
        const error = new Error(`기록 저장소가 받지 않았습니다(${(reply && reply.error) || "알 수 없음"}).`);
        error.code = String((reply && reply.error) || "");
        error.reply = reply;
        throw error;
      }
      return reply;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Google Drive 저장소 도구(HwpPwa.drive, 첫 화면과 앱 화면이 함께 쓴다) ──
  // Apps Script 2판(drive-sync.gs, 2026-10-31)은 이름 → 암호문만 아는 범용 저장소다(사용자 요청: "그냥 쿼리로 받아서 다 저장하고
  // 그 쿼리를 다 받아서 오면 안돼? 이거를 일반화해서 클라이언트쪽을 바꿔도 통용되게"). 이름의 뜻과 덮어쓰기·합치기 규칙은 모두 앱
  // 쪽(이 파일, home-host.js)에 있어서, 저장할 자료를 더하거나 형식을 바꿔도 스크립트는 다시 붙여 넣지 않는다.
  // - 쓰는 이름(.hwpsync 앞, 규칙 ^[a-z0-9][a-z0-9_-]{0,99}$): history-<기기 값>(사용 기록, 1판부터), work-main(첫 화면 작업 자료),
  //   image-<32자리 16진>(사용 기록 이미지, imageName). 내용은 모두 sealBytes로 잠근다(파일 이름을 덧붙인 자료).
  // - 요청: ping(판·한도), put(ifAbsent: 있으면 쓰지 않음, ifUpdated: Drive 파일의 updated가 그 값일 때만 씀, 아니면 conflict),
  //   get, list(prefix, withData), delete(휴지통). 사용 기록 백업(uploadHistory·restoreHistory)은 1판과 같은 요청(prefix 없는 list,
  //   history- put)만 써서 예전 스크립트로도 된다.
  // - 예전(1판) 스크립트는 ping 답에 store가 없다(새 요청에는 'bad op'·'bad name'). 그러면 1판으로 보고(status().v1), 이 화면에서는
  //   1시간 동안 새 요청을 보내지 않는다. 다음에 앱을 열거나 recheck() 뒤에 다시 해 본다.
  const DRIVE_NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;
  const DRIVE_V1_RETRY_MS = 60 * 60 * 1000;
  // 목록은 폴더 전체를 훑으므로 넉넉히 기다린다.
  const LIST_TIMEOUT_MS = 120000;
  let driveV1At = 0;
  // 이 화면에서 본 스크립트 판: 0(아직 모름), 1(예전), 2(범용 2판)
  let driveScript = 0;
  let driveConfigRun = null;
  // 이 화면에서 받은 ping 답(성공한 것만 기억한다)과 그 한도
  let drivePingRun = null;
  let driveLimits = null;
  // 이 화면의 사용 기록 이미지 백업을 곧 돌리는 함수. 맨 위 창(첫 화면, 맨 위 창으로 연 앱 화면)에만 있다(imageBackup).
  let imageKick = null;

  function driveError(code, message, extra) {
    const error = new Error(message);
    error.code = code;
    return Object.assign(error, extra || {});
  }

  function driveV1() {
    return Boolean(driveV1At) && Date.now() - driveV1At < DRIVE_V1_RETRY_MS;
  }

  function markV1() {
    driveV1At = Date.now();
    driveScript = 1;
    drivePingRun = null;
    return driveError("v1", "드라이브 저장 스크립트가 예전 버전입니다.");
  }

  // 새 요청은 이 화면에서 한 번 ping으로 범용 2판인지 본 뒤에 보낸다. 떠날 때(keepalive) 보내는 요청은 기다리지 않는다(그사이
  // 페이지가 닫힌다). 그때 예전 스크립트면 'bad name'으로 답하고 아무것도 쓰지 않는다.
  async function driveCall(body, options) {
    const config = await drive.config();
    if (!config) throw driveError("off", "구글 드라이브를 연결하지 않은 버전입니다.");
    if (driveV1()) throw driveError("v1", "드라이브 저장 스크립트가 예전 버전입니다.");
    const keepalive = Boolean(options && options.keepalive);
    if (!keepalive) await drive.ping();
    try {
      return await callSync(config, body, keepalive, (options && options.timeoutMs) || SYNC_TIMEOUT_MS);
    } catch (error) {
      if (error && (error.code === "bad op" || error.code === "bad name")) throw markV1();
      throw error;
    }
  }

  function checkDriveName(name) {
    if (typeof name !== "string" || !DRIVE_NAME.test(name)) throw driveError("bad name", `드라이브 파일 이름이 다릅니다: ${name}`);
  }

  const drive = {
    // 쓰는 버전 캐시의 sync.json({url, token, key}). 없으면 null(드라이브를 연결하지 않은 버전). 화면마다 한 번 읽는다.
    config() {
      if (!driveConfigRun) driveConfigRun = db.get("active").then(loadSyncConfig, () => null);
      return driveConfigRun;
    },
    // 이 화면에서 본 스크립트 상태. v1: 예전 스크립트라 새 요청을 멈춤. script: 0(아직 모름)·1·2. limits: ping의 한도(모르면 null).
    status() {
      return { v1: driveV1(), script: driveScript, limits: driveLimits };
    },
    // 예전 스크립트 표시와 ping 답을 지운다. 다음 요청 때 다시 본다(사용자가 '지금 저장'으로 다시 해 볼 때).
    recheck() {
      driveV1At = 0;
      drivePingRun = null;
    },
    // 스크립트의 ping 답 {folder, version, store, limits: {maxData, maxFiles, maxTotal}}. 이 화면에서 한 번 묻고 기억한다.
    // 범용 2판이 아니면 code "v1" 오류.
    ping(options) {
      if (!drivePingRun) {
        const run = (async () => {
          const config = await drive.config();
          if (!config) throw driveError("off", "구글 드라이브를 연결하지 않은 버전입니다.");
          if (driveV1()) throw driveError("v1", "드라이브 저장 스크립트가 예전 버전입니다.");
          const reply = await callSync(config, { op: "ping" }, false, (options && options.timeoutMs) || SYNC_TIMEOUT_MS);
          if (!(Number(reply.version) >= 2) || reply.store !== "generic") throw markV1();
          driveV1At = 0;
          driveScript = 2;
          driveLimits = reply.limits && typeof reply.limits === "object" ? reply.limits : null;
          return reply;
        })();
        drivePingRun = run;
        run.catch(() => {
          if (drivePingRun === run) drivePingRun = null;
        });
      }
      return drivePingRun;
    },
    // 파일을 받아 푼다: {bytes(Uint8Array), updated(Drive 파일 시각), size}. 없으면 null. 풀지 못하면(다른 열쇠·깨짐) code
    // "sealed" 오류(그 파일의 updated를 담는다. 이 열쇠로 덮어쓸 때 ifUpdated로 쓴다). options: timeoutMs.
    // 오류 code: off(연결 안 됨), v1(예전 스크립트), 그 밖은 연결·저장소 오류.
    async get(name, options) {
      checkDriveName(name);
      const reply = await driveCall({ op: "get", name }, options);
      if (reply.missing) return null;
      const data = String(reply.data || "");
      const updated = Number(reply.updated) || 0;
      let bytes;
      try {
        bytes = await openSealed(await drive.config(), name, data);
      } catch (error) {
        throw driveError("sealed", "드라이브 파일을 풀지 못했습니다(다른 열쇠로 잠갔거나 깨짐).", { updated });
      }
      return { bytes, updated, size: Number(reply.size) || data.length };
    },
    // put과 같은 방식으로 잠근 내용(base64). 떠날 때(pagehide)는 암호화를 기다리는 사이 페이지가 닫히므로 미리 만들어
    // put의 options.sealed로 준다.
    async seal(name, bytes) {
      checkDriveName(name);
      const config = await drive.config();
      if (!config) throw driveError("off", "구글 드라이브를 연결하지 않은 버전입니다.");
      return sealBytes(config, name, bytes);
    },
    // 내용(Uint8Array)을 잠가 올리고 {updated, existed}를 돌려준다. options: ifAbsent(이미 있으면 쓰지 않고 existed: true),
    // ifUpdated(Drive 파일의 updated가 이 값일 때만 씀. 없는 파일은 0. 아니면 code "conflict" 오류에 지금 값 updated),
    // sealed(seal로 미리 잠근 내용. 주면 bytes는 쓰지 않는다), keepalive(떠날 때, 작을 때만 쓰인다. 확인(ping)을 기다리지 않고
    // 바로 보낸다), timeoutMs. 한도를 넘으면 code "full"·"bad data" 오류.
    async put(name, bytes, options) {
      checkDriveName(name);
      const config = await drive.config();
      if (!config) throw driveError("off", "구글 드라이브를 연결하지 않은 버전입니다.");
      const sealed = options && typeof options.sealed === "string" ? options.sealed : await sealBytes(config, name, bytes);
      const body = { op: "put", name, data: sealed };
      if (options && options.ifAbsent) body.ifAbsent = true;
      if (options && typeof options.ifUpdated === "number") body.ifUpdated = options.ifUpdated;
      try {
        const reply = await driveCall(body, options);
        return { updated: Number(reply.updated) || 0, existed: reply.existed === true };
      } catch (error) {
        if (error && error.code === "conflict") error.updated = Number(error.reply && error.reply.updated) || 0;
        throw error;
      }
    },
    // 이 접두어로 시작하는 파일 [{name, updated, size}](휴지통 제외). options.withData면 각 파일을 풀어 bytes(못 풀면 null)도 담는다.
    // 폴더 전체를 훑으므로 자주 부르지 않는다.
    async list(prefix, options) {
      if (typeof prefix !== "string") throw driveError("bad prefix", `드라이브 파일 접두어가 다릅니다: ${prefix}`);
      const withData = Boolean(options && options.withData);
      const body = withData ? { op: "list", prefix, withData: true } : { op: "list", prefix };
      const reply = await driveCall(body, { timeoutMs: (options && options.timeoutMs) || LIST_TIMEOUT_MS });
      const config = await drive.config();
      const files = [];
      for (const file of Array.isArray(reply.files) ? reply.files : []) {
        const name = String((file && file.name) || "");
        if (!name.startsWith(prefix) || !DRIVE_NAME.test(name)) continue;
        const entry = { name, updated: Number(file.updated) || 0, size: Number(file.size) || 0 };
        if (withData) {
          try {
            entry.bytes = await openSealed(config, name, String(file.data || ""));
          } catch (error) {
            entry.bytes = null;
          }
        }
        files.push(entry);
      }
      return files;
    },
    // 파일을 Drive 휴지통으로 옮긴다(30일 안에 Drive에서 되살릴 수 있다). 없었으면 false.
    async remove(name, options) {
      checkDriveName(name);
      const reply = await driveCall({ op: "delete", name }, options);
      return !reply.missing;
    },
    // 사용 기록 이미지(id: 내용의 SHA-256 16진 64자, ext: ".jpg" 등)의 Drive 파일 이름 image-<32자리 16진>.
    // HMAC-SHA256(열쇠 = sync.json의 key 32바이트, "hwp-history-image:" + id + ext)의 앞 16바이트라 이름에서 이미지를 알 수 없다.
    async imageName(id, ext) {
      const config = await drive.config();
      if (!config) return null;
      const key = await crypto.subtle.importKey("raw", base64ToBytes(config.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, ENCODER.encode(`hwp-history-image:${id}${ext}`)));
      return `image-${Array.from(mac.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    },
    // 사용 기록이 바뀌었다(틀 안의 앱 화면이 첫 화면에 알린다). 맨 위 창이면 곧 이미지 백업을 돌린다. 그 밖에는 아무것도 하지 않는다.
    kick() {
      if (imageKick) imageKick();
    },
  };

  // ── 사용 기록 이미지 Google Drive 백업(2026-10-31) ──
  // 변환기는 표지·부제 이미지를 사용 기록과 함께 앱 저장소에 둔다(HwpToEpubWeb/history_images/<sha256><확장자>, 기록의
  // coverImage·subtitleImage {id, ext, name, type, size}). 맨 위 창(첫 화면, 또는 맨 위 창으로 연 앱 화면)이 이 기기에 있고 Drive에
  // 없는 이미지를 하나씩 잠가 image-<HMAC>으로 올린다(ifAbsent: 이미 있으면 쓰지 않음, 내용 = 이미지 바이트 그대로).
  // 틀 안의 앱 화면은 올리지 않고 기록이 바뀌면 첫 화면에 알린다(drive.kick). 다른 창(탭)과 겹치지 않게 Web Locks로 한 곳에서만 돈다.
  // 새 기기는 사용 기록만 되살린다. 이미지는 '다시 사용' 때 앱 화면(app-runtime.js)이 저장소에 없는 이미지를
  // window.HwpMobileImageFallback.fetch(id)로 받아 간다(Drive에서 받아 풀고 SHA-256이 id와 같은지 본다).
  const IMAGE_DIR = "HwpToEpubWeb/history_images/";
  const IMAGE_TYPES = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
  const IMAGE_ID = /^[0-9a-f]{64}$/;
  const IMAGE_STATE = "driveImages";
  const IMAGE_LOCK = "hwp-drive-images";
  // Drive에 있는 이미지 이름 목록은 하루에 한 번까지만 다시 받는다(Drive에서 지운 이미지를 다시 올리게).
  const IMAGE_LIST_MS = 24 * 60 * 60 * 1000;
  // Drive 폴더가 한도(파일 수·합계)에 차면(full) 하루 동안 이미지를 올리지 않는다(같은 큰 이미지를 5분마다 다시 보내지 않게).
  const IMAGE_FULL_RETRY_MS = 24 * 60 * 60 * 1000;
  const IMAGE_START_MS = 5000;
  const IMAGE_KICK_MS = 1000;
  const IMAGE_INTERVAL_MS = 5 * 60 * 1000;
  // 스크립트 한도(maxData)보다 큰 이미지는 조각으로 나눠 올린다(2026-10-31 사용자 요청: "그 업로드할 수 있는 이미지 사이즈를 더 키울 수는
  // 없어?"). 조각: <이름>-<조각 크기>-<번호>(번호는 0부터, 이미지 바이트의 한 토막. 크기가 이름에 있어 한도가 바뀐 뒤 이어 올려도 섞이지
  // 않는다). 조각을 다 올린 뒤 <이름>에 조각 목록(IMAGE_CHUNKS_MAGIC + JSON {count, size, piece, sha256})을 올린다(받는 쪽이 반쯤 올라간
  // 이미지를 보지 않게 맨 나중에). 받는 쪽은 <이름>을 풀어 이 표시로 시작하면 조각을 모아 SHA-256을 확인한다. 스크립트는 고치지 않는다.
  const IMAGE_CHUNKS_MAGIC = "HWPIMGCHUNKS1\n";
  // 이미지 하나는 50MB·16조각까지 Drive에 올린다(휴대폰 데이터·메모리). 넘으면 건너뛰고 기억한다(스크립트 한도가 커지면 다시 해 본다).
  const IMAGE_MAX_BYTES = 50 * 1024 * 1024;
  const IMAGE_MAX_CHUNKS = 16;

  // 기록의 표지·부제 이미지 [{id, ext, size}](id·확장자가 맞는 것만, id+확장자마다 하나, 기록 순서 = 최근 순)
  function historyImages(records) {
    const found = new Map();
    for (const record of records) {
      for (const meta of [record && record.coverImage, record && record.subtitleImage]) {
        if (!meta || typeof meta.id !== "string" || !IMAGE_ID.test(meta.id)) continue;
        if (typeof meta.ext !== "string" || !Object.prototype.hasOwnProperty.call(IMAGE_TYPES, meta.ext)) continue;
        if (!found.has(meta.id + meta.ext)) found.set(meta.id + meta.ext, { id: meta.id, ext: meta.ext, size: Number(meta.size) || 0 });
      }
    }
    return Array.from(found.values());
  }

  // 잠근 내용의 base64 길이(IV 12바이트 + 내용 + 태그 16바이트). 스크립트 한도(maxData)와 견준다.
  function sealedLength(byteLength) {
    return 4 * Math.ceil((byteLength + 28) / 3);
  }

  // 조각 하나에 담는 이미지 바이트 수: 잠근 길이(sealedLength)가 스크립트 한도 안에 들게 한다.
  function chunkBytes(maxData) {
    return Math.floor((maxData * 3) / 4) - 64;
  }

  function chunkName(name, piece, index) {
    return `${name}-${piece}-${index}`;
  }

  // Drive에서 받은 <이름>의 내용이 조각 목록이면 {count, size, piece}, 아니면(이미지 바이트 그대로) null.
  function readChunkList(bytes) {
    const magic = ENCODER.encode(IMAGE_CHUNKS_MAGIC);
    if (bytes.length <= magic.length || bytes.length > 4096 || magic.some((value, index) => bytes[index] !== value)) return null;
    try {
      const list = JSON.parse(DECODER.decode(bytes.subarray(magic.length)));
      const count = Number(list.count);
      const size = Number(list.size);
      const piece = Number(list.piece);
      if (!(count >= 1 && count <= 64 && piece >= 1 && size >= 1 && size <= count * piece)) return null;
      return { count, size, piece };
    } catch (error) {
      return null;
    }
  }

  // 큰 내용은 느린 연결에서도 끝나게 기다린다(초당 50KB를 가정, 최대 10분).
  function transferTimeout(length) {
    return Math.min(600000, SYNC_TIMEOUT_MS + Math.ceil(length / 50));
  }

  // 앱 저장소에 있는 경로(값은 읽지 않는다)
  async function persistPresent(paths) {
    const requests = await persistRun("readonly", (store) => paths.map((path) => store.count(path)));
    return new Set(paths.filter((path, index) => requests[index].result > 0));
  }

  // 앱 저장소의 파일 내용(Uint8Array). 없으면 null.
  async function persistRead(path) {
    const request = await persistRun("readonly", (store) => store.get(path));
    const value = request.result;
    if (!value) return null;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof Blob === "function" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
    return null;
  }

  // 이미지 백업 상태(IndexedDB hwp-pwa kv "driveImages"): {stamp(주소·열쇠의 해시), at(Drive 목록을 받은 시각), names(Drive에 있는
  // 이미지 이름), skip({이름: 암호문 길이}: 스크립트 한도보다 커서 올리지 않은 것. 한도가 커지면 다시 해 본다), fullAt(Drive 폴더가
  // 가득 찼다는 답을 받은 시각. 하루 뒤에 다시 해 본다)}.
  // 첫 화면(올림)과 앱 화면(받아 감)이 함께 고치므로 읽고 쓰기를 저장소 작업 하나로 한다. change가 없으면 읽기만 한다.
  async function updateImageState(stamp, change) {
    const store = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = store.transaction("kv", change ? "readwrite" : "readonly");
        const kv = transaction.objectStore("kv");
        let state = null;
        const request = kv.get(IMAGE_STATE);
        request.onsuccess = () => {
          const saved = request.result;
          state = saved && saved.stamp === stamp && Array.isArray(saved.names) ? saved : { stamp, at: 0, names: [], skip: {} };
          if (!state.skip || typeof state.skip !== "object") state.skip = {};
          if (change) {
            change(state);
            kv.put(state, IMAGE_STATE);
          }
        };
        transaction.oncomplete = () => resolve(state);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      store.close();
    }
  }

  async function imageStamp(config) {
    return sha256Hex(ENCODER.encode(JSON.stringify([config.url, config.key])));
  }

  // 이 기기에 있고 Drive에 없는 사용 기록 이미지를 하나씩 올린다. 결과: "off"(연결 전)·"v1"(예전 스크립트, 멈춤)·"invalid"(기록을
  // 읽지 못함)·"none"(이 기기에 이미지가 없음)·"same"(모두 올라가 있음)·"uploaded"·"hidden"(화면을 숨겨 멈춤)·"full"(Drive 폴더가
  // 한도에 차서 하루 동안 쉼, 2026-10-31 교차 검토: 같은 이미지를 5분마다 통째로 다시 보냈다). 연결이 끊기면 오류를 내고 다음에 다시 한다.
  async function uploadImages() {
    const config = await drive.config();
    if (!config) return "off";
    if (driveV1()) return "v1";
    const local = await readLocalHistory();
    if (!local.valid) return "invalid";
    const images = historyImages(local.records);
    const present = images.length ? await persistPresent(images.map((image) => IMAGE_DIR + image.id + image.ext)) : new Set();
    const candidates = images.filter((image) => present.has(IMAGE_DIR + image.id + image.ext));
    if (!candidates.length) return "none";
    let info;
    try {
      info = await drive.ping();
    } catch (error) {
      if (error && error.code === "v1") return "v1";
      throw error;
    }
    // 이미지는 한 번 올리고 덮어쓰지 않는 새 파일이라 새 파일 한도(maxNewData, 예전 스크립트면 maxData)까지 한 파일로 올리고,
    // 넘으면 조각으로 나눈다(2026-10-31 사용자 요청: 새 파일 한도 50MB).
    const maxData = Number(info.limits && (info.limits.maxNewData || info.limits.maxData)) || 0;
    const stamp = await imageStamp(config);
    let state = await updateImageState(stamp, null);
    const fullAt = Number(state.fullAt) || 0;
    if (fullAt && fullAt <= Date.now() && Date.now() - fullAt < IMAGE_FULL_RETRY_MS) return "full";
    const listedAt = Number(state.at) || 0;
    if (Date.now() - listedAt > IMAGE_LIST_MS || listedAt > Date.now()) {
      const names = (await drive.list("image-")).map((file) => file.name);
      state = await updateImageState(stamp, (current) => {
        current.at = Date.now();
        current.names = names;
      });
    }
    const known = new Set(state.names);
    let uploaded = 0;
    for (const image of candidates) {
      if (document.visibilityState === "hidden") return "hidden";
      const name = await drive.imageName(image.id, image.ext);
      if (known.has(name)) continue;
      // 건너뛴 이미지는 그때보다 스크립트 한도가 커졌을 때만 다시 해 본다(예전 숫자 기록은 조각 올리기 전의 것이라 다시 해 본다).
      const skipped = state.skip[name];
      if (skipped && typeof skipped === "object" && maxData && Number(skipped.maxData) >= maxData) continue;
      const bytes = await persistRead(IMAGE_DIR + image.id + image.ext);
      // 깨진 파일은 올리지 않는다(받는 기기도 SHA-256을 확인한다).
      if (!bytes || !bytes.length || (await sha256Hex(bytes)) !== image.id) continue;
      const length = sealedLength(bytes.length);
      const piece = maxData ? chunkBytes(maxData) : bytes.length;
      const count = maxData && length > maxData ? Math.ceil(bytes.length / piece) : 1;
      const tooLarge = (current) => {
        current.skip[name] = { bytes: bytes.length, maxData };
      };
      if (bytes.length > IMAGE_MAX_BYTES || count > IMAGE_MAX_CHUNKS || piece < 1024) {
        state = await updateImageState(stamp, tooLarge);
        continue;
      }
      try {
        if (count === 1) {
          await drive.put(name, bytes, { ifAbsent: true, timeoutMs: transferTimeout(length) });
        } else {
          for (let index = 0; index < count; index += 1) {
            if (document.visibilityState === "hidden") return "hidden";
            const part = chunkName(name, piece, index);
            if (known.has(part)) continue;
            const slice = bytes.subarray(index * piece, Math.min(bytes.length, (index + 1) * piece));
            await drive.put(part, slice, { ifAbsent: true, timeoutMs: transferTimeout(sealedLength(slice.length)) });
            known.add(part);
            state = await updateImageState(stamp, (current) => {
              if (!current.names.includes(part)) current.names.push(part);
            });
          }
          const list = ENCODER.encode(IMAGE_CHUNKS_MAGIC + JSON.stringify({ count, size: bytes.length, piece, sha256: image.id }));
          await drive.put(name, list, { ifAbsent: true });
        }
      } catch (error) {
        if (error && error.code === "full") {
          await updateImageState(stamp, (current) => {
            current.fullAt = Date.now();
          });
          return "full";
        }
        if (!error || error.code !== "bad data") throw error;
        state = await updateImageState(stamp, tooLarge);
        continue;
      }
      known.add(name);
      uploaded += 1;
      state = await updateImageState(stamp, (current) => {
        if (!current.names.includes(name)) current.names.push(name);
        delete current.skip[name];
        delete current.fullAt;
      });
    }
    return uploaded ? "uploaded" : "same";
  }

  // 맨 위 창의 이미지 백업. run(): 지금 돌린다(돌고 있으면 그 뒤에 한 번 더 돈 결과). start(): 열 때(조금 뒤)·다시 띄울 때·5분마다·
  // 앱 화면이 기록이 바뀌었다고 알릴 때(drive.kick) 돌게 한다. 다른 창(탭)이 돌리고 있으면 그번은 건너뛴다("busy").
  function imageBackup() {
    let running = null;
    let queued = null;
    let timer = 0;
    function once() {
      const work = () => uploadImages().catch(() => "error");
      if (navigator.locks && typeof navigator.locks.request === "function") {
        return navigator.locks.request(IMAGE_LOCK, { ifAvailable: true }, (lock) => (lock ? work() : "busy")).catch(() => "error");
      }
      return work();
    }
    function run() {
      if (!running) {
        running = once().finally(() => {
          running = null;
        });
        return running;
      }
      if (!queued) {
        queued = running.then(() => {
          queued = null;
          return run();
        });
      }
      return queued;
    }
    function soon(delay) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState !== "hidden") run();
      }, delay);
    }
    function start() {
      imageKick = () => soon(IMAGE_KICK_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") soon(IMAGE_START_MS);
      });
      setInterval(() => {
        if (document.visibilityState === "visible") run();
      }, IMAGE_INTERVAL_MS);
      soon(IMAGE_START_MS);
    }
    return { run, start };
  }

  // 앱 화면(app-runtime.js)이 앱 저장소에 없는 사용 기록 이미지를 Drive에서 받아 간다('다시 사용'). 기록에서 그 id의 확장자를 찾아
  // Drive 이름을 정하고, 받아 풀어 SHA-256이 id와 같을 때만 {bytes, ext, type}을 돌려준다. Drive를 연결하지 않았거나 예전
  // 스크립트이거나 받지 못하면 null(화면이 이미지를 올려 달라고 안내한다).
  const imageFallback = {
    async fetch(id) {
      try {
        if (typeof id !== "string" || !IMAGE_ID.test(id)) return null;
        const config = await drive.config();
        if (!config || driveV1()) return null;
        const local = await readLocalHistory();
        for (const image of historyImages(local.records).filter((item) => item.id === id)) {
          const name = await drive.imageName(id, image.ext);
          const file = await drive.get(name, { timeoutMs: transferTimeout(sealedLength(image.size)) });
          if (!file) continue;
          let bytes = file.bytes;
          const chunks = readChunkList(bytes);
          if (chunks) {
            // 큰 이미지: 조각을 차례로 받아 잇는다(하나라도 없으면 받지 못한 것).
            bytes = new Uint8Array(chunks.size);
            let offset = 0;
            for (let index = 0; index < chunks.count; index += 1) {
              const part = await drive.get(chunkName(name, chunks.piece, index), { timeoutMs: transferTimeout(sealedLength(chunks.piece)) });
              if (!part || offset + part.bytes.length > chunks.size) throw new Error("조각이 빠졌거나 크기가 다릅니다.");
              bytes.set(part.bytes, offset);
              offset += part.bytes.length;
            }
            if (offset !== chunks.size) throw new Error("조각을 다 받지 못했습니다.");
          }
          if ((await sha256Hex(bytes)) !== id) continue;
          // 이 기기에도 생겼으니 Drive에 있는 것으로 적어 둔다(맨 위 창이 다시 올리지 않게).
          const stamp = await imageStamp(config);
          await updateImageState(stamp, (state) => {
            if (!state.names.includes(name)) state.names.push(name);
          }).catch(() => {});
          return { bytes, ext: image.ext, type: IMAGE_TYPES[image.ext] };
        }
      } catch (error) {
        // 받지 못했다. 화면이 이미지를 올려 달라고 안내한다.
      }
      return null;
    },
  };

  // 이 기기의 기록 파일 이름에 쓰는 임의 값(16자). 앱 파일을 다시 받아도 남도록 hwp-pwa 저장소에 둔다.
  async function deviceId() {
    let id = await db.get("deviceId");
    if (typeof id !== "string" || !/^[a-z0-9]{8,32}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      await db.set("deviceId", id);
    }
    return id;
  }

  // 기록이 빈 기기면 Drive의 기록을 합쳐 앱 저장소에 쓰고, 쓴 기록 개수를 돌려준다(쓸 것이 없으면 0). 이 기기에서 한 번만 한다.
  // 인터넷이 안 되면 오류를 내고 다음에 다시 한다(그사이 이 기기에서 변환해 기록이 생겼어도 그때 합친다).
  // canWrite: 쓰기 직전에 부른다. false면 쓰지 않고 다음에 다시 한다(앱 화면에서 작업 중이면 다시 불러올 수 없다).
  // timeoutMs: 목록을 기다리는 시간. 앱 화면은 넉넉히(폴더 전체를 훑고 기기마다 기록 내용을 담는다) 기다리고, 잠금 화면은 오래
  // 붙잡지 않게 짧게 기다린다(받지 못하면 앱 화면이 다시 가져온다).
  async function restoreHistory(config, canWrite, onFetch, timeoutMs = LIST_TIMEOUT_MS) {
    if (await db.get("restoreDone")) return 0;
    const local = await readLocalHistory();
    if (!local.valid) return 0;
    if (local.records.length && !(await db.get("restorePending"))) {
      await db.set("restoreDone", true);
      return 0;
    }
    await db.set("restorePending", true);
    if (onFetch) onFetch();
    const reply = await callSync(config, { op: "list" }, false, timeoutMs);
    const own = await deviceId();
    const payloads = [];
    for (const file of Array.isArray(reply.files) ? reply.files : []) {
      const match = SYNC_NAME.exec(String(file.name || ""));
      if (!match) continue;
      try {
        const payload = await openSealedHistory(config, file.name, String(file.data || ""));
        payloads.push({ device: match[1], savedAt: Number(payload.savedAt) || 0, absorbed: payload.absorbed || {}, records: payload.records });
      } catch (error) {
        // 다른 열쇠로 잠근 파일(예전 설정)이나 깨진 파일은 건너뛴다.
      }
    }
    // 풀 수 있는 파일이 하나도 없으면(Drive가 비었거나 폴더가 바뀜) 끝내지 않는다. 기록이 빈 동안은 앱을 열 때마다 다시 본다.
    if (!payloads.length) {
      await db.remove("restorePending");
      return 0;
    }
    const absorbed = {};
    const note = (device, savedAt) => {
      const time = Number(savedAt) || 0;
      if (!(absorbed[device] >= time)) absorbed[device] = time;
    };
    payloads.forEach((payload) => Object.entries(payload.absorbed).forEach(([device, savedAt]) => note(device, savedAt)));
    const live = payloads.filter((payload) => !(absorbed[payload.device] >= payload.savedAt));
    payloads.forEach((payload) => note(payload.device, payload.savedAt));
    delete absorbed[own];
    const merged = mergeHistory([local.records, ...live.map((payload) => payload.records)]);
    const changed = JSON.stringify(merged) !== JSON.stringify(local.records);
    if (changed) {
      if (canWrite && !canWrite()) return 0;
      // 목록을 기다리는 사이 앱 화면에서 기록이 바뀌었으면(삭제·변환) 예전 것으로 덮지 않고 다음에 다시 한다.
      const current = await readLocalHistory();
      if (!current.valid || JSON.stringify(current.records) !== JSON.stringify(local.records)) return 0;
      await writeLocalHistory(merged);
    }
    await db.set("absorbed", absorbed);
    await db.set("restoreDone", true);
    await db.remove("restorePending");
    return changed ? merged.length : 0;
  }

  // ── 잠금 화면 ──
  function runLock() {
    const $ = (id) => document.getElementById(id);
    const form = $("lock-form");
    const input = $("password");
    const button = $("unlock-button");
    const message = $("lock-message");
    const progress = $("progress");
    const progressText = $("progress-text");
    const progressBar = $("progress-bar");
    const resetButton = $("reset-button");
    const continueButton = $("continue-button");
    const safariGate = $("safari-gate");
    const versionEl = $("app-version");
    const relock = new URLSearchParams(location.search).has("unlock");
    // 아이폰 Safari 탭에서는 홈 화면 앱과 저장 공간이 따로라, 여기서 비밀번호를 넣으면 홈 화면 앱에서 다시 넣고 다시 받아야 한다.
    // 그래서 안내를 먼저 보이고, 비밀번호 칸은 'Safari에서 그냥 쓰기'를 눌렀을 때만 보인다.
    let gated = IOS_DEVICE && !STANDALONE && !relock;

    if (IOS_DEVICE && !STANDALONE) $("install-hint").hidden = false;

    function showForm(text, isError) {
      progress.hidden = true;
      safariGate.hidden = !gated;
      form.hidden = gated;
      button.disabled = false;
      input.disabled = false;
      message.textContent = text || "";
      message.classList.toggle("is-error", Boolean(isError));
    }

    function showProgress(text, fraction) {
      form.hidden = true;
      safariGate.hidden = true;
      progress.hidden = false;
      progressText.textContent = text;
      progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100)}%`;
    }

    // offerReset: 앱 화면을 열지 못할 때만 '앱 파일 다시 받기'를 보인다. 받기가 잠깐 끊긴 경우에는 '열기'가 이어 받으므로
    // 보이지 않는다. 그 단추는 쓰던 버전까지 지우기 때문이다(2026-10-29 교차 검토).
    function showFailure(text, offerReset) {
      gated = false;
      showForm(text, true);
      resetButton.hidden = !offerReset;
    }

    function openApp() {
      const now = Date.now();
      let attempts = [];
      try {
        attempts = JSON.parse(sessionStorage.getItem(OPEN_ATTEMPTS_KEY) || "[]").filter((time) => now - time < 15000);
      } catch (error) {
        attempts = [];
      }
      if (attempts.length >= 2) {
        showFailure("앱 화면을 열지 못했습니다. 앱을 완전히 닫았다가 다시 열거나, 인터넷에 연결된 상태에서 아래 '앱 파일 다시 받기'를 눌러 주세요.", true);
        return;
      }
      attempts.push(now);
      try {
        sessionStorage.setItem(OPEN_ATTEMPTS_KEY, JSON.stringify(attempts));
      } catch (error) {
        // 저장하지 못해도 연다.
      }
      showProgress("앱을 여는 중입니다.", 1);
      const go = () => location.replace(SCOPE);
      if (navigator.serviceWorker.controller) {
        go();
        return;
      }
      navigator.serviceWorker.addEventListener("controllerchange", go, { once: true });
      setTimeout(go, 4000);
    }

    // 앱 화면을 열기 전에(엔진이 기록을 읽기 전에) 기록이 빈 기기면 Google Drive의 기록을 되살린다.
    // 인터넷이 안 되거나 저장소가 답하지 않으면 그냥 열고, 앱 화면이 다음에 다시 가져온다.
    async function restoreThenOpen(version) {
      try {
        const config = await loadSyncConfig(version);
        if (config) await restoreHistory(config, null, () => showProgress("Google Drive에서 사용 기록을 가져오는 중입니다.", 1), SYNC_TIMEOUT_MS);
      } catch (error) {
        // 앱 화면이 다음에 다시 가져온다.
      }
      openApp();
    }

    async function installAndOpen(info, keyBytes) {
      showProgress("앱 파일을 받는 중입니다. 화면을 켜 둔 채 잠시 기다려 주세요.", 0);
      await install(info, keyBytes, (done, total) => {
        const text = total
          ? `앱 파일을 받는 중입니다. ${formatMegabytes(done)} / ${formatMegabytes(total)}MB. 화면을 켜 둔 채 잠시 기다려 주세요.`
          : "앱 파일을 준비하는 중입니다.";
        showProgress(text, total ? done / total : 1);
      });
      showProgress("앱 파일을 준비하는 중입니다.", 1);
      await activate(info.version);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      await restoreThenOpen(info.version);
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = input.value;
      if (!normalizePassword(password)) {
        showForm("비밀번호를 넣어 주세요.", true);
        return;
      }
      button.disabled = true;
      input.disabled = true;
      message.classList.remove("is-error");
      message.textContent = "비밀번호를 확인하는 중입니다.";
      let info;
      try {
        info = await fetchVersionInfo();
      } catch (error) {
        showForm(`인터넷 연결을 확인한 뒤 다시 눌러 주세요. (${error.message || error})`, true);
        return;
      }
      const keyBytes = await deriveKey(password, info.vault);
      if (!(await keyMatches(keyBytes, info.vault))) {
        showForm("비밀번호가 맞지 않습니다.", true);
        input.select();
        return;
      }
      try {
        await db.set("key", keyBytes);
        // 비밀번호 변경을 되돌린 경우 등, 올라간 버전이 이미 쓰는 버전이면 받지 않고 연다.
        const active = await db.get("active");
        if (info.version === active && (await isInstalled(active))) {
          await restoreThenOpen(active);
          return;
        }
        await installAndOpen(info, keyBytes);
      } catch (error) {
        showFailure(`앱 파일을 받지 못했습니다. 인터넷 연결을 확인한 뒤 '열기'를 다시 눌러 주세요. 받은 파일은 남겨 두고 이어서 받습니다. (${error.message || error})`, false);
      }
    });

    $("safari-continue").addEventListener("click", () => {
      gated = false;
      showForm("");
      input.focus();
    });

    resetButton.addEventListener("click", async () => {
      resetButton.disabled = true;
      // 지금 다시 받을 수 있을 때만 지운다(지운 뒤 받지 못하면 앱을 열 수 없다).
      if (!(await canReinstall())) {
        resetButton.disabled = false;
        showFailure("사이트에 연결되지 않았습니다. 인터넷 연결을 확인한 뒤 '앱 파일 다시 받기'를 다시 눌러 주세요.", true);
        return;
      }
      try {
        await resetAppFiles();
      } catch (error) {
        // 다시 읽어 들이면서 처음부터 한다.
      }
      location.replace(SCOPE);
    });

    continueButton.addEventListener("click", () => location.replace(SCOPE));

    (async () => {
      try {
        await registerWorker();
      } catch (error) {
        showFailure(error.message || String(error), false);
        return;
      }
      let info = null;
      try {
        info = await fetchVersionInfo();
        if (versionEl) versionEl.textContent = `버전 ${info.app_version}`;
      } catch (error) {
        info = null;
      }
      const active = await db.get("active");
      const installed = Boolean(active) && (await isInstalled(active));
      if (relock && installed && info && info.version === active) {
        // 비밀번호 변경이 되돌려졌다(올라간 버전이 쓰는 버전이다). 비밀번호를 묻지 않고 앱으로 돌아간다.
        location.replace(SCOPE);
        return;
      }
      const storedKey = await db.get("key");
      if (relock && info && (await keyMatches(storedKey, info.vault))) {
        // 저장된 열쇠로 올라간 버전이 풀린다(비밀번호 변경을 되돌린 배포 등). 묻지 않고 받아서 연다.
        try {
          await installAndOpen(info, storedKey);
        } catch (error) {
          continueButton.hidden = !installed;
          showFailure(`앱 파일을 받지 못했습니다. 인터넷 연결을 확인한 뒤 다시 열어 주세요. (${error.message || error})`, false);
        }
        return;
      }
      if (relock) {
        // 비밀번호가 바뀐 새 버전을 받으려는 것이다. 지금 버전은 그대로 쓸 수 있으므로 돌아갈 단추를 보인다.
        continueButton.hidden = !installed;
        showForm(
          info
            ? "비밀번호가 바뀌었습니다. 새 비밀번호를 넣어 주세요."
            : "인터넷에 연결되지 않았습니다. 지금 버전을 계속 쓰다가 인터넷에 연결된 뒤 다시 넣어 주세요.",
          !info,
        );
        return;
      }
      if (installed) {
        await restoreThenOpen(active);
        return;
      }
      // 비밀번호를 넣은 적이 있으면(앱 파일만 지워졌거나 새 버전) 저장된 열쇠로 다시 받는다.
      const keyBytes = await db.get("key");
      if (info && keyBytes && (await keyMatches(keyBytes, info.vault))) {
        try {
          await installAndOpen(info, keyBytes);
        } catch (error) {
          showFailure(`앱 파일을 받지 못했습니다. 인터넷 연결을 확인한 뒤 앱을 다시 열어 주세요. 받은 파일은 남겨 두고 이어서 받습니다. (${error.message || error})`, false);
        }
        return;
      }
      showForm(info ? "" : "인터넷에 연결된 상태에서 처음 한 번 비밀번호를 넣어야 합니다.", !info);
    })();
  }

  // ── 첫 화면·앱 화면: 새 버전 확인과 사용 기록 백업 ──
  // home(첫 화면): 새 버전 확인·알림·바꾸기와 사용 기록 이미지 백업을 한다. 사용 기록은 앱 화면(틀) 안에서만 바뀌므로 백업하지 않는다.
  // embedded(첫 화면 틀 안의 앱 화면): 업데이트 확인·알림·받아 둔 버전 바꾸기·서비스 워커 등록·이미지 올리기를 하지 않는다. 사용
  //   기록 백업과 막힌 시작 화면의 '앱 파일 다시 받기'만 하고, 새 버전 확인은 첫 화면에 부탁한다. 되살린 기록은 이 틀만 다시
  //   불러오고, 기록을 올리면 첫 화면에 이미지 백업을 알린다(drive.kick). 이미지를 받아 가는 것(HwpMobileImageFallback)은 한다.
  // 둘 다 아니면(앱 화면을 맨 위 창으로 엶) 예전처럼 모두 하고 이미지 백업도 한다.
  function runApp(home, embedded) {
    let lastCheck = 0;
    let checkRun = null;
    let pending = null;
    let retryTimer = 0;

    // 화면의 연결(앱 화면은 app-runtime.js, 첫 화면은 home-host.js). 버전이 섞여도(예전 화면 + 새 이 파일) 멈추지 않게
    // 없는 기능은 기본값으로 둔다.
    function host() {
      const target = global.HwpMobileHost;
      if (!target) return null;
      const call = (name, fallback) => (typeof target[name] === "function" ? target[name].bind(target) : fallback);
      return {
        notify: call("notify", () => {}),
        hideNotice: call("hideNotice", () => false),
        notice: call("notice", () => null),
        isBusy: call("isBusy", () => false),
        hasWork: call("hasWork", () => false),
        isBlocked: call("isBlocked", () => false),
        onBlocked: call("onBlocked", () => {}),
        addBlockedAction: call("addBlockedAction", () => {}),
      };
    }

    function updateNotice() {
      return `새 버전(${pending.label})이 준비되었습니다. '업데이트'를 누르면 화면을 다시 불러와 바로 바뀝니다. 지금 누르지 않으면 다음에 앱을 열 때 바뀝니다.`;
    }

    // fresh: 새로 알릴 것이 생겼다(새 버전을 받음, 비밀번호가 바뀜). 아니면 같은 안내를 다시 보이는 것이다.
    function announce(fresh) {
      const target = host();
      if (!target || !pending) return;
      clearTimeout(retryTimer);
      // 시작 화면이 막혀 있으면(엔진 시작 실패 등) 잃을 작업이 없으므로 바로 새 버전으로 바꾼다. 알림은 그 화면에 가려 보이지 않는다.
      if (target.isBlocked()) {
        if (pending.relock) target.addBlockedAction("비밀번호 다시 넣기", () => location.replace(`${SCOPE}?unlock=1`));
        else applyUpdate(true);
        return;
      }
      const current = target.notice();
      // 같은 안내('지금 업데이트' 확인 포함)를 이미 보이고 있으면, 다시 화면에 띄울 때마다 처음 안내로 덮지 않는다.
      if (!fresh && current && current.owner === "pwa-update") return;
      // '저장·공유' 같은 다른 알림의 단추를 덮어쓰지 않는다. 그 알림이 닫힌 뒤 다시 알린다.
      if (current && current.action && current.owner !== "pwa-update") {
        retryTimer = setTimeout(() => announce(true), NOTICE_RETRY_MS);
        return;
      }
      if (pending.relock) {
        target.notify("새 버전을 받으려면 비밀번호를 다시 넣어야 합니다.", {
          action: () => goRelock(false),
          actionLabel: "비밀번호 넣기",
          sticky: true,
          owner: "pwa-update",
        });
        return;
      }
      target.notify(updateNotice(), { action: () => applyUpdate(false), actionLabel: "업데이트", sticky: true, owner: "pwa-update" });
    }

    // 비밀번호 화면으로 가면 이 화면을 떠나므로, 고른 파일·변환 결과가 있으면 한 번 더 묻는다(업데이트와 같다).
    function goRelock(confirmed) {
      const target = host();
      if (target && target.isBusy()) {
        target.notify("EPUB을 만드는 중입니다. 변환이 끝난 뒤 '비밀번호 넣기'를 다시 눌러 주세요.", {
          action: () => goRelock(false),
          actionLabel: "비밀번호 넣기",
          sticky: true,
          owner: "pwa-update",
        });
        return;
      }
      if (!confirmed && target && target.hasWork()) {
        target.notify("비밀번호 화면으로 가면 고른 파일과 이번 변환 결과가 지워집니다. 결과 파일을 먼저 저장한 뒤 누르세요.", {
          action: () => goRelock(true),
          actionLabel: "지금 넣기",
          sticky: true,
          owner: "pwa-update",
        });
        return;
      }
      location.replace(`${SCOPE}?unlock=1`);
    }

    // 알릴 것이 없어졌다(되돌린 배포·비밀번호 변경). 안내를 닫고, 받아 둔 다른 버전을 지운다.
    async function withdraw() {
      pending = null;
      clearTimeout(retryTimer);
      const target = host();
      if (target) target.hideNotice("pwa-update");
      await db.remove("pending");
      await pruneCaches(null);
    }

    async function applyUpdate(confirmed) {
      const target = host();
      if (target && target.isBusy()) {
        target.notify("EPUB을 만드는 중입니다. 변환이 끝난 뒤 '업데이트'를 다시 눌러 주세요.", {
          action: () => applyUpdate(false),
          actionLabel: "업데이트",
          sticky: true,
          owner: "pwa-update",
        });
        return;
      }
      // 화면을 다시 불러오면 고른 파일과 이번 변환 결과(아이폰은 '저장·공유'로 내보내기 전까지 이 화면에만 있다)가 사라진다.
      if (!confirmed && target && target.hasWork()) {
        target.notify("업데이트하면 화면을 다시 불러와 고른 파일과 이번 변환 결과가 지워집니다. 결과 파일을 먼저 저장한 뒤 누르세요.", {
          action: () => applyUpdate(true),
          actionLabel: "지금 업데이트",
          sticky: true,
          owner: "pwa-update",
        });
        return;
      }
      if (!pending || !pending.version) return;
      if (target) target.notify("업데이트하는 중입니다.", { sticky: true, owner: "pwa-update" });
      // 더 새 버전을 받는 중이면 끝날 때까지 기다린다. 끝나면 pending이 그 버전(또는 비밀번호 변경)으로 바뀐다.
      if (checkRun) await checkRun;
      if (!pending || !pending.version) {
        announce(true);
        return;
      }
      const waiting = pending.version;
      // 그사이 배포가 되돌려졌거나 받아 둔 버전이 온전하지 않으면 바꾸지 않는다. 인터넷이 없거나 늦으면(3초) 받아 둔 버전으로 바꾼다.
      const published = await publishedVersion();
      if ((published && published !== waiting) || !(await isInstalled(waiting))) {
        await withdraw();
        check(true);
        return;
      }
      // 확인하는 사이에 변환을 시작했거나 파일을 골랐으면 바꾸지 않고 다시 묻는다(다시 불러오면 사라진다).
      const now = host();
      if (now && (now.isBusy() || (!confirmed && now.hasWork()))) {
        applyUpdate(false);
        return;
      }
      try {
        await activate(waiting);
      } catch (error) {
        await withdraw();
        check(true);
        return;
      }
      location.replace(SCOPE);
    }

    // 지금 올라간 버전. 인터넷이 없거나 3초 안에 답이 없으면 null.
    function publishedVersion() {
      return Promise.race([
        fetchVersionInfo().then((info) => info.version).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
    }

    // 확인은 한 번에 하나만 돈다. '업데이트'는 도는 확인(새 버전 받기)이 끝나기를 기다린 뒤에 바꾼다(2026-10-29 확인 검토:
    // 받는 중에 누르면 받던 캐시를 지우고 반쪽 버전을 쓰려다 쓰던 버전까지 지울 수 있었다).
    function check(force) {
      if (checkRun) return checkRun;
      if (!force && Date.now() - lastCheck < UPDATE_INTERVAL_MS) {
        announce(false);
        return Promise.resolve();
      }
      lastCheck = Date.now();
      checkRun = runCheck().finally(() => {
        checkRun = null;
      });
      return checkRun;
    }

    async function runCheck() {
      try {
        const [active, info] = await Promise.all([db.get("active"), fetchVersionInfo()]);
        if (info.version === active) {
          await withdraw();
          return;
        }
        if (!(await isInstalled(info.version))) {
          const keyBytes = await db.get("key");
          if (!(await keyMatches(keyBytes, info.vault))) {
            const fresh = !pending || !pending.relock;
            pending = { relock: true };
            // 받아 둔 다른 버전은 이제 쓰지 않는다. 쓰는 버전만 남긴다.
            await db.remove("pending");
            await pruneCaches(null);
            announce(fresh);
            return;
          }
          await install(info, keyBytes);
        }
        await db.set("pending", info.version);
        // 받아 둔 버전이 바뀌었으면(그사이 새 배포) 예전 것은 지운다. 쓰는 버전과 이번 버전만 남긴다.
        await pruneCaches(info.version);
        const fresh = !pending || pending.version !== info.version;
        pending = { version: info.version, label: info.app_version };
        announce(fresh);
      } catch (error) {
        // 인터넷이 없거나 받는 중에 끊기면 다음에 다시 확인한다.
      }
    }

    // 받아 두고 '업데이트'를 누르지 않은 새 버전은 다음에 앱을 처음부터 열 때 바꾼다(아직 고른 파일도 결과도 없을 때).
    async function applyPendingAtStart() {
      try {
        const [active, waiting] = await Promise.all([db.get("active"), db.get("pending")]);
        if (!waiting || waiting === active) return false;
        if (!(await isInstalled(waiting))) {
          await db.remove("pending");
          await pruneCaches(null);
          return false;
        }
        const target = host();
        if (target && target.hasWork()) return false;
        // 그사이 배포가 되돌려졌으면 바꾸지 않고 받아 둔 것을 지운다. 인터넷이 없거나 늦으면(3초) 받아 둔 버전으로 바꾼다.
        const published = await publishedVersion();
        if (published && published !== waiting) {
          await db.remove("pending");
          await pruneCaches(null);
          return false;
        }
        await activate(waiting);
        location.replace(SCOPE);
        return true;
      } catch (error) {
        return false;
      }
    }

    // 틀 안의 앱 화면: 새 버전 확인은 첫 화면에 부탁한다. 첫 화면 스크립트가 아직 시작하지 않았으면 첫 화면이 열 때 확인한다.
    // 받아 둔 새 버전이 있으면 첫 화면이 막힌 틀을 보고(HwpMobileHost.isBlocked) 저절로 적용한다.
    function checkFromHome() {
      try {
        const homeWin = homeWindow();
        if (homeWin && homeWin.HwpPwa && typeof homeWin.HwpPwa.check === "function") homeWin.HwpPwa.check(true);
      } catch (error) {
        // 첫 화면이 열 때·다시 띄울 때 확인한다.
      }
    }

    // 시작 화면이 막히면 새 버전이 있는지 바로 보고, '앱 파일 다시 받기'로 앱 파일을 새로 받을 수 있게 한다.
    function watchBlocked() {
      const target = host();
      if (!target) return;
      const onBlocked = () => {
        target.addBlockedAction("앱 파일 다시 받기", async () => {
          // 앱 파일을 지운 뒤 받지 못하면 앱을 아예 열 수 없으므로, 지금 다시 받을 수 있을 때만 지운다.
          if (!(await canReinstall())) {
            target.notify("사이트에 연결되지 않았습니다. 인터넷 연결을 확인한 뒤 '앱 파일 다시 받기'를 다시 눌러 주세요.", { error: true });
            return;
          }
          try {
            await resetAppFiles();
          } catch (error) {
            // 다시 읽어 들이면서 처음부터 한다.
          }
          // 틀 안이면 첫 화면(맨 위 창)째 다시 연다.
          leave(SCOPE);
        });
        if (embedded) checkFromHome();
        else check(true);
      };
      if (target.isBlocked()) onBlocked();
      else target.onBlocked(onBlocked);
    }

    // ── 사용 기록 Google Drive 백업: 기록이 바뀌면(사용 기록 목록이 다시 그려지면) 잠시 뒤 올린다 ──
    const UPLOAD_DELAY_MS = 3000;
    const UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
    // 바뀐 것이 없어도 하루에 한 번은 다시 올린다(Drive에서 파일이 지워졌거나 폴더가 바뀌었어도 되살아나게).
    const RESEND_MS = 24 * 60 * 60 * 1000;
    let syncConfig = null;
    let syncRun = null;
    let syncAgain = false;
    let syncTimer = 0;
    // 이번에 앱을 연 뒤 기록이 있는 것을 본 적이 있는지. 없고 Drive 파일에도 기록이 없으면 빈 기록은 올리지 않는다(저장
    // 공간이 지워진 기기가 Drive의 기록까지 비우지 않게). 쓰다가 마지막 기록을 지운 것은 빈 기록으로 올린다.
    let sawRecords = false;

    function syncSoon(delay) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => syncNow().catch(() => {}), delay);
    }

    // 지금 올린다. 도는 중이면 끝난 뒤 한 번 더 돈다. 결과: "off"(연결 전), "invalid", "empty", "same", "uploaded".
    function syncNow(leaving) {
      if (!syncConfig) return Promise.resolve("off");
      if (syncRun) {
        syncAgain = true;
        return syncRun;
      }
      syncRun = uploadHistory(syncConfig, leaving)
        .then((result) => {
          // 기록이 바뀌었으면(새 표지·부제 이미지가 있을 수 있다) 맨 위 창의 이미지 백업을 곧 돌리게 한다.
          if (result === "uploaded" && !leaving) kickImages();
          return result;
        })
        .finally(() => {
          syncRun = null;
          if (syncAgain) {
            syncAgain = false;
            syncSoon(0);
          }
        });
      return syncRun;
    }

    // 이미지 백업은 맨 위 창만 한다. 틀 안이면 첫 화면에 알리고, 맨 위 창이면 이 화면의 것을 돌린다.
    function kickImages() {
      try {
        const target = embedded ? homeWindow() : global;
        const helper = target && target.HwpPwa && target.HwpPwa.drive;
        if (helper && typeof helper.kick === "function") helper.kick();
      } catch (error) {
        // 첫 화면이 다시 띄울 때·5분마다 올린다.
      }
    }

    // synced: 마지막으로 올린 것 {stamp(주소·열쇠·내용), time, count}. syncContent: 내용마다 처음 정한 저장 시각 {content, savedAt}.
    async function uploadHistory(config, leaving) {
      const local = await readLocalHistory();
      if (!local.valid) return "invalid";
      const synced = (await db.get("synced")) || {};
      if (local.records.length) sawRecords = true;
      else if (!sawRecords && !synced.count) return "empty";
      const absorbed = (await db.get("absorbed")) || {};
      const content = await sha256Hex(ENCODER.encode(JSON.stringify([absorbed, local.records])));
      const stamp = await sha256Hex(ENCODER.encode(JSON.stringify([config.url, config.key, content])));
      if (stamp === synced.stamp && Date.now() - (Number(synced.time) || 0) < RESEND_MS) return "same";
      // 내용이 같으면 처음 정한 저장 시각을 그대로 쓴다(답을 못 받아 다시 보내거나 하루 만에 다시 올려도 같다).
      // 저장 시각이 바뀌면 다른 기기가 흡수한(absorbed) 이 파일이 되살리기에서 다시 쓰여, 지운 기록이 돌아온다.
      let version = await db.get("syncContent");
      if (!version || version.content !== content) {
        version = { content, savedAt: Date.now() };
        await db.set("syncContent", version);
      }
      const name = `history-${await deviceId()}`;
      const data = await sealHistory(config, name, { format: 1, savedAt: version.savedAt, absorbed, records: local.records });
      await callSync(config, { op: "put", name, data }, leaving);
      await db.set("synced", { stamp, time: Date.now(), count: local.records.length });
      return "uploaded";
    }

    async function startHistorySync() {
      const config = await loadSyncConfig(await db.get("active"));
      if (!config) return;
      try {
        // 잠금 화면에서 되살리지 못했으면(인터넷 끊김 등) 여기서 다시 한다. 엔진은 이미 예전 기록으로 시작했으므로,
        // 되살린 기록을 썼으면 화면을 다시 불러온다. 고른 파일·변환 결과가 있으면 쓰지 않고 다음에 연다.
        const written = await restoreHistory(config, () => {
          const target = host();
          return !(target && (target.isBusy() || target.hasWork()));
        });
        if (written) {
          // 첫 화면의 틀 안이면 이 틀(앱 화면)만 다시 불러온다. 첫 화면의 다른 도구는 그대로 둔다.
          if (embedded) location.reload();
          else location.replace(SCOPE);
          return;
        }
      } catch (error) {
        // 다음에 앱을 열 때 다시 가져온다.
      }
      sawRecords = (await readLocalHistory()).records.length > 0;
      syncConfig = config;
      const list = document.getElementById("history-list");
      if (list && typeof MutationObserver === "function") new MutationObserver(() => syncSoon(UPLOAD_DELAY_MS)).observe(list, { childList: true });
      // 앱을 떠날 때는 바로 올린다(아이폰은 뒤로 간 앱을 곧 멈춘다). 돌아오면 그사이 올리지 못한 것을 올린다.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") syncNow(true).catch(() => {});
        else syncSoon(UPLOAD_DELAY_MS);
      });
      setInterval(() => {
        if (document.visibilityState === "visible") syncNow().catch(() => {});
      }, UPLOAD_INTERVAL_MS);
      syncSoon(UPLOAD_DELAY_MS);
    }

    if (embedded) {
      startHistorySync().catch(() => {});
      watchBlocked();
      return { syncNow };
    }
    // 사용 기록 이미지 Drive 백업은 맨 위 창(첫 화면, 맨 위 창으로 연 앱 화면)만 한다(HwpPwa.syncImages()는 시험에서 바로 부른다).
    const images = imageBackup();
    applyPendingAtStart().then((reloading) => {
      if (reloading) return;
      if (!home) startHistorySync().catch(() => {});
      images.start();
      registerWorker()
        .then((registration) => {
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") registration.update().catch(() => {});
          });
        })
        .catch(() => {});
      // 첫 화면은 막힌 시작 화면이 없다. 틀 안의 앱 화면이 막히면 그쪽이 '앱 파일 다시 받기'를 더하고 확인을 부탁한다.
      if (!home) watchBlocked();
      if (document.readyState === "complete") setTimeout(() => check(true), 4000);
      else global.addEventListener("load", () => setTimeout(() => check(true), 4000));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check(false);
      });
    });
    return home ? { check, syncImages: images.run } : { check, syncNow, syncImages: images.run };
  }

  // mode: "lock"·"home"·"app". embedded: 첫 화면 틀 안의 앱 화면. drive: 위 'Google Drive 저장소 도구'.
  const api = { SCOPE, mode: MODE, embedded: EMBEDDED, fetchVersionInfo, isInstalled, keyMatches, deriveKey, drive };
  // 앱 화면(틀 안이든 맨 위 창이든)의 app-runtime.js가 저장소에 없는 사용 기록 이미지를 이것으로 Drive에서 받는다.
  if (MODE === "app") global.HwpMobileImageFallback = imageFallback;
  if (MODE === "app" || MODE === "home") {
    const start = () => Object.assign(api, runApp(MODE === "home", EMBEDDED));
    // 화면의 HwpMobileHost(앱 화면은 app-runtime.js, 첫 화면은 이 파일보다 먼저 도는 home-host.js)가 준비된 뒤에 시작한다.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  } else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", runLock);
  else runLock();
  global.HwpPwa = api;
  // 첫 화면의 연결 스크립트(home-host.js)는 이 신호를 받고 HwpPwa.drive로 작업 자료 저장을 시작한다.
  try {
    global.dispatchEvent(new Event("hwp-pwa-ready"));
  } catch (error) {
    // 오래된 브라우저: 연결 스크립트가 HwpPwa를 직접 찾는다.
  }
})(window);
