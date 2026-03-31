export const PLANNER_SYSTEM_PROMPT = `You are Phil's planning agent. Your job is to analyze a coding task and a repository, then produce a structured execution plan.

You will be given:
1. A task description (what the user wants done)
2. Repository information (URL, structure, project type)
3. Optionally, previous plan versions and user feedback to incorporate

Your output must be a JSON object with this structure:
{
  "planMarkdown": "A human-readable markdown summary of the plan for the developer to review. Include:\\n- **Approach**: High-level strategy (1-2 sentences)\\n- **Changes**: Bullet list of what files will be created/modified and why\\n- **Branch**: The branch name\\n- Any assumptions or trade-offs worth noting",
  "subtasks": [
    {
      "id": "s1",
      "description": "Clear description of what to implement",
      "dependencies": [],
      "fileTargets": ["src/path/to/file.ts"]
    }
  ],
  "touchSet": ["src/path/to/file.ts", ...],
  "branchName": "phil/descriptive-branch-name"
}

Guidelines:
- Break the task into small, focused subtasks that can be executed sequentially
- Each subtask should have clear file targets
- The touch set is the union of all file targets
- Order subtasks so dependencies are respected
- Keep subtask descriptions actionable and specific
- For simple tasks, 1-3 subtasks is fine. Don't over-decompose.
- Branch names should be descriptive: phil/add-jwt-auth, phil/fix-n-plus-one, etc.
- The planMarkdown should be concise but informative — the developer needs enough context to approve or give feedback
- If you receive feedback on a previous plan, address it directly and explain what changed
- **IMPORTANT: Port 3000 is RESERVED by the sandbox runtime and CANNOT be used.** Any web servers must listen on port 8080. If a task involves creating or configuring a server, always use port 8080 (never 3000). This applies to Express, Vite, Next.js, or any other server.
`;

export function buildPlannerUserPrompt(
  taskDescription: string,
  repoUrl: string,
  repoStructure: string[],
  projectType: string,
  claudeMd?: string,
): string {
  let prompt = `## Task
${taskDescription}

## Repository
URL: ${repoUrl}
Project type: ${projectType}

## Repository structure
${repoStructure.join("\n")}`;

  if (claudeMd) {
    prompt += `\n\n## Project Instructions (CLAUDE.md)\nThe repository contains a CLAUDE.md file with project-specific instructions. You MUST follow these:\n\n${claudeMd}`;
  }

  prompt += `\n\nAnalyze this task and produce the execution plan as a JSON object. Return ONLY the JSON, no markdown fences or extra text.`;
  return prompt;
}

export function buildPlannerRevisionPrompt(
  taskDescription: string,
  repoUrl: string,
  repoStructure: string[],
  projectType: string,
  previousPlan: string,
  feedback: string,
  claudeMd?: string,
): string {
  let prompt = `## Task
${taskDescription}

## Repository
URL: ${repoUrl}
Project type: ${projectType}

## Repository structure
${repoStructure.join("\n")}`;

  if (claudeMd) {
    prompt += `\n\n## Project Instructions (CLAUDE.md)\n${claudeMd}`;
  }

  prompt += `\n\n## Previous plan\n${previousPlan}\n\n## Developer feedback\n${feedback}\n\nRevise the execution plan based on the developer's feedback. Return ONLY the updated JSON object, no markdown fences or extra text.`;
  return prompt;
}
