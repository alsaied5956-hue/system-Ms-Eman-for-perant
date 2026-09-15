/**
 * IndexedDB Purge & Deactivation Module
 * In compliance with cloud-first architecture, all offline snapshot caching and
 * IndexedDB state fallbacks are strictly disabled and purged to guarantee zero
 * data divergence between installed PWA apps and live browser views.
 */

const DB_NAME = "AimanCenterDB_v1";

interface OperationRecord {
  id: string;
  type: string;
  payload: any;
  timestamp: number;
}

// Purge all legacy IndexedDB stores on initialization
export async function purgeAllOfflineDatabases(): Promise<void> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return;
  try {
    const dbsToPurge = ["AimanCenterDB_v1", "TeacherEmanOfflineDB", "eman_offline_store"];
    dbsToPurge.forEach((name) => {
      try {
        indexedDB.deleteDatabase(name);
      } catch {}
    });
  } catch (err) {
    console.info("IndexedDB purge notice:", err);
  }
}

// Automatically trigger purge in browser
if (typeof window !== "undefined") {
  purgeAllOfflineDatabases().catch(() => {});
}

export async function openIndexedDB(): Promise<IDBDatabase | null> {
  // Offline IndexedDB is disabled in favor of live Supabase Cloud state
  return null;
}

/**
 * Save an operation to IndexedDB pending queue (disabled in cloud-only mode)
 */
export async function saveOperationToIndexedDB(_op: OperationRecord): Promise<void> {
  // No-op: Supabase is source of truth
}

/**
 * Get all pending operations from IndexedDB (always returns empty array)
 */
export async function getPendingOperationsFromIndexedDB(): Promise<OperationRecord[]> {
  return [];
}

/**
 * Delete specific operations from IndexedDB once committed to Firestore
 */
export async function removeOperationsFromIndexedDB(_ids: string[]): Promise<void> {
  // No-op
}

/**
 * Save system state snapshot to IndexedDB (disabled to prevent stale data divergence)
 */
export async function saveSnapshotToIndexedDB(_key: string, _data: any): Promise<void> {
  // No-op: Offline snapshots disabled
}

/**
 * Load system state snapshot from IndexedDB (strictly returns null to force live Supabase fetch)
 */
export async function loadSnapshotFromIndexedDB(_key: string): Promise<any | null> {
  return null;
}

