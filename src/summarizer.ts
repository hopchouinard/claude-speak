import type { VoiceConfig } from './config.js';
import { logWarning } from './error.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

function buildSystemPrompt(maxWords: number): string {
  return [
    'Rewrite this message to be heard, not read.',
    `Two sentences maximum, under ${maxWords} words.`,
    'State the outcome and the single number that matters most.',
    'No markdown, no file paths, no lists.',
    'If the input was a table of results, say how many there were and whether they passed.',
    'Reply with only the rewritten text.',
  ].join(' ');
}

/**
 * Tier 2 of the condensation chain: an LLM rewrite of a message that is too
 * long or too structured to speak verbatim.
 *
 * Returns null on any failure so the caller can fall back to the deterministic
 * heuristic. Never throws.
 *
 * Deliberately sends no temperature and no token cap: the target model family
 * varies in which of those parameters it accepts, and a rejected parameter
 * would fail every request. Length is controlled by the prompt instead.
 */
export async function summarizeForSpeech(
  raw: string,
  config: VoiceConfig,
): Promise<string | null> {
  const apiKey = config.apiKeys.openai;
  if (!apiKey) {
    logWarning('summarizer skipped: no OpenAI API key configured', config.logFile);
    return null;
  }

  const { model, timeout, maxWords } = config.speech.summarizer;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt(maxWords) },
          { role: 'user', content: raw },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logWarning(`summarizer failed: HTTP ${response.status}`, config.logFile);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      logWarning('summarizer failed: empty or malformed response', config.logFile);
      return null;
    }

    return content.trim();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarning(`summarizer failed: ${reason}`, config.logFile);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
