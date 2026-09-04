/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getServiceRegistry} from '@google/adk-devtools';
import {DemoSessionService} from './backend.js';

/** Compiled away rather than erased, so only a transpiler can run this file. */
enum Flavour {
  TypeScript = 'typescript',
}

getServiceRegistry().registerSessionService('demo', async (uri: string) => {
  await Promise.resolve();
  return new DemoSessionService(`${uri}#${Flavour.TypeScript}`);
});
