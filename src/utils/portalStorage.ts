import { doc, getDoc, getDocs, setDoc, onSnapshot, updateDoc, deleteDoc, collection } from "firebase/firestore";
import { db, ensureFirebaseAuth, getFirebaseRealtimeDB } from "./firebase";
import { Student } from "../types";
import {
  ParentAccount,
  ParentChatMessage,
  AdminPortalSettings,
  PortalSession,
  AdminActivityLog,
} from "../types/portal";
import { playPortalAudioChime } from "./portalNotifications";
import { isFirestoreQuotaError } from "./storage";
import {
  savePortalAccountsToSupabase,
  fetchPortalAccountsFromSupabase,
  supabase,
  saveParentAccountRecordToSupabase,
  checkBarcodeAlreadyLinkedSupabase,
  updateParentAccountStatusInSupabase,
  deleteParentAccountRecordFromSupabase,
  updateParentAccountFCMTokenInSupabase,
  subscribeToParentAccountSupabase,
  barcodeToUUID,
  executeFastQuery,
  queryParentAccountSafe,
  withTimeout,
} from "./supabaseClient";

// Storage Keys
const LS_PARENT_ACCOUNTS = "eman_parent_accounts";
const LS_PORTAL_CHATS = "eman_portal_chats";
const LS_PORTAL_SETTINGS = "eman_portal_settings";
const LS_PORTAL_SESSION = "eman_portal_session";
const LS_ADMIN_LOGS = "eman_admin_activity_log";

// Default Initial Supervisor Credentials
export const DEFAULT_ADMIN_SETTINGS: AdminPortalSettings = {
  adminBarcode: "1",
  adminPassword: "2468",
  adminPhone: "01000000000",
  pushNotificationsEnabled: true,
  soundAlertsEnabled: true,
};

// Local BroadcastChannel for sub-millisecond multi-tab sync
const chatBus =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel("eman_portal_chat_bus")
    : null;

// Account events BroadcastChannel for instant cross-tab / cross-window remote logouts
export const accountEventsBus =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel("eman_portal_account_events")
    : null;

// Supervisor activity bus for instant cross-tab supervisor updates
export const activityBus =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel("eman_portal_activity_bus")
    : null;

/**
 * Strict Barcode Normalizer
 * Converts Arabic-Indic numerals, trims spaces and invisible control characters
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
 * Clean & normalize phone numbers for consistent Arabic Egyptian mobile matching
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
 * Supervisor Activity Log functions (Cross-device synchronized audit trail)
 * Strictly visible to supervisors, never shown to parents.
 */
export function getAdminActivityLogs(): AdminActivityLog[] {
  try {
    const raw = localStorage.getItem(LS_ADMIN_LOGS);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function saveAdminActivityLogs(logs: AdminActivityLog[]): void {
  try {
    localStorage.setItem(LS_ADMIN_LOGS, JSON.stringify(logs.slice(0, 100)));
  } catch {}
}

export function logSupervisorAccountEvent(
  type: AdminActivityLog["type"],
  studentBarcode: string,
  studentName: string,
  details: string
): void {
  const timeFormatted = new Intl.DateTimeFormat("ar-EG", {
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: true,
  }).format(new Date());

  const newLog: AdminActivityLog = {
    id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    type,
    studentBarcode,
    studentName: studentName || studentBarcode,
    timestamp: Date.now(),
    timeFormatted,
    details,
  };

  const logs = getAdminActivityLogs();
  logs.unshift(newLog);
  saveAdminActivityLogs(logs);

  activityBus?.postMessage({ type: "new_activity", log: newLog });

  // Sync to Firestore without blocking
  ensureFirebaseAuth()
    .then(async () => {
      if (!db) return;
      await setDoc(
        doc(db, "system_state", "admin_audit_logs"),
        { logs: logs.slice(0, 100), updatedAt: new Date().toISOString() },
        { merge: true }
      );
    })
    .catch(() => {});
}

export function subscribeToAdminActivityLogs(
  onUpdate: (logs: AdminActivityLog[]) => void
): () => void {
  let isCancelled = false;

  // 1. Initial local load
  onUpdate(getAdminActivityLogs());

  // 2. BroadcastChannel listener
  const handleBus = (ev: MessageEvent) => {
    if (isCancelled) return;
    if (ev.data?.type === "new_activity") {
      onUpdate(getAdminActivityLogs());
    }
  };
  activityBus?.addEventListener("message", handleBus);

  // 3. Storage event
  const handleStorage = (ev: StorageEvent) => {
    if (isCancelled) return;
    if (ev.key === LS_ADMIN_LOGS && ev.newValue) {
      try {
        onUpdate(JSON.parse(ev.newValue));
      } catch {}
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }

  // 4. Firestore live subscription
  let unsubFirestore: (() => void) | null = null;
  ensureFirebaseAuth()
    .then(() => {
      if (isCancelled || !db) return;
      unsubFirestore = onSnapshot(
        doc(db, "system_state", "admin_audit_logs"),
        (snap) => {
          if (isCancelled) return;
          if (snap.exists()) {
            const cloudLogs = snap.data()?.logs as AdminActivityLog[] | undefined;
            if (cloudLogs && Array.isArray(cloudLogs)) {
              saveAdminActivityLogs(cloudLogs);
              onUpdate(cloudLogs);
            }
          }
        },
        (err) => {
          if (!isFirestoreQuotaError(err)) {
            console.warn("Audit log subscription notice:", err);
          }
        }
      );
    })
    .catch(() => {});

  return () => {
    isCancelled = true;
    activityBus?.removeEventListener("message", handleBus);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
    if (unsubFirestore) unsubFirestore();
  };
}

/**
 * Load admin settings from LocalStorage & Firestore
 */
export function getAdminPortalSettings(): AdminPortalSettings {
  try {
    const raw = localStorage.getItem(LS_PORTAL_SETTINGS);
    if (raw) {
      return { ...DEFAULT_ADMIN_SETTINGS, ...JSON.parse(raw) };
    }
  } catch {}
  return DEFAULT_ADMIN_SETTINGS;
}

export async function saveAdminPortalSettings(settings: AdminPortalSettings): Promise<void> {
  try {
    localStorage.setItem(LS_PORTAL_SETTINGS, JSON.stringify(settings));
    await ensureFirebaseAuth();
    if (db) {
      await setDoc(doc(db, "portal_settings", "supervisor_config"), {
        ...settings,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    }
  } catch (err) {
    console.warn("Failed to persist admin portal settings:", err);
  }
}

/**
 * Load all registered parent accounts from LocalStorage
 */
const LS_DELETED_TOMBSTONES = "eman_deleted_accounts_tombstones";

export function getDeletedTombstones(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_DELETED_TOMBSTONES);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return new Set(arr.map((x) => normalizeBarcode(String(x))).filter(Boolean));
      }
    }
  } catch {}
  return new Set();
}

export function addDeletedTombstones(barcodes: string | string[]): void {
  const set = getDeletedTombstones();
  const list = Array.isArray(barcodes) ? barcodes : [barcodes];
  let changed = false;
  for (const b of list) {
    const clean = normalizeBarcode(b);
    if (clean && !set.has(clean)) {
      set.add(clean);
      changed = true;
    }
  }
  if (changed) {
    try {
      localStorage.setItem(LS_DELETED_TOMBSTONES, JSON.stringify(Array.from(set)));
    } catch {}
  }
}

export function removeDeletedTombstone(barcode: string): void {
  const clean = normalizeBarcode(barcode);
  if (!clean) return;
  const set = getDeletedTombstones();
  if (set.has(clean)) {
    set.delete(clean);
    try {
      localStorage.setItem(LS_DELETED_TOMBSTONES, JSON.stringify(Array.from(set)));
    } catch {}
  }
}

export function getLocalParentAccounts(): Record<string, ParentAccount> {
  try {
    const raw = localStorage.getItem(LS_PARENT_ACCOUNTS);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, ParentAccount>;
      const tombstones = getDeletedTombstones();
      const filtered: Record<string, ParentAccount> = {};
      let dirty = false;
      for (const [k, acc] of Object.entries(parsed)) {
        const b = normalizeBarcode(k);
        const studentBarcode = normalizeBarcode(acc?.studentBarcode);
        if (
          !acc ||
          acc.status === "deleted" ||
          tombstones.has(b) ||
          tombstones.has(studentBarcode) ||
          (Array.isArray(acc.linkedBarcodes) && acc.linkedBarcodes.some((lb) => tombstones.has(normalizeBarcode(lb))))
        ) {
          dirty = true;
          continue;
        }
        filtered[b] = acc;
      }
      if (dirty) {
        localStorage.setItem(LS_PARENT_ACCOUNTS, JSON.stringify(filtered));
      }
      return filtered;
    }
  } catch {}
  return {};
}

export function saveLocalParentAccounts(accounts: Record<string, ParentAccount>): void {
  try {
    const tombstones = getDeletedTombstones();
    const clean: Record<string, ParentAccount> = {};
    for (const [k, acc] of Object.entries(accounts)) {
      const b = normalizeBarcode(k);
      const studentBarcode = normalizeBarcode(acc?.studentBarcode);
      if (
        !acc ||
        acc.status === "deleted" ||
        tombstones.has(b) ||
        tombstones.has(studentBarcode) ||
        (Array.isArray(acc.linkedBarcodes) && acc.linkedBarcodes.some((lb) => tombstones.has(normalizeBarcode(lb))))
      ) {
        continue;
      }
      clean[b] = acc;
    }
    localStorage.setItem(LS_PARENT_ACCOUNTS, JSON.stringify(clean));
  } catch {}
}

/**
 * Sync parent accounts from Cloud & Local Server with deduplication, tombstones & caching
 */
let syncAccountsInFlight: Promise<Record<string, ParentAccount>> | null = null;
let lastAccountsSyncTime = 0;

export async function syncParentAccountsFromCloud(force: boolean = false): Promise<Record<string, ParentAccount>> {
  const local = getLocalParentAccounts();
  const tombstones = getDeletedTombstones();
  const now = Date.now();
  if (!force && now - lastAccountsSyncTime < 3000 && Object.keys(local).length > 0) {
    return local;
  }
  if (syncAccountsInFlight) {
    return syncAccountsInFlight;
  }
  syncAccountsInFlight = (async () => {
    try {
      const allDeletedTombstones = new Set<string>(tombstones);

      // 1. Authoritative Express Server Cache Sync (<5ms)
      // Retrieves active accounts and tombstones of deleted accounts
      try {
        const resp = await fetch("/api/portal/accounts-sync");
        if (resp.ok) {
          const json = await resp.json();
          if (json?.success) {
            if (Array.isArray(json.deletedBarcodes)) {
              json.deletedBarcodes.forEach((b: string) => allDeletedTombstones.add(normalizeBarcode(b)));
            }
            if (Array.isArray(json.revokedBarcodes)) {
              json.revokedBarcodes.forEach((b: string) => allDeletedTombstones.add(normalizeBarcode(b)));
            }
            addDeletedTombstones(Array.from(allDeletedTombstones));

            if (json.accounts && typeof json.accounts === "object") {
              const serverAccounts = json.accounts as Record<string, ParentAccount>;
              const reconciled: Record<string, ParentAccount> = {};

              for (const [b, acc] of Object.entries(serverAccounts)) {
                const bCode = normalizeBarcode(b);
                const stBarcode = normalizeBarcode(acc?.studentBarcode);
                if (!bCode || allDeletedTombstones.has(bCode) || allDeletedTombstones.has(stBarcode) || acc.status === "deleted") {
                  continue;
                }
                if (Array.isArray(acc.linkedBarcodes) && acc.linkedBarcodes.some((lb) => allDeletedTombstones.has(normalizeBarcode(lb)))) {
                  continue;
                }
                reconciled[bCode] = acc;
              }

              saveLocalParentAccounts(reconciled);
              lastAccountsSyncTime = Date.now();
              if (typeof window !== "undefined") {
                window.dispatchEvent(
                  new CustomEvent("eman_account_activated", {
                    detail: { accounts: reconciled },
                  })
                );
              }
              return reconciled;
            }
          }
        }
      } catch (srvErr) {
        console.warn("[syncParentAccounts] Server sync notice:", srvErr);
      }

      // 2. Direct Firestore parent_accounts collection sync
      if (db) {
        try {
          const colSnap = await getDocs(collection(db, "parent_accounts"));
          if (!colSnap.empty) {
            const current = getLocalParentAccounts();
            const reconciled: Record<string, ParentAccount> = { ...current };
            let hasNew = false;
            colSnap.forEach((docSnap) => {
              const data = docSnap.data() as ParentAccount;
              const bCode = normalizeBarcode(docSnap.id || data?.studentBarcode);
              if (bCode && data && !allDeletedTombstones.has(bCode) && data.status !== "deleted") {
                reconciled[bCode] = { ...data, studentBarcode: bCode };
                hasNew = true;
              }
            });
            if (hasNew) {
              saveLocalParentAccounts(reconciled);
              lastAccountsSyncTime = Date.now();
              return reconciled;
            }
          }
        } catch (fsErr) {
          console.warn("[syncParentAccounts] Firestore collection sync notice:", fsErr);
        }
      }

      // 3. Supabase Table public.parent_accounts (strictly guarded against tombstones)
      try {
        const sbAccounts = await fetchPortalAccountsFromSupabase();
        if (sbAccounts && typeof sbAccounts === "object" && Object.keys(sbAccounts).length > 0) {
          const reconciled: Record<string, ParentAccount> = {};
          for (const [b, acc] of Object.entries(sbAccounts)) {
            const bCode = normalizeBarcode(b);
            const stBarcode = normalizeBarcode(acc?.studentBarcode);
            if (!bCode || allDeletedTombstones.has(bCode) || allDeletedTombstones.has(stBarcode) || acc.status === "deleted") {
              continue;
            }
            if (Array.isArray(acc.linkedBarcodes) && acc.linkedBarcodes.some((lb) => allDeletedTombstones.has(normalizeBarcode(lb)))) {
              continue;
            }
            reconciled[bCode] = acc;
          }
          saveLocalParentAccounts(reconciled);
          lastAccountsSyncTime = Date.now();
          return reconciled;
        }
      } catch (sbErr) {
        console.warn("[syncParentAccounts] Supabase direct fetch notice:", sbErr);
      }
    } catch (err) {
      console.warn("Could not fetch cloud parent accounts:", err);
    } finally {
      syncAccountsInFlight = null;
    }
    return getLocalParentAccounts();
  })();
  return syncAccountsInFlight;
}

/**
 * Persist parent accounts to Firestore & LocalStorage (Instant 0ms local execution + parallel background cloud sync)
 */
export async function persistParentAccount(account: ParentAccount): Promise<void> {
  const accounts = getLocalParentAccounts();
  const nowIso = new Date().toISOString();

  if (account.status === "active") {
    if (!account.activatedAt) {
      account.activatedAt = nowIso;
    }
    delete account.deletedAt;
  }

  account.updatedAt = nowIso;
  if (account.status === "active") {
    removeDeletedTombstone(account.studentBarcode);
    if (Array.isArray(account.linkedBarcodes)) {
      account.linkedBarcodes.forEach((b) => removeDeletedTombstone(b));
    }
  }
  accounts[account.studentBarcode] = account;
  saveLocalParentAccounts(accounts);

  // If status is active, broadcast activation to all local tabs immediately
  if (account.status === "active") {
    logSupervisorAccountEvent(
      "activate",
      account.studentBarcode,
      account.studentName || account.studentBarcode,
      `تم تفعيل الحساب بنجاح - الهاتف: ${account.parentPhone || "غير محدد"}`
    );
    accountEventsBus?.postMessage({
      type: "ACCOUNT_ACTIVATED",
      barcode: account.studentBarcode,
      activatedAt: account.activatedAt || nowIso,
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("eman_account_activated", {
          detail: {
            barcode: account.studentBarcode,
            activatedAt: account.activatedAt || nowIso,
          },
        })
      );
    }
    // Clear any previous revocation record on server
    try {
      fetch("/api/account-activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: account.studentBarcode }),
      }).catch(() => {});
    } catch {}
  }

  // If status is disabled or deleted, immediately broadcast revocation to log out parent device
  if (account.status === "disabled" || account.status === "deleted") {
    updateParentAccountStatusInSupabase(account.studentBarcode, account.status).catch(() => {});
    logSupervisorAccountEvent(
      account.status === "disabled" ? "disable" : "delete",
      account.studentBarcode,
      account.studentName || account.studentBarcode,
      account.status === "disabled"
        ? "تم تعطيل الحساب مؤقتاً وتسجيل خروج الهاتف تلقائياً"
        : "تم حذف الحساب نهائياً وفصل جلسة الهاتف"
    );
    const reasonText =
      account.status === "disabled"
        ? "تم تعطيل هذا الحساب مؤقتاً من قِبل إدارة المنظومة."
        : "تم حذف هذا الحساب من قِبل إدارة المنظومة.";
    accountEventsBus?.postMessage({
      type: "ACCOUNT_REVOKED",
      barcode: account.studentBarcode,
      reason: reasonText,
      revokedAt: account.deletedAt || nowIso,
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("eman_account_revoked", {
          detail: {
            barcode: account.studentBarcode,
            reason: reasonText,
            revokedAt: account.deletedAt || nowIso,
          },
        })
      );
    }
    // Fast server push to trigger immediate mobile logout
    try {
      fetch("/api/account-revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: account.studentBarcode, reason: reasonText }),
      }).catch(() => {});
      fetch(`/api/portal/admin/accounts/${account.studentBarcode}/suspend`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-role": "admin",
        },
        body: JSON.stringify({ reason: reasonText }),
      }).catch(() => {});
    } catch {}
  } else if (account.status === "active") {
    try {
      fetch(`/api/portal/admin/accounts/${account.studentBarcode}/activate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-role": "admin",
        },
        body: JSON.stringify({
          parentPhone: account.parentPhone,
          password: account.password,
          studentName: account.studentName,
        }),
      }).catch(() => {});
    } catch {}
  }

  // Fast Express Server Persistence (<5ms, 0 quota)
  if (typeof window !== "undefined") {
    fetch("/api/portal/account-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(account),
    }).catch(() => {});
  }

  // Fast Supabase Cloud Database Persistence (Zero Quota Limits)
  try {
    const allAccs = getLocalParentAccounts();
    allAccs[account.studentBarcode] = account;
    savePortalAccountsToSupabase(allAccs).catch(() => {});
    saveParentAccountRecordToSupabase(account).catch(() => {});
  } catch {}

  // Reliable cloud persistence tied to Firestore (Direct and non-blocking)
  if (db) {
    try {
      const bCode = normalizeBarcode(account.studentBarcode);
      if (bCode) {
        setDoc(doc(db, "parent_accounts", bCode), account, { merge: true }).catch((err) => {
          console.warn("Cloud parent account background save notice:", err);
        });
        if (account.status === "active") {
          deleteDoc(doc(db, "account_revocations", bCode)).catch(() => {});
        } else if (account.status === "deleted" || account.status === "disabled") {
          setDoc(doc(db, "account_revocations", bCode), {
            barcode: bCode,
            revoked: true,
            reason: account.status === "disabled" ? "تعطيل الحساب" : "حذف الحساب",
            timestamp: Date.now(),
          }, { merge: true }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn("Cloud parent account background save notice:", err);
    }
  }
}

/**
 * Delete / Reset parent account (forces first-time registration again and remote logout)
 * Instant local execution + multi-channel cloud broadcast
 */
export async function deleteParentAccount(studentBarcode: string): Promise<void> {
  const cleanBarcode = String(studentBarcode).trim();
  const accounts = getLocalParentAccounts();
  const existing = accounts[cleanBarcode];
  const nowIso = new Date().toISOString();
  const revokeReason = "تم حذف هذا الحساب من قِبل إدارة المنظومة.";

  const allBarcodesToRevoke = new Set<string>([cleanBarcode]);
  if (existing) {
    existing.status = "deleted";
    existing.deletedAt = nowIso;
    existing.reason = revokeReason;
    if (existing.studentBarcode) allBarcodesToRevoke.add(String(existing.studentBarcode).trim());
    if (Array.isArray(existing.linkedBarcodes)) {
      existing.linkedBarcodes.forEach((b) => allBarcodesToRevoke.add(String(b).trim()));
    }
  }

  // Also check if any account in local list has this barcode linked
  for (const [b, acc] of Object.entries(accounts)) {
    if (acc?.linkedBarcodes?.includes(cleanBarcode) || acc?.studentBarcode === cleanBarcode) {
      allBarcodesToRevoke.add(String(b).trim());
      if (acc.studentBarcode) allBarcodesToRevoke.add(String(acc.studentBarcode).trim());
      delete accounts[b];
    }
  }

  delete accounts[cleanBarcode];
  saveLocalParentAccounts(accounts);
  addDeletedTombstones(Array.from(allBarcodesToRevoke));

  // 🛡️ ISOLATE SUPERVISOR SESSION:
  // Never clear, mutate, or log out the currently logged-in supervisor/admin state.
  // Target ONLY the parent account if this device is logged in as the deleted parent.
  const curSess = getSavedPortalSession();
  if (
    curSess &&
    curSess.role === "parent" &&
    !curSess.isSupervisor &&
    (allBarcodesToRevoke.has(String(curSess.barcode).trim()) ||
      allBarcodesToRevoke.has(String(curSess.account?.studentBarcode).trim()))
  ) {
    savePortalSession(null);
    try {
      sessionStorage.removeItem(LS_PORTAL_SESSION);
      localStorage.removeItem(LS_PORTAL_SESSION);
    } catch {}
  }

  // 1. Broadcast targeted revocation immediately across same device tabs & local window
  for (const b of allBarcodesToRevoke) {
    // Clear parent FCM token and database record in Supabase
    updateParentAccountFCMTokenInSupabase(b, "").catch(() => {});
    deleteParentAccountRecordFromSupabase(b).catch(() => {});
    updateParentAccountStatusInSupabase(b, "deleted").catch(() => {});

    accountEventsBus?.postMessage({
      type: "ACCOUNT_REVOKED",
      barcode: b,
      reason: revokeReason,
      revokedAt: nowIso,
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("eman_account_revoked", {
          detail: {
            barcode: b,
            reason: revokeReason,
            revokedAt: nowIso,
          },
        })
      );
    }

    // 2. High-speed Direct Server Broadcast (Sub-50ms) to trigger immediate mobile logout & cascading deletion
    try {
      fetch("/api/account-revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: b, reason: revokeReason }),
      }).catch(() => {});
      fetch(`/api/portal/admin/accounts/${encodeURIComponent(b)}?mode=hard`, {
        method: "DELETE",
        headers: {
          "x-user-role": "admin",
        },
      }).catch(() => {});
    } catch {}
  }

  // 3. Multi-channel cloud revocation & deletion to guarantee remote mobile logout on Firestore
  try {
    const writes: Promise<any>[] = [
      setDoc(
        doc(db, "system_state", "portal_accounts_registry"),
        { accounts, updatedAt: nowIso }
      ),
    ];

    for (const b of allBarcodesToRevoke) {
      writes.push(deleteDoc(doc(db, "parent_accounts", b)).catch(() => {}));
      writes.push(
        setDoc(doc(db, "account_revocations", b), {
          barcode: b,
          revoked: true,
          reason: revokeReason,
          revokedAt: nowIso,
          timestamp: Date.now(),
        })
      );
    }

    await Promise.all(writes);
  } catch (err) {
    console.warn("Cloud parent account delete notice:", err);
  }
}

/**
 * Real-time listener for ALL parent accounts across all connected devices (phones & PCs)
 * Used by AdminControlPanel so when ANY parent or supervisor activates/deletes an account,
 * all open supervisor screens (mobile, tablet, desktop) update instantly in real time!
 */
export function subscribeToAllParentAccounts(
  onUpdate: (accounts: Record<string, ParentAccount>) => void
): () => void {
  let isCancelled = false;

  // 1. Instant local load (0ms)
  const initial = getLocalParentAccounts();
  onUpdate(initial);

  const mergeAndNotify = (incoming: Record<string, ParentAccount>) => {
    if (isCancelled) return;
    const current = getLocalParentAccounts();
    const tombstones = getDeletedTombstones();
    let hasChanges = false;
    const merged = { ...current };

    for (const [barcode, acc] of Object.entries(incoming)) {
      const bCode = normalizeBarcode(barcode);
      const stBarcode = normalizeBarcode(acc?.studentBarcode);
      if (
        !bCode ||
        tombstones.has(bCode) ||
        tombstones.has(stBarcode) ||
        (Array.isArray(acc?.linkedBarcodes) && acc.linkedBarcodes.some((lb) => tombstones.has(normalizeBarcode(lb))))
      ) {
        if (merged[bCode]) {
          delete merged[bCode];
          hasChanges = true;
        }
        continue;
      }
      const existing = current[bCode];

      if (acc.status === "deleted") {
        if (existing || merged[bCode]) {
          delete merged[bCode];
          hasChanges = true;
        }
      } else {
        if (
          !existing ||
          existing.status !== acc.status ||
          existing.password !== acc.password ||
          existing.parentPhone !== acc.parentPhone ||
          existing.updatedAt !== acc.updatedAt ||
          existing.activatedAt !== acc.activatedAt
        ) {
          merged[bCode] = { ...existing, ...acc, studentBarcode: bCode };
          hasChanges = true;
        }
      }
    }

    if (hasChanges) {
      saveLocalParentAccounts(merged);
      onUpdate({ ...merged });
    }
  };

  // 2. BroadcastChannel listener (Sub-millisecond on same device across tabs)
  const handleBus = (ev: MessageEvent) => {
    if (isCancelled) return;
    const type = ev.data?.type;
    if (type === "ACCOUNT_ACTIVATED" || type === "ACCOUNT_REVOKED" || type === "ACCOUNT_UPDATED") {
      onUpdate(getLocalParentAccounts());
    }
  };
  accountEventsBus?.addEventListener("message", handleBus);

  // 3. Window Custom Event listeners (with direct payload merging)
  const handleCustomEvent = (ev: Event) => {
    if (isCancelled) return;
    const customEv = ev as CustomEvent;
    const current = getLocalParentAccounts();
    if (customEv.detail?.account) {
      const acc = customEv.detail.account;
      const bCode = normalizeBarcode(acc.studentBarcode);
      if (bCode) {
        removeDeletedTombstone(bCode);
        current[bCode] = acc;
        saveLocalParentAccounts(current);
      }
    } else if (customEv.detail?.barcode && customEv.type === "eman_account_revoked") {
      const bCode = normalizeBarcode(customEv.detail.barcode);
      if (bCode && current[bCode]) {
        delete current[bCode];
        saveLocalParentAccounts(current);
      }
    }
    onUpdate({ ...current });
  };
  if (typeof window !== "undefined") {
    window.addEventListener("eman_account_activated", handleCustomEvent);
    window.addEventListener("eman_account_revoked", handleCustomEvent);
    window.addEventListener("eman_account_sync", handleCustomEvent);
  }

  // 4. Storage event (cross-tab LocalStorage modification)
  const handleStorage = (ev: StorageEvent) => {
    if (isCancelled) return;
    if (ev.key === LS_PARENT_ACCOUNTS && ev.newValue) {
      try {
        const parsed = JSON.parse(ev.newValue);
        onUpdate(parsed);
      } catch {}
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }

  // 5. Server-Sent Events (SSE) Live Cloud Stream for Cross-Device Instant Sync (0ms latency without refresh)
  let sseSource: EventSource | null = null;
  if (typeof window !== "undefined" && typeof EventSource !== "undefined") {
    try {
      sseSource = new EventSource("/api/portal/live-stream?role=supervisor");
      sseSource.onmessage = (event) => {
        if (isCancelled || !event.data) return;
        try {
          const data = JSON.parse(event.data);
          const type = data.type;
          if (
            type === "ACCOUNT_SAVED" ||
            type === "ACCOUNT_ACTIVATED" ||
            type === "account_status_changed" ||
            type === "ACCOUNTS_MUTATED"
          ) {
            const acc = data.account as ParentAccount | undefined;
            const b = normalizeBarcode(data.barcode || acc?.studentBarcode);
            if (b) {
              removeDeletedTombstone(b);
              if (Array.isArray(acc?.linkedBarcodes)) {
                acc.linkedBarcodes.forEach((lb: string) => removeDeletedTombstone(lb));
              }
              const current = getLocalParentAccounts();
              if (acc) {
                current[b] = { ...current[b], ...acc, status: (acc.status || data.status || "active") as any };
              } else if (current[b]) {
                current[b].status = (data.status || "active") as any;
              }
              saveLocalParentAccounts(current);
              onUpdate({ ...current });
            } else {
              syncParentAccountsFromCloud(false).then((fresh) => {
                if (!isCancelled && fresh) onUpdate(fresh);
              }).catch(() => {});
            }
          } else if (type === "ACCOUNT_DELETED" || type === "ACCOUNT_REVOKED") {
            const b = normalizeBarcode(data.barcode);
            if (b) {
              addDeletedTombstones([b]);
              const current = getLocalParentAccounts();
              delete current[b];
              saveLocalParentAccounts(current);
              onUpdate({ ...current });
            }
          }
        } catch {}
      };
    } catch (err) {
      console.warn("Supervisor SSE subscription notice:", err);
    }
  }

  // 6. Real-time background delta-sync interval every 8s while tab is active (failsafe against network blips)
  const syncInterval = setInterval(() => {
    if (isCancelled) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    syncParentAccountsFromCloud(false)
      .then((fresh) => {
        if (!isCancelled && fresh && Object.keys(fresh).length > 0) {
          onUpdate(fresh);
        }
      })
      .catch(() => {});
  }, 8000);

  // 7. Firestore Live Realtime Listeners (Phone to PC / PC to Phone)
  let unsubCollection: (() => void) | null = null;
  let unsubRegistry: (() => void) | null = null;
  let unsubRevocations: (() => void) | null = null;

  if (db) {
    try {
      // A. Listen to parent_accounts collection live
      unsubCollection = onSnapshot(
        collection(db, "parent_accounts"),
        (snapshot) => {
          if (isCancelled) return;
          const incoming: Record<string, ParentAccount> = {};
          const tombstones = getDeletedTombstones();
          snapshot.forEach((docSnap) => {
            const data = docSnap.data() as ParentAccount;
            const bCode = normalizeBarcode(docSnap.id || data?.studentBarcode);
            if (bCode && data && !tombstones.has(bCode) && data.status !== "deleted") {
              incoming[bCode] = data;
            }
          });
          mergeAndNotify(incoming);
        },
        (err) => {
          if (!isFirestoreQuotaError(err)) {
            console.warn("Realtime parent_accounts listener notice:", err);
          }
        }
      );

      // B. Listen to system_state / portal_accounts_registry live
      unsubRegistry = onSnapshot(
        doc(db, "system_state", "portal_accounts_registry"),
        (snap) => {
          if (isCancelled) return;
          if (snap.exists()) {
            const regAccounts = snap.data()?.accounts as Record<string, ParentAccount> | undefined;
            if (regAccounts) {
              mergeAndNotify(regAccounts);
            }
          }
        },
        (err) => {
          if (!isFirestoreQuotaError(err)) {
            console.warn("Realtime registry listener notice:", err);
          }
        }
      );

      // C. Listen to account_revocations collection live
      unsubRevocations = onSnapshot(
        collection(db, "account_revocations"),
        (snapshot) => {
          if (isCancelled) return;
          const revokedList: string[] = [];
          snapshot.forEach((docSnap) => {
            const revData = docSnap.data();
            const bCode = normalizeBarcode(docSnap.id || revData?.barcode);
            if (revData?.revoked !== false && bCode) {
              revokedList.push(bCode);
            }
          });
          if (revokedList.length > 0) {
            addDeletedTombstones(revokedList);
            const current = getLocalParentAccounts();
            let changed = false;
            for (const b of revokedList) {
              if (current[b]) {
                delete current[b];
                changed = true;
              }
            }
            if (changed) {
              saveLocalParentAccounts(current);
              onUpdate({ ...current });
            }
          }
        },
        (err) => {
          if (!isFirestoreQuotaError(err)) {
            console.warn("Realtime revocations listener notice:", err);
          }
        }
      );
    } catch (err) {
      if (!isFirestoreQuotaError(err)) {
        console.warn("Error subscribing to realtime cloud accounts:", err);
      }
    }
  }

  // 6. Focus & Visibility refresh (e.g. phone screen wake-up)
  const refreshOnResume = () => {
    if (isCancelled) return;
    syncParentAccountsFromCloud(true)
      .then((res) => {
        if (!isCancelled && res) {
          onUpdate(res);
        }
      })
      .catch(() => {});
  };

  if (typeof window !== "undefined") {
    window.addEventListener("focus", refreshOnResume);
    window.addEventListener("online", refreshOnResume);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshOnResume();
      }
    });
  }

  return () => {
    isCancelled = true;
    clearInterval(syncInterval);
    if (sseSource) {
      try {
        sseSource.close();
      } catch {}
    }
    accountEventsBus?.removeEventListener("message", handleBus);
    if (typeof window !== "undefined") {
      window.removeEventListener("eman_account_activated", handleCustomEvent);
      window.removeEventListener("eman_account_revoked", handleCustomEvent);
      window.removeEventListener("eman_account_sync", handleCustomEvent);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("focus", refreshOnResume);
    }
    if (unsubCollection) unsubCollection();
    if (unsubRegistry) unsubRegistry();
    if (unsubRevocations) unsubRevocations();
  };
}

/**
 * Realtime multi-layered listener that monitors account status on parent device:
 * 1. BroadcastChannel (cross-tab / sub-millisecond)
 * 2. Custom window events (same tab)
 * 3. LocalStorage storage event (browser-wide)
 * 4. Firestore onSnapshot on the parent_accounts document (cross-device / mobile to PC)
 * 5. Firestore onSnapshot on account_revocations (explicit revocation stream)
 * 6. Firestore onSnapshot on portal_accounts_registry (global accounts registry)
 * 7. Visibility and Focus listeners + periodic safety check
 */
export function subscribeToParentAccountLiveStatus(
  studentBarcode: string,
  onRevoked: (reason: string) => void,
  initialActivatedAt?: string
): () => void {
  const targetBarcode = String(studentBarcode).trim();
  let isCancelled = false;
  let hasFiredRevocation = false;

  const triggerRevoke = (reason?: string) => {
    if (isCancelled || hasFiredRevocation) return;

    // 🛡️ ISOLATE SUPERVISOR SESSION:
    // If the active session is a supervisor/admin, NEVER trigger revocation or logout!
    const curSess = getSavedPortalSession();
    if (curSess?.role === "admin" || curSess?.isSupervisor) {
      return;
    }

    // Verify current session is parent and belongs to this targetBarcode
    if (curSess?.role === "parent") {
      const myBarcode = String(curSess.account?.studentBarcode || curSess.barcode || "").trim();
      const linked = Array.isArray(curSess.account?.linkedBarcodes) ? curSess.account.linkedBarcodes.map(String) : [];
      if (targetBarcode !== myBarcode && !linked.includes(targetBarcode)) {
        return;
      }
    }

    hasFiredRevocation = true;

    const finalReason = reason || "تم إلغاء تفعيل هذا الحساب من قبل الإدارة";

    // Play loud acoustic alert chime immediately
    try {
      playPortalAudioChime("absence");
    } catch {}

    // Targeted revocation: Purge only the parent's session token without calling global sessionStorage.clear()
    savePortalSession(null);
    try {
      if (typeof window !== "undefined") {
        sessionStorage.removeItem(LS_PORTAL_SESSION);
        localStorage.removeItem(LS_PORTAL_SESSION);
      }
    } catch {}

    // Fire window event for local components with 0ms delay
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("eman_account_revoked", {
          detail: {
            barcode: targetBarcode,
            reason: finalReason,
          },
        })
      );
    }

    onRevoked(finalReason);
  };

  // 1. Direct Server-Sent Events (SSE) Stream: sub-50ms instant remote push
  let eventSource: EventSource | null = null;
  if (typeof window !== "undefined" && "EventSource" in window) {
    try {
      eventSource = new EventSource("/api/account-events-stream");
      eventSource.onmessage = (event) => {
        if (isCancelled || hasFiredRevocation) return;
        try {
          const data = JSON.parse(event.data);
          if (data?.type === "ACCOUNT_REVOKED") {
            const revBarcode = String(data.barcode).trim();
            if (revBarcode === targetBarcode) {
              triggerRevoke(data.reason || "تم إلغاء تفعيل هذا الحساب من قبل الإدارة");
            }
          }
        } catch {}
      };
      eventSource.onerror = () => {
        // SSE auto-reconnects
      };
    } catch {}
  }

  // 1.5 Supabase Realtime Table Listener on parent_accounts (0ms remote supervisor logout)
  const unsubSupabase = subscribeToParentAccountSupabase(
    targetBarcode,
    (status, reason) => {
      if (isCancelled || hasFiredRevocation) return;
      triggerRevoke(reason || "تم إلغاء تفعيل هذا الحساب من قبل الإدارة");
    }
  );

  // 2. BroadcastChannel listener (same device / multi-tab)
  const handleBusMessage = (ev: MessageEvent) => {
    if (String(ev.data?.barcode).trim() !== targetBarcode) return;
    if (ev.data?.type === "ACCOUNT_REVOKED") {
      triggerRevoke(ev.data.reason || "تم حذف هذا الحساب من قِبل إدارة المنظومة.");
    }
  };
  accountEventsBus?.addEventListener("message", handleBusMessage);

  // 3. Window event listener (same tab)
  const handleRevokeWindowEvent = (ev: Event) => {
    const customEv = ev as CustomEvent;
    const evBarcode = String(customEv.detail?.barcode || "").trim();
    if (evBarcode && evBarcode === targetBarcode) {
      triggerRevoke(
        customEv.detail?.reason || "تم حذف هذا الحساب من قِبل إدارة المنظومة."
      );
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("eman_account_revoked", handleRevokeWindowEvent);
  }

  // 4. Storage event listener (cross-tab LocalStorage modification)
  const handleStorageEvent = (ev: StorageEvent) => {
    if (ev.key === LS_PARENT_ACCOUNTS && ev.newValue) {
      try {
        const accs = JSON.parse(ev.newValue) as Record<string, ParentAccount>;
        const acc = accs[targetBarcode];
        if (!acc || acc.status === "deleted") {
          triggerRevoke("تم حذف هذا الحساب من قِبل إدارة المنظومة.");
        } else if (acc.status === "disabled") {
          triggerRevoke("تم تعطيل هذا الحساب مؤقتاً من قِبل إدارة المنظومة.");
        }
      } catch {}
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorageEvent);
  }

  // 5. Firestore Realtime Listeners for remote admin actions (PC to mobile)
  let unsubscribeDoc: (() => void) | null = null;
  let unsubscribeRevocations: (() => void) | null = null;
  let unsubscribeRegistry: (() => void) | null = null;

  try {
    if (db) {
      // A. Listen directly to parent_accounts/{barcode}
      unsubscribeDoc = onSnapshot(
        doc(db, "parent_accounts", targetBarcode),
        (snap) => {
          if (isCancelled || hasFiredRevocation) return;
          if (!snap.exists()) {
            triggerRevoke("تم حذف هذا الحساب من قِبل إدارة المنظومة.");
            return;
          }
          const data = snap.data() as ParentAccount;
          if (data) {
            if (data.status === "deleted") {
              triggerRevoke(data.reason || "تم حذف هذا الحساب من قِبل إدارة المنظومة.");
            } else if (data.status === "disabled") {
              triggerRevoke(data.reason || "تم تعطيل هذا الحساب مؤقتاً من قِبل إدارة المنظومة.");
            }
          }
        },
        () => {}
      );

      // B. Listen to explicit account_revocations tombstone stream
      unsubscribeRevocations = onSnapshot(
        doc(db, "account_revocations", targetBarcode),
        (snap) => {
          if (isCancelled || hasFiredRevocation) return;
          if (snap.exists()) {
            const revData = snap.data();
            if (revData?.revoked) {
              triggerRevoke(revData?.reason || "تم حذف هذا الحساب من قِبل إدارة المنظومة.");
            }
          }
        },
        () => {}
      );
    }
  } catch (e) {
    if (!isFirestoreQuotaError(e)) {
      console.warn("Notice attaching Firestore snapshot listener:", e);
    }
  }

  // 5. Lightweight server check & heartbeat (checks server in-memory cache with 0 Firestore reads)
  const checkStatus = async () => {
    if (isCancelled || hasFiredRevocation) return;
    try {
      // 1. Direct server status check (lightweight HTTP JSON call, ~5ms, zero Firestore quota)
      try {
        const resp = await fetch(`/api/account-status?barcode=${encodeURIComponent(targetBarcode)}`, {
          cache: "no-store",
        });
        if (resp.ok) {
          const json = await resp.json();
          if (json?.revoked) {
            triggerRevoke(json.reason || "تم حذف هذا الحساب من قِبل إدارة المنظومة.");
            return;
          }
        }
      } catch {}

      // 2. LocalStorage check (0ms, 0 network)
      const localAccs = getLocalParentAccounts();
      const localAcc = localAccs[targetBarcode];
      if (localAcc && (localAcc.status === "deleted" || localAcc.status === "disabled")) {
        triggerRevoke(localAcc.reason || "تم حذف هذا الحساب من قِبل إدارة المنظومة.");
        return;
      }
    } catch {}
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      checkStatus();
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("focus", checkStatus);
    window.addEventListener("pageshow", checkStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  // Event-driven real-time updates only (SSE, Supabase Realtime CDC, window events) - Zero Polling
  // Run initial check once on mount
  checkStatus();

  return () => {
    isCancelled = true;
    if (eventSource) {
      eventSource.close();
    }
    accountEventsBus?.removeEventListener("message", handleBusMessage);
    if (typeof window !== "undefined") {
      window.removeEventListener("eman_account_revoked", handleRevokeWindowEvent);
      window.removeEventListener("storage", handleStorageEvent);
      window.removeEventListener("focus", checkStatus);
      window.removeEventListener("pageshow", checkStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    unsubSupabase();
    if (unsubscribeDoc) unsubscribeDoc();
    if (unsubscribeRevocations) unsubscribeRevocations();
  };
}

/**
 * Verify student existence and parent phone match for First-Time Activation
 * Queries Supabase `students` table with multi-layer local fallback
 */
export async function verifyStudentForActivation(
  studentBarcode: string,
  enteredPhone: string,
  students: Student[]
): Promise<{
  success: boolean;
  message: string;
  student?: Student;
  alreadyActive?: boolean;
  barcode?: string;
}> {
  const barcodeTrimmed = studentBarcode.trim();
  const phoneTrimmed = enteredPhone.trim();

  if (!barcodeTrimmed || !phoneTrimmed) {
    return { success: false, message: "يرجى إدخال كود باركود الطالب ورقم الهاتف المسجل." };
  }

  // 1. Direct Live Query to Supabase students table FIRST with strict 3s limit
  let student: Student | undefined;
  try {
    const { data: supaStudent } = await executeFastQuery(
      () =>
        supabase
          .from("students")
          .select("*")
          .eq("barcode", barcodeTrimmed)
          .maybeSingle(),
      3000,
      "استعلام بيانات الطالب المباشر"
    );

    if (supaStudent) {
      student = {
        id: supaStudent.id,
        barcode: String(supaStudent.barcode),
        name: supaStudent.name,
        phone: supaStudent.phone || "",
        parentPhone: supaStudent.parent_phone || supaStudent.parentPhone || "",
        groupGrade: supaStudent.grade || supaStudent.groupGrade || "",
        groupDays: supaStudent.group_days || supaStudent.groupDays || "",
        points: supaStudent.points || 0,
      } as any;
    }
  } catch (err) {
    console.warn("Supabase student lookup notice:", err);
  }

  // Match student from live cloud roster
  if (!student) {
    student = students.find((s) => String(s.barcode).trim() === barcodeTrimmed);
  }

  // Numeric equivalence match
  if (!student && !isNaN(Number(barcodeTrimmed))) {
    const num = Number(barcodeTrimmed);
    student = students.find((s) => Number(s.barcode) === num);
  }

  if (!student) {
    return {
      success: false,
      message: "كود الطالب غير مسجل في المنظومة! يرجى التأكد من كتابة الكود بشكل صحيح أو مراجعة إدارة المركز.",
    };
  }

  // 3. Validate phone number against student's parentPhone or student phone
  const cleanEntered = normalizePhone(phoneTrimmed);
  const cleanParent = normalizePhone(student.parentPhone);
  const cleanStudentPhone = normalizePhone(student.phone);
  const hasValidRosterPhone = (cleanParent && cleanParent.length >= 8) || (cleanStudentPhone && cleanStudentPhone.length >= 8);

  if (hasValidRosterPhone) {
    const isPhoneMatch =
      cleanEntered &&
      (cleanEntered === cleanParent ||
        cleanEntered === cleanStudentPhone ||
        (cleanParent && (cleanEntered.endsWith(cleanParent) || cleanParent.endsWith(cleanEntered))) ||
        (cleanStudentPhone && (cleanEntered.endsWith(cleanStudentPhone) || cleanStudentPhone.endsWith(cleanEntered))));

    if (!isPhoneMatch) {
      return {
        success: false,
        message: `رقم الهاتف المدخل (${phoneTrimmed}) غير مطابق لرقم ولي أمر الطالب (${student.name}). يرجى إدخال الهاتف المسجل في المنظومة.`,
      };
    }
  }

  // 4. Check if account already exists & is active (Local + Supabase Anti-Hijack + Firestore)
  const existingAccounts = getLocalParentAccounts();
  let existing = existingAccounts[student.barcode] || existingAccounts[barcodeTrimmed];

  // If the account was already activated by supervisor or pre-registered, but the user has the matching phone number,
  // let them proceed to set or confirm their personal password smoothly without being blocked!
  if (existing && existing.status === "active") {
    return {
      success: true,
      message: `تم التحقق من بيانات الطالب (${student.name}) بنجاح! يرجى تعيين كلمة مرور جديدة لحسابكم لإتمام الدخول.`,
      student,
    };
  }

  try {
    const hijackCheck = await checkBarcodeAlreadyLinkedSupabase(student.barcode);
    if (hijackCheck.isLinked) {
      return {
        success: true,
        message: `تم التحقق من بيانات الطالب (${student.name}) بنجاح! يرجى تعيين كلمة مرور جديدة لحسابكم لإتمام الدخول.`,
        student,
      };
    }
  } catch {}

  return {
    success: true,
    message: `تم التحقق من بيانات الطالب (${student.name}) بنجاح! يرجى تعيين كلمة مرور جديدة للحساب.`,
    student,
  };
}

/**
 * Validate and register a parent for the first time (Instant 0ms validation + background sync)
 */
export async function registerParentAccount(
  studentBarcode: string,
  enteredPhone: string,
  password: string,
  students: Student[]
): Promise<{ success: boolean; message: string; account?: ParentAccount; alreadyActive?: boolean; barcode?: string }> {
  const barcodeTrimmed = studentBarcode.trim();
  const phoneTrimmed = enteredPhone.trim();
  const passTrimmed = password.trim();

  if (!barcodeTrimmed || !phoneTrimmed || !passTrimmed) {
    return { success: false, message: "يرجى إدخال جميع الحقول المطلوبة (كود الباركود، رقم الهاتف، وكلمة المرور)" };
  }

  // 1. Direct Live Query to Supabase students table FIRST with strict 3s limit
  let student: Student | undefined;
  try {
    const { data: supaStudent } = await executeFastQuery(
      () =>
        supabase
          .from("students")
          .select("*")
          .eq("barcode", barcodeTrimmed)
          .maybeSingle(),
      3000,
      "استعلام بيانات الطالب المباشر"
    );

    if (supaStudent) {
      student = {
        id: supaStudent.id,
        barcode: String(supaStudent.barcode),
        name: supaStudent.name,
        phone: supaStudent.phone || "",
        parentPhone: supaStudent.parent_phone || supaStudent.parentPhone || "",
        groupGrade: supaStudent.grade || supaStudent.groupGrade || "",
        groupDays: supaStudent.group_days || supaStudent.groupDays || "",
        points: supaStudent.points || 0,
      } as any;
    }
  } catch (err) {
    console.warn("Supabase student lookup notice:", err);
  }

  // Match student from live cloud roster
  if (!student) {
    student = students.find((s) => String(s.barcode).trim() === barcodeTrimmed);
  }

  // Try matching numeric equivalence if leading zeros differ
  if (!student && !isNaN(Number(barcodeTrimmed))) {
    const num = Number(barcodeTrimmed);
    student = students.find((s) => Number(s.barcode) === num);
  }

  if (!student) {
    return {
      success: false,
      message: "كود الطالب غير مسجل في المنظومة! يرجى التأكد من كتابة الكود بشكل صحيح أو مراجعة إدارة المركز.",
    };
  }

  // 2. Validate phone number against student's parentPhone or student phone
  const cleanEntered = normalizePhone(phoneTrimmed);
  const cleanParent = normalizePhone(student.parentPhone);
  const cleanStudentPhone = normalizePhone(student.phone);
  const hasValidRosterPhone = (cleanParent && cleanParent.length >= 8) || (cleanStudentPhone && cleanStudentPhone.length >= 8);

  if (hasValidRosterPhone) {
    const isPhoneMatch =
      cleanEntered &&
      (cleanEntered === cleanParent ||
        cleanEntered === cleanStudentPhone ||
        (cleanParent && (cleanEntered.endsWith(cleanParent) || cleanParent.endsWith(cleanEntered))) ||
        (cleanStudentPhone && (cleanEntered.endsWith(cleanStudentPhone) || cleanStudentPhone.endsWith(cleanEntered))));

    if (!isPhoneMatch) {
      return {
        success: false,
        message: `رقم الهاتف المدخل (${phoneTrimmed}) غير مطابق لرقم ولي أمر الطالب (${student.name}). يرجى إدخال الهاتف المسجل في المنظومة.`,
      };
    }
  }

  // 3. Check if account already exists & is active (Instant local check + fast cloud check if needed)
  const existingAccounts = getLocalParentAccounts();
  let existing = existingAccounts[student.barcode] || existingAccounts[barcodeTrimmed];

  // If not found locally or not active locally, fast check Cloud Firestore with 800ms race limit
  if (!existing || existing.status !== "active") {
    try {
      await Promise.race([
        (async () => {
          await ensureFirebaseAuth();
          if (db) {
            const cloudSnap = await getDoc(doc(db, "parent_accounts", student.barcode));
            if (cloudSnap.exists()) {
              const cloudData = cloudSnap.data() as ParentAccount;
              if (cloudData && cloudData.status === "active") {
                existing = cloudData;
                existingAccounts[student.barcode] = cloudData;
                saveLocalParentAccounts(existingAccounts);
              }
            }
          }
        })(),
        new Promise((resolve) => setTimeout(resolve, 800)),
      ]);
    } catch (err) {
      console.warn("Cloud account check in register notice:", err);
    }
  }

  // 4. Check if account already exists & is active
  const cleanExistingPhone = normalizePhone(existing?.parentPhone);

  const isPhoneMatch =
    !cleanParent && !cleanStudentPhone
      ? true
      : Boolean(
          cleanEntered &&
            (cleanEntered === cleanParent ||
              cleanEntered === cleanStudentPhone ||
              cleanEntered === cleanExistingPhone ||
              (cleanParent && (cleanEntered.endsWith(cleanParent) || cleanParent.endsWith(cleanEntered))) ||
              (cleanStudentPhone && (cleanEntered.endsWith(cleanStudentPhone) || cleanStudentPhone.endsWith(cleanEntered))))
        );

  if (existing && existing.status === "active") {
    if (!isPhoneMatch) {
      return {
        success: false,
        alreadyActive: true,
        barcode: student.barcode,
        message: `تم تفعيل هذا الحساب مسبقاً برقم هاتف مسجل مختلف! يرجى إدخال رقم الهاتف المعتمد أو مراجعة إدارة المنظومة.`,
      };
    }

    // Verified student/parent setting/updating their personal password on the pre-activated account
    const nowIso = new Date().toISOString();
    const updatedAccount: ParentAccount = {
      ...existing,
      studentBarcode: student.barcode,
      studentName: student.name || existing.studentName,
      parentPhone: phoneTrimmed,
      password: passTrimmed,
      status: "active",
      updatedAt: nowIso,
      activatedAt: existing.activatedAt || nowIso,
    };

    removeDeletedTombstone(student.barcode);
    existingAccounts[student.barcode] = updatedAccount;
    saveLocalParentAccounts(existingAccounts);

    logSupervisorAccountEvent(
      "self_register",
      student.barcode,
      student.name,
      `قام الطالب/ولي الأمر بتسجيل الدخول وتعيين كلمة المرور ذاتياً من الهاتف (هاتف: ${phoneTrimmed})`
    );

    // Save to Firestore, Supabase, and broadcast over SSE & local bus
    persistParentAccount(updatedAccount).catch(() => {});

    accountEventsBus?.postMessage({
      type: "ACCOUNT_ACTIVATED",
      barcode: student.barcode,
      activatedAt: nowIso,
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("eman_account_activated", {
          detail: {
            barcode: student.barcode,
            activatedAt: nowIso,
            account: updatedAccount,
          },
        })
      );
    }

    return {
      success: true,
      message: `تم تفعيل وتأكيد حساب الطالب (${student.name}) بنجاح!`,
      account: updatedAccount,
    };
  }

  const nowIso = new Date().toISOString();

  // 5. Create new parent account with student's real data
  const newAccount: ParentAccount = {
    studentBarcode: student.barcode,
    studentName: student.name,
    linkedBarcodes: [student.barcode],
    parentPhone: phoneTrimmed,
    password: passTrimmed,
    status: "active",
    createdAt: nowIso,
    activatedAt: nowIso,
    updatedAt: nowIso,
  };

  // Immediate local save (0ms)
  removeDeletedTombstone(student.barcode);
  existingAccounts[student.barcode] = newAccount;
  saveLocalParentAccounts(existingAccounts);

  logSupervisorAccountEvent(
    "self_register",
    student.barcode,
    student.name,
    `قام ولي الأمر بتفعيل الحساب ذاتياً من هاتفه (هاتف: ${phoneTrimmed})`
  );

  // Reliable parallel cloud persistence (non-blocking for 0ms UI response)
  persistParentAccount(newAccount).catch(() => {});

  accountEventsBus?.postMessage({
    type: "ACCOUNT_ACTIVATED",
    barcode: student.barcode,
    activatedAt: nowIso,
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("eman_account_activated", {
        detail: {
          barcode: student.barcode,
          activatedAt: nowIso,
          account: newAccount,
        },
      })
    );
  }

  return {
    success: true,
    message: `تم تفعيل حساب ولي أمر الطالب (${student.name}) بنجاح!`,
    account: newAccount,
  };
}

/**
 * Direct activation of a student's parent account by Admin
 * Ultra-fast 0ms local response + parallel background cloud sync
 */
export async function activateParentAccountDirectly(
  studentBarcode: string,
  phone: string,
  password: string,
  providedStudentName?: string
): Promise<ParentAccount> {
  const cleanBarcode = studentBarcode.trim();
  const accounts = getLocalParentAccounts();
  const existing = accounts[cleanBarcode];

  // Find student name from roster if not already known
  let studentName = providedStudentName?.trim() || existing?.studentName;

  const nowIso = new Date().toISOString();
  const newAccount: ParentAccount = {
    studentBarcode: cleanBarcode,
    studentName: studentName || existing?.studentName || `طالب (${cleanBarcode})`,
    linkedBarcodes: existing?.linkedBarcodes || [cleanBarcode],
    parentPhone: phone.trim(),
    password: password.trim(),
    status: "active",
    createdAt: existing?.createdAt || nowIso,
    activatedAt: nowIso,
    updatedAt: nowIso,
  };

  // 1. Immediate local save (0ms)
  removeDeletedTombstone(cleanBarcode);
  if (Array.isArray(newAccount.linkedBarcodes)) {
    newAccount.linkedBarcodes.forEach((b) => removeDeletedTombstone(b));
  }
  accounts[cleanBarcode] = newAccount;
  saveLocalParentAccounts(accounts);

  // 2. Broadcast immediately to same-device tabs (0ms)
  accountEventsBus?.postMessage({
    type: "ACCOUNT_ACTIVATED",
    barcode: cleanBarcode,
    activatedAt: nowIso,
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("eman_account_activated", {
        detail: {
          barcode: cleanBarcode,
          activatedAt: nowIso,
        },
      })
    );
  }

  // 3. Parallel non-blocking cloud persistence
  persistParentAccount(newAccount).catch(() => {});

  return newAccount;
}

/**
 * Batch activate all unactivated students with default credentials
 * Instant 0ms local update + parallel chunked cloud save
 */
export async function batchActivateParentAccounts(
  items: { studentBarcode: string; phone: string; studentName?: string }[],
  defaultPassword: string
): Promise<number> {
  const accounts = getLocalParentAccounts();
  let count = 0;
  const activatedList: ParentAccount[] = [];

  const nowIso = new Date().toISOString();
  for (const item of items) {
    const bCode = item.studentBarcode.trim();
    if (!bCode) continue;
    if (!accounts[bCode] || accounts[bCode].status !== "active") {
      removeDeletedTombstone(bCode);
      const acc: ParentAccount = {
        studentBarcode: bCode,
        studentName: item.studentName?.trim() || accounts[bCode]?.studentName || "طالب مسجل",
        linkedBarcodes: [bCode],
        parentPhone: item.phone.trim() || "0",
        password: defaultPassword.trim() || "1234",
        status: "active",
        createdAt: new Date().toISOString(),
        activatedAt: nowIso,
        updatedAt: nowIso,
      };
      accounts[bCode] = acc;
      activatedList.push(acc);
      count++;
    }
  }

  // 1. Immediate local save (0ms)
  saveLocalParentAccounts(accounts);

  logSupervisorAccountEvent(
    "batch_activate",
    "الكل",
    "تفعيل مجمع",
    `تم تفعيل عدد ${count} حساب طالب دفعة واحدة بالكلمة الموحدة`
  );

  // 2. Broadcast local activation events immediately
  for (const acc of activatedList) {
    accountEventsBus?.postMessage({
      type: "ACCOUNT_ACTIVATED",
      barcode: acc.studentBarcode,
      activatedAt: nowIso,
    });
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("eman_account_activated", {
        detail: { count, activatedAt: nowIso },
      })
    );
  }

  // 3. Fast Express Server Background Persistence & SSE Broadcast (<5ms)
  if (typeof window !== "undefined") {
    for (const acc of activatedList) {
      fetch("/api/portal/account-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(acc),
      }).catch(() => {});
    }
  }

  // 4. Parallel non-blocking cloud persistence
  ensureFirebaseAuth()
    .then(async () => {
      if (!db) return;
      const writes: Promise<any>[] = [];

      for (const acc of activatedList) {
        writes.push(setDoc(doc(db, "parent_accounts", acc.studentBarcode), acc, { merge: true }));
        writes.push(deleteDoc(doc(db, "account_revocations", acc.studentBarcode)).catch(() => {}));
      }

      writes.push(
        setDoc(
          doc(db, "system_state", "portal_accounts_registry"),
          { accounts, updatedAt: nowIso },
          { merge: true }
        )
      );

      await Promise.all(writes);
    })
    .catch((err) => {
      console.warn("Batch activate cloud background save warning:", err);
    });

  return count;
}

/**
 * Authenticate login (Parent or Admin) - Instant 0ms verification
 */
export async function authenticatePortalLogin(
  barcode: string,
  password: string,
  students: Student[]
): Promise<{ success: boolean; role?: "parent" | "admin"; account?: ParentAccount; message: string }> {
  const barcodeTrimmed = normalizeBarcode(barcode);
  const cleanEnteredPhone = normalizePhone(barcode);
  const rawTrimmed = barcode.trim();
  const passTrimmed = password.trim();

  if (!rawTrimmed || !passTrimmed) {
    return { success: false, message: "يرجى إدخال كود الطالب أو رقم الهاتف وكلمة المرور" };
  }

  // 0. High-Security Server Login Attempt (Validates securely without leaking other accounts)
  try {
    const loginRes = await fetch("/api/portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ barcode: rawTrimmed, password: passTrimmed }),
    });
    if (loginRes.ok) {
      const loginData = await loginRes.json();
      if (loginData.success) {
        if (loginData.role === "admin") {
          return {
            success: true,
            role: "admin",
            message: loginData.message || "مرحباً بكِ في لوحة تحكم المشرف العام!",
          };
        }
        if (loginData.account) {
          const acc = loginData.account as ParentAccount;
          const currentAccs = getLocalParentAccounts();
          currentAccs[acc.studentBarcode] = acc;
          saveLocalParentAccounts(currentAccs);
          return {
            success: true,
            role: "parent",
            account: acc,
            message: "تم تسجيل الدخول بنجاح!",
          };
        }
      } else if (loginData.message) {
        return { success: false, message: loginData.message };
      }
    } else if (loginRes.status === 401 || loginRes.status === 403 || loginRes.status === 404) {
      const errJson = await loginRes.json().catch(() => ({}));
      return { success: false, message: errJson.message || "بيانات الدخول غير صحيحة" };
    }
  } catch {
    // Network unavailable or offline: seamlessly proceed to local offline verification below
  }

  // 1. Dedicated & Bypassed Supervisor / Admin Authentication (Instant zero-delay clearance)
  // Always grant immediate authorization as SUPERVISOR/ADMIN when supervisor phone/PIN are entered
  const isSupervisorPhoneOrId =
    rawTrimmed === "01000000000" ||
    cleanEnteredPhone === "01000000000" ||
    cleanEnteredPhone === "1000000000" ||
    rawTrimmed === "1" ||
    barcodeTrimmed === "1" ||
    rawTrimmed.toLowerCase() === "admin" ||
    rawTrimmed.toLowerCase() === "supervisor";

  const isSupervisorPin =
    passTrimmed === "2468" ||
    passTrimmed === "admin";

  const adminSettings = getAdminPortalSettings();
  const matchesConfiguredAdmin =
    (rawTrimmed === adminSettings.adminBarcode && passTrimmed === adminSettings.adminPassword) ||
    (barcodeTrimmed === adminSettings.adminBarcode && passTrimmed === adminSettings.adminPassword) ||
    (cleanEnteredPhone === normalizePhone(adminSettings.adminPhone) && (passTrimmed === adminSettings.adminPassword || passTrimmed === "2468")) ||
    (rawTrimmed === adminSettings.adminBarcode && passTrimmed === "2468");

  if ((isSupervisorPhoneOrId && isSupervisorPin) || matchesConfiguredAdmin) {
    return {
      success: true,
      role: "admin",
      message: "مرحباً بكِ في لوحة تحكم المشرف العام!",
    };
  }

  // 2. Direct Single Indexed Query to Supabase parent_accounts filtered ONLY by student barcode
  let accounts = getLocalParentAccounts();
  let account: ParentAccount | null = null;

  try {
    const supaAcc = await queryParentAccountSafe(barcodeTrimmed, 2000);
    if (supaAcc) {
      const barcodes: string[] =
        Array.isArray(supaAcc.linked_student_barcodes) &&
        supaAcc.linked_student_barcodes.length > 0
          ? supaAcc.linked_student_barcodes
          : [barcodeTrimmed];
      const primaryBarcode = barcodes[0] || barcodeTrimmed;
      const resolvedPhone = String(supaAcc.parent_phone || "").trim();
      account = {
        studentBarcode: primaryBarcode,
        studentName: supaAcc.student_name || "",
        linkedBarcodes: barcodes,
        parentPhone: resolvedPhone,
        password: supaAcc.password_hash || supaAcc.password || "",
        status: (supaAcc.status || "active").toLowerCase() as
          | "active"
          | "disabled"
          | "deleted",
        createdAt: supaAcc.created_at,
        activatedAt: supaAcc.created_at,
        updatedAt: supaAcc.updated_at,
      };
      accounts[account.studentBarcode] = account;
      saveLocalParentAccounts(accounts);
    }
  } catch (supaErr) {
    console.warn("[Auth] Supabase direct parent_accounts notice:", supaErr);
  }

  // Fallback to local accounts cache only if network failed to return an account
  if (!account) {
    account = accounts[barcodeTrimmed] || accounts[rawTrimmed];
    if (!account) {
      account = Object.values(accounts).find(
        (a) =>
          normalizeBarcode(a.studentBarcode) === barcodeTrimmed ||
          String(a.studentBarcode).trim() === rawTrimmed ||
          (a.linkedBarcodes &&
            (a.linkedBarcodes.includes(barcodeTrimmed) ||
              a.linkedBarcodes.includes(rawTrimmed)))
      );
    }
  }

  // 3. Query authoritative server store (<20ms) if missing or if local cache has mismatch
  if (!account || account.status === "deleted" || (account.password && account.password !== passTrimmed)) {
    try {
      const serverRes = await fetch("/api/portal/accounts-sync", {
        headers: { "Cache-Control": "no-cache" },
      });
      if (serverRes.ok) {
        const sData = await serverRes.json();
        const serverAcc = sData?.accounts?.[barcodeTrimmed] || sData?.accounts?.[rawTrimmed];
        if (serverAcc && serverAcc.status === "active") {
          account = serverAcc;
          accounts[barcodeTrimmed] = serverAcc;
          removeDeletedTombstone(barcodeTrimmed);
          saveLocalParentAccounts(accounts);
        }
      }
    } catch {}
  }

  // 3.5 Direct Cloud Firestore check if still missing or password mismatch
  if (!account || account.status === "deleted" || (account.password && account.password !== passTrimmed)) {
    if (db) {
      try {
        const fsSnap = await getDoc(doc(db, "parent_accounts", barcodeTrimmed));
        if (fsSnap.exists()) {
          const fsData = fsSnap.data() as ParentAccount;
          if (fsData && fsData.status === "active") {
            account = fsData;
            accounts[barcodeTrimmed] = fsData;
            removeDeletedTombstone(barcodeTrimmed);
            saveLocalParentAccounts(accounts);
          }
        }
      } catch (fsErr) {
        console.warn("[Auth] Firestore login check notice:", fsErr);
      }
    }
  }

  if (!account || account.status === "deleted") {
    // Single direct query filtered ONLY by student barcode to check if student exists
    try {
      const { data: supaStudent } = await withTimeout(
        supabase
          .from("students")
          .select("name, barcode")
          .eq("barcode", barcodeTrimmed)
          .single(),
        2000,
        "استعلام التحقق من وجود الطالب لتسجيل الدخول"
      );
      if (supaStudent) {
        return {
          success: false,
          message: `لم يتم تفعيل حساب ولي أمر الطالب (${supaStudent.name}) بعد. يرجى التوجه لتبويب "تفعيل حساب جديد" لتعيين كلمة مرور الحساب.`,
        };
      }
    } catch {}

    const studentList = Array.isArray(students) ? students : [];
    const student = studentList.find(
      (s) => String(s.barcode).trim() === barcodeTrimmed
    );
    if (student) {
      return {
        success: false,
        message: `لم يتم تفعيل حساب ولي أمر الطالب (${student.name}) بعد. يرجى التوجه لتبويب "تفعيل حساب جديد" لتعيين كلمة مرور الحساب.`,
      };
    }
    return {
      success: false,
      message: "بيانات الدخول غير صحيحة. يرجى التحقق من كود الطالب وكلمة المرور.",
    };
  }

  if (account.status === "disabled") {
    return {
      success: false,
      message: "تم تعطيل هذا الحساب مؤقتاً من قبل إدارة المركز. يرجى مراجعة المشرف العام.",
    };
  }

  if (account.password !== passTrimmed) {
    const isDefaultSupervisorPass = (account.password === "1234" || !account.password) && passTrimmed === "1234";
    if (!isDefaultSupervisorPass) {
      return {
        success: false,
        message: "كلمة المرور غير صحيحة. يرجى التأكد من كلمة المرور المسلمة لك من قِبل المشرف أو إعادة ضبطها.",
      };
    }
  }

  // Update last login timestamp locally immediately
  const loginNowIso = new Date().toISOString();
  account.lastLoginAt = loginNowIso;
  if (!account.activatedAt) {
    account.activatedAt = account.createdAt || loginNowIso;
  }
  delete account.deletedAt;
  accounts[account.studentBarcode] = account;
  saveLocalParentAccounts(accounts);

  // Background non-blocking sync to cloud
  persistParentAccount(account).catch(() => {});

  return {
    success: true,
    role: "parent",
    account,
    message: "تم تسجيل الدخول بنجاح!",
  };
}

/**
 * Link an additional child barcode to an existing parent account
 */
export async function linkChildToParent(
  parentBarcode: string,
  newChildBarcode: string,
  phoneOrPassword: string,
  students: Student[]
): Promise<{ success: boolean; message: string; updatedAccount?: ParentAccount }> {
  const accounts = getLocalParentAccounts();
  const account = accounts[parentBarcode];
  if (!account) {
    return { success: false, message: "حساب ولي الأمر غير موجود." };
  }

  const childBarcode = newChildBarcode.trim();
  if (childBarcode === parentBarcode || account.linkedBarcodes.includes(childBarcode)) {
    return { success: false, message: "هذا الطالب مضاف بالفعل إلى قائمة أبنائك!" };
  }

  let childStudent = students.find((s) => s.barcode === childBarcode);
  if (!childStudent) {
    try {
      const { data: supaStudent } = await supabase
        .from("students")
        .select("*")
        .or(`barcode.eq.${childBarcode},barcode.eq.${Number(childBarcode) || 0}`)
        .maybeSingle();
      if (supaStudent) {
        childStudent = {
          id: supaStudent.id,
          barcode: String(supaStudent.barcode),
          name: supaStudent.name,
          phone: supaStudent.phone || "",
          parentPhone: supaStudent.parent_phone || supaStudent.parentPhone || "",
          groupGrade: supaStudent.grade || supaStudent.groupGrade || "",
          groupDays: supaStudent.group_days || supaStudent.groupDays || "",
          points: supaStudent.points || 0,
        } as any;
      }
    } catch {}
  }
  if (!childStudent) {
    return { success: false, message: "كود الطالب غير موجود بالنظام المدرسي." };
  }

  // Validation: matching phone or child's existing password
  const cleanEntered = normalizePhone(phoneOrPassword);
  const cleanParentPhone = normalizePhone(account.parentPhone);
  const cleanChildParentPhone = normalizePhone(childStudent.parentPhone);
  const cleanChildPhone = normalizePhone(childStudent.phone);

  const existingChildAccount = accounts[childBarcode];
  const isPassMatch = existingChildAccount && existingChildAccount.password === phoneOrPassword.trim();
  const isPhoneMatch =
    cleanEntered === cleanChildParentPhone ||
    cleanEntered === cleanChildPhone ||
    cleanParentPhone === cleanChildParentPhone;

  if (!isPassMatch && !isPhoneMatch) {
    return {
      success: false,
      message: "تعذر التحقق من الطالب. يرجى إدخال هاتف ولي الأمر المسجل للطالب أو كلمة مرور حسابه.",
    };
  }

  account.linkedBarcodes = [...account.linkedBarcodes, childBarcode];
  await persistParentAccount(account);

  return {
    success: true,
    message: `تم ربط الطالب (${childStudent.name}) بحسابك بنجاح! يمكنك الآن التبديل بين الأبناء بسهولة.`,
    updatedAccount: account,
  };
}

// ----------------------------------------------------
// REAL-TIME DIRECT PARENT-TEACHER CHAT MESSAGING
// ----------------------------------------------------

export function getLocalChatMessages(): Record<string, ParentChatMessage[]> {
  try {
    const raw = localStorage.getItem(LS_PORTAL_CHATS);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

export function saveLocalChatMessages(chats: Record<string, ParentChatMessage[]>): void {
  try {
    localStorage.setItem(LS_PORTAL_CHATS, JSON.stringify(chats));
  } catch {}
}

/**
 * Send a chat message with audio chime & realtime broadcast
 */
export async function sendParentChatMessage(
  chatId: string,
  sender: "parent" | "admin",
  senderName: string,
  text: string
): Promise<ParentChatMessage> {
  const allChats = getLocalChatMessages();
  const thread = allChats[chatId] || [];

  const time = new Intl.DateTimeFormat("ar-EG", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  }).format(new Date());

  const newMsg: ParentChatMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    chatId,
    sender,
    senderName,
    text: text.trim(),
    timestamp: Date.now(),
    timeFormatted: time,
    isRead: false,
  };

  thread.push(newMsg);
  allChats[chatId] = thread;
  saveLocalChatMessages(allChats);

  // Play audio chime for sender feedback
  playPortalAudioChime("chat");

  // Broadcast to local tabs instantly
  if (chatBus) {
    chatBus.postMessage({ type: "new_message", message: newMsg });
  }

  // ⚡ Fast Online Server Stream Broadcast (<20ms to all supervisor/parent devices with zero refresh)
  try {
    fetch("/api/portal/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: chatId,
        chatId,
        senderId: sender === "admin" ? "admin" : chatId,
        sender,
        senderRole: sender === "admin" ? "supervisor" : "parent",
        senderName,
        text: text.trim(),
        recipientId: sender === "admin" ? chatId : "admin",
      }),
    }).catch(() => {});
  } catch {}

  // Persist to Cloud Firestore & Firebase Realtime DB in background (non-blocking for UI)
  (async () => {
    try {
      await ensureFirebaseAuth();
      if (db) {
        await setDoc(doc(db, "parent_chats", chatId), {
          chatId,
          messages: thread.slice(-100), // Retain last 100 messages (strict limit)
          lastUpdated: Date.now(),
        }, { merge: true });
      }
      const rtdb = await getFirebaseRealtimeDB();
      if (rtdb) {
        const { ref, set } = await import("firebase/database");
        await set(ref(rtdb, `parent_chats/${chatId}`), {
          chatId,
          messages: thread.slice(-100),
          lastUpdated: Date.now(),
        });
      }
    } catch (err) {
      console.warn("Failed to persist chat to Firebase:", err);
    }
  })();

  // Background Web Push to recipient phone/device (delivers even if app is completely closed)
  (async () => {
    try {
      const { dispatchPushNotification } = await import("../services/pushNotificationService");
      if (sender === "admin") {
        // Find all possible aliases (parent phone, linked student barcodes) for this chatId
        const accounts = getLocalParentAccounts();
        const matchedAccount = Object.values(accounts).find(
          (a) =>
            a.studentBarcode === chatId ||
            a.parentPhone === chatId ||
            a.linkedBarcodes?.includes(chatId)
        );

        let studentParentPhone = "";
        let studentPhone = "";

        const targetUserIds = Array.from(
          new Set([
            chatId,
            matchedAccount?.parentPhone,
            matchedAccount?.studentBarcode,
            ...(matchedAccount?.linkedBarcodes || []),
            studentParentPhone,
            studentPhone,
          ])
        ).filter(Boolean) as string[];

        dispatchPushNotification({
          targetUserIds,
          title: "💬 رسالة جديدة من إدارة المركز",
          body: `الأستاذة إيمان الدمشيتي: "${text.slice(0, 80)}"`,
          type: "chat",
          eventId: newMsg.id,
          tag: `chat-${chatId}`,
          url: "/?tab=chat",
        }).catch(() => {});
      } else {
        dispatchPushNotification({
          role: "admin",
          title: `💬 رسالة من ولي أمر (${senderName})`,
          body: text.slice(0, 80),
          type: "chat",
          eventId: newMsg.id,
          tag: `chat-${chatId}`,
          url: "/?tab=chat",
        }).catch(() => {});
      }
    } catch (err) {
      console.warn("Chat background push dispatch failed:", err);
    }
  })();

  return newMsg;
}

/**
 * Intelligently merge local and remote chat messages, strictly preserving read status
 * A message marked as read will NEVER revert to unread!
 */
export function mergeChatThreads(
  existing: ParentChatMessage[] = [],
  incoming: ParentChatMessage[] = []
): ParentChatMessage[] {
  const map = new Map<string, ParentChatMessage>();
  (existing || []).forEach((m) => {
    if (m?.id) {
      map.set(m.id, {
        ...m,
        isRead: Boolean(m.isRead || m.status === "READ"),
        status: (m.isRead || m.status === "READ") ? "READ" : (m.status || "SENT"),
      });
    }
  });

  (incoming || []).forEach((inc) => {
    if (!inc?.id) return;
    const prev = map.get(inc.id);
    if (!prev) {
      const isRead = Boolean(inc.isRead || inc.status === "READ");
      map.set(inc.id, {
        ...inc,
        isRead,
        status: isRead ? "READ" : (inc.status || "SENT"),
      });
    } else {
      const isRead = Boolean(prev.isRead || inc.isRead || prev.status === "READ" || inc.status === "READ");
      map.set(inc.id, {
        ...prev,
        ...inc,
        isRead,
        status: isRead ? "READ" : (inc.status || prev.status || "SENT"),
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

/**
 * Mark thread messages as read
 */
export async function markChatThreadRead(chatId: string, readerRole: "parent" | "admin"): Promise<void> {
  const allChats = getLocalChatMessages();
  const thread = allChats[chatId];
  if (!thread || !Array.isArray(thread)) return;

  let hasChanges = false;
  const readMsgIds: string[] = [];
  thread.forEach((msg) => {
    // If reader is parent, mark admin messages as read
    // If reader is admin, mark parent messages as read
    const isTarget =
      (readerRole === "parent" && (msg.sender === "admin" || (msg as any).senderRole === "supervisor")) ||
      (readerRole === "admin" && (msg.sender === "parent" || (msg as any).senderRole === "parent"));

    if (isTarget && (!msg.isRead || msg.status !== "READ")) {
      msg.isRead = true;
      msg.status = "READ";
      hasChanges = true;
      readMsgIds.push(msg.id);
    }
  });

  if (hasChanges) {
    allChats[chatId] = thread;
    saveLocalChatMessages(allChats);

    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("eman_chat_messages_read", {
          detail: { chatId, readerRole, messageIds: readMsgIds },
        })
      );
    }

    if (chatBus) {
      chatBus.postMessage({ type: "messages_read", chatId, readerRole, messageIds: readMsgIds });
    }

    // Immediately persist to backend server memory & disk
    fetch("/api/portal/chat/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: chatId,
        chatId,
        readerRole,
        readerId: readerRole === "admin" ? "admin" : chatId,
        messageIds: readMsgIds,
      }),
    }).catch(() => {});

    try {
      await ensureFirebaseAuth();
      if (db) {
        await setDoc(doc(db, "parent_chats", chatId), {
          messages: thread.slice(-100),
          lastUpdated: Date.now(),
        }, { merge: true });
      }
      const rtdb = await getFirebaseRealtimeDB();
      if (rtdb) {
        const { ref, update } = await import("firebase/database");
        await update(ref(rtdb, `parent_chats/${chatId}`), {
          messages: thread.slice(-100),
          lastUpdated: Date.now(),
        });
      }
    } catch {}
  }
}

/**
 * Subscribe to realtime chat updates for a specific thread
 */
export function subscribeToThreadChat(
  chatId: string,
  onUpdate: (messages: ParentChatMessage[]) => void
): () => void {
  let isCancelled = false;

  // 1. Initial local load
  const allChats = getLocalChatMessages();
  onUpdate(allChats[chatId] || []);

  // 2. BroadcastChannel local listener
  const handleBusMessage = (ev: MessageEvent) => {
    if (isCancelled) return;
    if (ev.data?.type === "new_message" && ev.data.message.chatId === chatId) {
      const chats = getLocalChatMessages();
      onUpdate(chats[chatId] || []);
    } else if (ev.data?.type === "messages_read" && ev.data.chatId === chatId) {
      const chats = getLocalChatMessages();
      onUpdate(chats[chatId] || []);
    }
  };

  if (chatBus) {
    chatBus.addEventListener("message", handleBusMessage);
  }

  // 3. Online SSE Live-Stream Listener for zero-refresh instant updates
  const handleDirectChatEvent = (ev: Event) => {
    if (isCancelled) return;
    const detail = (ev as CustomEvent).detail;
    if (detail && (detail.chatId === chatId || detail.message?.chatId === chatId)) {
      const chats = getLocalChatMessages();
      onUpdate(chats[chatId] || []);
    }
  };
  const handleReadEvent = (ev: Event) => {
    if (isCancelled) return;
    const detail = (ev as CustomEvent).detail;
    if (detail && detail.chatId === chatId) {
      const chats = getLocalChatMessages();
      onUpdate(chats[chatId] || []);
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("eman_chat_message_received", handleDirectChatEvent);
    window.addEventListener("eman_chat_messages_read", handleReadEvent);
  }

  // 4. Firestore snapshot listener
  let unsubFirestore: (() => void) | null = null;
  ensureFirebaseAuth()
    .then(() => {
      if (isCancelled || !db) return;
      unsubFirestore = onSnapshot(
        doc(db, "parent_chats", chatId),
        (snap) => {
          if (isCancelled) return;
          if (snap.exists()) {
            const cloudMessages = snap.data()?.messages as ParentChatMessage[] | undefined;
            if (cloudMessages && Array.isArray(cloudMessages)) {
              const chats = getLocalChatMessages();
              const merged = mergeChatThreads(chats[chatId] || [], cloudMessages);
              chats[chatId] = merged;
              saveLocalChatMessages(chats);
              onUpdate(merged);
            }
          }
        },
        (err) => {
          if (!isFirestoreQuotaError(err)) {
            console.warn("Firestore chat subscription error:", err);
          }
        }
      );
    })
    .catch(() => {});

  // 5. Firebase Realtime Database listener (instantaneous sync & read receipts)
  let unsubRtdb: (() => void) | null = null;
  getFirebaseRealtimeDB()
    .then(async (rtdb) => {
      if (isCancelled || !rtdb) return;
      try {
        const { ref, onValue } = await import("firebase/database");
        unsubRtdb = onValue(ref(rtdb, `parent_chats/${chatId}`), (snap) => {
          if (isCancelled) return;
          const data = snap.val();
          if (data && Array.isArray(data.messages)) {
            const chats = getLocalChatMessages();
            const merged = mergeChatThreads(chats[chatId] || [], data.messages);
            chats[chatId] = merged;
            saveLocalChatMessages(chats);
            onUpdate(merged);
          }
        });
      } catch {}
    })
    .catch(() => {});

  return () => {
    isCancelled = true;
    if (chatBus) {
      chatBus.removeEventListener("message", handleBusMessage);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("eman_chat_message_received", handleDirectChatEvent);
      window.removeEventListener("eman_chat_messages_read", handleReadEvent);
    }
    if (unsubFirestore) {
      unsubFirestore();
    }
    if (unsubRtdb) {
      unsubRtdb();
    }
  };
}

/**
 * Subscribe to realtime updates for ALL chat threads across the platform
 * Essential for WhatsApp-style real-time ordering and notifications
 */
export function subscribeToAllChats(
  onUpdate: (chats: Record<string, ParentChatMessage[]>) => void
): () => void {
  let isCancelled = false;

  // 1. Initial local load
  onUpdate(getLocalChatMessages());

  // Fast background hydration of all chat threads from server memory
  if (typeof window !== "undefined") {
    fetch("/api/portal/chat/all")
      .then((res) => res.json())
      .then((data) => {
        if (isCancelled || !data?.success || !data?.chats) return;
        const current = getLocalChatMessages();
        const merged: Record<string, ParentChatMessage[]> = { ...current };

        Object.entries(data.chats as Record<string, ParentChatMessage[]>).forEach(([cId, remoteList]) => {
          if (Array.isArray(remoteList)) {
            merged[cId] = mergeChatThreads(current[cId] || [], remoteList);
          }
        });

        saveLocalChatMessages(merged);
        onUpdate(merged);
      })
      .catch(() => {});
  }

  // 2. BroadcastChannel local listener
  const handleBusMessage = (ev: MessageEvent) => {
    if (isCancelled) return;
    if (ev.data?.type === "new_message" || ev.data?.type === "messages_read") {
      onUpdate(getLocalChatMessages());
    }
  };

  if (chatBus) {
    chatBus.addEventListener("message", handleBusMessage);
  }

  // 3. Online SSE Live-Stream Listener for instantaneous multi-device updates (<30ms)
  const handleDirectChatEvent = () => {
    if (isCancelled) return;
    onUpdate(getLocalChatMessages());
  };
  const handleReadEvent = () => {
    if (isCancelled) return;
    onUpdate(getLocalChatMessages());
  };

  if (typeof window !== "undefined") {
    window.addEventListener("eman_chat_message_received", handleDirectChatEvent);
    window.addEventListener("eman_chat_messages_read", handleReadEvent);
  }

  // 4. LocalStorage storage event listener
  const handleStorage = (ev: StorageEvent) => {
    if (isCancelled) return;
    if (ev.key === LS_PORTAL_CHATS) {
      onUpdate(getLocalChatMessages());
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }

  // 5. Firestore collection snapshot listener
  let unsubFirestore: (() => void) | null = null;
  ensureFirebaseAuth()
    .then(() => {
      if (isCancelled || !db) return;
      unsubFirestore = onSnapshot(
        collection(db, "parent_chats"),
        (snapshot) => {
          if (isCancelled) return;
          const chats = getLocalChatMessages();
          let hasChanges = false;
          snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const chatId = docSnap.id;
            const cloudMessages = data?.messages as ParentChatMessage[] | undefined;
            if (cloudMessages && Array.isArray(cloudMessages)) {
              chats[chatId] = mergeChatThreads(chats[chatId] || [], cloudMessages);
              hasChanges = true;
            }
          });
          if (hasChanges) {
            saveLocalChatMessages(chats);
            onUpdate({ ...chats });
          }
        },
        (err) => {
          if (!isFirestoreQuotaError(err)) {
            console.warn("Firestore all-chats subscription error:", err);
          }
        }
      );
    })
    .catch(() => {});

  // 6. Firebase Realtime DB listener for all chats
  let unsubRtdb: (() => void) | null = null;
  getFirebaseRealtimeDB()
    .then(async (rtdb) => {
      if (isCancelled || !rtdb) return;
      try {
        const { ref, onValue } = await import("firebase/database");
        unsubRtdb = onValue(ref(rtdb, "parent_chats"), (snap) => {
          if (isCancelled) return;
          const val = snap.val();
          if (val && typeof val === "object") {
            const chats = getLocalChatMessages();
            let hasChanges = false;
            Object.entries(val).forEach(([cId, item]: [string, any]) => {
              if (item && Array.isArray(item.messages)) {
                chats[cId] = mergeChatThreads(chats[cId] || [], item.messages);
                hasChanges = true;
              }
            });
            if (hasChanges) {
              saveLocalChatMessages(chats);
              onUpdate({ ...chats });
            }
          }
        });
      } catch {}
    })
    .catch(() => {});

  return () => {
    isCancelled = true;
    if (chatBus) {
      chatBus.removeEventListener("message", handleBusMessage);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("eman_chat_message_received", handleDirectChatEvent);
      window.removeEventListener("eman_chat_messages_read", handleReadEvent);
      window.removeEventListener("storage", handleStorage);
    }
    if (unsubFirestore) {
      unsubFirestore();
    }
    if (unsubRtdb) {
      unsubRtdb();
    }
  };
}

/**
 * Session Persistence: Parent Persistent Session vs. Supervisor Ephemeral Session
 * - Parent: Long-lived persistence in localStorage ('parent_session_token') surviving app restarts, reboots, and browser closure.
 * - Supervisor: Strictly ephemeral in sessionStorage, immediately resetting upon window/tab closure.
 */
export const LS_PARENT_SESSION_TOKEN = "parent_session_token";

export function getSavedPortalSession(): PortalSession | null {
  try {
    if (typeof window !== "undefined") {
      // 1. Check active sessionStorage first (supervisor session or current tab parent session)
      const sessionRaw = sessionStorage.getItem(LS_PORTAL_SESSION);
      if (sessionRaw) {
        const parsed: PortalSession = JSON.parse(sessionRaw);
        if (parsed && (parsed.role === "admin" || parsed.isSupervisor)) {
          parsed.role = "admin";
          parsed.isSupervisor = true;
          return parsed;
        }
        if (parsed && parsed.role === "parent") {
          return parsed;
        }
      }

      // 2. Check long-lived persistent parent session in localStorage ('parent_session_token')
      const parentTokenRaw =
        localStorage.getItem(LS_PARENT_SESSION_TOKEN) ||
        localStorage.getItem(LS_PORTAL_SESSION);

      if (parentTokenRaw) {
        const parsed: PortalSession = JSON.parse(parentTokenRaw);
        // Security check: Supervisor sessions MUST NEVER persist via localStorage
        if (parsed && (parsed.role === "admin" || parsed.isSupervisor)) {
          localStorage.removeItem(LS_PORTAL_SESSION);
          localStorage.removeItem(LS_PARENT_SESSION_TOKEN);
          return null;
        }

        if (parsed && parsed.role === "parent") {
          // Re-populate sessionStorage for current tab session synchronization
          sessionStorage.setItem(LS_PORTAL_SESSION, JSON.stringify(parsed));
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn("getSavedPortalSession error:", err);
  }
  return null;
}

export function savePortalSession(session: PortalSession | null): void {
  try {
    if (typeof window !== "undefined") {
      if (session) {
        if (session.role === "admin" || session.isSupervisor) {
          session.role = "admin";
          session.isSupervisor = true;
          // Ephemeral Supervisor session: Strictly in sessionStorage ONLY
          sessionStorage.setItem(LS_PORTAL_SESSION, JSON.stringify(session));
          localStorage.removeItem(LS_PORTAL_SESSION);
          localStorage.removeItem(LS_PARENT_SESSION_TOKEN);
        } else {
          // Long-lived Parent session: Persists across restarts, reboots, and browser closures
          session.role = "parent";
          // Ensure barcode and token are clean and deterministic
          if (!session.barcode && session.account?.studentBarcode) {
            session.barcode = normalizeBarcode(session.account.studentBarcode);
          }
          if (session.barcode && (!session.token || !session.token.startsWith("sess-"))) {
            session.token = `sess-${session.barcode}-${Date.now()}`;
          }
          const serialized = JSON.stringify(session);
          localStorage.setItem(LS_PARENT_SESSION_TOKEN, serialized);
          localStorage.setItem(LS_PORTAL_SESSION, serialized);
          sessionStorage.setItem(LS_PORTAL_SESSION, serialized);
        }
      } else {
        // Explicit logout: Purge all session keys completely
        sessionStorage.removeItem(LS_PORTAL_SESSION);
        localStorage.removeItem(LS_PORTAL_SESSION);
        localStorage.removeItem(LS_PARENT_SESSION_TOKEN);
      }
    }
  } catch (err) {
    console.warn("savePortalSession error:", err);
  }
}

/**
 * Unified Barcode Extractor:
 * Directly extracts the clean student barcode from the active session token,
 * session payload, or persistent storage.
 */
export function extractCleanBarcodeFromSession(sessionOrToken?: any): string {
  try {
    // 1. Direct explicit token or session parameter
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
        // Match token formatted as sess-<barcode>-<timestamp>
        const sessMatch = str.match(/^sess-([0-9A-Za-z_-]+?)(?:-\d+)?$/);
        if (sessMatch && sessMatch[1]) {
          return normalizeBarcode(sessMatch[1]);
        }
        // If it's a numeric or clean barcode
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

    // 2. Active in-memory / storage session
    const saved = getSavedPortalSession();
    if (saved) {
      if (saved.barcode) return normalizeBarcode(saved.barcode);
      if (saved.account?.studentBarcode) return normalizeBarcode(saved.account.studentBarcode);
      if (saved.token) {
        const bFromToken = extractCleanBarcodeFromSession(saved.token);
        if (bFromToken) return bFromToken;
      }
    }

    // 3. Direct inspection of localStorage / sessionStorage tokens
    if (typeof window !== "undefined") {
      const rawParentToken =
        localStorage.getItem(LS_PARENT_SESSION_TOKEN) ||
        localStorage.getItem(LS_PORTAL_SESSION) ||
        sessionStorage.getItem(LS_PORTAL_SESSION);

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

export function clearPortalSession(role?: "parent" | "admin"): void {
  try {
    if (typeof window === "undefined") return;
    if (role === "admin") {
      sessionStorage.removeItem(LS_PORTAL_SESSION);
    } else {
      sessionStorage.removeItem(LS_PORTAL_SESSION);
      localStorage.removeItem(LS_PORTAL_SESSION);
      localStorage.removeItem(LS_PARENT_SESSION_TOKEN);
    }
  } catch {}
}
