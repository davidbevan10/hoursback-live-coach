/** Source-agnostic transcript events. A local-audio source can implement this later (Phase 4). */
export type CoachEvent =
  | { kind: 'session_start'; meetingUuid: string; streamId: string }
  | { kind: 'transcript'; speaker: string; speakerId: number | null; text: string; sourceTs: number | null }
  | { kind: 'participant'; action: string; names: string[] }
  | { kind: 'active_speaker'; speaker: string }
  | { kind: 'join_confirm'; reason: number }
  | { kind: 'leave'; reason: number }
  | { kind: 'session_stop'; meetingUuid: string };

export interface TranscriptSource {
  start(payload: unknown, emit: (e: CoachEvent) => void): void;
  stop(streamId: string): void;
}
