// Buzz messages in a turn's prompt as exact JSON records, the same for every
// runtime. A protection plugin re-encodes them exactly, which is how it finds
// each message to check, and remember, on its own.
import type { EventData } from "../relay/events";

/** JSON with `<` and `>` escaped, so no text in it opens or closes a section. */
export const quoted = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

/** The event a turn is for, then what it asks of the agent. */
export const eventBody = (event: EventData, request: string) =>
  `${quoted(event)}\nRequest: ${quoted(request)}`;

/** Who sent the event in an `eventBody`, and its request; undefined for any
 * other text. */
export function readEventBody(body: string) {
  const match = /^(\{.*\})\nRequest: (".*")$/.exec(body);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const event: unknown = JSON.parse(match[1]);
    const request: unknown = JSON.parse(match[2]);
    const pubkey = (event as { pubkey?: unknown } | null)?.pubkey;
    return typeof pubkey === "string" && typeof request === "string"
      ? { pubkey, request }
      : undefined;
  } catch {
    return undefined;
  }
}
