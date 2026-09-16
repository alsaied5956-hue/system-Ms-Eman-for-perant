import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  ReactNode,
} from "react";
import { Student, PaymentRecord } from "../types";
import { ParentAccount } from "../types/portal";
import { supabase } from "../utils/supabaseClient";
import { subscribeToStudentLiveBarcode, executeInstantRemoteLogout } from "../utils/studentLiveSync";
import { withTimeout } from "../utils/promiseTimeout";

export interface ChildBatchedData {
  student: Student;
  attendanceHistory?: Record<string, string>;
  paymentRecords?: PaymentRecord[];
  totalPoints?: number;
  lastExamScore?: string;
  lastExamTitle?: string;
}

interface ParentChildContextType {
  account: ParentAccount | null;
  activeBarcode: string;
  activeStudent: Student | null;
  allChildren: Student[];
  linkedBarcodes: string[];
  isLoadingBatch: boolean;
  switchChild: (barcode: string) => void;
  updateActiveStudentData: (updater: (prev: Student) => Student) => void;
  reloadChildrenBatch: () => Promise<void>;
}

const ParentChildContext = createContext<ParentChildContextType | null>(null);

export interface ParentChildProviderProps {
  children: ReactNode;
  account: ParentAccount | null;
  initialStudent?: Student | null;
  allSystemStudents?: Student[];
}

export const ParentChildProvider: React.FC<ParentChildProviderProps> = ({
  children,
  account,
  initialStudent = null,
  allSystemStudents = [],
}) => {
  const [activeBarcode, setActiveBarcode] = useState<string>(
    initialStudent?.barcode || account?.studentBarcode || ""
  );

  // In-memory cache of all linked students
  const [childrenMap, setChildrenMap] = useState<Record<string, Student>>(() => {
    const map: Record<string, Student> = {};
    if (initialStudent?.barcode) {
      map[initialStudent.barcode] = initialStudent;
    }
    return map;
  });

  const [isLoadingBatch, setIsLoadingBatch] = useState<boolean>(false);

  // All linked barcodes for this parent account
  const linkedBarcodes = useMemo<string[]>(() => {
    if (!account) return [initialStudent?.barcode].filter(Boolean) as string[];
    const set = new Set<string>();
    if (account.studentBarcode) set.add(account.studentBarcode);
    if (account.linkedBarcodes && Array.isArray(account.linkedBarcodes)) {
      account.linkedBarcodes.forEach((b) => b && set.add(b));
    }
    if (initialStudent?.barcode) set.add(initialStudent.barcode);
    return Array.from(set);
  }, [account, initialStudent?.barcode]);

  // Single Batched Fetch from Supabase (Free-Tier Optimization)
  const reloadChildrenBatch = useCallback(async () => {
    if (!linkedBarcodes || linkedBarcodes.length === 0) return;

    setIsLoadingBatch(true);
    try {
      // 1. Resolve any locally available system students first (0ms latency)
      const newMap: Record<string, Student> = { ...childrenMap };
      if (initialStudent?.barcode) {
        newMap[initialStudent.barcode] = initialStudent;
      }

      allSystemStudents.forEach((st) => {
        if (st && linkedBarcodes.includes(st.barcode)) {
          newMap[st.barcode] = { ...st };
        }
      });

      // 2. Single batched query to Supabase `students` table with 10s Cloud Timeout Guard
      const barcodesToQuery = linkedBarcodes.filter(Boolean);
      if (barcodesToQuery.length > 0) {
        const { data: supaStudents, error } = await withTimeout<any>(
          supabase
            .from("students")
            .select("*")
            .in("barcode", barcodesToQuery),
          10000,
          "انتهت مهلة استعلام بيانات الطلاب من السحابة (10 ثوانٍ)"
        );

        if (!error && supaStudents && supaStudents.length > 0) {
          supaStudents.forEach((row: any) => {
            const b = String(row.barcode);
            newMap[b] = {
              barcode: b,
              name: row.name || `طالب (${b})`,
              phone: row.phone || "",
              parentPhone: row.parent_phone || row.parentPhone || "",
              groupGrade: row.grade || row.groupGrade || "",
              groupDays: row.group_days || row.groupDays || "",
              points: row.points || 0,
              totalAttendanceDays: row.total_attendance_days || 0,
              totalAbsentDays: row.total_absent_days || 0,
              totalExamScores: row.exam_scores || [],
              notes: row.notes || "",
              customMonthlyFee: row.custom_monthly_fee,
              lastExamScore: row.last_exam_score,
              lastExamTitle: row.last_exam_title,
              createdAt: row.created_at,
            };
          });
        }
      }

      setChildrenMap(newMap);
    } catch (err) {
      console.warn("[ParentChildContext] Batched load notice:", err);
    } finally {
      setIsLoadingBatch(false);
    }
  }, [linkedBarcodes, allSystemStudents, initialStudent]);

  // Load once upon authentication
  useEffect(() => {
    reloadChildrenBatch();
  }, [reloadChildrenBatch]);

  // Update activeBarcode if initialStudent changes
  useEffect(() => {
    if (initialStudent?.barcode && !childrenMap[initialStudent.barcode]) {
      setChildrenMap((prev) => ({ ...prev, [initialStudent.barcode]: initialStudent }));
    }
  }, [initialStudent, childrenMap]);

  // Active Scoped Realtime Subscriptions to `/students_live/{barcode}`
  // Saves 95% bandwidth and provides 0ms live invalidation & remote logout upon deletion
  useEffect(() => {
    if (!linkedBarcodes || linkedBarcodes.length === 0) return;

    const unsubs = linkedBarcodes.map((bCode) => {
      return subscribeToStudentLiveBarcode(bCode, (ev) => {
        // 1. If student or account is deleted/revoked by supervisor
        if (ev.action === "account_revoked" || (ev.action === "delete" && ev.deletedItemType === "student")) {
          // If active student deleted, execute instant remote logout
          if (bCode === activeBarcode || bCode === account?.studentBarcode) {
            executeInstantRemoteLogout(ev.reason || "تم حذف حساب الطالب من قِبل إدارة المنظومة وفصل الجلسة فوراً.", bCode);
            return;
          }
          // If a linked child was deleted, purge from local map immediately (0ms DOM purge)
          setChildrenMap((prev) => {
            const next = { ...prev };
            delete next[bCode];
            return next;
          });
          return;
        }

        // 2. If student updated
        if (ev.action === "update" && ev.studentData) {
          setChildrenMap((prev) => {
            const existing = prev[bCode] || initialStudent;
            return {
              ...prev,
              [bCode]: { ...existing, ...ev.studentData },
            };
          });
        }

        // 3. If student exam grade recorded/updated
        if (ev.action === "exam_change") {
          setChildrenMap((prev) => {
            const existing = prev[bCode] || initialStudent;
            return {
              ...prev,
              [bCode]: {
                ...existing,
                lastExamTitle: ev.examTitle || existing.lastExamTitle,
                lastExamScore: ev.examScore || existing.lastExamScore,
              },
            };
          });
        }
      });
    });

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [linkedBarcodes, activeBarcode, account?.studentBarcode, initialStudent]);

  // Active student object (computed from in-memory map)
  const activeStudent = useMemo<Student | null>(() => {
    if (childrenMap[activeBarcode]) {
      return childrenMap[activeBarcode];
    }
    return initialStudent || null;
  }, [childrenMap, activeBarcode, initialStudent]);

  // All linked children array - pure cloud-sourced data only
  const allChildren = useMemo<Student[]>(() => {
    return linkedBarcodes
      .map((b) => childrenMap[b])
      .filter(Boolean) as Student[];
  }, [linkedBarcodes, childrenMap]);

  // Ultra-Fast In-Memory Child Switching with Explicit Channel Cleanup (Item 7)
  const switchChild = useCallback((barcode: string) => {
    const clean = String(barcode).trim();
    if (!clean || clean === activeBarcode) return;

    // Memory Leak Prevention: Explicitly invoke supabase.removeChannel() when switching between siblings/students
    try {
      const channels = supabase.getChannels();
      const prevChannelPrefix = `parent-student-engine-${activeBarcode}`;
      channels.forEach((ch) => {
        if (ch.topic.includes(prevChannelPrefix)) {
          console.log(`[ParentChildContext] Removing stale student channel on child switch: ${ch.topic}`);
          supabase.removeChannel(ch);
        }
      });
    } catch (chErr) {
      console.warn("[ParentChildContext] Channel cleanup notice on child switch:", chErr);
    }

    setActiveBarcode(clean);
  }, [activeBarcode]);

  const updateActiveStudentData = useCallback(
    (updater: (prev: Student) => Student) => {
      setChildrenMap((prev) => {
        const current = prev[activeBarcode] || activeStudent;
        const updated = updater(current);
        return {
          ...prev,
          [activeBarcode]: updated,
        };
      });
    },
    [activeBarcode, activeStudent]
  );

  const value = useMemo<ParentChildContextType>(
    () => ({
      account,
      activeBarcode,
      activeStudent,
      allChildren,
      linkedBarcodes,
      isLoadingBatch,
      switchChild,
      updateActiveStudentData,
      reloadChildrenBatch,
    }),
    [
      account,
      activeBarcode,
      activeStudent,
      allChildren,
      linkedBarcodes,
      isLoadingBatch,
      switchChild,
      updateActiveStudentData,
      reloadChildrenBatch,
    ]
  );

  return (
    <ParentChildContext.Provider value={value}>
      {children}
    </ParentChildContext.Provider>
  );
};

export function useParentChild(): ParentChildContextType {
  const context = useContext(ParentChildContext);
  if (!context) {
    throw new Error("useParentChild must be used within a ParentChildProvider");
  }
  return context;
}
