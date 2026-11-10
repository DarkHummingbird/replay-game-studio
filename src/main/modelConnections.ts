import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteJson } from './projectStore.js';
import { locateCodexBinary } from './codexLocator.js';
import { CodexAppServer } from './codexAppServer.js';
import type { ModelConnection, ModelConnectionInput, ModelConnectionKind } from '../shared/contracts.js';

export const CONNECTIONS = {
  chatgpt: 'ChatGPT · Codex',
  openai: 'OpenAI API Key',
  deepseek: 'DeepSeek API Key',
  bailian: '阿里云百炼 API Key',
  kimi: 'Kimi Code 账号',
} satisfies Record<ModelConnectionKind, string>;

interface StoredConnection {
  secret: string;
  endpoint?: string;
  model?: string;
}

interface ConnectionState {
  active: ModelConnectionKind;
  saved: Partial<Record<ModelConnectionKind, StoredConnection>>;
  projects: Record<string, ModelConnectionKind>;
  sessions?: Record<string, Partial<Record<ModelConnectionKind, string>>>;
}

export class ModelConnections {
  #state: ConnectionState = { active: 'chatgpt', saved: {}, projects: {} };
  #writes = Promise.resolve();

  constructor(private readonly directory: string, private readonly crypto: {
    seal(value: string): string;
    open(value: string): string;
  }) {}

  async init(): Promise<void> {
    try {
      this.#state = JSON.parse(await readFile(this.path, 'utf8')) as ConnectionState;
      assertConnectionKind(this.#state.active);
      this.#state.projects ??= {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private get path(): string { return join(this.directory, 'model-connections.json'); }
  get active(): ModelConnectionKind { return this.#state.active; }

  list(): ModelConnection[] {
    return (Object.keys(CONNECTIONS) as ModelConnectionKind[]).map((kind) => ({
      kind, label: CONNECTIONS[kind], active: kind === this.active,
      hasKey: Boolean(this.#state.saved[kind]), model: this.#state.saved[kind]?.model ?? null,
      endpoint: this.#state.saved[kind]?.endpoint ?? null,
    }));
  }

  getProject(id: string): ModelConnectionKind { return this.#state.projects[id] ?? 'chatgpt'; }

  getProjectThread(id: string, kind: ModelConnectionKind): string | null {
    return this.#state.sessions?.[id]?.[kind] ?? null;
  }

  async bindProject(id: string, kind: ModelConnectionKind, previousThread?: string | null): Promise<void> {
    if (this.getProject(id) === kind) return;
    await this.#commit((state) => ({
      ...state,
      projects: { ...state.projects, [id]: kind },
      ...(previousThread ? { sessions: {
        ...state.sessions, [id]: { ...state.sessions?.[id], [state.projects[id] ?? 'chatgpt']: previousThread },
      } } : {}),
    }));
  }

  async forgetProject(id: string): Promise<void> {
    await this.#commit((state) => {
      const projects = { ...state.projects };
      const sessions = { ...state.sessions };
      delete projects[id];
      delete sessions[id];
      return { ...state, projects, sessions };
    });
  }

  async use(kind: ModelConnectionKind, input?: ModelConnectionInput): Promise<void> {
    const config = input && validateConnectionInput(input);
    const stored = config && { secret: this.crypto.seal(config.apiKey), model: config.model, endpoint: config.endpoint };
    await this.#commit((state) => ({
      ...state, active: kind, saved: stored ? { ...state.saved, [kind]: stored } : state.saved,
    }));
  }

  async clear(kind: ModelConnectionKind): Promise<void> {
    await this.#commit((state) => {
      const saved = { ...state.saved };
      delete saved[kind];
      return { ...state, saved };
    });
  }

  async createCodex(kind: Exclude<ModelConnectionKind, 'kimi'>, input?: ModelConnectionInput, testProfile?: string): Promise<CodexAppServer> {
    const profile = testProfile ?? join(this.directory, kind === 'chatgpt' ? 'codex-home' : `codex-${kind}`);
    const stored = this.#state.saved[kind];
    const settings = input ? validateConnectionInput(input) : stored && {
      ...stored, apiKey: this.crypto.open(stored.secret),
    };
    if (kind === 'chatgpt') return new CodexAppServer({ codexHome: profile });
    if (kind === 'openai') {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(join(profile, 'config.toml'), 'cli_auth_credentials_store = "ephemeral"\n', { mode: 0o600 });
      const runtime = new CodexAppServer({ codexHome: profile });
      if (settings?.apiKey) {
        try { await runtime.loginWithApiKey(settings.apiKey); }
        catch (error) { await runtime.stop(); throw error; }
      }
      return runtime;
    }
    if (!settings?.apiKey || !settings.model || !settings.endpoint) throw new Error('请先保存并测试该供应商的 API Key。');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const binary = await locateCodexBinary();
    const { stdout } = await promisify(execFile)(binary, ['debug', 'models', '--bundled'], {
      env: { ...process.env, CODEX_HOME: profile }, maxBuffer: 8 * 1024 * 1024, timeout: 8_000,
    });
    const catalog = JSON.parse(stdout) as { models: Array<Record<string, unknown>> };
    const base = catalog.models[0];
    if (!base) throw new Error('无法读取此版本 Codex 的模型目录。');
    const modelsPath = join(profile, 'noobi-provider-models.json');
    const modelIds = [...new Set([settings.model, ...(kind === 'deepseek' ? ['deepseek-flash', 'deepseek-v4-pro'] : [])])];
    await atomicWriteJson(modelsPath, { models: modelIds.map((model, index) => ({
      ...base,
      slug: model, display_name: model, description: CONNECTIONS[kind], priority: index + 1,
      model_messages: null, availability_nux: null, upgrade: null,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'medium', description: 'Default' }],
      additional_speed_tiers: [], service_tiers: [], supported_in_api: true,
      input_modalities: kind === 'deepseek' && model !== 'deepseek-flash' ? ['text'] : ['text', 'image'],
      supports_parallel_tool_calls: false, supports_reasoning_summaries: false,
    })) });
    const config = [
      `model = ${JSON.stringify(settings.model)}`,
      'model_provider = "noobi-provider"',
      `model_catalog_json = ${JSON.stringify(modelsPath)}`,
      'web_search = "disabled"',
      '[shell_environment_policy]',
      'exclude = ["NOOBI_PROVIDER_API_KEY"]',
      '[model_providers.noobi-provider]',
      `name = ${JSON.stringify(CONNECTIONS[kind])}`,
      `base_url = ${JSON.stringify(settings.endpoint)}`,
      'wire_api = "responses"',
      'env_key = "NOOBI_PROVIDER_API_KEY"',
      'requires_openai_auth = false',
      '',
    ].join('\n');
    await writeFile(join(profile, 'config.toml'), config, { mode: 0o600 });
    return new CodexAppServer({
      codexHome: profile, providerKey: settings.apiKey,
      externalProvider: kind, externalModels: modelIds,
    });
  }

  #commit(update: (state: ConnectionState) => ConnectionState): Promise<void> {
    const write = this.#writes.then(async () => {
      const next = update(this.#state);
      await atomicWriteJson(this.path, next);
      this.#state = next;
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }
}

export function assertConnectionKind(value: unknown): asserts value is ModelConnectionKind {
  if (typeof value !== 'string' || !Object.hasOwn(CONNECTIONS, value)) throw new Error('模型连接无效。');
}

export function validateConnectionInput(input: ModelConnectionInput): ModelConnectionInput {
  assertConnectionKind(input?.kind);
  const { kind } = input;
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!['openai', 'deepseek', 'bailian'].includes(kind) || !/^[!-~]{12,512}$/u.test(apiKey)) {
    throw new Error('请输入有效的 API Key。');
  }
  if (kind === 'openai') return { kind, apiKey };
  const model = input.model?.trim() || (kind === 'deepseek' ? 'deepseek-flash' : '');
  if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(model)) throw new Error('请填写供应商提供的模型 ID。');
  if (kind === 'deepseek') return { kind, apiKey, model, endpoint: 'https://api.deepseek.com' };
  const endpoint = input.endpoint?.trim().replace(/\/$/u, '') ?? '';
  if (!/^https:\/\/[a-zA-Z0-9.-]+\.maas\.aliyuncs\.com\/compatible-mode\/v1$/u.test(endpoint)) {
    throw new Error('请填写百炼按量 API 的工作空间 Responses 地址。');
  }
  return { kind, apiKey, model, endpoint };
}

/** Stable event surface for the existing Harness and approval/tool brokers. */
export class ActiveRuntime {
  #events = new EventEmitter();
  #backend: CodexAppServer;
  readonly server: CodexAppServer;
  #forward = new Map<string, (...args: unknown[]) => void>();

  constructor(initial: CodexAppServer) {
    this.#backend = initial;
    for (const event of ['status', 'notification', 'serverRequest', 'diagnostic']) {
      const listener = (...args: unknown[]) => this.#events.emit(event, ...args);
      this.#forward.set(event, listener);
      initial.on(event, listener);
    }
    this.server = new Proxy(this.#events, {
      get: (target, key) => {
        const source = key in target ? target : this.#backend;
        const value = Reflect.get(source, key);
        return typeof value === 'function' ? value.bind(source) : value;
      },
    }) as unknown as CodexAppServer;
  }

  async replace(next: CodexAppServer): Promise<void> {
    const old = this.#backend;
    await old.stop();
    for (const [event, listener] of this.#forward) {
      old.removeListener(event, listener);
      next.on(event, listener);
    }
    this.#backend = next;
  }
}
