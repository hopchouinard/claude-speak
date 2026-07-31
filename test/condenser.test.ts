import { describe, it, expect } from 'vitest';
import { shouldCondense, heuristicCondense } from '../src/condenser.js';
import { sanitize } from '../src/sanitizer.js';

describe('shouldCondense', () => {
  it('is false for a short plain-prose message', () => {
    expect(shouldCondense('Done. All tests pass.', 500)).toBe(false);
  });

  it('is true when a markdown table is present, however short', () => {
    const raw = 'Done.\n\n| File | Status |\n|---|---|\n| a.ts | ok |\n';
    expect(shouldCondense(raw, 500)).toBe(true);
  });

  it('is true when a fenced code block is present', () => {
    expect(shouldCondense('Run this:\n\n```bash\nnpm test\n```\n', 500)).toBe(true);
  });

  it('is true at five list items', () => {
    const raw = '- one\n- two\n- three\n- four\n- five\n';
    expect(shouldCondense(raw, 500)).toBe(true);
  });

  it('is false at four list items', () => {
    const raw = '- one\n- two\n- three\n- four\n';
    expect(shouldCondense(raw, 500)).toBe(false);
  });

  it('counts numbered list items too', () => {
    const raw = '1. one\n2. two\n3. three\n4. four\n5. five\n';
    expect(shouldCondense(raw, 500)).toBe(true);
  });

  it('is true when sanitized length exceeds maxChars', () => {
    expect(shouldCondense('word '.repeat(200), 500)).toBe(true);
  });

  it('measures length after sanitizing, not before', () => {
    // Bold markers push the RAW length over the threshold while the spoken
    // text stays under it. This must not trigger condensation.
    // raw = (2 + 48 + 2) * 2 + 1 space = 105 chars, over the 100 threshold.
    // sanitized = 48 + 1 + 48 = 97 chars, under it.
    const spoken = 'a'.repeat(48);
    const raw = `**${spoken}** **${spoken}**`;
    expect(raw.length).toBeGreaterThan(100);
    expect(sanitize(raw).length).toBeLessThanOrEqual(100);
    expect(shouldCondense(raw, 100)).toBe(false);
  });
});

describe('heuristicCondense', () => {
  it('drops table blocks entirely', () => {
    const raw = 'Finished.\n\n| File | Status |\n|---|---|\n| a.ts | ok |\n\nAll good.';
    const out = heuristicCondense(raw, 500);
    expect(out).not.toContain('a.ts');
    expect(out).not.toContain('|');
  });

  it('drops fenced code blocks including their contents', () => {
    const raw = 'Run:\n\n```bash\nnpm test --coverage\n```\n\nThen review.';
    const out = heuristicCondense(raw, 500);
    expect(out).not.toContain('npm test');
    expect(out).not.toContain('```');
  });

  it('keeps the first three list items and summarizes the rest', () => {
    const raw = '- one\n- two\n- three\n- four\n- five\n- six\n';
    const out = heuristicCondense(raw, 500);
    expect(out).toContain('one');
    expect(out).toContain('three');
    expect(out).not.toContain('five');
    expect(out).toContain('and 3 more');
  });

  it('does not add a "more" note when there are three or fewer items', () => {
    const out = heuristicCondense('- one\n- two\n', 500);
    expect(out).not.toContain('more');
  });

  it('truncates on a sentence boundary, never mid-word', () => {
    const raw = 'First sentence here. Second sentence here. Third sentence here.';
    const out = heuristicCondense(raw, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toMatch(/\.$/);
    expect(out).toBe('First sentence here.');
  });

  it('falls back to a word boundary when no sentence break fits', () => {
    const out = heuristicCondense('alpha beta gamma delta epsilon zeta', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/\w$/);
  });

  it('keeps the first and last paragraph, dropping the middle', () => {
    const raw = 'Opening line.\n\nMiddle noise here.\n\nClosing line.';
    const out = heuristicCondense(raw, 500);
    expect(out).toContain('Opening line.');
    expect(out).toContain('Closing line.');
    expect(out).not.toContain('Middle noise');
  });

  it('returns an empty string for input that is entirely a table', () => {
    const raw = '| File | Status |\n|---|---|\n| a.ts | ok |\n';
    expect(heuristicCondense(raw, 500).trim()).toBe('');
  });

  // Regression: a list sandwiched between an intro and a closing paragraph
  // used to be treated as "the middle paragraph" and dropped entirely,
  // taking the collapsed "and N more" note with it — destroying the exact
  // structured content that triggered condensation in the first place.
  it('keeps a list paragraph sandwiched between two prose paragraphs', () => {
    const raw =
      "Here's what I did:\n\n- item1\n- item2\n- item3\n- item4\n- item5\n\nLet me know if you have questions.";
    const out = heuristicCondense(raw, 500);
    expect(out).toContain('item1');
    expect(out).toContain('item3');
    expect(out).not.toContain('item5');
    expect(out).toContain('and 2 more');
    expect(out).toContain("Here's what I did:");
    expect(out).toContain('Let me know if you have questions.');
  });

  // Regression: an unclosed code fence used to toggle inFence permanently,
  // silently swallowing everything after it through end of input.
  it('does not swallow trailing content when a code fence is never closed', () => {
    const raw =
      'Intro text.\n\n```\ncode that never closes\nmore code\nImportant trailing sentence that should survive.';
    const out = heuristicCondense(raw, 500);
    expect(out).toContain('Intro text.');
    expect(out).toContain('Important trailing sentence that should survive.');
    expect(out).not.toContain('```');
  });

  // Regression: when the truncation window contained no space at all (one
  // unbroken token), the fallback fell through to a raw slice, cutting
  // mid-word in violation of "never mid-word."
  it('never emits a mid-word cut when the window has no boundary at all', () => {
    const out = heuristicCondense('a'.repeat(60), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/\w$/);
  });
});

// Regression: found by listening to real output, not by any test. truncate()
// treated the "." in a numbered-list marker as a sentence boundary, cut
// immediately after it, and left a bare ordinal that TTS reads as "three".
describe('truncation around list markers', () => {
  const numbered = [
    'Intro sentence that sets things up and runs on for a while to eat budget.',
    '',
    '1. First item with enough text to matter here.',
    '2. Second item, also reasonably long so the cut lands past it.',
    '3. Third item that will be cut off partway through by the character budget.',
  ].join('\n');

  it('does not end on a bare list ordinal', () => {
    const out = heuristicCondense(numbered, 200);
    expect(out).not.toMatch(/\n\s*\d+\.\s*$/);
    expect(out.trimEnd()).not.toMatch(/\b\d+\.$/);
  });

  it('cuts at the previous real sentence end instead', () => {
    const out = heuristicCondense(numbered, 200);
    expect(out).toContain('Second item');
    expect(out).not.toContain('Third item');
  });

  it('still treats a genuine sentence-ending period as a boundary', () => {
    const out = heuristicCondense('One sentence here. Two sentence here. Three here.', 25);
    expect(out).toBe('One sentence here.');
  });

  it('does not strand a bullet marker either', () => {
    const bulleted = [
      'Opening line long enough to consume most of the available budget here.',
      '',
      '- alpha item text',
      '- beta item text that gets cut',
    ].join('\n');
    const out = heuristicCondense(bulleted, 95);
    expect(out).not.toMatch(/\n\s*[-*]\s*$/);
  });

  it('handles a decimal number without treating it as a boundary mid-word', () => {
    const out = heuristicCondense('Version 2.0 shipped today. Then more text followed after.', 30);
    expect(out).toBe('Version 2.0 shipped today.');
  });
});
