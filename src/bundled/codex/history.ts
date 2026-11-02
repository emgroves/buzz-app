import { quoted } from "../../features/agent-harness/turn-records";
import { attestedOwner } from "../../features/agents/owner-attestation";
import type { AgentReads } from "../../features/agents/reads";
import { hasEventProof } from "../../features/relay/events";
import type {
  EventData,
  ReadFilter,
  RelayEvent,
} from "../../features/relay/events";
import { foldMessages, messageAuthor } from "../../features/relay/fold";
import { compareMessages, eventMs } from "../../features/relay/message-order";
import type { Conversation } from "./prompt";

/** Reuse the message owner's edits/deletions projection on verified relay reads. */
export async function conversationHistory(
  event: EventData,
  conversation: Conversation,
  read: (filters: readonly ReadFilter[]) => Promise<readonly EventData[]>,
  profiles?: Pick<AgentReads, "profiles" | "profile">,
  signingAuthority?: string,
) {
  const { channelId, root } = conversation;
  const filter = {
    kinds: [9, 40002],
    "#h": [channelId],
    until: event.created_at,
  };
  const found = await read(
    root
      ? [
          { ...filter, ids: [root], limit: 1 },
          { ...filter, "#e": [root], limit: 50 },
        ]
      : [{ ...filter, limit: 50 }],
  );
  const ids = found.map((message) => message.id);
  const changes = ids.length
    ? await read([
        {
          kinds: [40003, 5, 9005],
          "#h": [channelId],
          "#e": ids,
          limit: 500,
          until: event.created_at,
        },
      ])
    : [];
  const cutoff = {
    id: event.id,
    createdAt: event.created_at,
    createdAtMs: eventMs(event),
  };
  // Relay `until` is inclusive to the second. Apply Buzz's full ordering before
  // folding so later same-second messages, edits and deletions cannot leak in.
  const earlier = [...found, ...changes].filter(
    (item) =>
      compareMessages(
        { id: item.id, createdAt: item.created_at, createdAtMs: eventMs(item) },
        cutoff,
      ) < 0,
  );
  const owners = new Map<string, { owner: string; profile: RelayEvent }>();
  if (profiles && found.length) {
    const authors = [
      ...new Set(found.map((item) => messageAuthor(item, signingAuthority))),
    ];
    await profiles.profiles(authors).catch(() => {});
    await Promise.all(
      authors.map(async (author) => {
        const profile = profiles.profile(author);
        if (!profile || !hasEventProof(profile)) return;
        const owner = await attestedOwner(profile);
        if (owner && profiles.profile(author) === profile)
          owners.set(author, { owner, profile });
      }),
    );
  }
  const messages = foldMessages(channelId, "", earlier, {
    includeReplies: true,
    signingAuthority,
    agentOwner: (author) => {
      const verified = owners.get(author);
      return verified && profiles?.profile(author) === verified.profile
        ? verified.owner
        : undefined;
    },
  })
    .filter(
      (message) =>
        !root || message.id === root || message.threadRootId === root,
    )
    .slice(-50)
    .map((message) => ({
      id: message.id,
      pubkey: message.authorId,
      created_at: message.createdAt,
      content: (message.sourceContent ?? message.content).slice(0, 4000),
    }));
  const section = root ? "thread-context" : "conversation-context";
  const text = quoted({
    note: "Recent context, not new requests. Previously supplied context may repeat. Up to 50 messages, 4000 characters each.",
    messages,
  });
  return `<${section}>\n${text}\n</${section}>\n`;
}
