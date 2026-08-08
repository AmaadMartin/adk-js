/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  A2AStreamEventData,
  A2aUserBuilder,
  AfterA2ARequestCallback,
  AfterEventCallback,
  AfterExecuteCallback,
  AgentExecutorConfig,
  BeforeA2ARequestCallback,
  BeforeExecuteCallback,
  ExecutorContext,
  RemoteA2AAgentConfig,
  RunnerOrRunnerConfig,
  ToA2aOptions,
} from '@google/adk/a2a';
import type {OTelHooks, OtelExportersConfig} from '@google/adk/telemetry';
import type {
  MCPConnectionParams,
  StdioConnectionParams,
  StreamableHTTPConnectionParams,
} from '@google/adk/tools/mcp';
import {existsSync, readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

/** The conditions every subpath entry declares, in the order it declares them. */
const CONDITION_ORDER = ['types', 'import', 'require', 'default'] as const;

type SubpathConditions = Record<(typeof CONDITION_ORDER)[number], string>;

/** The fields of `core/package.json` this suite reads. */
interface CoreManifest {
  exports: Record<string, SubpathConditions>;
  typesVersions: Record<string, Record<string, string[]>>;
}

/** The directory prefix each condition's target must live under. */
const TARGET_PREFIX: SubpathConditions = {
  types: './dist/types/',
  import: './dist/esm/',
  require: './dist/cjs/',
  default: './dist/esm/',
};

const CORE_DIR = new URL('../', import.meta.url);

const manifest: CoreManifest = JSON.parse(
  readFileSync(new URL('package.json', CORE_DIR), 'utf8'),
);

const subpathEntries = Object.entries(manifest.exports).filter(
  ([subpath]) => subpath !== '.',
);

/** Maps a published `dist` target back to the `core/src` file it is built from. */
function sourceOf(target: string): string {
  return target
    .replace(/^\.\/dist\/(?:cjs|esm|types)\//, './src/')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js$/, '.ts');
}

/** The exported names of a module namespace, keyed by name. */
function exportsOf(namespace: object): Map<string, unknown> {
  return new Map(Object.entries(namespace));
}

/**
 * Compile-time surface checks: `npm run ts:check` fails if one of these type
 * names stops being reachable through its subpath.
 */
type _A2aTypeSurface = [
  A2AStreamEventData,
  A2aUserBuilder,
  AfterA2ARequestCallback,
  AfterEventCallback,
  AfterExecuteCallback,
  AgentExecutorConfig,
  BeforeA2ARequestCallback,
  BeforeExecuteCallback,
  ExecutorContext,
  RemoteA2AAgentConfig,
  RunnerOrRunnerConfig,
  ToA2aOptions,
];
type _TelemetryTypeSurface = [OTelHooks, OtelExportersConfig];
type _McpTypeSurface = [
  MCPConnectionParams,
  StdioConnectionParams,
  StreamableHTTPConnectionParams,
];

describe('core package exports map', () => {
  it('declares at least one subpath besides the root', () => {
    expect(subpathEntries.length).toBeGreaterThan(0);
  });

  it('gives every subpath the same conditions as the root, in the same order', () => {
    for (const [subpath, conditions] of subpathEntries) {
      expect(Object.keys(conditions), subpath).toEqual([...CONDITION_ORDER]);
      expect(conditions.default, subpath).toBe(conditions.import);
      for (const condition of CONDITION_ORDER) {
        expect(conditions[condition], `${subpath} ${condition}`).toMatch(
          new RegExp(`^${TARGET_PREFIX[condition]}`),
        );
      }
    }
  });

  it('points every subpath target at a file that exists in core/src', () => {
    for (const [subpath, conditions] of subpathEntries) {
      for (const condition of CONDITION_ORDER) {
        const source = sourceOf(conditions[condition]);
        expect(
          existsSync(new URL(source, CORE_DIR)),
          `${subpath} ${condition} -> ${source}`,
        ).toBe(true);
      }
    }
  });
});

describe('core package typesVersions', () => {
  const legacyPaths = manifest.typesVersions['*'];

  it('covers exactly the subpaths the exports map declares', () => {
    expect(Object.keys(manifest.typesVersions)).toEqual(['*']);
    expect(Object.keys(legacyPaths).sort()).toEqual(
      subpathEntries.map(([subpath]) => subpath.slice('./'.length)).sort(),
    );
  });

  it('resolves each subpath to the same declaration file as the exports map', () => {
    for (const [subpath, conditions] of subpathEntries) {
      expect(legacyPaths[subpath.slice('./'.length)], subpath).toEqual([
        conditions.types,
      ]);
    }
  });

  it('leaves the root import to the typings field', () => {
    expect(Object.keys(legacyPaths)).not.toContain('*');
  });
});

describe('subpath barrels', () => {
  it('exports exactly the intended names', async () => {
    expect(Object.keys(await import('@google/adk/a2a')).sort()).toEqual([
      'A2AAgentExecutor',
      'AGENT_CARD_PATH',
      'RemoteA2AAgent',
      'bearerTokenUserBuilder',
      'getA2AAgentCard',
      'toA2a',
    ]);
    expect(Object.keys(await import('@google/adk/telemetry')).sort()).toEqual([
      'getGcpExporters',
      'getGcpResource',
      'maybeSetOtelProviders',
    ]);
    expect(Object.keys(await import('@google/adk/tools/mcp')).sort()).toEqual([
      'LoadMcpResourceTool',
      'MCPSessionManager',
      'MCPTool',
      'MCPToolset',
    ]);
  });

  it('resolves to the same objects the root barrel exports', async () => {
    const root = exportsOf(await import('@google/adk'));
    const namespaces = {
      common: await import('@google/adk/common'),
      a2a: await import('@google/adk/a2a'),
      telemetry: await import('@google/adk/telemetry'),
      'tools/mcp': await import('@google/adk/tools/mcp'),
    };

    for (const [subpath, namespace] of Object.entries(namespaces)) {
      for (const [name, value] of exportsOf(namespace)) {
        expect(root.get(name), `${subpath} ${name}`).toBe(value);
      }
    }
  });
});

describe('root barrel', () => {
  /** One name per subsystem the subpaths carve out, plus the two registries. */
  const SENTINELS = [
    'AgentRegistry',
    'DatabaseSessionService',
    'GcsArtifactService',
    'InMemorySessionService',
    'LlmAgent',
    'MCPToolset',
    'Runner',
    'getArtifactServiceFromUri',
    'getSessionServiceFromUri',
    'maybeSetOtelProviders',
    'toA2a',
  ];

  it('still exports every subsystem entry point', async () => {
    const root = exportsOf(await import('@google/adk'));
    expect(SENTINELS.filter((name) => !root.has(name))).toEqual([]);
  });
});
