# Multi Repo Setup CLI

Clone and install 14 TypeScript repositories into one local workspace.

## Use As A Custom Command

Build it once:

```bash
npm install
npm run build
```

Install the command globally on your machine while developing:

```bash
npm link
```

Now you can run this from any folder:

```bash
setup-repos --target ./workspace
```

You do not need to keep opening this CLI repo every time after it is installed globally.

## Sharing With Everyone

You have two good options.

Publish this package to npm, GitHub Packages, or your company registry. Then teammates install it with:

```bash
npm install -g multi-repo-setup-cli
setup-repos --target ./workspace
```

Or put this CLI in a GitHub repo and let teammates install it directly:

```bash
npm install -g git+ssh://git@github.com/your-org/multi-repo-setup-cli.git
setup-repos --target ./workspace
```

For a team-wide command with no config file, replace the placeholder URLs in `src/default-repos.ts`, build, and publish/share the package.

For per-user config, generate a config file:

```bash
setup-repos init
```

Then edit `repos.json`.

## Run Locally Without Global Install

```bash
npm run setup -- --target ./workspace
```

This creates:

```txt
workspace/
  repo-01/
  repo-02/
  ...
  repo-14/
```

## Options

```bash
setup-repos --target ./workspace --config ./repos.json --concurrency 3
```

- `--target`: folder where all repositories will be cloned. Defaults to `./workspace`.
- `--config`: repo config file. Defaults to `./repos.json`. If missing, the embedded defaults are used.
- `--concurrency`: number of repos to process at once. Defaults to `3`.
- `--package-manager`: install command to run. Defaults to `npm`.
- `--pull`: run `git pull` in repositories that already exist.
- `--skip-install`: clone/pull only, without installing dependencies.

After building, you can also run the compiled CLI:

```bash
npm run build
npm start -- setup --target ./workspace
```
