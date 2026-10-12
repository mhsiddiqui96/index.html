/* Service worker: makes the app installable, keeps the app shell available offline and shows push notifications. */
const CACHE = 'wa-saas-shell-v1';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Network first (so updates show up immediately); fall back to the cached shell when offline. API calls are never cached.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin ||
      url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhook')) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      if (res.ok && SHELL.includes(url.pathname)) (await caches.open(CACHE)).put(event.request, res.clone());
      return res;
    } catch {
      return (await caches.match(event.request)) ||
        (event.request.mode === 'navigate' ? caches.match('/') : Response.error());
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'নতুন মেসেজ', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || 'message',
      renotify: true,
      data: { url: data.url || '/#/inbox' },
    });
    if (typeof data.unread === 'number' && self.navigator.setAppBadge) {
      try { await self.navigator.setAppBadge(data.unread); } catch { /* not supported */ }
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/#/inbox', location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === location.origin) {
        await client.focus();
        client.postMessage({ type: 'open', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
