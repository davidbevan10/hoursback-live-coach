/** All runtime settings come from env. Model IDs and cue rate are config, never constants (brief, section 0). */

export type CueRate = 'conservative' | 'balanced' | 'proactive';

export const CUE_RATES: Record<CueRate, { minConfidence: number; cooldownMs: number; keywordGapMs: number }> = {
  conservative: { minConfidence: 0.75, cooldownMs: 12_000, keywordGapMs: 6_000 },
  balanced: { minConfidence: 0.65, cooldownMs: 10_000, keywordGapMs: 5_000 },
  proactive: { minConfidence: 0.55, cooldownMs: 6_000, keywordGapMs: 4_000 },
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const rate = (env.CUE_RATE ?? 'proactive') as CueRate;
  return {
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? './data',
    zoomSecret: env.ZOOM_WEBHOOK_SECRET_TOKEN ?? '',
    skipSignature: env.SKIP_SIGNATURE_CHECK === '1',
    /** Shared secret for the coach page. The page shows prospect data, so it is never open. */
    coachToken: env.COACH_TOKEN ?? '',
    /** Display name of the host in Zoom. Every other speaker is treated as the prospect. */
    hostName: env.HOST_NAME ?? 'David Bevan',
    anthropicKey: env.ANTHROPIC_API_KEY ?? '',
    cueModel: env.CUE_MODEL ?? 'claude-haiku-5-5',
    stateModel: env.STATE_MODEL ?? 'claude-sonnet-5-5',
    cueRate: (rate in CUE_RATES ? rate : 'proactive') as CueRate,
    /** Read-only Postgres URL for the HoursBack Supabase project (coach_reader role). Optional. */
    databaseUrl: env.HOURSBACK_DB_URL ?? '',
    /** Minutes either side of a booking's scheduled_at that count as "this call". */
    matchWindowBeforeMin: Number(env.MATCH_WINDOW_BEFORE_MIN ?? 20),
    matchWindowAfterMin: Number(env.MATCH_WINDOW_AFTER_MIN ?? 60),
  };
}

export type Config = ReturnType<typeof loadConfig>;
