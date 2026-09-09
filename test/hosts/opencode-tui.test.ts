// opencode TUI plugin — hermetic tests with a fake api. Verifies: the module
// registers the route + keymap layer, the state-dir resolution reuses the
// framework's command-file parsing (config → command/orchestrate.md → STATE_DIR),
// and every command action lands in the queue store via the shared
// applyPanelDecision (including the gate, the view toggle, and the
// dialog-driven refine/redispatch flows).

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newStore, saveStore, type QueueItem } from "../../src/queue-store.ts";
import { createPanelController, tui, tuiStateDir } from "../../src/hosts/opencode-tui.ts";

function item(p: Partial<QueueItem> & { key: string; status: QueueItem["status"] }): QueueItem {
  return {
    blocker: null,
    title: p.key,
    scope: "",
    cwd: null,
    evidence: "",
    value: "",
    urgency: "",
    risk: "low",
    runId: null,
    reviewerRunId: null,
    timeoutMs: null,
    attempts: 0,
    notes: "",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...p,
  };
}

interface FakeApi {
  routes: any[];
  layers: any[];
  toasts: any[];
  navs: any[];
  dialogs: any[];
  configDir: string;
  api: any;
}

function makeFake(configDir: string): FakeApi {
  const f: FakeApi = { routes: [], layers: [], toasts: [], navs: [], dialogs: [], configDir, api: null as any };
  f.api = {
    route: {
      register: (rs: any[]) => f.routes.push(...rs),
      navigate: (name: string, p?: any) => f.navs.push({ name, p }),
    },
    keymap: { registerLayer: (l: any) => f.layers.push(l) },
    mode: { push: () => () => {} },
    state: { path: { config: configDir } },
    ui: {
      toast: (t: any) => f.toasts.push(t),
      dialog: { replace: (render: () => any) => f.dialogs.push({ render }) },
      DialogPrompt: (props: any) => ({ kind: "prompt", props }),
    },
  };
  return f;
}

function seedState(dir: string, items: QueueItem[]): void {
  const store = newStore();
  for (const i of items) store.items[i.key] = i;
  saveStore(dir, store);
}

function readState(dir: string): Record<string, QueueItem> {
  return JSON.parse(readFileSync(join(dir, "queue.json"), "utf8")).items;
}

const command = (stateDir: string) =>
  ["# /orchestrate\n\n## Workspace\n", "- `STATE_DIR`: `" + stateDir + "`\n"].join("\n");

let tmp: string;
let stateDir: string;
let configDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "orch-oc-tui-"));
  stateDir = join(tmp, "state");
  mkdirSync(stateDir, { recursive: true });
  configDir = join(tmp, "config");
  const cmdDir = join(configDir, "command");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, "orchestrate.md"), command(stateDir));
});

describe("opencode TUI plugin registration + state-dir resolution", () => {
  test("registers the route, the palette-open command, and the keymap layer", async () => {
    const f = makeFake(configDir);
    await tui(f.api, {}, {});
    const route = f.routes.find((r) => r.name === "orchestrator-panel");
    expect(route).toBeTruthy();
    expect(typeof route.render).toBe("function");
    const layer = f.layers[0];
    expect(layer.mode).toBe("orch-panel");
    const names = layer.commands.map((c: any) => c.name);
    expect(names).toContain("orch.panel"); // palette/slash opener
    expect(names).toContain("orch.approve");
    expect(names).toContain("orch.refine");
    const has = (k: string) => layer.bindings.some((b: any) => b.key === k);
    expect(has("a")); expect(has("r")); expect(has("d")); expect(has("e")); expect(has("x"));
    expect(has("escape")); expect(has("tab"));
  });

  test("route render produces actual TUI output for a seeded feed (testRender smoke)", async () => {
    const { testRender } = await import("@opentui/solid");
    seedState(stateDir, [item({ key: "P1", status: "proposal", scope: "Rewrite the parser", cwd: "/tmp/repo" })]);
    const f = makeFake(configDir);
    await tui(f.api, {}, {});
    const route = f.routes.find((r) => r.name === "orchestrator-panel");
    const setup = await testRender(() => route.render({ params: {} }), { width: 60, height: 24 });
    await setup.renderOnce();
    await setup.flush();
    const text = [setup.externalOutput.takeText(), setup.captureCharFrame()].join("\n");
    expect(text).toContain("P1");
    expect(text).toContain("Rewrite the parser");
  });

  test("resolves the state dir from the opencode config's orchestrate command (config-carried)", () => {
    // same resolution the server plugin uses — env override → command STATE_DIR
    expect(tuiStateDir(configDir)).toBe(stateDir);
    expect(existsSync(join(stateDir, "queue.json"))).toBe(false); // read-only until a decision
  });
});

describe("opencode TUI controller + commands", () => {
  test("approve lands proposal → approved; the approval gate is enforced", async () => {
    seedState(stateDir, [
      item({ key: "P1", status: "proposal", scope: "task", cwd: "/tmp/repo" }),
      item({ key: "P2", status: "proposal", title: "no spec" }),
    ]);
    const ctl = createPanelController(stateDir);
    await tui(makeFake(configDir).api, {}, {});
    let r = ctl.act("approve"); // sel 0 = P1 (first)
    expect(r?.ok).toBe(true);
    expect(readState(stateDir)["P1"].status).toBe("approved");
    // P2 now selected (re-rendered feed) — approving must refuse (gate)
    r = ctl.act("approve");
    expect(r?.ok).toBe(false);
    expect(readState(stateDir)["P2"].status).toBe("proposal");
  });

  test("command run()s drive the same actions (keymap layer wiring)", async () => {
    seedState(stateDir, [item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" })]);
    const f = makeFake(configDir);
    await tui(f.api, {}, {});
    const layer = f.layers[0];
    const run = (name: string) => layer.commands.find((c: any) => c.name === name).run();
    run("orch.toggle"); // → human-review
    run("orch.approve");
    expect(readState(stateDir)["H1"].status).toBe("done");
    expect(f.toasts.some((t) => t.message.includes("H1"))).toBe(true);
  });

  test("refine dialog prefills scope and applies the rewritten scope", async () => {
    seedState(stateDir, [item({ key: "P1", status: "proposal", scope: "old scope", cwd: "/tmp" })]);
    const f = makeFake(configDir);
    await tui(f.api, {}, {});
    const layer = f.layers[0];
    layer.commands.find((c: any) => c.name === "orch.refine").run();
    expect(f.dialogs.length).toBe(1);
    const el = f.dialogs[0].render();
    expect(el.props.title).toContain("P1");
    expect(el.props.value).toBe("old scope"); // prefilled full scope
    el.props.onConfirm("rewritten scope\nmore");
    expect(readState(stateDir)["P1"].scope).toBe("rewritten scope\nmore");
    // now the gate passes: approve works
    layer.commands.find((c: any) => c.name === "orch.approve").run();
    expect(readState(stateDir)["P1"].status).toBe("approved");
  });

  test("redispatch dialog records findings without transitioning (harness re-dispatches)", async () => {
    seedState(stateDir, [item({ key: "H1", status: "human-review", scope: "work", cwd: "/tmp/repo" })]);
    const f = makeFake(configDir);
    const ctl = createPanelController(stateDir);
    ctl.kind = "human-review";
    await tui(f.api, {}, {});
    const layer = f.layers[0];
    layer.commands.find((c: any) => c.name === "orch.toggle").run(); // ensure HR view regardless of ctl init
    layer.commands.find((c: any) => c.name === "orch.redispatch").run();
    expect(f.dialogs.length).toBe(1);
    f.dialogs[0].render().props.onConfirm("the merge is missing on main");
    expect(readState(stateDir)["H1"].status).toBe("human-review");
    expect(readState(stateDir)["H1"].notes).toContain("the merge is missing on main");
  });

  test("close navigates home; toggle changes the controller view", async () => {
    const f = makeFake(configDir);
    await tui(f.api, {}, {});
    const layer = f.layers[0];
    layer.commands.find((c: any) => c.name === "orch.close").run();
    expect(f.navs[f.navs.length - 1].name).toBe("home");
    const ctl = createPanelController(stateDir);
    expect(ctl.kind).toBe("proposals");
    ctl.toggleView();
    expect(ctl.kind).toBe("human-review");
  });
});