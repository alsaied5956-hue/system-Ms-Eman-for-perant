/**
 * Timezone Parity & Localized Date/Time Formatting Utilities
 * Standardizes all UTC timestamps from Supabase using local browser timezone formatting
 * via Intl.DateTimeFormat with graceful Arabic locale ("ar-EG").
 */

/**
 * Resolves the client device / browser local timezone
 */
export function getUserTimeZone(): string {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) return tz;
    }
  } catch {}
  return "Africa/Cairo"; // Resilient fallback for Egyptian education portal
}

/**
 * Normalizes input date/timestamp string into a valid Date object
 */
export function parseUtcDate(input: string | number | Date | null | undefined): Date | null {
  if (!input) return null;
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === "number") {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof input === "string") {
    let str = input.trim();
    if (!str) return null;

    // If format is purely YYYY-MM-DD, append midnight T00:00:00 to avoid timezone backward shift
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const parts = str.split("-").map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    }

    // Standard ISO string or timestamp string
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Formats a UTC timestamp into localized full date and time string
 * Example: "الأربعاء، 16 سبتمبر 2026 في 04:30 م"
 */
export function formatLocalDateTime(
  dateInput: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = parseUtcDate(dateInput);
  if (!d) return "";

  try {
    const defaultOptions: Intl.DateTimeFormatOptions = {
      timeZone: getUserTimeZone(),
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...options,
    };
    return new Intl.DateTimeFormat("ar-EG", defaultOptions).format(d);
  } catch (err) {
    return d.toLocaleString("ar-EG");
  }
}

/**
 * Formats a UTC timestamp into localized date only
 * Example: "16 سبتمبر 2026" or "الأربعاء، 16 سبتمبر 2026"
 */
export function formatLocalDate(
  dateInput: string | number | Date | null | undefined,
  includeWeekday = false
): string {
  const d = parseUtcDate(dateInput);
  if (!d) return "";

  try {
    const options: Intl.DateTimeFormatOptions = {
      timeZone: getUserTimeZone(),
      year: "numeric",
      month: "long",
      day: "numeric",
      ...(includeWeekday ? { weekday: "long" } : {}),
    };
    return new Intl.DateTimeFormat("ar-EG", options).format(d);
  } catch {
    return d.toLocaleDateString("ar-EG");
  }
}

/**
 * Formats a UTC timestamp into localized time only
 * Example: "04:30 م"
 */
export function formatLocalTime(
  dateInput: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = parseUtcDate(dateInput);
  if (!d) return "";

  try {
    const defaultOptions: Intl.DateTimeFormatOptions = {
      timeZone: getUserTimeZone(),
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...options,
    };
    return new Intl.DateTimeFormat("ar-EG", defaultOptions).format(d);
  } catch {
    return d.toLocaleTimeString("ar-EG");
  }
}

/**
 * Formats a UTC timestamp into human-readable relative time in Arabic
 * Example: "الآن", "منذ 5 دقائق", "اليوم في 04:30 م", "أمس"
 */
export function formatRelativeTime(
  dateInput: string | number | Date | null | undefined
): string {
  const d = parseUtcDate(dateInput);
  if (!d) return "";

  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 45) return "الآن";
  if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
  if (diffHours < 24) return `منذ ${diffHours} ساعة`;
  if (diffDays === 1) return `أمس في ${formatLocalTime(d)}`;
  if (diffDays < 7) return `منذ ${diffDays} أيام`;

  return formatLocalDate(d);
}
