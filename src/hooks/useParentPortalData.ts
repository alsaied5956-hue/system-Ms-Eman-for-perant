import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  supabase,
  UnifiedStudentPortalData,
  fetchUnifiedStudentPortalDataFromSupabase,
  extractCleanBarcodeFromSession,
  barcodeToUUID,
} from "../utils/supabaseClient";
import { getSessionPortalData, setSessionPortalData } from "../utils/portalSessionStore";
import { getSavedPortalSession } from "../utils/portalStorage";

export interface UseParentPortalDataReturn {
  data: UnifiedStudentPortalData | null;
  isLoading: boolean;
  error: string | null;
  isHydrated: boolean;
  refetch: (barcode?: string, force?: boolean) => Promise<UnifiedStudentPortalData | null>;
  setData: React.Dispatch<React.SetStateAction<UnifiedStudentPortalData | null>>;
}

/**
 * Normalizes payload key variations dynamically across all Supabase table responses.
 */
export function normalizeGrade(item: any): string | number {
  if (!item) return 0;
  return item.grade ?? item.score ?? item.degree ?? 0;
}

export function normalizeSubjectTitle(item: any, fallback = "الرياضيات"): string {
  if (!item) return fallback;
  return item.subject || item.title || item.name || item.exam_title || item.examTitle || fallback;
}

export function normalizeDate(item: any, fallback = ""): string {
  if (!item) return fallback;
  const raw = item.created_at || item.date || item.timestamp || item.exam_date || item.date_key || item.payment_date || fallback;
  if (typeof raw === "string") {
    return raw.length >= 10 ? raw.slice(0, 10) : raw;
  }
  if (raw instanceof Date) {
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "number") {
    return new Date(raw).toISOString().slice(0, 10);
  }
  return fallback;
}

/**
 * Dual-Key child table query helper implementing:
 * .or(`student_id.eq.${student.id},student_barcode.eq.${student.barcode},barcode.eq.${student.barcode}`)
 */
export async function fetchChildTableWithDualKey(
  tableName: string,
  studentId: string,
  studentBarcode: string,
  orderCol?: string,
  ascending: boolean = false
): Promise<any[]> {
  try {
    const sId = String(studentId || "").trim();
    const bCode = String(studentBarcode || "").trim();
    const dualKeyFilter = bCode && sId
      ? `student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode}`
      : sId
      ? `student_id.eq.${sId}`
      : `student_barcode.eq.${bCode},barcode.eq.${bCode}`;

    let q = supabase.from(tableName).select("*");

    if (tableName === "payments") {
      if (!sId) return [];
      q = q.eq("student_id", sId);
    } else if (tableName === "chat_messages" || tableName === "messages") {
      const chatFilter = bCode && sId
        ? `student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode},chat_id.eq.${bCode}`
        : dualKeyFilter;
      q = q.or(chatFilter);
    } else {
      q = q.or(dualKeyFilter);
    }

    if (orderCol) {
      q = q.order(orderCol, { ascending });
    }
    const res = await q;
    if (!res.error && Array.isArray(res.data)) {
      return res.data;
    }

    // Direct fallback without order column in case column is not indexed
    if (res.error && orderCol) {
      let retryQ = supabase.from(tableName).select("*");
      if (tableName === "payments") {
        if (sId) retryQ = retryQ.eq("student_id", sId);
      } else if (tableName === "chat_messages" || tableName === "messages") {
        const chatFilter = bCode && sId
          ? `student_id.eq.${sId},student_barcode.eq.${bCode},barcode.eq.${bCode},chat_id.eq.${bCode}`
          : dualKeyFilter;
        retryQ = retryQ.or(chatFilter);
      } else {
        retryQ = retryQ.or(dualKeyFilter);
      }
      const fallbackRes = await retryQ;
      if (!fallbackRes.error && Array.isArray(fallbackRes.data)) {
        return fallbackRes.data;
      }
    }

    return [];
  } catch (err) {
    console.warn(`[useParentPortalData] Warning fetching ${tableName}:`, err);
    return [];
  }
}

/**
 * Primary Parent Portal Data Hook:
 * - Strict Network-First Strategy: Directly fetches live Supabase records on every mount, child switch, and foreground return
 * - Dual-Key Matching: queries sub-tables with .or(`student_id.eq.${student.id},student_barcode.eq.${student.barcode},barcode.eq.${student.barcode}`)
 * - Immediate (<200ms) REST revalidation on document.visibilitychange decoupled from websocket cooldown
 * - Renders raw authentic Supabase response immediately with zero stale cache fallback
 */
export function useParentPortalData(targetBarcodeOrToken?: string): UseParentPortalDataReturn {
  // Commandment 1: Bypass LocalStorage/IndexedDB for core entity records. State MUST initialize as null/empty until live queries resolve.
  const [data, setData] = useState<UnifiedStudentPortalData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState<boolean>(false);

  // Track active in-flight request to prevent race conditions during rapid revalidations
  const inFlightPromiseRef = useRef<{ barcode: string; promise: Promise<UnifiedStudentPortalData | null> } | null>(null);

  const executeFetch = useCallback(
    async (barcodeParam?: string, _force: boolean = true): Promise<UnifiedStudentPortalData | null> => {
      let cleanInput = String(barcodeParam || targetBarcodeOrToken || "").trim();
      if (cleanInput.startsWith("sess-") || cleanInput.includes("eman_portal_")) {
        const ext = extractCleanBarcodeFromSession(cleanInput);
        if (ext) cleanInput = ext;
      }

      if (!cleanInput) {
        const sess = getSavedPortalSession();
        cleanInput = String(sess?.account?.studentBarcode || sess?.barcode || "").trim();
      }

      if (!cleanInput) return null;

      // If exact same barcode fetch is already in flight, reuse its promise
      if (inFlightPromiseRef.current && inFlightPromiseRef.current.barcode === cleanInput) {
        return inFlightPromiseRef.current.promise;
      }

      setIsLoading(true);
      setError(null);

      const fetchPromise = (async () => {
        try {
          // Fast-Path: Query high-performance server endpoint first (handles 720+ concurrent parents with micro-caching & request deduplication)
          let unifiedData: UnifiedStudentPortalData | null = null;

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500);
            const res = await fetch(`/api/portal/student-data?barcode=${encodeURIComponent(cleanInput)}&_t=${Date.now()}`, {
              headers: { Accept: "application/json" },
              signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (res.ok) {
              const serverPayload = await res.json();
              if (serverPayload && serverPayload.success && serverPayload.student) {
                unifiedData = {
                  success: true,
                  student: serverPayload.student,
                  attendanceHistory: serverPayload.attendanceHistory || {},
                  attendanceLogs: serverPayload.attendanceLogs || [],
                  payments: serverPayload.payments || {},
                  paymentsList: serverPayload.paymentsList || [],
                  homeworkList: serverPayload.homeworkList || [],
                  examScores: serverPayload.examScores || [],
                  examGradesList: serverPayload.examGradesList || [],
                  messagesList: serverPayload.messagesList || serverPayload.unreadNotices || [],
                  lastExamTitle: serverPayload.lastExamTitle || serverPayload.student?.lastExamTitle || "",
                  lastExamScore: serverPayload.lastExamScore || serverPayload.student?.lastExamScore || "",
                  account: serverPayload.account || null,
                  message: serverPayload.message,
                };
              }
            }
          } catch (serverErr) {
            console.warn("[useParentPortalData] Fast server endpoint notice, attempting direct Supabase query:", serverErr);
          }

          // Resilient Fallback:
          // If server did not return a student, fetch directly from Supabase Cloud
          if (!unifiedData || !unifiedData.success || !unifiedData.student) {
            try {
              const directSbData = await fetchUnifiedStudentPortalDataFromSupabase(cleanInput);
              if (directSbData && directSbData.success && directSbData.student) {
                unifiedData = directSbData;
              }
            } catch (enrichErr) {
              console.warn("[useParentPortalData] Direct enrichment notice:", enrichErr);
            }
          }

          if (unifiedData && unifiedData.success) {
            setSessionPortalData(cleanInput, unifiedData);
            setData(unifiedData);
            setIsHydrated(true);
            return unifiedData;
          }

          setData(unifiedData);
          if (!unifiedData?.success) {
            setError(unifiedData?.message || "تعذر مزامنة بيانات الطالب");
          }
          return unifiedData;
        } catch (err: any) {
          console.error("[useParentPortalData] Network fetch error:", err);
          setError(err.message || "حدث خطأ أثناء جلب البيانات");
          return null;
        } finally {
          setIsLoading(false);
          inFlightPromiseRef.current = null;
        }
      })();

      inFlightPromiseRef.current = { barcode: cleanInput, promise: fetchPromise };
      return fetchPromise;
    },
    [targetBarcodeOrToken]
  );

  // Network-First initial load & target barcode change
  useEffect(() => {
    let clean = String(targetBarcodeOrToken || "").trim();
    if (clean.startsWith("sess-") || clean.includes("eman_portal_")) {
      const ext = extractCleanBarcodeFromSession(clean);
      if (ext) clean = ext;
    }
    if (!clean) {
      const sess = getSavedPortalSession();
      clean = String(sess?.account?.studentBarcode || sess?.barcode || "").trim();
    }
    if (!clean) return;

    // Trigger immediate direct network fetch
    executeFetch(clean, true);
  }, [targetBarcodeOrToken, executeFetch]);

  // Immediate REST Revalidation: Listen to un-throttled visibility change & focus events (<200ms)
  useEffect(() => {
    const handleRevalidate = () => {
      let clean = String(targetBarcodeOrToken || "").trim();
      if (clean.startsWith("sess-") || clean.includes("eman_portal_")) {
        const ext = extractCleanBarcodeFromSession(clean);
        if (ext) clean = ext;
      }
      if (!clean) {
        const sess = getSavedPortalSession();
        clean = String(sess?.account?.studentBarcode || sess?.barcode || "").trim();
      }
      if (clean) {
        console.log("[useParentPortalData] Immediate REST revalidation executing for:", clean);
        executeFetch(clean, true);
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("eman_portal_force_revalidate", handleRevalidate);

      // Commandment 5: visibilitychange, focus, and online events MUST trigger instant REST data revalidation (< 200ms)
      const onVisibilityChange = () => {
        if (typeof document !== "undefined" && document.visibilityState === "visible") {
          handleRevalidate();
        }
      };
      const onFocus = () => handleRevalidate();
      const onOnline = () => handleRevalidate();

      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("focus", onFocus);
      window.addEventListener("online", onOnline);

      return () => {
        window.removeEventListener("eman_portal_force_revalidate", handleRevalidate);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("online", onOnline);
      };
    }
    return undefined;
  }, [targetBarcodeOrToken, executeFetch]);

  return {
    data,
    isLoading,
    error,
    isHydrated,
    refetch: executeFetch,
    setData,
  };
}
