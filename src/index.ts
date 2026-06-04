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
  .description("Clone and set up Node, React, TypeScript, and other JS/TS repositories.")
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
  .option("--package-manager <command>", "package manager install command (npm, yarn, pnpm)", "npm")
  .option("--pull", "run git pull in repositories that already exist", false)
  .option("--skip-install", "clone/pull only, skip dependency installation", false)
  .option("--skip-build", "skip the post-install build step even for TS/React/Next/Vite projects", false)
  .option("--clone-timeout <seconds>", `seconds before a clone/pull is killed (0 = no limit)`, String(DEFAULT_CLONE_TIMEOUT_S))
  .option("--install-timeout <seconds>", `seconds before an install is killed (0 = no limit)`, String(DEFAULT_INSTALL_TIMEOUT_S))
  .option("--build-timeout <seconds>", `seconds before a build is killed (0 = no limit)`, String(DEFAULT_BUILD_TIMEOUT_S))
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
  pull: boolean;
  skipInstall: boolean;
  skipBuild: boolean;
  cloneTimeout: number;
  installTimeout: number;
  buildTimeout: number;
}): Promise<RepoResult> {
  const repoDir = path.join(targetDir, repo.name);
  const exists = await fs.pathExists(repoDir);

  // Prevent git from hanging on credential prompts
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

  // ── clone / pull ──────────────────────────────────────────────────────────
  try {
    if (exists) {
      const spinner = ora(`${repo.name}: already exists`).start();

      if (pull) {
        spinner.text = `${repo.name}: pulling latest changes`;
        await execa("git", ["pull", "--ff-only"], {
          cwd: repoDir,
          env: gitEnv,
          ...(cloneTimeout && { timeout: cloneTimeout })
        });
      }

      spinner.succeed(`${repo.name}: repository ready`);
    } else {
      const spinner = ora(`${repo.name}: cloning`).start();
      const args = ["clone", repo.url, repoDir];

      if (repo.branch) {
        args.splice(1, 0, "--branch", repo.branch);
      }

      await execa("git", args, {
        env: gitEnv,
        ...(cloneTimeout && { timeout: cloneTimeout })
      });
      spinner.succeed(`${repo.name}: cloned`);
    }
  } catch (err) {
    return {
      status: "failed",
      name: repo.name,
      step: exists ? "pull" : "clone",
      message: formatError(err, cloneTimeout)
    };
  }

  if (skipInstall) {
    return { status: "ok", name: repo.name };
  }

  // ── install ───────────────────────────────────────────────────────────────
  try {
    const installSpinner = ora(`${repo.name}: installing dependencies`).start();
    await execa(packageManager, ["install"], {
      cwd: repoDir,
      ...(installTimeout && { timeout: installTimeout })
    });
    installSpinner.succeed(`${repo.name}: dependencies installed`);
  } catch (err) {
    return {
      status: "failed",
      name: repo.name,
      step: "install",
      message: formatError(err, installTimeout)
    };
  }

  if (skipBuild) {
    return { status: "ok", name: repo.name };
  }

  // ── build (auto-detect for TS / React / Next / Vite) ─────────────────────
  try {
    const runBuild = await resolveBuild(repo, repoDir);
    if (runBuild) {
      const buildSpinner = ora(`${repo.name}: building`).start();
      await execa(packageManager, ["run", "build"], {
        cwd: repoDir,
        ...(buildTimeout && { timeout: buildTimeout })
      });
      buildSpinner.succeed(`${repo.name}: build complete`);
    }
  } catch (err) {
    return {
      status: "failed",
      name: repo.name,
      step: "build",
      message: formatError(err, buildTimeout)
    };
  }

  return { status: "ok", name: repo.name };
}

/** Decide whether to run the build script for a repo. */
async function resolveBuild(repo: Repo, repoDir: string): Promise<boolean> {
  if (repo.build === false) return false;
  if (repo.build === true) return hasBuildScript(repoDir);

  const detectedType = repo.type && repo.type !== "auto"
    ? repo.type
    : await detectProjectType(repoDir);

  if (detectedType === "node") return false;

  return hasBuildScript(repoDir);
}

/** Read the repo's package.json and infer project type from its dependencies. */
async function detectProjectType(repoDir: string): Promise<ProjectType> {
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

  return {
    repos,
    source: configPath
  };
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
  return n * 1000; // convert to ms for execa
}

function formatError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    // execa sets .timedOut = true on timeout kills
    if ((err as NodeJS.ErrnoException & { timedOut?: boolean }).timedOut) {
      return `timed out after ${timeoutMs / 1000}s`;
    }
    return err.message.split("\n")[0].trim();
  }
  return String(err);
}
