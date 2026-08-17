// test/hosts/opencode-plugin.test.ts — the opencode plugin's tick delivery:
// session-id tracking from events + injection via client.session.promptAsync.
// Hermetic (mocked client); the REAL delivery is verified by an oc run with a
// fast sweep interval (see the env-flag e2e pattern).
import { describe, test, expect } from "bun:test";
import { createTickDelivery, type PromptClient } from "../../src/hosts/opencode-plugin.ts";

function mockClient(): { client: PromptClient; calls: Array<{ path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }>; failNext: boolean } {
  const calls: Array<{ path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }> = [];
  const state = { failNext: false };
  const client: PromptClient = {
    session: {
      async promptAsync(opts) {
        if (state.failNext) throw new Error("inject boom");
        calls.push(opts);
        return { ok: true };
      },
    },
  };
  return { client, calls, state };
}

describe("opencode tick delivery (hermetic)", () => {
  test("no session target yet → console fallback, no inject", () => {
    const { client, calls } = mockClient();
    const logs: string[] = [];
    const d = createTickDelivery(client, (l) => logs.push(l));
    d.deliver("dispatch: 1 ready");
    expect(calls.length).toBe(0);
    expect(logs).toEqual(["[orch-tick] dispatch: 1 ready"]);
  });

  test("session target set (from an event) → injects via promptAsync with the tick text", () => {
    const { client, calls } = mockClient();
    const d = createTickDelivery(client);
    d.setTarget("ses_orchestrator123");
    d.deliver("intake: approved buffer low");
    expect(calls.length).toBe(1);
    expect(calls[0].path.id).toBe("ses_orchestrator123");
    expect(calls[0].body.parts[0]).toEqual({ type: "text", text: "[orch-tick] intake: approved buffer low" });
  });

  test("setTarget ignores empty/undefined session ids", () => {
    const { client, calls } = mockClient();
    const d = createTickDelivery(client);
    d.setTarget(undefined);
    d.setTarget("");
    d.deliver("nudge");
    expect(calls.length).toBe(0);
  });

  test("inject failure → console fallback, never throws", () => {
    const { client, calls, state } = mockClient();
    state.failNext = true;
    const logs: string[] = [];
    const d = createTickDelivery(client, (l) => logs.push(l));
    d.setTarget("ses_x");
    d.deliver("nudge");
    // async — wait a tick for the rejection to land
    return new Promise((r) => setTimeout(r, 10)).then(() => {
      expect(logs.some((l) => l.includes("inject failed: inject boom"))).toBe(true);
    });
  });
});
