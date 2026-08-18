// backends/index.ts — the subagent-backend factory. The queue tools and the
// hosts depend on the SubagentBackend interface (backends/types.ts); each
// host DEDUCES its backend from the runtime it runs in (pi extension → pi,
// opencode plugin → opencode) — the portability seam of the framework.

import type { SubagentBackend, PiLike, OpenCodeBackendOptions } from "./types.ts";
import { createPiBackend } from "./pi.ts";
import { createOpenCodeBackend } from "./opencode.ts";

export type { SubagentBackend, PiLike, OpenCodeBackendOptions, OpenCodeRunRecord } from "./types.ts";
export { createPiBackend } from "./pi.ts";
export { createOpenCodeBackend, defaultRunsDir } from "./opencode.ts";

export type BackendSelection =
  | { kind: "pi"; pi: PiLike }
  | { kind: "opencode"; opencode: OpenCodeBackendOptions };

/** The portability seam: create the backend the framework should spawn runs on. */
export function createSubagentBackend(sel: BackendSelection): SubagentBackend {
  if (sel.kind === "opencode") return createOpenCodeBackend(sel.opencode);
  return createPiBackend(sel.pi);
}
