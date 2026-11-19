/** All runtime settings come from env. Model IDs and cue rate are config, never constants (brief, section 0). */

export type CueRate = 'conservative' | 'balanced' | 'proactive';

/**
 * cooldownMs / keywordGapMs: how often the coach may *check* for a cue.
 * minShownGapMs: how long after a cue is shown before ordinary turns may produce another. Price,
 * budget and decision-maker keywords and the talking-too-long check can still break through.
 * The first replay benchmark (19 Nov) showed cues on most turns without this gap.
 */
export const CUE_RATES: Record<CueRate, { minConfidence: number; cooldownMs: number; keywordGapMs: number; minShownGapMs: number }> = {
  conservative: { minConfidence: 0.8, cooldownMs: 12_000, keywordGapMs: 6_000, minShownGapMs: 90_000 },
  balanced: { minConfidence: 0.7, cooldownMs: 10_000, keywordGapMs: 5_000, minShownGapMs: 60_000 },
  proactive: { minConfidence: 0.6, cooldownMs: 6_000, keywordGapMs: 4_000, minShownGapMs: 35_000 },
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
