/**
 * Firebase Cloud Messaging Service Worker (FCM PWA Background Handler)
 * Dispatches high-priority background audio alerts, vibrations, and notifications
 * even when the PWA / browser is completely closed.
 */

// Give the service worker access to Firebase Messaging.
importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js");

// Initialize the Firebase app in the service worker
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

  if (normType === "chat" || normType === "message" || normType === "messages" || normTag.includes("chat") || normTag.includes("msg")) {
    return [
      { action: "open_chat", title: "💬 فتح المحادثة" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  if (normType === "attendance" || normType === "absence" || normType === "delay" || normType === "late" || normTag.includes("att") || normTag.includes("abs") || normTag.includes("late")) {
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
  if (normType === "grade" || normType === "exam" || normType === "grades" || normTag.includes("grade") || normTag.includes("exam")) {
    return [
      { action: "view_exams", title: "📊 كشف الدرجات" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  if (normType === "fee" || normType === "payment" || normType === "payments" || normTag.includes("pay")) {
    return [
      { action: "view_payments", title: "💳 إيصال المصروفات" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  if (normType === "edit" || normType === "data_edit" || normTag.includes("edit")) {
    return [
      { action: "open_portal", title: "عرض بيانات الطالب" },
      { action: "open_portal", title: "عرض المنظومة" },
    ];
  }
  return [
    { action: "open_portal", title: "عرض المنظومة" },
  ];
}

// Handle FCM Background Messages
messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Received FCM background message:", payload);

  const title =
    payload.notification?.title ||
    payload.data?.title ||
    "منظومة الأستاذة إيمان الدمشيتي";

  const body =
    payload.notification?.body ||
    payload.data?.body ||
    "تنبيه جديد بخصوص الطالب في المنظومة";

  const notifType = payload.data?.type || "alert";
  const eventId = payload.data?.eventId || `fcm-${Date.now()}`;
  const targetUrl = payload.data?.url || (notifType === "chat" ? "/?tab=chat" : "/");
  const actions = getNotificationActions(notifType, payload.data?.tag || eventId);

  const notificationOptions = {
    body,
    icon: payload.notification?.icon || payload.data?.icon || "/icon.svg",
    badge: "/icon.svg",
    vibrate: getVibrationPattern(notifType), // High-priority background vibration pattern
    silent: false, // Rings mobile device default notification chime at high volume
    sound: "/notification.wav",
    renotify: true,
    requireInteraction: true,
    tag: payload.data?.tag || eventId,
    data: {
      url: targetUrl,
      eventId,
      type: notifType,
      timestamp: Date.now(),
    },
    dir: "rtl",
    lang: "ar",
    actions,
  };

  return self.registration.showNotification(title, notificationOptions);
});

// Dual Support: Native Web Push listener for direct VAPID / FCM pushes
self.addEventListener("push", (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const title = data.title || "منظومة الأستاذة إيمان الدمشيتي";
    const body = data.body || "تنبيه جديد بخصوص الطالب في المنظومة";
    const notifType = data.type || "alert";
    const notifTag = data.tag || data.eventId || `fcm-push-${Date.now()}`;

    const options = {
      body,
      icon: data.icon || "/icon.svg",
      badge: data.badge || "/icon.svg",
      vibrate: getVibrationPattern(notifType),
      silent: false, // Rings device notification chime
      sound: "/notification.wav",
      renotify: true,
      requireInteraction: true,
      tag: notifTag,
      actions: getNotificationActions(notifType, notifTag),
      data: {
        url: data.url || (notifType === "chat" ? "/?tab=chat" : "/"),
        eventId: data.eventId,
        timestamp: data.timestamp || Date.now(),
      },
      dir: "rtl",
      lang: "ar",
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    // Non-JSON push payload fallback
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

// User click on notification: Focus existing window or open new tab & trigger audio
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const clickData = event.notification.data || {};
  let targetUrl = clickData.url || "/";
  if (event.action === "open_chat") {
    targetUrl = "/?tab=chat";
  } else if (event.action === "view_details") {
    targetUrl = clickData.url || "/?tab=attendance";
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
