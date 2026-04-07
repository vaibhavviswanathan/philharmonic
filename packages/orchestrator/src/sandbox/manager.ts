import { getSandbox, type Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { DispatchPayload, Sandbox } from "@phil/shared";
import type { Env } from "../env.js";
import { ensureSandboxReady } from "./agent.js";

export class SandboxManager {
  constructor(private env: Env) {}

  /**
   * Create a sandbox and write the startup script.
   * The startup script is fully self-contained — it handles cloning,
   * git config, CLAUDE.md, onboarding skip, and launching Claude Code.
   * This makes it resilient to container recycling.
   */
  async create(payload: DispatchPayload): Promise<{ sandbox: SandboxInstance; meta: Sandbox }> {
    const sandboxId = `task-${payload.taskId}`.toLowerCase();
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      keepAlive: true,
    });

    // Explicitly set keepAlive to ensure container persists
    await sandbox.setKeepAlive(true);

    // Write the self-contained startup script
    await ensureSandboxReady(sandbox, payload, this.env);

    const meta: Sandbox = {
      id: sandboxId,
      taskId: payload.taskId,
      containerId: sandboxId,
      state: "active",
      repoPath: "/workspace",
      branchName: payload.branchName,
      createdAt: new Date().toISOString(),
    };

    return { sandbox, meta };
  }

  async destroy(taskId: string): Promise<void> {
    const sandboxId = `task-${taskId}`.toLowerCase();
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);
    await sandbox.destroy();
  }
}
