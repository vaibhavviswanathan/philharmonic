import Anthropic from "@anthropic-ai/sdk";
import type { Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { ManagerPhase, ManagerState, ReviewComment } from "@phil/shared";
import type { Env } from "../env.js";
import { buildManagerSystemPrompt } from "./prompts.js";
import {
  loadManagerState,
  saveManagerState,
  loadConversation,
  saveConversation,
  defaultManagerState,
} from "./state.js";

type MessageParam = Anthropic.MessageParam;
type Tool = Anthropic.Tool;

const TMUX_SOCK = "/workspace/.tmux.sock";
const MAX_STEPS = 20;

/** Tools the manager can use via Claude API */
const MANAGER_TOOLS: Tool[] = [
  {
    name: "send_terminal_command",
    description:
      "Send a command or message to Claude Code running in the terminal. The text will be typed into the tmux session. Use for short instructions. For long instructions, use write_instruction_file first, then send a short command referencing the file.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The text to send to the terminal (will have Enter appended)",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "write_instruction_file",
    description:
      "Write detailed instructions to /workspace/.phil-instruction.md. Use this for long, complex instructions that would be unwieldy as terminal input. After writing, send a terminal command telling Claude Code to read the file.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The instruction content (markdown)",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "read_terminal_output",
    description:
      "Read the last 200 lines of terminal output from Claude Code's tmux session. Use to check progress, read plans, detect errors, or see if Claude Code is idle (waiting at the > prompt).",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "read_sandbox_file",
    description: "Read a file from the sandbox filesystem.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ask_user",
    description:
      "Escalate a message or question to the user. This BLOCKS the manager until the user responds. Use for: plan approval, error reports, PR ready notifications, questions, anything non-routine.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The message to show the user in the chat panel",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "wait",
    description:
      "Signal that you're done for now and want to be checked back on later. Use when waiting for Claude Code to finish work (polling). The manager will re-tick after a short delay.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Why you're waiting (for logging)",
        },
      },
      required: ["reason"],
    },
  },
];

interface ManagerContext {
  taskId: string;
  taskDescription: string;
  repoUrl: string;
  branchName: string;
  sandbox: SandboxInstance;
  storage: DurableObjectStorage;
  env: Env;
  broadcastEvent: (type: string, data: Record<string, unknown>) => void;
  addEscalation: (from: "agent" | "user", message: string) => Promise<void>;
  updateTask: (updates: Record<string, unknown>) => Promise<void>;
}

export class ManagerAgent {
  private client: Anthropic;
  private ctx: ManagerContext;

  constructor(ctx: ManagerContext) {
    this.ctx = ctx;
    this.client = new Anthropic({
      apiKey: ctx.env.ANTHROPIC_API_KEY ?? "",
    });
  }

  /** Initial boot — called when task starts executing. */
  async start(): Promise<void> {
    const state = defaultManagerState();
    await saveManagerState(this.ctx.storage, this.ctx.taskId, state);
    await saveConversation(this.ctx.storage, this.ctx.taskId, []);
    this.broadcast("manager_phase_changed", { phase: "booting" });
    await this.boot();
    // tick() will handle dialog acceptance and transition to planning
  }

  /** Run the boot script in the sandbox. Idempotent — safe to call again after container recycle. */
  private async boot(): Promise<void> {
    // Explicitly enable keepAlive to prevent container auto-shutdown
    try {
      await (this.ctx.sandbox as unknown as { setKeepAlive(v: boolean): Promise<void> }).setKeepAlive(true);
    } catch (err) {
      console.log(`[Manager ${this.ctx.taskId}] setKeepAlive failed (may not be supported):`, err);
    }

    // Verify secrets are available for the boot script
    const apiKeyLen = (this.ctx.env.ANTHROPIC_API_KEY ?? "").length;
    const ghTokenLen = (this.ctx.env.GITHUB_TOKEN ?? "").length;
    console.log(`[Manager ${this.ctx.taskId}] Boot env: ANTHROPIC_API_KEY=${apiKeyLen}chars, GITHUB_TOKEN=${ghTokenLen}chars`);

    const { buildStartScript } = await import("../sandbox/agent.js");
    const script = buildStartScript(
      {
        taskId: this.ctx.taskId,
        branchName: this.ctx.branchName,
        repoContext: { repoUrl: this.ctx.repoUrl, defaultBranch: "main", projectType: "unknown", structure: [] },
        subtasks: [],
        touchSet: [],
        callbackUrl: "",
      },
      this.ctx.env,
    );
    const asciiScript = script.replace(/[^\x00-\x7F]/g, "-");
    const b64 = btoa(asciiScript);
    try {
      const boot = await this.ctx.sandbox.exec(
        `echo '${b64}' | base64 -d > /workspace/.phil-start.sh && chmod +x /workspace/.phil-start.sh && /workspace/.phil-start.sh 2>&1`,
      );
      if (!boot.success) {
        console.error(`[Manager ${this.ctx.taskId}] Boot failed:`, boot.stderr, boot.stdout);
      }
    } catch (err) {
      console.error(`[Manager ${this.ctx.taskId}] Boot exception:`, err);
    }
  }

  /** Periodic check — called by alarm */
  async tick(): Promise<void> {
    const state = await loadManagerState(this.ctx.storage, this.ctx.taskId);
    if (!state || state.phase === "done" || state.phase === "error") return;
    if (state.waitingForUser) return; // blocked on user response

    // Check if container recycled (tmux not running) — re-boot if needed
    const tmuxCheck = await this.ctx.sandbox.exec(`tmux -S ${TMUX_SOCK} has-session -t claude 2>&1 && echo READY || echo NOT_READY`);
    if (!tmuxCheck.stdout.includes("READY")) {
      console.log(`[Manager ${this.ctx.taskId}] Container recycled — re-booting`);
      this.broadcast("manager_thinking", { message: "Container recycled, re-booting sandbox..." });
      await this.boot();
      return; // Next tick will check if boot succeeded
    }

    // During booting phase, navigate Claude Code through startup dialogs
    if (state.phase === "booting") {
      const termOutput = await this.ctx.sandbox.exec(
        `tmux -S ${TMUX_SOCK} capture-pane -p -S -50 2>&1`,
      );
      const output = termOutput.stdout || "";

      // Auto-accept startup dialogs via tmux keystrokes
      if (output.includes("Yes, I trust this folder") && output.includes("Enter to confirm")) {
        console.log(`[Manager ${this.ctx.taskId}] Accepting workspace trust dialog`);
        await this.ctx.sandbox.exec(`tmux -S ${TMUX_SOCK} send-keys -t claude Enter`);
        return;
      }

      // "Use API key from environment?" dialog — select "Yes, use it" (need to navigate to it)
      if (output.includes("API key") && output.includes("ANTHROPIC_API_KEY") && output.includes("Enter to confirm")) {
        console.log(`[Manager ${this.ctx.taskId}] Accepting API key from environment`);
        // "No (recommended)" is pre-selected; move up to "Yes" and confirm
        await this.ctx.sandbox.exec(`tmux -S ${TMUX_SOCK} send-keys -t claude Up`);
        await this.ctx.sandbox.exec(`tmux -S ${TMUX_SOCK} send-keys -t claude Enter`);
        return;
      }

      if (output.includes("Bypass Permissions mode") && output.includes("Enter to confirm")) {
        console.log(`[Manager ${this.ctx.taskId}] Accepting bypass permissions dialog`);
        await this.ctx.sandbox.exec(`tmux -S ${TMUX_SOCK} send-keys -t claude Down`);
        await this.ctx.sandbox.exec(`tmux -S ${TMUX_SOCK} send-keys -t claude Enter`);
        return;
      }

      if (output.includes("Enter to confirm") || output.includes("Esc to cancel")) {
        console.log(`[Manager ${this.ctx.taskId}] Unknown dialog, pressing Enter`);
        await this.ctx.sandbox.exec(`tmux -S ${TMUX_SOCK} send-keys -t claude Enter`);
        return;
      }

      // Check if Claude Code is actually idle (showing the > prompt)
      // It might still be initializing even after dialogs are gone
      if (!output.includes(">") && !output.includes("claude")) {
        console.log(`[Manager ${this.ctx.taskId}] Claude Code still initializing`);
        return; // Wait for next tick
      }

      // Claude Code is ready — transition to planning phase
      state.phase = "planning";
      await saveManagerState(this.ctx.storage, this.ctx.taskId, state);
      this.broadcast("manager_phase_changed", { phase: "planning" });

      await this.runStepLoop(
        "Claude Code is now ready in the terminal (past all startup dialogs). Begin the planning phase: send it the task description and ask it to create a plan. The task is: " + this.ctx.taskDescription,
      );
      return;
    }

    await this.runStepLoop(
      "Periodic check. Read the terminal output to see what Claude Code is doing. Take appropriate action based on the current phase.",
    );
  }

  /** User sent a message via ChatPanel */
  async onUserMessage(message: string): Promise<void> {
    const state = await loadManagerState(this.ctx.storage, this.ctx.taskId);
    if (!state) return;

    // If we were waiting for user, resume
    if (state.waitingForUser) {
      state.waitingForUser = false;
      state.pendingQuestion = undefined;
      await saveManagerState(this.ctx.storage, this.ctx.taskId, state);
    }

    await this.runStepLoop(
      `The user responded: "${message}"\n\nProcess their response and take appropriate action.`,
    );
  }

  /** GitHub review comments received */
  async onReviewReceived(reviews: ReviewComment[]): Promise<void> {
    const state = await loadManagerState(this.ctx.storage, this.ctx.taskId);
    if (!state) return;

    const reviewText = reviews
      .map(
        (r) =>
          `- ${r.author}${r.path ? ` on ${r.path}${r.line ? `:${r.line}` : ""}` : ""}: ${r.body}`,
      )
      .join("\n");

    await this.setPhase("fixing");
    await this.runStepLoop(
      `PR review comments received. Pass these to Claude Code to fix:\n\n${reviewText}`,
    );
  }

  // --- Internal ---

  private async runStepLoop(trigger: string): Promise<void> {
    const state = await loadManagerState(this.ctx.storage, this.ctx.taskId);
    if (!state) return;

    const messages = await loadConversation(this.ctx.storage, this.ctx.taskId);

    // Add the trigger as a user message
    messages.push({ role: "user", content: trigger });

    const systemPrompt = buildManagerSystemPrompt({
      taskDescription: this.ctx.taskDescription,
      repoUrl: this.ctx.repoUrl,
      branchName: this.ctx.branchName,
      currentPhase: state.phase,
    });

    for (let step = 0; step < MAX_STEPS; step++) {
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: systemPrompt,
          tools: MANAGER_TOOLS,
          messages,
        });
      } catch (err) {
        console.error(`[Manager ${this.ctx.taskId}] API error:`, err);
        await this.ctx.addEscalation("agent", `Manager error: ${String(err)}`);
        break;
      }

      // Add assistant response to conversation
      messages.push({ role: "assistant", content: response.content });

      // Extract any text content for logging
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          this.broadcast("manager_thinking", { message: block.text });
        }
      }

      // If no tool use, the model is done for now
      if (response.stop_reason === "end_turn") {
        break;
      }

      // Process tool calls
      if (response.stop_reason === "tool_use") {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        let shouldBreak = false;

        for (const block of response.content) {
          if (block.type !== "tool_use") continue;

          const result = await this.executeTool(
            block.name,
            block.input as Record<string, string>,
            state,
          );

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.output,
          });

          if (result.breakLoop) {
            shouldBreak = true;
          }
        }

        // Add tool results as user message
        messages.push({ role: "user", content: toolResults });

        // Save state after each tool execution
        await saveManagerState(this.ctx.storage, this.ctx.taskId, state);
        await saveConversation(this.ctx.storage, this.ctx.taskId, messages);

        if (shouldBreak) break;
      }
    }

    // Final save
    await saveConversation(this.ctx.storage, this.ctx.taskId, messages);
    await saveManagerState(this.ctx.storage, this.ctx.taskId, state);
  }

  private async executeTool(
    name: string,
    input: Record<string, string>,
    state: ManagerState,
  ): Promise<{ output: string; breakLoop: boolean }> {
    switch (name) {
      case "send_terminal_command": {
        const text = input.text;
        const escaped = text.replace(/"/g, '\\"').replace(/\$/g, "\\$");
        const result = await this.ctx.sandbox.exec(
          `tmux -S ${TMUX_SOCK} send-keys "${escaped}" Enter`,
        );
        return {
          output: result.success
            ? `Command sent to terminal: ${text.slice(0, 100)}`
            : `Failed to send: ${result.stderr}`,
          breakLoop: false,
        };
      }

      case "write_instruction_file": {
        await this.ctx.sandbox.writeFile(
          "/workspace/.phil-instruction.md",
          input.content,
        );
        return {
          output: "Instruction file written to /workspace/.phil-instruction.md",
          breakLoop: false,
        };
      }

      case "read_terminal_output": {
        const result = await this.ctx.sandbox.exec(
          `tmux -S ${TMUX_SOCK} capture-pane -p -S -200 2>&1`,
        );
        const output = result.stdout || "(empty terminal)";
        return { output, breakLoop: false };
      }

      case "read_sandbox_file": {
        const result = await this.ctx.sandbox.exec(
          `cat '${input.path}' 2>&1`,
        );
        return {
          output: result.success
            ? result.stdout
            : `File not found or error: ${result.stderr}`,
          breakLoop: false,
        };
      }

      case "ask_user": {
        state.waitingForUser = true;
        state.pendingQuestion = input.message;
        await this.ctx.addEscalation("agent", input.message);
        return {
          output:
            "Message sent to user. The manager will pause until the user responds.",
          breakLoop: true,
        };
      }

      case "wait": {
        return {
          output: `Waiting: ${input.reason}. Will check again on next tick.`,
          breakLoop: true,
        };
      }

      default:
        return { output: `Unknown tool: ${name}`, breakLoop: false };
    }
  }

  private async setPhase(phase: ManagerPhase): Promise<void> {
    const state = await loadManagerState(this.ctx.storage, this.ctx.taskId);
    if (!state) return;
    state.phase = phase;
    await saveManagerState(this.ctx.storage, this.ctx.taskId, state);
    this.broadcast("manager_phase_changed", { phase });
  }

  private broadcast(type: string, data: Record<string, unknown>): void {
    this.ctx.broadcastEvent(type, { ...data, taskId: this.ctx.taskId });
  }
}
