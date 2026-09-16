/**
 * Firebase Cloud Messaging & PWA Unified Service Worker
 * Dispatches high-priority background audio alerts, vibrations, and notifications
 * even when the PWA / browser is completely closed or in background.
 */

// 1. Give the service worker access to Firebase Messaging compat scripts
try {
  importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js");
} catch (e) {
  console.info("[SW] Firebase CDN scripts offline or blocked, continuing with fallback push handler:", e);
}

// 2. Initialize the Firebase app in the service worker
if (typeof firebase !== "undefined") {
  try {
    firebase.initializeApp({
      apiKey: "AIzaSyA8SdOtbVmBF7tsfIC_WsAgOFQj6tkyjaw",
      authDomain: "ai-studio-applet-webapp-dffd3.firebaseapp.com",
      projectId: "ai-studio-applet-webapp-dffd3",
      storageBucket: "ai-studio-applet-webapp-dffd3.firebasestorage.app",
      messagingSenderId: "319901039747",
      appId: "1:319901039747:web:fcd7b7a92b3923b44fefb6",
    });

    const messaging = firebase.messaging();

    // Helper: High-priority vibration patterns for notification categories
    function getVibrationPattern(type) {
      const norm = String(type || "").toLowerCase();
      if (norm.includes("abs") || norm === "absence") return [350, 100, 350, 100, 450]; // Absence
      if (norm.includes("delay") || norm.includes("late")) return [250, 80, 250, 80, 250]; // Late
      if (norm.includes("grade") || norm.includes("exam") || norm.includes("grades")) return [150, 80, 150, 80, 300]; // Grades
      if (norm.includes("pay") || norm.includes("fee") || norm.includes("payment")) return [200, 100, 200, 100, 400]; // Payments
      if (norm.includes("chat") || norm.includes("msg") || norm.includes("message")) return [120, 60, 120]; // Messages
      if (norm.includes("edit") || norm.includes("update")) return [250, 100, 250]; // Data edits
      return [200, 100, 200, 100, 300]; // Attendance / Default high-priority
    }

    // Helper: Contextual interactive action buttons for notifications
    function getNotificationActions(type, tag) {
      const normType = String(type || "").toLowerCase();
      const normTag = String(tag || "").toLowerCase();

      if (
        normType === "chat" ||
        normType === "message" ||
        normType === "messages" ||
        normTag.includes("chat") ||
        normTag.includes("msg")
      ) {
        return [
          { action: "open_chat", title: "💬 فتح المحادثة" },
          { action: "open_portal", title: "عرض المنظومة" },
        ];
      }
      if (
        normType === "attendance" ||
        normType === "absence" ||
        normType === "delay" ||
        normType === "late" ||
        normTag.includes("att") ||
        normTag.includes("abs") ||
        normTag.includes("late")
      ) {
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
      if (
        normType === "grade" ||
        normType === "exam" ||
        normType === "grades" ||
        normTag.includes("grade") ||
        normTag.includes("exam")
      ) {
        return [
          { action: "view_exams", title: "📊 كشف الدرجات" },
          { action: "open_portal", title: "عرض المنظومة" },
        ];
      }
      if (
        normType === "fee" ||
        normType === "payment" ||
        normType === "payments" ||
        normTag.includes("pay")
      ) {
        return [
          { action: "view_payments", title: "💳 إيصال المصروفات" },
          { action: "open_portal", title: "عرض المنظومة" },
        ];
      }
      return [{ action: "open_portal", title: "عرض المنظومة" }];
    }

    // Configure background message handling using onBackgroundMessage
    messaging.onBackgroundMessage((payload) => {
      console.log("[firebase-messaging-sw.js] onBackgroundMessage received payload:", payload);

      // Display notifications with explicit title, body, and icon payload properties
      const title =
        payload.notification?.title ||
        payload.data?.title ||
        "منظومة الأستاذة إيمان الدمشيتي";

      const body =
        payload.notification?.body ||
        payload.data?.body ||
        "تنبيه جديد بخصوص الطالب في المنظومة";

      const icon =
        payload.notification?.icon ||
        payload.data?.icon ||
        payload.notification?.image ||
        payload.data?.image ||
        "/icon.svg";

      const badge =
        payload.notification?.badge ||
        payload.data?.badge ||
        "/icon.svg";

      const notifType = payload.data?.type || "alert";
      const eventId = payload.data?.eventId || `fcm-${Date.now()}`;
      const targetUrl = payload.data?.url || (notifType === "chat" ? "/?tab=chat" : "/");
      const actions = getNotificationActions(notifType, payload.data?.tag || eventId);
      const vibratePattern = getVibrationPattern(notifType);

      // Enforce standard OS sound (default_sound: true) and high-priority vibration patterns
      const notificationOptions = {
        title,
        body,
        icon,
        badge,
        vibrate: vibratePattern,
        silent: false, // Rings mobile device default notification chime
        sound: "/notification.wav",
        renotify: true,
        requireInteraction: true,
        tag: payload.data?.tag || eventId,
        data: {
          url: targetUrl,
          eventId,
          type: notifType,
          default_sound: true,
          timestamp: Date.now(),
          ...payload.data,
        },
        dir: "rtl",
        lang: "ar",
        actions,
      };

      return self.registration.showNotification(title, notificationOptions);
    });
  } catch (initErr) {
    console.warn("[SW] Firebase messaging init warning:", initErr);
  }
}

// 3. Dual Support: Native Web Push listener for direct VAPID / FCM pushes
self.addEventListener("push", (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const title = data.title || "منظومة الأستاذة إيمان الدمشيتي";
    const body = data.body || "تنبيه جديد بخصوص الطالب في المنظومة";
    const notifType = data.type || "alert";
    const notifTag = data.tag || data.eventId || `fcm-push-${Date.now()}`;
    const icon = data.icon || "/icon.svg";
    const badge = data.badge || "/icon.svg";

    function getPushVibrationPattern(t) {
      const norm = String(t || "").toLowerCase();
      if (norm.includes("abs") || norm === "absence") return [350, 100, 350, 100, 450];
      if (norm.includes("delay") || norm.includes("late")) return [250, 80, 250, 80, 250];
      if (norm.includes("grade") || norm.includes("exam")) return [150, 80, 150, 80, 300];
      if (norm.includes("pay") || norm.includes("fee")) return [200, 100, 200, 100, 400];
      if (norm.includes("chat") || norm.includes("msg")) return [120, 60, 120];
      return [200, 100, 200, 100, 300];
    }

    const options = {
      title,
      body,
      icon,
      badge,
      vibrate: getPushVibrationPattern(notifType),
      silent: false, // Rings device notification chime
      sound: "/notification.wav",
      renotify: true,
      requireInteraction: true,
      tag: notifTag,
      data: {
        url: data.url || (notifType === "chat" ? "/?tab=chat" : "/"),
        eventId: data.eventId,
        default_sound: true,
        timestamp: data.timestamp || Date.now(),
      },
      dir: "rtl",
      lang: "ar",
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    const text = event.data.text();
    event.waitUntil(
      self.registration.showNotification("منظومة الأستاذة إيمان الدمشيتي", {
        body: text,
        icon: "/icon.svg",
        vibrate: [200, 100, 200, 100, 300],
        silent: false,
        sound: "/notification.wav",
        renotify: true,
        dir: "rtl",
        lang: "ar",
      })
    );
  }
});

// 4. User click on notification: Focus existing window or open new tab & trigger audio
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const clickData = event.notification.data || {};
  let targetUrl = clickData.url || "/";
  if (event.action === "open_chat") {
    targetUrl = "/?tab=chat";
  } else if (event.action === "view_attendance") {
    targetUrl = "/?tab=attendance";
  } else if (event.action === "view_exams") {
    targetUrl = "/?tab=grades";
  } else if (event.action === "view_payments") {
    targetUrl = "/?tab=payments";
  } else if (event.action === "view_homework") {
    targetUrl = "/?tab=homework";
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // 1. If an open client window is available, focus it and postMessage
        for (const client of clientList) {
          if ("focus" in client) {
            client.focus();
            client.postMessage({
              type: "USER_INTERACTED_PLAY_ALERT",
              url: targetUrl,
            });
            if ("navigate" in client && targetUrl) {
              client.navigate(targetUrl);
            }
            return;
          }
        }
        // 2. Otherwise, open a new window to the target URL
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

// 5. PWA Lifecycle & Caching Engine (Offline Support)
const CACHE_NAME = "math-center-v10.0-fcm-pwa";
const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon.svg",
  "/notification.wav",
  "/pwa-192x192.png",
  "/pwa-512x512.png"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .catch((err) => console.info("[SW] Pre-cache notice:", err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((cacheNames) =>
        Promise.all(
          cacheNames.map((name) => {
            if (name !== CACHE_NAME) {
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

// 6. Client Message Listener
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (event.data?.type === "PURGE_OFFLINE_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  } else if (event.data?.type === "SHOW_PORTAL_NOTIFICATION") {
    const { title, body, icon, badge, url, vibrate, tag, data, type } = event.data;
    const options = {
      body: body || "",
      icon: icon || "/icon.svg",
      badge: badge || "/icon.svg",
      vibrate: vibrate || [200, 100, 200, 100, 300],
      silent: false, // Ensures OS rings native system notification sound
      sound: "/notification.wav",
      renotify: true,
      requireInteraction: true,
      tag: tag || `portal-${type || "alert"}-${Date.now()}`,
      data: {
        url: url || "/",
        type: type || "alert",
        default_sound: true,
        ...data,
      },
      dir: "rtl",
      lang: "ar",
    };
    self.registration.showNotification(title, options);
  }
});

// 7. Network-First for app shell, Network-Only for APIs
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Exclude non-GET and real-time APIs from service worker cache
  if (
    req.method !== "GET" ||
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("firestore")
  ) {
    return;
  }

  // Network-First strategy
  event.respondWith(
    fetch(req)
      .then((networkResponse) => {
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          (url.pathname === "/" || url.pathname.endsWith(".js") || url.pathname.endsWith(".css") || url.pathname.endsWith(".svg"))
        ) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(req, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(req).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (req.mode === "navigate") {
            return caches.match("/index.html");
          }
          return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
        });
      })
  );
});
