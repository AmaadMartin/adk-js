/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, isBasePlugin, isBasePluginClass} from '@google/adk';
import {describe, expect, it} from 'vitest';

class GuardTestPlugin extends BasePlugin {}

class DerivedGuardTestPlugin extends GuardTestPlugin {}

describe('isBasePlugin', () => {
  it('accepts a plugin instance', () => {
    expect(isBasePlugin(new GuardTestPlugin('guard'))).toBe(true);
    expect(isBasePlugin(new DerivedGuardTestPlugin('derived'))).toBe(true);
  });

  it('accepts an instance built from another copy of the package', () => {
    // The marker is registered on the global symbol registry, so an object
    // built by a second copy of @google/adk in the same process still passes,
    // where `instanceof` would not.
    const marker = Symbol.for('google.adk.basePlugin');
    expect(isBasePlugin({name: 'foreign', [marker]: true})).toBe(true);
  });

  it.each([
    ['a plugin class', GuardTestPlugin],
    ['a plain object', {name: 'plain'}],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'plugin'],
    ['a plain function', () => undefined],
  ])('rejects %s', (_label, value) => {
    expect(isBasePlugin(value)).toBe(false);
  });
});

describe('isBasePluginClass', () => {
  it('accepts a plugin class and a subclass of one', () => {
    expect(isBasePluginClass(GuardTestPlugin)).toBe(true);
    expect(isBasePluginClass(DerivedGuardTestPlugin)).toBe(true);
    expect(isBasePluginClass(BasePlugin)).toBe(true);
  });

  it('constructs a plugin from the class it accepted', () => {
    const value: unknown = GuardTestPlugin;
    if (!isBasePluginClass(value)) {
      expect.fail('GuardTestPlugin should be recognised as a plugin class');
    }
    expect(new value('constructed').name).toBe('constructed');
  });

  it.each([
    ['a plugin instance', new GuardTestPlugin('guard')],
    ['a plain class', class NotAPlugin {}],
    ['a plain function', () => undefined],
    ['a plain object', {name: 'plain'}],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isBasePluginClass(value)).toBe(false);
  });
});
