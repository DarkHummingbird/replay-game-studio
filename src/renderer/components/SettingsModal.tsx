import {
  Boxes,
  Cable,
  CheckCircle2,
  Cpu,
  ExternalLink,
  FileCode2,
  FileText,
  FolderOpen,
  KeyRound,
  LogIn,
  LogOut,
  Monitor,
  RefreshCw,
  Save,
  Settings2,
  SquareTerminal,
  SunMoon,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type {
  AppSettings,
  LoginStartResult,
  RuntimeStatus,
  ModelConnection,
  ModelConnectionKind,
} from '../../shared/contracts';
import { runtimeLabel, toMessage } from '../ui';
import { Modal } from './Modal';
import { EnvironmentSettings } from './EnvironmentSettings';
import {
  McpSettings,
  MediaApiSettings,
  PromptSettings,
  SkillsSettings,
  useExtensionSettings,
} from './SettingsExtensions';

export type SettingsSection = 'account' | 'environment' | 'media' | 'defaults' | 'skills' | 'mcp' | 'prompts' | 'appearance';

interface SettingsModalProps {
  value: AppSettings;
  runtime: RuntimeStatus;
  initialSection?: SettingsSection;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
  onRuntime: (runtime: RuntimeStatus) => void;
}

const SECTIONS = [
  { id: 'account', label: '模型连接', detail: '账号、API Key 与运行时', icon: KeyRound },
  { id: 'environment', label: '环境管理', detail: 'Node、Codex、Godot', icon: Cpu },
  { id: 'media', label: '媒体 API', detail: '图像、音频、3D', icon: Boxes },
  { id: 'defaults', label: '项目默认值', detail: '目录、模型、推理', icon: Settings2 },
  { id: 'skills', label: 'Skills', detail: 'Agent 专业能力', icon: FileCode2 },
  { id: 'mcp', label: 'MCP Servers', detail: '工具与数据连接', icon: Cable },
  { id: 'prompts', label: '提示词', detail: '分角色模板', icon: FileText },
  { id: 'appearance', label: '外观', detail: '深色与浅色', icon: SunMoon },
] as const;

export function SettingsModal({
  value,
  runtime,
  initialSection = 'account',
  onClose,
  onSaved,
  onRuntime,
}: SettingsModalProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [connectionDraft, setConnectionDraft] = useState<ModelConnectionKind>(runtime.connection ?? 'chatgpt');
  const [connectionKey, setConnectionKey] = useState('');
  const [connectionModel, setConnectionModel] = useState('');
  const [connectionEndpoint, setConnectionEndpoint] = useState('');
  const [login, setLogin] = useState<LoginStartResult | null>(null);
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptBusy, setPromptBusy] = useState(false);
  const extensions = useExtensionSettings(setMessage);

  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (section !== 'account') return;
    let current = true;
    void window.noobi.listModelConnections().then((next) => {
      if (current) setConnections(next);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [section, runtime.connection, runtime.account?.type]);
  const editingConnection = connections.find((item) => item.kind === connectionDraft);
  const needsKey = connectionDraft !== 'chatgpt' && connectionDraft !== 'kimi';

  function selectConnection(kind: ModelConnectionKind) {
    const record = connections.find((item) => item.kind === kind);
    setConnectionDraft(kind);
    setConnectionKey('');
    setConnectionModel(record?.model ?? (kind === 'deepseek' ? 'deepseek-flash' : ''));
    setConnectionEndpoint(record?.endpoint ?? '');
  }

  async function applyConnection(withKey: boolean) {
    setBusy(true);
    setMessage('');
    try {
      const next = withKey ? await window.noobi.connectModelKey({
        kind: connectionDraft, apiKey: connectionKey, model: connectionModel, endpoint: connectionEndpoint,
      }) : await window.noobi.useModelConnection(connectionDraft);
      onRuntime(next);
      setLogin(null);
      setConnectionKey('');
      setConnections(await window.noobi.listModelConnections());
      setMessage(next.error ?? (withKey ? '模型请求已通过，已切换到此连接。' : '已切换模型连接。'));
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const selectedModel = useMemo(
    () => runtime.models.find((item) => item.model === draft.defaultModel),
    [draft.defaultModel, runtime.models],
  );
  const efforts = selectedModel?.efforts.length
    ? selectedModel.efforts
    : ['minimal', 'low', 'medium', 'high', 'xhigh'];

  async function refreshRuntime() {
    setBusy(true);
    setMessage('');
    try {
      onRuntime(await window.noobi.refreshRuntime());
      setMessage('运行时状态已刷新。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function startLogin() {
    setBusy(true);
    setMessage('');
    try {
      const result = await window.noobi.startLogin();
      setLogin(result);
      setMessage(runtime.connection === 'kimi'
        ? '请在 Kimi 官方页面完成账号授权。'
        : '请在官方页面完成 ChatGPT 登录。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setMessage('');
    try {
      onRuntime(await window.noobi.logout());
      setLogin(null);
      setMessage('已断开此连接。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function chooseDirectory() {
    const directory = await window.noobi.chooseDirectory();
    if (directory) setDraft((current) => ({ ...current, defaultWorkspace: directory }));
  }

  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const saved = await window.noobi.saveSettings(draft);
      setDraft(saved);
      onSaved(saved);
      setMessage('设置已保存。');
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function confirmPromptDiscard(): boolean {
    return !promptDirty || window.confirm('提示词有未保存更改。离开此页面会放弃这些更改，是否继续？');
  }

  function closeSettings() {
    if (promptBusy || !confirmPromptDiscard()) return;
    setPromptDirty(false);
    onClose();
  }

  function selectSection(next: SettingsSection) {
    if (next === section || promptBusy || !confirmPromptDiscard()) return;
    setPromptDirty(false);
    setSection(next);
    setMessage('');
  }

  return (
    <Modal
      eyebrow="REPLAY / PREFERENCES"
      title="设置"
      description="管理模型、媒体服务和工作台偏好。"
      className="settings-modal"
      onClose={busy || promptBusy ? undefined : closeSettings}
      footer={
        <>
          <span className="settings-feedback" role="status">{message}</span>
          {section === 'defaults' || section === 'appearance' ? (
            <button className="primary-button" type="button" disabled={busy} onClick={() => void save()}>
              <Save size={15} /> {busy ? '保存中…' : '保存设置'}
            </button>
          ) : null}
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={section === item.id ? 'is-active' : ''}
                aria-current={section === item.id ? 'page' : undefined}
                disabled={promptBusy}
                onClick={() => selectSection(item.id)}
              >
                <Icon size={16} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="settings-page">
          {section === 'account' ? (
            <>
            <section className="settings-form">
              <label>
                <span>选择连接</span>
                <select value={connectionDraft} disabled={busy}
                  onChange={(event) => selectConnection(event.target.value as ModelConnectionKind)}>
                  {connections.map((item) => (
                    <option key={item.kind} value={item.kind}>
                      {item.label}{item.active ? ' · 使用中' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {needsKey ? (
                <>
                  <label>
                    <span>API Key{editingConnection?.hasKey ? '（已保存，可更换）' : ''}</span>
                    <input type="password" autoComplete="off" disabled={busy} value={connectionKey}
                      onChange={(event) => setConnectionKey(event.target.value)} />
                  </label>
                  {connectionDraft !== 'openai' ? (
                    <label>
                      <span>模型 ID</span>
                      <input disabled={busy} value={connectionModel} placeholder="供应商提供的模型 ID"
                        onChange={(event) => setConnectionModel(event.target.value)} />
                    </label>
                  ) : null}
                  {connectionDraft === 'bailian' ? (
                    <label>
                      <span>百炼按量 API 地址</span>
                      <input disabled={busy} value={connectionEndpoint} placeholder="https://工作空间.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
                        onChange={(event) => setConnectionEndpoint(event.target.value)} />
                    </label>
                  ) : null}
                  <button type="button" className="primary-button compact" disabled={busy || !connectionKey.trim()}
                    onClick={() => void applyConnection(true)}>保存并测试（可能产生少量用量）</button>
                </>
              ) : null}
              {!needsKey || editingConnection?.hasKey ? (
                <button type="button" className="secondary-button compact" disabled={busy || editingConnection?.active}
                  onClick={() => void applyConnection(false)}>使用此连接</button>
              ) : null}
            </section>
            <AccountSettings
              runtime={runtime}
              login={login}
              busy={busy}
              onRefresh={() => void refreshRuntime()}
              onLogin={() => void startLogin()}
              onLogout={() => void logout()}
            />
            </>
          ) : null}

          {section === 'environment' ? <EnvironmentSettings onMessage={setMessage} /> : null}

          {section === 'media' ? <MediaApiSettings controller={extensions} /> : null}

          {section === 'defaults' ? (
            <section>
              <SettingsHeading
                eyebrow="PROJECT DEFAULTS"
                title="新项目默认值"
                description="这些值只作为新任务起点，每个项目仍可单独选择模型和推理强度。"
              />
              <div className="settings-form">
                <label>
                  <span>默认工作区</span>
                  <div className="path-control">
                    <input
                      value={draft.defaultWorkspace}
                      onChange={(event) => setDraft((current) => ({ ...current, defaultWorkspace: event.target.value }))}
                    />
                    <button type="button" onClick={() => void chooseDirectory()}>
                      <FolderOpen size={14} /> 选择
                    </button>
                  </div>
                </label>
                <label>
                  <span>默认模型</span>
                  <select
                    value={draft.defaultModel ?? ''}
                    onChange={(event) => {
                      const model = runtime.models.find((item) => item.model === event.target.value);
                      setDraft((current) => ({
                        ...current,
                        defaultModel: event.target.value || null,
                        defaultEffort: model?.defaultEffort ?? current.defaultEffort,
                      }));
                    }}
                  >
                    <option value="">使用 Codex 默认模型</option>
                    {runtime.models.map((item) => (
                      <option value={item.model} key={item.id}>{item.displayName}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>默认推理强度</span>
                  <select
                    value={draft.defaultEffort}
                    onChange={(event) => setDraft((current) => ({ ...current, defaultEffort: event.target.value }))}
                  >
                    {efforts.map((effort) => (
                      <option value={effort} key={effort}>{effort.toUpperCase()}</option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
          ) : null}

          {section === 'skills' ? <SkillsSettings controller={extensions} /> : null}

          {section === 'mcp' ? <McpSettings controller={extensions} /> : null}

          {section === 'prompts' ? (
            <PromptSettings
              controller={extensions}
              onDirtyChange={setPromptDirty}
              onBusyChange={setPromptBusy}
            />
          ) : null}

          {section === 'appearance' ? (
            <section>
              <SettingsHeading
                eyebrow="APPEARANCE"
                title="界面主题"
                description="功能颜色在两种主题下保持一致，颜色只用来表达状态。"
              />
              <div className="theme-choices" role="radiogroup" aria-label="界面主题">
                {(['dark', 'light'] as const).map((theme) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={draft.theme === theme}
                    className={draft.theme === theme ? 'is-active' : ''}
                    key={theme}
                    onClick={() => setDraft((current) => ({ ...current, theme }))}
                  >
                    <span className={`theme-swatch theme-${theme}`} aria-hidden="true">
                      <i /><i /><i />
                    </span>
                    <span>
                      <strong>{theme === 'dark' ? '深色' : '浅色'}</strong>
                      <small>{theme === 'dark' ? '适合长时间制作' : '适合明亮工作环境'}</small>
                    </span>
                    {draft.theme === theme ? <CheckCircle2 size={16} /> : null}
                  </button>
                ))}
              </div>
              <footer className="replay-credits">
                <strong>关于 Replay Game Studio</strong>
                <p>录屏创作与界面为二次开发，桌面游戏制作基座来自 <a href="https://github.com/Innate-Labs/Noobi.ai" target="_blank" rel="noreferrer">Innate Labs 的 Noobi.ai</a>。</p>
                <p>首页示例画面来自 <a href="https://github.com/KenneyNL/Starter-Kit-3D-Platformer" target="_blank" rel="noreferrer">Kenney 的 Starter Kit 3D Platformer</a>（CC0 1.0）。</p>
              </footer>
            </section>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function AccountSettings({
  runtime,
  login,
  busy,
  onRefresh,
  onLogin,
  onLogout,
}: {
  runtime: RuntimeStatus;
  login: LoginStartResult | null;
  busy: boolean;
  onRefresh: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  return (
    <section>
      <SettingsHeading
        eyebrow={runtime.connection === 'kimi' ? 'KIMI CODE CLI' : 'CODEX APP SERVER'}
        title="当前连接"
        description={runtime.connection === 'kimi'
          ? '通过 Kimi Code CLI 使用账号权益。请安装官方 CLI 后登录。'
          : 'ChatGPT 账号使用会员用量，API Key 使用相应供应商的额度。'}
        action={
          <button className="secondary-button compact" type="button" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={13} className={busy ? 'spin' : ''} /> 刷新
          </button>
        }
      />

      <div className={`runtime-card state-${runtime.state}`}>
        <div className="runtime-card-heading">
          <span className={`runtime-dot state-${runtime.state}`} />
          <div>
            <strong>{runtimeLabel(runtime)}</strong>
            <small>{runtime.version ?? 'VERSION UNKNOWN'}</small>
          </div>
        </div>
        {runtime.error ? <p className="runtime-error">{runtime.error}</p> : null}
        <dl>
          <div><dt>Binary</dt><dd>{runtime.binaryPath ?? '尚未定位'}</dd></div>
          <div><dt>运行目录</dt><dd>{runtime.codexHome ?? '尚未启动'}</dd></div>
          <div><dt>Models</dt><dd>{runtime.models.length}</dd></div>
          <div><dt>Image route</dt><dd>{runtime.capabilities.externalImageGeneration ? '外部 API 优先' : runtime.capabilities.imageGeneration ? 'Codex ImageGen' : '当前不可用'}</dd></div>
          <div><dt>Media tools</dt><dd>{runtime.state === 'ready' ? '素材库 / 音效已接入' : '等待运行时'}</dd></div>
        </dl>
      </div>

      <div className="account-card">
        <div className="account-icon"><SquareTerminal size={20} /></div>
        <div className="account-copy">
          <span>{runtime.connection === 'kimi' ? 'KIMI CODE' : '模型授权'}</span>
          <strong>{runtime.account?.email ?? (runtime.account ? '已连接' : '尚未授权')}</strong>
          <small>{runtime.account?.planType ?? runtime.account?.type ?? '使用厂商账号或 API Key'}</small>
        </div>
        {runtime.account ? (
          <button className="secondary-button compact" type="button" disabled={busy} onClick={onLogout}>
            <LogOut size={13} /> {runtime.connection === 'chatgpt' || runtime.connection === 'kimi' || !runtime.connection ? '退出' : '移除 Key'}
          </button>
        ) : !runtime.connection || runtime.connection === 'chatgpt' || runtime.connection === 'kimi' ? (
          <button className="primary-button compact" type="button" disabled={busy} onClick={onLogin}>
            <LogIn size={13} /> {runtime.connection === 'kimi' ? '登录 Kimi' : '登录 ChatGPT'}
          </button>
        ) : null}
      </div>

      {login ? (
        <div className="login-instructions">
          <Monitor size={17} />
          <div>
            <strong>在官方页面完成登录</strong>
            {login.userCode ? <code>{login.userCode}</code> : null}
            {login.verificationUrl || login.authUrl ? (
              <a href={login.verificationUrl ?? login.authUrl} target="_blank" rel="noreferrer">
                打开验证页面 <ExternalLink size={12} />
              </a>
            ) : (
              <span>系统浏览器已打开，请在那里完成授权。</span>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SettingsHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="settings-page-heading">
      <div>
        <span>{eyebrow}</span>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
