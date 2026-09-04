/**
 * §4.12 realtime: `postgres_changes` on `vehicles`, filtered `user_id=eq.<uid>`.
 *
 * "The event is only a signal to pull; it is never applied directly (one apply path)."
 * That sentence is the entire contract of this file, and it is why the callback here takes
 * no payload argument: there is nothing a caller could apply even if it wanted to. The
 * payload is dropped where it arrives.
 *
 * A silent channel costs latency and nothing else. The migration says so too — adding
 * `vehicles` to the `supabase_realtime` publication is allowed to fail on a project whose
 * publication this app does not own — and §4.12's other five triggers (app start, online,
 * visible, after every push, every 5 min) still deliver everything.
 */
import type { ChannelHandle, SyncClient } from "./types";

/**
 * Subscribe for one user and return the teardown.
 *
 * The channel name carries the user id so that a sign-in as someone else cannot land on the
 * channel the previous account was listening to; the engine removes the old one first
 * anyway, and this makes the two impossible to confuse if it ever does not.
 */
export function subscribeVehicleChanges(
  client: SyncClient,
  userId: string,
  onSignal: () => void,
  onStatus?: (status: string) => void,
): () => void {
  const channel: ChannelHandle = client.channel(`vin-relay:vehicles:${userId}`);

  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "vehicles",
      // Realtime applies this server-side against the row's replica identity — the primary
      // key (user_id, vin) — so another account's row is never sent to this client. RLS is
      // still the wall; this is the filter that keeps the socket quiet.
      filter: `user_id=eq.${userId}`,
    },
    () => {
      onSignal();
    },
  );

  channel.subscribe((status) => {
    onStatus?.(status);
  });

  return () => {
    client.removeChannel(channel);
  };
}
