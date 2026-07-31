import { sanitize } from './sanitizer.js';

// Mirrors the table-separator regex used by convertTables() in
// src/sanitizer.ts. The two must stay in step: if one changes what counts as
// a markdown table separator row, shouldCondense's table detection drifts
// out of sync with what sanitize() actually flattens into prose.
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
  const fenceIndices: number[] = [];
  lines.forEach((line, idx) => {
    if (/^```/.test(line)) fenceIndices.push(idx);
  });

  // An odd number of fence markers means the last one never closed. The spec
  // says drop fenced *blocks*; an unterminated fence never completes a block,
  // so it does not pair up. Only paired markers toggle stripping — this
  // bounds the blast radius of one stray backtick line to itself, instead of
  // swallowing every line through EOF (the previous, buggy behavior).
  const pairedCount = fenceIndices.length - (fenceIndices.length % 2);
  const pairedMarkers = new Set(fenceIndices.slice(0, pairedCount));
  const strayMarker = fenceIndices.length % 2 === 1 ? fenceIndices[fenceIndices.length - 1] : -1;

  const kept: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (pairedMarkers.has(i)) {
      inFence = !inFence;
      continue;
    }
    if (i === strayMarker) continue; // drop the orphan marker line itself, nothing else
    if (!inFence) kept.push(lines[i]);
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

function paragraphHasListItems(paragraph: string): boolean {
  return paragraph.split('\n').some((line) => LIST_ITEM.test(line));
}

/**
 * Keeps the first paragraph, the last paragraph, and any middle paragraph
 * that carries list items. Dropping the middle is meant to cut rambling
 * prose, not the payload: a list is the answer itself (collapseLists has
 * already capped it at 3 items + "and N more"), so a list-bearing middle
 * paragraph survives even though ordinary prose paragraphs around it don't.
 * Runs after collapseLists, whose surviving item lines still carry their
 * `- ` / `1. ` markers, which is what LIST_ITEM detects here.
 */
function keepStructuralParagraphs(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length <= 2) return paragraphs.join('\n\n');

  const first = paragraphs[0];
  const last = paragraphs[paragraphs.length - 1];
  const middleWithLists = paragraphs.slice(1, -1).filter(paragraphHasListItems);
  return [first, ...middleWithLists, last].join('\n\n');
}

/**
 * True when the `.` at dotIndex terminates a list ordinal ("3.") rather than a
 * sentence. Cutting there strands the number on its own line, and a lone "3."
 * is read aloud as "three" — observed in the wild before this guard existed.
 */
function isListOrdinalDot(window: string, dotIndex: number): boolean {
  return /(?:^|\n)[ \t]*\d+$/.test(window.slice(0, dotIndex));
}

/**
 * Drop a list marker left alone on the final line by a cut. A bare "3." or "-"
 * carries nothing once its text is gone.
 */
function stripDanglingMarker(text: string): string {
  return text.replace(/\n[ \t]*(?:\d+\.|[-*])[ \t]*$/, '').trimEnd();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const window = text.slice(0, maxChars);

  let lastSentence = -1;
  for (let i = 0; i < window.length; i++) {
    const ch = window[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    // A terminator only ends a sentence if whitespace or the window follows it.
    const next = window[i + 1];
    if (next !== undefined && next !== ' ' && next !== '\n') continue;
    if (ch === '.' && isListOrdinalDot(window, i)) continue;
    lastSentence = i;
  }
  if (lastSentence > 0) return stripDanglingMarker(window.slice(0, lastSentence + 1)).trim();

  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace > 0) return stripDanglingMarker(window.slice(0, lastSpace)).trim() + ' ';

  // No sentence or word boundary exists anywhere within the budget: the
  // window is one unbroken token (URL, hash, base64, ...). There is no
  // substring of it that is both within maxChars and word-safe, and the
  // spec forbids a mid-word cut outright. Dropping it is a deliberate
  // choice over silently mangling it — an unreadable fragment is worse
  // than nothing for text headed to speech.
  return '';
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
  result = keepStructuralParagraphs(result);
  return truncate(result.trim(), maxChars);
}
