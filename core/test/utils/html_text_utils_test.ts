/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {defaultTreeAdapter, parse} from 'parse5';
import {describe, expect, it} from 'vitest';
import {
  boundedTreeAdapter,
  htmlToText,
} from '../../src/utils/html_text_utils.js';

/** The deepest nesting `boundedTreeAdapter` accepts. */
const MAX_PARSE_DEPTH = 256;

/** Parses `html` under a deadline only an explicit limit can beat. */
function parseBounded(html: string, expiresAt = Date.now() + 600_000) {
  const treeAdapter = boundedTreeAdapter(defaultTreeAdapter, expiresAt);
  return parse(html, {treeAdapter});
}

/** Extracts the text of `html`, the way the tool does. */
function extract(html: string): string {
  return htmlToText(parseBounded(html));
}

/** Wraps `text` in `depth` nested `div` elements. */
function nest(depth: number, text: string): string {
  return '<div>'.repeat(depth) + text + '</div>'.repeat(depth);
}

describe('htmlToText', () => {
  it('reads a plain paragraph', () => {
    expect(extract('<p>This page has enough words to keep.</p>')).toBe(
      'This page has enough words to keep.',
    );
  });

  it('puts each text node on its own line', () => {
    expect(extract('<p>first line</p><p>second line</p>')).toBe(
      'first line\nsecond line',
    );
  });

  it('trims each line and drops the whitespace-only ones', () => {
    expect(extract('<div>   </div><p>  padded text here  </p>')).toBe(
      'padded text here',
    );
  });

  it('returns an empty string for a document with no text', () => {
    expect(extract('<html><body><br></body></html>')).toBe('');
  });

  describe('markup a regex cannot read', () => {
    it('keeps text after an attribute value containing >', () => {
      expect(extract('<a title="x > y">link text here now</a>')).toBe(
        'link text here now',
      );
    });

    it('ends a script at the first </script>, as the HTML parser does', () => {
      expect(
        extract('<script>var s = "</script>";</script><p>Body text</p>'),
      ).toBe('";\nBody text');
    });

    it('separates two unclosed paragraphs', () => {
      expect(extract('<p>first paragraph<p>second paragraph')).toBe(
        'first paragraph\nsecond paragraph',
      );
    });

    it('reads cells through an implicit tbody', () => {
      expect(
        extract('<table><tr><td>cell one</td><td>cell two</td></tr></table>'),
      ).toBe('cell one\ncell two');
    });

    it('skips the content of a template', () => {
      expect(
        extract('<template><p>hidden text</p></template><p>visible text</p>'),
      ).toBe('visible text');
    });
  });

  describe('entities', () => {
    it.each([
      ['&amp;', '&'],
      ['&apos;', "'"],
      ['&quot;', '"'],
      ['&lt;', '<'],
      ['&mdash;', '—'],
      ['&#8212;', '—'],
      ['&#x2014;', '—'],
    ])('decodes %s', (entity, decoded) => {
      expect(extract(`<p>a ${entity} b</p>`)).toBe(`a ${decoded} b`);
    });

    it('decodes an escaped entity only once', () => {
      expect(extract('<p>&amp;lt; is a tag</p>')).toBe('&lt; is a tag');
    });

    it('leaves an unknown named entity alone', () => {
      expect(extract('<p>&nope; stays here</p>')).toBe('&nope; stays here');
    });

    it('expands a legacy entity that has no semicolon', () => {
      // `&not` is in the HTML5 legacy list, so `&notanentity;` is `¬` followed
      // by literal text. lxml and BeautifulSoup read it the same way.
      expect(extract('<p>&notanentity; stays</p>')).toBe('¬anentity; stays');
    });
  });

  describe('non-readable content', () => {
    it('omits script, style and comment content', () => {
      const html =
        '<style>.a{color:red}</style>' +
        '<script>var secret = "do not leak this";</script>' +
        '<!-- a comment that should vanish -->' +
        '<p>Fish &amp; chips are quite tasty today</p>';

      expect(extract(html)).toBe('Fish & chips are quite tasty today');
    });

    it('omits a script or style nested inside the body', () => {
      const html =
        '<body><div><style>p{margin:0}</style>' +
        '<script>alert(1)</script><p>kept text</p></div></body>';

      expect(extract(html)).toBe('kept text');
    });

    it('omits the doctype', () => {
      expect(extract('<!DOCTYPE html><p>kept text</p>')).toBe('kept text');
    });
  });
});

describe('boundedTreeAdapter', () => {
  it('builds an ordinary document exactly as the base adapter does', () => {
    const html = '<p>first line</p><table><tr><td>cell text</td></tr></table>';

    expect(htmlToText(parseBounded(html))).toBe(
      htmlToText(parse(html, {treeAdapter: defaultTreeAdapter})),
    );
  });

  it('accepts markup nested up to the depth limit', () => {
    // html > body > 253 divs is 255 elements, and the text node is the 256th.
    const html = nest(MAX_PARSE_DEPTH - 3, 'deep text is still read');

    expect(extract(html)).toBe('deep text is still read');
  });

  it('refuses markup nested past the depth limit', () => {
    expect(() => parseBounded(nest(MAX_PARSE_DEPTH + 1, 'x'))).toThrow(
      `Markup nests deeper than ${MAX_PARSE_DEPTH} elements`,
    );
  });

  it('refuses a nesting bomb quickly instead of parsing it', () => {
    // 40_000 nested elements take about 13 seconds without the limit, on the
    // main thread, so nothing else in the process runs meanwhile.
    const bomb = nest(40_000, 'x');
    const startedAt = Date.now();

    expect(() => parseBounded(bomb)).toThrow(/nests deeper than/);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('stops once the deadline has passed', () => {
    expect(() =>
      parseBounded('<p>anything at all</p>', Date.now() - 1),
    ).toThrow('Request timed out');
  });

  it('reads a document that fits inside the deadline', () => {
    expect(
      htmlToText(parseBounded('<p>read me</p>', Date.now() + 600_000)),
    ).toBe('read me');
  });
});

describe('boundedTreeAdapter with foster parenting', () => {
  // Misnested table content is moved before the table, which is the one path
  // that reaches the adapter's insertBefore.
  const FOSTERED = '<table><div>moved out of the table</div><tr></tr></table>';

  it('reads content the parser moves out of a table', () => {
    expect(extract(FOSTERED)).toBe('moved out of the table');
  });

  it('applies the depth limit to fostered content', () => {
    const deep = `<table>${nest(MAX_PARSE_DEPTH + 1, 'x')}<tr></tr></table>`;

    expect(() => parseBounded(deep)).toThrow(/nests deeper than/);
  });

  it('applies the deadline to fostered content', () => {
    expect(() => parseBounded(FOSTERED, Date.now() - 1)).toThrow(
      'Request timed out',
    );
  });
});
