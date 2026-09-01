/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolution behaviour of the Claude model provider, translated from
 * adk-python `tests/unittests/models/test_models.py`. Each case names the
 * Python case it comes from.
 *
 * adk-js has no `core/src/models/anthropic_llm.ts` yet. These tests are the
 * contract a port must satisfy, and they fail until it lands.
 *
 * The model ids below are copied verbatim from the Python parametrization,
 * including the ones that look malformed. They exist to pin the family
 * pattern `claude-.*`: adk-python's `_LAZY_PROVIDERS` comment records that
 * enumerating generations left each new model unusable, and that no
 * generation ordering holds, because `claude-opus-4` and `claude-4-opus` are
 * both real ids.
 *
 * One deliberate divergence, in the missing-SDK case. Python registers
 * providers lazily as `(module_path, class_name)`, so `resolve()` drops the
 * `claude-.*` entry when the `anthropic` package will not import, and the
 * "not found" error carries the install instructions. adk-js's registry
 * stores eagerly imported classes, so `Claude` always resolves and only the
 * SDK behind it can be missing. The message therefore moves from `resolve()`
 * to the SDK load. What survives translation is the contract that it names
 * the package and the command that installs it, asserted through
 * `loadOptionalPeer`, the loader every optional peer in this repo goes
 * through.
 */

import {Claude, LLMRegistry} from '@google/adk';
import {ANTHROPIC_SDK} from '@google/adk/models/anthropic_llm.js';
import {loadOptionalPeer} from '@google/adk/utils/optional_peer.js';
import {describe, expect, it} from 'vitest';

const CLAUDE_MODEL_NAMES = [
  'claude-3-5-haiku@20241022',
  'claude-3-5-sonnet-v2@20241022',
  'claude-3-5-sonnet@20240620',
  'claude-3-haiku@20240307',
  'claude-3-opus@20240229',
  'claude-3-sonnet@20240229',
  'claude-sonnet-4@20250514',
  'claude-opus-4@20250514',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-5@default',
  'claude-sonnet-5@default',
  // Anthropic put the generation first at the 4 launch, so these ids matched
  // nothing even though claude-opus-4 did.
  'claude-4-opus-20250514',
  'claude-4-sonnet-20250514',
  // Carries no generation at all.
  'claude-mythos-preview',
  // A generation nobody has added a pattern for yet.
  'claude-opus-6',
];

describe('Claude model resolution', () => {
  // test_match_claude_family
  it.each(CLAUDE_MODEL_NAMES)('resolves %s to Claude', (modelName) => {
    expect(LLMRegistry.resolve(modelName)).toBe(Claude);
  });

  // test_resolve_with_prefix, Claude assertion. The prefix names the class,
  // which overrides pattern matching.
  it('resolves a Claude-prefixed model name to Claude', () => {
    expect(LLMRegistry.resolve('Claude:claude-3-opus@20240229')).toBe(Claude);
  });
});

describe('Claude optional dependency', () => {
  // test_helpful_error_for_claude_without_extensions
  it('names the Anthropic SDK and its install command when it is missing', async () => {
    const notInstalled = new Error(
      "Cannot find package '@anthropic-ai/sdk' imported from /app/index.js",
    ) as Error & {code?: string};
    notInstalled.code = 'ERR_MODULE_NOT_FOUND';

    const load = loadOptionalPeer(ANTHROPIC_SDK, () => {
      throw notInstalled;
    });

    await expect(load).rejects.toThrow(/Claude requires/);
    await expect(load).rejects.toThrow(/npm install @anthropic-ai\/sdk/);
  });
});
