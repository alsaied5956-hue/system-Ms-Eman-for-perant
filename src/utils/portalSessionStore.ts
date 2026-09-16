/**
 * src/utils/portalSessionStore.ts
 * In-Memory Session Caching for Parent Portal (Zero Local Storage, No Mock Data)
 * 
 * Solidifies the cloud-only data fetching flow by keeping fetched Supabase data active
 * in React memory state during the current app session. Prevents spamming Supabase API
 * calls on every tab navigation. Live data from Supabase is re-fetched ONLY on:
 *   1. Manual pull-to-refresh / direct refresh action
 *   2. Page reload (resets memory)
 *   3. Realtime database triggers (WebSockets)
 */

import type { UnifiedStudentPortalData } from "./supabaseClient";

// In-memory session store (pure memory, strictly NO localStorage / sessionStorage)
const sessionPortalCache = new Map<string, UnifiedStudentPortalData>();

// Active listeners for cache mutations (reactive sync with React components)
type PortalCacheListener = (barcode: string, data: UnifiedStudentPortalData) => void;
const cacheListeners = new Set<PortalCacheListener>();

/**
 * Retrieve cached unified portal data for a student barcode from memory
 */
export function getSessionPortalData(barcode: string): UnifiedStudentPortalData | null {
  const clean = String(barcode || "").trim();
  if (!clean) return null;
  return sessionPortalCache.get(clean) || null;
}

/**
 * Check if portal data for a student barcode exists in memory
 */
export function hasSessionPortalData(barcode: string): boolean {
  const clean = String(barcode || "").trim();
  if (!clean) return false;
  return sessionPortalCache.has(clean);
}

/**
 * Save unified portal data for a student barcode into in-memory session cache
 */
export function setSessionPortalData(barcode: string, data: UnifiedStudentPortalData): void {
  const clean = String(barcode || "").trim();
  if (!clean || !data) return;

  sessionPortalCache.set(clean, data);

  // Notify active subscribers
  cacheListeners.forEach((listener) => {
    try {
      listener(clean, data);
    } catch (err) {
      console.warn("[portalSessionStore] Listener error:", err);
    }
  });
}

/**
 * Realtime helper: updates student profile inside the cached data
 */
export function updateSessionPortalStudent(barcode: string, partialOrUpdater: any): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing || !existing.student) return;

  const updatedStudent =
    typeof partialOrUpdater === "function"
      ? partialOrUpdater(existing.student)
      : { ...existing.student, ...partialOrUpdater };

  const updated: UnifiedStudentPortalData = {
    ...existing,
    student: updatedStudent,
  };

  setSessionPortalData(clean, updated);
}

/**
 * Realtime helper: updates attendance history inside the cached data
 */
export function updateSessionPortalAttendance(barcode: string, dateKey: string, status: string): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const updated: UnifiedStudentPortalData = {
    ...existing,
    attendanceHistory: {
      ...(existing.attendanceHistory || {}),
      [dateKey]: status,
    },
  };

  setSessionPortalData(clean, updated);
}

/**
 * Realtime helper: updates payment record inside the cached data
 */
export function updateSessionPortalPayment(barcode: string, monthKey: string, paymentRecord: any): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const currentMonthPayments = (existing.payments && existing.payments[monthKey]) || {};

  const updated: UnifiedStudentPortalData = {
    ...existing,
    payments: {
      ...(existing.payments || {}),
      [monthKey]: {
        ...currentMonthPayments,
        [clean]: paymentRecord,
      },
    },
  };

  setSessionPortalData(clean, updated);
}

/**
 * Realtime helper: updates or inserts homework log inside the cached data
 */
export function updateSessionPortalHomework(barcode: string, homeworkItem: any): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const currentList = Array.isArray(existing.homeworkList) ? existing.homeworkList : [];
  const itemDateKey = homeworkItem?.date_key || homeworkItem?.date;
  const index = currentList.findIndex((h: any) => (h.date_key || h.date) === itemDateKey);

  let updatedList = [];
  if (index >= 0) {
    updatedList = [...currentList];
    updatedList[index] = { ...updatedList[index], ...homeworkItem };
  } else {
    updatedList = [homeworkItem, ...currentList];
  }

  const updated: UnifiedStudentPortalData = {
    ...existing,
    homeworkList: updatedList,
  };

  setSessionPortalData(clean, updated);
}

/**
 * Realtime helper: removes homework log from cached data
 */
export function deleteSessionPortalHomework(barcode: string, dateKeyOrId: string): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const currentList = Array.isArray(existing.homeworkList) ? existing.homeworkList : [];
  const updatedList = currentList.filter(
    (h: any) => h.id !== dateKeyOrId && (h.date_key || h.date) !== dateKeyOrId
  );

  setSessionPortalData(clean, {
    ...existing,
    homeworkList: updatedList,
  });
}

/**
 * Realtime helper: updates or inserts exam grade inside cached data
 */
export function updateSessionPortalExamGrade(barcode: string, gradeItem: any): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const currentList = Array.isArray(existing.examGradesList) ? existing.examGradesList : [];
  const itemTitle = gradeItem?.exam_title || gradeItem?.examTitle || gradeItem?.title;
  const itemId = gradeItem?.id;

  const index = currentList.findIndex(
    (g: any) => (itemId && g.id === itemId) || (itemTitle && (g.examTitle || g.title) === itemTitle)
  );

  const normalized = {
    id: itemId || `exam-${Date.now()}`,
    studentId: gradeItem?.student_id || gradeItem?.studentId || existing.student?.id,
    barcode: clean,
    examTitle: itemTitle || "اختبار دوري",
    title: itemTitle || "اختبار دوري",
    score: Number(gradeItem?.score) || 0,
    maxScore: Number(gradeItem?.max_score || gradeItem?.maxScore) || 10,
    percentage:
      gradeItem?.percentage !== undefined
        ? Number(gradeItem?.percentage)
        : Math.round(((Number(gradeItem?.score) || 0) / (Number(gradeItem?.max_score || gradeItem?.maxScore) || 10)) * 100),
    teacherNotes: gradeItem?.teacher_notes || gradeItem?.teacherNotes || gradeItem?.notes || "",
    notes: gradeItem?.teacher_notes || gradeItem?.teacherNotes || gradeItem?.notes || "",
    examDate: gradeItem?.exam_date || gradeItem?.examDate || new Date().toISOString().slice(0, 10),
    createdAt: gradeItem?.created_at || gradeItem?.createdAt || new Date().toISOString(),
    scoreFormatted: `${gradeItem?.score || 0} / ${gradeItem?.max_score || gradeItem?.maxScore || 10}`,
  };

  let updatedList = [];
  if (index >= 0) {
    updatedList = [...currentList];
    updatedList[index] = { ...updatedList[index], ...normalized };
  } else {
    updatedList = [normalized, ...currentList];
  }

  // Recalculate derived scores
  const finalScores = updatedList.map((g) => g.score);
  const latest = updatedList[0];

  const updatedStudent = existing.student
    ? {
        ...existing.student,
        totalExamScores: finalScores,
        lastExamTitle: latest?.examTitle || existing.student.lastExamTitle,
        lastExamScore: latest?.scoreFormatted || existing.student.lastExamScore,
        points: gradeItem?.points !== undefined ? gradeItem.points : existing.student.points,
      }
    : null;

  setSessionPortalData(clean, {
    ...existing,
    student: updatedStudent,
    examGradesList: updatedList,
    examScores: finalScores,
    lastExamTitle: latest?.examTitle || existing.lastExamTitle,
    lastExamScore: latest?.scoreFormatted || existing.lastExamScore,
  });
}

/**
 * Realtime helper: deletes exam grade from cached data
 */
export function deleteSessionPortalExamGrade(barcode: string, gradeIdOrTitle: string): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const currentList = Array.isArray(existing.examGradesList) ? existing.examGradesList : [];
  const updatedList = currentList.filter(
    (g: any) => g.id !== gradeIdOrTitle && (g.examTitle || g.title) !== gradeIdOrTitle
  );

  const finalScores = updatedList.map((g) => g.score);
  const latest = updatedList[0];

  const updatedStudent = existing.student
    ? {
        ...existing.student,
        totalExamScores: finalScores,
        lastExamTitle: latest?.examTitle || "",
        lastExamScore: latest?.scoreFormatted || "",
      }
    : null;

  setSessionPortalData(clean, {
    ...existing,
    student: updatedStudent,
    examGradesList: updatedList,
    examScores: finalScores,
    lastExamTitle: latest?.examTitle || "",
    lastExamScore: latest?.scoreFormatted || "",
  });
}

/**
 * Realtime helper: removes single attendance record from cached data
 */
export function deleteSessionPortalAttendance(barcode: string, dateKeyOrId: string): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const newHistory = { ...(existing.attendanceHistory || {}) };
  delete newHistory[dateKeyOrId];

  const currentLogs = Array.isArray(existing.attendanceLogs) ? existing.attendanceLogs : [];
  const newLogs = currentLogs.filter((l: any) => l.id !== dateKeyOrId && l.date_key !== dateKeyOrId);

  const updatedStudent = existing.student
    ? {
        ...existing.student,
        totalAttendanceDays: newLogs.filter((a: any) => a.status === "حضور").length,
        totalAbsentDays: newLogs.filter((a: any) => a.status === "غياب" || a.status === "غائب").length,
      }
    : null;

  setSessionPortalData(clean, {
    ...existing,
    student: updatedStudent,
    attendanceHistory: newHistory,
    attendanceLogs: newLogs,
  });
}

/**
 * Realtime helper: removes payment record from cached data
 */
export function deleteSessionPortalPayment(barcode: string, monthKeyOrId: string): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const newPayments = { ...(existing.payments || {}) };
  delete newPayments[monthKeyOrId];

  const currentList = Array.isArray(existing.paymentsList) ? existing.paymentsList : [];
  const newList = currentList.filter(
    (p: any) => p.id !== monthKeyOrId && p.month_key !== monthKeyOrId && p.monthKey !== monthKeyOrId
  );

  setSessionPortalData(clean, {
    ...existing,
    payments: newPayments,
    paymentsList: newList,
  });
}

/**
 * Realtime helper: appends or updates chat message in cached data
 */
export function updateSessionPortalMessage(barcode: string, messageItem: any): void {
  const clean = String(barcode || "").trim();
  const existing = sessionPortalCache.get(clean);
  if (!existing) return;

  const currentList = Array.isArray(existing.messagesList) ? existing.messagesList : [];
  const index = currentList.findIndex((m: any) => m.id === messageItem.id);

  let updatedList = [];
  if (index >= 0) {
    updatedList = [...currentList];
    updatedList[index] = { ...updatedList[index], ...messageItem };
  } else {
    updatedList = [...currentList, messageItem];
  }

  setSessionPortalData(clean, {
    ...existing,
    messagesList: updatedList,
  });
}

/**
 * Clear in-memory cache (e.g. upon user logout)
 */
export function clearSessionPortalCache(): void {
  sessionPortalCache.clear();
}

/**
 * Subscribe to in-memory cache updates
 */
export function subscribeToSessionPortalCache(listener: PortalCacheListener): () => void {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
}
