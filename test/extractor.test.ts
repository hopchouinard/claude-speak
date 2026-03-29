import { describe, it, expect } from 'vitest';
import { extractMessage } from '../src/extractor.js';

describe('extractMessage', () => {
  it('extracts last_assistant_message from Stop hook JSON', () => {
    const hookData = {
      session_id: 'abc-123',
      hook_event_name: 'Stop',
      last_assistant_message: 'I updated the config file and ran the tests. All 12 tests pass.',
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('I updated the config file and ran the tests. All 12 tests pass.');
  });

  it('extracts last_assistant_message from Notification hook JSON', () => {
    const hookData = {
      session_id: 'abc-123',
      hook_event_name: 'Notification',
      last_assistant_message: 'I need your permission to delete the old migration files.',
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('I need your permission to delete the old migration files.');
  });

  it('falls back to message.content format', () => {
    const hookData = {
      message: {
        role: 'assistant',
        content: 'Fallback message content.',
      },
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('Fallback message content.');
  });

  it('returns null for malformed JSON', () => {
    expect(extractMessage('not valid json{{{')).toBeNull();
  });

  it('returns null when no message content is present', () => {
    const hookData = { session_id: 'abc', hook_event_name: 'Stop' };
    expect(extractMessage(JSON.stringify(hookData))).toBeNull();
  });

  it('returns null for empty last_assistant_message', () => {
    const hookData = {
      session_id: 'abc',
      last_assistant_message: '',
    };
    expect(extractMessage(JSON.stringify(hookData))).toBeNull();
  });

  it('handles bare message string', () => {
    const hookData = {
      message: 'Simple string message',
    };
    const result = extractMessage(JSON.stringify(hookData));
    expect(result).toBe('Simple string message');
  });
});
