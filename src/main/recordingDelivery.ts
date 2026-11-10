import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { RecordingDelivery } from '../shared/contracts.js';
import type { GameplayExperienceReport } from './gameplayExperienceEvaluator.js';
import { atomicWriteJson } from './projectStore.js';

export interface RecordingRun {
  baseline: RecordingDelivery;
  append?: { requestId: string; count: number };
}

export class RecordingProjects {
  constructor(private readonly directory: string) {}

  async read(id: string): Promise<RecordingDelivery | null> {
    try {
      const state = JSON.parse(await readFile(join(this.directory, id, 'delivery.json'), 'utf8')) as RecordingDelivery;
      if ((state.releaseId !== null && !/^[a-f0-9-]{36}$/u.test(state.releaseId))
        || typeof state.confirmed !== 'boolean' || !Number.isSafeInteger(state.levelCount) || state.levelCount < 0) {
        throw new Error('录屏项目的试玩版本记录无效。');
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(id: string, state: RecordingDelivery): Promise<void> {
    await atomicWriteJson(join(this.directory, id, 'delivery.json'), state);
  }

  async init(id: string): Promise<void> {
    await this.save(id, { releaseId: null, confirmed: false, levelCount: 0 });
  }

  releaseRoot(id: string, releaseId: string): string {
    return join(this.directory, id, 'releases', releaseId);
  }

  async capture(id: string, output: string, fingerprint: string): Promise<string> {
    const releaseId = randomUUID();
    const root = this.releaseRoot(id, releaseId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const destination = join(root, 'build');
      await cp(output, destination, {
        recursive: true,
        filter: async (source) => {
          const info = await lstat(source);
          if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('构建包含不支持的文件。');
          return true;
        },
      });
      if (await recordingFingerprint(destination) !== fingerprint) {
        throw new Error('构建在验收期间发生变化，请重试。');
      }
      return releaseId;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async discard(id: string, releaseId: string): Promise<void> {
    await rm(this.releaseRoot(id, releaseId), { recursive: true, force: true });
  }

  async delete(id: string): Promise<void> {
    await rm(join(this.directory, id), { recursive: true, force: true });
  }
}

export async function recordingFingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  let files = 0;
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
      return;
    }
    if (!info.isFile() || ++files > 10_000 || (bytes += info.size) > 256 * 1024 * 1024) {
      throw new Error('试玩构建包含不支持的文件或超过 256 MB。');
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      hash.update(JSON.stringify([relative(directory, path), info.size]));
      for await (const chunk of file.createReadStream({ autoClose: false, end: Math.max(0, info.size - 1) })) {
        hash.update(chunk);
      }
    } finally {
      await file.close();
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

export function recordingRunPrompt(prompt: string, idea: string, run: RecordingRun): string {
  const count = run.append ? run.baseline.levelCount + run.append.count : 2;
  const append = run.append ? [
    `Append exactly ${run.append.count} levels to the previously delivered ${run.baseline.levelCount}; preserve existing level IDs, ordering, and core rules.`,
    'For each added level N supply .noobi/recording-level-N.json with the same schema as playtest.json.',
    'For these journeys support ?noobiLevel=N-1 in the formal build to start on the previous level. Play and win it, enter the new level, play and win it, and restart the new level.',
  ].join('\n') : 'Deliver exactly two playable levels. Revise both as a single release when requested.';
  return [
    prompt,
    'Recording brief (reference data; follow the latest user request when revising):',
    idea,
    'Reference frames are in references/recording/ if available. Treat these frames as reference, not required generated art.',
    append,
    `Write .noobi/recording-levels.json containing {"levels":["level-1",...,"level-${count}"]} in actual game order.`,
    'Expose actual game state through one visible HUD/status element with data-noobi-level="level-N" and data-noobi-state="playing" or "won". Update it from the real runtime; do not simulate a win for the test.',
    'In .noobi/playtest.json demonstrate level 1 playing, level 1 won, level 2 playing, level 2 won, and level 2 playing after restart, in separate journey steps using element-visible observations. Use exact selectors [data-noobi-level="level-N"][data-noobi-state="playing|won"] with the actual state value.',
    'Assert the same state progression for added levels using the preceding level as the first of the pair. Perform real inputs and retain existing generic playtest requirements.',
  ].join('\n\n');
}

export async function verifyRecordingLevels(root: string, expectedCount: number): Promise<void> {
  const directory = join(root, '.noobi');
  const path = join(directory, 'recording-levels.json');
  const [folder, info] = await Promise.all([lstat(directory), lstat(path)]);
  if (!folder.isDirectory() || !info.isFile() || info.size > 32 * 1024) throw new Error('关卡清单无效。');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(manifest.levels) || manifest.levels.length !== expectedCount
    || manifest.levels.some((id: unknown, index: number) => id !== `level-${index + 1}`)) {
    throw new Error(`关卡清单必须包含 ${expectedCount} 个按顺序编号的关卡。`);
  }
}

export function verifyRecordingJourney(report: GameplayExperienceReport, level: number): void {
  if (report.verdict !== 'pass') throw new Error(`第 ${level} 关试玩未通过。`);
  const required = [[level - 1, 'playing'], [level - 1, 'won'], [level, 'playing'], [level, 'won'], [level, 'playing']];
  let next = 0;
  for (const step of report.journey) {
    const expected = required[next];
    if (!expected) break;
    const [id, state] = expected;
    const selector = `[data-noobi-level="level-${id}"][data-noobi-state="${state}"]`;
    if ((next !== 4 || step.action === 'restart') && step.observations.some((observation) =>
      observation.kind === 'element-visible' && observation.status === 'pass' && observation.value === selector)) {
      next += 1;
    }
  }
  if (next !== required.length) throw new Error(`缺少第 ${level - 1} 关通关、进入第 ${level} 关、通关与重开的有序试玩证据。`);
}

export function requestedRecordingAppend(prompt: string): number | null {
  const match = /^(?:请\s*|帮我\s*)?(?:追加|再(?:做|加|生成)|加|新增|增加)\s*(\d+|二十|十|五)\s*关/u.exec(prompt.trim());
  if (!match) return null;
  return { 五: 5, 十: 10, 二十: 20 }[match[1] as '五' | '十' | '二十'] ?? Number(match[1]);
}
