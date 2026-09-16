// Unified Service Worker for Ms. Eman Mathematics Platform
// Enforces strict Network-First for app shell, Network-Only (Zero-Cache) for Supabase & API data,
// and loud audible FCM / Web Push system notifications.

try {
  importScripts("/firebase-messaging-sw.js");
} catch (e) {
  console.info("[SW] Loaded standalone worker");
}
