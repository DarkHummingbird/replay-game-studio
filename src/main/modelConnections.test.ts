import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServer } from './codexAppServer.js';
import { ActiveRuntime, ModelConnections, validateConnectionInput } from './modelConnections.js';
import { kimiModels } from './kimiRuntime.js';

describe('model connections', () => {
  it('pins provider endpoints and rejects lookalike hosts', () => {
    expect(validateConnectionInput({
      kind: 'deepseek', apiKey: 'placeholder-test-key', endpoint: 'https://untrusted.invalid',
    })).toMatchObject({ endpoint: 'https://api.deepseek.com', model: 'deepseek-flash' });
    expect(() => validateConnectionInput({
      kind: 'bailian', apiKey: 'placeholder-test-key', model: 'qwen3.7-max',
      endpoint: 'https://maas.aliyuncs.com.invalid/compatible-mode/v1',
    })).toThrow();
  });

  it('stores only sealed keys and keeps per-project session pointers across connection switches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noobi-connections-'));
    try {
      const store = new ModelConnections(root, { seal: () => 'sealed-data', open: () => 'placeholder-test-key' });
      await store.use('openai', { kind: 'openai', apiKey: 'placeholder-test-key' });
      await Promise.all([
        store.bindProject('project-a', 'kimi', 'thread-chatgpt'),
        store.bindProject('project-b', 'deepseek', 'thread-other'),
      ]);
      const saved = await readFile(join(root, 'model-connections.json'), 'utf8');
      expect(saved).not.toContain('placeholder-test-key');
      expect(store.list().find((connection) => connection.kind === 'openai')).toMatchObject({ active: true, hasKey: true });
      expect(store.getProject('project-a')).toBe('kimi');
      expect(store.getProject('project-b')).toBe('deepseek');
      expect(store.getProjectThread('project-a', 'chatgpt')).toBe('thread-chatgpt');
      await store.bindProject('project-a', 'chatgpt', 'thread-kimi');
      expect(store.getProjectThread('project-a', 'kimi')).toBe('thread-kimi');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves Harness event subscriptions when replacing the active runtime', async () => {
    const previous = new CodexAppServer();
    const next = new CodexAppServer();
    const router = new ActiveRuntime(previous);
    const onNotice = vi.fn();
    router.server.on('notification', onNotice);
    await router.replace(next);
    previous.emit('notification', { method: 'old' });
    next.emit('notification', { method: 'new' });
    expect(onNotice).toHaveBeenCalledExactlyOnceWith({ method: 'new' });
  });

  it('uses the model options reported by Kimi ACP and retains the selected model', () => {
    const models = kimiModels([{ id: 'model', currentValue: 'actual-model-b',
      options: [{ options: [{ value: 'actual-model-a', name: 'A' }, { value: 'actual-model-b', name: 'B' }] }] }]);
    expect(models.map(({ model, isDefault }) => [model, isDefault])).toEqual([
      ['actual-model-a', false], ['actual-model-b', true],
    ]);
  });
});
