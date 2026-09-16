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
