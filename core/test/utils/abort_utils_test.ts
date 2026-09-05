/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {chainAbortController} from '../../src/utils/abort_utils.js';

describe('chainAbortController', () => {
  it('returns an independent controller when there is no parent', () => {
    const {controller, dispose} = chainAbortController();
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    dispose();
  });

  it('starts aborted when the parent already is', () => {
    const parent = new AbortController();
    parent.abort();
    const {controller} = chainAbortController(parent.signal);
    expect(controller.signal.aborted).toBe(true);
  });

  it('aborts when the parent aborts later', () => {
    const parent = new AbortController();
    const {controller} = chainAbortController(parent.signal);
    expect(controller.signal.aborted).toBe(false);
    parent.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it('stops following the parent once disposed', () => {
    const parent = new AbortController();
    const {controller, dispose} = chainAbortController(parent.signal);
    dispose();
    parent.abort();
    expect(controller.signal.aborted).toBe(false);
  });
});
