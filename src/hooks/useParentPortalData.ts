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
    // 1. Primary requested query pattern: BOTH student UUID and barcode across student_id, student_barcode, barcode
    const primaryOr = `student_id.eq.${studentId},student_barcode.eq.${studentBarcode},barcode.eq.${studentBarcode}`;
    let q = supabase.from(tableName).select("*").or(primaryOr);
    if (orderCol) {
      q = q.order(orderCol, { ascending });
    }
    const res = await q;
    if (!res.error && Array.isArray(res.data)) {
      return res.data;
    }

    // 2. Schema-tolerant fallback: if student_barcode column does not exist in this table
    const fallbackOr = studentBarcode
      ? `student_id.eq.${studentId},barcode.eq.${studentBarcode}`
      : `student_id.eq.${studentId}`;
    let q2 = supabase.from(tableName).select("*").or(fallbackOr);
    if (orderCol) {
      q2 = q2.order(orderCol, { ascending });
    }
    const res2 = await q2;
    if (!res2.error && Array.isArray(res2.data)) {
      return res2.data;
    }

    // 3. Independent column fallbacks
    const idRes = await supabase.from(tableName).select("*").eq("student_id", studentId);
    if (!idRes.error && Array.isArray(idRes.data) && idRes.data.length > 0) {
      return idRes.data;
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
 * - Dual-Key query across attendance_logs, homework, payments, exam_grades, and messages
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
        // 1. Primary Attempt: Standard implicit relational join without explicit named foreign keys
        // Removes explicit named foreign keys like attendance_logs_student_id_fkey which cause HTTP 400
        let studentRecord: any = null;
        let attendance: any[] = [];
        let homework: any[] = [];
        let payments: any[] = [];
        let grades: any[] = [];
        let chatMessages: any[] = [];
        let usedRelationalJoin = false;

        try {
          const { data: relStudent, error: relErr } = await supabase
            .from("students")
            .select("*, attendance_logs(*), payments(*), homework(*), exam_grades(*), chat_messages(*)")
            .eq("barcode", cleanInput)
            .maybeSingle();

          if (!relErr && relStudent) {
            studentRecord = relStudent;
            attendance = Array.isArray(relStudent.attendance_logs) ? relStudent.attendance_logs : [];
            homework = Array.isArray(relStudent.homework) ? relStudent.homework : [];
            payments = Array.isArray(relStudent.payments) ? relStudent.payments : [];
            grades = Array.isArray(relStudent.exam_grades) ? relStudent.exam_grades : [];
            chatMessages = Array.isArray(relStudent.chat_messages) ? relStudent.chat_messages : [];
            usedRelationalJoin = true;
            console.log("[useParentPortalData] Standard implicit relational query succeeded for barcode:", cleanInput);
          } else if (relErr) {
            console.warn(
              "[useParentPortalData] Standard relational join notice (foreign key ambiguity or schema constraint, executing sequential per-table fallback):",
              relErr.message || relErr
            );
          }
        } catch (relEx) {
          console.warn("[useParentPortalData] Relational join exception, executing sequential fallback:", relEx);
        }

        // 2. Sequential fallback if relational join failed or returned null
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanInput);

        if (!usedRelationalJoin) {
          if (isUUID) {
            const res = await supabase.from("students").select("*").eq("id", cleanInput).maybeSingle();
            studentRecord = res.data;
          }

          if (!studentRecord) {
            const res = await supabase.from("students").select("*").eq("barcode", cleanInput).maybeSingle();
            studentRecord = res.data;
          }

          if (!studentRecord && !isUUID) {
            const uuidFallback = barcodeToUUID(cleanInput);
            const res = await supabase.from("students").select("*").eq("id", uuidFallback).maybeSingle();
            studentRecord = res.data;
          }

          const fallbackStudentId = studentRecord?.id || (isUUID ? cleanInput : barcodeToUUID(cleanInput));
          const fallbackStudentBarcode = studentRecord?.barcode || cleanInput;

          // Sequential Dual-Key queries per table
          const attRes = await fetchChildTableWithDualKey("attendance_logs", fallbackStudentId, fallbackStudentBarcode, "date_key", false);
          const hwRes = await fetchChildTableWithDualKey("homework", fallbackStudentId, fallbackStudentBarcode, "date_key", false);
          const payRes = await fetchChildTableWithDualKey("payments", fallbackStudentId, fallbackStudentBarcode, "month_key", false);
          let gradesRes = await fetchChildTableWithDualKey("exam_grades", fallbackStudentId, fallbackStudentBarcode, "created_at", false);
          if (!gradesRes || gradesRes.length === 0) {
            gradesRes = await fetchChildTableWithDualKey("evaluations", fallbackStudentId, fallbackStudentBarcode, "created_at", false);
          }
          let msgRes = await fetchChildTableWithDualKey("chat_messages", fallbackStudentId, fallbackStudentBarcode, "created_at", true);
          if (!msgRes || msgRes.length === 0) {
            msgRes = await fetchChildTableWithDualKey("messages", fallbackStudentId, fallbackStudentBarcode, "created_at", true);
          }

          attendance = attRes || [];
          homework = hwRes || [];
          payments = payRes || [];
          grades = gradesRes || [];
          chatMessages = msgRes || [];
        }

        const studentId = studentRecord?.id || (isUUID ? cleanInput : barcodeToUUID(cleanInput));
        const studentBarcode = studentRecord?.barcode || cleanInput;

        // 3. EXPLICIT CONSOLE AUDIT LOGGING: exact payload inspection
        console.log("Parent Fetch Raw Response:", { attendance, homework, grades, payments });

        // 4. Also invoke the central unified parser to ensure complete state synchronization
        const unifiedData = await fetchUnifiedStudentPortalDataFromSupabase(cleanInput);

        // Merge raw responses if unified parser encountered constraint issues
        if (unifiedData && unifiedData.success) {
          if ((!unifiedData.homeworkList || unifiedData.homeworkList.length === 0) && homework.length > 0) {
            unifiedData.homeworkList = homework;
          }
          if ((!unifiedData.examGradesList || unifiedData.examGradesList.length === 0) && grades.length > 0) {
            unifiedData.examGradesList = grades.map((g: any, idx: number) => {
              const rawScore = normalizeGrade(g);
              const scoreNum = Number(rawScore) || 0;
              const maxScore = Number(g.max_score || g.maxScore || 10);
              const title = normalizeSubjectTitle(g, "اختبار دوري");
              const dateVal = normalizeDate(g);
              return {
                id: g.id || `exam-${idx}`,
                studentId: g.student_id || studentId,
                barcode: studentBarcode,
                examTitle: title,
                title,
                subject: g.subject || "الرياضيات",
                grade: rawScore,
                score: scoreNum,
                degree: g.degree,
                maxScore,
                percentage: g.percentage !== undefined ? Number(g.percentage) : Math.round((scoreNum / maxScore) * 100),
                teacherNotes: g.teacher_notes || g.notes || "",
                notes: g.teacher_notes || g.notes || "",
                examDate: dateVal,
                date: dateVal,
                createdAt: g.created_at || dateVal,
                scoreFormatted: `${rawScore} / ${maxScore}`,
              };
            });
          }
          if ((!unifiedData.paymentsList || unifiedData.paymentsList.length === 0) && payments.length > 0) {
            unifiedData.paymentsList = payments;
          }
          if ((!unifiedData.attendanceLogs || unifiedData.attendanceLogs.length === 0) && attendance.length > 0) {
            unifiedData.attendanceLogs = attendance;
          }

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
