/*
 * NextSpot 서비스 워커 — 정적 export(output: 'export') 호환.
 * 목표: 설치형 PWA가 오프라인/백엔드 장애 상황에서도 앱 셸을 띄운다.
 *
 * 전략
 *  - 내비게이션(문서 요청): network-first → 캐시 → /offline.html
 *  - 정적 동일출처 GET: stale-while-revalidate(먼저 캐시로 응답, 백그라운드 갱신)
 *  - API/교차출처: 절대 가로채지 않음 → 항상 네트워크(신선도 보장, 인증/실시간)
 *
 * 캐시 버전은 이름에 박아 두고(nextspot-v1), skipWaiting + clients.claim 로
 * 새 워커가 즉시 활성화되며 activate 에서 옛 버전 캐시를 정리한다.
 */

const CACHE_VERSION = 'nextspot-v1';

// 안전하게 참조 가능한 앱 셸 / 핵심 정적 자산.
// (실패해도 설치를 막지 않도록 개별 add — 일부 경로가 export 산출에 없더라도 무해)
const CORE_ASSETS = [
  '/',
  '/main',
  '/offline.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

const OFFLINE_URL = '/offline.html';

// ── install: 앱 셸 프리캐시(개별·내결함) + 즉시 대기 해제 ───────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // addAll 은 하나라도 404 면 전체 실패하므로 개별 add 로 내결함 처리.
      await Promise.allSettled(
        CORE_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
      );
    })()
  );
  self.skipWaiting();
});

// ── activate: 옛 버전 캐시 제거 + 즉시 클라이언트 장악 ──────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// API/가로채지 말아야 할 요청 판별.
function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

// ── fetch: 라우팅 ─────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // GET 이외(POST 등)는 절대 캐시/가로채기 하지 않는다.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return; // URL 파싱 실패 시 브라우저 기본 동작에 맡긴다.
  }

  // 교차출처(FastAPI localhost:8000, Supabase, Kakao 등)는 항상 네트워크.
  if (url.origin !== self.location.origin) return;

  // 동일출처 API 경로도 캐시 금지 — 항상 네트워크.
  if (isApiRequest(url)) return;

  // 내비게이션(문서 요청): network-first → 캐시 → 오프라인 폴백.
  const isNavigation =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    event.respondWith(handleNavigation(request));
    return;
  }

  // 그 외 동일출처 정적 GET: stale-while-revalidate.
  event.respondWith(handleStatic(request));
});

// 내비게이션: 네트워크 우선, 실패 시 캐시, 그다음 오프라인 페이지.
async function handleNavigation(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const network = await fetch(request);
    // 성공 응답은 캐시에 반영(다음 오프라인 대비).
    if (network && network.ok) {
      cache.put(request, network.clone()).catch(() => {});
    }
    return network;
  } catch {
    // 오프라인/네트워크 실패 → 캐시된 페이지 → 정확 매치 실패 시 오프라인 폴백.
    const cached = await cache.match(request);
    if (cached) return cached;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    // 폴백 자산조차 없으면 최후로 네트워크를 한 번 더 시도(에러 전파 방지).
    return fetch(request);
  }
}

// 정적 자산: 캐시 즉시 응답 + 백그라운드 갱신(stale-while-revalidate).
async function handleStatic(request) {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);

    const networkFetch = fetch(request)
      .then((response) => {
        if (response && response.ok) {
          cache.put(request, response.clone()).catch(() => {});
        }
        return response;
      })
      .catch(() => undefined);

    // 캐시가 있으면 즉시 반환하고 네트워크는 백그라운드로 갱신.
    if (cached) {
      void networkFetch; // fire-and-forget: 백그라운드 갱신
      return cached;
    }
    const network = await networkFetch;
    if (network) return network;
    // 캐시·네트워크 모두 실패 — 핸들러 에러가 페이지를 막지 않도록 재시도.
    return fetch(request);
  } catch {
    // 어떤 이유로든 핸들러가 실패하면 순수 네트워크로 폴백.
    return fetch(request);
  }
}
