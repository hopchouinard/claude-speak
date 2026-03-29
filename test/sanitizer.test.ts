import { describe, it, expect } from 'vitest';
import { sanitize } from '../src/sanitizer.js';

describe('sanitize', () => {
  it('strips markdown headers', () => {
    expect(sanitize('## Hello World')).toBe('Hello World');
    expect(sanitize('### Sub heading')).toBe('Sub heading');
  });

  it('strips bold and italic markers', () => {
    expect(sanitize('This is **bold** and *italic*')).toBe('This is bold and italic');
    expect(sanitize('Also __bold__ and _italic_')).toBe('Also bold and italic');
  });

  it('strips code fences', () => {
    const input = 'Before\n```typescript\nconst x = 1;\n```\nAfter';
    expect(sanitize(input)).toBe('Before\nconst x = 1;\nAfter');
  });

  it('strips inline code backticks', () => {
    expect(sanitize('Use the `loadConfig` function')).toBe('Use the loadConfig function');
  });

  it('strips link syntax, keeps display text', () => {
    expect(sanitize('Check [the docs](https://example.com) here')).toBe('Check the docs here');
  });

  it('strips horizontal rules', () => {
    expect(sanitize('Above\n---\nBelow')).toBe('Above\nBelow');
  });

  it('strips bullet markers', () => {
    expect(sanitize('- First item\n- Second item')).toBe('First item\nSecond item');
    expect(sanitize('* First item\n* Second item')).toBe('First item\nSecond item');
  });

  it('strips numbered list prefixes', () => {
    expect(sanitize('1. First\n2. Second\n3. Third')).toBe('First\nSecond\nThird');
  });

  it('strips HTML tags', () => {
    expect(sanitize('Hello <b>world</b>')).toBe('Hello world');
  });

  it('converts markdown tables to natural speech', () => {
    const input = '| File | Status | Notes |\n| --- | --- | --- |\n| app.ts | updated | added error handling |\n| lib.ts | created | new utility |';
    const result = sanitize(input);
    expect(result).toContain('File: app.ts, Status: updated, Notes: added error handling');
    expect(result).toContain('File: lib.ts, Status: created, Notes: new utility');
  });

  it('preserves plain text unchanged', () => {
    expect(sanitize('Just a normal sentence.')).toBe('Just a normal sentence.');
  });

  it('handles empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('strips multiple formatting types in one pass', () => {
    const input = '## **Bold heading**\n\nSome `code` and [a link](http://x.com).\n\n---';
    const result = sanitize(input);
    expect(result).toBe('Bold heading\n\nSome code and a link.\n');
  });
});
