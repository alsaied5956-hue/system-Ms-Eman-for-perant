// Unified Service Worker for Ms. Eman Mathematics Platform
// Enforces strict Network-First for app shell, Network-Only (Zero-Cache) for Supabase & API data,
// and loud audible FCM / Web Push system notifications.

// Optional Firebase Cloud Messaging Compat Scripts (with graceful fallback if offline)
try {
  importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js");
} catch (e) {
  // Service worker continues normally without external CDN dependency
}

const CACHE_NAME = "math-center-v7.0-cloud-sync";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.svg",
  "/notification.wav"
];

// 1. Install Event: Immediate Cache Invalidation & Activation
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .catch((err) => console.info("SW pre-cache warning:", err))
      .then(() => self.skipWaiting())
  );
});

// 2. Activate Event: Immediate Client Claim & Clean Up Legacy Caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((cacheNames) =>
          Promise.all(
            cacheNames.map((name) => {
              if (name !== CACHE_NAME) {
                console.log("[SW] Purging outdated cache:", name);
                return caches.delete(name);
              }
            })
          )
        ),
    ]).then(() => {
      return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: "SW_ACTIVATED_CLAIMED",
            cacheName: CACHE_NAME,
            timestamp: Date.now(),
          });
        });
      });
    })
  );
});

// 3. Client Message Listener
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (event.data?.type === "PURGE_OFFLINE_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  } else if (event.data?.type === "SHOW_PORTAL_NOTIFICATION") {
    const { title, body, icon, badge, url, vibrate, tag, data, type } = event.data;
    const actions = getNotificationActions(type, tag);
    const options = {
      body: body || "",
      icon: icon || "/icon.svg",
      badge: badge || "/icon.svg",
      vibrate: vibrate || [200, 100, 200],
      silent: false, // Ensures OS rings native system notification sound
      sound: "/notification.wav",
      renotify: true,
      requireInteraction: true,
      tag: tag || `eman-${Date.now()}`,
      actions,
      data: {
        url: url || "/",
        type: type || "alert",
        ...(data || {}),
      },
      dir: "rtl",
      lang: "ar",
    };

    event.waitUntil(
      self.registration.showNotification(title || "منظومة الأستاذة إيمان الدمشيتي", options)
    );
  }
});

// Helper: Contextual interactive action buttons for notifications
function getNotificationActions(type, tag) {
  const normType = String(type || "").toLowerCase();
  const normTag = String(tag || "").toLowerCase();

  if (normType === "chat" || normTag.includes("chat")) {
    return [
      { action: "open_chat", title: "💬 فتح المحادثة" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  if (normType === "attendance" || normType === "absence" || normType === "delay" || normTag.includes("att") || normTag.includes("abs")) {
    return [
      { action: "view_attendance", title: "📋 سجل الحضور" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  if (normType === "homework" || normTag.includes("hw")) {
    return [
      { action: "view_homework", title: "📖 متابعة الواجب" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  if (normType === "grade" || normType === "exam" || normTag.includes("grade") || normTag.includes("exam")) {
    return [
      { action: "view_exams", title: "📊 كشف الدرجات" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  if (normType === "fee" || normType === "payment" || normTag.includes("pay")) {
    return [
      { action: "view_payments", title: "💳 إيصال المصروفات" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  return [
    { action: "open_portal", title: "عرض المنظومة" },
  ];
}

// 4. Fetch Event: Strict Network-First for HTML/Assets, STRICT NETWORK-ONLY (Zero-Cache) for Supabase & API
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = request.url;

  // STRICT NETWORK-ONLY: Never cache Supabase, backend API, Firebase, or non-GET requests
  if (
    request.method !== "GET" ||
    url.includes("supabase.co") ||
    url.includes("lzdvmzumwuqycwdecaan") ||
    url.includes("/rest/v1") ||
    url.includes("/auth/v1") ||
    url.includes("realtime/v1") ||
    url.includes("/api/") ||
    url.includes("/api/portal") ||
    url.includes("/api/notifications") ||
    url.startsWith("ws:") ||
    url.startsWith("wss:") ||
    url.includes("firestore.googleapis.com") ||
    url.includes("firebaseapp.com") ||
    url.includes("identitytoolkit.googleapis.com") ||
    url.includes("securetoken.googleapis.com") ||
    url.includes("fcm.googleapis.com") ||
    url.includes("chrome-extension")
  ) {
    // Let browser make direct live network call without SW caching
    return;
  }

  // HTML Navigation: Strict Network-First with cache fallback ONLY when offline
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-cache" })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match("/index.html").then((cached) => cached || caches.match("/"));
        })
    );
    return;
  }

  // Static Assets (JS chunks, CSS, Icons, Fonts): Network-First, fallback to cache
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(request).then((cached) => {
          if (cached) return cached;
          return new Response("Offline resource unavailable", {
            status: 503,
            statusText: "Offline",
          });
        });
      })
  );
});

// Helper: Show loud system notification
function displayLoudNotification(title, data) {
  const notifTag = data.tag || data.eventId || `eman-push-${Date.now()}`;
  const actions = getNotificationActions(data.type, notifTag);

  const options = {
    body: data.body || "",
    icon: data.icon || "/icon.svg",
    badge: data.badge || "/icon.svg",
    vibrate: [200, 100, 200], // High-intensity distinct vibration
    silent: false, // Forces device system notification sound to chime
    sound: data.sound || "/notification.wav",
    renotify: true, // Triggers sound even if prior notification remains unread
    requireInteraction: true, // Remains on screen until user dismisses or clicks
    tag: notifTag,
    actions,
    data: {
      url: data.url || "/",
      type: data.type || "alert",
      eventId: data.eventId,
      timestamp: data.timestamp || Date.now(),
    },
    dir: "rtl",
    lang: "ar",
  };

  return self.registration.showNotification(title || "منظومة الأستاذة إيمان الدمشيتي", options);
}

// 5. FCM Background Message Listener
try {
  if (typeof firebase !== "undefined" && (!firebase.apps || firebase.apps.length === 0)) {
    firebase.initializeApp({
      apiKey: "AIzaSyA8SdOtbVmBF7tsfIC_WsAgOFQj6tkyjaw",
      authDomain: "ai-studio-applet-webapp-dffd3.firebaseapp.com",
      projectId: "ai-studio-applet-webapp-dffd3",
      storageBucket: "ai-studio-applet-webapp-dffd3.firebasestorage.app",
      messagingSenderId: "319901039747",
      appId: "1:319901039747:web:fcd7b7a92b3923b44fefb6",
    });
  }

  if (typeof firebase !== "undefined" && typeof firebase.messaging === "function") {
    const fcmMessaging = firebase.messaging();
    fcmMessaging.onBackgroundMessage((payload) => {
      const title = payload.notification?.title || payload.data?.title || "منظومة الأستاذة إيمان الدمشيتي";
      const body = payload.notification?.body || payload.data?.body || "";
      const rawData = {
        body,
        icon: payload.notification?.icon || payload.data?.icon || "/icon.svg",
        badge: payload.data?.badge || "/icon.svg",
        type: payload.data?.type || "alert",
        url: payload.data?.url || "/",
        tag: payload.data?.tag,
        eventId: payload.data?.eventId,
        sound: "/notification.wav",
      };

      displayLoudNotification(title, rawData);
    });
  }
} catch (err) {
  console.info("FCM background initialization notice:", err);
}

// 6. Push Notification Event Listener (Web Push API)
self.addEventListener("push", (event) => {
  let data = {
    title: "منظومة الأستاذة إيمان الدمشيتي",
    body: "تنبيه جديد بخصوص الطالب في المنظومة",
    icon: "/icon.svg",
    badge: "/icon.svg",
    url: "/",
    type: "alert",
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch {
      data.body = event.data.text();
    }
  }

  const notifyClients = self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((clientList) => {
      clientList.forEach((client) => {
        client.postMessage({
          type: "PUSH_RECEIVED",
          eventId: data.eventId,
          notifType: data.type || "alert",
          title: data.title,
          body: data.body,
        });
      });
    });

  event.waitUntil(
    Promise.all([
      displayLoudNotification(data.title, data),
      notifyClients,
    ])
  );
});

// 7. Notification Click Handler: Deep Links and Plays Loud Audio Chime on User Interaction
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const clickData = event.notification.data || {};
  let targetUrl = clickData.url || "/";

  // Contextual Action Routing
  if (event.action === "open_chat") {
    targetUrl = "/?tab=chat";
  } else if (event.action === "view_attendance") {
    targetUrl = "/?tab=attendance";
  } else if (event.action === "view_homework") {
    targetUrl = "/?tab=homework";
  } else if (event.action === "view_exams") {
    targetUrl = "/?tab=exams";
  } else if (event.action === "view_payments") {
    targetUrl = "/?tab=payments";
  } else if (event.action === "open_portal") {
    targetUrl = clickData.url || "/";
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // 1. Focus existing window if open
      for (const client of clientList) {
        if ("focus" in client) {
          if (client.url && client.navigate) {
            client.navigate(targetUrl);
          }
          client.postMessage({
            type: "USER_INTERACTED_PLAY_ALERT",
            url: targetUrl,
            sound: "/notification.wav",
            notifType: clickData.type || "alert",
            timestamp: Date.now(),
          });
          return client.focus();
        }
      }
      // 2. Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl).then((newWindow) => {
          if (newWindow) {
            newWindow.postMessage({
              type: "USER_INTERACTED_PLAY_ALERT",
              url: targetUrl,
              sound: "/notification.wav",
              notifType: clickData.type || "alert",
              timestamp: Date.now(),
            });
          }
        });
      }
    })
  );
});

