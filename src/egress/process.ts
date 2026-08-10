import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export async function runProcess(
  command: string,
  args: string[],
  stdin: Buffer | string,
  timeoutMs = 60_000,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        exitCode: exitCode ?? -1,
      });
    });
    child.stdin.end(stdin);
  });
}
