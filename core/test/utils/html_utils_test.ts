/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {htmlToText} from '../../src/utils/html_utils.js';

describe('htmlToText', () => {
  it('joins text nodes with newlines in document order', () => {
    const html =
      '<html><body><h1>Title</h1><p>First</p><p>Second</p></body></html>';

    expect(htmlToText(html)).toBe('Title\nFirst\nSecond');
  });

  it('trims each text node and drops the whitespace-only ones', () => {
    const html = '<div>  padded  </div>\n  \n<div>\t</div><div>kept</div>';

    expect(htmlToText(html)).toBe('padded\nkept');
  });

  it.each([
    ['&amp;', 'Fish &amp; chips', 'Fish & chips'],
    ['&#39;', 'it&#39;s here', "it's here"],
    ['&lt;', 'a &lt; b', 'a < b'],
  ])('decodes the %s character reference', (_name, source, expected) => {
    expect(htmlToText(`<p>${source}</p>`)).toBe(expected);
  });

  it('decodes &nbsp; to a no-break space', () => {
    expect(htmlToText('<p>one&nbsp;two</p>')).toBe('one\u00a0two');
  });

  it.each(['script', 'style', 'noscript'])(
    'excludes the contents of <%s>',
    (tag) => {
      const html = `<body><${tag}>hidden</${tag}><p>shown</p></body>`;

      expect(htmlToText(html)).toBe('shown');
    },
  );

  it('excludes comments', () => {
    expect(htmlToText('<p>shown</p><!-- hidden -->')).toBe('shown');
  });

  it('does not mistake a > inside an attribute for the end of the tag', () => {
    const html = '<a href="/x" title="1 > 2">Link text with several words</a>';

    expect(htmlToText(html)).toBe('Link text with several words');
  });

  it('recovers the text of an unclosed tag', () => {
    expect(htmlToText('<p>first<p>second')).toBe('first\nsecond');
  });

  it('recovers the text of mis-nested tags', () => {
    expect(htmlToText('<b><i>bold italic</b> italic</i>')).toBe(
      'bold italic\nitalic',
    );
  });

  it('returns an empty string for an empty document', () => {
    expect(htmlToText('')).toBe('');
  });

  it('returns an empty string for a document with no text', () => {
    expect(htmlToText('<html><body><br><img src="x.png"></body></html>')).toBe(
      '',
    );
  });
});
