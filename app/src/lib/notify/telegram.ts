/**
 * Outbound Telegram messages — the desk's alert channel.
 *
 * Credentials live in app/.env.local beside the Kite keys: the bot token from
 * @BotFather and the numeric chat ID of the one person allowed to receive. Read
 * lazily, like the Kite config, so a missing key is a handled "not configured"
 * result rather than an import-time crash.
 *
 * Plain text on purpose. Telegram's Markdown modes reject the whole message
 * when a tradingsymbol or a price carries an unescaped `_`, `*` or `.`, and an
 * alert that fails to send because of its own punctuation is worse than a plain
 * one.
 *
 * Never throws. Sending an alert is always a side job of something more
 * important, and a Telegram outage must not take an order path down with it —
 * the caller gets a result it can log instead.
 */

const API_ROOT = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;
/** Telegram's cap on a single message. */
const MAX_LENGTH = 4096;

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export type SendResult =
  | { ok: true; messageId: number }
  | { ok: false; kind: "not-configured" | "rejected" | "unreachable"; reason: string };

interface TelegramReply {
  ok: boolean;
  description?: string;
  result?: { message_id?: number };
}

export function readTelegramConfig(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

export async function sendTelegram(text: string): Promise<SendResult> {
  const config = readTelegramConfig();
  if (!config) {
    return {
      ok: false,
      kind: "not-configured",
      reason: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing. Add both to app/.env.local as KEY=value.",
    };
  }

  try {
    const res = await fetch(`${API_ROOT}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: text.slice(0, MAX_LENGTH),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    const body = (await res.json().catch(() => null)) as TelegramReply | null;
    if (!res.ok || !body?.ok) {
      // Telegram's own wording is the useful part: "Unauthorized" is a bad
      // token, "Bad Request: chat not found" a wrong chat ID or a bot that was
      // never sent /start.
      return {
        ok: false,
        kind: "rejected",
        reason: `Telegram ${res.status}: ${body?.description ?? res.statusText}`,
      };
    }
    return { ok: true, messageId: body.result?.message_id ?? 0 };
  } catch (err) {
    /*
     * The token is part of the URL, and a failed fetch can quote the URL it was
     * trying. Scrubbed so a network error never writes the token into a log
     * line or an API response.
     */
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "unreachable", reason: detail.split(config.token).join("<token>") };
  }
}
