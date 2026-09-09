// opencode-entry.ts — the opencode PLUGIN ENTRY for npm distribution.
// opencode's `plugin` config resolves the package and uses its DEFAULT export
// as the plugin; the implementation lives in opencode-plugin.ts (named export
// OrchestratorAutopilot). This entry exists purely to give opencode the shape
// it expects — no pi-adjacent code is reachable from here.
//
// Install: `opencode.jsonc` → "plugin": ["orchestrator-autopilot"]
// Requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1 for detached runs.
// Prerequisite: the pi-subagents-style backend runtime this plugin spawns
// workers through (see README).

import { OrchestratorAutopilot } from "./opencode-plugin.ts";

export default OrchestratorAutopilot;
