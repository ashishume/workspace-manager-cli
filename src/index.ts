#!/usr/bin/env node

import { Command } from "commander";
import { execa } from "execa";
import fs from "fs-extra";
import ora from "ora";
import pLimit from "p-limit";
import path from "node:path";
import { DEFAULT_REPOS } from "./default-repos.js";
import type { ProjectType, Repo } from "./types.js";

const DEFAULT_CLONE_TIMEOUT_S = 60;
const DEFAULT_INSTALL_TIMEOUT_S = 120;
const DEFAULT_BUILD_TIMEOUT_S = 120;

type SetupOptions = {
  target: string;
  config: string;
  concurrency: string;
  packageManager: string;
  python: string;
  pull: boolean;
  skipInstall: boolean;
  skipBuild: boolean;
  cloneTimeout: string;
  installTimeout: string;
  buildTimeout: string;
};

type InitOptions = {
  config: string;
  force: boolean;
};

type RepoResult =
  | { status: "ok"; name: string }
  | { status: "failed"; name: string; step: string; message: string };

const program = new Command();

program
  .name("setup-repos")
  .description("Clone and set up Node, React, TypeScript, FastAPI, and other repositories.")
  .version("0.1.0");

program
  .command("init")
  .description("Create a repos.json config file from the embedded default repo list.")
  .option("-c, --config <file>", "config file to create", "./repos.json")
  .option("--force", "overwrite the config file if it already exists", false)
  .action((options: InitOptions) => {
    initConfig(options).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  });

program
  .command("setup", { isDefault: true })
  .description("Clone all configured repositories and run install (and build) in each.")
  .option("-t, --target <dir>", "folder where repositories will be cloned", "./workspace")
  .option("-c, --config <file>", "JSON file containing repository definitions", "./repos.json")
  .option("--concurrency <number>", "number of repositories to process at once", "3")
  .option("--package-manager <command>", "JS package manager install command (npm, yarn, pnpm)", "npm")
  .option("--python <command>", "Python binary to use for venv creation", "python3")
  .option("--pull", "run git pull in repositories that already exist", false)
  .option("--skip-install", "clone/pull only, skip dependency installation", false)
  .option("--skip-build", "skip the post-install build step for TS/React/Next/Vite projects", false)
  .option("--clone-timeout <seconds>", "seconds before a clone/pull is killed (0 = no limit)", String(DEFAULT_CLONE_TIMEOUT_S))
  .option("--install-timeout <seconds>", "seconds before an install is killed (0 = no limit)", String(DEFAULT_INSTALL_TIMEOUT_S))
  .option("--build-timeout <seconds>", "seconds before a build is killed (0 = no limit)", String(DEFAULT_BUILD_TIMEOUT_S))
  .action((options: SetupOptions) => {
    setup(options).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  });

await program.parseAsync();

async function setup(options: SetupOptions) {
  const cwd = process.cwd();
  const targetDir = path.resolve(cwd, options.target);
  const configPath = path.resolve(cwd, options.config);
  const concurrency = parseConcurrency(options.concurrency);
  const packageManager = options.packageManager.trim();
  const python = options.python.trim();
  const cloneTimeout = parseTimeout(options.cloneTimeout, "--clone-timeout");
  const installTimeout = parseTimeout(options.installTimeout, "--install-timeout");
  const buildTimeout = parseTimeout(options.buildTimeout, "--build-timeout");

  const { repos, source } = await loadRepos(configPath);

  await fs.ensureDir(targetDir);

  console.log(`Using repos      : ${source}`);
  console.log(`Target           : ${targetDir}`);
  console.log(`Repos            : ${repos.length}`);
  console.log(`Concurrency      : ${concurrency}`);
  console.log(`Clone timeout    : ${cloneTimeout ? `${cloneTimeout / 1000}s` : "none"}`);
  console.log(`Install timeout  : ${installTimeout ? `${installTimeout / 1000}s` : "none"}`);
  console.log(`Build timeout    : ${buildTimeout ? `${buildTimeout / 1000}s` : "none"}`);
  console.log("");

  const limit = pLimit(concurrency);
  const results = await Promise.all(
    repos.map((repo) =>
      limit(() =>
        setupRepo({
          repo,
          targetDir,
          packageManager,
          python,
          pull: options.pull,
          skipInstall: options.skipInstall,
          skipBuild: options.skipBuild,
          cloneTimeout,
          installTimeout,
          buildTimeout
        })
      )
    )
  );

  const succeeded = results.filter((r): r is Extract<RepoResult, { status: "ok" }> => r.status === "ok");
  const failed = results.filter((r): r is Extract<RepoResult, { status: "failed" }> => r.status === "failed");

  console.log("");

  if (succeeded.length > 0) {
    console.log(`${succeeded.length} repo(s) ready.`);
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} repo(s) failed:\n`);
    for (const r of failed) {
      console.error(`  ✗ ${r.name}  [${r.step}]  ${r.message}`);
    }
    process.exitCode = 1;
  }
}

async function initConfig(options: InitOptions) {
  const configPath = path.resolve(process.cwd(), options.config);

  if ((await fs.pathExists(configPath)) && !options.force) {
    throw new Error(`Config already exists: ${configPath}\nUse --force to overwrite it.`);
  }

  const template = [
    { name: "repo-01", url: "https://github.com/your-org/repo-01.git" },
    { name: "repo-02", url: "https://github.com/your-org/repo-02.git" }
  ];

  await fs.ensureDir(path.dirname(configPath));
  await fs.writeJson(configPath, template, { spaces: 2 });
  console.log(`Created ${configPath}`);
  console.log(`Edit it to add your own repositories, then run: setup-repos setup`);
}

async function setupRepo({
  repo,
  targetDir,
  packageManager,
  python,
  pull,
  skipInstall,
  skipBuild,
  cloneTimeout,
  installTimeout,
  buildTimeout
}: {
  repo: Repo;
  targetDir: string;
  packageManager: string;
  python: string;
  pull: boolean;
  skipInstall: boolean;
  skipBuild: boolean;
  cloneTimeout: number;
  installTimeout: number;
  buildTimeout: number;
}): Promise<RepoResult> {
  const repoDir = path.join(targetDir, repo.name);
  const exists = await fs.pathExists(repoDir);
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  // ── clone / pull ──────────────────────────────────────────────────────────
  if (exists) {
    const spinner = ora(`${repo.name}: already exists`).start();

    if (pull) {
      spinner.text = `${repo.name}: pulling latest changes`;
      try {
        await execa("git", ["pull", "--ff-only"], {
          cwd: repoDir,
          env: gitEnv,
          ...(cloneTimeout && { timeout: cloneTimeout })
        });
      } catch (err) {
        spinner.fail(`${repo.name}: pull failed`);
        return { status: "failed", name: repo.name, step: "pull", message: formatError(err, cloneTimeout) };
      }
    }

    spinner.succeed(`${repo.name}: repository ready`);
  } else {
    const spinner = ora(`${repo.name}: cloning`).start();
    const args = ["clone", repo.url, repoDir];

    if (repo.branch) {
      args.splice(1, 0, "--branch", repo.branch);
    }

    try {
      await execa("git", args, {
        env: gitEnv,
        ...(cloneTimeout && { timeout: cloneTimeout })
      });
    } catch (err) {
      spinner.fail(`${repo.name}: clone failed`);
      return { status: "failed", name: repo.name, step: "clone", message: formatError(err, cloneTimeout) };
    }

    spinner.succeed(`${repo.name}: cloned`);
  }

  if (skipInstall) {
    return { status: "ok", name: repo.name };
  }

  // ── detect project type ───────────────────────────────────────────────────
  const projectType = repo.type && repo.type !== "auto"
    ? repo.type
    : await detectProjectType(repoDir);

  const isPython = projectType === "python" || projectType === "fastapi";

  // Guard: skip install entirely if the repo has no recognizable project files.
  // This handles empty repos (git clone exits 0 but leaves no files).
  if (!isPython && !(await fs.pathExists(path.join(repoDir, "package.json")))) {
    ora(`${repo.name}: no package.json found — skipping install`).warn();
    return { status: "ok", name: repo.name };
  }

  // ── install ───────────────────────────────────────────────────────────────
  if (isPython) {
    try {
      const result = await pythonInstall(repo.name, repoDir, python, installTimeout);
      if (result) return result;
    } catch (err) {
      return {
        status: "failed",
        name: repo.name,
        step: "install",
        message: formatError(err, installTimeout)
      };
    }
  } else {
    const installSpinner = ora(`${repo.name}: installing dependencies`).start();
    try {
      await execa(packageManager, ["install"], {
        cwd: repoDir,
        ...(installTimeout && { timeout: installTimeout })
      });
      installSpinner.succeed(`${repo.name}: dependencies installed`);
    } catch (err) {
      installSpinner.fail(`${repo.name}: install failed`);
      return { status: "failed", name: repo.name, step: "install", message: formatError(err, installTimeout) };
    }
  }

  // ── build (JS/TS only) ────────────────────────────────────────────────────
  if (!isPython && !skipBuild) {
    const runBuild = await resolveBuild(repo, projectType, repoDir);
    if (runBuild) {
      const buildSpinner = ora(`${repo.name}: building`).start();
      try {
        await execa(packageManager, ["run", "build"], {
          cwd: repoDir,
          ...(buildTimeout && { timeout: buildTimeout })
        });
        buildSpinner.succeed(`${repo.name}: build complete`);
      } catch (err) {
        buildSpinner.fail(`${repo.name}: build failed`);
        return { status: "failed", name: repo.name, step: "build", message: formatError(err, buildTimeout) };
      }
    }
  }

  return { status: "ok", name: repo.name };
}

/**
 * Set up a Python project:
 *   1. Create .venv if missing
 *   2. pip install from requirements.txt, pyproject.toml, or setup.py
 */
async function pythonInstall(
  repoName: string,
  repoDir: string,
  python: string,
  timeout: number
): Promise<RepoResult | null> {
  const venvDir = path.join(repoDir, ".venv");
  const pip = path.join(venvDir, "bin", "pip");

  // create venv
  if (!(await fs.pathExists(venvDir))) {
    const venvSpinner = ora(`${repoName}: creating virtual environment`).start();
    try {
      await execa(python, ["-m", "venv", ".venv"], {
        cwd: repoDir,
        ...(timeout && { timeout })
      });
      venvSpinner.succeed(`${repoName}: virtual environment created`);
    } catch (err) {
      venvSpinner.fail(`${repoName}: failed to create virtual environment`);
      return { status: "failed", name: repoName, step: "venv", message: formatError(err, timeout) };
    }
  }

  // upgrade pip silently
  await execa(pip, ["install", "--upgrade", "pip", "--quiet"], {
    cwd: repoDir,
    ...(timeout && { timeout })
  }).catch(() => { /* non-fatal */ });

  // pick install method
  const hasRequirements = await fs.pathExists(path.join(repoDir, "requirements.txt"));
  const hasPyproject = await fs.pathExists(path.join(repoDir, "pyproject.toml"));
  const hasSetupPy = await fs.pathExists(path.join(repoDir, "setup.py"));

  const installSpinner = ora(`${repoName}: installing Python dependencies`).start();

  if (hasRequirements) {
    await execa(pip, ["install", "-r", "requirements.txt"], {
      cwd: repoDir,
      ...(timeout && { timeout })
    });
  } else if (hasPyproject || hasSetupPy) {
    await execa(pip, ["install", "-e", "."], {
      cwd: repoDir,
      ...(timeout && { timeout })
    });
  } else {
    installSpinner.warn(`${repoName}: no requirements.txt or pyproject.toml found — skipping install`);
    return null;
  }

  installSpinner.succeed(`${repoName}: Python dependencies installed`);
  return null;
}

/** Decide whether to run the build script for a JS/TS repo. */
async function resolveBuild(repo: Repo, detectedType: ProjectType, repoDir: string): Promise<boolean> {
  if (repo.build === false) return false;
  if (repo.build === true) return hasBuildScript(repoDir);
  if (detectedType === "node") return false;
  return hasBuildScript(repoDir);
}

/** Infer project type from the repo's files. */
async function detectProjectType(repoDir: string): Promise<ProjectType> {
  // Python markers take precedence
  const [hasRequirements, hasPyproject, hasSetupPy] = await Promise.all([
    fs.pathExists(path.join(repoDir, "requirements.txt")),
    fs.pathExists(path.join(repoDir, "pyproject.toml")),
    fs.pathExists(path.join(repoDir, "setup.py"))
  ]);

  if (hasRequirements || hasSetupPy) {
    const isFastapi = hasRequirements && (await fileContains(path.join(repoDir, "requirements.txt"), "fastapi"));
    return isFastapi ? "fastapi" : "python";
  }

  if (hasPyproject) {
    const isFastapi = await fileContains(path.join(repoDir, "pyproject.toml"), "fastapi");
    return isFastapi ? "fastapi" : "python";
  }

  // JS/TS detection via package.json
  const pkgPath = path.join(repoDir, "package.json");
  if (!(await fs.pathExists(pkgPath))) return "node";

  let pkg: Record<string, unknown>;
  try {
    pkg = await fs.readJson(pkgPath);
  } catch {
    return "node";
  }

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {})
  };

  if ("next" in allDeps) return "next";
  if ("react" in allDeps || "react-dom" in allDeps) return "react";
  if ("vite" in allDeps) return "vite";
  if ("typescript" in allDeps) return "typescript";
  return "node";
}

/** Check whether the repo's package.json defines a "build" script. */
async function hasBuildScript(repoDir: string): Promise<boolean> {
  const pkgPath = path.join(repoDir, "package.json");
  if (!(await fs.pathExists(pkgPath))) return false;

  try {
    const pkg = await fs.readJson(pkgPath);
    return typeof (pkg as Record<string, unknown> & { scripts?: Record<string, unknown> }).scripts?.build === "string";
  } catch {
    return false;
  }
}

/** Case-insensitive substring check in a file. */
async function fileContains(filePath: string, keyword: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.toLowerCase().includes(keyword.toLowerCase());
  } catch {
    return false;
  }
}

async function loadRepos(configPath: string): Promise<{ repos: Repo[]; source: string }> {
  if (!(await fs.pathExists(configPath))) {
    validateRepos(DEFAULT_REPOS);
    return {
      repos: DEFAULT_REPOS,
      source: `embedded defaults (${DEFAULT_REPOS.length} repos)`
    };
  }

  const repos = await fs.readJson(configPath);
  validateRepos(repos);

  return { repos, source: configPath };
}

function validateRepos(repos: unknown): asserts repos is Repo[] {
  if (!Array.isArray(repos)) {
    throw new Error("Repo config must be an array.");
  }

  repos.forEach((repo, index) => {
    if (!repo || typeof repo.name !== "string" || typeof repo.url !== "string") {
      throw new Error(`Invalid repo at index ${index}. Each repo needs "name" and "url".`);
    }
  });
}

function parseConcurrency(value: string) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--concurrency must be a positive integer.");
  }
  return n;
}

function parseTimeout(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative integer (0 = no limit).`);
  }
  return n * 1000;
}

function formatError(err: unknown, timeoutMs: number): string {
  if (!(err instanceof Error)) return String(err);

  const e = err as NodeJS.ErrnoException & { timedOut?: boolean; stderr?: string; stdout?: string };

  if (e.timedOut) return `timed out after ${timeoutMs / 1000}s`;

  // execa puts the real error output in stderr (or stdout for some tools)
  const detail = (e.stderr ?? e.stdout ?? "").trim();
  if (detail) {
    // return the last non-empty line — that's usually the actual error
    const lines = detail.split("\n").map(l => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? detail;
  }

  return err.message.split("\n")[0].trim();
}
