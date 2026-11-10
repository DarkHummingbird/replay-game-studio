import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { RecordingBrief } from '../shared/contracts.js';

const execute = promisify(execFile);

export async function withRecordingFrames<T>(
  source: string,
  signal: AbortSignal,
  use: (frames: readonly { path: string; seconds: number }[], directory: string) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(source) || !['.mov', '.mp4'].includes(extname(source).toLowerCase())) {
    throw new Error('请选择 MP4 或 MOV 录屏。');
  }
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 100 * 1024 * 1024) {
    throw new Error('请选择不超过 100 MB 的录屏文件。');
  }

  const [probe, decoder] = await Promise.all([findMediaTool('ffprobe'), findMediaTool('ffmpeg')]);
  const directory = await mkdtemp(join(tmpdir(), 'noobi-recording-'));
  try {
    signal.throwIfAborted();
    const input = join(directory, 'input.mp4');
    await copyFile(source, input, constants.COPYFILE_EXCL);
    const options = { signal, timeout: 8_000, maxBuffer: 128 * 1024, encoding: 'utf8' as const };
    const result = await execute(probe, [
      '-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=width,height', '-of', 'json', input,
    ], options);
    const metadata = JSON.parse(result.stdout);
    const duration = Number(metadata.format?.duration);
    const video = metadata.streams?.[0];
    if (!video || video.width * video.height > 3840 * 2160 || !(duration >= 1 && duration <= 60)) {
      throw new Error('录屏需要有可读取的画面，时长为 1–60 秒，最高支持 4K。');
    }
    const frames: { path: string; seconds: number }[] = [];
    for (let i = 0; i < 8; i += 1) {
      const seconds = Number((duration * i / 8).toFixed(2));
      const path = join(directory, `frame-${i + 1}.jpg`);
      await execute(decoder, [
        '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-ss', String(seconds),
        '-f', 'mov', '-i', input, '-map', '0:v:0', '-frames:v', '1',
        '-vf', 'scale=960:960:force_original_aspect_ratio=decrease', '-q:v', '4', '-threads', '1', path,
      ], options);
      if ((await lstat(path)).size > 0) frames.push({ path, seconds });
    }
    await rm(input);
    return await use(frames, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function findMediaTool(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
  for (const base of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const candidate = join(base, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next installation directory. */ }
  }
  throw new Error('读取录屏需要 FFmpeg 和 FFprobe，请先安装 FFmpeg。');
}

export function parseRecordingBrief(answer: string): RecordingBrief {
  const parsed: unknown = JSON.parse(answer.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/giu, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('玩法分析格式无效，请重试。');
  const value = parsed as Record<string, unknown>;
  for (const name of ['controls', 'rules', 'goal'] as const) {
    if (typeof value[name] !== 'string' || !value[name].trim() || value[name].length > 1200) {
      throw new Error('玩法分析缺少操作、规则或过关条件，请重试。');
    }
  }
  if (typeof value.uncertainty !== 'string' || value.uncertainty.length > 1200) {
    throw new Error('玩法分析缺少待确认信息，请重试。');
  }
  return {
    controls: value.controls as string,
    rules: value.rules as string,
    goal: value.goal as string,
    uncertainty: value.uncertainty,
  };
}

export function describeRecording(brief: RecordingBrief, notes: string): string {
  return [
    '根据下面的录屏玩法需求开发两关。第一关体现录屏核心玩法；第二关保持核心规则并改变关卡设计。',
    `操作：${brief.controls}`, `规则与反馈：${brief.rules}`, `过关条件：${brief.goal}`,
    brief.uncertainty && `待确认或推断：${brief.uncertainty}`,
    notes.trim() && `玩家补充要求：${notes.trim()}`,
  ].filter(Boolean).join('\n');
}
