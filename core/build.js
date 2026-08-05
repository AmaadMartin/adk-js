/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import esbuild from 'esbuild';
import {readdir, writeFile} from 'node:fs/promises';
import {sep} from 'node:path';

const platformBuildTargets = {
  'node': ['node10.4'],
  'browser': ['chrome58', 'firefox57', 'safari11'],
};

/**
 * Source modules the browser build must not emit. `dist/web` is transpile-only
 * - every module in `src` is compiled on its own and its import specifiers are
 * passed through verbatim - so emitting the Node entry point or a Node-only
 * implementation would put `winston` into the published browser artifact even
 * though nothing reachable from `index_web.ts` imports them.
 */
const NODE_ONLY_SOURCE = /^\.\/src\/index\.ts$|_node\.ts$/;

/**
 * Lists the entry points for a transpile-only (non-bundled) build.
 *
 * @param {string} platform - The esbuild platform.
 * @return {!Promise<!Array<string>>} The entry points to compile.
 */
async function transpileEntryPoints(platform) {
  if (platform !== 'browser') {
    return ['./src/**/*.ts'];
  }

  const names = await readdir('./src', {recursive: true});
  return names
    .map((name) => `./src/${name.split(sep).join('/')}`)
    .filter((file) => file.endsWith('.ts') && !NODE_ONLY_SOURCE.test(file));
}

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
async function build({
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
    sourcemap: bundle,
    packages: 'external',
    logLevel: 'info',
  };

  if (platform === 'browser' && bundle) {
    buildOptions.alias = {
      'node:async_hooks': './src/utils/async_hooks_shim.ts',
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
    buildOptions.entryPoints = await transpileEntryPoints(platform);
    // Pinned so that excluding a source file cannot shift the emitted layout:
    // esbuild otherwise derives the output root from the entry points.
    buildOptions.outbase = './src';
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

    // Create package.json for cjs to ensure Node.js treats it as commonjs.
    await writeFile('./dist/cjs/package.json', '{"type": "commonjs"}');
  }
}

main();
