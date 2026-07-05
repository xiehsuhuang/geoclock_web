self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || "GeoClock 呼叫提醒";
  const options = {
    body: payload.body || "有人提醒你快到了，請確認是否醒著",
    data: {
      url: payload.url || "/"
    },
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: payload.tag || "geoclock-wake",
    renotify: true,
    actions: [
      {
        action: "open",
        title: "打開 GeoClock"
      }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
