import Anthropic from "@anthropic-ai/sdk";
import type { DispatchPayload, Subtask, RepoContext } from "@phil/shared";
import { SandboxManager } from "../sandbox/manager.js";
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt } from "./prompts.js";
import type { Env } from "../env.js";

interface PlannerOutput {
  subtasks: Array<{
    id: string;
    description: string;
    dependencies: string[];
    fileTargets: string[];
  }>;
  touchSet: string[];
  branchName: string;
}

export async function planTask(
  taskId: string,
  repoUrl: string,
  description: string,
  env: Env,
): Promise<DispatchPayload> {
  const sandboxManager = new SandboxManager(env);

  // Use sandbox to clone and analyze repo
  const { structure, projectType, defaultBranch } = await sandboxManager.analyzeRepo(repoUrl, taskId);

  const repoContext: RepoContext = {
    repoUrl,
    defaultBranch,
    projectType,
    structure,
  };

  // Ask Claude to plan the task
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const userPrompt = buildPlannerUserPrompt(
    description,
    repoUrl,
    structure,
    projectType,
  );

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: PLANNER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Planner returned no text response");
  }

  let plan: PlannerOutput;
  try {
    plan = JSON.parse(textBlock.text);
  } catch {
    throw new Error(`Planner returned invalid JSON: ${textBlock.text.slice(0, 200)}`);
  }

  const subtasks: Subtask[] = plan.subtasks.map((s) => ({
    id: s.id,
    description: s.description,
    status: "pending",
    dependencies: s.dependencies,
    fileTargets: s.fileTargets,
  }));

  const workerUrl = env.WORKER_URL ?? "";
  return {
    taskId,
    branchName: plan.branchName,
    repoContext,
    subtasks,
    touchSet: plan.touchSet,
    callbackUrl: `${workerUrl}/internal/sandboxes/${taskId}`,
  };
}
