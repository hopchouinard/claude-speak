import { sanitize } from './sanitizer.js';

const TABLE_SEPARATOR = /^\|?\s*[-:]+\s*\|/;
const LIST_ITEM = /^\s*(?:[-*]\s+|\d+\.\s+)/;

function hasTable(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('|') && TABLE_SEPARATOR.test(lines[i + 1])) return true;
  }
  return false;
}

function hasCodeFence(text: string): boolean {
  return /^```/m.test(text);
}

function countListItems(text: string): number {
  return text.split('\n').filter((line) => LIST_ITEM.test(line)).length;
}

/**
 * Structured content always triggers condensation regardless of length: a
 * three-line message containing a table is the core problem case. Plain prose
 * gets the maxChars allowance, measured after sanitizing so that markdown
 * syntax does not count against the spoken budget.
 */
export function shouldCondense(raw: string, maxChars: number): boolean {
  if (!raw) return false;
  if (hasTable(raw)) return true;
  if (hasCodeFence(raw)) return true;
  if (countListItems(raw) >= 5) return true;
  return sanitize(raw).length > maxChars;
}

function stripCodeFences(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

function stripTables(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const isTableStart =
      lines[i].includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]);
    if (isTableStart) {
      i += 2;
      while (i < lines.length && lines[i].includes('|')) i++;
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return kept.join('\n');
}

function collapseLists(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!LIST_ITEM.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const items: string[] = [];
    while (i < lines.length && LIST_ITEM.test(lines[i])) {
      items.push(lines[i]);
      i++;
    }
    out.push(...items.slice(0, 3));
    if (items.length > 3) out.push(`and ${items.length - 3} more`);
  }
  return out.join('\n');
}

function keepFirstAndLastParagraph(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length <= 2) return paragraphs.join('\n\n');
  return [paragraphs[0], paragraphs[paragraphs.length - 1]].join('\n\n');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const window = text.slice(0, maxChars);

  const lastSentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.endsWith('.') ? window.length - 1 : -1,
  );
  if (lastSentence > 0) return window.slice(0, lastSentence + 1).trim();

  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) return window.slice(0, lastSpace).trim() + ' ';

  return window;
}

/**
 * Deterministic last-resort condensation, used when the LLM rewrite is
 * unavailable. Extractive only: it can cut, never synthesize.
 */
export function heuristicCondense(raw: string, maxChars: number): string {
  if (!raw) return '';
  let result = stripCodeFences(raw);
  result = stripTables(result);
  result = collapseLists(result);
  result = keepFirstAndLastParagraph(result);
  return truncate(result.trim(), maxChars);
}
