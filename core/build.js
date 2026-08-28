/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {cp, writeFile} from 'node:fs/promises';
import {basename} from 'node:path';

const platformBuildTargets = {
  'node': ['node10.4'],
  'browser': ['chrome58', 'firefox57', 'safari11'],
};

const SKILL_ASSET_DIR = 'tools/bigquery/skills';

const licenseHeaderText = `/**
  * @license
  * Copyright 2026 Google LLC
  * SPDX-License-Identifier: Apache-2.0
  */
`;

/**
 * Builds the ADK core library with the given options.
 *
 * @param {{
 *   targetDir: string,
 *   platform: string,
 *   format: string,
 *   bundle: boolean,
 *   watch: boolean,
 *   entry: string
 * }} options - The build options.
 * @return {!Promise} A promise that resolves when the build is complete.
 */
function build({
  targetDir,
  platform,
  format,
  bundle,
  watch,
  entry = 'index.ts',
}) {
  const buildOptions = {
    target: platformBuildTargets[platform],
    platform,
    format,
    bundle,
    minify: bundle,
    // Minification renames classes, and we report those names at runtime:
    // `@experimental` logs `target.name`, which otherwise reads "Class oR is
    // experimental". User code that logs `constructor.name` sees the same
    // mangling, so keep the original names in the bundle.
    keepNames: true,
    sourcemap: bundle,
    packages: 'external',
    logLevel: 'info',
  };

  if (platform === 'browser' && bundle) {
    buildOptions.alias = {
      'node:async_hooks': './src/utils/async_hooks_shim.ts',
      'node:crypto': './src/utils/crypto_shim.ts',
    };
  }

  // Prepend license header to the top of the file
  if (format === 'cjs' || bundle) {
    buildOptions.banner = {js: licenseHeaderText};
  }

  if (bundle) {
    buildOptions.entryPoints = [`./src/${entry}`];
    buildOptions.outfile = `./dist/${targetDir}/index.js`;
  } else {
    buildOptions.entryPoints = ['./src/**/*.ts'];
    buildOptions.outdir = `./dist/${targetDir}`;
  }

  if (format === 'esm') {
    buildOptions.banner = {
      js:
        (buildOptions.banner?.js || '') +
        `import {createRequire as topLevelCreateRequire} from 'module';\nconst require = topLevelCreateRequire(import.meta.url);`,
    };
  }

  return watch
    ? esbuild.context(buildOptions).then((c) => c.watch())
    : esbuild.build(buildOptions);
}

/**
 * Copies the markdown that packaged skills are made of into the Node outputs.
 *
 * esbuild emits only the TypeScript sources, and `files` in package.json
 * publishes `dist`, so an asset that is not copied here never reaches an
 * installed package. A skill loads from a directory beside its own module, so
 * the destination follows the layout the build emits: a bundled build collapses
 * every module into `./dist/<format>/index.js`, which puts the skill at the
 * format root. The browser output is skipped: reading a skill needs `node:fs`.
 *
 * @param {!Array<string>} targetDirs - Format directories under `./dist`.
 * @param {boolean} bundle - Whether the build emits one file per format.
 * @return {!Promise} A promise that resolves when every asset is copied.
 */
function copySkillAssets(targetDirs, bundle) {
  const destDir = bundle ? basename(SKILL_ASSET_DIR) : SKILL_ASSET_DIR;
  return Promise.all(
    targetDirs.map((targetDir) =>
      cp(`./src/${SKILL_ASSET_DIR}`, `./dist/${targetDir}/${destDir}`, {
        recursive: true,
      }),
    ),
  );
}

/**
 * The main function that builds the ADK core library.
 */
async function main() {
  const bundle = process.argv.includes('--bundle');
  const watch = process.argv.includes('--watch');

  if (watch) {
    build({
      targetDir: 'esm',
      platform: 'node',
      format: 'esm',
      bundle,
      watch: true,
    });
    await copySkillAssets(['esm'], bundle);
  } else {
    await Promise.all([
      build({targetDir: 'esm', platform: 'node', format: 'esm', bundle}),
      build({targetDir: 'cjs', platform: 'node', format: 'cjs', bundle}),
      build({
        targetDir: 'web',
        platform: 'browser',
        format: 'esm',
        entry: 'index_web.ts',
        bundle,
      }),
    ]);

    await copySkillAssets(['esm', 'cjs'], bundle);

    // Create package.json for cjs to ensure Node.js treats it as commonjs.
    await writeFile('./dist/cjs/package.json', '{"type": "commonjs"}');
  }
}

main();
