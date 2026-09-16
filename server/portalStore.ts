import fs from "fs";
import path from "path";
import type { Response } from "express";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "https://lzdvmzumwuqycwdecaan.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";

let supabaseServer: SupabaseClient | null = null;
try {
  supabaseServer = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
} catch (e) {
  console.warn("[portalStore] Supabase client init notice:", e);
}

export function getSupabaseServer(): SupabaseClient | null {
  return supabaseServer;
}

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

export interface StudentRecord {
  barcode: string;
  name: string;
  phone: string;
  parentPhone: string;
  groupGrade: string;
  groupDays: string;
  points?: number;
  totalAttendanceDays?: number;
  totalAbsentDays?: number;
  totalExamScores?: number[];
  createdAt?: string;
  notes?: string;
  lastExamTitle?: string;
  lastExamScore?: string;
  [key: string]: any;
}

export interface SystemDataCache {
  students: StudentRecord[];
  attendanceHistory: Record<string, Record<string, string>>;
  attendanceToday: Record<string, string>;
  scanLogTimes: Record<string, string>;
  scanLogOrder: string[];
  payments: Record<string, Record<string, any>>;
  groupPrices: Record<string, number>;
  usersList: any[];
  platformMessages: any[];
  pendingWhatsAppMessages: any[];
  gradeWhatsAppLinks: Record<string, string>;
  activeSessionSlotId?: string;
  version: number;
  lastUpdated: number;
}

export interface ParentAccountRecord {
  id?: string;
  studentBarcode: string;
  studentName?: string;
  linkedBarcodes?: string[];
  parentPhone: string;
  password: string;
  status: "active" | "disabled" | "deleted";
  fcmToken?: string;
  reason?: string;
  createdAt?: string;
  activatedAt?: string;
  updatedAt?: string;
  lastLoginAt?: string;
}

// In-Memory Storage
let systemDataCache: SystemDataCache = {
  students: [],
  attendanceHistory: {},
  attendanceToday: {},
  scanLogTimes: {},
  scanLogOrder: [],
  payments: {},
  groupPrices: {},
  usersList: [],
  platformMessages: [],
  pendingWhatsAppMessages: [],
  gradeWhatsAppLinks: {},
  version: 1,
  lastUpdated: Date.now(),
};

let parentAccountsCache: Record<string, ParentAccountRecord> = {};
let deletedAccountsCache = new Set<string>();

const STORE_PATH = path.join(process.cwd(), ".system_data_store.json");
const ACCOUNTS_PATH = path.join(process.cwd(), ".parent_accounts_store.json");
const DELETED_ACCOUNTS_PATH = path.join(process.cwd(), ".deleted_accounts_store.json");

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

export function normalizePhone(val?: string | null): string {
  if (!val) return "";
  let raw = String(val).trim();
  raw = raw.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    if (code >= 1632 && code <= 1641) return String(code - 1632);
    if (code >= 1776 && code <= 1785) return String(code - 1776);
    return d;
  });
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = digits.slice(4);
  else if (digits.startsWith("20") && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

export function getTodayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Load baseline on module load: 100% Cloud-Authoritative from Firestore
export function initPortalStore(): void {
  try {
    // Delete any legacy disk store file to avoid local disk corruption
    if (fs.existsSync(STORE_PATH)) {
      try {
        fs.unlinkSync(STORE_PATH);
      } catch {}
    }

    systemDataCache.students = [];
    systemDataCache.attendanceHistory = {};
    systemDataCache.attendanceToday = {};
    systemDataCache.scanLogTimes = {};
    systemDataCache.scanLogOrder = [];
    systemDataCache.payments = {};
    systemDataCache.groupPrices = {};
    systemDataCache.usersList = [];
    systemDataCache.platformMessages = [];
    systemDataCache.gradeWhatsAppLinks = {};
    systemDataCache.activeSessionSlotId = "";
    console.log("[PortalStore] Initialized clean: ready for 100% cloud hydration from Firestore.");
    // 3. Load Parent Accounts
    if (fs.existsSync(ACCOUNTS_PATH)) {
      try {
        const accRaw = fs.readFileSync(ACCOUNTS_PATH, "utf8");
        parentAccountsCache = JSON.parse(accRaw) || {};
        console.log(`[PortalStore] Loaded ${Object.keys(parentAccountsCache).length} parent accounts.`);
      } catch {}
    }

    // 4. Load Deleted Accounts Tombstones
    if (fs.existsSync(DELETED_ACCOUNTS_PATH)) {
      try {
        const delRaw = fs.readFileSync(DELETED_ACCOUNTS_PATH, "utf8");
        const arr = JSON.parse(delRaw);
        if (Array.isArray(arr)) {
          deletedAccountsCache = new Set(arr.map((x) => String(x).trim()));
          console.log(`[PortalStore] Loaded ${deletedAccountsCache.size} deleted accounts tombstones.`);
        }
      } catch {}
    }

    // 5. Hydrate authoritative parent accounts and core data from production Supabase tables
    if (supabaseServer) {
      Promise.allSettled([
        supabaseServer.from("students").select("*"),
        supabaseServer.from("payments").select("*"),
        supabaseServer
          .from("attendance_logs")
          .select("student_id, barcode, date_key, status")
          .order("date_key", { ascending: false })
          .limit(3000),
        supabaseServer.from("parent_accounts").select("*"),
      ])
        .then(([studentsRes, paymentsRes, attendanceRes, accountsRes]) => {
          const studentIdToBarcode = new Map<string, string>();

          // A. Hydrate Students
          if (studentsRes.status === "fulfilled" && Array.isArray(studentsRes.value.data)) {
            const list: StudentRecord[] = [];
            for (const row of studentsRes.value.data) {
              const b = String(row.barcode).trim();
              if (row.id && b) {
                studentIdToBarcode.set(row.id, b);
              }
              list.push({
                id: row.id,
                barcode: b,
                name: row.name || "طالب بدون اسم",
                phone: row.phone || "",
                parentPhone: row.parent_phone || "",
                groupGrade: row.grade || "الصف الرابع الابتدائي",
                groupDays: row.group_days || "سبت - إثنين - أربعاء",
                points: row.points || 0,
                totalAttendanceDays: Number(row.total_attendance_days || 0),
                totalAbsentDays: Number(row.total_absent_days || 0),
                createdAt: row.created_at,
                notes: row.notes || "",
              });
            }
            systemDataCache.students = list;
            console.log(`[PortalStore] Synced ${list.length} students from Supabase.`);
          }

          // B. Hydrate Payments
          if (paymentsRes.status === "fulfilled" && Array.isArray(paymentsRes.value.data)) {
            const paymentsMap: Record<string, Record<string, any>> = {};
            for (const p of paymentsRes.value.data) {
              const mKey = p.month_key;
              const b = p.barcode ? String(p.barcode).trim() : (p.student_id ? studentIdToBarcode.get(p.student_id) : null);
              if (!mKey || !b) continue;
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
            }
            systemDataCache.payments = paymentsMap;
            console.log(`[PortalStore] Synced payments across ${Object.keys(paymentsMap).length} months from Supabase.`);
          }

          // C. Hydrate Attendance
          if (attendanceRes.status === "fulfilled" && Array.isArray(attendanceRes.value.data)) {
            const history: Record<string, Record<string, string>> = {};
            for (const att of attendanceRes.value.data) {
              const dKey = att.date_key;
              const b = att.barcode ? String(att.barcode).trim() : (att.student_id ? studentIdToBarcode.get(att.student_id) : null);
              if (!dKey || !b) continue;
              if (!history[dKey]) history[dKey] = {};
              history[dKey][b] = att.status || "حضور";
            }
            systemDataCache.attendanceHistory = history;
            console.log(`[PortalStore] Synced attendance logs across ${Object.keys(history).length} days from Supabase.`);
          }

          // D. Hydrate Parent Accounts
          if (accountsRes.status === "fulfilled" && Array.isArray(accountsRes.value.data)) {
            let loadedCount = 0;
            for (const row of accountsRes.value.data) {
              const barcodes: string[] = Array.isArray(row.linked_student_barcodes) && row.linked_student_barcodes.length > 0
                ? row.linked_student_barcodes
                : [];
              const primaryBarcode = barcodes[0] || "";
              if (!primaryBarcode) continue;
              const status = (row.status || "active").toLowerCase() as "active" | "disabled" | "deleted";
              if (status === "deleted") {
                deletedAccountsCache.add(primaryBarcode);
                delete parentAccountsCache[primaryBarcode];
                continue;
              }
              const acc: ParentAccountRecord = {
                id: row.id,
                studentBarcode: primaryBarcode,
                linkedBarcodes: barcodes,
                parentPhone: row.parent_phone || "",
                password: row.password_hash || "",
                fcmToken: row.fcm_token || "",
                status,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                activatedAt: row.created_at,
              };
              parentAccountsCache[primaryBarcode] = acc;
              barcodes.forEach((b: string) => {
                if (b && !parentAccountsCache[b]) {
                  parentAccountsCache[b] = acc;
                }
              });
              loadedCount++;
            }
            console.log(`[PortalStore] Synced ${loadedCount} accounts from Supabase production table.`);
          }
        })
        .catch((e: any) => console.warn("[PortalStore] Initial Supabase store hydration notice:", e));
    }
  } catch (err) {
    console.error("[PortalStore] Init error:", err);
  }
}

// Debounced Disk Persistence
let saveTimeout: NodeJS.Timeout | null = null;
export function persistStoreDebounced(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(systemDataCache), "utf8");
    } catch (e) {
      console.warn("[PortalStore] Failed saving .system_data_store.json:", e);
    }
  }, 1000);
}

let saveAccountsTimeout: NodeJS.Timeout | null = null;
export function persistAccountsDebounced(): void {
  if (saveAccountsTimeout) clearTimeout(saveAccountsTimeout);
  saveAccountsTimeout = setTimeout(() => {
    saveAccountsTimeout = null;
    try {
      fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(parentAccountsCache), "utf8");
    } catch (e) {
      console.warn("[PortalStore] Failed saving .parent_accounts_store.json:", e);
    }
  }, 1000);
}

let saveDeletedTimeout: NodeJS.Timeout | null = null;
export function persistDeletedAccountsDebounced(): void {
  if (saveDeletedTimeout) clearTimeout(saveDeletedTimeout);
  saveDeletedTimeout = setTimeout(() => {
    saveDeletedTimeout = null;
    try {
      fs.writeFileSync(DELETED_ACCOUNTS_PATH, JSON.stringify(Array.from(deletedAccountsCache)), "utf8");
    } catch (e) {
      console.warn("[PortalStore] Failed saving .deleted_accounts_store.json:", e);
    }
  }, 1000);
}

// SSE Live Stream Clients
interface PortalClient {
  id: string;
  res: Response;
  barcode?: string;
  aliases: string[];
  role: "parent" | "supervisor";
  connectedAt: number;
}

const activeClients = new Map<string, PortalClient>();

export function registerPortalSSEClient(
  id: string,
  res: Response,
  barcode?: string,
  aliases: string[] = [],
  role: "parent" | "supervisor" = "parent"
): void {
  const normBarcode = barcode ? barcode.trim() : undefined;
  const normAliases = aliases.map((a) => String(a).trim()).filter(Boolean);

  activeClients.set(id, {
    id,
    res,
    barcode: normBarcode,
    aliases: normAliases,
    role,
    connectedAt: Date.now(),
  });

  // Initial handshake
  res.write(
    `data: ${JSON.stringify({
      type: "connected",
      clientId: id,
      role,
      timestamp: Date.now(),
    })}\n\n`
  );
}

export function unregisterPortalSSEClient(id: string): void {
  activeClients.delete(id);
}

export function broadcastPortalSSE(event: { type: string; barcode?: string; [key: string]: any }): void {
  const targetBarcode = event.barcode ? String(event.barcode).trim() : null;
  const isStudentFacingAlert =
    event.type === "scan" ||
    event.type === "attendance" ||
    event.type === "exam" ||
    event.type === "homework" ||
    event.type === "grade";

  const payload = `data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`;

  activeClients.forEach((client, id) => {
    try {
      // 1. Zero-Leakage: Supervisors MUST NOT receive student-facing alerts!
      if (client.role === "supervisor" && isStudentFacingAlert) {
        return;
      }

      // 2. Strict targeting for student-specific events
      if (targetBarcode) {
        const isMatched = client.barcode === targetBarcode || client.aliases.includes(targetBarcode);
        // Supervisors can receive non-alert sync events like SYSTEM_DATA_UPDATED or STUDENT_LIVE_EVENT for data syncing
        if (isMatched || (client.role === "supervisor" && !isStudentFacingAlert)) {
          client.res.write(payload);
        }
      } else if (!isStudentFacingAlert) {
        // Global non-alert event (e.g. SYSTEM_DATA_UPDATED)
        client.res.write(payload);
      }
    } catch {
      activeClients.delete(id);
    }
  });
}

// Keepalive Ping every 20s
setInterval(() => {
  activeClients.forEach((client, id) => {
    try {
      client.res.write(`: ping\n\n`);
    } catch {
      activeClients.delete(id);
    }
  });
}, 20000);

// Core Data Accessors
export function getSystemCache(): SystemDataCache {
  return systemDataCache;
}

export function getSystemETag(): string {
  return `W/"${systemDataCache.version}-${systemDataCache.lastUpdated}-${systemDataCache.students.length}"`;
}

export function recordLiveScan(data: {
  barcode: string;
  status: "حضور" | "تأخير" | "غائب";
  timeIso?: string;
  timeDisplay?: string;
  studentName?: string;
  grade?: string;
  days?: string;
  scannedBy?: string;
}): { success: boolean; student?: StudentRecord; scanInfo: any } {
  const barcode = String(data.barcode).trim();
  const todayKey = getTodayKey();
  const timeIso = data.timeIso || new Date().toISOString();
  const timeDisplay = data.timeDisplay || new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });

  // 1. Update in-memory state
  systemDataCache.attendanceToday[barcode] = data.status;
  systemDataCache.scanLogTimes[barcode] = timeIso;

  if (!systemDataCache.attendanceHistory[todayKey]) {
    systemDataCache.attendanceHistory[todayKey] = {};
  }
  systemDataCache.attendanceHistory[todayKey][barcode] = data.status;

  // Add to scan order (dedup)
  const existingOrderIndex = systemDataCache.scanLogOrder.indexOf(barcode);
  if (existingOrderIndex !== -1) {
    systemDataCache.scanLogOrder.splice(existingOrderIndex, 1);
  }
  systemDataCache.scanLogOrder.unshift(barcode);

  // Find student to update points/stats
  const student = systemDataCache.students.find((s) => String(s.barcode).trim() === barcode);
  if (student) {
    if (data.status === "حضور") {
      student.totalAttendanceDays = (student.totalAttendanceDays || 0) + 1;
      student.points = (student.points || 0) + 5;
    } else if (data.status === "تأخير") {
      student.totalAttendanceDays = (student.totalAttendanceDays || 0) + 1;
      student.points = (student.points || 0) + 2;
    } else if (data.status === "غائب") {
      student.totalAbsentDays = (student.totalAbsentDays || 0) + 1;
    }
  }

  systemDataCache.version++;
  systemDataCache.lastUpdated = Date.now();

  // 2. Persist to disk
  persistStoreDebounced();

  // 3. Broadcast instant SSE to all open parent & teacher windows
  broadcastPortalSSE({
    type: "scan",
    barcode,
    status: data.status,
    timeIso,
    timeDisplay,
    studentName: student?.name || data.studentName || "الطالب",
    grade: student?.groupGrade || data.grade,
    days: student?.groupDays || data.days,
    scannedBy: data.scannedBy || "الماسح",
    timestamp: Date.now(),
  });

  return {
    success: true,
    student,
    scanInfo: {
      barcode,
      status: data.status,
      timeIso,
      timeDisplay,
    },
  };
}

export async function getStudentPortalData(query: string): Promise<{
  success: boolean;
  student?: StudentRecord;
  todayAttendance?: string | null;
  todayScanTime?: string | null;
  attendanceHistory?: Record<string, string>;
  payments?: Record<string, any>;
  groupPrices?: Record<string, number>;
  examScores?: number[];
  examGradesList?: any[];
  homeworkList?: any[];
  attendanceLogs?: any[];
  paymentsList?: any[];
  unreadNotices?: any[];
  account?: ParentAccountRecord | null;
  message?: string;
  systemTime: string;
}> {
  const cleanBarcode = normalizeBarcode(query);
  const cleanPhone = normalizePhone(query);
  const todayKey = getTodayKey();

  // 1. Primary Source of Truth: Direct Supabase Authoritative Query
  if (supabaseServer) {
    try {
      let studentRow: any = null;
      if (cleanBarcode) {
        const numBarcode = !isNaN(Number(cleanBarcode)) ? Number(cleanBarcode) : null;
        let q = supabaseServer.from("students").select("*");
        if (numBarcode !== null) {
          q = q.or(`barcode.eq.${cleanBarcode},barcode.eq.${numBarcode}`);
        } else {
          q = q.eq("barcode", cleanBarcode);
        }
        const { data: stData } = await q.limit(1);
        if (stData && stData.length > 0) {
          studentRow = stData[0];
        }
      }

      if (!studentRow && cleanPhone) {
        const { data: stPhoneData } = await supabaseServer
          .from("students")
          .select("*")
          .or(`parent_phone.ilike.%${cleanPhone}%,phone.ilike.%${cleanPhone}%`)
          .limit(1);
        if (stPhoneData && stPhoneData.length > 0) {
          studentRow = stPhoneData[0];
        }
      }

      if (studentRow) {
        const sId = studentRow.id;
        const bCode = String(studentRow.barcode).trim();

        const uuid = barcodeToUUID(bCode);
        let parentAccountQuery = supabaseServer.from("parent_accounts").select("*");
        if (studentRow.parent_phone) {
          parentAccountQuery = parentAccountQuery.or(
            `id.eq.${uuid},linked_student_barcodes.cs.{${bCode}},parent_phone.eq.${studentRow.parent_phone}`
          );
        } else {
          parentAccountQuery = parentAccountQuery.or(
            `id.eq.${uuid},linked_student_barcodes.cs.{${bCode}}`
          );
        }

        // Concurrently fetch attendance_logs, payments, homework, exam_grades, and parent_accounts
        // Query using both student_id (UUID) and student_barcode/barcode for 100% data parity
        const [attRes, payRes, accRes, examRes, hwRes] = await Promise.allSettled([
          supabaseServer
            .from("attendance_logs")
            .select("*")
            .or(`student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode}`)
            .order("date_key", { ascending: false })
            .limit(500),
          supabaseServer
            .from("payments")
            .select("*")
            .or(`student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode}`)
            .order("month_key", { ascending: false })
            .limit(100),
          parentAccountQuery.maybeSingle(),
          supabaseServer
            .from("exam_grades")
            .select("*")
            .or(`student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode}`)
            .order("created_at", { ascending: false })
            .limit(100),
          supabaseServer
            .from("homework")
            .select("*")
            .or(`student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode}`)
            .order("date_key", { ascending: false })
            .limit(100),
        ]);

        const studentHistory: Record<string, string> = {};
        if (attRes.status === "fulfilled" && attRes.value.data) {
          attRes.value.data.forEach((att: any) => {
            if (att.date_key) {
              studentHistory[att.date_key] = att.status || "حضور";
            }
          });
        }

        const studentPayments: Record<string, any> = {};
        if (payRes.status === "fulfilled" && payRes.value.data) {
          payRes.value.data.forEach((p: any) => {
            const mKey = p.month_key;
            if (mKey) {
              studentPayments[mKey] = {
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
        }

        // Parse exam_grades with unified dual naming
        const examGradesList: any[] = [];
        if (examRes.status === "fulfilled" && examRes.value.data) {
          examRes.value.data.forEach((g: any, idx: number) => {
            const score = Number(g.score) || 0;
            const maxScore = Number(g.max_score !== undefined ? g.max_score : (g.maxScore !== undefined ? g.maxScore : 10)) || 10;
            const pct = g.percentage !== undefined ? Number(g.percentage) : Math.round((score / maxScore) * 100);
            const title = g.exam_title || g.title || "اختبار دوري";
            const date = g.date || g.exam_date || (g.created_at ? String(g.created_at).slice(0, 10) : "");
            const notes = g.teacher_notes || g.notes || "";
            examGradesList.push({
              id: g.id || `exam-${idx}`,
              studentId: g.student_id || sId,
              student_id: g.student_id || sId,
              barcode: bCode,
              student_barcode: bCode,
              studentBarcode: bCode,
              grade: g.grade || studentRow.grade || "",
              score,
              maxScore,
              max_score: maxScore,
              subject: g.subject || "الرياضيات",
              date,
              examDate: date,
              exam_date: date,
              examTitle: title,
              exam_title: title,
              title,
              percentage: pct,
              teacherNotes: notes,
              teacher_notes: notes,
              notes,
              createdAt: g.created_at || new Date().toISOString(),
              scoreFormatted: `${score} / ${maxScore}`,
              score_formatted: `${score} / ${maxScore}`,
            });
          });
        }

        // Parse homework list
        const homeworkList: any[] = [];
        if (hwRes.status === "fulfilled" && hwRes.value.data) {
          hwRes.value.data.forEach((h: any, idx: number) => {
            homeworkList.push({
              id: h.id || `hw-${idx}`,
              studentId: h.student_id || sId,
              student_id: h.student_id || sId,
              barcode: bCode,
              student_barcode: bCode,
              dateKey: h.date_key || "",
              date_key: h.date_key || "",
              date: h.date || h.date_key || "",
              title: h.title || "واجب الحصة",
              subject: h.subject || "الرياضيات",
              status: h.status || "done",
              score: h.score !== null && h.score !== undefined ? Number(h.score) : undefined,
              maxScore: h.max_score !== null && h.max_score !== undefined ? Number(h.max_score) : undefined,
              max_score: h.max_score !== null && h.max_score !== undefined ? Number(h.max_score) : undefined,
              notes: h.notes || "",
              createdAt: h.created_at || new Date().toISOString(),
            });
          });
        }

        // Merge live today status from memory cache if scanned recently
        const todayAttendance =
          systemDataCache.attendanceToday[bCode] ||
          studentHistory[todayKey] ||
          systemDataCache.attendanceHistory[todayKey]?.[bCode] ||
          null;

        const todayScanTime = systemDataCache.scanLogTimes[bCode] || null;

        // Parse exam scores
        let parsedScores: number[] = [];
        if (Array.isArray(studentRow.total_exam_scores)) {
          parsedScores = studentRow.total_exam_scores;
        } else if (typeof studentRow.total_exam_scores === "string") {
          try {
            parsedScores = JSON.parse(studentRow.total_exam_scores);
          } catch {}
        }

        const student: StudentRecord = {
          id: studentRow.id,
          barcode: bCode,
          name: studentRow.name,
          phone: studentRow.phone || "",
          parentPhone: studentRow.parent_phone || "",
          groupGrade: studentRow.grade || "الصف الرابع الابتدائي",
          groupDays: studentRow.group_days || "سبت - إثنين - أربعاء",
          points: studentRow.points || 0,
          totalAttendanceDays:
            studentRow.total_attendance_days !== undefined
              ? Number(studentRow.total_attendance_days)
              : Object.values(studentHistory).filter((s) => s === "حضور").length,
          totalAbsentDays:
            studentRow.total_absent_days !== undefined
              ? Number(studentRow.total_absent_days)
              : Object.values(studentHistory).filter((s) => s === "غائب").length,
          totalExamScores: parsedScores,
          lastExamTitle: studentRow.last_exam_title || "",
          lastExamScore: studentRow.last_exam_score || "",
          createdAt: studentRow.created_at,
          notes: studentRow.notes || "",
        };

        const unreadNotices = (systemDataCache.platformMessages || []).filter((msg) => {
          if (!msg) return false;
          if (msg.studentBarcode && String(msg.studentBarcode).trim() === bCode) return true;
          if (msg.grade && student.groupGrade && msg.grade === student.groupGrade) return true;
          if (msg.target === "all" || msg.target === "all_parents") return true;
          return false;
        });

        const account =
          (accRes.status === "fulfilled" && accRes.value.data ? accRes.value.data : null) ||
          parentAccountsCache[bCode] ||
          null;

        if (examGradesList.length > 0) {
          student.lastExamTitle = examGradesList[0].examTitle || student.lastExamTitle;
          student.lastExamScore = examGradesList[0].scoreFormatted || student.lastExamScore;
        }

        return {
          success: true,
          student,
          todayAttendance,
          todayScanTime,
          attendanceHistory: studentHistory,
          payments: studentPayments,
          groupPrices: systemDataCache.groupPrices,
          examScores: student.totalExamScores || [],
          examGradesList,
          homeworkList,
          attendanceLogs: attRes.status === "fulfilled" && attRes.value.data ? attRes.value.data : [],
          paymentsList: payRes.status === "fulfilled" && payRes.value.data ? payRes.value.data : [],
          unreadNotices,
          account,
          systemTime: new Date().toISOString(),
        };
      }
    } catch (err) {
      console.warn("[portalStore] Supabase query notice, falling back to cache:", err);
    }
  }

  // 2. Resilient Fallback to systemDataCache
  const student = systemDataCache.students.find((s) => {
    const b = normalizeBarcode(s.barcode);
    if (b === cleanBarcode) return true;
    if (cleanPhone) {
      if (normalizePhone(s.parentPhone) === cleanPhone) return true;
      if (normalizePhone(s.phone) === cleanPhone) return true;
    }
    return false;
  });

  if (!student) {
    return {
      success: false,
      message: "لم يتم العثور على طالب بهذا الكود أو رقم الهاتف",
      systemTime: new Date().toISOString(),
    };
  }

  const bCode = String(student.barcode).trim();

  // Collect student-specific attendance history
  const studentHistory: Record<string, string> = {};
  for (const [date, rec] of Object.entries(systemDataCache.attendanceHistory || {})) {
    if (rec && rec[bCode]) {
      studentHistory[date] = rec[bCode];
    }
  }

  // Collect student-specific payments
  const studentPayments: Record<string, any> = {};
  for (const [mKey, pMap] of Object.entries(systemDataCache.payments || {})) {
    if (pMap && pMap[bCode]) {
      studentPayments[mKey] = pMap[bCode];
    }
  }

  // Today status
  const todayAttendance =
    systemDataCache.attendanceToday[bCode] ||
    systemDataCache.attendanceHistory[todayKey]?.[bCode] ||
    null;

  const todayScanTime = systemDataCache.scanLogTimes[bCode] || null;

  // Filter notices for this student or grade
  const unreadNotices = (systemDataCache.platformMessages || []).filter((msg) => {
    if (!msg) return false;
    if (msg.studentBarcode && String(msg.studentBarcode).trim() === bCode) return true;
    if (msg.grade && student.groupGrade && msg.grade === student.groupGrade) return true;
    if (msg.target === "all" || msg.target === "all_parents") return true;
    return false;
  });

  // Find account if registered
  const account = parentAccountsCache[bCode] || null;

  return {
    success: true,
    student,
    todayAttendance,
    todayScanTime,
    attendanceHistory: studentHistory,
    payments: studentPayments,
    groupPrices: systemDataCache.groupPrices,
    examScores: student.totalExamScores || [],
    unreadNotices,
    account,
    systemTime: new Date().toISOString(),
  };
}

export function updateSystemDataPartial(updates: Partial<SystemDataCache>): void {
  if (Array.isArray(updates.students)) {
    systemDataCache.students = updates.students;
  }
  if (updates.attendanceHistory) {
    systemDataCache.attendanceHistory = { ...systemDataCache.attendanceHistory, ...updates.attendanceHistory };
  }
  if (updates.attendanceToday) {
    systemDataCache.attendanceToday = { ...systemDataCache.attendanceToday, ...updates.attendanceToday };
  }
  if (updates.scanLogTimes) {
    systemDataCache.scanLogTimes = { ...systemDataCache.scanLogTimes, ...updates.scanLogTimes };
  }
  if (Array.isArray(updates.scanLogOrder)) {
    systemDataCache.scanLogOrder = updates.scanLogOrder;
  }
  if (updates.payments) {
    systemDataCache.payments = { ...systemDataCache.payments, ...updates.payments };
  }
  if (updates.groupPrices) {
    systemDataCache.groupPrices = { ...systemDataCache.groupPrices, ...updates.groupPrices };
  }
  if (Array.isArray(updates.usersList)) {
    systemDataCache.usersList = updates.usersList;
  }
  if (Array.isArray(updates.platformMessages)) {
    systemDataCache.platformMessages = updates.platformMessages;
  }
  if (updates.activeSessionSlotId !== undefined) {
    systemDataCache.activeSessionSlotId = updates.activeSessionSlotId;
  }

  systemDataCache.version++;
  systemDataCache.lastUpdated = Date.now();
  persistStoreDebounced();
}

export function setSystemDataFromCloud(cloudData: any): void {
  if (!cloudData || typeof cloudData !== "object") return;
  if (Array.isArray(cloudData.students)) {
    systemDataCache.students = cloudData.students;
  }
  if (cloudData.attendanceHistory) {
    systemDataCache.attendanceHistory = cloudData.attendanceHistory;
  }
  if (cloudData.attendanceToday) {
    systemDataCache.attendanceToday = cloudData.attendanceToday;
  }
  if (cloudData.scanLogTimes) {
    systemDataCache.scanLogTimes = cloudData.scanLogTimes;
  }
  if (Array.isArray(cloudData.scanLogOrder)) {
    systemDataCache.scanLogOrder = cloudData.scanLogOrder;
  }
  if (cloudData.payments) {
    systemDataCache.payments = cloudData.payments;
  }
  if (cloudData.groupPrices) {
    systemDataCache.groupPrices = cloudData.groupPrices;
  }
  if (Array.isArray(cloudData.usersList)) {
    systemDataCache.usersList = cloudData.usersList;
  }
  if (Array.isArray(cloudData.platformMessages)) {
    systemDataCache.platformMessages = cloudData.platformMessages;
  }
  if (cloudData.gradeWhatsAppLinks) {
    systemDataCache.gradeWhatsAppLinks = cloudData.gradeWhatsAppLinks;
  }
  if (cloudData.activeSessionSlotId !== undefined) {
    systemDataCache.activeSessionSlotId = cloudData.activeSessionSlotId;
  }

  systemDataCache.version++;
  systemDataCache.lastUpdated = Date.now();
  persistStoreDebounced();
}

export function recordLivePayment(data: {
  barcode: string;
  monthKey: string;
  paymentRecord?: any;
  action: "record" | "delete";
}): void {
  const { barcode, monthKey, paymentRecord, action } = data;
  if (!barcode || !monthKey) return;

  if (!systemDataCache.payments[monthKey]) {
    systemDataCache.payments[monthKey] = {};
  }

  if (action === "delete") {
    delete systemDataCache.payments[monthKey][barcode];
  } else if (paymentRecord) {
    systemDataCache.payments[monthKey][barcode] = paymentRecord;
  }

  systemDataCache.version++;
  systemDataCache.lastUpdated = Date.now();
  persistStoreDebounced();
}

export function recordLiveStudentMutation(data: {
  action: "add" | "update" | "delete";
  barcode: string;
  student?: StudentRecord;
}): void {
  const { action, barcode, student } = data;
  const bCode = String(barcode).trim();
  if (!bCode) return;

  if (action === "delete") {
    systemDataCache.students = systemDataCache.students.filter(
      (s) => String(s.barcode).trim() !== bCode
    );
  } else if (student) {
    const existingIndex = systemDataCache.students.findIndex(
      (s) => String(s.barcode).trim() === bCode
    );
    if (existingIndex !== -1) {
      systemDataCache.students[existingIndex] = {
        ...systemDataCache.students[existingIndex],
        ...student,
      };
    } else {
      systemDataCache.students.unshift(student);
    }
  }

  systemDataCache.version++;
  systemDataCache.lastUpdated = Date.now();
  persistStoreDebounced();
}

export function recordLiveGroupFinished(data: {
  grade: string;
  days: string;
  absentBarcodes: string[];
  lateBarcodes: string[];
  presentBarcodes: string[];
  dateKey: string;
}): void {
  const { absentBarcodes, lateBarcodes, presentBarcodes, dateKey } = data;
  if (!systemDataCache.attendanceHistory[dateKey]) {
    systemDataCache.attendanceHistory[dateKey] = {};
  }

  const todayKey = getTodayKey();
  const isToday = dateKey === todayKey;

  absentBarcodes.forEach((b) => {
    systemDataCache.attendanceHistory[dateKey][b] = "غائب";
    if (isToday) systemDataCache.attendanceToday[b] = "غائب";
  });
  lateBarcodes.forEach((b) => {
    systemDataCache.attendanceHistory[dateKey][b] = "تأخير";
    if (isToday) systemDataCache.attendanceToday[b] = "تأخير";
  });
  presentBarcodes.forEach((b) => {
    systemDataCache.attendanceHistory[dateKey][b] = "حضور";
    if (isToday) systemDataCache.attendanceToday[b] = "حضور";
  });

  systemDataCache.version++;
  systemDataCache.lastUpdated = Date.now();
  persistStoreDebounced();
}

// Parent Accounts Operations
export function getAllParentAccounts(): Record<string, ParentAccountRecord> {
  return parentAccountsCache;
}

export function getDeletedAccountBarcodes(): string[] {
  return Array.from(deletedAccountsCache);
}

export function saveParentAccountRecord(account: ParentAccountRecord): ParentAccountRecord {
  const bCode = String(account.studentBarcode).trim();
  const nowIso = new Date().toISOString();

  // Clear from deleted tombstones if re-activated or saved
  deletedAccountsCache.delete(bCode);
  persistDeletedAccountsDebounced();

  const existing = parentAccountsCache[bCode];
  const updated: ParentAccountRecord = {
    ...existing,
    ...account,
    studentBarcode: bCode,
    fcmToken: account.fcmToken || existing?.fcmToken || "",
    updatedAt: nowIso,
    activatedAt: existing?.activatedAt || account.activatedAt || nowIso,
  };

  parentAccountsCache[bCode] = updated;
  persistAccountsDebounced();

  // Sync to production Supabase table public.parent_accounts
  if (supabaseServer) {
    const uuid = barcodeToUUID(bCode);
    const barcodes = updated.linkedBarcodes && updated.linkedBarcodes.length > 0
      ? updated.linkedBarcodes
      : [bCode];
    Promise.resolve(
      supabaseServer
        .from("parent_accounts")
        .upsert({
          id: uuid,
          parent_phone: updated.parentPhone || "",
          password_hash: updated.password || "",
          linked_student_barcodes: barcodes,
          fcm_token: updated.fcmToken || "",
          status: updated.status || "active",
          updated_at: nowIso,
        }, { onConflict: "id" })
    )
      .then(({ error }: any) => {
        if (error) console.warn("[portalStore] Supabase upsert notice:", error.message);
      })
      .catch((e: any) => console.warn("[portalStore] Supabase upsert exception:", e));
  }

  // Broadcast account state change over SSE stream to ALL clients (supervisors & parents)
  broadcastPortalSSE({
    type: "ACCOUNT_SAVED",
    barcode: bCode,
    status: updated.status,
    account: updated,
    timestamp: Date.now(),
  });

  return updated;
}

/**
 * Updates fcm_token in in-memory cache and Supabase production table
 */
export async function updateAccountFCMTokenInStoreAndDb(
  targetId: string,
  fcmToken: string
): Promise<boolean> {
  const cleanId = String(targetId || "").trim();
  if (!cleanId || !fcmToken) return false;

  const cleanBarcode = normalizeBarcode(cleanId);
  const cleanPhone = normalizePhone(cleanId);
  const uuid = barcodeToUUID(cleanBarcode || cleanId);

  // 1. Update in-memory cache
  if (parentAccountsCache[cleanId]) {
    parentAccountsCache[cleanId].fcmToken = fcmToken;
  }
  if (cleanBarcode && parentAccountsCache[cleanBarcode]) {
    parentAccountsCache[cleanBarcode].fcmToken = fcmToken;
  }
  persistAccountsDebounced();

  // 2. Update Supabase production table parent_accounts
  if (supabaseServer) {
    try {
      const { error } = await supabaseServer
        .from("parent_accounts")
        .update({
          fcm_token: fcmToken,
          updated_at: new Date().toISOString(),
        })
        .or(
          `id.eq.${uuid},id.eq.${cleanId},parent_phone.eq.${cleanId}${cleanPhone ? `,parent_phone.eq.${cleanPhone}` : ""}`
        );

      if (error) {
        console.warn("[portalStore] Failed to update fcm_token in Supabase:", error.message);
        return false;
      }
      return true;
    } catch (err) {
      console.warn("[portalStore] update fcm_token exception:", err);
      return false;
    }
  }
  return true;
}

export function deleteParentAccountRecord(barcode: string): boolean {
  const bCode = String(barcode).trim();
  if (!bCode) return false;

  // Track barcode as deleted tombstone so all syncing devices purge it
  deletedAccountsCache.add(bCode);
  persistDeletedAccountsDebounced();

  let existed = false;
  if (parentAccountsCache[bCode]) {
    delete parentAccountsCache[bCode];
    persistAccountsDebounced();
    existed = true;
  }

  // HARD DELETE directly on production Supabase table public.parent_accounts
  if (supabaseServer) {
    const uuid = barcodeToUUID(bCode);
    Promise.resolve(
      supabaseServer
        .from("parent_accounts")
        .delete()
        .or(`id.eq.${uuid},linked_student_barcodes.cs.{${bCode}}`)
    )
      .then(({ error }: any) => {
        if (error) {
          console.warn("[portalStore] Supabase delete notice:", error.message);
        } else {
          console.log(`[portalStore] Hard deleted account for barcode ${bCode} from Supabase.`);
        }
      })
      .catch((e: any) => console.warn("[portalStore] Supabase delete exception:", e));
  }

  // Instant broadcast to ALL connected mobile and desktop devices (<30ms, 0 quota)
  broadcastPortalSSE({
    type: "ACCOUNT_DELETED",
    barcode: bCode,
    reason: "تم حذف هذا الحساب من قِبل إدارة المنظومة.",
    timestamp: Date.now(),
  });

  return existed;
}

// ----------------------------------------------------
// MULTI-DEVICE / MACHINE-SPECIFIC ISOLATED STATE STORE
// Zero-cross-talk state management per Device ID / Machine ID
// ----------------------------------------------------

export interface DeviceScanRecord {
  id: string;
  barcode: string;
  studentName?: string;
  grade?: string;
  days?: string;
  status: "حضور" | "تأخير" | "غائب";
  timeIso: string;
  timeDisplay: string;
  timestamp: number;
}

export interface DeviceStateRecord {
  deviceId: string;
  machineId: string;
  deviceName: string;
  role: "scanner" | "display" | "supervisor" | "portal" | "kiosk";
  activeGrade?: string;
  activeDays?: string;
  activeSlotId?: string;
  lastSeen: number;
  lastIp?: string;
  status: "online" | "idle" | "offline";
  recentScans: DeviceScanRecord[];
  customSettings: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

const deviceStatesCache = new Map<string, DeviceStateRecord>();
const DEVICE_STORE_PATH = path.join(process.cwd(), ".device_states_store.json");

// Load devices from disk if existing
try {
  if (fs.existsSync(DEVICE_STORE_PATH)) {
    const raw = fs.readFileSync(DEVICE_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      Object.entries(parsed).forEach(([devId, rec]: [string, any]) => {
        if (rec && typeof rec === "object") {
          deviceStatesCache.set(devId, {
            ...rec,
            deviceId: devId,
            machineId: rec.machineId || devId,
            recentScans: Array.isArray(rec.recentScans) ? rec.recentScans : [],
            customSettings: rec.customSettings || {},
          });
        }
      });
      console.log(`[PortalStore] Loaded ${deviceStatesCache.size} device state profiles.`);
    }
  }
} catch (err) {
  console.warn("[PortalStore] Warning loading .device_states_store.json:", err);
}

let saveDevicesTimeout: NodeJS.Timeout | null = null;
function persistDeviceStatesDebounced(): void {
  if (saveDevicesTimeout) clearTimeout(saveDevicesTimeout);
  saveDevicesTimeout = setTimeout(() => {
    saveDevicesTimeout = null;
    try {
      const obj: Record<string, DeviceStateRecord> = {};
      deviceStatesCache.forEach((val, key) => {
        obj[key] = val;
      });
      fs.writeFileSync(DEVICE_STORE_PATH, JSON.stringify(obj), "utf8");
    } catch (e) {
      console.warn("[PortalStore] Failed saving .device_states_store.json:", e);
    }
  }, 1000);
}

export function registerOrUpdateDeviceState(
  rawDeviceId: string,
  updates: Partial<DeviceStateRecord> = {},
  clientIp?: string
): DeviceStateRecord {
  const deviceId = String(rawDeviceId || "default_device").trim();
  const machineId = String(updates.machineId || deviceId).trim();
  const now = Date.now();

  let existing = deviceStatesCache.get(deviceId);
  if (!existing) {
    existing = {
      deviceId,
      machineId,
      deviceName: updates.deviceName || `جهاز ${deviceId.slice(-6)}`,
      role: updates.role || "scanner",
      activeGrade: updates.activeGrade || "الكل",
      activeDays: updates.activeDays || "الكل",
      activeSlotId: updates.activeSlotId || "auto",
      lastSeen: now,
      lastIp: clientIp,
      status: "online",
      recentScans: [],
      customSettings: updates.customSettings || {},
      createdAt: now,
      updatedAt: now,
    };
  } else {
    existing.lastSeen = now;
    existing.status = "online";
    if (clientIp) existing.lastIp = clientIp;
    if (updates.deviceName) existing.deviceName = updates.deviceName;
    if (updates.role) existing.role = updates.role;
    if (updates.activeGrade !== undefined) existing.activeGrade = updates.activeGrade;
    if (updates.activeDays !== undefined) existing.activeDays = updates.activeDays;
    if (updates.activeSlotId !== undefined) existing.activeSlotId = updates.activeSlotId;
    if (updates.customSettings) {
      existing.customSettings = { ...existing.customSettings, ...updates.customSettings };
    }
    existing.updatedAt = now;
  }

  deviceStatesCache.set(deviceId, existing);
  persistDeviceStatesDebounced();
  return existing;
}

export function getDeviceState(rawDeviceId: string): DeviceStateRecord | null {
  const deviceId = String(rawDeviceId || "").trim();
  if (!deviceId) return null;
  return deviceStatesCache.get(deviceId) || null;
}

export function getAllDeviceStates(): DeviceStateRecord[] {
  const now = Date.now();
  const list: DeviceStateRecord[] = [];
  deviceStatesCache.forEach((dev) => {
    // Flag as idle if no activity for 2 minutes, offline if 10 minutes
    const diff = now - dev.lastSeen;
    let status: "online" | "idle" | "offline" = dev.status;
    if (diff > 10 * 60 * 1000) {
      status = "offline";
    } else if (diff > 2 * 60 * 1000) {
      status = "idle";
    }
    list.push({ ...dev, status });
  });
  return list;
}

export function recordDeviceSpecificScan(
  rawDeviceId: string,
  scanInfo: {
    barcode: string;
    studentName?: string;
    grade?: string;
    days?: string;
    status: "حضور" | "تأخير" | "غائب";
    timeIso?: string;
    timeDisplay?: string;
  }
): DeviceScanRecord {
  const device = registerOrUpdateDeviceState(rawDeviceId);
  const now = Date.now();
  const timeIso = scanInfo.timeIso || new Date().toISOString();
  const timeDisplay =
    scanInfo.timeDisplay ||
    new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });

  const record: DeviceScanRecord = {
    id: `devscan-${now}-${Math.random().toString(36).substring(2, 6)}`,
    barcode: String(scanInfo.barcode).trim(),
    studentName: scanInfo.studentName,
    grade: scanInfo.grade,
    days: scanInfo.days,
    status: scanInfo.status,
    timeIso,
    timeDisplay,
    timestamp: now,
  };

  device.recentScans.unshift(record);
  if (device.recentScans.length > 100) {
    device.recentScans = device.recentScans.slice(0, 100);
  }
  device.lastSeen = now;
  device.updatedAt = now;
  persistDeviceStatesDebounced();

  // Broadcast SSE to this specific device stream
  broadcastDeviceSSE(device.deviceId, {
    type: "device_scan",
    deviceId: device.deviceId,
    scan: record,
    timestamp: now,
  });

  return record;
}

export function getDeviceIsolatedLiveData(
  rawDeviceId: string,
  options: {
    filterGrade?: string;
    filterDays?: string;
    limitScans?: number;
    includeStudents?: boolean;
  } = {}
): {
  success: boolean;
  deviceId: string;
  device: DeviceStateRecord;
  liveStats: {
    totalStudents: number;
    matchingStudents: number;
    todayAttendanceCount: number;
    todayAbsentCount: number;
    todayLateCount: number;
  };
  deviceScans: DeviceScanRecord[];
  activeGrade: string;
  activeDays: string;
  activeSlotId: string;
  students?: StudentRecord[];
  todayAttendanceMap: Record<string, string>;
  systemTime: string;
  systemVersion: number;
} {
  const device = registerOrUpdateDeviceState(rawDeviceId, {
    activeGrade: options.filterGrade,
    activeDays: options.filterDays,
  });

  const activeGrade = options.filterGrade || device.activeGrade || "الكل";
  const activeDays = options.filterDays || device.activeDays || "الكل";
  const limit = options.limitScans || 50;

  // Filter students matching this device's grade/days scope
  let matching = systemDataCache.students;
  if (activeGrade && activeGrade !== "الكل") {
    matching = matching.filter(
      (s) => s.groupGrade === activeGrade || s.grade === activeGrade
    );
  }
  if (activeDays && activeDays !== "الكل") {
    matching = matching.filter(
      (s) => s.groupDays === activeDays || s.days === activeDays
    );
  }

  // Calculate live stats
  let presentCount = 0;
  let lateCount = 0;
  let absentCount = 0;

  const todayAttendanceMap: Record<string, string> = {};
  matching.forEach((s) => {
    const bCode = String(s.barcode).trim();
    const st = systemDataCache.attendanceToday[bCode];
    if (st) {
      todayAttendanceMap[bCode] = st;
      if (st === "حضور") presentCount++;
      else if (st === "تأخير") lateCount++;
      else if (st === "غائب") absentCount++;
    }
  });

  return {
    success: true,
    deviceId: device.deviceId,
    device,
    liveStats: {
      totalStudents: systemDataCache.students.length,
      matchingStudents: matching.length,
      todayAttendanceCount: presentCount,
      todayLateCount: lateCount,
      todayAbsentCount: absentCount,
    },
    deviceScans: device.recentScans.slice(0, limit),
    activeGrade,
    activeDays,
    activeSlotId: device.activeSlotId || "auto",
    students: options.includeStudents ? matching : undefined,
    todayAttendanceMap,
    systemTime: new Date().toISOString(),
    systemVersion: systemDataCache.version,
  };
}

// Dedicated Device-Specific SSE Connections
interface DeviceSSEClient {
  deviceId: string;
  res: Response;
  connectedAt: number;
}

const activeDeviceSSEClients = new Map<string, Set<DeviceSSEClient>>();

export function registerDeviceSSEClient(deviceId: string, res: Response): () => void {
  const cleanId = String(deviceId || "default_device").trim();
  const client: DeviceSSEClient = {
    deviceId: cleanId,
    res,
    connectedAt: Date.now(),
  };

  if (!activeDeviceSSEClients.has(cleanId)) {
    activeDeviceSSEClients.set(cleanId, new Set());
  }
  activeDeviceSSEClients.get(cleanId)!.add(client);

  // Initial greeting
  res.write(
    `data: ${JSON.stringify({
      type: "device_connected",
      deviceId: cleanId,
      timestamp: Date.now(),
    })}\n\n`
  );

  return () => {
    const set = activeDeviceSSEClients.get(cleanId);
    if (set) {
      set.delete(client);
      if (set.size === 0) activeDeviceSSEClients.delete(cleanId);
    }
  };
}

export function broadcastDeviceSSE(deviceId: string, event: Record<string, any>): void {
  const cleanId = String(deviceId || "").trim();
  const payload = `data: ${JSON.stringify(event)}\n\n`;

  // Send to target device subscribers
  const targetSet = activeDeviceSSEClients.get(cleanId);
  if (targetSet) {
    targetSet.forEach((client) => {
      try {
        client.res.write(payload);
      } catch {
        targetSet.delete(client);
      }
    });
  }

  // Also broadcast to broadcast/all subscribers
  const allSet = activeDeviceSSEClients.get("*");
  if (allSet) {
    allSet.forEach((client) => {
      try {
        client.res.write(payload);
      } catch {
        allSet.delete(client);
      }
    });
  }
}

// Keepalive Ping for Device Streams every 20 seconds
setInterval(() => {
  activeDeviceSSEClients.forEach((set) => {
    set.forEach((client) => {
      try {
        client.res.write(`: ping-device\n\n`);
      } catch {
        set.delete(client);
      }
    });
  });
}, 20000);

// Initialize immediately on file load
initPortalStore();
