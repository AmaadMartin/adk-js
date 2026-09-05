/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates the JavaScript service classes that the service registry tests
 * declare from a `services.yaml`. The registry imports a declared class at
 * runtime, so the fixture has to be real JavaScript on disk rather than a
 * TypeScript object the test hands over.
 */

import {ServiceType} from '../../src/cli/service_registry.js';

/** The methods each service type's guard requires. */
export const SERVICE_METHODS: Record<ServiceType, readonly string[]> = {
  'session': [
    'createSession',
    'getSession',
    'listSessions',
    'deleteSession',
    'appendEvent',
  ],
  'artifact': [
    'saveArtifact',
    'loadArtifact',
    'listArtifactKeys',
    'deleteArtifact',
    'listVersions',
  ],
  'memory': ['addSessionToMemory', 'searchMemory'],
};

export interface ServiceClassSourceOptions {
  /** Emit `export default` instead of a named export. */
  asDefault?: boolean;
  /** Absolute path the constructor writes its options to, as JSON. */
  recordOptionsTo?: string;
}

/** Builds the source of a JavaScript class that satisfies `type`'s guard. */
export function serviceClassSource(
  className: string,
  type: ServiceType,
  options: ServiceClassSourceOptions = {},
): string {
  const methods = SERVICE_METHODS[type]
    .map((method) => `  async ${method}() {}`)
    .join('\n');
  const imports = options.recordOptionsTo
    ? "import {writeFileSync} from 'node:fs';\n"
    : '';
  const record = options.recordOptionsTo
    ? `    writeFileSync(${JSON.stringify(options.recordOptionsTo)}, JSON.stringify(serviceOptions));\n`
    : '';
  const declaration = options.asDefault
    ? 'export default class'
    : `export class ${className}`;
  return `${imports}${declaration} {
  constructor(serviceOptions) {
${record}    this.serviceOptions = serviceOptions;
  }
${methods}
}
`;
}
