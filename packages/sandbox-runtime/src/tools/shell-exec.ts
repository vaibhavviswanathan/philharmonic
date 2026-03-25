import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 120_000;

export async function shellExec(input: {
  command: string;
  args?: string[];
  cwd?: string;
}): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      input.command,
      input.args ?? [],
      {
        cwd: input.cwd ?? process.cwd(),
        timeout: TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
        shell: true,
      },
    );
    const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : "");
    return output || "(no output)";
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message: string };
    return `ERROR: ${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
  }
}
