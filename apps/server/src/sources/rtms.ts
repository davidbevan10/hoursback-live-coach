import rtms from '@zoom/rtms';
import type { CoachEvent, TranscriptSource } from './types.js';

/** Zoom RTMS transcript source. Transcript only: no audio or video subscribed in the spike. */
export class RtmsSource implements TranscriptSource {
  private clients = new Map<string, InstanceType<typeof rtms.Client>>();

  start(payload: any, emit: (e: CoachEvent) => void) {
    const streamId: string = payload.rtms_stream_id;
    if (this.clients.has(streamId)) return; // webhook retries must not open a second connection
    const client = new rtms.Client();
    this.clients.set(streamId, client);

    client.onJoinConfirm((reason: number) => emit({ kind: 'join_confirm', reason }));
    client.onTranscriptData((data: Buffer, _size: number, timestamp: number, metadata: any) => {
      emit({
        kind: 'transcript',
        speaker: metadata?.userName ?? 'unknown',
        speakerId: metadata?.userId ?? null,
        text: data.toString('utf8'),
        sourceTs: typeof timestamp === 'number' ? timestamp : null,
      });
    });
    client.onParticipantEvent((event: string, _ts: number, participants: any[]) =>
      emit({ kind: 'participant', action: String(event), names: participants.map((p) => p.userName) }));
    client.onActiveSpeakerEvent((_ts: number, _id: number, userName: string) =>
      emit({ kind: 'active_speaker', speaker: userName }));
    client.onLeave((reason: number) => {
      emit({ kind: 'leave', reason });
      this.clients.delete(streamId);
    });

    emit({ kind: 'session_start', meetingUuid: payload.meeting_uuid ?? payload.session_id, streamId });
    let joined = false;
    try {
      joined = client.join(payload) !== false;
    } catch (err) {
      console.error('RTMS join threw', err);
    }
    if (!joined) {
      // No transcript will ever arrive; end the session instead of showing a dead "live" call.
      this.clients.delete(streamId);
      emit({ kind: 'leave', reason: -1 });
    }
  }

  stop(streamId: string) {
    const c = this.clients.get(streamId);
    if (c) { c.leave(); this.clients.delete(streamId); }
  }
}
