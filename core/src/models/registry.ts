/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';

import {ApigeeLlm} from './apigee_llm.js';
import {BaseLlm} from './base_llm.js';
import {Gemini} from './google_llm.js';

/**
 * type[BaseLlm] equivalent in TypeScript, represents a class that can be new-ed
 * to create a BaseLlm instance.
 */
export type BaseLlmType = (new (params: {model: string}) => BaseLlm) & {
  readonly supportedModels: Array<string | RegExp>;
};

/**
 * A simple LRU cache.
 */
// TODO - b/425992518: consider remove this. model resolution is not frequent.
class LRUCache<K, V> {
  private readonly maxSize: number;
  private cache: Map<K, V>;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.cache = new Map<K, V>();
  }

  get(key: K): V | undefined {
    const item = this.cache.get(key);
    if (item) {
      // Map maintians insertion order.
      this.cache.delete(key);
      this.cache.set(key, item);
    }
    return item;
  }

  set(key: K, value: V): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Splits a `prefix:model` name on the first colon.
 *
 * `openai:gpt-4` gives `{prefix: 'openai', actualModel: 'gpt-4'}`, and a name
 * without a colon gives an empty prefix.
 */
function parseModel(model: string): {prefix: string; actualModel: string} {
  const separator = model.indexOf(':');
  if (separator === -1) {
    return {prefix: '', actualModel: model};
  }
  return {
    prefix: model.slice(0, separator),
    actualModel: model.slice(separator + 1),
  };
}

/**
 * Reports whether a model-name prefix names the given class.
 *
 * The comparison is case-insensitive and ignores one trailing `Llm`, so both
 * `lite` and `LiteLlm` name `LiteLlm`.
 */
function matchPrefix(prefix: string, className: string): boolean {
  const name = className.toLowerCase();
  const prefixLower = prefix.toLowerCase();
  return prefixLower === name || prefixLower === name.replace(/llm$/, '');
}

/**
 * Registry for LLMs.
 */
export class LLMRegistry {
  /**
   * Key is the regex that matches the model name.
   * Value is the class that implements the model.
   */
  private static llmRegistryDict: Map<string | RegExp, BaseLlmType> = new Map();
  private static resolveCache = new LRUCache<string, BaseLlmType>(32);

  /**
   * Creates a new LLM instance.
   *
   * A `prefix:model` name that selects its class by prefix is constructed
   * without the prefix, so `lite:openai/gpt-4o` gives
   * `LiteLlm({model: 'openai/gpt-4o'})`. A prefix that does not name the
   * resolved class stays in the model string.
   *
   * @param model The model name.
   * @returns The LLM instance.
   */
  static newLlm(model: string): BaseLlm {
    const {prefix, actualModel} = parseModel(model);
    const llmClass = LLMRegistry.resolve(model);

    if (prefix && matchPrefix(prefix, llmClass.name)) {
      return new llmClass({model: actualModel});
    }
    return new llmClass({model});
  }

  private static _register(
    modelNameRegex: string | RegExp,
    llmCls: BaseLlmType,
  ) {
    if (LLMRegistry.llmRegistryDict.has(modelNameRegex)) {
      logger.info(
        `Updating LLM class for ${modelNameRegex} from ${LLMRegistry.llmRegistryDict.get(modelNameRegex)} to ${llmCls}`,
      );
    }
    LLMRegistry.llmRegistryDict.set(modelNameRegex, llmCls);
    LLMRegistry.resolveCache.clear();
  }

  /**
   * Registers a new LLM class.
   * @param llmCls The class that implements the model.
   */
  static register<T extends BaseLlm>(
    llmCls: (new (params: {model: string}) => T) & {
      readonly supportedModels: Array<string | RegExp>;
    },
  ) {
    for (const regex of llmCls.supportedModels) {
      LLMRegistry._register(regex, llmCls);
    }
  }

  /**
   * Resolves the model to a BaseLlm subclass.
   *
   * A name shaped `prefix:model` treats the prefix as a class name and skips
   * regex matching. The comparison is case-insensitive and ignores a trailing
   * `Llm`, so `lite:openai/gpt-4o` and `LiteLlm:openai/gpt-4o` both select
   * `LiteLlm`. A prefix that names no registered class is not an error: the
   * full name goes on to regex matching.
   *
   * @param model The model name.
   * @returns The BaseLlm subclass.
   * @throws If the model is not found.
   */
  static resolve(model: string): BaseLlmType {
    const cachedLlm = LLMRegistry.resolveCache.get(model);
    if (cachedLlm) {
      return cachedLlm;
    }

    const {prefix} = parseModel(model);
    if (prefix) {
      for (const llmClass of LLMRegistry.llmRegistryDict.values()) {
        if (matchPrefix(prefix, llmClass.name)) {
          LLMRegistry.resolveCache.set(model, llmClass);
          return llmClass;
        }
      }
    }

    for (const [regex, llmClass] of LLMRegistry.llmRegistryDict.entries()) {
      // Replicates Python's `re.fullmatch` by anchoring the regex
      // to the start (^) and end ($) of the string.
      // TODO - b/425992518: validate it works well.
      const pattern = new RegExp(
        `^${regex instanceof RegExp ? regex.source : regex}$`,
        regex instanceof RegExp ? regex.flags : undefined,
      );
      if (pattern.test(model)) {
        LLMRegistry.resolveCache.set(model, llmClass);
        return llmClass;
      }
    }

    throw new Error(`Model ${model} not found.`);
  }
}

/** Registers default LLM factories, e.g. for Gemini models. */
LLMRegistry.register(Gemini);
LLMRegistry.register(ApigeeLlm);
