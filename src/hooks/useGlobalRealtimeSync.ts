import type { Dispatch, SetStateAction } from "react";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  supabase,
  barcodeToUUID,
  normalizeBarcode,
  getSecureChannelTopic,
  throttledRealtimeConnect,
} from "../utils/supabaseClient";
import { ParentAccount } from "../types/portal";
import {
  getLocalParentAccounts,
  saveLocalParentAccounts,
  getSavedPortalSession,
  getDeletedTombstones,
  addDeletedTombstones,
} from "../utils/portalStorage";
import {
  updateSessionPortalAttendance,
  updateSessionPortalPayment,
  updateSessionPortalStudent,
  updateSessionPortalHomework,
  updateSessionPortalExamGrade,
  deleteSessionPortalExamGrade,
  deleteSessionPortalAttendance,
  deleteSessionPortalPayment,
  deleteSessionPortalHomework,
  updateSessionPortalMessage,
} from "../utils/portalSessionStore";
import {
  playPortalAudioChime,
  sendPortalNotification,
  getVibrationPatternForType,
  NotificationType,
} from "../utils/portalNotifications";
import { shouldNotifyEvent, SESSION_START_TIME, markEventProcessed } from "../utils/notificationTracker";

export type RealtimeTable =
  | "attendance_logs"
  | "homework"
  | "payments"
  | "students"
  | "exam_grades"
  | "evaluations"
  | "messages"
  | "chat_messages"
  | "parent_accounts";

export interface RealtimeTableChange<T = any> {
  table: RealtimeTable;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T | null;
  old: T | null;
}

export interface UseGlobalRealtimeSyncOptions {
  /** Operational mode: "admin" for whole-school synchronization, "parent" for child-scoped listening */
  mode?: "admin" | "parent" | "global";
  /** Target student barcode (if omitted, auto-detected from logged-in parent session) */
  studentBarcode?: string;
  /** Target student ID / UUID (if known) */
  studentId?: string;
  /** Linked student barcodes for multi-child accounts */
  linkedBarcodes?: string[];
  /** Whether to play sound chime automatically on received alerts (defaults to true) */
  enableSoundAlerts?: boolean;
  /** Callback fired when attendance logs change */
  onAttendanceChange?: (change: RealtimeTableChange<any>) => void;
  /** Callback fired when homework logs change */
  onHomeworkChange?: (change: RealtimeTableChange<any>) => void;
  /** Callback fired when payments change */
  onPaymentChange?: (change: RealtimeTableChange<any>) => void;
  /** Callback fired when student record changes */
  onStudentChange?: (change: RealtimeTableChange<any>) => void;
  /** Callback fired when exam grades or evaluations change */
  onGradeChange?: (change: RealtimeTableChange<any>) => void;
  /** Callback fired when chat/messages change */
  onMessageChange?: (change: RealtimeTableChange<any>) => void;
  /** Generic callback fired on any table change */
  onAnyChange?: (change: RealtimeTableChange<any>) => void;

  // Account sync parameters (backward compatibility):
  initialAccounts?: ParentAccount[];
  accounts?: ParentAccount[];
  setAccounts?: Dispatch<SetStateAction<ParentAccount[]>>;
  onAccountInserted?: (account: ParentAccount) => void;
  onAccountUpdated?: (account: ParentAccount) => void;
  onAccountDeleted?: (deletedId: string) => void;
}

/**
 * Normalizes and matches an account by id, barcode, or linked barcode against a search query/ID.
 */
export function matchesAccount(acc: ParentAccount, query: string): boolean {
  if (!acc || !query) return false;
  const clean = String(query).trim().toLowerCase();
  const cleanBarcode = normalizeBarcode(clean).toLowerCase();
  const cleanUUID = barcodeToUUID(cleanBarcode || clean).toLowerCase();

  const accId = String(acc.id || "").trim().toLowerCase();
  const accBarcode = String(acc.studentBarcode || "").trim().toLowerCase();
  const accUUID = barcodeToUUID(accBarcode || accId).toLowerCase();

  if (accId && (accId === clean || accId === cleanUUID)) return true;
  if (accBarcode && (accBarcode === clean || accBarcode === cleanBarcode)) return true;
  if (accUUID && (accUUID === clean || accUUID === cleanUUID)) return true;

  if (Array.isArray(acc.linkedBarcodes)) {
    for (const b of acc.linkedBarcodes) {
      const bLower = String(b).trim().toLowerCase();
      const bUUID = barcodeToUUID(bLower).toLowerCase();
      if (bLower === clean || bLower === cleanBarcode || bUUID === clean || bUUID === cleanUUID) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Strict filtering check: determines if a raw database row belongs to the target student
 */
export function isRowForStudent(
  row: any,
  targetBarcode: string,
  targetId?: string,
  linkedBarcodes: string[] = []
): boolean {
  if (!row) return false;
  const cleanTarget = normalizeBarcode(targetBarcode).toLowerCase();
  const allowedBarcodes = new Set<string>([
    cleanTarget,
    ...linkedBarcodes.map((b) => normalizeBarcode(b).toLowerCase()).filter(Boolean),
  ]);

  const rowBarcode = normalizeBarcode(
    String(row.barcode || row.student_barcode || row.chat_id || row.studentBarcode || "")
  ).toLowerCase();

  if (rowBarcode && allowedBarcodes.has(rowBarcode)) {
    return true;
  }

  if (targetId) {
    const cleanTargetId = String(targetId).trim().toLowerCase();
    const rowStudentId = String(row.student_id || row.id || "").trim().toLowerCase();
    if (
      rowStudentId &&
      (rowStudentId === cleanTargetId ||
        rowStudentId === barcodeToUUID(cleanTarget).toLowerCase())
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Maps a raw Supabase database row from `parent_accounts` to the client-side `ParentAccount` model.
 */
export function mapRowToAccount(row: any): ParentAccount | null {
  if (!row) return null;
  const rawId = String(row.id || "").trim();
  const linked: string[] = Array.isArray(row.linked_student_barcodes)
    ? row.linked_student_barcodes.map(String)
    : [];
  const primaryBarcode = linked[0] || (rawId && !rawId.includes("-") ? rawId : rawId);

  return {
    id: rawId,
    studentBarcode: primaryBarcode,
    studentName: row.student_name || "",
    parentName: row.parent_name || "",
    parentPhone: String(row.parent_phone || "").trim(),
    password: row.password_hash || row.password || "",
    linkedBarcodes: linked.length > 0 ? linked : [primaryBarcode],
    fcmToken: row.fcm_token || "",
    status: (row.status || "active").toLowerCase() as "active" | "disabled" | "deleted",
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
    activatedAt: row.activated_at || row.created_at,
    reason: row.reason || "",
  };
}

/**
 * Converts the current ParentAccount array to the key-value dictionary and persists to localStorage.
 */
function syncLocalAccountsCache(accounts: ParentAccount[]): Record<string, ParentAccount> {
  const record: Record<string, ParentAccount> = {};
  for (const acc of accounts) {
    if (!acc) continue;
    const bCode = acc.studentBarcode;
    if (bCode) {
      record[bCode] = acc;
    }
    if (Array.isArray(acc.linkedBarcodes)) {
      for (const b of acc.linkedBarcodes) {
        if (b && !record[b]) {
          record[b] = acc;
        }
      }
    }
  }
  saveLocalParentAccounts(record);
  return record;
}

/**
 * Extracts initial parent accounts from local storage as an array.
 */
function getInitialAccountsArray(): ParentAccount[] {
  const map = getLocalParentAccounts();
  const seen = new Set<string>();
  const list: ParentAccount[] = [];

  for (const acc of Object.values(map)) {
    if (!acc || !acc.studentBarcode) continue;
    const key = acc.id || acc.studentBarcode;
    if (!seen.has(key)) {
      seen.add(key);
      list.push(acc);
    }
  }
  return list;
}

interface SubscriberCallbacks {
  id: string;
  setAccounts?: Dispatch<SetStateAction<ParentAccount[]>>;
  onAccountInserted?: (account: ParentAccount) => void;
  onAccountUpdated?: (account: ParentAccount) => void;
  onAccountDeleted?: (deletedId: string) => void;
}

// Module-level singleton channel and subscriber set for account sync
const activeSubscribers = new Set<SubscriberCallbacks>();
let sharedSyncChannel: any = null;

function ensureSharedSyncChannel() {
  if (sharedSyncChannel) {
    return sharedSyncChannel;
  }

  try {
    const existing = supabase
      .getChannels()
      .find(
        (ch) =>
          ch.topic === "realtime:parent-accounts-sync" ||
          ch.topic === "parent-accounts-sync"
      );
    if (existing) {
      supabase.removeChannel(existing);
    }
  } catch (err) {
    console.warn("[parent-accounts-sync] Channel cleanup notice:", err);
  }

  const channel = supabase.channel("parent-accounts-sync");

  channel
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "parent_accounts",
      },
      (payload: any) => {
        const newRow = payload?.new;
        if (!newRow) return;

        const newAccount = mapRowToAccount(newRow);
        if (!newAccount || !newAccount.studentBarcode) return;

        const tombstones = getDeletedTombstones();
        const cleanB = normalizeBarcode(newAccount.studentBarcode);
        if (
          tombstones.has(cleanB) ||
          newAccount.status === "deleted" ||
          (Array.isArray(newAccount.linkedBarcodes) && newAccount.linkedBarcodes.some((lb) => tombstones.has(normalizeBarcode(lb))))
        ) {
          return; // Ignore resurrection
        }

        const identifier = newAccount.id || newAccount.studentBarcode;

        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              const exists = prevAccounts.some((acc) => matchesAccount(acc, identifier));
              let next: ParentAccount[];
              if (exists) {
                next = prevAccounts.map((acc) =>
                  matchesAccount(acc, identifier) ? { ...acc, ...newAccount } : acc
                );
              } else {
                next = [...prevAccounts, newAccount];
              }
              const cloned = [...next];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountInserted?.(newAccount);
        });

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eman_account_sync", {
              detail: { event: "INSERT", account: newAccount },
            })
          );
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "parent_accounts",
      },
      (payload: any) => {
        const newRow = payload?.new;
        if (!newRow) return;

        const updatedAccount = mapRowToAccount(newRow);
        if (!updatedAccount || !updatedAccount.studentBarcode) return;

        const identifier = updatedAccount.id || updatedAccount.studentBarcode;
        const cleanB = normalizeBarcode(updatedAccount.studentBarcode);
        const tombstones = getDeletedTombstones();
        const isDeletedStatus =
          String(updatedAccount.status || "").toLowerCase() === "deleted" ||
          tombstones.has(cleanB) ||
          (Array.isArray(updatedAccount.linkedBarcodes) && updatedAccount.linkedBarcodes.some((lb) => tombstones.has(normalizeBarcode(lb))));

        if (isDeletedStatus) {
          addDeletedTombstones(cleanB);
          if (Array.isArray(updatedAccount.linkedBarcodes)) {
            addDeletedTombstones(updatedAccount.linkedBarcodes);
          }
        }

        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              let next: ParentAccount[];
              if (isDeletedStatus) {
                next = prevAccounts.filter((acc) => !matchesAccount(acc, identifier));
              } else {
                let found = false;
                const mapped = prevAccounts.map((acc) => {
                  if (matchesAccount(acc, identifier)) {
                    found = true;
                    return { ...acc, ...updatedAccount };
                  }
                  return acc;
                });
                next = found ? mapped : [...prevAccounts, updatedAccount];
              }
              const cloned = [...next];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountUpdated?.(updatedAccount);
        });

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eman_account_sync", {
              detail: { event: "UPDATE", account: updatedAccount },
            })
          );
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "DELETE",
        schema: "public",
        table: "parent_accounts",
      },
      (payload: any) => {
        const oldRow = payload?.old;
        const deletedId = String(oldRow?.id || oldRow?.student_barcode || "").trim();
        if (!deletedId) return;

        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              const filtered = prevAccounts.filter((acc) => !matchesAccount(acc, deletedId));
              const cloned = [...filtered];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountDeleted?.(deletedId);
        });

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eman_account_sync", {
              detail: { event: "DELETE", deletedId },
            })
          );
        }
      }
    );

  channel.subscribe((status: string, err: any) => {
    if (status === "SUBSCRIBED") {
      console.info("[parent-accounts-sync] Realtime CDC channel connected successfully.");
    } else if (status === "CHANNEL_ERROR") {
      console.warn("[parent-accounts-sync] Realtime CDC channel error:", err);
    }
  });

  sharedSyncChannel = channel;
  return channel;
}

/**
 * Unified Realtime Listener Engine for Parent App
 * Listens to postgres_changes across attendance_logs, homework, payments, students, messages, and parent_accounts
 * Strictly filtered by logged-in parent's student barcode / ID
 */
export function useGlobalRealtimeSync(options?: UseGlobalRealtimeSyncOptions) {
  // Extract target student barcode & linked barcodes
  const [activeBarcode, setActiveBarcode] = useState<string>(() => {
    if (options?.studentBarcode) return normalizeBarcode(options.studentBarcode);
    const sess = getSavedPortalSession();
    return normalizeBarcode(sess?.account?.studentBarcode || sess?.barcode || "");
  });

  const [activeStudentId, setActiveStudentId] = useState<string | undefined>(options?.studentId);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  // Sync state if options change
  useEffect(() => {
    if (options?.studentBarcode) {
      const clean = normalizeBarcode(options.studentBarcode);
      if (clean !== activeBarcode) setActiveBarcode(clean);
    }
    if (options?.studentId !== undefined && options.studentId !== activeStudentId) {
      setActiveStudentId(options.studentId);
    }
  }, [options?.studentBarcode, options?.studentId]);

  // If barcode wasn't provided, listen to session updates in localStorage
  useEffect(() => {
    if (options?.studentBarcode) return;
    const handleStorage = () => {
      const sess = getSavedPortalSession();
      const b = normalizeBarcode(sess?.account?.studentBarcode || sess?.barcode || "");
      if (b && b !== activeBarcode) {
        setActiveBarcode(b);
      }
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("eman_portal_session_updated" as any, handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("eman_portal_session_updated" as any, handleStorage);
    };
  }, [options?.studentBarcode, activeBarcode]);

  // Stable callback refs to ensure zero infinite re-renders
  const onAttendanceRef = useRef(options?.onAttendanceChange);
  const onHomeworkRef = useRef(options?.onHomeworkChange);
  const onPaymentRef = useRef(options?.onPaymentChange);
  const onStudentRef = useRef(options?.onStudentChange);
  const onGradeRef = useRef(options?.onGradeChange);
  const onMessageRef = useRef(options?.onMessageChange);
  const onAnyRef = useRef(options?.onAnyChange);
  const enableSoundAlerts = options?.enableSoundAlerts !== false;

  useEffect(() => {
    onAttendanceRef.current = options?.onAttendanceChange;
    onHomeworkRef.current = options?.onHomeworkChange;
    onPaymentRef.current = options?.onPaymentChange;
    onStudentRef.current = options?.onStudentChange;
    onGradeRef.current = options?.onGradeChange;
    onMessageRef.current = options?.onMessageChange;
    onAnyRef.current = options?.onAnyChange;
  }, [
    options?.onAttendanceChange,
    options?.onHomeworkChange,
    options?.onPaymentChange,
    options?.onStudentChange,
    options?.onGradeChange,
    options?.onMessageChange,
    options?.onAnyChange,
  ]);

  // Background Reconnection & Visibility Change (Item 5, 2, 3):
  // 1. Immediate un-throttled REST data revalidation when user opens/returns to the app (<200ms)
  // 2. Throttled reconnect of Supabase Realtime WebSocket socket (4s cooldown) to prevent reconnect storms and HTTP 429
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        // Immediate un-throttled REST data revalidation
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eman_portal_force_revalidate", {
              detail: { timestamp: Date.now(), source: "document-visibilitychange" },
            })
          );
        }
        // Throttled WebSocket reconnect
        throttledRealtimeConnect("document-visibilitychange");
      }
    };

    const handleWindowFocus = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        // Immediate un-throttled REST data revalidation
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eman_portal_force_revalidate", {
              detail: { timestamp: Date.now(), source: "window-focus" },
            })
          );
        }
        // Throttled WebSocket reconnect
        throttledRealtimeConnect("window-focus");
      }
    };

    const handleOnline = () => {
      // Immediate un-throttled REST data revalidation on network recovery
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("eman_portal_force_revalidate", {
            detail: { timestamp: Date.now(), source: "network-online" },
          })
        );
      }
      // Throttled WebSocket reconnect
      throttledRealtimeConnect("network-online");
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleWindowFocus);
      window.addEventListener("online", handleOnline);
    }

    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleWindowFocus);
        window.removeEventListener("online", handleOnline);
      }
    };
  }, []);

  // Helper to trigger chime & vibration for received alerts with deduplication (Item 8) and safe autoplay handling (Item 3)
  const triggerAlertFeedback = useCallback(
    (type: NotificationType, title: string, body: string, eventId?: string, createdAt?: string | number) => {
      if (!enableSoundAlerts) return;

      // Commandment 8: Drop stale CDC replay events older than current session start
      if (createdAt) {
        const time = typeof createdAt === "number" ? createdAt : new Date(createdAt).getTime();
        if (!isNaN(time) && time < SESSION_START_TIME - 1000) {
          if (eventId) markEventProcessed(eventId);
          return;
        }
      }

      // Notification Deduplication: check if already processed (e.g. by Web Push / FCM / previous CDC)
      if (eventId && !shouldNotifyEvent({ eventId, timestamp: createdAt ? (typeof createdAt === "number" ? createdAt : new Date(createdAt).getTime()) : undefined })) {
        console.log("[Notification Deduplication] Skipping duplicate alert already handled:", eventId);
        return;
      }

      // Safe Audio autoplay attempt with fallback to PWA system push notification
      try {
        const chime = new Audio('/notification.mp3');
        chime.volume = 1.0;
        const playPromise = chime.play();
        if (playPromise !== undefined) {
          playPromise.catch((playErr) => {
            console.warn("[Realtime Audio] Autoplay policy prevented playback; relying on system push notifications:", playErr?.name || playErr);
          });
        }
      } catch (err) {
        console.warn("[Realtime Audio] Audio initialization notice:", err);
      }

      try {
        playPortalAudioChime(type);
      } catch {}

      sendPortalNotification(title, body, type, { eventId }).catch(() => {});
    },
    [enableSoundAlerts]
  );

  // ─── Persistent Supabase Realtime Subscription for Student Tables ───
  useEffect(() => {
    const isGlobalAdmin = options?.mode === "admin" || (!activeBarcode && options?.mode !== "parent");
    if (!isGlobalAdmin && !activeBarcode) return;

    const cleanBarcode = normalizeBarcode(activeBarcode || "");
    const cleanStudentId = activeStudentId;
    const linkedList = options?.linkedBarcodes || [];

    const channelTopic = isGlobalAdmin
      ? "admin-global-realtime-engine"
      : getSecureChannelTopic("parent-student-engine", cleanBarcode);

    // Clean up any stale channel with this topic first
    try {
      const existing = supabase
        .getChannels()
        .find((ch) => ch.topic === `realtime:${channelTopic}` || ch.topic === channelTopic);
      if (existing) {
        supabase.removeChannel(existing);
      }
    } catch {}

    const channel = supabase.channel(channelTopic);

    // 1. Attendance Logs Subscription (INSERT, UPDATE, DELETE)
    channel
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "attendance_logs",
        },
        (payload: any) => {
          const newRow = payload?.new;
          const oldRow = payload?.old;
          const targetRow = newRow || oldRow;

          if (!isGlobalAdmin && !isRowForStudent(targetRow, cleanBarcode, cleanStudentId, linkedList)) return;

          const rowBarcode = normalizeBarcode(
            String(targetRow?.student_barcode || targetRow?.barcode || cleanBarcode)
          );

          const change: RealtimeTableChange = {
            table: "attendance_logs",
            eventType: payload.eventType,
            new: newRow,
            old: oldRow,
          };

          if (payload.eventType === "DELETE") {
            if (!isGlobalAdmin) {
              deleteSessionPortalAttendance(rowBarcode, oldRow?.id || oldRow?.date_key);
            }
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", { detail: change })
              );
            }
          } else if (newRow && newRow.date_key) {
            const status = String(newRow.status || "حضور").trim();
            if (!isGlobalAdmin) {
              updateSessionPortalAttendance(rowBarcode, newRow.date_key, status);

              // Determine alert type & sound
              let alertType: NotificationType = "attendance";
              let alertTitle = "تسجيل حضور الطالب";
              let alertBody = `تم تسجيل حضور الطالب بتاريخ ${newRow.date_key}`;

              if (status === "غياب" || status === "غائب") {
                alertType = "absence";
                alertTitle = "تنبيه غياب الطالب";
                alertBody = `تم تسجيل غياب الطالب اليوم (${newRow.date_key}) في المنظومة`;
              } else if (status === "تأخير") {
                alertType = "delay";
                alertTitle = "تنبيه تأخير الطالب";
                alertBody = `تم تسجيل تأخير الطالب في حصة اليوم (${newRow.date_key})`;
              }

              triggerAlertFeedback(alertType, alertTitle, alertBody, `att-${newRow.id || newRow.date_key}`, newRow.created_at || newRow.date);
            }

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_attendance_sync", {
                  detail: { ...newRow, barcode: rowBarcode },
                })
              );
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", {
                  detail: change,
                })
              );
            }
          }

          onAttendanceRef.current?.(change);
          onAnyRef.current?.(change);
        }
      )
      // 2. Homework Logs Subscription (INSERT, UPDATE, DELETE)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "homework",
        },
        (payload: any) => {
          const newRow = payload?.new;
          const oldRow = payload?.old;
          const targetRow = newRow || oldRow;

          if (!isGlobalAdmin && !isRowForStudent(targetRow, cleanBarcode, cleanStudentId, linkedList)) return;

          const rowBarcode = normalizeBarcode(
            String(targetRow?.student_barcode || targetRow?.barcode || cleanBarcode)
          );

          const change: RealtimeTableChange = {
            table: "homework",
            eventType: payload.eventType,
            new: newRow,
            old: oldRow,
          };

          if (payload.eventType === "DELETE") {
            if (!isGlobalAdmin) {
              deleteSessionPortalHomework(rowBarcode, oldRow?.id || oldRow?.date_key);
            }
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", { detail: change })
              );
            }
          } else if (newRow) {
            if (!isGlobalAdmin) {
              updateSessionPortalHomework(rowBarcode, newRow);
              const title = newRow.title || "الواجب المدرسي";
              triggerAlertFeedback(
                "homework",
                "متابعة الواجب المدرسي",
                `تم تحديث سجل الواجب: ${title} (${newRow.status || "مكتمل"})`,
                `hw-${newRow.id || newRow.date_key}`,
                newRow.created_at || newRow.date
              );
            }

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_homework_sync", {
                  detail: { ...newRow, barcode: rowBarcode },
                })
              );
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", {
                  detail: change,
                })
              );
            }
          }

          onHomeworkRef.current?.(change);
          onAnyRef.current?.(change);
        }
      )
      // 3. Payments Subscription (INSERT, UPDATE, DELETE)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "payments",
        },
        (payload: any) => {
          const newRow = payload?.new;
          const oldRow = payload?.old;
          const targetRow = newRow || oldRow;

          if (!isGlobalAdmin && !isRowForStudent(targetRow, cleanBarcode, cleanStudentId, linkedList)) return;

          const rowBarcode = normalizeBarcode(
            String(targetRow?.student_barcode || targetRow?.barcode || cleanBarcode)
          );

          const change: RealtimeTableChange = {
            table: "payments",
            eventType: payload.eventType,
            new: newRow,
            old: oldRow,
          };

          if (payload.eventType === "DELETE") {
            if (!isGlobalAdmin) {
              deleteSessionPortalPayment(rowBarcode, oldRow?.id || oldRow?.month_key);
            }
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", { detail: change })
              );
            }
          } else if (newRow && (newRow.month_key || newRow.monthKey)) {
            const mKey = newRow.month_key || newRow.monthKey;
            const paymentRecord = {
              barcode: rowBarcode,
              monthKey: mKey,
              amount: Number(newRow.amount_paid || newRow.amount || 0),
              paidAmount: Number(newRow.amount_paid || newRow.amount || 0),
              requiredAmount: Number(newRow.required_amount || 0),
              date: newRow.payment_date || new Date().toISOString(),
              month: mKey,
              notes: newRow.notes || "",
            };

            if (!isGlobalAdmin) {
              updateSessionPortalPayment(rowBarcode, mKey, paymentRecord);
              triggerAlertFeedback(
                "fee",
                "إيصال سداد مصروفات جديد",
                `تم تسجيل دفعة مصروفات بقيمة ${paymentRecord.paidAmount} ج.م لشهر (${mKey})`,
                `pay-${newRow.id || mKey}`,
                newRow.created_at || newRow.payment_date
              );
            }

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_payment_sync", {
                  detail: { paymentRecord, barcode: rowBarcode },
                })
              );
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", {
                  detail: change,
                })
              );
            }
          }

          onPaymentRef.current?.(change);
          onAnyRef.current?.(change);
        }
      )
      // 4. Students Subscription (INSERT, UPDATE, DELETE)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "students",
        },
        (payload: any) => {
          const newRow = payload?.new;
          const oldRow = payload?.old;
          const targetRow = newRow || oldRow;

          if (!isGlobalAdmin && !isRowForStudent(targetRow, cleanBarcode, cleanStudentId, linkedList)) return;

          const rowBarcode = normalizeBarcode(
            String(targetRow?.barcode || cleanBarcode)
          );

          const change: RealtimeTableChange = {
            table: "students",
            eventType: payload.eventType,
            new: newRow,
            old: oldRow,
          };

          if (newRow) {
            if (!isGlobalAdmin) {
              updateSessionPortalStudent(rowBarcode, (prev: any) => ({
                ...(prev || {}),
                ...newRow,
                barcode: rowBarcode,
              }));

              // Differentiate between exam grades and data edits
              const isGradeUpdate =
                newRow.last_exam_score !== undefined &&
                (!oldRow || newRow.last_exam_score !== oldRow.last_exam_score);

              if (isGradeUpdate) {
                triggerAlertFeedback(
                  "grade",
                  "رصد درجات امتحان جديدة",
                  `حصل الطالب على درجة ${newRow.last_exam_score} في ${newRow.last_exam_title || "الامتحان"}`,
                  `grade-${newRow.id || Date.now()}`,
                  newRow.updated_at || newRow.created_at
                );
              } else {
                triggerAlertFeedback(
                  "edit",
                  "تحديث بيانات الطالب",
                  `تم تحديث بيانات الطالب ${newRow.name || ""} في المنظومة`,
                  `student-${newRow.id || Date.now()}`,
                  newRow.updated_at || newRow.created_at
                );
              }
            }

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_student_sync", {
                  detail: { student: newRow, barcode: rowBarcode },
                })
              );
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", {
                  detail: change,
                })
              );
            }
          }

          onStudentRef.current?.(change);
          onAnyRef.current?.(change);
        }
      )
      // 5. Exam Grades Subscription (INSERT, UPDATE, DELETE)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "exam_grades",
        },
        (payload: any) => {
          const newRow = payload?.new;
          const oldRow = payload?.old;
          const targetRow = newRow || oldRow;

          if (!isGlobalAdmin && !isRowForStudent(targetRow, cleanBarcode, cleanStudentId, linkedList)) return;

          const rowBarcode = normalizeBarcode(
            String(targetRow?.student_barcode || targetRow?.barcode || cleanBarcode)
          );

          const change: RealtimeTableChange = {
            table: "exam_grades",
            eventType: payload.eventType,
            new: newRow,
            old: oldRow,
          };

          if (payload.eventType === "DELETE") {
            if (!isGlobalAdmin) {
              deleteSessionPortalExamGrade(rowBarcode, oldRow?.id || oldRow?.exam_title);
            }
            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", { detail: change })
              );
            }
          } else if (newRow) {
            if (!isGlobalAdmin) {
              updateSessionPortalExamGrade(rowBarcode, newRow);
              const title = newRow.exam_title || newRow.title || "اختبار جديد";
              const scoreStr = `${newRow.score || 0} / ${newRow.max_score || 10}`;
              triggerAlertFeedback(
                "grade",
                "رصد درجات امتحان جديدة",
                `حصل الطالب على درجة ${scoreStr} في ${title}`,
                `grade-${newRow.id || Date.now()}`,
                newRow.created_at || newRow.exam_date || newRow.date
              );
            }

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_grade_sync", {
                  detail: { ...newRow, barcode: rowBarcode },
                })
              );
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", {
                  detail: change,
                })
              );
            }
          }

          onGradeRef.current?.(change);
          onAnyRef.current?.(change);
        }
      )
      // 6. Evaluations View/Table Fallback Subscription
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "evaluations",
        },
        (payload: any) => {
          const newRow = payload?.new;
          const oldRow = payload?.old;
          const targetRow = newRow || oldRow;

          if (!isGlobalAdmin && !isRowForStudent(targetRow, cleanBarcode, cleanStudentId, linkedList)) return;

          const rowBarcode = normalizeBarcode(
            String(targetRow?.student_barcode || targetRow?.barcode || cleanBarcode)
          );

          const change: RealtimeTableChange = {
            table: "evaluations",
            eventType: payload.eventType,
            new: newRow,
            old: oldRow,
          };

          if (payload.eventType === "DELETE") {
            if (!isGlobalAdmin) {
              deleteSessionPortalExamGrade(rowBarcode, oldRow?.id || oldRow?.exam_title);
            }
          } else if (newRow) {
            if (!isGlobalAdmin) {
              updateSessionPortalExamGrade(rowBarcode, newRow);
            }
          }

          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("eman_grade_sync", {
                detail: { ...newRow, barcode: rowBarcode },
              })
            );
            window.dispatchEvent(
              new CustomEvent("eman_realtime_data_update", {
                detail: change,
              })
            );
          }

          onGradeRef.current?.(change);
          onAnyRef.current?.(change);
        }
      )
      // 7. Messages & Chat Messages Subscription (INSERT, UPDATE, DELETE)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "chat_messages",
        },
        (payload: any) => {
          const newRow = payload?.new;
          const oldRow = payload?.old;
          const targetRow = newRow || oldRow;

          if (!isGlobalAdmin && !isRowForStudent(targetRow, cleanBarcode, cleanStudentId, linkedList)) return;

          const rowBarcode = normalizeBarcode(
            String(targetRow?.student_barcode || targetRow?.barcode || cleanBarcode)
          );

          const change: RealtimeTableChange = {
            table: "chat_messages",
            eventType: payload.eventType,
            new: newRow,
            old: oldRow,
          };

          if (newRow) {
            if (!isGlobalAdmin) {
              updateSessionPortalMessage(rowBarcode, newRow);
              const isFromSupervisor =
                newRow.sender === "admin" ||
                newRow.sender_role === "supervisor" ||
                newRow.sender_role === "admin" ||
                newRow.sender_role === "assistant" ||
                (newRow.sender && newRow.sender !== "parent");

              if (isFromSupervisor && payload.eventType === "INSERT") {
                triggerAlertFeedback(
                  "chat",
                  "رسالة جديدة من إدارة المنظومة",
                  newRow.message || newRow.text || "رسالة واردة جديدة بخصوص الطالب",
                  `msg-${newRow.id || Date.now()}`,
                  newRow.created_at
                );
              }
            }

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_message_sync", {
                  detail: { message: newRow, barcode: rowBarcode },
                })
              );
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", {
                  detail: change,
                })
              );
            }
          }

          onMessageRef.current?.(change);
          onAnyRef.current?.(change);
        }
      )
      // 8. Fallback Messages Subscription
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
        },
        (payload: any) => {
          const newRow = payload?.new;
          const oldRow = payload?.old;
          const targetRow = newRow || oldRow;

          if (!isGlobalAdmin && !isRowForStudent(targetRow, cleanBarcode, cleanStudentId, linkedList)) return;

          const rowBarcode = normalizeBarcode(
            String(targetRow?.student_barcode || targetRow?.barcode || cleanBarcode)
          );

          const change: RealtimeTableChange = {
            table: "messages",
            eventType: payload.eventType,
            new: newRow,
            old: oldRow,
          };

          if (newRow) {
            if (!isGlobalAdmin) {
              updateSessionPortalMessage(rowBarcode, newRow);
              const isFromSupervisor =
                newRow.sender === "admin" ||
                newRow.sender_role === "supervisor" ||
                newRow.sender_role === "admin" ||
                newRow.sender_role === "assistant" ||
                (newRow.sender && newRow.sender !== "parent");

              if (isFromSupervisor && payload.eventType === "INSERT") {
                triggerAlertFeedback(
                  "chat",
                  "رسالة جديدة من إدارة المنظومة",
                  newRow.message || newRow.text || "رسالة واردة جديدة بخصوص الطالب",
                  `msg-${newRow.id || Date.now()}`,
                  newRow.created_at
                );
              }
            }

            if (typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("eman_message_sync", {
                  detail: { message: newRow, barcode: rowBarcode },
                })
              );
              window.dispatchEvent(
                new CustomEvent("eman_realtime_data_update", {
                  detail: change,
                })
              );
            }
          }

          onMessageRef.current?.(change);
          onAnyRef.current?.(change);
        }
      );

    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        setIsConnected(true);
      }
    });

    return () => {
      try {
        supabase.removeChannel(channel);
      } catch (e) {
        console.warn("[realtime-engine] Channel cleanup notice:", e);
      }
      setIsConnected(false);
    };
  }, [activeBarcode, activeStudentId, options?.mode, options?.linkedBarcodes, triggerAlertFeedback]);

  // ─── Backward-Compatible Account Sync Functionality ───
  const [internalAccounts, setInternalAccounts] = useState<ParentAccount[]>(() => {
    if (options?.initialAccounts && options.initialAccounts.length > 0) {
      return options.initialAccounts;
    }
    return getInitialAccountsArray();
  });

  const isControlled = Boolean(options?.accounts && options?.setAccounts);
  const accounts = isControlled ? (options!.accounts as ParentAccount[]) : internalAccounts;
  const setAccounts = isControlled ? options!.setAccounts! : setInternalAccounts;

  const onInsertedRef = useRef(options?.onAccountInserted);
  const onUpdatedRef = useRef(options?.onAccountUpdated);
  const onDeletedRef = useRef(options?.onAccountDeleted);

  useEffect(() => {
    onInsertedRef.current = options?.onAccountInserted;
    onUpdatedRef.current = options?.onAccountUpdated;
    onDeletedRef.current = options?.onAccountDeleted;
  }, [options?.onAccountInserted, options?.onAccountUpdated, options?.onAccountDeleted]);

  const accountsRecord = useMemo<Record<string, ParentAccount>>(() => {
    const record: Record<string, ParentAccount> = {};
    for (const acc of accounts) {
      if (!acc) continue;
      if (acc.studentBarcode) {
        record[acc.studentBarcode] = acc;
      }
      if (Array.isArray(acc.linkedBarcodes)) {
        for (const b of acc.linkedBarcodes) {
          if (b && !record[b]) {
            record[b] = acc;
          }
        }
      }
    }
    return record;
  }, [accounts]);

  useEffect(() => {
    const subscriberId = Math.random().toString(36).slice(2, 9);
    const subscriber: SubscriberCallbacks = {
      id: subscriberId,
      setAccounts,
      onAccountInserted: (acc) => onInsertedRef.current?.(acc),
      onAccountUpdated: (acc) => onUpdatedRef.current?.(acc),
      onAccountDeleted: (id) => onDeletedRef.current?.(id),
    };

    activeSubscribers.add(subscriber);
    ensureSharedSyncChannel();

    return () => {
      activeSubscribers.delete(subscriber);
      if (activeSubscribers.size === 0 && sharedSyncChannel) {
        try {
          supabase.removeChannel(sharedSyncChannel);
        } catch (e) {
          console.warn("[parent-accounts-sync] Error removing channel on cleanup:", e);
        }
        sharedSyncChannel = null;
      }
    };
  }, [setAccounts]);

  const deleteAccount = useCallback(async (idOrBarcode: string): Promise<boolean> => {
    const cleanId = String(idOrBarcode || "").trim();
    if (!cleanId) return false;

    const cleanBarcode = normalizeBarcode(cleanId);
    const uuid = barcodeToUUID(cleanBarcode || cleanId);

    // Immediately record in tombstone cache to prevent resurrection
    addDeletedTombstones([cleanBarcode, cleanId].filter(Boolean));

    try {
      const { error } = await supabase
        .from("parent_accounts")
        .delete()
        .or(`id.eq.${uuid},id.eq.${cleanId},id.eq.${cleanBarcode}`);

      if (error) {
        console.warn("[useGlobalRealtimeSync] deleteAccount mutation server error:", error.message);
        return false;
      }

      activeSubscribers.forEach((sub) => {
        if (sub.setAccounts) {
          sub.setAccounts((prevAccounts) => {
            const filtered = prevAccounts.filter((acc) => !matchesAccount(acc, cleanId));
            const cloned = [...filtered];
            syncLocalAccountsCache(cloned);
            return cloned;
          });
        }
        sub.onAccountDeleted?.(cleanId);
      });

      return true;
    } catch (err) {
      console.error("[useGlobalRealtimeSync] deleteAccount exception:", err);
      return false;
    }
  }, []);

  const updateAccount = useCallback(
    async (idOrBarcode: string, updates: Partial<ParentAccount>): Promise<boolean> => {
      const cleanId = String(idOrBarcode || "").trim();
      if (!cleanId) return false;

      const cleanBarcode = normalizeBarcode(cleanId);
      const uuid = barcodeToUUID(cleanBarcode || cleanId);
      const nowIso = new Date().toISOString();

      const dbPayload: any = {
        updated_at: nowIso,
      };
      if (updates.parentPhone !== undefined) dbPayload.parent_phone = updates.parentPhone;
      if (updates.parentName !== undefined) dbPayload.parent_name = updates.parentName;
      if (updates.studentName !== undefined) dbPayload.student_name = updates.studentName;
      if (updates.password !== undefined) dbPayload.password_hash = updates.password;
      if (updates.status !== undefined) dbPayload.status = updates.status;
      if (updates.fcmToken !== undefined) dbPayload.fcm_token = updates.fcmToken;
      if (updates.linkedBarcodes !== undefined) dbPayload.linked_student_barcodes = updates.linkedBarcodes;
      if (updates.reason !== undefined) dbPayload.reason = updates.reason;

      try {
        const { error } = await supabase
          .from("parent_accounts")
          .update(dbPayload)
          .or(`id.eq.${uuid},id.eq.${cleanId},id.eq.${cleanBarcode}`);

        if (error) {
          console.warn("[useGlobalRealtimeSync] updateAccount mutation server error:", error.message);
          return false;
        }

        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              const mapped = prevAccounts.map((acc) => {
                if (matchesAccount(acc, cleanId)) {
                  return { ...acc, ...updates, updatedAt: nowIso };
                }
                return acc;
              });
              const cloned = [...mapped];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountUpdated?.({ ...updates, id: uuid, studentBarcode: cleanBarcode } as any);
        });

        return true;
      } catch (err) {
        console.error("[useGlobalRealtimeSync] updateAccount exception:", err);
        return false;
      }
    },
    []
  );

  const insertAccount = useCallback(async (account: ParentAccount): Promise<boolean> => {
    const rawBarcode = account.studentBarcode;
    if (!rawBarcode) return false;

    const cleanBarcode = normalizeBarcode(rawBarcode);
    const uuid = account.id || barcodeToUUID(cleanBarcode);
    const nowIso = new Date().toISOString();

    const dbPayload: any = {
      id: uuid,
      parent_phone: account.parentPhone || "",
      parent_name: account.parentName || "",
      student_name: account.studentName || "",
      password_hash: account.password || "1234",
      linked_student_barcodes:
        account.linkedBarcodes && account.linkedBarcodes.length > 0
          ? account.linkedBarcodes
          : [cleanBarcode],
      fcm_token: account.fcmToken || "",
      status: account.status || "active",
      created_at: account.createdAt || nowIso,
      updated_at: nowIso,
      activated_at: account.activatedAt || nowIso,
    };

    try {
      const { error } = await supabase
        .from("parent_accounts")
        .upsert(dbPayload, { onConflict: "id" });

      if (error) {
        console.warn("[useGlobalRealtimeSync] insertAccount mutation server error:", error.message);
        return false;
      }

      const normalizedAccount: ParentAccount = {
        ...account,
        id: uuid,
        studentBarcode: cleanBarcode,
        updatedAt: nowIso,
      };

      activeSubscribers.forEach((sub) => {
        if (sub.setAccounts) {
          sub.setAccounts((prevAccounts) => {
            const exists = prevAccounts.some((acc) => matchesAccount(acc, uuid));
            const next = exists
              ? prevAccounts.map((acc) => (matchesAccount(acc, uuid) ? normalizedAccount : acc))
              : [...prevAccounts, normalizedAccount];
            const cloned = [...next];
            syncLocalAccountsCache(cloned);
            return cloned;
          });
        }
        sub.onAccountInserted?.(normalizedAccount);
      });

      return true;
    } catch (err) {
      console.error("[useGlobalRealtimeSync] insertAccount exception:", err);
      return false;
    }
  }, []);

  const refreshAccounts = useCallback(async (): Promise<ParentAccount[]> => {
    try {
      const { data, error } = await supabase
        .from("parent_accounts")
        .select("*")
        .order("created_at", { ascending: false });

      if (error || !data) {
        return accounts;
      }

      const list: ParentAccount[] = [];
      const seen = new Set<string>();
      const tombstones = getDeletedTombstones();

      for (const row of data) {
        const acc = mapRowToAccount(row);
        if (acc && acc.studentBarcode) {
          const cleanB = normalizeBarcode(acc.studentBarcode);
          if (
            tombstones.has(cleanB) ||
            acc.status === "deleted" ||
            (Array.isArray(acc.linkedBarcodes) && acc.linkedBarcodes.some((lb) => tombstones.has(normalizeBarcode(lb))))
          ) {
            continue;
          }
          if (!seen.has(acc.studentBarcode)) {
            seen.add(acc.studentBarcode);
            list.push(acc);
          }
        }
      }

      setAccounts(list);
      syncLocalAccountsCache(list);
      return list;
    } catch (err) {
      console.warn("[useGlobalRealtimeSync] Error refreshing accounts:", err);
      return accounts;
    }
  }, [accounts, setAccounts]);

  return {
    accounts,
    accountsRecord,
    setAccounts,
    deleteAccount,
    updateAccount,
    insertAccount,
    refreshAccounts,
    isConnected,
    activeBarcode,
  };
}
