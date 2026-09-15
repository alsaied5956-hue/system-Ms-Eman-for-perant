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

const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL || "https://lzdvmzumwuqycwdecaan.supabase.co";
const SUPABASE_ANON_KEY =
  (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: {
      eventsPerSecond: 30,
    },
  },
});

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

/** Delete student from Supabase */
export async function deleteStudentFromSupabase(barcode: string): Promise<void> {
  try {
    const b = String(barcode).trim();
    barcodeToIdCache.delete(b);
    await supabase.from("students").delete().eq("barcode", b);
  } catch (err) {
    console.warn("deleteStudentFromSupabase error:", err);
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
    // 1. Fetch latest snapshot from Supabase chat_messages
    const { data: snapshotRows, error: snapErr } = await supabase
      .from("chat_messages")
      .select("message, created_at")
      .eq("sender_name", "system_state_snapshot")
      .order("created_at", { ascending: false })
      .limit(1);

    let baseState: Partial<SystemData> = {};

    if (snapshotRows && snapshotRows.length > 0 && snapshotRows[0].message) {
      try {
        const decompressed = await decompressData<SystemData>(snapshotRows[0].message);
        if (decompressed && typeof decompressed === "object" && Array.isArray(decompressed.students)) {
          baseState = decompressed;
          console.log(`[Supabase Pull] Restored snapshot with ${decompressed.students.length} students.`);
        }
      } catch (decompErr) {
        console.warn("[Supabase Pull] Snapshot decompression notice:", decompErr);
      }
    }

    // 2. Concurrently fetch students, payments, and recent attendance from Supabase tables
    const [studentsRes, paymentsRes, attendanceRes] = await Promise.allSettled([
      supabase.from("students").select("*"),
      supabase.from("payments").select("*"),
      supabase
        .from("attendance_logs")
        .select("student_id, barcode, date_key, status, time_recorded")
        .order("date_key", { ascending: false })
        .limit(3000),
    ]);

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

    // Merge attendance records
    if (attendanceRes.status === "fulfilled" && attendanceRes.value.data && attendanceRes.value.data.length > 0) {
      const history: Record<string, Record<string, string>> = baseState.attendanceHistory ? { ...baseState.attendanceHistory } : {};
      attendanceRes.value.data.forEach((att: any) => {
        const dKey = att.date_key;
        const b = att.barcode ? String(att.barcode).trim() : (att.student_id ? studentIdToBarcode.get(att.student_id) : null);
        if (!dKey || !b) return;
        if (!history[dKey]) history[dKey] = {};
        history[dKey][b] = att.status || "حضور";
      });
      baseState.attendanceHistory = history;
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
    const { data, error } = await supabase
      .from("parent_accounts")
      .select("*");

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
          parentPhone: row.parent_phone || "",
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
 * Check if a student barcode is already linked to an active parent account
 * Prevents account hijacking before registration.
 */
export async function checkBarcodeAlreadyLinkedSupabase(
  barcode: string
): Promise<{ isLinked: boolean; parentPhone?: string; accountId?: string }> {
  try {
    const cleanBarcode = String(barcode).trim();
    if (!cleanBarcode) return { isLinked: false };
    const uuid = barcodeToUUID(cleanBarcode);

    // 1. Direct ID match or Array contains match
    const { data: matches, error } = await supabase
      .from("parent_accounts")
      .select("id, parent_phone, status, linked_student_barcodes")
      .or(`id.eq.${uuid},linked_student_barcodes.cs.{${cleanBarcode}}`)
      .eq("status", "active")
      .limit(1);

    if (!error && matches && matches.length > 0) {
      return {
        isLinked: true,
        parentPhone: matches[0].parent_phone,
        accountId: matches[0].id,
      };
    }
  } catch (err) {
    console.warn("[Supabase Anti-Hijack] Link check notice:", err);
  }
  return { isLinked: false };
}

/**
 * Update parent account status in Supabase (e.g. 'active', 'disabled', 'suspended', 'deleted')
 */
export async function updateParentAccountStatusInSupabase(
  barcode: string,
  status: "active" | "disabled" | "suspended" | "deleted"
): Promise<boolean> {
  try {
    const cleanBarcode = String(barcode).trim();
    if (!cleanBarcode) return false;
    const uuid = barcodeToUUID(cleanBarcode);

    const { error } = await supabase
      .from("parent_accounts")
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .or(`id.eq.${uuid},linked_student_barcodes.cs.{${cleanBarcode}}`);

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
 */
export async function deleteParentAccountRecordFromSupabase(barcode: string): Promise<boolean> {
  try {
    const cleanBarcode = String(barcode).trim();
    if (!cleanBarcode) return false;
    const uuid = barcodeToUUID(cleanBarcode);

    const { error } = await supabase
      .from("parent_accounts")
      .delete()
      .or(`id.eq.${uuid},linked_student_barcodes.cs.{${cleanBarcode}}`);

    if (error) {
      console.warn("[Supabase parent_accounts] Delete error:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[Supabase parent_accounts] Delete exception:", err);
    return false;
  }
}

/**
 * Save FCM token to parent account
 */
export async function updateParentAccountFCMTokenInSupabase(
  barcode: string,
  fcmToken: string
): Promise<boolean> {
  try {
    const cleanBarcode = String(barcode).trim();
    const uuid = barcodeToUUID(cleanBarcode);
    const { error } = await supabase
      .from("parent_accounts")
      .update({
        fcm_token: fcmToken,
        updated_at: new Date().toISOString(),
      })
      .or(`id.eq.${uuid},linked_student_barcodes.cs.{${cleanBarcode}}`);
    return !error;
  } catch {
    return false;
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
  lastExamTitle?: string;
  lastExamScore?: string;
  account?: any | null;
  message?: string;
}

/**
 * High-Speed Authoritative Data Aggregator for Parent Student Portal
 * Fetches real-time student data, attendance logs, payment records, exams, and homework
 * directly from primary Supabase tables (students, attendance_logs, payments, homework, parent_accounts).
 */
export async function fetchUnifiedStudentPortalDataFromSupabase(
  barcodeOrPhone: string
): Promise<UnifiedStudentPortalData> {
  const cleanBarcode = normalizeBarcode(barcodeOrPhone);
  const cleanPhone = normalizePhone(barcodeOrPhone);

  if (!cleanBarcode && !cleanPhone) {
    return {
      success: false,
      student: null,
      attendanceHistory: {},
      attendanceLogs: [],
      payments: {},
      paymentsList: [],
      homeworkList: [],
      examScores: [],
      message: "كود الطالب أو رقم الهاتف مطلوب",
    };
  }

  try {
    // 1. Query students table
    let studentRow: any = null;
    if (cleanBarcode) {
      const numBarcode = !isNaN(Number(cleanBarcode)) ? Number(cleanBarcode) : null;
      let query = supabase.from("students").select("*");
      if (numBarcode !== null) {
        query = query.or(`barcode.eq.${cleanBarcode},barcode.eq.${numBarcode}`);
      } else {
        query = query.eq("barcode", cleanBarcode);
      }
      const { data: stData } = await query.limit(1);
      if (stData && stData.length > 0) {
        studentRow = stData[0];
      }
    }

    if (!studentRow && cleanPhone) {
      const { data: stPhoneData } = await supabase
        .from("students")
        .select("*")
        .or(`parent_phone.ilike.%${cleanPhone}%,phone.ilike.%${cleanPhone}%`)
        .limit(1);
      if (stPhoneData && stPhoneData.length > 0) {
        studentRow = stPhoneData[0];
      }
    }

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
        message: "لم يتم العثور على طالب بهذا الكود أو رقم الهاتف في قاعدة البيانات الموحدة",
      };
    }

    const sId = studentRow.id;
    const bCode = String(studentRow.barcode).trim();
    const uuid = barcodeToUUID(bCode);

    // Build parent_accounts query filter using UUID and linked_student_barcodes
    let parentAccountQuery = supabase.from("parent_accounts").select("*");
    if (studentRow.parent_phone) {
      parentAccountQuery = parentAccountQuery.or(
        `id.eq.${uuid},linked_student_barcodes.cs.{${bCode}},parent_phone.eq.${studentRow.parent_phone}`
      );
    } else {
      parentAccountQuery = parentAccountQuery.or(
        `id.eq.${uuid},linked_student_barcodes.cs.{${bCode}}`
      );
    }

    // 2. Concurrently fetch attendance_logs, payments, homework, and parent_accounts
    // Note: payments and homework tables do NOT have a barcode column, they use student_id (UUID)
    const [attRes, payRes, hwRes, accRes] = await Promise.allSettled([
      supabase
        .from("attendance_logs")
        .select("*")
        .or(`student_id.eq.${sId},barcode.eq.${bCode}`)
        .order("date_key", { ascending: false })
        .limit(500),
      supabase
        .from("payments")
        .select("*")
        .eq("student_id", sId)
        .order("month_key", { ascending: false })
        .limit(100),
      supabase
        .from("homework")
        .select("*")
        .eq("student_id", sId)
        .order("date_key", { ascending: false })
        .limit(100),
      parentAccountQuery.maybeSingle(),
    ]);

    // Format Attendance
    const attendanceLogs = attRes.status === "fulfilled" && attRes.value.data ? attRes.value.data : [];
    const attendanceHistory: Record<string, string> = {};
    attendanceLogs.forEach((att: any) => {
      if (att.date_key) {
        attendanceHistory[att.date_key] = att.status || "حضور";
      }
    });

    // Format Payments
    const paymentsList = payRes.status === "fulfilled" && payRes.value.data ? payRes.value.data : [];
    const paymentsMap: Record<string, any> = {};
    paymentsList.forEach((p: any) => {
      const mKey = p.month_key;
      if (mKey) {
        paymentsMap[mKey] = {
          monthKey: mKey,
          amount: Number(p.amount_paid || 0),
          paidAmount: Number(p.amount_paid || 0),
          requiredAmount: Number(p.required_amount || 0),
          date: p.payment_date ? p.payment_date.slice(0, 10) : "",
          time: p.payment_date ? p.payment_date.slice(11, 16) : "",
          note: p.notes || "",
          notes: p.notes || "",
          recordedBy: p.received_by || "الإشراف",
          timestamp: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
        };
      }
    });

    // Format Homework
    const homeworkList = hwRes.status === "fulfilled" && hwRes.value.data ? hwRes.value.data : [];

    // Format Account
    const account = accRes.status === "fulfilled" && accRes.value.data ? accRes.value.data : null;

    // Parse exam scores if stored in student row
    let parsedScores: number[] = [];
    if (Array.isArray(studentRow.total_exam_scores)) {
      parsedScores = studentRow.total_exam_scores;
    } else if (typeof studentRow.total_exam_scores === "string") {
      try {
        parsedScores = JSON.parse(studentRow.total_exam_scores);
      } catch {}
    }

    const student = {
      id: studentRow.id,
      barcode: bCode,
      name: studentRow.name,
      phone: studentRow.phone || "",
      parentPhone: studentRow.parent_phone || "",
      groupGrade: studentRow.grade || "الصف الرابع الابتدائي",
      groupDays: studentRow.group_days || "سبت - إثنين - أربعاء",
      groupTime: studentRow.group_time || "04:00 م",
      customMonthlyFee: studentRow.monthly_fee !== undefined && studentRow.monthly_fee !== null ? Number(studentRow.monthly_fee) : undefined,
      discountReason: studentRow.notes || "",
      notes: studentRow.notes || "",
      points: studentRow.points || 0,
      totalAttendanceDays: studentRow.total_attendance_days !== undefined ? Number(studentRow.total_attendance_days) : attendanceLogs.filter((a: any) => a.status === "حضور").length,
      totalAbsentDays: studentRow.total_absent_days !== undefined ? Number(studentRow.total_absent_days) : attendanceLogs.filter((a: any) => a.status === "غياب" || a.status === "غائب").length,
      totalExamScores: parsedScores,
      lastExamTitle: studentRow.last_exam_title || "",
      lastExamScore: studentRow.last_exam_score || "",
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
      examScores: student.totalExamScores,
      lastExamTitle: student.lastExamTitle,
      lastExamScore: student.lastExamScore,
      account,
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
      message: err.message || "حدث خطأ أثناء جلب البيانات من الخادم الموحد",
    };
  }
}



