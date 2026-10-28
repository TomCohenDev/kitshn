// K-1606, K-1907: the service worker of the kitshn map. It shows Web Push notifications and opens the map on a
// click. It caches nothing: the map sits behind Access, and a cache could show a stale map.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const message = event.data
    ? event.data.json()
    : { title: "kitshn", body: "", tag: "kitshn", path: "/#notifications" };
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      icon: "/icon-192.png",
      badge: "/favicon-32.png",
      data: { path: message.path },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || "/#notifications";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((each) => new URL(each.url).origin === self.location.origin);
      if (open) return open.navigate(path).then((each) => (each ?? open).focus());
      return self.clients.openWindow(path);
    }),
  );
});
