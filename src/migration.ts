export interface ProviderConfig {
  model: string;
  voice: string;
  voiceId?: string;
  instructions?: string;
  speed: number;
  stability?: number;
  similarityBoost?: number;
  style?: number;
}

export interface NewFormatConfig {
  activeProvider: string;
  providers: Record<string, ProviderConfig>;
  hooks: { stop: boolean; notification: boolean };
  playback: { command: string };
  cooldown: number;
  timeout: number;
  logFile: string;
}

export const PROVIDER_FIELDS = [
  'model',
  'voice',
  'voiceId',
  'instructions',
  'speed',
  'stability',
  'similarityBoost',
  'style',
] as const;

/**
 * Returns true if the config is in the old flat format:
 * has `provider` as a string and no `providers` key.
 */
export function isOldFormat(config: Record<string, unknown>): boolean {
  return typeof config.provider === 'string' && !('providers' in config);
}

/**
 * Migrates an old flat config into the new nested provider format.
 * Extracts provider-specific fields into `providers.<name>` and
 * preserves shared settings with sensible defaults.
 */
export function migrateConfig(old: Record<string, unknown>): NewFormatConfig {
  const providerName = (old.provider as string) || 'openai';

  // Build provider config from old flat fields
  const providerConfig: ProviderConfig = {
    model: (old.model as string) ?? 'gpt-4o-mini-tts-2025-12-15',
    voice: (old.voice as string) ?? 'ash',
    speed: (old.speed as number) ?? 1.0,
  };

  // Copy optional provider fields if present
  if (old.voiceId !== undefined) providerConfig.voiceId = old.voiceId as string;
  if (old.instructions !== undefined) providerConfig.instructions = old.instructions as string;
  if (old.stability !== undefined) providerConfig.stability = old.stability as number;
  if (old.similarityBoost !== undefined) providerConfig.similarityBoost = old.similarityBoost as number;
  if (old.style !== undefined) providerConfig.style = old.style as number;

  return {
    activeProvider: providerName,
    providers: {
      [providerName]: providerConfig,
    },
    hooks: (old.hooks as { stop: boolean; notification: boolean }) ?? { stop: true, notification: true },
    playback: (old.playback as { command: string }) ?? { command: process.platform === 'darwin' ? 'afplay' : 'paplay' },
    cooldown: (old.cooldown as number) ?? 15,
    timeout: (old.timeout as number) ?? 30,
    logFile: (old.logFile as string) ?? '',
  };
}
