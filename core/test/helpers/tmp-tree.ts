import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** A throwaway directory tree for pipeline tests. */
export class TmpTree {
  readonly root: string;

  constructor(prefix = "waterslide-test-") {
    this.root = mkdtempSync(path.join(tmpdir(), prefix));
  }

  write(rel: string, content: string): string {
    const abs = path.join(this.root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  remove(rel: string): void {
    rmSync(path.join(this.root, rel), { recursive: true, force: true });
  }

  gitInit(rel = ""): void {
    const dir = path.join(this.root, rel);
    const git = (...args: string[]): string =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init", "--allow-empty");
  }

  gitHead(rel = ""): string {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.join(this.root, rel),
      encoding: "utf8",
    }).trim();
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
