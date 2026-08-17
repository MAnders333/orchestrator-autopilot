// orchestrator-autopilot.ts — the opencode PLUGIN (thin adapter). The framework
// logic lives in lib/orchestrator-autopilot (src/hosts/opencode.ts — the
// host-agnostic framework, shared queue ops, completion wiring, reviewer
// projection); THIS file maps it to the opencode plugin API:
//
//   tool: { name: tool({ description, args, execute }) }
//
// Registered in the global opencode.jsonc `plugin` array (active in both
// work + personal modes; the state dir resolves per mode).
//
// The agent sees the six queue tools alongside opencode's builtins and can
// drive the orchestrator queue directly. Completion of spawned runs (workers /
// reviewers) is wired via the backend's onComplete → queue flips + verdict
// routing; ticks route to the orchestrator session when the plugin can resolve
// it (best-effort — see fw.onTick below).

import { tool, type Plugin } from "@opencode-ai/plugin";
import { join } from "node:path";
import { homedir } from "node:os";
import { createOpenCodeFramework, type ArgSpec } from "./opencode.ts";

function resolveStateDir(): string {
  if (process.env.AUTOPILOT_STATE_DIR) return process.env.AUTOPILOT_STATE_DIR;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  return agentDir.includes("personal")
    ? join(homedir(), ".local/state/orchestrator-personal")
    : join(homedir(), ".local/state/orchestrator");
}

/** Map ArgSpec[] → opencode tool.schema args object. */
function argsSchema(specs: ArgSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of specs) {
    let v: unknown = s.type === "number" ? tool.schema.number() : s.type === "boolean" ? tool.schema.boolean() : tool.schema.string();
    if (s.description) v = (v as { describe?: (d: string) => unknown }).describe?.(s.description) ?? v;
    out[s.name] = s.required ? v : (v as { optional?: () => unknown }).optional?.() ?? v;
  }
  return out;
}

export const OrchestratorAutopilot: Plugin = async (ctx) => {
  const fw = createOpenCodeFramework({
    stateDir: resolveStateDir(),
    // The plugin cannot inject messages into the orchestrator session yet
    // (opencode gap — the tick mechanism is a follow-up); log ticks instead.
    onTick: (message) => console.log(`[orch-tick] ${message}`),
  });

  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const [name, def] of Object.entries(fw.tools)) {
    tools[name] = tool({
      description: def.description,
      args: argsSchema(def.args),
      execute: async (args) => (await def.execute(args as Record<string, unknown>)).text,
    });
  }

  return { tool: tools };
};
