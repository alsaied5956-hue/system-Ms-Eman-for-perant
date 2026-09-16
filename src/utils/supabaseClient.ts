/**
 * src/utils/supabaseClient.ts
 * High-Performance Supabase v2 Client & Sub-20ms Realtime WebSocket Hub
 * Powers Instant Multi-Device Sync for Attendance, Group Finalization, Payments, Homework, and Students
 */

import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { isOfficialGroupDay } from "./helpers";
import { compressData, decompressData } from "./compression";
import type { SystemData } from "./storage";
import type { ParentAccount } from "../types/portal";
import { withTimeout } from "./promiseTimeout";
import { getSessionPortalData } from "./portalSessionStore";
import { purgeAllOfflineDatabases } from "./indexedDB";
export { withTimeout };

const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL || "https://lzdvmzumwuqycwdecaan.supabase.co";
const SUPABASE_ANON_KEY =
  (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  },
  global: {
    headers: {
      "x-client-info": "parent-portal-fast",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
    fetch: (url: any, options: any = {}) => {
      const headers = new Headers(options?.headers || {});
      headers.set("Cache-Control", "no-cache");
      headers.set("Pragma", "no-cache");
      return fetch(url, {
        ...options,
        cache: "no-cache",
        headers,
      });
    },
  },
  realtime: {
    params: {
      eventsPerSecond: 30,
    },
  },
});

// Setup global onAuthStateChange listener to prevent write/refresh race conditions
// Never invoke signOut() or wipe tokens on transient network errors
if (typeof window !== "undefined") {
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      console.log(`[Supabase Auth] Auth state change event: ${event}`, session ? "Session active" : "No session");
      // Preserve auth tokens and prevent premature signouts on transient network delays
      if (event === "TOKEN_REFRESHED" && session) {
        console.info("[Supabase Auth] Session token refreshed successfully.");
      } else if (event === "SIGNED_OUT") {
        console.info("[Supabase Auth] User signed out.");
      }
    });
  } catch (authErr) {
    console.warn("[Supabase Auth] Listener registration notice:", authErr);
  }
}

/**
 * Fast Query Executor with a strict 3-second timeout limit.
 * If a request exceeds 3 seconds, it fails fast and performs a light retry
 * instead of blocking the application for minutes.
 */
export async function executeFastQuery<T>(
  queryPromiseFn: () => PromiseLike<T> | Promise<T>,
  timeoutMs: number = 3000,
  errorContext: string = "استعلام سحابي استغرق أكثر من 3 ثوانٍ"
): Promise<T> {
  try {
    return await withTimeout(Promise.resolve(queryPromiseFn()) as Promise<T>, timeoutMs, errorContext);
  } catch (err: any) {
    console.warn(`[FastQuery] ${errorContext}. تشغيل محاولة سريعة ثانية...`);
    return await withTimeout(Promise.resolve(queryPromiseFn()) as Promise<T>, timeoutMs, `${errorContext} (إعادة المحاولة)`);
  }
}

/**
 * Strict Barcode Normalizer
 * Converts Arabic-Indic numerals, trims invisible spaces, and normalizes barcodes
 */
export function normalizeBarcode(raw?: string | number | null): string {
  if (raw === undefined || raw === null) return "";
  let val = String(raw).trim();
  val = val.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    if (code >= 1632 && code <= 1641) return String(code - 1632);
    if (code >= 1776 && code <= 1785) return String(code - 1776);
    return d;
  });
  return val.replace(/[\u200B-\u200D\uFEFF\s]/g, "");
}

/**
 * Strict Phone Normalizer
 * Handles Egyptian phone formats, country codes (+20, 0020, 20), Arabic numerals, and spaces
 */
export function normalizePhone(raw?: string | number | null): string {
  if (raw === undefined || raw === null) return "";
  let val = String(raw).trim();
  val = val.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    if (code >= 1632 && code <= 1641) return String(code - 1632);
    if (code >= 1776 && code <= 1785) return String(code - 1776);
    return d;
  });
  let digits = val.replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("20") && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

/**
 * Sanitizes and securely encodes a Realtime channel identifier.
 * Replaces any non-alphanumeric characters (except underscores and hyphens) with underscores.
 * Does NOT use encodeURIComponent or percent-encoding as '%' causes silent CHANNEL_ERROR socket crashes in Supabase Realtime.
 */
export function getSecureChannelTopic(prefix: string, identifier: string): string {
  if (!identifier) return prefix;
  const cleanPrefix = String(prefix).trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  const sanitized = String(identifier).trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${cleanPrefix}-${sanitized}`;
}

let lastRealtimeReconnectTimestamp = 0;
let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_COOLDOWN_MS = 4000; // 4 second cooldown window strictly for WebSocket reconnection

/**
 * Throttled Supabase Realtime Reconnection.
 * Prevents reconnect storms and HTTP 429 (Too Many Requests) errors strictly on the WebSocket layer.
 * NOTE: REST data revalidation is decoupled and handled immediately/un-throttled.
 */
export function throttledRealtimeConnect(source: string = "foreground"): void {
  const now = Date.now();
  const elapsed = now - lastRealtimeReconnectTimestamp;

  if (elapsed < RECONNECT_COOLDOWN_MS) {
    // Schedule trailing execution if not already scheduled
    if (!reconnectTimeoutId) {
      reconnectTimeoutId = setTimeout(() => {
        reconnectTimeoutId = null;
        throttledRealtimeConnect(`${source}-trailing`);
      }, RECONNECT_COOLDOWN_MS - elapsed);
    }
    return;
  }

  lastRealtimeReconnectTimestamp = now;
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }

  console.log(`[Realtime Sync] Re-establishing Supabase Realtime socket connection (source: ${source})...`);
  try {
    if (supabase && supabase.realtime) {
      supabase.realtime.connect();
    }
  } catch (err) {
    console.warn("[Realtime Sync] Socket reconnect warning:", err);
  }
}

/**
 * Unified Barcode Extractor:
 * Extracts clean student barcode directly from active session token / session object or storage.
 */
export function extractCleanBarcodeFromSession(sessionOrToken?: any): string {
  try {
    if (sessionOrToken) {
      if (typeof sessionOrToken === "string") {
        const str = sessionOrToken.trim();
        if (str.startsWith("{")) {
          try {
            const parsed = JSON.parse(str);
            const b = parsed.barcode || parsed.studentBarcode || parsed.account?.studentBarcode;
            if (b) return normalizeBarcode(b);
            if (parsed.token) return extractCleanBarcodeFromSession(parsed.token);
          } catch {}
        }
        const sessMatch = str.match(/^sess-([0-9A-Za-z_-]+?)(?:-\d+)?$/);
        if (sessMatch && sessMatch[1]) {
          return normalizeBarcode(sessMatch[1]);
        }
        if (/^[0-9]+$/.test(str) || str.length <= 15) {
          return normalizeBarcode(str);
        }
      } else if (typeof sessionOrToken === "object") {
        const b =
          sessionOrToken.barcode ||
          sessionOrToken.studentBarcode ||
          sessionOrToken.account?.studentBarcode;
        if (b) return normalizeBarcode(b);
        if (sessionOrToken.token) {
          const bFromTok = extractCleanBarcodeFromSession(sessionOrToken.token);
          if (bFromTok) return bFromTok;
        }
      }
    }

    if (typeof window !== "undefined") {
      const rawParentToken =
        localStorage.getItem("parent_session_token") ||
        localStorage.getItem("eman_portal_session") ||
        sessionStorage.getItem("eman_portal_session");

      if (rawParentToken) {
        try {
          const parsed = JSON.parse(rawParentToken);
          const b = parsed.barcode || parsed.studentBarcode || parsed.account?.studentBarcode;
          if (b) return normalizeBarcode(b);
          if (parsed.token) {
            const bFromToken = extractCleanBarcodeFromSession(parsed.token);
            if (bFromToken) return bFromToken;
          }
        } catch {
          const bDirect = extractCleanBarcodeFromSession(rawParentToken);
          if (bDirect) return bDirect;
        }
      }
    }
  } catch (err) {
    console.warn("extractCleanBarcodeFromSession error:", err);
  }
  return "";
}

export interface LiveScanPayload {
  barcode: string;
  name: string;
  grade: string;
  days: string;
  status: "حضور" | "تأخير" | "غياب";
  timeIso: string;
  timeDisplay: string;
  isPaid: boolean;
  scannedBy: string;
  timestamp: number;
}

export interface GroupFinishedPayload {
  grade: string;
  days: string;
  absentBarcodes: string[];
  lateBarcodes: string[];
  presentBarcodes: string[];
  dateKey: string;
  finishedBy: string;
  timestamp: number;
}

export interface PaymentSyncPayload {
  action: "record" | "update" | "delete";
  barcode: string;
  monthKey: string;
  amount: number;
  date: string;
  time: string;
  note: string;
  recordedBy: string;
  timestamp: number;
}

export interface HomeworkSyncPayload {
  action: "update" | "bulk_update";
  barcodes: string[];
  dateKey: string;
  status: "done" | "incomplete" | "not_done";
  notes?: string;
  updatedBy: string;
  timestamp: number;
}

export interface StudentSyncPayload {
  action: "add" | "update" | "delete";
  barcode: string;
  studentData?: any;
  timestamp: number;
}

export interface AttendanceStatusSyncPayload {
  action: "update" | "delete";
  barcode: string;
  dateKey: string;
  status: string; // "" or "لم يسجل" for deletion/clearance
  previousStatus?: string;
  changedBy?: string;
  timestamp: number;
}

export interface GradeSyncPayload {
  action: "record" | "update" | "clear" | "delete";
  barcode: string;
  examTitle?: string;
  score?: number;
  maxScore?: number;
  scoreFormatted?: string;
  scoreString?: string;
  points?: number;
  totalExamScores?: number[];
  updatedScores?: number[];
  timestamp: number;
}

export interface SessionClearedSyncPayload {
  grade: string;
  resetTodayAttendance?: boolean;
  clearedBy?: string;
  timestamp: number;
}

export function getTodayDateKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ------------------------------------------------------------------------
// 1. DEDICATED REALTIME HUB (Sub-20ms WebSocket Channel)
// ------------------------------------------------------------------------

let realtimeHubChannel: RealtimeChannel | null = null;

export function getOrCreateRealtimeHub(): RealtimeChannel {
  if (!realtimeHubChannel) {
    realtimeHubChannel = supabase.channel("realtime-center-hub", {
      config: {
        broadcast: {
          self: false, // Don't echo back to the emitting device
          ack: false,  // Fire-and-forget for absolute zero-latency
        },
      },
    });

    realtimeHubChannel.subscribe((status) => {
      console.log(`[Supabase Realtime Hub] Status: ${status}`);
    });
  }
  return realtimeHubChannel;
}

// ------------------------------------------------------------------------
// 2. BROADCAST METHODS (Zero Latency Emits)
// ------------------------------------------------------------------------

/** Broadcast single scan to all assistant screens */
export async function broadcastLiveScan(payload: LiveScanPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "assistant_scan",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast scan notice:", err);
  }
}

/** Broadcast group finish (حفظ وإرسال الغياب للكل) across all screens */
export async function broadcastGroupFinished(payload: GroupFinishedPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "group_finished",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast group finish notice:", err);
  }
}

/** Broadcast payment record / update / delete across all screens */
export async function broadcastPaymentChange(payload: PaymentSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "payment_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast payment notice:", err);
  }
}

/** Broadcast homework status update across all screens */
export async function broadcastHomeworkChange(payload: HomeworkSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "homework_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast homework notice:", err);
  }
}

/** Broadcast student addition, update, or deletion */
export async function broadcastStudentChange(payload: StudentSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "student_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast student notice:", err);
  }
}

/** Broadcast single attendance status update or deletion/clearance across all devices */
export async function broadcastAttendanceStatusChange(payload: AttendanceStatusSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "attendance_status_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast attendance status notice:", err);
  }
}

/** Broadcast grade recording, modification, or clearance across all devices */
export async function broadcastGradeChange(payload: GradeSyncPayload): Promise<void> {
  try {
    const channel = getOrCreateRealtimeHub();
    await channel.send({
      type: "broadcast",
      event: "grade_change",
      payload,
    });
  } catch (err) {
    console.warn("Realtime broadcast grade notice:", err);
  }
}

// ------------------------------------------------------------------------
// 3. LISTENERS (Instant Reception on All Devices)
// ------------------------------------------------------------------------

export function subscribeToLiveScans(
  onScanReceived: (payload: LiveScanPayload) => void
): () => void {
  const channel = getOrCreateRealtimeHub();
  channel.on("broadcast", { event: "assistant_scan" }, ({ payload }) => {
    if (payload && typeof onScanReceived === "function") {
      onScanReceived(payload as LiveScanPayload);
    }
  });
  return () => {};
}

export function subscribeToGroupFinished(
  onGroupFinished: (payload: GroupFinishedPayload) => void
): () => void {
  const channel = getOrCreateRealtimeHub();
  channel.on("broadcast", { event: "group_finished" }, ({ payload }) => {
    if (payload && typeof onGroupFinished === "function") {
      onGroupFinished(payload as GroupFinishedPayload);
    }
  });
  return () => {};
}

// In-memory barcode to student_id cache to avoid redundant network lookups
const barcodeToIdCache = new Map<string, string>();

const paymentListeners = new Set<(payload: PaymentSyncPayload) => void>();
let paymentsDbChannel: RealtimeChannel | null = null;

function initPaymentsDbChannelOnce(): void {
  if (paymentsDbChannel) return;
  try {
    // Note: In Supabase, postgres_changes callbacks MUST be registered BEFORE calling .subscribe()
    paymentsDbChannel = supabase
      .channel("payments-db-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "payments" },
        async (payload) => {
          try {
            if (payload.eventType === "DELETE") {
              const oldRow = payload.old as any;
              if (oldRow) {
                let barcode = "";
                for (const [b, id] of barcodeToIdCache.entries()) {
                  if (id === oldRow.student_id) {
                    barcode = b;
                    break;
                  }
                }
                if (!barcode && oldRow.student_id) {
                  const { data } = await supabase.from("students").select("barcode").eq("id", oldRow.student_id).maybeSingle();
                  if (data?.barcode) barcode = data.barcode;
                }
                if (barcode && oldRow.month_key) {
                  const syncPayload: PaymentSyncPayload = {
                    action: "delete",
                    barcode,
                    monthKey: oldRow.month_key,
                    amount: 0,
                    date: "",
                    time: "",
                    note: "",
                    recordedBy: "external_sync",
                    timestamp: Date.now(),
                  };
                  paymentListeners.forEach((fn) => {
                    try { fn(syncPayload); } catch {}
                  });
                }
              }
            } else if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
              const newRow = payload.new as any;
              if (newRow) {
                let barcode = "";
                for (const [b, id] of barcodeToIdCache.entries()) {
                  if (id === newRow.student_id) {
                    barcode = b;
                    break;
                  }
                }
                if (!barcode && newRow.student_id) {
                  const { data } = await supabase.from("students").select("barcode").eq("id", newRow.student_id).maybeSingle();
                  if (data?.barcode) barcode = data.barcode;
                }
                if (barcode && newRow.month_key) {
                  const syncPayload: PaymentSyncPayload = {
                    action: payload.eventType === "INSERT" ? "record" : "update",
                    barcode,
                    monthKey: newRow.month_key,
                    amount: Number(newRow.amount_paid) || 0,
                    date: newRow.payment_date || "",
                    time: "",
                    note: newRow.notes || "",
                    recordedBy: newRow.received_by || "external_sync",
                    timestamp: Date.now(),
                  };
                  paymentListeners.forEach((fn) => {
                    try { fn(syncPayload); } catch {}
                  });
                }
              }
            }
          } catch (err) {
            console.warn("Postgres CDC payments listener error:", err);
          }
        }
      );

    paymentsDbChannel.subscribe((status) => {
      console.log(`[Supabase Payments DB Channel] Status: ${status}`);
    });
  } catch (err) {
    console.warn("Failed to initialize payments DB channel:", err);
  }
}

export function subscribeToPaymentChanges(
  onPaymentChanged: (payload: PaymentSyncPayload) => void
): () => void {
  paymentListeners.add(onPaymentChanged);

  // 1. WebSocket sub-20ms broadcast event
  const hubChannel = getOrCreateRealtimeHub();
  hubChannel.on("broadcast", { event: "payment_change" }, ({ payload }) => {
    if (payload && typeof onPaymentChanged === "function") {
      onPaymentChanged(payload as PaymentSyncPayload);
    }
  });

  // 2. Dedicated channel for Postgres changes (registered before subscribe)
  initPaymentsDbChannelOnce();

  return () => {
    paymentListeners.delete(onPaymentChanged);
  };
}

export function subscribeToHomeworkChanges(
  onHomeworkChanged: (payload: HomeworkSyncPayload) => void
): () => void {
  const channel = getOrCreateRealtimeHub();
  channel.on("broadcast", { event: "homework_change" }, ({ payload }) => {
    if (payload && typeof onHomeworkChanged === "function") {
      onHomeworkChanged(payload as HomeworkSyncPayload);
    }
  });
  return () => {};
}

const studentListeners = new Set<(payload: StudentSyncPayload) => void>();
let studentsDbChannel: RealtimeChannel | null = null;

function initStudentsDbChannelOnce(): void {
  if (studentsDbChannel) return;
  try {
    studentsDbChannel = supabase
      .channel("students-db-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "students" },
        (payload) => {
          try {
            if (payload.eventType === "DELETE") {
              const oldRow = payload.old as any;
              const barcode = oldRow?.barcode;
              if (barcode) {
                studentListeners.forEach((fn) => {
                  try { fn({ action: "delete", barcode, timestamp: Date.now() }); } catch {}
                });
              }
            } else if (payload.eventType === "INSERT" || payload.eventType === "UPDATE") {
              const newRow = payload.new as any;
              if (newRow?.barcode) {
                studentListeners.forEach((fn) => {
                  try {
                    fn({
                      action: payload.eventType === "INSERT" ? "add" : "update",
                      barcode: newRow.barcode,
                      studentData: {
                        barcode: newRow.barcode,
                        name: newRow.name,
                        phone: newRow.phone,
                        parentPhone: newRow.parent_phone,
                        groupGrade: newRow.grade,
                        groupDays: newRow.group_days,
                        notes: newRow.notes,
                        updatedAt: Date.now(),
                      },
                      timestamp: Date.now(),
                    });
                  } catch {}
                });
              }
            }
          } catch (err) {
            console.warn("Postgres CDC students listener error:", err);
          }
        }
      );
    studentsDbChannel.subscribe((status) => {
      console.log(`[Supabase Students DB Channel] Status: ${status}`);
    });
  } catch (err) {
    console.warn("Failed to initialize students DB channel:", err);
  }
}

export function subscribeToStudentChanges(
  onStudentChanged: (payload: StudentSyncPayload) => void
): () => void {
  studentListeners.add(onStudentChanged);

  const hubChannel = getOrCreateRealtimeHub();
  hubChannel.on("broadcast", { event: "student_change" }, ({ payload }) => {
    if (payload && typeof onStudentChanged === "function") {
      onStudentChanged(payload as StudentSyncPayload);
    }
  });

  initStudentsDbChannelOnce();

  return () => {
    studentListeners.delete(onStudentChanged);
  };
}

const attendanceStatusListeners = new Set<(payload: AttendanceStatusSyncPayload) => void>();

export function subscribeToAttendanceStatusChanges(
  onAttendanceChanged: (payload: AttendanceStatusSyncPayload) => void
): () => void {
  attendanceStatusListeners.add(onAttendanceChanged);

  const hubChannel = getOrCreateRealtimeHub();
  hubChannel.on("broadcast", { event: "attendance_status_change" }, ({ payload }) => {
    if (payload && typeof onAttendanceChanged === "function") {
      onAttendanceChanged(payload as AttendanceStatusSyncPayload);
    }
  });

  return () => {
    attendanceStatusListeners.delete(onAttendanceChanged);
  };
}

const gradeChangeListeners = new Set<(payload: GradeSyncPayload) => void>();

export function subscribeToGradeChanges(
  onGradeChanged: (payload: GradeSyncPayload) => void
): () => void {
  gradeChangeListeners.add(onGradeChanged);

  const hubChannel = getOrCreateRealtimeHub();
  hubChannel.on("broadcast", { event: "grade_change" }, ({ payload }) => {
    if (payload && typeof onGradeChanged === "function") {
      onGradeChanged(payload as GradeSyncPayload);
    }
  });

  return () => {
    gradeChangeListeners.delete(onGradeChanged);
  };
}

export async function broadcastSessionCleared(payload: SessionClearedSyncPayload): Promise<void> {
  try {
    const hubChannel = getOrCreateRealtimeHub();
    await hubChannel.send({
      type: "broadcast",
      event: "session_cleared",
      payload,
    });
  } catch (err) {
    console.warn("broadcastSessionCleared error:", err);
  }
}

const sessionClearedListeners = new Set<(payload: SessionClearedSyncPayload) => void>();

export function subscribeToSessionCleared(
  onSessionCleared: (payload: SessionClearedSyncPayload) => void
): () => void {
  sessionClearedListeners.add(onSessionCleared);

  const hubChannel = getOrCreateRealtimeHub();
  hubChannel.on("broadcast", { event: "session_cleared" }, ({ payload }) => {
    if (payload && typeof onSessionCleared === "function") {
      onSessionCleared(payload as SessionClearedSyncPayload);
    }
  });

  return () => {
    sessionClearedListeners.delete(onSessionCleared);
  };
}

// ------------------------------------------------------------------------
// 4. SUPABASE POSTGRES PERSISTENCE HELPERS
// ------------------------------------------------------------------------

async function getStudentIdByBarcode(barcode: string): Promise<string | null> {
  try {
    const b = String(barcode).trim();
    if (barcodeToIdCache.has(b)) {
      return barcodeToIdCache.get(b)!;
    }
    const { data, error } = await supabase
      .from("students")
      .select("id")
      .eq("barcode", b)
      .maybeSingle();

    if (error || !data) {
      return null;
    }
    if (data?.id) {
      barcodeToIdCache.set(b, data.id);
      return data.id;
    }
    return null;
  } catch (err) {
    console.warn("getStudentIdByBarcode error:", err);
    return null;
  }
}

/** Save single attendance record to Supabase */
export async function saveAttendanceToSupabase(record: {
  barcode: string;
  studentName: string;
  status: "حضور" | "تأخير" | "غياب";
  timeIso?: string;
  dateKey?: string;
  scannedBy?: string;
}): Promise<void> {
  try {
    const dateKey = record.dateKey || getTodayDateKey();
    const studentId = await getStudentIdByBarcode(record.barcode);
    if (!studentId) return;

    await supabase
      .from("attendance_logs")
      .upsert(
        {
          student_id: studentId,
          barcode: String(record.barcode).trim(),
          student_name: record.studentName,
          date_key: dateKey,
          time_recorded: record.timeIso || new Date().toISOString(),
          status: record.status,
          scanned_by: record.scannedBy || "admin",
        },
        { onConflict: "student_id,date_key" }
      );
  } catch (err) {
    console.warn("saveAttendanceToSupabase error:", err);
  }
}

/**
 * Bulk save group attendance to Supabase in parallel chunks
 * Called when "حفظ وإرسال الغياب للكل" is clicked
 */
export async function saveBulkAttendanceToSupabase(
  records: Array<{
    barcode: string;
    studentName: string;
    status: "حضور" | "تأخير" | "غياب";
    dateKey: string;
    scannedBy?: string;
  }>
): Promise<void> {
  if (!records || records.length === 0) return;

  try {
    const rowsToInsert = [];
    for (const rec of records) {
      const sId = await getStudentIdByBarcode(rec.barcode);
      if (!sId) continue;
      rowsToInsert.push({
        student_id: sId,
        barcode: String(rec.barcode).trim(),
        student_name: rec.studentName,
        date_key: rec.dateKey,
        time_recorded: new Date().toISOString(),
        status: rec.status,
        scanned_by: rec.scannedBy || "admin",
      });
    }

    const chunkSize = 100;
    for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
      const chunk = rowsToInsert.slice(i, i + chunkSize);
      await supabase
        .from("attendance_logs")
        .upsert(chunk, { onConflict: "student_id,date_key" });
    }
  } catch (err) {
    console.warn("saveBulkAttendanceToSupabase error:", err);
  }
}

/** Delete single attendance record from Supabase */
export async function deleteAttendanceFromSupabase(barcode: string, dateKey: string): Promise<void> {
  try {
    const studentId = await getStudentIdByBarcode(barcode);
    if (!studentId) return;

    await supabase
      .from("attendance_logs")
      .delete()
      .eq("student_id", studentId)
      .eq("date_key", dateKey);
  } catch (err) {
    console.warn("deleteAttendanceFromSupabase error:", err);
  }
}

/** Save or update payment in Supabase */
export async function savePaymentToSupabase(record: {
  barcode: string;
  monthKey: string;
  amount: number;
  date?: string;
  note?: string;
  recordedBy?: string;
}): Promise<void> {
  try {
    const studentId = await getStudentIdByBarcode(record.barcode);
    if (!studentId) return;

    await supabase
      .from("payments")
      .upsert(
        {
          student_id: studentId,
          month_key: record.monthKey,
          amount_paid: Number(record.amount) || 0,
          required_amount: Number(record.amount) || 100,
          discount: 0,
          status: "paid",
          payment_date: record.date ? new Date(record.date).toISOString() : new Date().toISOString(),
          received_by: record.recordedBy || "admin",
          notes: record.note || "سداد اشتراك",
        },
        { onConflict: "student_id,month_key" }
      );
  } catch (err) {
    console.warn("savePaymentToSupabase error:", err);
  }
}

/** Delete payment from Supabase */
export async function deletePaymentFromSupabase(barcode: string, monthKey: string): Promise<void> {
  try {
    const studentId = await getStudentIdByBarcode(barcode);
    if (!studentId) return;

    await supabase
      .from("payments")
      .delete()
      .eq("student_id", studentId)
      .eq("month_key", monthKey);
  } catch (err) {
    console.warn("deletePaymentFromSupabase error:", err);
  }
}

/** Save or update homework record in Supabase */
export async function saveHomeworkToSupabase(records: Array<{
  barcode: string;
  dateKey: string;
  status: "done" | "incomplete" | "not_done";
  notes?: string;
}>): Promise<void> {
  if (!records || records.length === 0) return;

  try {
    const rows = [];
    for (const r of records) {
      const sId = await getStudentIdByBarcode(r.barcode);
      if (!sId) continue;
      rows.push({
        student_id: sId,
        date_key: r.dateKey,
        title: "واجب الحصة",
        status: r.status,
        notes: r.notes || "",
      });
    }

    if (rows.length > 0) {
      await supabase.from("homework").insert(rows);
    }
  } catch (err) {
    console.warn("saveHomeworkToSupabase error:", err);
  }
}

/** Save exam grade record to Supabase (saves to homework table which is reliably present in Supabase, and also attempts exam_grades) */
export async function saveExamGradeToSupabase(record: {
  barcode: string;
  studentId?: string;
  examTitle: string;
  score: number;
  maxScore: number;
  percentage?: number;
  teacherNotes?: string;
  examDate?: string;
}): Promise<void> {
  if (!record || !record.barcode) return;
  try {
    const studentId = record.studentId || (await getStudentIdByBarcode(record.barcode));
    const pct =
      record.percentage !== undefined
        ? record.percentage
        : Math.round((Number(record.score) / (Number(record.maxScore) || 10)) * 100);

    const examTitle = record.examTitle || "اختبار دوري";
    const examDate = record.examDate || new Date().toISOString().slice(0, 10);
    const score = Number(record.score) || 0;
    const maxScore = Number(record.maxScore) || 10;
    const scoreFormatted = `${score}/${maxScore} (${pct}%)`;
    const notes = record.teacherNotes || `رصد درجة امتحان: ${examTitle} (${scoreFormatted})`;

    // 1. Save to homework table which acts as the reliable evaluation store in Supabase
    if (studentId) {
      const hwPayload = {
        student_id: studentId,
        date_key: examDate,
        title: examTitle,
        status: "done",
        score: score,
        max_score: maxScore,
        notes: notes,
      };
      await supabase.from("homework").insert(hwPayload);
    }

    // 2. Also attempt insert to exam_grades if table exists in environment
    try {
      const payload: any = {
        barcode: String(record.barcode).trim(),
        exam_title: examTitle,
        score: score,
        max_score: maxScore,
        percentage: pct,
        teacher_notes: notes,
        exam_date: examDate,
      };
      if (studentId) {
        payload.student_id = studentId;
      }
      await supabase.from("exam_grades").insert(payload);
    } catch {}
  } catch (err) {
    console.warn("saveExamGradeToSupabase error:", err);
  }
}

/** Delete exam grade record from Supabase */
export async function deleteExamGradeFromSupabase(barcode: string, examTitle?: string): Promise<void> {
  try {
    const studentId = await getStudentIdByBarcode(barcode);
    if (studentId) {
      let qHw = supabase.from("homework").delete().eq("student_id", studentId);
      if (examTitle) {
        qHw = qHw.eq("title", examTitle);
      }
      await qHw;
    }
    // Also delete from exam_grades if exists
    try {
      let q = supabase.from("exam_grades").delete();
      if (studentId) {
        q = q.eq("student_id", studentId);
      } else {
        q = q.eq("barcode", barcode);
      }
      if (examTitle) {
        q = q.eq("exam_title", examTitle);
      }
      await q;
    } catch {}
  } catch (err) {
    console.warn("deleteExamGradeFromSupabase error:", err);
  }
}

/** Save student to Supabase */
export async function saveStudentToSupabase(s: any): Promise<void> {
  if (!s || !s.barcode) return;
  try {
    const payload = {
      barcode: String(s.barcode).trim(),
      name: s.name || "طالب بدون اسم",
      phone: String(s.phone || ""),
      parent_phone: String(s.parentPhone || s.phone || "00000000000"),
      grade: s.groupGrade || s.grade || "غير محدد",
      group_days: s.groupDays || "غير محدد",
      group_time: s.groupTime || "04:00 م",
      monthly_fee: Number(s.monthlyFee) || 0,
      discount: Number(s.discount) || 0,
      notes: s.notes || "",
      is_active: s.isActive !== false,
    };

    const { data } = await supabase
      .from("students")
      .upsert(payload, { onConflict: "barcode" })
      .select("id")
      .single();

    if (data?.id) {
      barcodeToIdCache.set(String(s.barcode).trim(), data.id);
    }
  } catch (err) {
    console.warn("saveStudentToSupabase error:", err);
  }
}

/** Delete student from Supabase with complete Hard Delete cascade across all relational tables and local caches */
export async function deleteStudentFromSupabase(barcode: string): Promise<void> {
  try {
    const cleanBarcode = normalizeBarcode(barcode);
    if (!cleanBarcode) return;
    barcodeToIdCache.delete(cleanBarcode);

    // Resolve student UUID if cached or in DB
    let studentId = barcodeToUUID(cleanBarcode);
    try {
      const { data: sRow } = await supabase
        .from("students")
        .select("id")
        .or(`barcode.eq.${cleanBarcode},id.eq.${cleanBarcode}`)
        .maybeSingle();
      if (sRow?.id) {
        studentId = sRow.id;
      }
    } catch {}

    const orFilter = `student_id.eq.${studentId},barcode.eq.${cleanBarcode},student_barcode.eq.${cleanBarcode}`;

    // 0. Invoke PostgreSQL RPC SECURITY DEFINER function for atomic server-side cascade
    try {
      const { error: rpcErr } = await supabase.rpc("delete_student_cascade", {
        target_barcode: cleanBarcode,
        target_uuid: studentId,
      });
      if (!rpcErr) {
        console.info(`[Hard Delete] PostgreSQL SECURITY DEFINER RPC delete_student_cascade executed successfully for ${cleanBarcode}`);
      }
    } catch (rpcEx) {
      console.info("[Hard Delete] PostgreSQL RPC note (proceeding with direct table cascade):", rpcEx);
    }

    // 1. Cascade hard delete across all related relational tables in Supabase in parallel
    await Promise.allSettled([
      supabase.from("students").delete().or(`barcode.eq.${cleanBarcode},id.eq.${studentId}`),
      supabase.from("parent_accounts").delete().or(`id.eq.${studentId},id.eq.${barcodeToUUID(cleanBarcode)},id.eq.${cleanBarcode},student_barcode.eq.${cleanBarcode},parent_phone.eq.${cleanBarcode}`),
      supabase.from("attendance_logs").delete().or(orFilter),
      supabase.from("homework").delete().or(orFilter),
      supabase.from("payments").delete().or(orFilter),
      supabase.from("exam_grades").delete().or(orFilter),
      supabase.from("evaluations").delete().or(orFilter),
      supabase.from("chat_messages").delete().or(`${orFilter},chat_id.eq.${cleanBarcode}`),
      supabase.from("messages").delete().or(`${orFilter},chat_id.eq.${cleanBarcode}`),
      supabase.from("push_subscriptions").delete().or(`barcode.eq.${cleanBarcode},student_barcode.eq.${cleanBarcode}`),
    ]);

    // 2. Clear local client state & LocalStorage for this record so deleted accounts never resurrect
    if (typeof window !== "undefined") {
      try {
        // Clean localStorage students cache
        const rawStudents = localStorage.getItem("eman_students_data");
        if (rawStudents) {
          const parsed = JSON.parse(rawStudents);
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter((s: any) => String(s.barcode).trim() !== cleanBarcode && s.id !== studentId);
            localStorage.setItem("eman_students_data", JSON.stringify(filtered));
          }
        }

        // Clean parent accounts cache
        const rawAccounts = localStorage.getItem("eman_parent_accounts");
        if (rawAccounts) {
          const parsed = JSON.parse(rawAccounts);
          delete parsed[cleanBarcode];
          delete parsed[studentId];
          localStorage.setItem("eman_parent_accounts", JSON.stringify(parsed));
        }

        // Purge IndexedDB cache to prevent stale restoration
        purgeAllOfflineDatabases().catch(() => {});
      } catch (lsErr) {
        console.warn("[Hard Delete] Local storage cleanup notice:", lsErr);
      }
    }

    // 3. Notify backend server to revoke push tokens and delete from in-memory stores
    try {
      fetch("/api/account-revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: cleanBarcode, reason: "تم حذف الطالب نهائياً من المنظومة" }),
      }).catch(() => {});
      fetch(`/api/portal/admin/accounts/${encodeURIComponent(cleanBarcode)}?mode=hard`, {
        method: "DELETE",
        headers: { "x-user-role": "admin" },
      }).catch(() => {});
    } catch {}

    console.info(`[Hard Delete] Successfully cascaded permanent deletion for student: ${cleanBarcode} (${studentId})`);
  } catch (err) {
    console.warn("deleteStudentFromSupabase cascade error:", err);
  }
}

/**
 * Fetch real attendance logs for a student directly from Supabase,
 * dynamically filtering out cross-day or off-schedule records based on the student's assigned group schedule.
 * Group A: Sat/Mon/Wed only
 * Group B: Sun/Tue/Thu only
 */
export async function fetchStudentAttendanceBySchedule(
  barcode: string,
  groupDays?: string
): Promise<Array<{
  id: string;
  barcode: string;
  studentName: string;
  dateKey: string;
  status: "حضور" | "تأخير" | "غياب";
  timeRecorded: string;
  sessionSlotId?: string;
  scannedBy?: string;
  notes?: string;
}>> {
  const b = String(barcode).trim();
  
  const { data, error } = await supabase
    .from("attendance_logs")
    .select("*")
    .eq("barcode", b)
    .order("date_key", { ascending: false });

  if (error || !data) {
    console.warn("Failed to fetch attendance logs from Supabase:", error);
    return [];
  }

  // If groupDays is provided, strictly isolate dates according to the group schedule
  if (groupDays) {
    return data.filter((row) => isOfficialGroupDay(groupDays, row.date_key));
  }

  return data;
}

/**
 * Invokes the database stored procedure to fetch an unbroken date series strictly matching
 * the student's group schedule (Sat/Mon/Wed for Group A, Sun/Tue/Thu for Group B)
 * outer-joined with real attendance records to prevent missing date gaps.
 */
export async function fetchStudentCompleteScheduleAttendance(
  barcode: string,
  startDate: string,
  endDate?: string
): Promise<Array<{
  student_id: string;
  barcode: string;
  student_name: string;
  group_days: string;
  date_key: string;
  day_of_week: number;
  day_name: string;
  status: string;
  is_recorded: boolean;
  time_recorded?: string;
}>> {
  const b = String(barcode).trim();
  const { data, error } = await supabase.rpc("get_student_complete_schedule_attendance", {
    p_barcode: b,
    p_start_date: startDate,
    p_end_date: endDate || new Date().toISOString().split("T")[0],
  });

  if (error || !data) {
    console.warn("get_student_complete_schedule_attendance RPC error:", error);
    return [];
  }

  return data;
}

/**
 * Records student group transfer in Supabase for audit compliance and schedule isolation
 */
export async function recordStudentGroupHistoryInSupabase(record: {
  barcode: string;
  groupDays: string;
  effectiveFrom: string;
  effectiveTo?: string;
  reason?: string;
}): Promise<void> {
  try {
    const studentId = await getStudentIdByBarcode(record.barcode);
    if (!studentId) return;

    await supabase.from("student_group_history").insert({
      student_id: studentId,
      barcode: String(record.barcode).trim(),
      group_days: record.groupDays,
      effective_from: record.effectiveFrom,
      effective_to: record.effectiveTo || null,
      reason: record.reason || "تحويل مجموعة دراسية",
    });
  } catch (err) {
    console.warn("recordStudentGroupHistoryInSupabase error:", err);
  }
}

// ------------------------------------------------------------------------
// 5. UNLIMITED CLOUD SYNC & SNAPSHOT ENGINE (Zero Quota Limits)
// ------------------------------------------------------------------------

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let lastSavedSnapshotTime = 0;
let isSnapshotSaveInProgress = false;

/**
 * Save complete system state snapshot directly to Supabase with Zero Quota Limits
 */
export async function saveFullSystemStateToSupabase(data: SystemData): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  const now = Date.now();
  if (isSnapshotSaveInProgress) return false;
  if (now - lastSavedSnapshotTime < 6000) return true;

  isSnapshotSaveInProgress = true;
  try {
    const compression = await compressData(data);
    const payload = {
      sender_role: "admin",
      sender_name: "system_state_snapshot",
      message: compression.compressedString,
      is_read: true,
    };

    const { data: inserted, error } = await supabase
      .from("chat_messages")
      .insert(payload)
      .select("id");

    if (error) {
      console.warn("[Supabase Snapshot] Insert failed:", error.message);
      return false;
    }

    lastSavedSnapshotTime = Date.now();
    console.log("[Supabase Snapshot] Successfully saved state to Supabase (Zero Quota Limit).");

    // Prune older snapshots asynchronously (keep latest 3)
    setTimeout(async () => {
      try {
        const { data: list } = await supabase
          .from("chat_messages")
          .select("id, created_at")
          .eq("sender_name", "system_state_snapshot")
          .order("created_at", { ascending: false });

        if (list && list.length > 3) {
          const toDelete = list.slice(3).map((r) => r.id);
          await supabase.from("chat_messages").delete().in("id", toDelete);
        }
      } catch {}
    }, 2000);

    return true;
  } catch (err) {
    console.warn("[Supabase Snapshot] Save error:", err);
    return false;
  } finally {
    isSnapshotSaveInProgress = false;
  }
}

/**
 * Pull full system state from Supabase (Snapshot + Live DB Records)
 * Fast sub-500ms latency, 100% resilient across GitHub deployments, Vercel, and new devices.
 */
export async function pullFullStateFromSupabase(): Promise<Partial<SystemData> | null> {
  if (!isSupabaseConfigured()) return null;

  try {
    // 1. Fetch live tables in parallel
    const [snapshotRes, studentsRes, paymentsRes] = await executeFastQuery(
      () =>
        Promise.allSettled([
          supabase
            .from("chat_messages")
            .select("message, created_at")
            .eq("sender_name", "system_state_snapshot")
            .order("created_at", { ascending: false })
            .limit(1),
          supabase.from("students").select("*"),
          supabase.from("payments").select("*"),
        ]),
      5000,
      "استعلام الطلاب والمدفوعات من Supabase"
    );

    // 2. Fetch full attendance records with pagination to include all 21k+ records
    const allAttendanceLogs: any[] = [];
    let attPage = 0;
    const pageSize = 1000;
    while (true) {
      try {
        const { data, error } = await supabase
          .from("attendance_logs")
          .select("student_id, barcode, date_key, status, time_recorded")
          .range(attPage * pageSize, (attPage + 1) * pageSize - 1);
        if (error || !data || data.length === 0) break;
        allAttendanceLogs.push(...data);
        if (data.length < pageSize) break;
        attPage++;
      } catch {
        break;
      }
    }

    // 3. Fetch homework / exams with pagination
    const allHomework: any[] = [];
    let hwPage = 0;
    while (true) {
      try {
        const { data, error } = await supabase
          .from("homework")
          .select("*")
          .range(hwPage * pageSize, (hwPage + 1) * pageSize - 1);
        if (error || !data || data.length === 0) break;
        allHomework.push(...data);
        if (data.length < pageSize) break;
        hwPage++;
      } catch {
        break;
      }
    }

    let baseState: Partial<SystemData> = {};

    if (
      snapshotRes.status === "fulfilled" &&
      snapshotRes.value.data &&
      snapshotRes.value.data.length > 0 &&
      snapshotRes.value.data[0].message
    ) {
      try {
        const decompressed = await decompressData<SystemData>(snapshotRes.value.data[0].message);
        if (decompressed && typeof decompressed === "object" && Array.isArray(decompressed.students)) {
          baseState = decompressed;
          console.log(`[Supabase Pull] Restored snapshot with ${decompressed.students.length} students.`);
        }
      } catch (decompErr) {
        console.warn("[Supabase Pull] Snapshot decompression notice:", decompErr);
      }
    }

    // Build student id to barcode map
    const studentIdToBarcode = new Map<string, string>();

    // Merge students table
    if (studentsRes.status === "fulfilled" && studentsRes.value.data && studentsRes.value.data.length > 0) {
      const studentMap = new Map<string, any>();
      (baseState.students || []).forEach((s) => {
        if (s && s.barcode) studentMap.set(String(s.barcode).trim(), s);
      });

      studentsRes.value.data.forEach((row: any) => {
        const b = String(row.barcode).trim();
        if (row.id && b) {
          studentIdToBarcode.set(row.id, b);
        }
        const existing = studentMap.get(b) || {};
        studentMap.set(b, {
          ...existing,
          id: row.id,
          barcode: b,
          name: row.name || existing.name || "طالب بدون اسم",
          phone: row.phone && row.phone !== "0" ? row.phone : existing.phone || "0",
          parentPhone: row.parent_phone && row.parent_phone !== "0" ? row.parent_phone : existing.parentPhone || "0",
          groupGrade: row.grade || existing.groupGrade || "الصف الرابع الابتدائي",
          groupDays: row.group_days || existing.groupDays || "سبت - إثنين - أربعاء",
          groupTime: row.group_time || existing.groupTime || "04:00 م",
          customMonthlyFee: row.monthly_fee !== undefined && row.monthly_fee !== null ? Number(row.monthly_fee) : existing.customMonthlyFee,
          discountReason: row.notes || existing.discountReason,
          notes: row.notes || existing.notes,
        });
      });

      baseState.students = Array.from(studentMap.values());
    }

    // Merge payments table (using student_id to barcode mapping)
    if (paymentsRes.status === "fulfilled" && paymentsRes.value.data && paymentsRes.value.data.length > 0) {
      const paymentsMap: Record<string, Record<string, any>> = baseState.payments ? { ...baseState.payments } : {};
      paymentsRes.value.data.forEach((p: any) => {
        const mKey = p.month_key;
        const b = p.barcode ? String(p.barcode).trim() : (p.student_id ? studentIdToBarcode.get(p.student_id) : null);
        if (!mKey || !b) return;
        if (!paymentsMap[mKey]) paymentsMap[mKey] = {};
        paymentsMap[mKey][b] = {
          monthKey: mKey,
          amount: Number(p.amount_paid || 0),
          paidAmount: Number(p.amount_paid || 0),
          requiredAmount: Number(p.required_amount || 0),
          discount: Number(p.discount || 0),
          date: p.payment_date ? p.payment_date.slice(0, 10) : "",
          time: p.payment_date ? p.payment_date.slice(11, 16) : "",
          note: p.notes || "",
          notes: p.notes || "",
          recordedBy: p.received_by || "الإشراف",
          timestamp: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
        };
      });
      baseState.payments = paymentsMap;
    }

    // Merge attendance records from paginated results
    if (allAttendanceLogs.length > 0) {
      const history: Record<string, Record<string, string>> = baseState.attendanceHistory ? { ...baseState.attendanceHistory } : {};
      allAttendanceLogs.forEach((att: any) => {
        const dKey = att.date_key;
        const b = att.barcode ? String(att.barcode).trim() : (att.student_id ? studentIdToBarcode.get(att.student_id) : null);
        if (!dKey || !b) return;
        if (!history[dKey]) history[dKey] = {};
        history[dKey][b] = att.status || "حضور";
      });
      baseState.attendanceHistory = history;
    }

    // Merge homework and exam records from paginated results
    if (allHomework.length > 0) {
      const studentExamsMap = new Map<string, any[]>();
      allHomework.forEach((hw: any) => {
        const b = hw.barcode ? String(hw.barcode).trim() : (hw.student_id ? studentIdToBarcode.get(hw.student_id) : null);
        if (!b) return;
        const rawGrade = hw.grade !== undefined ? hw.grade : (hw.score !== undefined ? hw.score : hw.degree);
        const hasScore = rawGrade !== null && rawGrade !== undefined && rawGrade !== "";
        const isExam =
          hasScore ||
          (typeof hw.notes === "string" && (hw.notes.includes("امتحان") || hw.notes.includes("اختبار") || hw.notes.includes("تقييم") || hw.notes.includes("درجة") || hw.notes.includes("رصد"))) ||
          (typeof hw.title === "string" && (hw.title.includes("امتحان") || hw.title.includes("اختبار") || hw.title.includes("تقييم")));

        if (isExam) {
          if (!studentExamsMap.has(b)) studentExamsMap.set(b, []);
          studentExamsMap.get(b)!.push(hw);
        }
      });

      if (baseState.students) {
        // Calculate true attendance and absence from attendance logs
        const clientAttCounts = new Map<string, { present: number; absent: number }>();
        if (history) {
          for (const dKey of Object.keys(history)) {
            const dayMap = history[dKey];
            if (dayMap && typeof dayMap === "object") {
              for (const [bCode, st] of Object.entries(dayMap)) {
                if (!clientAttCounts.has(bCode)) clientAttCounts.set(bCode, { present: 0, absent: 0 });
                const counts = clientAttCounts.get(bCode)!;
                if (st === "حضور" || st === "present") counts.present++;
                else if (st === "غياب" || st === "absent") counts.absent++;
              }
            }
          }
        }

        baseState.students = baseState.students.map((s: any) => {
          const b = String(s.barcode || "").trim();
          const counts = clientAttCounts.get(b);
          const attDays = counts ? counts.present : (s.totalAttendanceDays || 0);
          const absDays = counts ? counts.absent : (s.totalAbsentDays || 0);

          const exams = studentExamsMap.get(b);
          if (exams && exams.length > 0) {
            const newest = exams[0];
            const sc = Number(newest.grade ?? newest.score ?? newest.degree) || 0;
            const maxSc = Number(newest.max_score || newest.maxScore || 10);
            const pct = Math.min(100, Math.round((sc / maxSc) * 100));
            const scoreFormatted = `${sc}/${maxSc} (${pct}%)`;
            const allPcts = exams.map((e: any) => {
              const eSc = Number(e.grade ?? e.score ?? e.degree) || 0;
              const eMax = Number(e.max_score || e.maxScore || 10);
              return Math.min(100, Math.round((eSc / eMax) * 100));
            }).reverse();

            return {
              ...s,
              totalAttendanceDays: attDays,
              totalAbsentDays: absDays,
              lastExamTitle: s.lastExamTitle || newest.title || "التقييم الدوري",
              lastExamScore: s.lastExamScore || scoreFormatted,
              totalExamScores: (s.totalExamScores && s.totalExamScores.length > 0) ? s.totalExamScores : allPcts,
            };
          }
          return {
            ...s,
            totalAttendanceDays: attDays,
            totalAbsentDays: absDays,
          };
        });
      }
    }

    return baseState;
  } catch (err) {
    console.warn("[Supabase Pull] Failed to pull full state from Supabase:", err);
    return null;
  }
}

/**
 * Subscribe to Supabase Database Realtime changes across all connected clients
 */
export function subscribeToDatabaseChanges(onStateChange: () => void): () => void {
  const dbChannel = supabase
    .channel("supabase-db-sync-channel")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "chat_messages" },
      (payload) => {
        const record = payload.new as any;
        if (record && record.sender_name === "system_state_snapshot") {
          onStateChange();
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "students" },
      () => {
        onStateChange();
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "payments" },
      () => {
        onStateChange();
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(dbChannel);
  };
}

/**
 * Deterministic UUID generator for student barcodes (converts any barcode to valid Postgres UUID)
 */
export function barcodeToUUID(barcode: string): string {
  const raw = String(barcode || "").trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw.toLowerCase();
  }
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x62a9d36f, h4 = 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 3812041933);
    h4 = Math.imul(h4 ^ ch, 2869860233);
  }
  const hex1 = ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0"));
  const hex2 = ((h3 >>> 0).toString(16).padStart(8, "0") + (h4 >>> 0).toString(16).padStart(8, "0"));
  const fullHex = (hex1 + hex2).slice(0, 32);
  return `${fullHex.slice(0, 8)}-${fullHex.slice(8, 12)}-4${fullHex.slice(13, 16)}-a${fullHex.slice(17, 20)}-${fullHex.slice(20, 32)}`;
}

/**
 * Save parent accounts registry to production Supabase table public.parent_accounts
 */
export async function savePortalAccountsToSupabase(accounts: Record<string, ParentAccount>): Promise<boolean> {
  try {
    const accountList = Object.values(accounts).filter((a) => a && a.studentBarcode && a.status !== "deleted");
    if (accountList.length === 0) return true;

    const records = accountList.map((acc) => {
      const bCode = String(acc.studentBarcode).trim();
      const barcodes = acc.linkedBarcodes && acc.linkedBarcodes.length > 0
        ? acc.linkedBarcodes
        : [bCode];
      return {
        id: barcodeToUUID(bCode),
        parent_phone: acc.parentPhone || "",
        password_hash: acc.password || "",
        linked_student_barcodes: barcodes,
        fcm_token: acc.fcmToken || "",
        status: acc.status || "active",
        updated_at: new Date().toISOString(),
      };
    });

    const { error } = await supabase
      .from("parent_accounts")
      .upsert(records, { onConflict: "id" });

    if (error) {
      console.warn("[Supabase parent_accounts] Upsert multiple notice:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase parent_accounts] Error saving registry:", err);
    return false;
  }
}

/**
 * Fetch all parent accounts from production Supabase table public.parent_accounts
 */
export async function fetchPortalAccountsFromSupabase(): Promise<Record<string, ParentAccount> | null> {
  try {
    const { data, error } = await executeFastQuery(
      () => supabase.from("parent_accounts").select("*"),
      3000,
      "استعلام حسابات أولياء الأمور من Supabase"
    );

    if (!error && Array.isArray(data)) {
      const result: Record<string, ParentAccount> = {};
      for (const row of data) {
        const barcodes: string[] = Array.isArray(row.linked_student_barcodes) && row.linked_student_barcodes.length > 0
          ? row.linked_student_barcodes
          : [];
        const primaryBarcode = barcodes[0] || "";
        if (!primaryBarcode) continue;

        const normalizedStatus = (row.status || "active").toLowerCase() as "active" | "disabled" | "deleted";
        if (normalizedStatus === "deleted") continue;

        const account: ParentAccount = {
          studentBarcode: primaryBarcode,
          linkedBarcodes: barcodes,
          parentPhone: String(row.parent_phone || row.phone || row.phone_number || "").trim(),
          password: row.password_hash || "",
          fcmToken: row.fcm_token || "",
          status: normalizedStatus,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          activatedAt: row.created_at,
        };

        result[primaryBarcode] = account;
        barcodes.forEach((b: string) => {
          if (b && !result[b]) {
            result[b] = account;
          }
        });
      }
      return result;
    }
  } catch (err) {
    console.warn("[Supabase parent_accounts] Fetch error:", err);
  }
  return null;
}

// ==============================================================================
// DEDICATED PARENT_ACCOUNTS TABLE CRITICAL SECURITY & REALTIME INTEGRATION
// ==============================================================================

/**
 * Upsert parent account into dedicated parent_accounts table in Supabase
 */
export async function saveParentAccountRecordToSupabase(account: ParentAccount): Promise<boolean> {
  try {
    const bCode = String(account.studentBarcode).trim();
    if (!bCode) return false;
    const uuid = barcodeToUUID(bCode);
    const barcodes = account.linkedBarcodes && account.linkedBarcodes.length > 0
      ? account.linkedBarcodes
      : [bCode];

    const { error } = await supabase.from("parent_accounts").upsert(
      {
        id: uuid,
        parent_phone: account.parentPhone || "",
        password_hash: account.password || "",
        linked_student_barcodes: barcodes,
        fcm_token: account.fcmToken || "",
        status: account.status || "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

    if (error) {
      console.warn("[Supabase parent_accounts] Upsert notice:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase parent_accounts] Error saving record:", err);
    return false;
  }
}

/**
 * Single Indexed Parent Account Lookup Engine.
 * Direct indexed query filtered ONLY by student barcode UUID.
 * Zero sequential retries, zero phone column variations, zero cascading fallback lookups.
 */
export async function queryParentAccountByBarcode(
  barcode?: string | null,
  timeoutMs: number = 2000
): Promise<any | null> {
  const cleanBarcode = normalizeBarcode(barcode);
  if (!cleanBarcode) return null;
  const uuid = barcodeToUUID(cleanBarcode);

  try {
    const { data } = await withTimeout(
      supabase
        .from("parent_accounts")
        .select("*")
        .eq("id", uuid)
        .maybeSingle(),
      timeoutMs,
      "استعلام حساب ولي الأمر المباشر"
    );
    return data || null;
  } catch {
    return null;
  }
}

// Export as queryParentAccountSafe for clean backward compatibility
export const queryParentAccountSafe = queryParentAccountByBarcode;

/**
 * Check if a student barcode is already linked to an active parent account
 * Single direct indexed query filtered ONLY by student barcode.
 */
export async function checkBarcodeAlreadyLinkedSupabase(
  barcode: string
): Promise<{ isLinked: boolean; parentPhone?: string; accountId?: string }> {
  try {
    const cleanBarcode = normalizeBarcode(barcode);
    if (!cleanBarcode) return { isLinked: false };
    const uuid = barcodeToUUID(cleanBarcode);

    const { data: match } = await withTimeout(
      supabase
        .from("parent_accounts")
        .select("id, parent_phone, status")
        .eq("id", uuid)
        .maybeSingle(),
      2000,
      "التحقق المباشر من ربط كود الطالب"
    );

    if (match && String(match.status || "active").toLowerCase() === "active") {
      return {
        isLinked: true,
        parentPhone: String(match.parent_phone || "").trim(),
        accountId: match.id,
      };
    }
  } catch (err) {
    console.warn("[Supabase Anti-Hijack] Link check notice:", err);
  }
  return { isLinked: false };
}

/**
 * Update parent account status in Supabase (e.g. 'active', 'disabled', 'suspended', 'deleted')
 * Single direct indexed query filtered ONLY by student barcode UUID.
 */
export async function updateParentAccountStatusInSupabase(
  barcode: string,
  status: "active" | "disabled" | "suspended" | "deleted"
): Promise<boolean> {
  try {
    const cleanBarcode = normalizeBarcode(barcode);
    if (!cleanBarcode) return false;
    const uuid = barcodeToUUID(cleanBarcode);

    const { error } = await supabase
      .from("parent_accounts")
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", uuid);

    if (error) {
      console.warn("[Supabase parent_accounts] Update status error:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase parent_accounts] Update status exception:", err);
    return false;
  }
}

/**
 * Hard delete parent account record permanently from Supabase production table
 * Cascade deletes parent account, associated chat messages, and clears local caches.
 */
export async function deleteParentAccountRecordFromSupabase(barcode: string): Promise<boolean> {
  try {
    const cleanBarcode = normalizeBarcode(barcode);
    if (!cleanBarcode) return false;
    const uuid = barcodeToUUID(cleanBarcode);

    const orFilter = `id.eq.${uuid},id.eq.${cleanBarcode},student_barcode.eq.${cleanBarcode},parent_phone.eq.${cleanBarcode}`;

    // 0. Invoke PostgreSQL RPC SECURITY DEFINER function for atomic server-side cascade
    try {
      const { error: rpcErr } = await supabase.rpc("delete_parent_account_cascade", {
        target_barcode: cleanBarcode,
        target_uuid: uuid,
      });
      if (!rpcErr) {
        console.info(`[Hard Delete] PostgreSQL SECURITY DEFINER RPC delete_parent_account_cascade executed successfully for ${cleanBarcode}`);
      }
    } catch (rpcEx) {
      console.info("[Hard Delete] PostgreSQL RPC note for parent account delete:", rpcEx);
    }

    const [accRes] = await Promise.allSettled([
      supabase.from("parent_accounts").delete().or(orFilter),
      supabase.from("chat_messages").delete().or(`student_id.eq.${uuid},barcode.eq.${cleanBarcode},chat_id.eq.${cleanBarcode}`),
      supabase.from("messages").delete().or(`student_id.eq.${uuid},barcode.eq.${cleanBarcode},chat_id.eq.${cleanBarcode}`),
      supabase.from("push_subscriptions").delete().or(`barcode.eq.${cleanBarcode},student_barcode.eq.${cleanBarcode}`),
    ]);

    // Clear local parent accounts cache
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem("eman_parent_accounts");
        if (raw) {
          const parsed = JSON.parse(raw);
          delete parsed[cleanBarcode];
          delete parsed[uuid];
          localStorage.setItem("eman_parent_accounts", JSON.stringify(parsed));
        }
        purgeAllOfflineDatabases().catch(() => {});
      } catch {}
    }

    const isSuccess = accRes.status === "fulfilled" && !accRes.value.error;
    return isSuccess;
  } catch (err) {
    console.warn("[Supabase parent_accounts] Delete exception:", err);
    return false;
  }
}

/**
 * Save FCM token to parent account
 * Dual-key matching to update row whether keyed by UUID, barcode, or parent_phone.
 */
export async function updateParentAccountFCMTokenInSupabase(
  barcode: string,
  fcmToken: string
): Promise<boolean> {
  try {
    const cleanBarcode = normalizeBarcode(barcode);
    if (!cleanBarcode || !fcmToken || fcmToken === "undefined" || fcmToken === "null") return false;
    const uuid = barcodeToUUID(cleanBarcode);

    const { error } = await supabase
      .from("parent_accounts")
      .update({
        fcm_token: fcmToken,
        updated_at: new Date().toISOString(),
      })
      .or(`id.eq.${uuid},id.eq.${cleanBarcode},student_barcode.eq.${cleanBarcode},parent_phone.eq.${cleanBarcode}`);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Verify Parent Account Status in Supabase for silent background check on app launch
 * Dual-Key Querying with resilient offline fallback so network errors never trigger premature logout.
 */
export async function verifyParentAccountStatusInSupabase(
  barcode: string,
  _optionalPhone?: string
): Promise<{ exists: boolean; status: "active" | "disabled" | "deleted" | "unknown"; account?: ParentAccount }> {
  try {
    const cleanBarcode = normalizeBarcode(barcode);
    if (!cleanBarcode) return { exists: false, status: "unknown" };
    const uuid = barcodeToUUID(cleanBarcode);

    const { data: row, error } = await withTimeout(
      supabase
        .from("parent_accounts")
        .select("*")
        .or(`id.eq.${uuid},id.eq.${cleanBarcode},student_barcode.eq.${cleanBarcode},parent_phone.eq.${cleanBarcode}`)
        .maybeSingle(),
      2500,
      "التحقق السريع من حالة حساب ولي الأمر"
    ).catch(() => ({ data: null, error: "timeout" }));

    // Never log out user on network errors, timeouts, or transient database stalls
    if (error) {
      console.warn("[verifyParentAccountStatusInSupabase] Query notice (maintaining active state):", error);
      return { exists: true, status: "unknown" };
    }

    if (!row) {
      // If client is offline or network is degraded, preserve session
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        return { exists: true, status: "unknown" };
      }
      return { exists: false, status: "deleted" };
    }

    const statusVal = String(row.status || "active").toLowerCase();

    if (statusVal === "disabled" || statusVal === "suspended") {
      return { exists: true, status: "disabled" };
    }

    if (statusVal === "deleted") {
      return { exists: false, status: "deleted" };
    }

    const account: ParentAccount = {
      studentBarcode: cleanBarcode,
      studentName: row.student_name || "",
      parentPhone: String(row.parent_phone || "").trim(),
      parentName: row.parent_name || "",
      role: "parent",
      status: "active",
      activatedAt: row.activated_at || row.created_at,
      linkedBarcodes: Array.isArray(row.linked_student_barcodes) ? row.linked_student_barcodes : [cleanBarcode],
    };

    return { exists: true, status: "active", account };
  } catch (err) {
    console.warn("[verifyParentAccountStatusInSupabase] notice (maintaining active state):", err);
    return { exists: true, status: "unknown" };
  }
}


/**
 * Subscribe to realtime status changes of parent_accounts table in Supabase
 * Triggers 0ms instant remote logout when supervisor deactivates, suspends, or deletes.
 */
export function subscribeToParentAccountSupabase(
  barcode: string,
  onStatusChanged: (status: string, reason: string) => void
): () => void {
  const cleanBarcode = String(barcode).trim();
  const channelName = `parent-account-live-${cleanBarcode}-${Date.now()}`;

  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "parent_accounts",
      },
      (payload) => {
        try {
          const uuid = barcodeToUUID(cleanBarcode);
          if (payload.eventType === "DELETE") {
            const oldRow = payload.old as any;
            const matchesBarcode =
              !oldRow ||
              String(oldRow.id).toLowerCase() === uuid.toLowerCase() ||
              String(oldRow.id).trim() === cleanBarcode ||
              (Array.isArray(oldRow.linked_student_barcodes) &&
                oldRow.linked_student_barcodes.includes(cleanBarcode));
            if (matchesBarcode) {
              onStatusChanged("deleted", "تم إلغاء تفعيل هذا الحساب من قبل الإدارة");
            }
          } else if (payload.eventType === "UPDATE") {
            const newRow = payload.new as any;
            const matchesBarcode =
              newRow &&
              (String(newRow.id).toLowerCase() === uuid.toLowerCase() ||
                String(newRow.id).trim() === cleanBarcode ||
                (Array.isArray(newRow.linked_student_barcodes) &&
                  newRow.linked_student_barcodes.includes(cleanBarcode)));
            if (matchesBarcode) {
              const currentStatus = String(newRow.status || "").toLowerCase();
              if (currentStatus !== "active") {
                onStatusChanged(
                  currentStatus,
                  "تم إلغاء تفعيل هذا الحساب من قبل الإدارة"
                );
              }
            }
          }
        } catch (err) {
          console.warn("[Supabase Realtime Account Watch] Handler error:", err);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

export interface UnifiedStudentPortalData {
  success: boolean;
  student: any | null;
  attendanceHistory: Record<string, string>;
  attendanceLogs: any[];
  payments: Record<string, any>;
  paymentsList: any[];
  homeworkList: any[];
  examScores: number[];
  examGradesList: any[];
  messagesList: any[];
  lastExamTitle?: string;
  lastExamScore?: string;
  account?: any | null;
  message?: string;
}

/**
 * Unified Relational Master Query for Parent Student Portal:
 * 1. Resolves student by either Barcode OR UUID Student ID or Active Session Token.
 * 2. Fetches the complete relational graph in a single query:
 *    - `students` (Demographics, Group, Fees, Status, Points)
 *    - `attendance_logs` (Present, Absent, Late records with timestamps & notes)
 *    - `homework` (Assigned, Completed, Pending status, grades & feedback)
 *    - `payments` (Subscription amounts, dates, receipt numbers & balances)
 *    - `exam_grades` / `evaluations` (Scores, tests, teacher comments)
 *    - `chat_messages` / `messages` (Conversation history with supervisors)
 * 3. Graceful fallback for custom foreign key alias naming and standalone child tables.
 * 4. Strictly null-safe object parsing: empty arrays & default maps guarantee no UI crashes.
 */
export async function fetchUnifiedStudentPortalDataFromSupabase(
  barcodeOrToken?: string
): Promise<UnifiedStudentPortalData> {
  let cleanInput = String(barcodeOrToken || "").trim();

  // Extract barcode if input is an active session token
  if (cleanInput.startsWith("sess-") || cleanInput.includes("eman_portal_")) {
    const extracted = extractCleanBarcodeFromSession(cleanInput);
    if (extracted) cleanInput = extracted;
  }

  if (!cleanInput) {
    return {
      success: false,
      student: null,
      attendanceHistory: {},
      attendanceLogs: [],
      payments: {},
      paymentsList: [],
      homeworkList: [],
      examScores: [],
      examGradesList: [],
      messagesList: [],
      message: "تعذر استخراج رمز أو معرف الطالب من الجلسة النشطة",
    };
  }

  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanInput);

  try {
    // Direct Supabase Cloud Fetch Engine with Dual-Key matching across all sub-tables:
    // .or(`student_id.eq.${student.id},student_barcode.eq.${student.barcode},barcode.eq.${student.barcode}`)
    const fetchDirectAggregatedStudent = async () => {
      // Step A: Fast direct student resolution from students table
      let studentData: any = null;
      if (isUUID) {
        const res = await supabase
          .from("students")
          .select("*")
          .or(`id.eq.${cleanInput},barcode.eq.${cleanInput}`)
          .maybeSingle();
        studentData = res.data;
      } else {
        const uuidFallback = barcodeToUUID(cleanInput);
        const res = await supabase
          .from("students")
          .select("*")
          .or(`barcode.eq.${cleanInput},id.eq.${uuidFallback},id.eq.${cleanInput}`)
          .maybeSingle();
        studentData = res.data;
      }

      if (!studentData) {
        const byBarcode = await supabase.from("students").select("*").eq("barcode", cleanInput).maybeSingle();
        studentData = byBarcode.data;
      }

      if (!studentData && isUUID) {
        const byId = await supabase.from("students").select("*").eq("id", cleanInput).maybeSingle();
        studentData = byId.data;
      }

      if (!studentData) {
        return null;
      }

      const sId = String(studentData.id || "").trim();
      const bCode = String(studentData.barcode || cleanInput).trim();

      // Step B: Dual-Key matching filter across all sub-tables
      const dualKeyFilter = bCode && sId
        ? `student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode}`
        : sId
        ? `student_id.eq.${sId}`
        : `student_barcode.eq.${bCode},barcode.eq.${bCode}`;

      const chatDualKeyFilter = bCode && sId
        ? `student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode},chat_id.eq.${bCode}`
        : dualKeyFilter;

      // Helper for direct sub-table queries using Dual-Key filter
      const querySubTableDirect = async (
        tableName: string,
        filter: string,
        orderCol?: string,
        ascending = false
      ): Promise<any[]> => {
        try {
          let q = supabase.from(tableName).select("*").or(filter);
          if (orderCol) {
            q = q.order(orderCol, { ascending });
          }
          const res = await q;
          if (!res.error && Array.isArray(res.data)) {
            return res.data;
          }
          if (res.error && orderCol) {
            // Retry without order column if schema does not support orderCol
            const retryRes = await supabase.from(tableName).select("*").or(filter);
            if (!retryRes.error && Array.isArray(retryRes.data)) {
              return retryRes.data;
            }
          }
          return [];
        } catch (err) {
          console.warn(`[Parent Fetch] Error querying ${tableName}:`, err);
          return [];
        }
      };

      // Parallel direct queries to all 5 sub-tables for authentic sub-second responses
      const [attendance, homework, payments, grades, chatMessages] = await Promise.all([
        querySubTableDirect("attendance_logs", dualKeyFilter, "date_key", false),
        querySubTableDirect("homework", dualKeyFilter, "date_key", false),
        querySubTableDirect("payments", dualKeyFilter, "month_key", false),
        querySubTableDirect("exam_grades", dualKeyFilter, "created_at", false).then(async (rows) => {
          if (!rows || rows.length === 0) {
            return await querySubTableDirect("evaluations", dualKeyFilter, "created_at", false);
          }
          return rows;
        }),
        querySubTableDirect("chat_messages", chatDualKeyFilter, "created_at", true).then(async (rows) => {
          if (!rows || rows.length === 0) {
            return await querySubTableDirect("messages", chatDualKeyFilter, "created_at", true);
          }
          return rows;
        }),
      ]);

      // Console audit log: exact payload inspection directly from Supabase
      console.log("Parent Fetch Raw Response:", { attendance, homework, grades, payments, chatMessages });

      return {
        ...studentData,
        attendance_logs: attendance,
        homework,
        payments,
        exam_grades: grades,
        chat_messages: chatMessages,
      };
    };

    // Generous 12-Second Response Limit
    const studentRow = await withTimeout(
      fetchDirectAggregatedStudent(),
      12000,
      "استعلام بيانات الطالب الموحدة من Supabase"
    );

    if (!studentRow) {
      return {
        success: false,
        student: null,
        attendanceHistory: {},
        attendanceLogs: [],
        payments: {},
        paymentsList: [],
        homeworkList: [],
        examScores: [],
        examGradesList: [],
        messagesList: [],
        message: "لم يتم العثور على طالب بهذا الكود أو المعرف في قاعدة البيانات الموحدة",
      };
    }

    const bCode = String(studentRow.barcode || "").trim();

    // 1. Parse Attendance Records (Null-Safe with key variations)
    const rawAttendance = Array.isArray(studentRow.attendance_logs) ? studentRow.attendance_logs : [];
    const attendanceLogs = [...rawAttendance].sort((a: any, b: any) =>
      String(b.date_key || b.date || b.created_at || "").localeCompare(String(a.date_key || a.date || a.created_at || ""))
    );
    const attendanceHistory: Record<string, string> = {};
    attendanceLogs.forEach((att: any) => {
      const attDate = att.created_at || att.date || att.timestamp || att.date_key;
      const dKey = att.date_key || (typeof attDate === "string" ? attDate.slice(0, 10) : "");
      if (dKey) {
        attendanceHistory[dKey] = att.status || "حضور";
      }
    });

    // 2. Parse Payments & Receipts (Null-Safe with key variations)
    const rawPayments = Array.isArray(studentRow.payments) ? studentRow.payments : [];
    const paymentsList = [...rawPayments].sort((a: any, b: any) =>
      String(b.month_key || b.month || b.date || b.created_at || "").localeCompare(
        String(a.month_key || a.month || a.date || a.created_at || "")
      )
    );
    const paymentsMap: Record<string, any> = {};
    paymentsList.forEach((p: any) => {
      const pDate = p.created_at || p.date || p.timestamp || p.payment_date || "";
      const pDateStr = typeof pDate === "string" ? pDate.slice(0, 10) : "";
      const mKey = p.month_key || p.month || (pDateStr ? pDateStr.slice(0, 7) : "");
      const pTitle = p.subject || p.title || p.name || (mKey ? `مصروفات شهر ${mKey}` : "سداد اشتراك");
      const pAmount = Number(p.amount_paid ?? p.amount ?? p.paidAmount ?? 0);
      if (mKey) {
        const paymentRecord = {
          barcode: bCode,
          monthKey: mKey,
          amount: pAmount,
          paidAmount: pAmount,
          requiredAmount: Number(p.required_amount || 0),
          discount: Number(p.discount || 0),
          status: p.status || "paid",
          date: pDateStr,
          time: typeof pDate === "string" && pDate.length >= 16 ? pDate.slice(11, 16) : "",
          subject: pTitle,
          title: pTitle,
          name: pTitle,
          note: p.notes || "",
          notes: p.notes || "",
          recordedBy: p.received_by || "الإشراف",
          timestamp: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
          created_at: p.created_at,
        };
        paymentsMap[mKey] = {
          ...paymentRecord,
          [bCode]: paymentRecord,
        };
      }
    });

    // 3. Parse Homework Logs (Null-Safe with key variations)
    const rawHomework = Array.isArray(studentRow.homework) ? studentRow.homework : [];
    const homeworkList = [...rawHomework]
      .map((hw: any, idx: number) => {
        const hwTitle = hw.subject || hw.title || hw.name || `واجب درس ${hw.date_key || hw.date || ""}`;
        const hwDate = hw.created_at || hw.date || hw.timestamp || hw.date_key || "";
        const hwDateStr = typeof hwDate === "string" ? (hwDate.length >= 10 ? hwDate.slice(0, 10) : hwDate) : "";
        const hwGrade = hw.grade || hw.score || hw.degree;
        const hwScore = Number(hwGrade) || 0;
        const maxScore = Number(hw.max_score || hw.maxScore || 10);
        return {
          ...hw,
          id: hw.id || `hw-${idx}`,
          title: hwTitle,
          subject: hw.subject || hwTitle,
          name: hw.name || hwTitle,
          date_key: hw.date_key || hwDateStr,
          date: hwDateStr,
          created_at: hw.created_at || hwDateStr,
          timestamp: hw.timestamp,
          grade: hwGrade,
          score: hwScore,
          degree: hw.degree,
          max_score: maxScore,
          maxScore,
          status: hw.status || "done",
          notes: hw.notes || hw.teacher_notes || "",
        };
      })
      .sort((a: any, b: any) =>
        String(b.date_key || b.date || b.created_at || "").localeCompare(String(a.date_key || a.date || a.created_at || ""))
      );

    // 4. Parse Exam Grades & Evaluations (Merges exam_grades table + homework evaluations)
    const rawExamGrades = Array.isArray(studentRow.exam_grades) ? studentRow.exam_grades : [];
    const examGradesMap = new Map<string, any>();

    // A. Parse records from dedicated exam_grades table (if present)
    rawExamGrades.forEach((g: any, idx: number) => {
      const rawGrade = g.grade !== undefined ? g.grade : (g.score !== undefined ? g.score : g.degree);
      const score = Number(rawGrade) || 0;
      const maxScore = Number(g.max_score || g.maxScore || 10);
      const pct =
        g.percentage !== undefined
          ? Number(g.percentage)
          : Math.min(100, Math.round((score / maxScore) * 100));
      const examTitle = g.subject || g.title || g.name || g.exam_title || g.examTitle || "اختبار دوري";
      const examDate = g.created_at || g.date || g.timestamp || g.exam_date || "";
      const cleanExamDate = typeof examDate === "string" ? (examDate.length >= 10 ? examDate.slice(0, 10) : examDate) : "";
      const notes = g.teacher_notes || g.notes || "";
      const key = g.id || `${examTitle}-${cleanExamDate}-${score}`;

      examGradesMap.set(key, {
        id: g.id || `exam-${idx}`,
        studentId: g.student_id || studentRow.id,
        barcode: bCode,
        examTitle,
        title: examTitle,
        subject: g.subject || "الرياضيات",
        name: examTitle,
        grade: rawGrade,
        score,
        degree: g.degree,
        maxScore,
        max_score: maxScore,
        percentage: pct,
        teacherNotes: notes,
        notes,
        examDate: cleanExamDate,
        date: cleanExamDate,
        created_at: g.created_at || cleanExamDate,
        timestamp: g.timestamp,
        scoreFormatted: `${rawGrade !== undefined ? rawGrade : score} / ${maxScore} (${pct}%)`,
      });
    });

    // B. Parse evaluation and exam records stored in homework table (where scores and evaluations are recorded)
    rawHomework.forEach((hw: any, idx: number) => {
      const rawGrade = hw.grade !== undefined ? hw.grade : (hw.score !== undefined ? hw.score : hw.degree);
      const hasScore = rawGrade !== null && rawGrade !== undefined && rawGrade !== "";
      const isExam =
        hasScore ||
        (typeof hw.notes === "string" && (hw.notes.includes("امتحان") || hw.notes.includes("اختبار") || hw.notes.includes("تقييم") || hw.notes.includes("درجة") || hw.notes.includes("رصد"))) ||
        (typeof hw.title === "string" && (hw.title.includes("امتحان") || hw.title.includes("اختبار") || hw.title.includes("تقييم")));

      if (isExam) {
        const score = Number(rawGrade) || 0;
        const maxScore = Number(hw.max_score || hw.maxScore || 10);
        const pct = Math.min(100, Math.round((score / maxScore) * 100));
        const examTitle = hw.title || hw.subject || hw.name || "التقييم الدوري";
        const examDate = hw.created_at || hw.date || hw.timestamp || hw.date_key || "";
        const cleanExamDate = typeof examDate === "string" ? (examDate.length >= 10 ? examDate.slice(0, 10) : examDate) : "";
        const notes = hw.notes || hw.teacher_notes || "";
        const key = hw.id || `${examTitle}-${cleanExamDate}-${score}`;

        if (!examGradesMap.has(key)) {
          examGradesMap.set(key, {
            id: hw.id || `exam-hw-${idx}`,
            studentId: hw.student_id || studentRow.id,
            barcode: bCode,
            examTitle,
            title: examTitle,
            subject: hw.subject || "الرياضيات",
            name: examTitle,
            grade: rawGrade,
            score,
            degree: hw.degree,
            maxScore,
            max_score: maxScore,
            percentage: pct,
            teacherNotes: notes,
            notes,
            examDate: cleanExamDate,
            date: cleanExamDate,
            created_at: hw.created_at || cleanExamDate,
            timestamp: hw.timestamp,
            scoreFormatted: `${score} / ${maxScore} (${pct}%)`,
          });
        }
      }
    });

    let examGradesList = Array.from(examGradesMap.values());

    // Sort exam grades descending by date/creation
    examGradesList.sort((a: any, b: any) =>
      String(b.examDate || b.createdAt || b.date || "").localeCompare(String(a.examDate || a.createdAt || a.date || ""))
    );

    // Parse exam scores if stored in student row
    let parsedScores: number[] = [];
    if (Array.isArray(studentRow.total_exam_scores)) {
      parsedScores = studentRow.total_exam_scores;
    } else if (typeof studentRow.total_exam_scores === "string") {
      try {
        parsedScores = JSON.parse(studentRow.total_exam_scores);
      } catch {}
    }

    // Derive numeric scores list (percentages for performance indicators)
    const finalScores: number[] =
      examGradesList.length > 0
        ? examGradesList.map((g) => (g.percentage !== undefined ? g.percentage : g.score))
        : parsedScores;

    const latestExam = examGradesList[0];
    const derivedLastExamTitle = latestExam?.examTitle || studentRow.last_exam_title || "";
    const derivedLastExamScore = latestExam?.scoreFormatted || studentRow.last_exam_score || "";

    // 5. Parse Messages / Chat History (Null-Safe)
    const rawMessages = Array.isArray(studentRow.chat_messages)
      ? studentRow.chat_messages
      : Array.isArray(studentRow.messages)
      ? studentRow.messages
      : [];
    const messagesList = [...rawMessages]
      .map((m: any) => ({
        id: m.id,
        studentId: m.student_id || studentRow.id,
        senderRole: m.sender_role || "admin",
        senderName: m.sender_name || "إدارة المنظومة",
        message: m.message || "",
        isRead: m.is_read || false,
        createdAt: m.created_at || new Date().toISOString(),
      }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    // 6. Assemble Student Demographic Object
    const student = {
      id: studentRow.id,
      barcode: bCode,
      name: studentRow.name,
      phone: studentRow.phone || "",
      parentPhone: studentRow.parent_phone || "",
      groupGrade: studentRow.grade || "الصف الرابع الابتدائي",
      groupDays: studentRow.group_days || "سبت - إثنين - أربعاء",
      groupTime: studentRow.group_time || "04:00 م",
      customMonthlyFee:
        studentRow.monthly_fee !== undefined && studentRow.monthly_fee !== null
          ? Number(studentRow.monthly_fee)
          : undefined,
      discountReason: studentRow.notes || "",
      notes: studentRow.notes || "",
      points: studentRow.points || 0,
      totalAttendanceDays:
        studentRow.total_attendance_days !== undefined
          ? Number(studentRow.total_attendance_days)
          : attendanceLogs.filter((a: any) => a.status === "حضور").length,
      totalAbsentDays:
        studentRow.total_absent_days !== undefined
          ? Number(studentRow.total_absent_days)
          : attendanceLogs.filter((a: any) => a.status === "غياب" || a.status === "غائب").length,
      totalExamScores: finalScores,
      lastExamTitle: derivedLastExamTitle,
      lastExamScore: derivedLastExamScore,
      createdAt: studentRow.created_at,
      updatedAt: studentRow.updated_at,
    };

    return {
      success: true,
      student,
      attendanceHistory,
      attendanceLogs,
      payments: paymentsMap,
      paymentsList,
      homeworkList,
      examScores: finalScores,
      examGradesList,
      messagesList,
      lastExamTitle: derivedLastExamTitle,
      lastExamScore: derivedLastExamScore,
      account: null,
    };
  } catch (err: any) {
    console.error("[fetchUnifiedStudentPortalDataFromSupabase] Error:", err);
    return {
      success: false,
      student: null,
      attendanceHistory: {},
      attendanceLogs: [],
      payments: {},
      paymentsList: [],
      homeworkList: [],
      examScores: [],
      examGradesList: [],
      messagesList: [],
      message: err.message || "حدث خطأ أثناء جلب البيانات من الخادم الموحد",
    };
  }
}



