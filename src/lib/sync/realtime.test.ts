/**
 * §4.12's realtime subscription, pinned at the shape the server reads: `postgres_changes`
 * on `public.vehicles`, filtered `user_id=eq.<uid>`. Get the filter wrong and the socket
 * either says nothing (sync degrades to the five-minute poll, silently) or says everything
 * (a phone woken by rows RLS would not even hand it).
 *
 * And the rule that outranks all of it: "the event is only a signal to pull; it is never
 * applied directly (one apply path)."
 */
import { describe, expect, it, vi } from "vitest";

import { subscribeVehicleChanges } from "./realtime";
import type { ChannelHandle, PostgresChangesFilter, SyncClient } from "./types";

const USER = "11111111-1111-4111-8111-111111111111";

function recordingClient() {
  const seen: {
    names: string[];
    filters: PostgresChangesFilter[];
    statuses: string[];
    removed: ChannelHandle[];
    fire: (payload: unknown) => void;
  } = { names: [], filters: [], statuses: [], removed: [], fire: () => {} };

  const client: SyncClient = {
    from: () => {
      throw new Error("not used");
    },
    rpc: () => {
      throw new Error("not used");
    },
    channel: (name: string) => {
      seen.names.push(name);
      const handle: ChannelHandle = {
        on: (_type, filter, callback) => {
          seen.filters.push(filter);
          seen.fire = callback;
          return handle;
        },
        subscribe: (callback) => {
          callback?.("SUBSCRIBED");
          return handle;
        },
      };
      return handle;
    },
    removeChannel: (channel) => seen.removed.push(channel),
  };

  return { client, seen };
}

describe("subscribeVehicleChanges", () => {
  it("listens to this user's vehicles rows and nothing else", () => {
    const { client, seen } = recordingClient();

    subscribeVehicleChanges(client, USER, () => {});

    expect(seen.names).toEqual([`vin-relay:vehicles:${USER}`]);
    expect(seen.filters).toEqual([
      { event: "*", schema: "public", table: "vehicles", filter: `user_id=eq.${USER}` },
    ]);
  });

  it("signals without handing the payload on (one apply path)", () => {
    const { client, seen } = recordingClient();
    const onSignal = vi.fn();

    subscribeVehicleChanges(client, USER, onSignal);
    seen.fire({ eventType: "UPDATE", new: { vin: "1HGCM82633A004352", unit: "TRK-9" } });

    expect(onSignal).toHaveBeenCalledTimes(1);
    // Nothing from the wire reaches the caller, so there is nothing it could apply.
    expect(onSignal).toHaveBeenCalledWith();
  });

  it("reports the subscription status for a caller that wants it", () => {
    const { client } = recordingClient();
    const statuses: string[] = [];

    subscribeVehicleChanges(
      client,
      USER,
      () => {},
      (status) => statuses.push(status),
    );

    expect(statuses).toEqual(["SUBSCRIBED"]);
  });

  it("hands back a teardown that removes the channel", () => {
    const { client, seen } = recordingClient();

    subscribeVehicleChanges(client, USER, () => {})();

    expect(seen.removed).toHaveLength(1);
  });
});
