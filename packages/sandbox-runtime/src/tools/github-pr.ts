import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function githubPr(input: {
  title: string;
  body: string;
  base?: string;
}): Promise<string> {
  const args = [
    "pr", "create",
    "--title", input.title,
    "--body", input.body,
  ];
  if (input.base) {
    args.push("--base", input.base);
  }

  const { stdout } = await execFileAsync("gh", args, {
    cwd: process.cwd(),
    timeout: 30_000,
  });

  return stdout.trim();
}
