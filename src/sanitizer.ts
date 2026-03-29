export function sanitize(text: string): string {
  if (!text) return '';

  let result = text;

  // Convert tables before stripping other markdown
  result = convertTables(result);

  // Strip code fences (``` blocks)
  result = result.replace(/```[\w]*\n?/g, '');

  // Strip inline code backticks
  result = result.replace(/`([^`]+)`/g, '$1');

  // Strip markdown headers
  result = result.replace(/^#{1,6}\s+/gm, '');

  // Strip bullet markers (before bold/italic so * bullets aren't treated as italic)
  result = result.replace(/^[\s]*[-*]\s+/gm, '');

  // Strip numbered list prefixes
  result = result.replace(/^[\s]*\d+\.\s+/gm, '');

  // Strip bold/italic markers
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');

  // Strip link syntax, keep display text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip horizontal rules (and the blank line they leave behind)
  result = result.replace(/^---+$\n?/gm, '');

  // Strip HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  // Trim leading whitespace; collapse multiple trailing newlines to one
  result = result.replace(/^\s+/, '');
  result = result.replace(/\n{2,}$/, '\n');

  return result;
}

function convertTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect table: line has pipes and next line is a separator row
    if (line.includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+\s*\|/.test(lines[i + 1])) {
      const headers = parsePipeRow(line);
      i += 2; // skip header + separator

      while (i < lines.length && lines[i].includes('|') && !/^\|?\s*[-:]+\s*\|/.test(lines[i])) {
        const values = parsePipeRow(lines[i]);
        const parts = headers.map((h, idx) => `${h}: ${values[idx] ?? ''}`);
        result.push(parts.join(', '));
        i++;
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

function parsePipeRow(row: string): string[] {
  return row
    .split('|')
    .map(cell => cell.trim())
    .filter(cell => cell.length > 0);
}
