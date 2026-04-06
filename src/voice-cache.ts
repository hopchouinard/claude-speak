import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface VoiceCacheEntry {
  name: string;
  voiceId: string;
  category: string;
}

export interface VoiceCache {
  fetched: string;
  voices: VoiceCacheEntry[];
}

export function getCachePath(): string {
  return path.join(os.homedir(), '.claude-speak', 'voices-elevenlabs.json');
}

export function readCache(): VoiceCache | null {
  const cachePath = getCachePath();
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(raw) as VoiceCache;
  } catch {
    return null;
  }
}

export function writeCache(voices: VoiceCacheEntry[]): void {
  const cachePath = getCachePath();
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  const data: VoiceCache = {
    fetched: new Date().toISOString(),
    voices,
  };
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function resolveVoiceName(name: string, voices: VoiceCacheEntry[]): string | null {
  const lower = name.toLowerCase();
  // Exact match first
  const exact = voices.find((v) => v.name.toLowerCase() === lower);
  if (exact) return exact.voiceId;
  // Prefix match: "Nina" matches "Nina - nerdy"
  const prefix = voices.find((v) => v.name.toLowerCase().startsWith(lower));
  if (prefix) return prefix.voiceId;
  // Substring match: "nerdy" matches "Nina - nerdy"
  const substring = voices.find((v) => v.name.toLowerCase().includes(lower));
  if (substring) return substring.voiceId;
  return null;
}

export async function fetchElevenLabsVoices(apiKey: string): Promise<VoiceCacheEntry[]> {
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { voices: Array<{ voice_id: string; name: string; category: string }> };
  return data.voices.map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category,
  }));
}
