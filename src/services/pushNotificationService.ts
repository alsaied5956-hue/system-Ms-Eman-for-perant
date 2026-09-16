/**
 * Background Push Notification Service
 * Handles Web Push subscriptions, Service Worker background push registration,
 * Periodic Background Sync, and synchronization with Supabase & Firebase Firestore.
 */

import { supabase, barcodeToUUID, updateParentAccountFCMTokenInSupabase, normalizeBarcode } from "../utils/supabaseClient";
import { db, app } from "../utils/firebase";
import { collection, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { markEventProcessed, shouldNotifyEvent } from "../utils/notificationTracker";
import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";
import { playPortalAudioChime, sendPortalNotification } from "../utils/portalNotifications";

// Resolves current Supabase JWT auth token or authenticated parent portal session token
export async function getClientAuthToken(userId?: string): Promise<string> {
  try {
    const sessionRes = await supabase.auth.getSession();
    const jwt = sessionRes?.data?.session?.access_token;
    if (jwt) return jwt;
  } catch {}

  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem("eman_portal_session_v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.token) return parsed.token;
        if (parsed?.barcode) return parsed.barcode;
      }
    }
  } catch {}

  return userId || "";
}

/**
 * Force Service Worker update across all registered workers on sign-in
 * Guarantees clients always run the latest firebase-messaging-sw.js and VAPID key.
 */
export async function forceUpdateServiceWorker(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const reg of registrations) {
      if (typeof reg.update === "function") {
        await reg.update();
        console.log(`[ServiceWorker Auto-Update] Forced update for: ${reg.scope}`);
      }
    }
  } catch (err) {
    console.warn("[ServiceWorker Auto-Update] Update check notice:", err);
  }
}

// Standard VAPID Public Key matching the backend server and Firebase Web Push Certificates
export const VAPID_PUBLIC_KEY =
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_FIREBASE_VAPID_KEY) ||
  (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_VAPID_PUBLIC_KEY) ||
  "BE0N1wV5fSDpg0YAO8uoPXzWpBYJznOLFcF05uh8P-Du7NMgWpbcafllzDXaeDp8FPAXkS6p50KE0v9SfDHNZXQ";

export const FIREBASE_VAPID_PUBLIC_KEY = VAPID_PUBLIC_KEY;

/**
 * Converts a base64 string to a Uint8Array for pushManager.subscribe applicationServerKey
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Registers the Service Worker and requests a Push Subscription from the browser push service (FCM / Mozilla / Apple).
 * Works reliably when the application is completely closed or in the background.
 */
export async function registerPushSubscription(
  userId: string,
  userRole: "parent" | "student" | "admin" = "parent",
  aliases: string[] = []
): Promise<PushSubscriptionData | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("Web Push is not supported in this browser environment.");
    return null;
  }

  try {
    // 1. Verify Notification Permission
    let permission = Notification.permission;
    if (permission !== "granted") {
      try {
        const permPromise = Notification.requestPermission();
        permission =
          permPromise instanceof Promise
            ? await permPromise
            : await new Promise<NotificationPermission>((res) => (Notification as any).requestPermission(res));
      } catch {
        permission = "denied";
      }
    }
    if (permission !== "granted") {
      console.warn("Notification permission was denied or dismissed.");
      return null;
    }

    // 2. Register or retrieve active Service Worker
    let registration = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
    if (!registration) {
      registration = await navigator.serviceWorker.getRegistration();
    }
    if (!registration) {
      registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
    }
    await navigator.serviceWorker.ready;

    // Force swRegistration.update() to ensure clients always run the latest firebase-messaging-sw.js and VAPID key
    try {
      if (registration && typeof registration.update === "function") {
        await registration.update();
      }
    } catch {}

    // 3. Register Periodic Background Sync if supported (PWA background capability)
    try {
      if ("periodicSync" in registration) {
        const periodicSync = (registration as any).periodicSync;
        const tags = await periodicSync.getTags();
        if (!tags.includes("attendance-schedule-check")) {
          await periodicSync.register("attendance-schedule-check", {
            minInterval: 12 * 60 * 60 * 1000, // 12 hours check
          });
        }
      }
    } catch {
      // Periodic sync is optional and depends on browser PWA installation
    }

    // 4. Retrieve VAPID Key (dynamically from server or fallback constant)
    let activeVapidKey = VAPID_PUBLIC_KEY;
    try {
      const res = await fetch("/api/push-public-key");
      if (res.ok) {
        const data = await res.json();
        if (data?.publicKey) activeVapidKey = data.publicKey;
      }
    } catch {}

    const convertedKey = urlBase64ToUint8Array(activeVapidKey);

    // 5. Check for existing subscription or create a new one
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      // Verify subscription applicationServerKey matches current server key
      try {
        const rawKey = subscription.options?.applicationServerKey;
        if (rawKey) {
          const keyArr = new Uint8Array(rawKey);
          let match = keyArr.length === convertedKey.length;
          if (match) {
            for (let i = 0; i < keyArr.length; i++) {
              if (keyArr[i] !== convertedKey[i]) {
                match = false;
                break;
              }
            }
          }
          if (!match) {
            console.log("Renewing Web Push subscription for updated server VAPID key...");
            await subscription.unsubscribe();
            subscription = null;
          }
        }
      } catch {}
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedKey,
      });
    }

    const subJson = subscription.toJSON() as PushSubscriptionData;
    if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) {
      console.warn("Invalid push subscription payload generated.");
      return null;
    }

    // 6. Persist the subscription to backend server + database
    await savePushSubscription(userId, userRole, subJson, aliases);

    return subJson;
  } catch (error) {
    console.error("Failed to register Web Push Subscription:", error);
    return null;
  }
}

/**
 * Persists the client's Push Subscription into Backend Server, Firestore, and Supabase
 * so background triggers can reach the phone even when app is closed.
 */
export async function savePushSubscription(
  userId: string,
  userRole: string,
  sub: PushSubscriptionData,
  aliases: string[] = [],
  explicitFcmToken?: string
): Promise<void> {
  const endpoint = sub.endpoint;
  const p256dh = sub.keys.p256dh;
  const auth = sub.keys.auth;
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const cleanAliases = Array.isArray(aliases) ? aliases.map(String).filter(Boolean) : [];

  // Extract FCM token if endpoint belongs to Google FCM / Chrome Web Push or passed explicitly
  let fcmToken: string | null =
    typeof explicitFcmToken === "string" &&
    explicitFcmToken.trim() !== "" &&
    explicitFcmToken !== "undefined" &&
    explicitFcmToken !== "null"
      ? explicitFcmToken.trim()
      : null;

  if (!fcmToken && endpoint && endpoint.includes("/fcm/send/")) {
    const extracted = endpoint.split("/fcm/send/")[1]?.trim() || "";
    if (extracted && extracted !== "undefined" && extracted !== "null") {
      fcmToken = extracted;
    }
  }

  // 1. Primary Backend Express API (for instant web-push sending and FCM dispatch)
  try {
    const payload: Record<string, any> = {
      userId,
      userRole,
      aliases: cleanAliases,
      subscription: sub,
    };
    if (fcmToken) {
      payload.fcmToken = fcmToken;
    }
    const authToken = await getClientAuthToken(userId);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
      headers["x-supabase-auth"] = authToken;
    }

    await fetch("/api/push-subscribe", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn("Could not register push to Express backend:", err);
  }

  // 2. Direct Supabase parent_accounts synchronization to retain active fcm_token (only valid strings)
  if (fcmToken && userRole === "parent" && userId && userId !== "guest") {
    try {
      const allBarcodes = [userId, ...cleanAliases];
      for (const targetBarcode of allBarcodes) {
        const uuid = barcodeToUUID(targetBarcode);
        await supabase
          .from("parent_accounts")
          .update({
            fcm_token: fcmToken,
            updated_at: new Date().toISOString(),
          })
          .or(`id.eq.${uuid},id.eq.${targetBarcode},parent_phone.eq.${targetBarcode}`);
      }
      console.info(`[Push Service] Retained active FCM token in Supabase for user ${userId}`);
    } catch (dbErr) {
      console.warn("[Push Service] Supabase token retention notice:", dbErr);
    }
  }

  // 3. Firestore push_subscriptions collection (secondary cloud backup)
  // Safely write only valid token strings, never undefined
  if (db) {
    try {
      const cleanDocId = encodeURIComponent(endpoint).slice(-80);
      const firestoreDoc: Record<string, any> = {
        userId,
        userRole,
        aliases: cleanAliases,
        endpoint,
        p256dh,
        auth,
        userAgent,
        updatedAt: serverTimestamp(),
      };
      if (fcmToken) {
        firestoreDoc.fcmToken = fcmToken;
      }
      await setDoc(
        doc(collection(db, "push_subscriptions"), cleanDocId),
        firestoreDoc,
        { merge: true }
      );
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (!msg.includes("quota") && !msg.includes("Quota") && !msg.includes("resource-exhausted")) {
        console.warn("Failed saving push subscription to Firestore:", err);
      }
    }
  }
}

/**
 * Dispatches a native Web Push notification to target users (e.g. parents of a student).
 * This awakens the recipient's phone/browser via Google/Apple push even if the app is completely closed!
 */
export async function dispatchPushNotification(payload: {
  targetUserIds?: string | string[];
  role?: "parent" | "admin" | "all";
  title: string;
  body: string;
  icon?: string;
  url?: string;
  tag?: string;
  eventId?: string;
  type?: string;
  sound?: string;
}): Promise<boolean> {
  const eventId = payload.eventId || `ev-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  
  // Pre-mark locally so this client doesn't double-alert
  markEventProcessed(eventId);

  try {
    const res = await fetch("/api/send-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        eventId,
      }),
    });

    const data = await res.json().catch(() => null);

    if (data?.missingTokens && data.missingTokens.length > 0) {
      console.warn(
        `[FCM Parent Dispatcher] Notification alert sent, but missing active fcm_token for targets:`,
        data.missingTokens
      );
    }

    if (data?.failureDetails && data.failureDetails.length > 0) {
      console.warn(`[FCM Parent Dispatcher] Delivery failure details reported:`, data.failureDetails);
    }

    if (data && (data.sent > 0 || data.fcmDispatched > 0 || data.webPushDispatched > 0)) {
      console.info(
        `[FCM Parent Dispatcher] Successfully delivered push notifications: ${data.sent} device(s) reached.`
      );
      return true;
    }

    return res.ok;
  } catch (err) {
    console.warn("dispatchPushNotification network warning:", err);
  }
  return false;
}

/**
 * Helper to dispatch a local background alert via Service Worker
 * (Plays acoustic chime, triggers mobile vibration, rings device sound)
 */
export async function triggerDeviceBackgroundAlert(payload: {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg && reg.showNotification) {
      await reg.showNotification(payload.title, {
        body: payload.body,
        icon: "/icon.svg",
        badge: "/icon.svg",
        vibrate: [200, 100, 200],
        silent: false,
        renotify: true,
        requireInteraction: true,
        tag: payload.tag || `eman-alert-${Date.now()}`,
        data: {
          url: payload.url || "/",
          timestamp: Date.now(),
        },
        dir: "rtl",
        lang: "ar",
      } as any);
    }
  } catch (err) {
    console.warn("ServiceWorker trigger alert failed:", err);
  }
}

/**
 * Auto-Request Notification Permissions & VAPID Token Generation Pipeline
 * Requirement #2:
 * - On user/parent login, explicitly invoke Notification.requestPermission().
 * - Upon approval, call getToken(messaging, { vapidKey: "YOUR_VAPID_KEY" }).
 * - CRITICAL: Immediately update the authenticated user's record in parent_accounts / profiles
 *   with the generated fcm_token via direct Supabase query:
 *   await supabase.from('parent_accounts').update({ fcm_token: token }).eq('id', userId)
 */
export async function autoRequestPermissionAndSyncFCMToken(
  userId: string,
  userRole: "parent" | "student" | "admin" = "parent",
  aliases: string[] = []
): Promise<{ success: boolean; token: string | null; permission: NotificationPermission }> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    console.warn("[FCM Pipeline] Notifications not supported in this environment.");
    return { success: false, token: null, permission: "denied" };
  }

  // 1. Explicitly invoke Notification.requestPermission()
  let permission: NotificationPermission = Notification.permission;
  if (permission !== "granted") {
    try {
      const permPromise = Notification.requestPermission();
      permission =
        permPromise instanceof Promise
          ? await permPromise
          : await new Promise<NotificationPermission>((res) => (Notification as any).requestPermission(res));
    } catch (permErr) {
      console.warn("[FCM Pipeline] Notification.requestPermission error:", permErr);
      permission = "denied";
    }
  }

  if (permission !== "granted") {
    console.warn(`[FCM Pipeline] Notification permission not granted: ${permission}`);
    return { success: false, token: null, permission };
  }

  // 2. Ensure Service Worker is registered
  let swReg: ServiceWorkerRegistration | undefined;
  if ("serviceWorker" in navigator) {
    try {
      swReg = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
      if (!swReg) {
        swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
      }
      await navigator.serviceWorker.ready;
    } catch (swErr) {
      console.warn("[FCM Pipeline] Service worker readiness notice:", swErr);
    }
  }

  // 3. Resolve active VAPID key
  let activeVapidKey = FIREBASE_VAPID_PUBLIC_KEY;
  try {
    const res = await fetch("/api/push-public-key");
    if (res.ok) {
      const keyData = await res.json();
      if (keyData?.publicKey) activeVapidKey = keyData.publicKey;
    }
  } catch {}

  let fcmToken: string | null = null;

  // 4. Upon approval, call getToken(messaging, { vapidKey: "YOUR_VALID_PUBLIC_VAPID_KEY" })
  try {
    const messagingSupported = await isSupported().catch(() => false);
    if (messagingSupported) {
      const messaging = getMessaging(app);
      const vapidKeyToUse =
        (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_FIREBASE_VAPID_KEY) ||
        (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_VAPID_PUBLIC_KEY) ||
        activeVapidKey ||
        FIREBASE_VAPID_PUBLIC_KEY;

      try {
        const token = await getToken(messaging, {
          vapidKey: vapidKeyToUse,
          serviceWorkerRegistration: swReg,
        });

        if (token && typeof token === "string" && token.trim() !== "" && token !== "undefined" && token !== "null") {
          fcmToken = token.trim();
          console.info(`[FCM Pipeline] Active FCM token generated: ${fcmToken.slice(0, 15)}... for user ${userId}`);

          // Handle foreground notifications with acoustic chime & vibration
          try {
            onMessage(messaging, (payload) => {
              console.log("[FCM Pipeline] Foreground message received:", payload);
              const title = payload.notification?.title || payload.data?.title || "منظومة الأستاذة إيمان الدمشيتي";
              const body = payload.notification?.body || payload.data?.body || "إشعار جديد في المنظومة";
              const type = (payload.data?.type || "alert") as any;
              const eventId =
                payload.data?.eventId ||
                payload.data?.id ||
                payload.messageId ||
                `${type}-${payload.data?.timestamp || Date.now()}`;

              // Notification Deduplication (Item 8): Prevent double alerts if already alerted via Realtime CDC
              if (!shouldNotifyEvent({ eventId })) {
                console.log("[FCM Pipeline] Foreground message skipped by deduplication layer (already alerted):", eventId);
                return;
              }

              // Browser Autoplay & Audio Handling (Item 3): Wrap Audio in safe try/catch and rely on system notifications
              try {
                playPortalAudioChime(type);
              } catch (audioErr) {
                console.warn("[FCM Pipeline] Audio chime autoplay policy note:", audioErr);
              }

              sendPortalNotification(title, body, type, { eventId }).catch(() => {});

              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("eman_fcm_foreground_message", {
                    detail: { payload, title, body, type, eventId },
                  })
                );
              }
            });
          } catch (onMsgErr) {
            console.info("[FCM Pipeline] onMessage setup notice:", onMsgErr);
          }
        }
      } catch (tokenErr: any) {
        const errMsg = tokenErr?.message || String(tokenErr);
        console.warn(
          `[FCM Pipeline] Firebase getToken setup error (HTTP 401 / VAPID key verification): ${errMsg}. ` +
          `Verify that the public VAPID key matches Firebase Console -> Project Settings -> Cloud Messaging -> Web Push Certificates.`
        );
        fcmToken = null;
      }
    }
  } catch (fcmErr) {
    console.warn("[FCM Pipeline] Firebase messaging check notice:", fcmErr);
    fcmToken = null;
  }

  // Complement with WebPush subscription
  let webPushSub: PushSubscriptionData | null = null;
  try {
    webPushSub = await registerPushSubscription(userId, userRole, aliases);
    if (!fcmToken && webPushSub?.endpoint?.includes("/fcm/send/")) {
      const extracted = webPushSub.endpoint.split("/fcm/send/")[1]?.trim();
      if (extracted && extracted !== "undefined" && extracted !== "null") {
        fcmToken = extracted;
      }
    }
  } catch (wpErr) {
    console.warn("[FCM Pipeline] WebPush registration fallback notice:", wpErr);
  }

  // Validate that fcmToken is non-null and not undefined string
  const hasValidFcmToken = Boolean(
    fcmToken &&
    typeof fcmToken === "string" &&
    fcmToken.trim() !== "" &&
    fcmToken !== "undefined" &&
    fcmToken !== "null"
  );
  const validFcmToken = hasValidFcmToken ? (fcmToken as string).trim() : null;

  if (!hasValidFcmToken && !webPushSub) {
    console.log("[FCM Pipeline] No valid FCM token string or WebPush subscription generated. Safely skipping token persistence.");
    return { success: false, token: null, permission };
  }

  // 5. CRITICAL: Safely update only valid token strings in parent_accounts / profiles
  try {
    if (validFcmToken) {
      console.log(`[FCM Pipeline] CRITICAL: Updating parent_accounts with valid fcm_token for id: ${userId}`);

      // Direct required query:
      const { error: directErr } = await supabase
        .from("parent_accounts")
        .update({ fcm_token: validFcmToken, updated_at: new Date().toISOString() })
        .eq("id", userId);

      if (directErr) {
        console.warn("[FCM Pipeline] Direct eq('id', userId) update note:", directErr.message);
      }

      // Also ensure updates match when id is stored as student barcode, UUID, or phone
      const cleanBarcode = normalizeBarcode(userId);
      const uuid = barcodeToUUID(cleanBarcode || userId);
      const allTargets = Array.from(new Set([userId, cleanBarcode, uuid, ...aliases])).filter(Boolean);

      for (const target of allTargets) {
        const targetUuid = barcodeToUUID(target);
        await supabase
          .from("parent_accounts")
          .update({ fcm_token: validFcmToken, updated_at: new Date().toISOString() })
          .or(`id.eq.${targetUuid},id.eq.${target},parent_phone.eq.${target}`);
      }

      // Also update profiles table if present in Supabase
      try {
        await supabase
          .from("profiles")
          .update({ fcm_token: validFcmToken, updated_at: new Date().toISOString() })
          .eq("id", userId);
      } catch {}

      // Update local storage accounts cache
      try {
        const raw = localStorage.getItem("eman_parent_accounts");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed[userId]) {
            parsed[userId].fcmToken = validFcmToken;
          }
          if (cleanBarcode && parsed[cleanBarcode]) {
            parsed[cleanBarcode].fcmToken = validFcmToken;
          }
          localStorage.setItem("eman_parent_accounts", JSON.stringify(parsed));
        }
      } catch {}
    }

    // Secondary sync to backend server & Firestore
    if (webPushSub) {
      await savePushSubscription(userId, userRole, webPushSub, aliases, validFcmToken || undefined);
    } else if (validFcmToken) {
      // Validate fcmToken before sending fetch request to /api/push-subscribe
      const authToken = await getClientAuthToken(userId);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
        headers["x-supabase-auth"] = authToken;
      }

      await fetch("/api/push-subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({
          userId,
          userRole,
          aliases,
          fcmToken: validFcmToken,
        }),
      }).catch((fetchErr) => {
        console.warn("[FCM Pipeline] /api/push-subscribe fetch notice:", fetchErr);
      });
    }

    console.info(`[FCM Pipeline] Successfully synchronized push credentials for ${userId}`);
    return { success: true, token: validFcmToken, permission: "granted" };
  } catch (updateErr) {
    console.error("[FCM Pipeline] Failed to update parent_accounts with fcm_token:", updateErr);
    return { success: false, token: validFcmToken, permission: "granted" };
  }

  return { success: false, token: null, permission };
}
