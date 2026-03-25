import { getSandbox, type Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { DispatchPayload, Sandbox } from "@phil/shared";
import type { Env } from "../env.js";

export class SandboxManager {
  constructor(private env: Env) {}

  async create(payload: DispatchPayload): Promise<{ sandbox: SandboxInstance; meta: Sandbox }> {
    const sandboxId = `task-${payload.taskId}`;
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      keepAlive: true, // Agent process is long-running; we destroy explicitly
    });

    // Clone the repo inside the sandbox
    await sandbox.exec(`git clone ${payload.repoContext.repoUrl} /workspace`, {
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GITHUB_TOKEN: this.env.GITHUB_TOKEN,
        GIT_ASKPASS: "echo",
      },
    });

    // Configure git
    await sandbox.exec('git config user.name "Phil Agent"', { cwd: "/workspace" });
    await sandbox.exec('git config user.email "phil@agent.local"', { cwd: "/workspace" });

    // Write dispatch payload
    await sandbox.writeFile(
      "/workspace/.phil-dispatch.json",
      JSON.stringify(payload, null, 2),
    );

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

  async runAgent(
    sandbox: SandboxInstance,
    payload: DispatchPayload,
    onLog: (message: string) => Promise<void>,
  ): Promise<void> {
    // Start the agent as a background process
    const process = await sandbox.startProcess(
      "node /app/packages/sandbox-runtime/dist/lifecycle.js",
      {
        processId: `agent-${payload.taskId}`,
        cwd: "/workspace",
        env: {
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
          GITHUB_TOKEN: this.env.GITHUB_TOKEN,
          PHIL_TASK_ID: payload.taskId,
          PHIL_SANDBOX_ID: `task-${payload.taskId}`,
          PHIL_CALLBACK_URL: this.env.WORKER_URL ?? "",
        },
      },
    );

    await onLog("Agent process started in sandbox");

    // Wait for the agent to complete
    await process.waitForExit();

    // Collect logs
    const logs = await sandbox.getProcessLogs(`agent-${payload.taskId}`);
    if (logs) {
      await onLog(`Agent finished. Last output: ${String(logs).slice(-500)}`);
    }
  }

  async destroy(taskId: string): Promise<void> {
    const sandboxId = `task-${taskId}`;
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);
    await sandbox.destroy();
  }

  /**
   * For the planner: create a temporary sandbox to clone and analyze a repo
   */
  async analyzeRepo(
    repoUrl: string,
    taskId: string,
  ): Promise<{ structure: string[]; projectType: string; defaultBranch: string }> {
    const sandboxId = `task-${taskId}`;
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      keepAlive: true,
    });

    // Clone repo
    await sandbox.exec(`git clone --depth 1 ${repoUrl} /workspace`, {
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GITHUB_TOKEN: this.env.GITHUB_TOKEN,
      },
    });

    // Get default branch
    let defaultBranch = "main";
    const branchResult = await sandbox.exec(
      'git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null || echo "origin/main"',
      { cwd: "/workspace" },
    );
    if (branchResult.success) {
      defaultBranch = branchResult.stdout.trim().replace("origin/", "");
    }

    // List structure (depth 3)
    const structResult = await sandbox.exec(
      'find . -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" | sort',
      { cwd: "/workspace" },
    );
    const structure = structResult.success
      ? structResult.stdout.trim().split("\n").filter(Boolean)
      : [];

    // Detect project type
    const detectResult = await sandbox.exec(
      'ls package.json pyproject.toml requirements.txt Cargo.toml go.mod pom.xml build.gradle 2>/dev/null || true',
      { cwd: "/workspace" },
    );
    let projectType = "unknown";
    const files = detectResult.stdout.trim();
    if (files.includes("package.json")) projectType = "node";
    else if (files.includes("pyproject.toml") || files.includes("requirements.txt")) projectType = "python";
    else if (files.includes("Cargo.toml")) projectType = "rust";
    else if (files.includes("go.mod")) projectType = "go";
    else if (files.includes("pom.xml") || files.includes("build.gradle")) projectType = "java";

    return { structure, projectType, defaultBranch };
  }
}
