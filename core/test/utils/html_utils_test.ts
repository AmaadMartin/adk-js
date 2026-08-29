/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {extractText} from '../../src/utils/html_utils.js';

describe('extractText', () => {
  it('returns an empty string for an empty document', () => {
    expect(extractText('')).toBe('');
  });

  it('joins the text of separate elements with a newline', () => {
    expect(extractText('<p>first</p><p>second</p>')).toBe('first\nsecond');
  });

  it('trims each run and drops the whitespace-only ones', () => {
    expect(extractText('<p>  padded  </p>\n\n  \n<p>next</p>')).toBe(
      'padded\nnext',
    );
  });

  it('splits a run at every inline element boundary', () => {
    expect(extractText('<p>a <b>bold</b> word</p>')).toBe('a\nbold\nword');
  });

  it('leaves out the contents of script and style elements', () => {
    const html =
      '<style>.a{color:red}</style><script>var x = 1;</script><p>text</p>';

    expect(extractText(html)).toBe('text');
  });

  it('leaves out an unterminated style element that runs to the end', () => {
    expect(extractText('<p>text</p><style>.a{color:red}')).toBe('text');
  });

  it('leaves out comments', () => {
    expect(extractText('<!-- hidden --><p>text</p>')).toBe('text');
  });

  it('keeps text that follows an attribute value containing a bracket', () => {
    expect(extractText('<a title="a > b">visible</a>')).toBe('visible');
  });

  it('decodes named character references beyond the basic set', () => {
    expect(extractText('<p>caf&eacute; &mdash; ok</p>')).toBe('café — ok');
  });

  it('decodes numeric character references', () => {
    expect(extractText('<p>&#8212; and &#x2014;</p>')).toBe('— and —');
  });

  it('decodes a doubly escaped reference only once', () => {
    expect(extractText('<p>&amp;lt;</p>')).toBe('&lt;');
  });

  it('reads the text a template element parks in its content fragment', () => {
    expect(extractText('<template><p>templated</p></template>')).toBe(
      'templated',
    );
  });

  it('reads text that the parser hoists out of an implied body', () => {
    expect(extractText('bare text')).toBe('bare text');
  });
});
