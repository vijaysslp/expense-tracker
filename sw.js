
const CACHE="expensepro-v7";
const ASSETS=["./","./index.html","./style.css?v=7","./script.js?v=7","./manifest.json","./icon-192.png","./icon-512.png",
"https://cdn.jsdelivr.net/npm/chart.js@4.4.1",
"https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
"https://accounts.google.com/gsi/client"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener("activate",e=>{e.waitUntil(self.clients.claim())});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(u.origin===location.origin){e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));}});
