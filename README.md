# workspace-manager

A CLI to clone and set up multiple repositories in one shot.

Supports **Node.js**, **TypeScript**, **React**, **Next.js**, **Vite**, and **FastAPI / Python** projects — detected automatically from each repo's files.

## Install

```bash
npm install -g @ashishdev97/workspace-manager
```

## Quick start

```bash
# 1. Generate a config file
setup-repos init

# 2. Edit repos.json with your own repositories
# 3. Run setup
setup-repos setup
```

`repos.json` example:

```json
[
  { "name": "my-api",      "url": "https://github.com/your-org/my-api.git" },
  { "name": "my-frontend", "url": "https://github.com/your-org/my-frontend.git" },
  { "name": "my-service",  "url": "https://github.com/your-org/my-service.git", "branch": "develop" }
]
```

Then run:

```bash
setup-repos setup
```

This clones every repo, installs dependencies, and runs the build step where needed — all in parallel.

## What gets set up automatically

| Files found in repo | Detected as | Install | Build |
|---|---|---|---|
| `requirements.txt` with `fastapi` | FastAPI | `pip install -r requirements.txt` in `.venv` | — |
| `requirements.txt` | Python | `pip install -r requirements.txt` in `.venv` | — |
| `pyproject.toml` / `setup.py` | Python | `pip install -e .` in `.venv` | — |
| `package.json` with `next` | Next.js | `npm install` | `npm run build` |
| `package.json` with `react` | React | `npm install` | `npm run build` |
| `package.json` with `vite` | Vite | `npm install` | `npm run build` |
| `package.json` with `typescript` | TypeScript | `npm install` | `npm run build` |
| `package.json` only | Node.js | `npm install` | — |
| Empty repo | — | skipped with warning | — |

Build only runs if the repo has a `build` script in `package.json`.

## Commands

### `setup-repos init`

Creates a `repos.json` template in the current directory.

```bash
setup-repos init
setup-repos init --config ./config/repos.json   # custom path
setup-repos init --force                         # overwrite existing
```

### `setup-repos setup`

Clones and sets up all repositories.

```bash
setup-repos setup [options]
```

| Option | Default | Description |
|---|---|---|
| `-t, --target <dir>` | `./workspace` | Folder where repos are cloned |
| `-c, --config <file>` | `./repos.json` | Path to repo config (uses embedded defaults if missing) |
| `--concurrency <n>` | `3` | Number of repos to process in parallel |
| `--package-manager <cmd>` | `npm` | JS package manager (`npm`, `yarn`, `pnpm`) |
| `--python <cmd>` | `python3` | Python binary used to create virtual environments |
| `--pull` | `false` | Run `git pull` in repos that already exist |
| `--skip-install` | `false` | Clone/pull only, skip dependency installation |
| `--skip-build` | `false` | Skip the build step for all repos |
| `--clone-timeout <s>` | `60` | Seconds before a clone/pull is killed (0 = no limit) |
| `--install-timeout <s>` | `120` | Seconds before an install is killed (0 = no limit) |
| `--build-timeout <s>` | `120` | Seconds before a build is killed (0 = no limit) |

## Per-repo config

Each entry in `repos.json` supports these fields:

```json
[
  {
    "name": "my-api",
    "url": "https://github.com/your-org/my-api.git",
    "branch": "develop",
    "type": "fastapi",
    "build": false
  }
]
```

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Folder name the repo is cloned into |
| `url` | `string` | Git clone URL |
| `branch` | `string` | Branch to clone (optional) |
| `type` | `string` | Override auto-detection: `auto` `node` `typescript` `react` `next` `vite` `python` `fastapi` |
| `build` | `boolean` | Force (`true`) or suppress (`false`) the build step |

## Error handling

Each repo is processed independently. If one fails, the others continue. At the end, all failures are reported together with the exact step and error:

```
6 repo(s) ready.

2 repo(s) failed:

  ✗ my-api       [clone]    fatal: repository not found
  ✗ my-frontend  [install]  npm error code ERESOLVE
```

## Examples

```bash
# Use yarn instead of npm
setup-repos setup --package-manager yarn

# Clone only, skip install and build
setup-repos setup --skip-install

# Use a specific Python version
setup-repos setup --python python3.11

# Give slow repos more time to install
setup-repos setup --install-timeout 300

# Update all existing repos
setup-repos setup --pull --skip-install

# Point to a custom config file
setup-repos setup --config ./team-repos.json --target ~/projects
```
