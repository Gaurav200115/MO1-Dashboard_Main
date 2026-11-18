import { readSession } from "@/lib/kite/session";
import { sendTelegram } from "./telegram";

/**
 * The morning Kite sign-in reminder: 09:00 IST, Monday to Friday, on Telegram,
 * with the link that signs in.
 *
 * The token dies at 06:00 IST every day and nothing trades until it is minted
 * again by hand - the sign-in is also what starts the day's strategies. On 17
 * Nov the desk showed no prompt, nobody signed in, and the day took no trades.
 * This puts the link on the phone fifteen minutes before the open whether or
 * not the desk is being looked at.
 *
 * The link is DESK_URL from app/.env.local (e.g. https://mo1-dashboard.tech)
 * plus /api/kite/login. There is no exchange-holiday calendar on the desk, so
 * it also arrives on a weekday holiday.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const REMINDER_HOUR_IST = 9;
export const REMINDER_MINUTE_IST = 0;

/**
 * Milliseconds until the next 09:00 IST on a weekday. Strictly after `now`, so a
 * process that boots at exactly 09:00:00.000 waits for the next one rather than
 * firing twice.
 */
export function msUntilNextReminder(now = Date.now()): number {
  const ist = new Date(now + IST_OFFSET_MS);
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const at =
      Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + ahead, REMINDER_HOUR_IST, REMINDER_MINUTE_IST) -
      IST_OFFSET_MS;
    const weekday = new Date(at + IST_OFFSET_MS).getUTCDay();
    if (at > now && weekday >= 1 && weekday <= 5) return at - now;
  }
  return DAY_MS; // unreachable: a weekday always falls within the week
}

export function loginUrl(): string | null {
  const base = process.env.DESK_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}/api/kite/login` : null;
}

/** The message, given whether a session is already good for today. */
export function reminderText(signedIn: boolean, url: string | null): string {
  const link = url ?? "(add DESK_URL to app/.env.local to get the link here)";
  return signedIn
    ? `Good morning. Kite is already connected for today - nothing to do.\nTo sign in again: ${link}`
    : `Good morning. Kite is NOT connected - nothing trades until you sign in.\nConnect Kite: ${link}\nThe day's strategies start as soon as you do.`;
}

const globalRef = globalThis as typeof globalThis & { __loginReminderTimer?: NodeJS.Timeout | null };

/** Arms the reminder, and re-arms it from inside each fire. Safe to call again. */
export function startLoginReminder(): void {
  if (globalRef.__loginReminderTimer) clearTimeout(globalRef.__loginReminderTimer);

  const arm = () => {
    const timer = setTimeout(() => {
      void (async () => {
        const signedIn = (await readSession()) != null;
        const result = await sendTelegram(reminderText(signedIn, loginUrl()));
        console.log(
          `[login] 09:00 reminder sent - ${signedIn ? "already signed in" : "not signed in"}` +
            (result.ok ? "" : ` (telegram failed: ${result.reason})`)
        );
      })()
        .catch((err: unknown) => console.warn("[login] reminder failed:", err instanceof Error ? err.message : err))
        .finally(arm);
    }, msUntilNextReminder());
    timer.unref();
    globalRef.__loginReminderTimer = timer;
  };

  arm();
}
