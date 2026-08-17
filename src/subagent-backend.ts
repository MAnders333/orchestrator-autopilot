// subagent-backend.ts — stable import path for the extension. The seam
// contract + backend implementations live in src/backends/ (types.ts, pi.ts,
// opencode.ts, index.ts factory). Kept as a re-export so the extension's
// require path does not churn with the backend structure.

export { createSubagentBackend, createPiBackend, createOpenCodeBackend, defaultRunsDir } from "./backends/index.ts";
export type { SubagentBackend, PiLike, OpenCodeBackendOptions, OpenCodeRunRecord } from "./backends/index.ts";
