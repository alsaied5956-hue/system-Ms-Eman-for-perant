/**
 * Web Audio Synthesizer & Push Notification Manager for Parents & Admins Portal
 * Synthesizes pure harmonic acoustic chimes via Web Audio API (zero external asset dependencies).
 */

export type NotificationType =
  | "attendance"
  | "absence"
  | "delay"
  | "late"
  | "fee"
  | "payment"
  | "grade"
  | "exam"
  | "homework"
  | "chat"
  | "message"
  | "edit"
  | "data_edit"
  | "alert";

let sharedAudioCtx: AudioContext | null = null;

export function getVibrationPatternForType(type: NotificationType): number[] {
  const norm = String(type || "").toLowerCase();
  if (norm === "absence") return [350, 100, 350, 100, 450];
  if (norm === "delay" || norm === "late") return [250, 80, 250, 80, 250];
  if (norm === "grade" || norm === "exam") return [150, 80, 150, 80, 300];
  if (norm === "payment" || norm === "fee") return [200, 100, 200, 100, 400];
  if (norm === "homework") return [180, 90, 180];
  if (norm === "chat" || norm === "message") return [120, 60, 120];
  if (norm === "edit" || norm === "data_edit") return [250, 100, 250];
  return [200, 100, 200, 100, 300]; // Default high-priority pattern
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!sharedAudioCtx) {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtxClass) {
        sharedAudioCtx = new AudioCtxClass();
      }
    }
    if (sharedAudioCtx && sharedAudioCtx.state === "suspended") {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

// Auto-unlock audio context on first user interaction so sound can play smoothly on mobile phones
if (typeof window !== "undefined") {
  const unlockAudio = () => {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    } catch {}
  };
  window.addEventListener("click", unlockAudio, { passive: true });
  window.addEventListener("touchstart", unlockAudio, { passive: true });
  window.addEventListener("keydown", unlockAudio, { passive: true });

  // Safe Post-Interaction Audio Chime: Dispatched by Service Worker upon user notification click
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "USER_INTERACTED_PLAY_ALERT") {
        unlockAudio();
        if (event.data.sound) {
          try {
            const audio = new Audio(event.data.sound);
            audio.play().catch(() => {
              playPortalAudioChime("alert");
            });
          } catch {
            playPortalAudioChime("alert");
          }
        } else {
          playPortalAudioChime("alert");
        }
      }
    });
  }
}

/**
 * Play a crystal-clear, high-volume harmonic chime for instant auditory notification
 */
export function playPortalAudioChime(type: NotificationType): void {
  // Trigger physical device vibration with high-priority pattern
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(getVibrationPatternForType(type));
    } catch {}
  }

  // Attempt playing default high-volume notification WAV file
  try {
    const audio = new Audio("/notification.wav");
    audio.volume = 1.0;
    audio.play().catch(() => {});
  } catch {}

  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  } catch {}

  const now = ctx.currentTime;
  const normType = String(type || "").toLowerCase();

  try {
    if (normType === "attendance") {
      // Pleasant clear double-chime (D5 -> A5)
      playTone(ctx, 587.33, now, 0.18, "sine", 0.45);
      playTone(ctx, 880.0, now + 0.12, 0.45, "sine", 0.55);
    } else if (normType === "absence") {
      // Urgent attention-grabbing minor alert triad (E4 -> C4 -> G4)
      playTone(ctx, 329.63, now, 0.22, "triangle", 0.5);
      playTone(ctx, 261.63, now + 0.16, 0.35, "sine", 0.55);
      playTone(ctx, 392.0, now + 0.32, 0.45, "triangle", 0.6);
    } else if (normType === "delay" || normType === "late") {
      // Warning prompt (F4 -> G4 -> D5)
      playTone(ctx, 349.23, now, 0.18, "sine", 0.45);
      playTone(ctx, 392.0, now + 0.12, 0.25, "triangle", 0.5);
      playTone(ctx, 587.33, now + 0.25, 0.4, "sine", 0.55);
    } else if (normType === "fee" || normType === "payment") {
      // Harmonic celebratory chime (C5 -> E5 -> G5)
      playTone(ctx, 523.25, now, 0.15, "sine", 0.4);
      playTone(ctx, 659.25, now + 0.1, 0.18, "sine", 0.45);
      playTone(ctx, 783.99, now + 0.2, 0.45, "sine", 0.55);
    } else if (normType === "grade" || normType === "exam") {
      // Ascending success arpeggio (G4 -> C5 -> E5 -> G5)
      playTone(ctx, 392.0, now, 0.12, "sine", 0.4);
      playTone(ctx, 523.25, now + 0.1, 0.12, "sine", 0.45);
      playTone(ctx, 659.25, now + 0.18, 0.14, "sine", 0.5);
      playTone(ctx, 783.99, now + 0.26, 0.5, "sine", 0.6);
    } else if (normType === "homework") {
      // Academic task chime (E5 -> B5 -> G#5)
      playTone(ctx, 659.25, now, 0.12, "sine", 0.4);
      playTone(ctx, 987.77, now + 0.1, 0.22, "sine", 0.5);
      playTone(ctx, 830.61, now + 0.2, 0.35, "sine", 0.45);
    } else if (normType === "chat" || normType === "message") {
      // Modern message bubble pop-chime (F5 -> C6)
      playTone(ctx, 698.46, now, 0.1, "sine", 0.45);
      playTone(ctx, 1046.5, now + 0.08, 0.3, "sine", 0.5);
    } else if (normType === "edit" || normType === "data_edit") {
      // Data updated notification chime (A4 -> C#5 -> E5)
      playTone(ctx, 440.0, now, 0.14, "sine", 0.4);
      playTone(ctx, 554.37, now + 0.1, 0.18, "sine", 0.45);
      playTone(ctx, 659.25, now + 0.2, 0.35, "sine", 0.5);
    } else {
      // General alert chime
      playTone(ctx, 440.0, now, 0.3, "sine", 0.45);
      playTone(ctx, 660.0, now + 0.15, 0.4, "sine", 0.5);
    }
  } catch (err) {
    console.warn("Audio chime error:", err);
  }
}

function playTone(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
  waveType: OscillatorType,
  volume: number
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = waveType;
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(0.001, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

/**
 * Check if Web Notifications are supported
 */
export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Request permission for web push notifications.
 * MUST be triggered by an explicit user gesture (e.g. click/tap) to comply with mobile audio autoplay policies.
 */
export async function requestNotificationPermission(
  userId?: string,
  userRole: "parent" | "student" | "admin" = "parent",
  aliases: string[] = []
): Promise<NotificationPermission> {
  if (!isNotificationSupported()) {
    return "denied";
  }
  try {
    // Unlock and resume AudioContext synchronously within user gesture call stack
    const ctx = getAudioContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const permPromise = Notification.requestPermission();
    const perm =
      permPromise instanceof Promise
        ? await permPromise
        : await new Promise<NotificationPermission>((res) => (Notification as any).requestPermission(res));

    if (perm === "granted" && userId) {
      import("../services/pushNotificationService")
        .then(({ autoRequestPermissionAndSyncFCMToken, registerPushSubscription }) => {
          autoRequestPermissionAndSyncFCMToken(userId, userRole, aliases).catch(() => {
            registerPushSubscription(userId, userRole, aliases).catch(() => {});
          });
        })
        .catch(() => {});
    }
    return perm;
  } catch {
    return "denied";
  }
}

import { shouldNotifyEvent, markEventProcessed } from "./notificationTracker";

/**
 * Send an instantaneous in-app or system push notification with audio alert
 */
export async function sendPortalNotification(
  title: string,
  body: string,
  type: NotificationType = "alert",
  options?: {
    url?: string;
    sound?: boolean;
    eventId?: string;
    timestamp?: number;
    force?: boolean;
  }
): Promise<void> {
  // Deduplication check: Do not re-notify if already processed or historical
  if (options?.eventId) {
    if (
      !shouldNotifyEvent({
        eventId: options.eventId,
        timestamp: options.timestamp,
        force: options.force,
      })
    ) {
      return;
    }
  }

  // 1. Play acoustic chime if not explicitly muted
  if (options?.sound !== false) {
    playPortalAudioChime(type);
  }

  // 2. Trigger mobile phone physical vibration if hardware supports it
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      navigator.vibrate(getVibrationPatternForType(type));
    } catch {}
  }

  // 3. Display system-level push notification if permitted
  if (isNotificationSupported() && Notification.permission === "granted") {
    const vibratePattern = getVibrationPatternForType(type);
    const targetUrl = options?.url || "/";
    const notifTag = options?.eventId || `eman-${type}-${Date.now()}`;

    // A. Service Worker Registration (Required on Android Chrome, highly reliable across all mobile browsers)
    if ("serviceWorker" in navigator) {
      try {
        let reg = await navigator.serviceWorker.getRegistration();
        if (!reg) {
          reg = await navigator.serviceWorker.register("/sw.js");
          await navigator.serviceWorker.ready;
        }

        if (reg && typeof reg.showNotification === "function") {
          await reg.showNotification(title, {
            body,
            icon: "/icon.svg",
            badge: "/icon.svg",
            vibrate: vibratePattern,
            silent: false, // Rings the phone's native notification sound
            renotify: true, // Guarantees new sound even if previous notif is unread
            requireInteraction: true,
            tag: notifTag,
            data: { url: targetUrl, eventId: options?.eventId },
            dir: "rtl",
            lang: "ar",
          } as any);
          return;
        }
      } catch (err) {
        console.warn("ServiceWorker showNotification failed:", err);
      }
    }

    // B. Standard Notification fallback (for desktop Safari/Edge/Firefox)
    try {
      new Notification(title, {
        body,
        icon: "/icon.svg",
        tag: notifTag,
        silent: false,
        dir: "rtl",
        lang: "ar",
      });
    } catch (err) {
      console.warn("Desktop Notification fallback failed:", err);
    }
  }
}
