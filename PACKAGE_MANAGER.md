# Package Manager

**This project uses npm.**

There is no `packageManager` field in any `package.json` in this repo, so npm is
not pinned to a specific version by Corepack. The evidence below comes from the
lockfile, the workspace configuration, the root scripts, and CI.

## Primary evidence

### 1. The lockfile is npm's

`package-lock.json` exists at the repo root and is the only lockfile in the
checkout. Its format marks it as npm's:

- `package-lock.json:4` — `"lockfileVersion": 3`

`lockfileVersion: 3` is written by npm v7 and later (npm 9/10 by default). No
`yarn.lock`, `pnpm-lock.yaml`, or `bun.lockb` exists anywhere in the tree, and
there is no `pnpm-workspace.yaml`, `.yarnrc.yml`, or `.npmrc`.

The root scripts treat `package-lock.json` as *the* lockfile to manage:

- `package.json:16` — `"clean:all": "rm package-lock.json && rm -rf ./node_modules && npm run clean:all --workspaces"`
- `package.json:17` — `"rebuild": "npm run clean:all && npm install && npm run build"`

### 2. Workspaces are declared the npm way

- `package.json:38-42` — `"workspaces": ["core", "dev", "integrations"]`

The workspace list lives in `package.json` rather than in a
`pnpm-workspace.yaml`, and the root scripts drive it with npm's
`--workspaces` flag, which is npm-specific (yarn and pnpm use
`workspaces foreach` and `-r` respectively):

- `package.json:13` — `"build": "npm run build --workspaces"`
- `package.json:15` — `"clean": "npm run clean --workspaces"`

The three workspace packages are `@google/adk` (`core`),
`@google/adk-devtools` (`dev`), and `@google/adk-integrations`
(`integrations`).

### 3. CI installs with npm

- `.github/workflows/validation.yaml:36` — `run: npm install`
- `.github/workflows/cross-language-integration.yml:26` — `run: npm install`

### 4. Contributor docs say npm

- `CONTRIBUTING.md:21` — `npm install`
- `CONTRIBUTING.md:27-28` — `npm run build`, `npm test`
- `CONTRIBUTING.md:38` / `CONTRIBUTING.md:44` / `CONTRIBUTING.md:50` — `npm run lint`, `npm run lint:fix`, `npm run format`

## One thing that is not counter-evidence

`README.md:62-66` shows `yarn add @google/adk`. That is installation guidance
for *consumers* of the published packages, offered alongside the
`npm install @google/adk` snippet at `README.md:58-59`. It says nothing about
how this repository itself is developed, and no yarn lockfile or yarn config is
present.

## Runtime note

- `README.md:55` — "ADK for TypeScript requires Node.js 20.19 or newer."

No `engines` field is declared in any `package.json`, so this requirement is
documentation only and is not enforced at install time.
