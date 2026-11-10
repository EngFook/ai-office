import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MEETING_FILE = path.join(import.meta.dirname, '..', 'reports', 'meetings', 'live.json');
export function createMeetingRoom(file = MEETING_FILE) {
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { active: false }; throw error; } };
  function write(value) {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, file);
  }
  return {
    start(id, topic, attendees, startedAt) {
      if (read().active) return false; // Never replace a human's existing meeting.
      write({ active: true, id, source: 'qwen-blocked', topic, attendees, startedAt }); return true;
    },
    end(id, endedAt) {
      const current = read();
      if (current.id === id && current.source === 'qwen-blocked') write({ ...current, active: false, attendees: [], endedAt });
    },
  };
}
