import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelQueries, ChannelReference } from "../relay/contracts";

const unknown: ChannelReference = Object.freeze({ state: "unknown" });
const noop = () => () => {};

/**
 * What a link can show about a channel the reader may not have joined. The
 * store owns the lookup, its batching, expiry and retry; this hook only
 * demands one while the answer isn't `found` and the list is ready, because
 * discovery owns access.
 */
export function useChannelReference(
  queries: ChannelQueries | undefined,
  channelId: string | undefined,
): ChannelReference {
  const active = channelId && queries?.describe ? queries : undefined;
  // The list is replaced on every message preview; re-render only when this
  // reference's answer changes.
  const key = useSyncExternalStore(
    active?.subscribeList ?? noop,
    () =>
      active && channelId
        ? `${active.list().status === "ready" ? "ready" : ""}:${JSON.stringify(active.describe?.(channelId))}`
        : "",
    () => "",
  );
  const ready = key.startsWith("ready:");
  const reference = useMemo<ChannelReference>(
    () => (key ? JSON.parse(key.slice(key.indexOf(":") + 1)) : unknown),
    [key],
  );
  // Mounted links hold the demand, so the store rechecks them when an answer
  // expires or a failure's backoff ends. Moving between answers that aren't
  // `found` keeps the same demand.
  const found = reference.state === "found";
  useEffect(() => {
    if (active && channelId && ready && !found)
      return active.refer?.(channelId);
  }, [active, channelId, ready, found]);
  return reference;
}

/** A found channel that a link presents as a channel. DMs and Solo chats keep
 * their own presentation. */
export function namedChannel(reference: ChannelReference) {
  return reference.state === "found" &&
    !reference.hidden &&
    reference.channelType !== "dm" &&
    reference.channelType !== "solo"
    ? reference
    : undefined;
}
