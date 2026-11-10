import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { CodexAppServer, type DynamicToolSpec, type StartThreadOptions, type StartTurnOptions, type TurnResult } from './codexAppServer.js';
import { JsonRpcPeer, type JsonRpcId, type JsonRpcServerRequest } from './jsonRpcPeer.js';
import { MEDIA_DYNAMIC_TOOLS } from './mediaToolBroker.js';
import type { LoginStartResult, ModelOption, RuntimeStatus } from '../shared/contracts.js';

interface AcpConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string; description?: string; options?: AcpConfigOption['options'] }>;
}

interface SessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

interface Session {
  id: string;
  peer: JsonRpcPeer;
  process: ChildProcessWithoutNullStreams;
  options: StartThreadOptions;
  models: ModelOption[];
  media?: Server;
  turn?: { id: string; text: string };
}

type Pending = (value: unknown) => void;

export function kimiModels(config: AcpConfigOption[] = []): ModelOption[] {
  const option = config.find((entry) => entry.category === 'model' || entry.id === 'model');
  return (option?.options ?? []).flatMap((entry) => entry.options ?? [entry])
    .filter((entry) => typeof entry.value === 'string')
    .map((entry) => ({
      id: entry.value!, model: entry.value!, displayName: entry.name ?? entry.value!,
      description: entry.description ?? '', isDefault: option?.currentValue === entry.value,
      defaultEffort: 'medium', efforts: ['medium'],
    }));
}

const EMPTY_STATUS: RuntimeStatus = {
  state: 'stopped', binaryPath: null, version: null, codexHome: null, error: null,
  account: null, models: [],
  capabilities: { namespaceTools: false, imageGeneration: false, externalImageGeneration: false, webSearch: false },
};

export class KimiRuntime extends CodexAppServer {
  #status = structuredClone(EMPTY_STATUS);
  #sessions = new Map<string, Session>();
  #pending = new Map<JsonRpcId, Pending>();
  #refresh: Promise<RuntimeStatus> | null = null;
  #login: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly home: string) { super(); }

  override get status(): RuntimeStatus { return structuredClone(this.#status); }

  override start(): Promise<RuntimeStatus> {
    return this.#status.state === 'ready' ? Promise.resolve(this.status) : this.refresh();
  }

  override refresh(): Promise<RuntimeStatus> {
    this.#refresh ??= this.#probe().finally(() => { this.#refresh = null; });
    return this.#refresh;
  }

  async #probe(): Promise<RuntimeStatus> {
    const cwd = join(this.home, 'probe');
    try {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const session = await this.#open({ cwd, sandbox: 'read-only', ephemeral: true, approvalPolicy: 'never' });
      this.#status = { ...this.#status, state: 'ready', error: null, models: session.models,
        account: { type: 'kimi', email: null, planType: 'Kimi Code 账号权益' } };
      await this.unsubscribeThread(session.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unauthenticated = /auth(?:entication)?[ _-]*required|not logged|login required|登录/iu.test(message);
      this.#status = { ...this.#status, state: unauthenticated ? 'ready' : 'error',
        error: unauthenticated ? null : message, models: [], account: null };
    }
    this.emit('status', this.status);
    return this.status;
  }

  override async startLogin(): Promise<LoginStartResult> {
    if (this.#login) throw new Error('Kimi 正在等待浏览器授权。');
    const binary = await findKimi();
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ['login'], { env: this.#env(), stdio: ['pipe', 'pipe', 'pipe'] });
      this.#login = child;
      let output = '';
      let announced = false;
      const timeout = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);
      timeout.unref();
      const consume = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-12_000);
        const url = output.match(/https:\/\/(?:[a-z0-9-]+\.)*(?:kimi\.com|kimi\.ai)\/[^\s\x1b)<>]+/iu)?.[0];
        if (!url || announced) return;
        const userCode = new URL(url).searchParams.get('user_code')
          ?? output.match(/(?:user code|verification code|enter code|验证码|授权码)\s*[:：]?\s*([A-Z0-9-]{4,24})/iu)?.[1];
        announced = true;
        resolve({ type: 'chatgptDeviceCode', verificationUrl: url, ...(userCode ? { userCode } : {}) });
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (this.#login === child) this.#login = null;
        if (code === 0) {
          if (!announced) resolve({ type: 'chatgptDeviceCode' });
          void this.refresh();
        } else if (!announced) {
          reject(new Error('无法开始 Kimi Code 账号授权。请确认已安装支持 kimi login 的版本。'));
        }
      });
    });
  }

  override async logout(): Promise<RuntimeStatus> {
    this.#login?.kill('SIGTERM');
    const session = await this.#open({ cwd: this.home, sandbox: 'read-only', ephemeral: true });
    try { await session.peer.request('logout', {}); } finally { await this.unsubscribeThread(session.id); }
    return this.refresh();
  }

  override async startThread(options: StartThreadOptions): Promise<string> {
    return (await this.#open(options)).id;
  }

  override async resumeThread(threadId: string, options: Omit<StartThreadOptions, 'ephemeral' | 'dynamicTools'>): Promise<string> {
    return (await this.#open({ ...options, dynamicTools: MEDIA_DYNAMIC_TOOLS }, threadId)).id;
  }

  override async startTurn(options: StartTurnOptions): Promise<string> {
    const session = this.#requireSession(options.threadId);
    const turnId = randomUUID();
    void this.#prompt(session, turnId, options).catch(() => undefined);
    return turnId;
  }

  override async runTurn(options: StartTurnOptions): Promise<TurnResult> {
    return this.#prompt(this.#requireSession(options.threadId), randomUUID(), options);
  }

  override async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (session?.turn?.id === turnId) session.peer.notify('session/cancel', { sessionId: threadId });
  }

  override async unsubscribeThread(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (!session) return;
    this.#sessions.delete(threadId);
    if (session.options.ephemeral) await session.peer.request('session/delete', { sessionId: threadId }, 2_000).catch(() => undefined);
    session.media?.close();
    session.media?.closeAllConnections();
    session.peer.close();
    session.process.kill('SIGTERM');
  }

  override async stop(): Promise<void> {
    this.#login?.kill('SIGTERM');
    await Promise.allSettled([...this.#sessions.keys()].map((id) => this.unsubscribeThread(id)));
    for (const resolve of this.#pending.values()) resolve(undefined);
    this.#pending.clear();
    this.#status = { ...this.#status, state: 'stopped', account: null, models: [] };
    this.emit('status', this.status);
  }

  override respondToServerRequest(id: JsonRpcId, result: unknown): void {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    pending?.(result);
  }

  override rejectServerRequest(id: JsonRpcId, _code: number, _message: string): void {
    this.respondToServerRequest(id, undefined);
  }

  override async readConfig() { return {}; }
  override async listSkills() { return []; }
  override async listMcpServerStatuses() { return []; }

  async #open(options: StartThreadOptions, resumeId?: string): Promise<Session> {
    const binary = await findKimi();
    const cwd = await realpath(options.cwd);
    const home = await realpath(this.home);
    const temporary = join(home, 'tmp');
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    // Kimi's own approvals cover user consent. The OS also constrains writes
    // to the project for writers and to private CLI state for readers.
    const rules = [
      '(version 1)', '(allow default)', '(deny file-write*)',
      `(deny file-read* (literal ${JSON.stringify(join(dirname(home), 'model-connections.json'))}))`,
      ...['codex-home', 'codex-openai', 'codex-deepseek', 'codex-bailian'].map((profile) =>
        `(deny file-read* (subpath ${JSON.stringify(join(dirname(home), profile))}))`),
      `(allow file-write* (subpath ${JSON.stringify(home)}) (literal "/dev/null"))`,
      ...(options.sandbox === 'workspace-write'
        ? [`(allow file-write* (subpath ${JSON.stringify(cwd)}))`] : []),
    ].join('\n');
    if (process.platform !== 'darwin') throw new Error('当前 Kimi 接入需要 macOS。');
    const child = spawn('/usr/bin/sandbox-exec', ['-p', rules, binary, 'acp'], {
      cwd, env: { ...this.#env(), TMPDIR: temporary, npm_config_cache: join(temporary, 'npm') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const peer = new JsonRpcPeer(child.stdout, child.stdin, true);
    const session: Session = { id: '', peer, process: child, options, models: [] };
    child.stderr.resume();
    child.once('error', (error) => peer.close(error));
    child.once('exit', () => peer.close(new Error('Kimi Code CLI 已退出。')));
    peer.on('serverRequest', (request: JsonRpcServerRequest) => { void this.#handleRequest(session, request); });
    peer.on('notification', (notice) => this.#handleUpdate(session, notice));
    peer.start();
    try {
      const init = await peer.request<{ agentInfo?: { version?: string } }>('initialize', {
        protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'noobi-ai', version: '0.1.0' },
      }, 8_000);
      this.#status = { ...this.#status, binaryPath: binary, version: init.agentInfo?.version ?? null, codexHome: home };
      const mcpServers = options.dynamicTools?.length ? [await this.#mediaBridge(session, options.dynamicTools)] : [];
      const data = await peer.request<SessionResult>(resumeId ? 'session/load' : 'session/new', {
        cwd, mcpServers, ...(resumeId ? { sessionId: resumeId } : {}),
      }, 15_000);
      session.id = data.sessionId;
      session.models = kimiModels(data.configOptions);
      this.#sessions.set(session.id, session);
      return session;
    } catch (error) {
      session.media?.close();
      session.media?.closeAllConnections();
      peer.close();
      child.kill('SIGTERM');
      throw error;
    }
  }

  async #prompt(session: Session, id: string, options: StartTurnOptions): Promise<TurnResult> {
    const threadId = session.id;
    const turn = { id, text: '' };
    session.turn = turn;
    const abort = () => { void this.interruptTurn(threadId, id).catch(() => undefined); };
    let status = 'failed';
    try {
      options.signal?.throwIfAborted();
      if (options.model) {
        const model = session.models.find((entry) => entry.model === options.model);
        if (!model) throw new Error('该 Kimi 会话不支持所选模型，请重新选择。');
        if (!model.isDefault) {
          const changed = await session.peer.request<{ configOptions?: AcpConfigOption[] }>('session/set_config_option',
            { sessionId: threadId, configId: 'model', value: options.model });
          session.models = changed.configOptions ? kimiModels(changed.configOptions)
            : session.models.map((entry) => ({ ...entry, isDefault: entry.model === options.model }));
        }
      }
      const images = await Promise.all((options.localImages ?? []).map(async (path) => ({
        type: 'image', mimeType: 'image/jpeg', data: (await readFile(path)).toString('base64'),
      })));
      const text = [session.options.developerInstructions, options.prompt].filter(Boolean).join('\n\n');
      options.signal?.throwIfAborted();
      options.signal?.addEventListener('abort', abort, { once: true });
      const result = await session.peer.request<{ stopReason: string }>('session/prompt', {
        sessionId: threadId, prompt: [{ type: 'text', text }, ...images],
      }, options.timeoutMs ?? 20 * 60_000);
      status = result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'interrupted' : 'failed';
      return { turnId: id, status, text: turn.text, raw: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit('diagnostic', `Kimi 制作失败：${message.slice(0, 400)}`);
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      session.turn = undefined;
      this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id, status } } });
    }
  }

  #handleUpdate(session: Session, notice: { method: string; params?: unknown }): void {
    if (notice.method !== 'session/update' || !session.turn) return;
    const params = notice.params as { update?: { sessionUpdate?: string; content?: { text?: string }; toolCallId?: string; title?: string } };
    const update = params.update;
    const threadId = session.id;
    const turnId = session.turn.id;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
      session.turn.text += update.content.text;
      this.emit('notification', { method: 'item/agentMessage/delta', params: {
        threadId, turnId, itemId: turnId, delta: update.content.text,
      } });
    } else if (update?.sessionUpdate === 'tool_call') {
      this.emit('notification', { method: 'item/started', params: { threadId, turnId,
        item: { type: 'mcpToolCall', id: update.toolCallId, server: 'Kimi', tool: update.title ?? '工具', status: 'inProgress' },
      } });
    }
  }

  async #handleRequest(session: Session, request: JsonRpcServerRequest): Promise<void> {
    try {
      if (request.method !== 'session/request_permission') {
        session.peer.respondError(request.id, { code: -32601, message: 'Unsupported host operation' });
        return;
      }
      const params = request.params as {
        toolCall?: { title?: string; kind?: string };
        options?: Array<{ optionId: string; kind: string }>;
      };
      const options = params?.options ?? [];
      const result = session.options.approvalPolicy === 'never' ? undefined : await this.#requestHost(
        params.toolCall?.kind === 'edit' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
        { threadId: session.id, reason: params.toolCall?.title ?? 'Kimi 工具需要授权' },
        125_000,
      ) as { decision?: string } | undefined;
      const kind = result?.decision === 'accept' ? 'allow_once'
        : result?.decision === 'acceptForSession' ? 'allow_always' : 'reject_once';
      const selected = options.find((item) => item.kind === kind)
        ?? (kind === 'allow_always' ? options.find((item) => item.kind === 'allow_once') : undefined);
      session.peer.respond(request.id, { outcome: selected
        ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } });
    } catch { /* The session may have stopped while waiting for approval. */ }
  }

  #requestHost(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const finish = (result: unknown) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      timer.unref();
      this.#pending.set(id, finish);
      this.emit('serverRequest', { id, method, params });
    });
  }

  async #mediaBridge(session: Session, tools: DynamicToolSpec[]) {
    const token = randomUUID();
    const server = createServer((request, response) => {
      if (request.url !== `/${token}` || request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      void (async () => {
        let body = '';
        for await (const chunk of request) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 64 * 1024) { response.writeHead(413).end(); return; }
        }
        const rpc = JSON.parse(body);
        let result: unknown;
        if (rpc.id == null) { response.writeHead(202).end(); return; }
        if (rpc.method === 'initialize') result = {
          protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26',
          serverInfo: { name: 'noobi-media', version: '1.0.0' }, capabilities: { tools: {} },
        };
        else if (rpc.method === 'tools/list') result = {
          tools: tools.filter((tool) => tool.type === 'function').map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
        else if (rpc.method === 'tools/call' && session.turn && tools.some((tool) => tool.name === rpc.params?.name)) {
          const output = await this.#requestHost('item/tool/call', {
            threadId: session.id, turnId: session.turn.id, callId: randomUUID(), namespace: null,
            tool: rpc.params.name, arguments: rpc.params.arguments ?? {},
          }, 15 * 60_000) as { success?: boolean; contentItems?: Array<{ text: string }> } | undefined;
          result = { isError: !output?.success, content: output?.contentItems?.map(({ text }) => ({ type: 'text', text }))
            ?? [{ type: 'text', text: 'Noobi 媒体工具没有返回结果。' }] };
        } else if (rpc.method === 'ping') result = {};
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: rpc.id, ...(result ? { result } : { error: { code: -32601, message: 'Unsupported method' } }),
        }));
      })().catch(() => response.writeHead(400).end());
    });
    session.media = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法打开 Noobi 素材工具接口。');
    return { name: 'noobi-media', type: 'http', url: `http://127.0.0.1:${address.port}/${token}`, headers: [] };
  }

  #requireSession(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new Error('Kimi 会话已关闭。');
    return session;
  }

  #env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('KIMI_') || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/u.test(key)) delete env[key];
    }
    return { ...env, KIMI_CODE_HOME: this.home, KIMI_DISABLE_TELEMETRY: '1', NO_COLOR: '1' };
  }
}

async function findKimi(): Promise<string> {
  const candidates = (process.env.PATH ?? '').split(':').filter((path) => path.startsWith('/'))
    .concat('/opt/homebrew/bin', '/usr/local/bin');
  for (const directory of candidates) {
    const binary = join(directory, 'kimi');
    try { await access(binary, constants.X_OK); return realpath(binary); } catch { /* Continue searching. */ }
  }
  throw new Error('未找到 Kimi Code CLI，请先安装官方 CLI，再刷新连接。');
}
