import React, { useState, useEffect, useCallback } from "react";
import { Student, PaymentRecord, GradeName } from "../../types";
import { ParentAccount, PortalSession } from "../../types/portal";
import {
  getSavedPortalSession,
  savePortalSession,
  syncParentAccountsFromCloud,
  subscribeToParentAccountLiveStatus,
} from "../../utils/portalStorage";
import { verifyParentAccountStatusInSupabase } from "../../utils/supabaseClient";
import { autoRequestPermissionAndSyncFCMToken } from "../../services/pushNotificationService";
import { PortalAuthScreen } from "./PortalAuthScreen";
import { ParentPortalDashboard } from "./ParentPortalDashboard";
import { AdminControlPanel } from "./AdminControlPanel";
import { ParentChildProvider } from "../../contexts/ParentChildContext";

interface PortalMasterAppProps {
  students: Student[];
  attendanceToday: Record<string, string>;
  attendanceHistory: Record<string, Record<string, string>>;
  payments: Record<string, Record<string, PaymentRecord>>;
  scanLogTimes: Record<string, string>;
  groupPrices?: Record<GradeName, number>;
}

export const PortalMasterApp: React.FC<PortalMasterAppProps> = ({
  students,
  attendanceToday,
  attendanceHistory,
  payments,
  scanLogTimes,
  groupPrices,
}) => {
  // Portal session state
  const [session, setSession] = useState<PortalSession | null>(() => {
    const saved = getSavedPortalSession();
    if (saved && (saved.role === "admin" || saved.isSupervisor)) {
      return {
        ...saved,
        role: "admin",
        isSupervisor: true,
      };
    }
    return saved;
  });

  // Notice when session is revoked remotely by admin (disable or delete)
  const [revocationNotice, setRevocationNotice] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      try {
        const params = new URLSearchParams(window.location.search);
        const notice = params.get("notice");
        if (notice) {
          // Clean URL without reloading
          const cleanUrl = window.location.pathname;
          window.history.replaceState({}, document.title, cleanUrl);
          return notice;
        }
      } catch {}
    }
    return null;
  });

  // Sync latest cloud accounts registry on mount
  useEffect(() => {
    syncParentAccountsFromCloud().catch(() => {});
  }, []);

  // Handle logout
  const handleLogout = useCallback((keepNotice: boolean = true) => {
    setSession(null);
    savePortalSession(null);
    if (!keepNotice) {
      setRevocationNotice(null);
    }
  }, []);

  // ⚡ Silent Background Check on App Launch against Supabase (Active vs Disabled/Deleted)
  // If active, keeps parent logged in instantly without showing the login screen.
  // Only terminates if explicitly disabled or deleted by supervisor in Supabase.
  useEffect(() => {
    if (session?.role !== "parent") return;
    const barcode = String(session.account?.studentBarcode || session.barcode || "").trim();
    if (!barcode) return;
    const phone = session.account?.parentPhone;

    verifyParentAccountStatusInSupabase(barcode, phone)
      .then((res) => {
        if (res.status === "disabled") {
          setRevocationNotice("تم تعطيل هذا الحساب من قِبل إدارة المنظومة.");
          handleLogout(true);
        } else if (res.status === "deleted") {
          setRevocationNotice("تم حذف هذا الحساب من قِبل إدارة المنظومة.");
          handleLogout(true);
        } else if (res.status === "active" && res.account) {
          setSession((prev) => (prev ? { ...prev, account: res.account } : prev));
        }
      })
      .catch((err) => {
        // Safe offline/transient fallback: Keep parent logged in
        console.warn("Silent background account status check notice:", err);
      });
  }, [session?.role, session?.barcode, session?.account?.studentBarcode, handleLogout]);

  // Window-level remote revocation event listener (from studentLiveSync or BroadcastChannel)
  useEffect(() => {
    const handleRevoked = (ev: Event) => {
      const customEv = ev as CustomEvent;
      const targetBarcode = String(customEv.detail?.barcode || "").trim();
      const reason = customEv.detail?.reason || "تم فصل الجلسة وإلغاء تنشيط الحساب من قِبل إدارة المنظومة.";

      // 🛡️ ISOLATE SUPERVISOR SESSION:
      // Never terminate supervisor/admin session context during account deletion or revocation
      if (session?.role === "admin" || session?.isSupervisor) {
        return;
      }

      // If current session is a parent, ONLY log out if the target barcode strictly matches this parent
      if (session?.role === "parent") {
        const myBarcode = String(session.account?.studentBarcode || session.barcode || "").trim();
        const linked = Array.isArray(session.account?.linkedBarcodes) ? session.account.linkedBarcodes.map(String) : [];
        if (targetBarcode && (targetBarcode === myBarcode || linked.includes(targetBarcode))) {
          setRevocationNotice(reason);
          handleLogout(true);
        }
      }
    };

    window.addEventListener("eman_account_revoked", handleRevoked);
    return () => {
      window.removeEventListener("eman_account_revoked", handleRevoked);
    };
  }, [handleLogout, session]);

  // Live remote logout watcher:
  // If admin explicitly disables or revokes account, force remote logout
  useEffect(() => {
    if (session?.role !== "parent" || !session.account?.studentBarcode) {
      return;
    }

    const currentBarcode = String(session.account.studentBarcode).trim();

    // Realtime listener across Firestore, BroadcastChannel, and storage events
    const unsubscribe = subscribeToParentAccountLiveStatus(
      currentBarcode,
      (reason) => {
        setRevocationNotice(reason);
        handleLogout(true);
      },
      session.account.activatedAt
    );

    return () => {
      unsubscribe();
    };
  }, [session?.role, session?.account?.studentBarcode, session?.account?.activatedAt, handleLogout]);

  // Handle successful login from AuthScreen: Immediately trigger notification permission & FCM token sync
  const handleLoginSuccess = (
    role: "parent" | "admin",
    account?: ParentAccount,
    barcode?: string
  ) => {
    setRevocationNotice(null);
    const newSession: PortalSession = {
      role,
      account,
      barcode: barcode || account?.studentBarcode || "1",
      token: `sess-${Date.now()}`,
      isSupervisor: role === "admin",
    };
    setSession(newSession);
    savePortalSession(newSession);

    // Auto-request notification permissions & VAPID FCM token generation with immediate Supabase update
    const targetId = account?.id || barcode || account?.studentBarcode || (role === "admin" ? "admin" : "parent");
    const aliases = [
      barcode,
      account?.studentBarcode,
      account?.parentPhone,
      ...(account?.linkedBarcodes || [])
    ].filter(Boolean) as string[];

    autoRequestPermissionAndSyncFCMToken(targetId, role, aliases).catch((err) => {
      console.warn("[PortalMasterApp] Auto notification sync notice:", err);
    });
  };

  // Background check on restored session: Ensure FCM token remains fresh and synced to Supabase
  useEffect(() => {
    if (session) {
      const targetId =
        session.account?.id ||
        session.barcode ||
        session.account?.studentBarcode ||
        (session.role === "admin" ? "admin" : "parent");
      const aliases = [
        session.barcode,
        session.account?.studentBarcode,
        session.account?.parentPhone,
        ...(session.account?.linkedBarcodes || [])
      ].filter(Boolean) as string[];

      // If already granted, refresh FCM token and update Supabase in background
      if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
        autoRequestPermissionAndSyncFCMToken(targetId, session.role, aliases).catch(() => {});
      }
    }
  }, [session?.role, session?.barcode]);

  // Update parent account in session state
  const handleUpdateAccount = (updated: ParentAccount) => {
    if (session && session.role === "parent") {
      const updatedSession: PortalSession = {
        ...session,
        account: updated,
      };
      setSession(updatedSession);
      savePortalSession(updatedSession);
    }
  };

  // 1. Not logged in -> Show Authentication / Registration Screen
  if (!session) {
    return (
      <PortalAuthScreen
        students={students}
        onLoginSuccess={handleLoginSuccess}
        revocationNotice={revocationNotice}
        onClearRevocationNotice={() => setRevocationNotice(null)}
      />
    );
  }

  // 2. Logged in as Admin / Supervisor -> Show Admin Control Panel
  if (session.role === "admin") {
    return (
      <AdminControlPanel
        students={students}
        onLogout={() => handleLogout(false)}
      />
    );
  }

  // 3. Logged in as Parent -> Show Parent Portal Dashboard
  if (session.role === "parent" && session.account) {
    const initialStudent: Student | null =
      students.find(
        (s) => String(s.barcode).trim() === String(session.account?.studentBarcode).trim()
      ) || null;

    return (
      <ParentChildProvider
        account={session.account}
        initialStudent={initialStudent}
        allSystemStudents={students}
      >
        <ParentPortalDashboard
          account={session.account}
          students={students}
          attendanceHistory={attendanceHistory}
          attendanceToday={attendanceToday}
          payments={payments}
          scanLogTimes={scanLogTimes}
          groupPrices={groupPrices}
          onLogout={() => handleLogout(false)}
          onUpdateAccount={handleUpdateAccount}
        />
      </ParentChildProvider>
    );
  }

  // Fallback if account data was missing
  return (
    <PortalAuthScreen
      students={students}
      onLoginSuccess={handleLoginSuccess}
      revocationNotice={revocationNotice}
      onClearRevocationNotice={() => setRevocationNotice(null)}
    />
  );
};
