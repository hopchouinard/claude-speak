import { describe, it, expect } from 'vitest';
import { extractMessage } from '../src/extractor.js';

describe('extractMessage', () => {
  it('extracts assistant message from Stop hook JSON', () => {
    const hookData = {
      stop_reason: 'end_turn',
      message: {
        role: 'assistant',
        content: 'I updated the config file and ran the tests. All 12 tests pass.',
      },
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('I updated the config file and ran the tests. All 12 tests pass.');
  });

  it('extracts message from Notification hook JSON', () => {
    const hookData = {
      message: {
        role: 'assistant',
        content: 'I need your permission to delete the old migration files.',
      },
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('I need your permission to delete the old migration files.');
  });

  it('returns null for malformed JSON', () => {
    expect(extractMessage('not valid json{{{')).toBeNull();
  });

  it('returns null when no message content is present', () => {
    const hookData = { stop_reason: 'end_turn' };
    expect(extractMessage(JSON.stringify(hookData))).toBeNull();
  });

  it('returns null for empty message content', () => {
    const hookData = {
      message: { role: 'assistant', content: '' },
    };
    expect(extractMessage(JSON.stringify(hookData))).toBeNull();
  });

  it('handles message content as string directly', () => {
    const hookData = {
      message: 'Simple string message',
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('Simple string message');
  });
});
