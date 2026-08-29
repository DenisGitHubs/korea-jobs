// collector/src/handles.ts
//
// Reading @usernames off GramJS entities. Pure and dependency-free (so the backend's vitest can
// exercise it), because two different product rules hang off these strings:
//
//   * the CHAT handle fills `username` in the ingest payload, which is how the backend resolves a
//     source that was added by name before its numeric id was known;
//   * the SENDER handle fills `sender_username`, which is the FALLBACK CONTACT of a published card
//     (owner rule 2026-07-19, lib/korea/parser/run.ts): when the AI finds no contact in the text —
//     and in most postings there is none — the card shows the author's @handle instead of a bare
//     "открыть в канале".
//
// ⚠️ THE SENDER RULE IS NARROWER THAN "any username on the entity", on purpose. In a broadcast
// channel the "sender" IS the channel, so a naive read would put the channel's own handle into
// every contact-less card and call it the author's contact. That is not a person, cannot be DMed,
// and would quietly replace an honest "открыть в канале" with a misleading contact on a large
// share of cards. So senderHandle returns a handle ONLY for a User entity.
//
// The bot check is deliberately NOT duplicated here: the backend owns it in ONE place
// (lib/korea/parser/canonical.ts isLiveUserHandle) and both the canonical choice and the contact
// fallback import it from there. A second copy on this side would be a second thing to keep in
// step, and they would drift.

/** One entity's public @username in its ORIGINAL case, or null. */
export function entityUsername(entity: unknown): string | null {
  if (!entity || typeof entity !== 'object') return null;

  const direct = (entity as { username?: string | null }).username;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  // Collectible/multiple usernames (Telegram, 2022+): `username` can be empty while the account is
  // reachable through an entry in `usernames`. Only an ACTIVE one is a working address.
  const list = (entity as { usernames?: unknown }).usernames;
  if (Array.isArray(list)) {
    for (const u of list) {
      if (!u || typeof u !== 'object') continue;
      const name = (u as { username?: unknown }).username;
      const active = (u as { active?: unknown }).active;
      if (typeof name === 'string' && name.length > 0 && active !== false) return name;
    }
  }
  return null;
}

/**
 * The @handle of the message AUTHOR — but only when the author is a real user account.
 * `null` for a channel, a group, an anonymous admin, or a sender we have no entity for.
 */
export function senderHandle(sender: unknown): string | null {
  if (!sender || typeof sender !== 'object') return null;
  if ((sender as { className?: unknown }).className !== 'User') return null;
  return entityUsername(sender);
}
