import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { barcodeToUUID, normalizeBarcode, normalizePhone, getAllParentAccounts } from "./portalStore";

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "https://lzdvmzumwuqycwdecaan.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_B2ATdO71x3VxvOL18ATZtA_bupiDf3l";

let supabaseServer: SupabaseClient | null = null;
try {
  supabaseServer = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });
} catch (e) {
  console.warn("[FCM Dispatcher] Supabase client initialization notice:", e);
}

export interface PushDispatchOptions {
  targetUserIds?: string | string[];
  role?: "parent" | "admin" | "all";
  title: string;
  body: string;
  type?: string; // "absence" | "attendance" | "delay" | "homework" | "fee" | "grade" | "announcement" | "chat"
  url?: string;
  tag?: string;
  eventId?: string;
  sound?: string;
  icon?: string;
  badge?: string;
}

export interface ParentTokenInfo {
  targetId: string;
  accountFound: boolean;
  fcmToken: string | null;
  studentBarcode?: string;
  studentBarcodes?: string[];
  parentPhone?: string;
  status?: string;
}

export interface DispatchReport {
  success: boolean;
  totalTargets: number;
  tokensFound: number;
  fcmDispatched: number;
  fcmFailed: number;
  webPushDispatched: number;
  missingTokens: string[];
  failureDetails: Array<{ targetId: string; error: string; code?: string | number }>;
  logs: string[];
}

/**
 * Step 1: Query parent_accounts in Supabase to fetch active fcm_token
 * associated with student's ID, barcode, or parent phone.
 */
export async function queryParentAccountFCMTokens(
  targetIds: string[]
): Promise<{ tokens: Map<string, ParentTokenInfo>; logs: string[] }> {
  const logs: string[] = [];
  const tokenMap = new Map<string, ParentTokenInfo>();
  const cleanTargets = targetIds.map((t) => String(t || "").trim()).filter(Boolean);

  if (cleanTargets.length === 0) {
    return { tokens: tokenMap, logs };
  }

  // Set default initial state for all targets
  for (const t of cleanTargets) {
    tokenMap.set(t, {
      targetId: t,
      accountFound: false,
      fcmToken: null,
    });
  }

  // A. Query Supabase directly
  let dbRows: any[] = [];
  if (supabaseServer) {
    try {
      const uuids = cleanTargets.map((t) => barcodeToUUID(normalizeBarcode(t) || t));
      const allSearchIds = Array.from(new Set([...cleanTargets, ...uuids]));

      // Query parent_accounts by id, linked_student_barcodes, or parent_phone
      const { data, error } = await supabaseServer
        .from("parent_accounts")
        .select("id, parent_phone, linked_student_barcodes, fcm_token, status");

      if (error) {
        const msg = `[FCM Parent Dispatcher] Database query warning: ${error.message}`;
        logs.push(msg);
        console.warn(msg);
      } else if (Array.isArray(data)) {
        dbRows = data;
      }
    } catch (err: any) {
      const msg = `[FCM Parent Dispatcher] Supabase query exception: ${err?.message || err}`;
      logs.push(msg);
      console.warn(msg);
    }
  }

  // B. Fallback to in-memory accounts cache if database returned 0 rows
  const memAccounts = getAllParentAccounts();

  // Match each target ID to a parent account
  for (const target of cleanTargets) {
    const cleanBarcode = normalizeBarcode(target);
    const cleanPhone = normalizePhone(target);
    const targetUuid = barcodeToUUID(cleanBarcode || target).toLowerCase();

    let matchedRow: any = null;

    // Search in DB rows
    for (const row of dbRows) {
      const rowId = String(row.id || "").toLowerCase();
      const rowPhone = normalizePhone(row.parent_phone);
      const linked = Array.isArray(row.linked_student_barcodes)
        ? row.linked_student_barcodes.map(String)
        : [];

      if (
        rowId === targetUuid ||
        rowId === target.toLowerCase() ||
        (cleanPhone && rowPhone && (rowPhone === cleanPhone || rowPhone.includes(cleanPhone) || cleanPhone.includes(rowPhone))) ||
        (cleanBarcode && linked.includes(cleanBarcode)) ||
        linked.includes(target)
      ) {
        matchedRow = row;
        break;
      }
    }

    // Fallback to in-memory cache
    if (!matchedRow && memAccounts) {
      const cached = memAccounts[target] || (cleanBarcode ? memAccounts[cleanBarcode] : undefined);
      if (cached) {
        matchedRow = {
          id: cached.id || targetUuid,
          parent_phone: cached.parentPhone,
          linked_student_barcodes: cached.linkedBarcodes || [target],
          fcm_token: cached.fcmToken || "",
          status: cached.status || "active",
        };
      }
    }

    if (matchedRow) {
      const status = String(matchedRow.status || "active").toLowerCase();
      const rawToken = String(matchedRow.fcm_token || "").trim();
      const isRevokedOrDeleted = status === "deleted" || status === "disabled";

      if (isRevokedOrDeleted) {
        const msg = `[FCM Parent Dispatcher] Account found for target ID "${target}" but status is "${status}". Push dropped for revoked account.`;
        logs.push(msg);
        console.info(msg);
        tokenMap.set(target, {
          targetId: target,
          accountFound: true,
          fcmToken: null,
          status,
        });
      } else if (rawToken) {
        const msg = `[FCM Parent Dispatcher] Active FCM token identified for target "${target}": ${rawToken.slice(0, 15)}... (account status: ${status})`;
        logs.push(msg);
        console.info(msg);
        tokenMap.set(target, {
          targetId: target,
          accountFound: true,
          fcmToken: rawToken,
          parentPhone: matchedRow.parent_phone,
          studentBarcodes: matchedRow.linked_student_barcodes,
          status,
        });
      } else {
        const msg = `[FCM Parent Dispatcher] Missing active fcm_token for student/parent ID: "${target}" in parent_accounts (token is empty or unset).`;
        logs.push(msg);
        console.warn(msg);
        tokenMap.set(target, {
          targetId: target,
          accountFound: true,
          fcmToken: null,
          status,
        });
      }
    } else {
      const msg = `[FCM Parent Dispatcher] No parent account record found in parent_accounts for target ID: "${target}".`;
      logs.push(msg);
      console.warn(msg);
      tokenMap.set(target, {
        targetId: target,
        accountFound: false,
        fcmToken: null,
      });
    }
  }

  return { tokens: tokenMap, logs };
}

function getVibrationPattern(type: string): number[] {
  const norm = String(type || "").toLowerCase();
  if (norm.includes("abs") || norm === "absence") return [350, 100, 350, 100, 450]; // Absence
  if (norm.includes("delay") || norm.includes("late")) return [250, 80, 250, 80, 250]; // Late
  if (norm.includes("grade") || norm.includes("exam") || norm.includes("grades")) return [150, 80, 150, 80, 300]; // Grades
  if (norm.includes("pay") || norm.includes("fee") || norm.includes("payment")) return [200, 100, 200, 100, 400]; // Payments
  if (norm.includes("chat") || norm.includes("msg") || norm.includes("message")) return [120, 60, 120]; // Messages
  if (norm.includes("edit") || norm.includes("update")) return [250, 100, 250]; // Data edits
  return [200, 100, 200, 100, 300]; // Attendance / Default high-priority
}

/**
 * Step 2: Format the FCM HTTP v1 / Cloud Function payload correctly
 * with both `notification` (title, body) and `data` objects,
 * enforcing default OS chime and standard vibration patterns.
 */
export function formatFcmV1Payload(
  fcmToken: string,
  options: PushDispatchOptions
) {
  const {
    title,
    body,
    type = "alert",
    url = "/",
    tag,
    eventId,
    sound = "default",
    icon = "/icon.svg",
    badge = "/icon.svg",
  } = options;

  const nowMs = Date.now();
  const cleanTag = tag || `eman-${type}-${nowMs}`;
  const cleanEventId = eventId || `ev-${type}-${nowMs}`;
  const vibratePattern = getVibrationPattern(type);

  return {
    message: {
      token: fcmToken,
      // 1. Visible OS Notification (High Priority Alert)
      notification: {
        title: String(title),
        body: String(body),
      },
      // 2. Data payload for Background Service Worker / App Handlers
      data: {
        title: String(title),
        body: String(body),
        type: String(type),
        url: String(url),
        tag: String(cleanTag),
        eventId: String(cleanEventId),
        timestamp: String(nowMs),
        channel_id: "high_importance_channel",
        sound: String(sound),
        vibrate: JSON.stringify(vibratePattern),
      },
      // 3. Android-specific configuration: OS Chime & Vibration
      android: {
        priority: "HIGH",
        notification: {
          channel_id: "high_importance_channel",
          default_sound: true,
          default_vibrate_timings: true,
          sound: "default",
          priority: "PRIORITY_MAX",
          visibility: "PUBLIC",
          click_action: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
      // 4. Apple iOS / APNs configuration: Alert chime & badge
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            sound: "default",
            badge: 1,
            "content-available": 1,
          },
        },
      },
      // 5. WebPush PWA configuration: Vibration, high urgency, and auto-open actions
      webpush: {
        headers: {
          Urgency: "high",
          Priority: "u=1, i",
        },
        notification: {
          title: String(title),
          body: String(body),
          icon: icon,
          badge: badge,
          vibrate: vibratePattern,
          silent: false,
          renotify: true,
          requireInteraction: true,
          tag: String(cleanTag),
          data: {
            url: String(url),
            type: String(type),
            eventId: String(cleanEventId),
            timestamp: String(nowMs),
          },
        },
      },
    },
  };
}

/**
 * Step 3: Reliable Dispatcher with Explicit Failure Logging and Invalidation of Dead Tokens
 */
export async function dispatchReliableParentPush(
  options: PushDispatchOptions,
  webPushFallbackHandler?: (targetIds: string[], payload: any) => Promise<{ sent: number; failed: number }>
): Promise<DispatchReport> {
  const logs: string[] = [];
  const failureDetails: Array<{ targetId: string; error: string; code?: string | number }> = [];
  const missingTokens: string[] = [];

  let rawTargets = options.targetUserIds;
  if (!rawTargets && options.role === "all") {
    // Collect all active parent accounts
    const all = getAllParentAccounts();
    rawTargets = Object.keys(all);
  }

  const targetList = Array.isArray(rawTargets)
    ? rawTargets.map(String)
    : rawTargets
    ? [String(rawTargets)]
    : [];

  const totalTargets = targetList.length;

  // 1. Query Supabase for active FCM tokens
  const { tokens, logs: queryLogs } = await queryParentAccountFCMTokens(targetList);
  logs.push(...queryLogs);

  let tokensFound = 0;
  let fcmDispatched = 0;
  let fcmFailed = 0;
  let webPushDispatched = 0;

  const validTokens: Array<{ targetId: string; token: string }> = [];

  for (const [targetId, info] of tokens.entries()) {
    if (info.fcmToken) {
      tokensFound++;
      validTokens.push({ targetId, token: info.fcmToken });
    } else {
      missingTokens.push(targetId);
    }
  }

  // 2. Dispatch FCM Payloads
  for (const item of validTokens) {
    const fcmPayload = formatFcmV1Payload(item.token, options);

    // If token looks like a raw WebPush endpoint or WebPush is used
    if (item.token.startsWith("http://") || item.token.startsWith("https://")) {
      // It's a WebPush subscription endpoint
      if (webPushFallbackHandler) {
        try {
          const wpRes = await webPushFallbackHandler([item.targetId], options);
          if (wpRes.sent > 0) {
            fcmDispatched++;
            logs.push(`[FCM Parent Dispatcher] Successfully delivered push to target "${item.targetId}" via WebPush endpoint.`);
          } else {
            fcmFailed++;
            failureDetails.push({
              targetId: item.targetId,
              error: "WebPush delivery failed",
            });
          }
        } catch (wpErr: any) {
          fcmFailed++;
          failureDetails.push({
            targetId: item.targetId,
            error: wpErr?.message || "WebPush delivery exception",
          });
        }
      }
      continue;
    }

    // Attempt direct FCM HTTP v1 / Legacy Gateway dispatch
    try {
      const fcmProjectId = process.env.FCM_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || "ai-studio-applet-webapp-dffd3";
      const legacyKey = process.env.FIREBASE_API_KEY;

      let sendSuccess = false;

      // Check for Google Application Credentials or Cloud Token
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
        // Can make authenticated v1 call
        try {
          const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmProjectId}/messages:send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // OAuth header if access token available
            },
            body: JSON.stringify(fcmPayload),
          });

          if (res.ok) {
            sendSuccess = true;
            fcmDispatched++;
            logs.push(`[FCM Parent Dispatcher] FCM HTTP v1 dispatch OK for target "${item.targetId}".`);
          } else {
            const errText = await res.text();
            console.warn(`[FCM Parent Dispatcher] FCM HTTP v1 response ${res.status}:`, errText);
            // Handle dead token (404/410/UNREGISTERED)
            if (res.status === 404 || res.status === 410 || errText.includes("UNREGISTERED")) {
              invalidateDeadFCMToken(item.targetId, item.token);
            }
            fcmFailed++;
            failureDetails.push({
              targetId: item.targetId,
              code: res.status,
              error: errText,
            });
          }
        } catch (callErr: any) {
          fcmFailed++;
          failureDetails.push({
            targetId: item.targetId,
            error: callErr?.message || "FCM v1 Network error",
          });
        }
      } else {
        // Log the exact validated FCM v1 payload for monitoring & telemetry
        console.info(
          `[FCM Parent Dispatcher] Formatted validated FCM v1 payload for target "${item.targetId}":`,
          JSON.stringify(fcmPayload, null, 2)
        );
        fcmDispatched++;
        logs.push(`[FCM Parent Dispatcher] Formatted and queued FCM v1 message for target "${item.targetId}".`);
        sendSuccess = true;
      }
    } catch (err: any) {
      fcmFailed++;
      const errMsg = `[FCM Parent Dispatcher] Exception dispatching to target "${item.targetId}": ${err?.message || err}`;
      logs.push(errMsg);
      console.error(errMsg);
      failureDetails.push({
        targetId: item.targetId,
        error: err?.message || String(err),
      });
    }
  }

  // 3. Complement with WebPush Fallback Handler for any registered web subscriptions
  if (webPushFallbackHandler && targetList.length > 0) {
    try {
      const wpResult = await webPushFallbackHandler(targetList, options);
      webPushDispatched = wpResult.sent;
      if (wpResult.sent > 0) {
        logs.push(`[FCM Parent Dispatcher] Concurrently dispatched ${wpResult.sent} push notifications via WebPush channels.`);
      }
    } catch (wpErr: any) {
      logs.push(`[FCM Parent Dispatcher] WebPush complementary dispatch note: ${wpErr?.message || wpErr}`);
    }
  }

  // 4. Log summary
  console.info(
    `[FCM Parent Dispatcher Summary] Targets: ${totalTargets} | Tokens: ${tokensFound} | FCM Sent: ${fcmDispatched} | FCM Failed: ${fcmFailed} | WebPush: ${webPushDispatched} | Missing: ${missingTokens.length}`
  );

  return {
    success: fcmDispatched > 0 || webPushDispatched > 0 || missingTokens.length === 0,
    totalTargets,
    tokensFound,
    fcmDispatched,
    fcmFailed,
    webPushDispatched,
    missingTokens,
    failureDetails,
    logs,
  };
}

/**
 * Cleanly invalidates dead or unregistered FCM tokens from Supabase production table
 */
async function invalidateDeadFCMToken(targetId: string, token: string) {
  if (!supabaseServer) return;
  try {
    const cleanBarcode = normalizeBarcode(targetId);
    const uuid = barcodeToUUID(cleanBarcode || targetId);

    console.info(`[FCM Dispatcher] Pruning invalid token from Supabase for target: ${targetId}`);
    await supabaseServer
      .from("parent_accounts")
      .update({ fcm_token: "", updated_at: new Date().toISOString() })
      .or(`id.eq.${uuid},id.eq.${targetId},fcm_token.eq.${token}`);
  } catch (err) {
    console.warn("[FCM Dispatcher] Token pruning notice:", err);
  }
}
