// Cache só do "shell" estático — nunca de /api/*, pra não arriscar servir
// uma resposta de login/sync antiga ou quebrar a sincronização entre abas.
var CACHE_NAME = "quack-shell-v1";
var SHELL = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(SHELL); })
  );
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(names.filter(function(n){ return n !== CACHE_NAME; }).map(function(n){ return caches.delete(n); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

// não força a nova versão sozinho no install — trocar o service worker no
// meio de um pomodoro rodando seria estranho mesmo sem perder dado (o
// timer vive no localStorage). Só troca quando a própria aba mandar o aviso,
// depois que a pessoa confirmar no prompt de atualização.
self.addEventListener("message", function(event){
  if(event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function(event){
  var req = event.request;
  if(req.method !== "GET") return;

  var url = new URL(req.url);
  if(url.origin !== self.location.origin) return;
  if(url.pathname.indexOf("/api/") === 0) return;

  if(req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html"){
    event.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put("/", copy); });
        return res;
      }).catch(function(){ return caches.match("/"); })
    );
    return;
  }

  if(url.pathname === "/manifest.json" || url.pathname.indexOf("/icons/") === 0){
    event.respondWith(
      caches.match(req).then(function(cached){
        return cached || fetch(req).then(function(res){
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(req, copy); });
          return res;
        });
      })
    );
  }
});
