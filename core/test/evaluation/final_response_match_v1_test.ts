/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  calculateRouge1Scores,
  defaultTokenize,
  EvalStatus,
  type Invocation,
  InvocationSchema,
  isCjk,
  isNonSpacedScript,
  isWordChar,
  PrebuiltMetrics,
  RougeEvaluator,
  UnicodeAwareTokenizer,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const QUERY = {parts: [{text: 'This is a test query.'}]};

function testInvocations(
  candidate: string,
  reference: string,
): [Invocation, Invocation] {
  return [
    InvocationSchema.parse({
      userContent: QUERY,
      finalResponse: {parts: [{text: candidate}]},
    }),
    InvocationSchema.parse({
      userContent: QUERY,
      finalResponse: {parts: [{text: reference}]},
    }),
  ];
}

function rougeEvaluator(threshold: number): RougeEvaluator {
  return new RougeEvaluator({
    metricName: PrebuiltMetrics.RESPONSE_MATCH_SCORE,
    threshold,
  });
}

describe('evaluation/final_response_match_v1', () => {
  describe('calculateRouge1Scores', () => {
    it('scores 0 for empty candidate and reference', () => {
      const score = calculateRouge1Scores('', '');
      expect(score.precision).toBe(0);
      expect(score.recall).toBe(0);
      expect(score.fmeasure).toBe(0);
    });

    it('scores 0 for an empty candidate', () => {
      const score = calculateRouge1Scores('', 'This is a test reference.');
      expect(score.precision).toBe(0);
      expect(score.recall).toBe(0);
      expect(score.fmeasure).toBe(0);
    });

    it('scores 0 for an empty reference', () => {
      const score = calculateRouge1Scores(
        'This is a test candidate response.',
        '',
      );
      expect(score.precision).toBe(0);
      expect(score.recall).toBe(0);
      expect(score.fmeasure).toBe(0);
    });

    it('computes precision, recall, and fmeasure', () => {
      const score = calculateRouge1Scores(
        'This is a test candidate response.',
        'This is a test reference.',
      );
      expect(score.precision).toBeCloseTo(2 / 3, 10);
      expect(score.recall).toBeCloseTo(4 / 5, 10);
      expect(score.fmeasure).toBeCloseTo(8 / 11, 10);
    });

    it.each([
      'สวัสดี', // Thai
      '你好世界', // Chinese
      'مرحبا بالعالم', // Arabic
      'こんにちは', // Japanese
      'Здравствуйте', // Russian
    ])('scores 1 for identical non-English text %s', (text) => {
      const score = calculateRouge1Scores(text, text);
      expect(score.precision).toBeCloseTo(1, 10);
      expect(score.recall).toBeCloseTo(1, 10);
      expect(score.fmeasure).toBeCloseTo(1, 10);
    });

    it('scores different non-English text', () => {
      const score = calculateRouge1Scores('мир привет', 'привет только');
      expect(score.precision).toBeCloseTo(1 / 2, 10);
      expect(score.recall).toBeCloseTo(1 / 2, 10);
      expect(score.fmeasure).toBeCloseTo(1 / 2, 10);
    });

    it('scores CJK partial overlap and inversion by character', () => {
      const score = calculateRouge1Scores('天气很好今天', '今天天气很好');
      expect(score.precision).toBeCloseTo(1.0, 10);
      expect(score.recall).toBeCloseTo(1.0, 10);
      expect(score.fmeasure).toBeCloseTo(1.0, 10);
    });

    it('scores mixed-language text', () => {
      const score = calculateRouge1Scores('hello สวัสดี', 'hello world');
      expect(score.precision).toBeCloseTo(1 / 5, 10);
      expect(score.recall).toBeCloseTo(1 / 2, 10);
      expect(score.fmeasure).toBeCloseTo(2 / 7, 10);
    });
  });

  describe('UnicodeAwareTokenizer combining marks', () => {
    it('keeps a Thai combining mark attached to its base character', () => {
      const tokenizer = new UnicodeAwareTokenizer();
      const thaiVowelMark = [...'ดี'][1];
      expect(isWordChar(thaiVowelMark)).toBe(true);
      const tokens = tokenizer.tokenize('ดี');
      expect(tokens).toEqual(['ดี']);
    });

    it('keeps Devanagari combining marks attached', () => {
      const tokenizer = new UnicodeAwareTokenizer();
      expect(tokenizer.tokenize('नमस्ते')).toEqual(['नमस्ते']);
    });
  });

  describe('UnicodeAwareTokenizer branch coverage', () => {
    it.each<[string, boolean, string[]]>([
      ['hello สวัสดี', true, ['hello', 'ส', 'วั', 'ส', 'ดี']],
      ['中文测试', false, ['中', '文', '测', '试']],
      ['今天天气很好', false, ['今', '天', '天', '气', '很', '好']],
      ['ひらがな', false, ['ひ', 'ら', 'が', 'な']],
      ['こんにちは', false, ['こ', 'ん', 'に', 'ち', 'は']],
      ['カタカナ', false, ['カ', 'タ', 'カ', 'ナ']],
      ['한글', false, ['한', '글']],
      ['ดี', false, ['ดี']],
      ['ฉันรักคุณมาก', false, ['ฉั', 'น', 'รั', 'ก', 'คุ', 'ณ', 'ม', 'า', 'ก']],
      ['ດີ', false, ['ດີ']],
      ['ល្អ', false, ['ល្', 'អ']],
      ['မင်္ဂလာ', false, ['မ', 'င်္', 'ဂ', 'လာ']],
      ['Running jumped 123', true, ['run', 'jump', '123']],
      ['Running jumped 123', false, ['running', 'jumped', '123']],
      ['مَرْحَبًا', false, ['مَرْحَبًا']],
      ['नमस्ते', false, ['नमस्ते']],
      ['Hello World! Привет мир', true, ['hello', 'world', 'привет', 'мир']],
      ['hello, world! @123 #test', true, ['hello', 'world', '123', 'test']],
    ])('tokenizes %s (stemmer=%s)', (input, useStemmer, expected) => {
      const tokenizer = new UnicodeAwareTokenizer(useStemmer);
      expect(tokenizer.tokenize(input)).toEqual(expected);
    });
  });

  describe('script helpers', () => {
    it.each<[string, boolean]>([
      ['中', true],
      ['ぁ', true],
      ['ァ', true],
      ['한', true],
      ['a', false],
      ['1', false],
      ['ส', false],
      ['', false],
    ])('isCjk(%s) === %s', (char, expected) => {
      expect(isCjk(char)).toBe(expected);
    });

    it.each<[string, boolean]>([
      ['ส', true],
      ['ກ', true],
      ['ក', true],
      ['က', true],
      ['中', false],
      ['a', false],
      ['', false],
    ])('isNonSpacedScript(%s) === %s', (char, expected) => {
      expect(isNonSpacedScript(char)).toBe(expected);
    });

    it.each<[string, boolean]>([
      ['a', true],
      ['9', true],
      ['中', true],
      ['ส', true],
      [[...'ดี'][1], true],
      [' ', false],
      ['!', false],
    ])('isWordChar(%s) === %s', (char, expected) => {
      expect(isWordChar(char)).toBe(expected);
    });
  });

  describe('ASCII parity with the default tokenizer', () => {
    it.each([
      'The quick brown fox jumps over the lazy dog.',
      "Testing stemmed words like running and jumped, don't split!",
      'Numbers 123 and mixed a1b2 tokens under_scored.',
      '',
    ])('tokenizes %s the same as the default tokenizer', (text) => {
      expect(new UnicodeAwareTokenizer(true).tokenize(text)).toEqual(
        defaultTokenize(text, true),
      );
    });
  });

  describe('RougeEvaluator', () => {
    it.each<[string[], string[], number, EvalStatus]>([
      [
        ['The quick brown fox jumps.', 'hello world'],
        ['The quick brown fox jumps over the lazy dog.', 'hello'],
        0.69048,
        EvalStatus.FAILED,
      ],
      [
        ['This is a test.', 'Another test case.'],
        ['This is a test.', 'This is a different test.'],
        0.625,
        EvalStatus.FAILED,
      ],
      [
        ['No matching words here.', 'Second candidate.'],
        ['Completely different text.', 'Another reference.'],
        0.0,
        EvalStatus.FAILED,
      ],
      [
        ['Same words', 'Same words'],
        ['Same words', 'Same words'],
        1.0,
        EvalStatus.PASSED,
      ],
      [['สวัสดี', '你好'], ['สวัสดี', '你好'], 1.0, EvalStatus.PASSED],
      [
        ['今天天气不错', '我想吃炒饭'],
        ['今天天气很好', '我想吃面条'],
        0.63333,
        EvalStatus.FAILED,
      ],
      [
        ['สวัสดีครับ', 'ฉันชอบกินข้าวผัด'],
        ['สวัสดีค่ะ', 'ฉันชอบกินก๋วยเตี๋ยว'],
        0.61538,
        EvalStatus.FAILED,
      ],
      [['你好世界', '人工智能'], ['再见', '机器学习'], 0.0, EvalStatus.FAILED],
    ])(
      'scores multiple invocations',
      (candidates, references, expectedScore, expectedStatus) => {
        const actual: Invocation[] = [];
        const expected: Invocation[] = [];
        for (let i = 0; i < candidates.length; i++) {
          const [a, e] = testInvocations(candidates[i], references[i]);
          actual.push(a);
          expected.push(e);
        }
        const result = rougeEvaluator(0.8).evaluateInvocations(
          actual,
          expected,
        );
        expect(result.overallScore).toBeCloseTo(expectedScore, 4);
        expect(result.overallEvalStatus).toBe(expectedStatus);
      },
    );

    it('returns NOT_EVALUATED for no invocations', () => {
      const result = rougeEvaluator(0.8).evaluateInvocations([], []);
      expect(result.overallScore).toBeUndefined();
      expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
      expect(result.perInvocationResults).toHaveLength(0);
    });

    it('treats a missing final response as empty text', () => {
      const actual = InvocationSchema.parse({userContent: QUERY});
      const [, expected] = testInvocations('', 'Some reference text.');
      const result = rougeEvaluator(0.8).evaluateInvocations(
        [actual],
        [expected],
      );
      expect(result.overallScore).toBe(0);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('joins multiple text parts of the final response', () => {
      const actual = InvocationSchema.parse({
        userContent: QUERY,
        finalResponse: {
          parts: [{text: 'same'}, {inlineData: {}}, {text: 'words'}],
        },
      });
      const expected = InvocationSchema.parse({
        userContent: QUERY,
        finalResponse: {parts: [{text: 'same'}, {text: 'words'}]},
      });
      const result = rougeEvaluator(0.8).evaluateInvocations(
        [actual],
        [expected],
      );
      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('throws when expected invocations are missing', () => {
      const [actual] = testInvocations('same', 'same');
      expect(() => rougeEvaluator(0.8).evaluateInvocations([actual])).toThrow(
        'expected_invocations is required for this metric.',
      );
    });

    it.each<[number, number]>([
      [2, 1],
      [1, 2],
    ])(
      'rejects mismatched invocation lengths (%i vs %i)',
      (actualCount, expectedCount) => {
        const [actual, expected] = testInvocations('same', 'same');
        expect(() =>
          rougeEvaluator(0.8).evaluateInvocations(
            Array<Invocation>(actualCount).fill(actual),
            Array<Invocation>(expectedCount).fill(expected),
          ),
        ).toThrow(`same length; got ${actualCount} and ${expectedCount}`);
      },
    );
  });
});
