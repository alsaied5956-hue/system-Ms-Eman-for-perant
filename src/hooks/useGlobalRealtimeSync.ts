import type { Dispatch, SetStateAction } from "react";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase, barcodeToUUID, normalizeBarcode } from "../utils/supabaseClient";
import { ParentAccount } from "../types/portal";
import { getLocalParentAccounts, saveLocalParentAccounts } from "../utils/portalStorage";

export interface UseGlobalRealtimeSyncOptions {
  /** Optional initial accounts state array */
  initialAccounts?: ParentAccount[];
  /** Optional external state array */
  accounts?: ParentAccount[];
  /** Optional state setter for external array state */
  setAccounts?: Dispatch<SetStateAction<ParentAccount[]>>;
  /** Optional callback fired on Realtime CDC INSERT */
  onAccountInserted?: (account: ParentAccount) => void;
  /** Optional callback fired on Realtime CDC UPDATE */
  onAccountUpdated?: (account: ParentAccount) => void;
  /** Optional callback fired on Realtime CDC DELETE */
  onAccountDeleted?: (deletedId: string) => void;
}

/**
 * Normalizes and matches an account by id, barcode, or linked barcode against a search query/ID.
 * Handles UUID matching, raw barcode matching, and linked barcodes.
 */
export function matchesAccount(acc: ParentAccount, query: string): boolean {
  if (!acc || !query) return false;
  const clean = String(query).trim().toLowerCase();
  const cleanBarcode = normalizeBarcode(clean).toLowerCase();
  const cleanUUID = barcodeToUUID(cleanBarcode || clean).toLowerCase();

  const accId = String(acc.id || "").trim().toLowerCase();
  const accBarcode = String(acc.studentBarcode || "").trim().toLowerCase();
  const accUUID = barcodeToUUID(accBarcode || accId).toLowerCase();

  if (accId && (accId === clean || accId === cleanUUID)) return true;
  if (accBarcode && (accBarcode === clean || accBarcode === cleanBarcode)) return true;
  if (accUUID && (accUUID === clean || accUUID === cleanUUID)) return true;

  if (Array.isArray(acc.linkedBarcodes)) {
    for (const b of acc.linkedBarcodes) {
      const bLower = String(b).trim().toLowerCase();
      const bUUID = barcodeToUUID(bLower).toLowerCase();
      if (bLower === clean || bLower === cleanBarcode || bUUID === clean || bUUID === cleanUUID) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Maps a raw Supabase database row from `parent_accounts` to the client-side `ParentAccount` model.
 */
export function mapRowToAccount(row: any): ParentAccount | null {
  if (!row) return null;
  const rawId = String(row.id || "").trim();
  const linked: string[] = Array.isArray(row.linked_student_barcodes)
    ? row.linked_student_barcodes.map(String)
    : [];
  const primaryBarcode = linked[0] || (rawId && !rawId.includes("-") ? rawId : rawId);

  return {
    id: rawId,
    studentBarcode: primaryBarcode,
    studentName: row.student_name || "",
    parentName: row.parent_name || "",
    parentPhone: String(row.parent_phone || "").trim(),
    password: row.password_hash || row.password || "",
    linkedBarcodes: linked.length > 0 ? linked : [primaryBarcode],
    fcmToken: row.fcm_token || "",
    status: (row.status || "active").toLowerCase() as "active" | "disabled" | "deleted",
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
    activatedAt: row.activated_at || row.created_at,
    reason: row.reason || "",
  };
}

/**
 * Converts the current ParentAccount array to the key-value dictionary and persists to localStorage.
 */
function syncLocalAccountsCache(accounts: ParentAccount[]): Record<string, ParentAccount> {
  const record: Record<string, ParentAccount> = {};
  for (const acc of accounts) {
    if (!acc) continue;
    const bCode = acc.studentBarcode;
    if (bCode) {
      record[bCode] = acc;
    }
    if (Array.isArray(acc.linkedBarcodes)) {
      for (const b of acc.linkedBarcodes) {
        if (b && !record[b]) {
          record[b] = acc;
        }
      }
    }
  }
  saveLocalParentAccounts(record);
  return record;
}

/**
 * Extracts initial parent accounts from local storage as an array.
 */
function getInitialAccountsArray(): ParentAccount[] {
  const map = getLocalParentAccounts();
  const seen = new Set<string>();
  const list: ParentAccount[] = [];

  for (const acc of Object.values(map)) {
    if (!acc || !acc.studentBarcode) continue;
    const key = acc.id || acc.studentBarcode;
    if (!seen.has(key)) {
      seen.add(key);
      list.push(acc);
    }
  }
  return list;
}

interface SubscriberCallbacks {
  id: string;
  setAccounts?: Dispatch<SetStateAction<ParentAccount[]>>;
  onAccountInserted?: (account: ParentAccount) => void;
  onAccountUpdated?: (account: ParentAccount) => void;
  onAccountDeleted?: (deletedId: string) => void;
}

// Module-level singleton channel and subscriber set
const activeSubscribers = new Set<SubscriberCallbacks>();
let sharedSyncChannel: any = null;

function ensureSharedSyncChannel() {
  if (sharedSyncChannel) {
    return sharedSyncChannel;
  }

  // If a channel already exists with this topic in Supabase client, clean it up first
  // to avoid: "cannot add postgres_changes callbacks for realtime:parent-accounts-sync after subscribe()"
  try {
    const existing = supabase
      .getChannels()
      .find(
        (ch) =>
          ch.topic === "realtime:parent-accounts-sync" ||
          ch.topic === "parent-accounts-sync"
      );
    if (existing) {
      supabase.removeChannel(existing);
    }
  } catch (err) {
    console.warn("[parent-accounts-sync] Channel cleanup notice:", err);
  }

  console.info("[parent-accounts-sync] Initializing dedicated Supabase Realtime CDC subscription...");

  const channel = supabase.channel("parent-accounts-sync");

  // ATTACH ALL POSTGRES_CHANGES CALLBACKS BEFORE CALLING .subscribe()
  channel
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "parent_accounts",
      },
      (payload: any) => {
        const newRow = payload?.new;
        if (!newRow) return;

        const newAccount = mapRowToAccount(newRow);
        if (!newAccount || !newAccount.studentBarcode) return;

        const identifier = newAccount.id || newAccount.studentBarcode;
        console.info(`[parent-accounts-sync] Realtime CDC INSERT received: ${identifier}`);

        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              const exists = prevAccounts.some((acc) => matchesAccount(acc, identifier));
              let next: ParentAccount[];
              if (exists) {
                next = prevAccounts.map((acc) =>
                  matchesAccount(acc, identifier) ? { ...acc, ...newAccount } : acc
                );
              } else {
                next = [...prevAccounts, newAccount];
              }
              const cloned = [...next];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountInserted?.(newAccount);
        });

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eman_account_sync", {
              detail: { event: "INSERT", account: newAccount },
            })
          );
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "parent_accounts",
      },
      (payload: any) => {
        const newRow = payload?.new;
        if (!newRow) return;

        const updatedAccount = mapRowToAccount(newRow);
        if (!updatedAccount || !updatedAccount.studentBarcode) return;

        const identifier = updatedAccount.id || updatedAccount.studentBarcode;
        const isDeletedStatus = String(updatedAccount.status || "").toLowerCase() === "deleted";

        console.info(
          `[parent-accounts-sync] Realtime CDC UPDATE received: ${identifier} (status: ${updatedAccount.status})`
        );

        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              let next: ParentAccount[];
              if (isDeletedStatus) {
                next = prevAccounts.filter((acc) => !matchesAccount(acc, identifier));
              } else {
                let found = false;
                const mapped = prevAccounts.map((acc) => {
                  if (matchesAccount(acc, identifier)) {
                    found = true;
                    return { ...acc, ...updatedAccount };
                  }
                  return acc;
                });
                next = found ? mapped : [...prevAccounts, updatedAccount];
              }
              const cloned = [...next];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountUpdated?.(updatedAccount);
        });

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eman_account_sync", {
              detail: { event: "UPDATE", account: updatedAccount },
            })
          );
        }
      }
    )
    .on(
      "postgres_changes",
      {
        event: "DELETE",
        schema: "public",
        table: "parent_accounts",
      },
      (payload: any) => {
        const oldRow = payload?.old;
        const deletedId = String(oldRow?.id || oldRow?.student_barcode || "").trim();
        if (!deletedId) return;

        console.info(`[parent-accounts-sync] Realtime CDC DELETE received: ID=${deletedId}`);

        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              const filtered = prevAccounts.filter((acc) => !matchesAccount(acc, deletedId));
              const cloned = [...filtered];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountDeleted?.(deletedId);
        });

        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eman_account_sync", {
              detail: { event: "DELETE", deletedId },
            })
          );
        }
      }
    );

  // Subscribe after all callbacks are registered
  channel.subscribe((status: string, err: any) => {
    if (status === "SUBSCRIBED") {
      console.info("[parent-accounts-sync] Dedicated Realtime CDC channel connected successfully.");
    } else if (status === "CHANNEL_ERROR") {
      console.warn("[parent-accounts-sync] Realtime CDC channel error:", err);
    }
  });

  sharedSyncChannel = channel;
  return channel;
}

/**
 * Senior Supabase Architect Realtime CDC Hook for Multi-Device Account State Synchronization
 */
export function useGlobalRealtimeSync(options?: UseGlobalRealtimeSyncOptions) {
  const [internalAccounts, setInternalAccounts] = useState<ParentAccount[]>(() => {
    if (options?.initialAccounts && options.initialAccounts.length > 0) {
      return options.initialAccounts;
    }
    return getInitialAccountsArray();
  });

  const [isConnected, setIsConnected] = useState<boolean>(false);

  // Determine whether to use external state or internal hook state
  const isControlled = Boolean(options?.accounts && options?.setAccounts);
  const accounts = isControlled ? (options!.accounts as ParentAccount[]) : internalAccounts;
  const setAccounts = isControlled ? options!.setAccounts! : setInternalAccounts;

  // Stable callback refs to avoid channel re-subscriptions on handler changes
  const onInsertedRef = useRef(options?.onAccountInserted);
  const onUpdatedRef = useRef(options?.onAccountUpdated);
  const onDeletedRef = useRef(options?.onAccountDeleted);

  useEffect(() => {
    onInsertedRef.current = options?.onAccountInserted;
    onUpdatedRef.current = options?.onAccountUpdated;
    onDeletedRef.current = options?.onAccountDeleted;
  }, [options?.onAccountInserted, options?.onAccountUpdated, options?.onAccountDeleted]);

  // Fast O(1) dictionary representation of the accounts array
  const accountsRecord = useMemo<Record<string, ParentAccount>>(() => {
    const record: Record<string, ParentAccount> = {};
    for (const acc of accounts) {
      if (!acc) continue;
      if (acc.studentBarcode) {
        record[acc.studentBarcode] = acc;
      }
      if (Array.isArray(acc.linkedBarcodes)) {
        for (const b of acc.linkedBarcodes) {
          if (b && !record[b]) {
            record[b] = acc;
          }
        }
      }
    }
    return record;
  }, [accounts]);

  // Dedicated Realtime Channel Setup via safe singleton pattern
  useEffect(() => {
    const subscriberId = Math.random().toString(36).slice(2, 9);
    const subscriber: SubscriberCallbacks = {
      id: subscriberId,
      setAccounts,
      onAccountInserted: (acc) => onInsertedRef.current?.(acc),
      onAccountUpdated: (acc) => onUpdatedRef.current?.(acc),
      onAccountDeleted: (id) => onDeletedRef.current?.(id),
    };

    activeSubscribers.add(subscriber);
    setIsConnected(true);

    ensureSharedSyncChannel();

    return () => {
      activeSubscribers.delete(subscriber);
      if (activeSubscribers.size === 0 && sharedSyncChannel) {
        try {
          supabase.removeChannel(sharedSyncChannel);
        } catch (e) {
          console.warn("[parent-accounts-sync] Error removing channel on cleanup:", e);
        }
        sharedSyncChannel = null;
        setIsConnected(false);
      }
    };
  }, [setAccounts]);

  /**
   * Local Delete Mutation:
   * Awaits Supabase delete query cleanly and forces a fresh state reference clone.
   */
  const deleteAccount = useCallback(
    async (idOrBarcode: string): Promise<boolean> => {
      const cleanId = String(idOrBarcode || "").trim();
      if (!cleanId) return false;

      const cleanBarcode = normalizeBarcode(cleanId);
      const uuid = barcodeToUUID(cleanBarcode || cleanId);

      try {
        // Cleanly await the server response
        const { error } = await supabase
          .from("parent_accounts")
          .delete()
          .or(`id.eq.${uuid},id.eq.${cleanId},id.eq.${cleanBarcode}`);

        if (error) {
          console.warn("[useGlobalRealtimeSync] deleteAccount mutation server error:", error.message);
          return false;
        }

        // Instantly prune local state across all active subscribers and force fresh state reference clone [...prevAccounts]
        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              const filtered = prevAccounts.filter((acc) => !matchesAccount(acc, cleanId));
              const cloned = [...filtered];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountDeleted?.(cleanId);
        });

        return true;
      } catch (err) {
        console.error("[useGlobalRealtimeSync] deleteAccount exception:", err);
        return false;
      }
    },
    []
  );

  /**
   * Local Update Mutation:
   * Awaits Supabase update query cleanly and forces a fresh state reference clone.
   */
  const updateAccount = useCallback(
    async (idOrBarcode: string, updates: Partial<ParentAccount>): Promise<boolean> => {
      const cleanId = String(idOrBarcode || "").trim();
      if (!cleanId) return false;

      const cleanBarcode = normalizeBarcode(cleanId);
      const uuid = barcodeToUUID(cleanBarcode || cleanId);
      const nowIso = new Date().toISOString();

      const dbPayload: any = {
        updated_at: nowIso,
      };

      if (updates.status) dbPayload.status = updates.status;
      if (updates.parentPhone) dbPayload.parent_phone = updates.parentPhone;
      if (updates.password) dbPayload.password_hash = updates.password;
      if (updates.fcmToken !== undefined) dbPayload.fcm_token = updates.fcmToken;
      if (updates.linkedBarcodes) dbPayload.linked_student_barcodes = updates.linkedBarcodes;
      if (updates.studentName) dbPayload.student_name = updates.studentName;
      if (updates.parentName) dbPayload.parent_name = updates.parentName;
      if (updates.reason !== undefined) dbPayload.reason = updates.reason;

      try {
        // Cleanly await the server response
        const { error } = await supabase
          .from("parent_accounts")
          .update(dbPayload)
          .or(`id.eq.${uuid},id.eq.${cleanId},id.eq.${cleanBarcode}`);

        if (error) {
          console.warn("[useGlobalRealtimeSync] updateAccount mutation server error:", error.message);
          return false;
        }

        // Instantly update local state with fresh reference clone
        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              const updated = prevAccounts.map((acc) =>
                matchesAccount(acc, cleanId) ? { ...acc, ...updates, updatedAt: nowIso } : acc
              );
              const cloned = [...updated];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountUpdated?.({
            studentBarcode: cleanBarcode || cleanId,
            ...updates,
            updatedAt: nowIso,
          } as ParentAccount);
        });

        return true;
      } catch (err) {
        console.error("[useGlobalRealtimeSync] updateAccount exception:", err);
        return false;
      }
    },
    []
  );

  /**
   * Local Insert/Upsert Mutation:
   * Awaits Supabase upsert query cleanly and forces a fresh state reference clone.
   */
  const insertAccount = useCallback(
    async (account: ParentAccount): Promise<boolean> => {
      if (!account || !account.studentBarcode) return false;

      const cleanBarcode = normalizeBarcode(account.studentBarcode);
      const uuid = account.id || barcodeToUUID(cleanBarcode);
      const nowIso = new Date().toISOString();

      const dbPayload = {
        id: uuid,
        student_name: account.studentName || "",
        parent_name: account.parentName || "",
        parent_phone: account.parentPhone || "",
        password_hash: account.password || "1234",
        linked_student_barcodes:
          account.linkedBarcodes && account.linkedBarcodes.length > 0
            ? account.linkedBarcodes
            : [cleanBarcode],
        fcm_token: account.fcmToken || "",
        status: account.status || "active",
        created_at: account.createdAt || nowIso,
        updated_at: nowIso,
        activated_at: account.activatedAt || nowIso,
      };

      try {
        // Cleanly await the server response
        const { error } = await supabase
          .from("parent_accounts")
          .upsert(dbPayload, { onConflict: "id" });

        if (error) {
          console.warn("[useGlobalRealtimeSync] insertAccount mutation server error:", error.message);
          return false;
        }

        const normalizedAccount: ParentAccount = {
          ...account,
          id: uuid,
          studentBarcode: cleanBarcode,
          updatedAt: nowIso,
        };

        // Append to state array and force fresh state reference clone [...prevAccounts]
        activeSubscribers.forEach((sub) => {
          if (sub.setAccounts) {
            sub.setAccounts((prevAccounts) => {
              const exists = prevAccounts.some((acc) => matchesAccount(acc, uuid));
              const next = exists
                ? prevAccounts.map((acc) => (matchesAccount(acc, uuid) ? normalizedAccount : acc))
                : [...prevAccounts, normalizedAccount];
              const cloned = [...next];
              syncLocalAccountsCache(cloned);
              return cloned;
            });
          }
          sub.onAccountInserted?.(normalizedAccount);
        });

        return true;
      } catch (err) {
        console.error("[useGlobalRealtimeSync] insertAccount exception:", err);
        return false;
      }
    },
    []
  );

  /**
   * Hydrates state directly from Supabase parent_accounts table.
   */
  const refreshAccounts = useCallback(async (): Promise<ParentAccount[]> => {
    try {
      const { data, error } = await supabase
        .from("parent_accounts")
        .select("*")
        .order("created_at", { ascending: false });

      if (error || !data) {
        return accounts;
      }

      const list: ParentAccount[] = [];
      const seen = new Set<string>();

      for (const row of data) {
        const acc = mapRowToAccount(row);
        if (acc && acc.studentBarcode && !seen.has(acc.studentBarcode)) {
          seen.add(acc.studentBarcode);
          list.push(acc);
        }
      }

      setAccounts(list);
      syncLocalAccountsCache(list);
      return list;
    } catch (err) {
      console.warn("[useGlobalRealtimeSync] Error refreshing accounts:", err);
      return accounts;
    }
  }, [accounts, setAccounts]);

  return {
    accounts,
    accountsRecord,
    setAccounts,
    deleteAccount,
    updateAccount,
    insertAccount,
    refreshAccounts,
    isConnected,
  };
}
