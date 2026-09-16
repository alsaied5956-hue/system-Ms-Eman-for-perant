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
    let q = supabase.from(tableName).select("*");
    if (tableName === "homework" || tableName === "exam_grades" || tableName === "evaluations") {
      const orFilter = studentBarcode
        ? `student_id.eq.${studentId},student_barcode.eq.${studentBarcode},barcode.eq.${studentBarcode}`
        : `student_id.eq.${studentId}`;
      q = q.or(orFilter);
    } else if (tableName === "attendance_logs") {
      const orFilter = studentBarcode
        ? `student_id.eq.${studentId},student_barcode.eq.${studentBarcode},barcode.eq.${studentBarcode}`
        : `student_id.eq.${studentId}`;
      q = q.or(orFilter);
    } else if (tableName === "payments") {
      const orFilter = studentBarcode
        ? `student_id.eq.${studentId},student_barcode.eq.${studentBarcode},barcode.eq.${studentBarcode}`
        : `student_id.eq.${studentId}`;
      q = q.or(orFilter);
    } else {
      const orFilter = studentBarcode
        ? `student_id.eq.${studentId},student_barcode.eq.${studentBarcode},barcode.eq.${studentBarcode},chat_id.eq.${studentBarcode}`
        : `student_id.eq.${studentId}`;
      q = q.or(orFilter);
    }

    if (orderCol) {
      q = q.order(orderCol, { ascending });
    }
    const res = await q;
    if (!res.error && Array.isArray(res.data)) {
      return res.data;
    }

    // Schema-tolerant fallback
    if (studentId) {
      const idRes = await supabase.from(tableName).select("*").eq("student_id", studentId);
      if (!idRes.error && Array.isArray(idRes.data) && idRes.data.length > 0) {
        return idRes.data;
      }
    }

    if (studentBarcode) {
      const bcRes = await supabase.from(tableName).select("*").eq("barcode", studentBarcode);
      if (!bcRes.error && Array.isArray(bcRes.data) && bcRes.data.length > 0) {
        return bcRes.data;
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
 * - Direct execution of fetchUnifiedStudentPortalDataFromSupabase
 * - Explicit Console Audit Logging: console.log('Parent Fetch Raw Response:', { attendance, homework, grades, payments });
 * - Dynamic payload normalization for grade/score/degree, subject/title/name, created_at/date/timestamp
 */
export function useParentPortalData(targetBarcodeOrToken?: string): UseParentPortalDataReturn {
  const [data, setData] = useState<UnifiedStudentPortalData | null>(() => {
    let clean = String(targetBarcodeOrToken || "").trim();
    if (clean.startsWith("sess-") || clean.includes("eman_portal_")) {
      const ext = extractCleanBarcodeFromSession(clean);
      if (ext) clean = ext;
    }
    return clean ? getSessionPortalData(clean) : null;
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState<boolean>(() => {
    let clean = String(targetBarcodeOrToken || "").trim();
    if (clean.startsWith("sess-") || clean.includes("eman_portal_")) {
      const ext = extractCleanBarcodeFromSession(clean);
      if (ext) clean = ext;
    }
    return Boolean(clean && getSessionPortalData(clean)?.success);
  });

  const currentHydratedBarcodeRef = useRef<string>("");

  const executeFetch = useCallback(
    async (barcodeParam?: string, force: boolean = false): Promise<UnifiedStudentPortalData | null> => {
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

      if (!force && currentHydratedBarcodeRef.current === cleanInput && data?.success) {
        return data;
      }

      setIsLoading(true);
      setError(null);

      try {
        const unifiedData = await fetchUnifiedStudentPortalDataFromSupabase(cleanInput);

        if (unifiedData && unifiedData.success) {
          setSessionPortalData(cleanInput, unifiedData);
          setData(unifiedData);
          setIsHydrated(true);
          currentHydratedBarcodeRef.current = cleanInput;
          return unifiedData;
        }

        setData(unifiedData);
        if (!unifiedData?.success) {
          setError(unifiedData?.message || "تعذر مزامنة بيانات الطالب");
        }
        return unifiedData;
      } catch (err: any) {
        console.error("[useParentPortalData] Fetch error:", err);
        setError(err.message || "حدث خطأ أثناء جلب البيانات");
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [targetBarcodeOrToken, data]
  );

  useEffect(() => {
    let clean = String(targetBarcodeOrToken || "").trim();
    if (clean.startsWith("sess-") || clean.includes("eman_portal_")) {
      const ext = extractCleanBarcodeFromSession(clean);
      if (ext) clean = ext;
    }
    if (!clean) return;

    if (currentHydratedBarcodeRef.current === clean && data?.success) {
      return;
    }

    executeFetch(clean, false);
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
