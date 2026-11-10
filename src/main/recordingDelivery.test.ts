import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameplayExperienceReport, GameplayJourneyStepResult } from './gameplayExperienceEvaluator.js';
import { RecordingProjects, recordingFingerprint, requestedRecordingAppend, verifyRecordingJourney, verifyRecordingLevels } from './recordingDelivery.js';
import { parseRecordingBrief } from './recording.js';

describe('recording workflow', () => {
  it('requires a complete structured brief and preserves uncertainty', () => {
    const brief = { controls: '拖动', rules: '放入对应格', goal: '填满三格', uncertainty: '是否计时' };
    expect(parseRecordingBrief(JSON.stringify(brief))).toEqual(brief);
    expect(() => parseRecordingBrief('{"controls":"拖动"}')).toThrow();
  });

  it('checks level transitions in order and requires a real restart step', () => {
    const timeline: Array<[number, string]> = [[1, 'playing'], [1, 'won'], [2, 'playing'], [2, 'won'], [2, 'playing']];
    const journey: GameplayJourneyStepResult[] = timeline.map(([level, state], index) => ({
      id: String(index), action: index === 4 ? 'restart' : 'primary', screenshotPath: null, durationMs: 1,
      observations: [{ kind: 'element-visible', description: '', message: '', stepId: String(index),
        status: 'pass', value: `[data-noobi-level="level-${level}"][data-noobi-state="${state}"]` }],
    }));
    const report = { verdict: 'pass', journey } as GameplayExperienceReport;
    expect(() => verifyRecordingJourney(report, 2)).not.toThrow();
    expect(() => verifyRecordingJourney({ ...report, journey: journey.slice(0, 4) }, 2)).toThrow();
    expect(() => verifyRecordingJourney({ ...report, journey: [...journey].reverse() }, 2)).toThrow();
  });

  it('counts actual ordered IDs and leaves a previously published build intact if the candidate changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noobi-recording-test-'));
    try {
      const output = join(root, 'dist');
      const metadata = join(root, '.noobi');
      await Promise.all([mkdir(output), mkdir(metadata)]);
      await writeFile(join(metadata, 'recording-levels.json'), '{"levels":["level-1","level-2"]}');
      await expect(verifyRecordingLevels(root, 2)).resolves.toBeUndefined();
      await expect(verifyRecordingLevels(root, 3)).rejects.toThrow('3');
      await writeFile(join(output, 'index.html'), 'original');
      const store = new RecordingProjects(join(root, 'state'));
      await store.init('project');
      const fingerprint = await recordingFingerprint(output);
      const releaseId = await store.capture('project', output, fingerprint);
      await store.save('project', { releaseId, confirmed: true, levelCount: 2 });
      await writeFile(join(output, 'index.html'), 'changed');
      await expect(store.capture('project', output, fingerprint)).rejects.toThrow('发生变化');
      expect((await store.read('project'))?.releaseId).toBe(releaseId);
      expect(await recordingFingerprint(join(store.releaseRoot('project', releaseId), 'build'))).toBe(fingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('extracts requested quantities from supported chat phrases', () => {
    expect(requestedRecordingAppend('再做十关')).toBe(10);
    expect(requestedRecordingAppend('追加 20 关')).toBe(20);
    expect(requestedRecordingAppend('第二关改简单一点')).toBeNull();
  });
});
