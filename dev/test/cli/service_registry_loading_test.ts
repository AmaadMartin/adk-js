/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers `loadServicesModule` and the `services.yaml` path. adk-python has no
 * tests for either, so these have no reference counterpart. Every case writes
 * real files into a temporary directory and loads them through the real
 * loader; nothing here is mocked except the logger the assertions read.
 */

import {InMemorySessionService} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {
  getServiceRegistry,
  loadServicesModule,
  registerBuiltinServices,
  ServiceRegistry,
} from '../../src/cli/service_registry.js';
import {AdkLogger} from '../../src/utils/logger.js';
import {serviceClassSource} from './service_class_fixture.js';

describe('loadServicesModule', () => {
  let agentsDir: string;
  let registry: ServiceRegistry;
  let warn: MockInstance<AdkLogger['warn']>;

  const write = (name: string, contents: string): string => {
    const target = path.join(agentsDir, name);
    fs.writeFileSync(target, contents);
    return target;
  };

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-services-'));
    registry = new ServiceRegistry();
    registerBuiltinServices(registry);
    warn = vi.spyOn(AdkLogger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(agentsDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  it('registers every service type a services.yaml declares', async () => {
    const recordPath = path.join(agentsDir, 'constructed.json');
    write(
      'demo_session.js',
      serviceClassSource('DemoSessionService', 'session', {
        recordOptionsTo: recordPath,
      }),
    );
    write('demo_artifact.js', serviceClassSource('DemoArtifact', 'artifact'));
    write('demo_memory.js', serviceClassSource('DemoMemory', 'memory'));
    write('demo_tasks.js', serviceClassSource('DemoTasks', 'task_store'));
    write(
      'services.yaml',
      `services:
  - scheme: demosession
    type: session
    class: './demo_session.js#DemoSessionService'
  - scheme: demoartifact
    type: artifact
    class: './demo_artifact.js#DemoArtifact'
  - scheme: demomemory
    type: memory
    class: './demo_memory.js#DemoMemory'
  - scheme: demotasks
    type: task_store
    class: './demo_tasks.js#DemoTasks'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(
      await registry.createSessionService('demosession://host', {agentsDir}),
    ).toBeDefined();
    expect(
      await registry.createArtifactService('demoartifact://x'),
    ).toBeDefined();
    expect(await registry.createMemoryService('demomemory://x')).toBeDefined();
    expect(
      await registry.createTaskStoreService('demotasks://x'),
    ).toBeDefined();
    expect(warn).not.toHaveBeenCalled();

    const recorded: unknown = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
    expect(recorded).toEqual({uri: 'demosession://host', agentsDir});
  });

  it('reads services.yml when services.yaml is absent', async () => {
    write('demo_session.js', serviceClassSource('DemoSession', 'session'));
    write(
      'services.yml',
      `services:
  - scheme: fromyml
    type: session
    class: './demo_session.js#DemoSession'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(await registry.createSessionService('fromyml://x')).toBeDefined();
  });

  it('imports the default export when the class path names no export', async () => {
    write(
      'demo_session.js',
      serviceClassSource('DemoSession', 'session', {asDefault: true}),
    );
    write(
      'services.yaml',
      `services:
  - scheme: defaultexport
    type: session
    class: './demo_session.js'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(
      await registry.createSessionService('defaultexport://x'),
    ).toBeDefined();
  });

  it('imports a class named by an installed package', async () => {
    write(
      'services.yaml',
      `services:
  - scheme: packaged
    type: session
    class: '@google/adk#InMemorySessionService'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(await registry.createSessionService('packaged://x')).toBeInstanceOf(
      InMemorySessionService,
    );
  });

  // A `services.js` file registers on the process-wide singleton, so the two
  // cases below load into it and use a scheme no other test claims.
  it('stops after a services.yaml it cannot load', async () => {
    write('services.yaml', 'services: [unclosed\n');
    write('script_session.js', serviceClassSource('ScriptSession', 'session'));
    write('services.js', servicesScriptSource('stopmarker', 'ScriptSession'));

    await loadServicesModule(agentsDir, getServiceRegistry());

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Failed to load services.yaml',
    );
    expect(
      await getServiceRegistry().createSessionService('stopmarker://x'),
    ).toBeUndefined();
  });

  it('lets services.js replace a scheme services.yaml declared', async () => {
    const yamlRecord = path.join(agentsDir, 'from-yaml.json');
    const scriptRecord = path.join(agentsDir, 'from-script.json');
    write(
      'yaml_session.js',
      serviceClassSource('YamlSession', 'session', {
        recordOptionsTo: yamlRecord,
      }),
    );
    write(
      'script_session.js',
      serviceClassSource('ScriptSession', 'session', {
        recordOptionsTo: scriptRecord,
      }),
    );
    write(
      'services.yaml',
      `services:
  - scheme: overridden
    type: session
    class: './yaml_session.js#YamlSession'
`,
    );
    write('services.js', servicesScriptSource('overridden', 'ScriptSession'));

    await loadServicesModule(agentsDir, getServiceRegistry());
    await getServiceRegistry().createSessionService('overridden://x');

    expect(fs.existsSync(scriptRecord)).toBe(true);
    expect(fs.existsSync(yamlRecord)).toBe(false);
  });

  it('skips a YAML entry with no class and keeps the entries around it', async () => {
    write('demo_session.js', serviceClassSource('DemoSession', 'session'));
    write('demo_memory.js', serviceClassSource('DemoMemory', 'memory'));
    write(
      'services.yaml',
      `services:
  - scheme: good
    type: session
    class: './demo_session.js#DemoSession'
  - scheme: broken
    type: session
  - scheme: alsogood
    type: memory
    class: './demo_memory.js#DemoMemory'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(await registry.createSessionService('good://x')).toBeDefined();
    expect(await registry.createSessionService('broken://x')).toBeUndefined();
    expect(await registry.createMemoryService('alsogood://x')).toBeDefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Invalid service config in YAML',
    );
  });

  it('skips a YAML services entry that is not a mapping', async () => {
    write('services.yaml', 'services:\n  - just-a-string\n');

    await loadServicesModule(agentsDir, registry);

    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Invalid service config in YAML',
    );
  });

  it('reports a services.js that throws a non-Error value', async () => {
    write('services.js', 'throw "boom";\n');

    await loadServicesModule(agentsDir, registry);

    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Failed to load services.js',
    );
    expect(String(warn.mock.calls[0]?.[0])).toContain('boom');
  });

  it('registers nothing for a YAML entry with an unknown type', async () => {
    write('demo_session.js', serviceClassSource('DemoSession', 'session'));
    write(
      'services.yaml',
      `services:
  - scheme: nonsense
    type: nonsense
    class: './demo_session.js#DemoSession'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(await registry.createSessionService('nonsense://x')).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Unknown service type in YAML: nonsense',
    );
  });

  it('ignores a services.yaml with no services list', async () => {
    write('services.yaml', 'unrelated: true\n');

    await loadServicesModule(agentsDir, registry);

    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a class path naming a Node built-in', async () => {
    write(
      'services.yaml',
      `services:
  - scheme: builtin
    type: session
    class: 'node:child_process#execSync'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(await registry.createSessionService('builtin://x')).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'is a Node built-in module',
    );
  });

  it('refuses a class path carrying its own URL scheme', async () => {
    write(
      'services.yaml',
      `services:
  - scheme: inline
    type: session
    class: 'data:text/javascript,export default class {}'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(await registry.createSessionService('inline://x')).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "'data:' module specifiers are not allowed",
    );
  });

  it('refuses a class path whose export is not a class', async () => {
    write('not_a_class.js', 'export const NotAClass = 42;\n');
    write(
      'services.yaml',
      `services:
  - scheme: notaclass
    type: session
    class: './not_a_class.js#NotAClass'
`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(
      await registry.createSessionService('notaclass://x'),
    ).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "export 'NotAClass' is not a class",
    );
  });

  it('rejects a declared class that does not implement its service type', async () => {
    write('demo_memory.js', serviceClassSource('DemoMemory', 'memory'));
    write(
      'services.yaml',
      `services:
  - scheme: mismatched
    type: session
    class: './demo_memory.js#DemoMemory'
`,
    );

    await loadServicesModule(agentsDir, registry);

    await expect(
      registry.createSessionService('mismatched://x'),
    ).rejects.toThrowError(
      "declared for service type 'session' does not implement it",
    );
  });

  it('warns and continues when services.js throws', async () => {
    write('services.js', 'throw new Error("boom");\n');

    await loadServicesModule(agentsDir, registry);

    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Failed to load services.js',
    );
  });

  it('loads a services.mjs', async () => {
    write('script_session.js', serviceClassSource('ScriptSession', 'session'));
    write('services.mjs', servicesScriptSource('frommjs', 'ScriptSession'));

    await loadServicesModule(agentsDir, getServiceRegistry());

    expect(
      await getServiceRegistry().createSessionService('frommjs://x'),
    ).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads a services.cjs', async () => {
    const marker = path.join(agentsDir, 'cjs-ran.txt');
    write(
      'services.cjs',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`,
    );

    await loadServicesModule(agentsDir, registry);

    expect(fs.existsSync(marker)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads a services.ts', async () => {
    write('script_session.js', serviceClassSource('ScriptSession', 'session'));
    write('services.ts', servicesTypeScriptSource('fromts', 'ScriptSession'));

    await loadServicesModule(agentsDir, getServiceRegistry());

    expect(
      await getServiceRegistry().createSessionService('fromts://x'),
    ).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('removes the file it transpiled a services.ts into', async () => {
    write('script_session.js', serviceClassSource('ScriptSession', 'session'));
    write(
      'services.ts',
      servicesTypeScriptSource('cleanedup', 'ScriptSession'),
    );

    await loadServicesModule(agentsDir, getServiceRegistry());

    expect(fs.readdirSync(agentsDir).filter((n) => n.endsWith('.mjs'))).toEqual(
      [],
    );
  });

  it('loads only services.ts when services.js is present too', async () => {
    write('script_session.js', serviceClassSource('ScriptSession', 'session'));
    write('services.ts', servicesTypeScriptSource('winner', 'ScriptSession'));
    write('services.js', servicesScriptSource('loser', 'ScriptSession'));

    await loadServicesModule(agentsDir, getServiceRegistry());

    const singleton = getServiceRegistry();
    expect(await singleton.createSessionService('winner://x')).toBeDefined();
    expect(await singleton.createSessionService('loser://x')).toBeUndefined();
  });

  it('warns when a services.ts does not compile', async () => {
    write('services.ts', 'const broken: = ;\n');

    await loadServicesModule(agentsDir, registry);

    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Failed to load services.ts',
    );
  });

  it('returns quietly when the path is not a directory', async () => {
    const filePath = write('services.yaml', 'services: []\n');

    await expect(
      loadServicesModule(filePath, registry),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns quietly when neither file is present', async () => {
    await expect(
      loadServicesModule(agentsDir, registry),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('getServiceRegistry', () => {
  it('returns one instance that keeps the registrations made through it', async () => {
    const service = new InMemorySessionService();
    const first = getServiceRegistry();
    first.registerSessionService('singleton', () => service);

    const second = getServiceRegistry();

    expect(second).toBe(first);
    expect(await second.createSessionService('singleton://x')).toBe(service);
  });
});

/**
 * Builds the source of a `services.js` that registers `className` for
 * `scheme`, the way a user's file registers a service imperatively.
 */
function servicesScriptSource(scheme: string, className: string): string {
  return `import {getServiceRegistry} from '@google/adk-devtools';
import {${className}} from './script_session.js';

getServiceRegistry().registerSessionService(
  ${JSON.stringify(scheme)},
  (uri, options) => new ${className}({uri, ...options}),
);
`;
}

/**
 * The same script in TypeScript, carrying an `enum`.
 *
 * An `enum` has to be compiled away rather than erased, so this source only
 * runs if esbuild transpiled it. That keeps the test from passing on a Node
 * that happens to strip types on its own.
 */
function servicesTypeScriptSource(scheme: string, className: string): string {
  return `${servicesScriptSource(scheme, className)}
enum Loaded {
  Yes = 'yes',
}
export const loaded: Loaded = Loaded.Yes;
`;
}
