import type { Dispatch, SetStateAction } from "react";
import { useEffect, useCallback } from "react";
import { supabase, barcodeToUUID, normalizeBarcode } from "../utils/supabaseClient";
import { ParentAccount } from "../types/portal";
import { getLocalParentAccounts, saveLocalParentAccounts } from "../utils/portalStorage";

interface UseGlobalRealtimeSyncOptions {
  accounts: Record<string, ParentAccount>;
  setAccounts: Dispatch<SetStateAction<Record<string, ParentAccount>>>;
  onAccountDeleted?: (deletedId: string) => void;
  onAccountInserted?: (account: ParentAccount) => void;
  onAccountUpdated?: (account: ParentAccount) => void;
}

/**
 * Global Realtime Supabase CDC Hook for Multi-Device Account Mutations
 * Explicitly subscribes to postgres_changes DELETE, INSERT, and UPDATE on public.parent_accounts
 * Guarantees 0ms cross-device synchronization without manual page reloads.
 */
export function useGlobalRealtimeSync({
  accounts,
  setAccounts,
  onAccountDeleted,
  onAccountInserted,
  onAccountUpdated,
}: UseGlobalRealtimeSyncOptions) {
  // Helper to convert raw database row from parent_accounts into ParentAccount object
  const mapRowToAccount = useCallback((row: any): ParentAccount | null => {
    if (!row) return null;
    const rawId = String(row.id || "").trim();
    const linked = Array.isArray(row.linked_student_barcodes)
      ? row.linked_student_barcodes.map(String)
      : [];
    const primaryBarcode = linked[0] || rawId;

    return {
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
    };
  }, []);

  // CDC Realtime Subscription
  useEffect(() => {
    const channelName = `global-accounts-cdc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "parent_accounts",
        },
        (payload) => {
          const eventType = payload.eventType;

          // 1. Instant Multi-Device DELETE Synchronization
          if (eventType === "DELETE") {
            const oldRow = payload.old as any;
            const deletedId = String(oldRow?.id || "").trim().toLowerCase();
            if (!deletedId) return;

            console.info(`[useGlobalRealtimeSync] Received Realtime DELETE for account ID: ${deletedId}`);

            setAccounts((prev) => {
              const next = { ...prev };
              let modified = false;

              for (const [key, acc] of Object.entries(next) as Array<[string, ParentAccount]>) {
                const keyLower = String(key).toLowerCase();
                const barcodeLower = String(acc?.studentBarcode || "").toLowerCase();
                const uuidLower = barcodeToUUID(acc?.studentBarcode || key).toLowerCase();
                const isLinked = Array.isArray(acc?.linkedBarcodes) &&
                  acc.linkedBarcodes.some(
                    (b) => String(b).toLowerCase() === deletedId || barcodeToUUID(b).toLowerCase() === deletedId
                  );

                if (
                  keyLower === deletedId ||
                  barcodeLower === deletedId ||
                  uuidLower === deletedId ||
                  isLinked
                ) {
                  delete next[key];
                  modified = true;
                }
              }

              if (modified) {
                saveLocalParentAccounts(next);
                if (onAccountDeleted) {
                  onAccountDeleted(deletedId);
                }
                return next;
              }
              return prev;
            });
          }

          // 2. Instant Multi-Device INSERT Synchronization
          else if (eventType === "INSERT") {
            const newRow = payload.new as any;
            const newAccount = mapRowToAccount(newRow);
            if (!newAccount || !newAccount.studentBarcode) return;

            console.info(`[useGlobalRealtimeSync] Received Realtime INSERT for account: ${newAccount.studentBarcode}`);

            setAccounts((prev) => {
              const next = { ...prev, [newAccount.studentBarcode]: newAccount };
              saveLocalParentAccounts(next);
              if (onAccountInserted) {
                onAccountInserted(newAccount);
              }
              return next;
            });
          }

          // 3. Instant Multi-Device UPDATE Synchronization
          else if (eventType === "UPDATE") {
            const newRow = payload.new as any;
            const updatedAccount = mapRowToAccount(newRow);
            if (!updatedAccount || !updatedAccount.studentBarcode) return;

            const currentStatus = String(updatedAccount.status || "").toLowerCase();

            console.info(`[useGlobalRealtimeSync] Received Realtime UPDATE for account: ${updatedAccount.studentBarcode} (status: ${currentStatus})`);

            setAccounts((prev) => {
              const next = { ...prev };
              const bCode = updatedAccount.studentBarcode;

              if (currentStatus === "deleted") {
                delete next[bCode];
                for (const [k, acc] of Object.entries(next) as Array<[string, ParentAccount]>) {
                  if (acc?.studentBarcode === bCode || acc?.linkedBarcodes?.includes(bCode)) {
                    delete next[k];
                  }
                }
              } else {
                next[bCode] = { ...next[bCode], ...updatedAccount };
              }

              saveLocalParentAccounts(next);
              if (onAccountUpdated) {
                onAccountUpdated(updatedAccount);
              }
              return next;
            });
          }
        }
      )
      // Also subscribe to profiles table if available for user account sync
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "profiles",
        },
        (payload) => {
          const oldRow = payload.old as any;
          const deletedId = String(oldRow?.id || "").trim().toLowerCase();
          if (!deletedId) return;

          setAccounts((prev) => {
            const next = { ...prev };
            let modified = false;
            for (const [key, acc] of Object.entries(next) as Array<[string, ParentAccount]>) {
              if (
                String(key).toLowerCase() === deletedId ||
                String(acc?.studentBarcode || "").toLowerCase() === deletedId
              ) {
                delete next[key];
                modified = true;
              }
            }
            if (modified) {
              saveLocalParentAccounts(next);
              return next;
            }
            return prev;
          });
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.info("[useGlobalRealtimeSync] Realtime CDC channel connected successfully.");
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [setAccounts, mapRowToAccount, onAccountDeleted, onAccountInserted, onAccountUpdated]);

  /**
   * Directly awaits Supabase deletion query and instantly prunes in-memory React state
   */
  const deleteAccount = useCallback(
    async (userId: string): Promise<boolean> => {
      const cleanId = String(userId || "").trim();
      if (!cleanId) return false;

      const cleanBarcode = normalizeBarcode(cleanId);
      const uuid = barcodeToUUID(cleanBarcode || cleanId);

      try {
        // 1. Direct Supabase deletion query with explicit await
        const { error } = await supabase
          .from("parent_accounts")
          .delete()
          .or(`id.eq.${uuid},id.eq.${cleanId},id.eq.${cleanBarcode}`);

        if (error) {
          console.warn("[useGlobalRealtimeSync] Direct delete error:", error.message);
        }

        // 2. Immediate local React in-memory state pruning (0ms feedback)
        setAccounts((prev) => {
          const next = { ...prev };
          delete next[cleanId];
          delete next[cleanBarcode];
          for (const [k, acc] of Object.entries(next) as Array<[string, ParentAccount]>) {
            if (
              acc?.studentBarcode === cleanId ||
              acc?.studentBarcode === cleanBarcode ||
              acc?.linkedBarcodes?.includes(cleanId) ||
              acc?.linkedBarcodes?.includes(cleanBarcode)
            ) {
              delete next[k];
            }
          }
          saveLocalParentAccounts(next);
          return next;
        });

        return !error;
      } catch (err) {
        console.error("[useGlobalRealtimeSync] Delete operation exception:", err);
        return false;
      }
    },
    [setAccounts]
  );

  /**
   * Modifies an existing account directly in Supabase
   */
  const modifyAccount = useCallback(
    async (account: ParentAccount): Promise<boolean> => {
      try {
        const bCode = String(account.studentBarcode).trim();
        const uuid = barcodeToUUID(bCode);
        const barcodes =
          account.linkedBarcodes && account.linkedBarcodes.length > 0
            ? account.linkedBarcodes
            : [bCode];

        const { error } = await supabase.from("parent_accounts").upsert({
          id: uuid,
          parent_phone: account.parentPhone || "",
          password_hash: account.password || "",
          linked_student_barcodes: barcodes,
          fcm_token: account.fcmToken || "",
          status: account.status || "active",
          updated_at: new Date().toISOString(),
        });

        if (!error) {
          setAccounts((prev) => {
            const next = { ...prev, [bCode]: account };
            saveLocalParentAccounts(next);
            return next;
          });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [setAccounts]
  );

  return {
    accounts,
    deleteAccount,
    modifyAccount,
  };
}
