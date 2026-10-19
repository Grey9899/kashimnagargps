// কাশিমনগর সরকারি প্রাথমিক বিদ্যালয় — সার্ভিস ওয়ার্কার
// দ্রুত লোডের জন্য: একবার লোড হলে ফাইল (Tailwind, আইকন, ফন্ট সহ) মোবাইলে জমা থাকে; পরেরবার সঙ্গে সঙ্গে খোলে এবং পেছনে নতুন সংস্করণ নামিয়ে রাখে।
const CACHE = 'kashimnagar-v2';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const CDN = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === location.origin;
  // Firebase ও অন্য বাইরের সার্ভিস সরাসরি নেটে যাক; শুধু পরিচিত CDN জমা হবে
  if (!same && CDN.indexOf(url.hostname) < 0) return;
  e.respondWith(caches.open(CACHE).then(cache => cache.match(req, { ignoreSearch: false }).then(hit => {
    const net = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }).catch(() => hit || (req.mode === 'navigate' ? cache.match('./index.html') : undefined));
    return hit || net;
  })));
});
