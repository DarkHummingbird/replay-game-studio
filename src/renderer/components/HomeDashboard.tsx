import {
  ArrowRight,
  FileText,
  ImagePlus,
  Menu,
  Moon,
  Paperclip,
  Settings,
  Clapperboard,
  LibraryBig,
  Upload,
  Video,
  Square,
  Sun,
  X,
} from 'lucide-react';
import {
  default as React,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';

import type {
  AppSettings,
  ModelOption,
  ProjectRecord,
  RuntimeStatus,
  RecordingDraft,
} from '../../shared/contracts';
import { formatRelative, PROJECT_STATUS_LABELS } from '../ui';
import { ModelPicker } from './ModelPicker';
import { ProjectIconImage } from './ProjectIcon';
import replayPlatformer from '../assets/replay-platformer.png';
import { shouldSubmitPrompt } from '../promptSubmission';

const RECORDING_FILE = /\.(?:mp4|mov)$/iu;
const REPLAY_STEPS = [
  { title: '读懂玩法', detail: '从画面提取操作、规则和通关条件。' },
  { title: '试玩两关', detail: '直接上手，哪里不对就说一句。' },
  { title: '确认后加关', detail: '满意这一版后，再选择追加数量。' },
];

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
const FILE_ACCEPT = '.pdf,.md,.txt,.json,.csv,.wav,.mp3,.ogg,.glb';
const SUPPORTED_ATTACHMENT = /\.(?:png|jpe?g|webp|pdf|md|txt|json|csv|wav|mp3|ogg|glb)$/iu;
const MAX_HOME_ATTACHMENTS = 20;

export interface HomeLaunchInput {
  idea: string;
  model: string | null;
  effort: string | null;
  attachments: readonly File[];
  recordingDraftId?: string;
}

interface HomeDashboardProps {
  runtime: RuntimeStatus;
  settings: AppSettings;
  projects: readonly ProjectRecord[];
  models: readonly ModelOption[];
  imageGenerationAvailable: boolean;
  busy: boolean;
  focusSignal: number;
  onLaunch: (input: HomeLaunchInput) => Promise<void>;
  onOpenProject: (project: ProjectRecord) => void;
  onOpenRail: () => void;
  onOpenSettings: (section?: 'account' | 'environment' | 'media') => void;
  onToggleTheme: () => void;
}

export function HomeDashboard({
  runtime,
  settings,
  projects,
  models,
  imageGenerationAvailable,
  busy,
  focusSignal,
  onLaunch,
  onOpenProject,
  onOpenRail,
  onOpenSettings,
  onToggleTheme,
}: HomeDashboardProps) {
  const [idea, setIdea] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [recording, setRecording] = useState<File | null>(null);
  const [reviewRecording, setReviewRecording] = useState(false);
  const [recordingDraft, setRecordingDraft] = useState<RecordingDraft | null>(null);
  const [analyzingRecording, setAnalyzingRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState('');
  const recordingInputRef = useRef<HTMLInputElement>(null);
  const ideaInputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [model, setModel] = useState(
    settings.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? '',
  );
  const [effort, setEffort] = useState(settings.defaultEffort);
  const activeModel = useMemo(
    () => models.find((item) => item.model === model) ?? models[0] ?? null,
    [model, models],
  );
  const runtimeReady = runtime.state === 'ready' && Boolean(runtime.account);
  const needsRecordingConfirmation = Boolean(recordingDraft && (reviewRecording || recordingDraft.brief.uncertainty));
  const launchReady = (idea.trim().length > 0 || recording !== null) && !busy && !submitting;

  useEffect(() => {
    if (models.length === 0) {
      setModel('');
      return;
    }
    if (!models.some((item) => item.model === model)) {
      setModel(settings.defaultModel ?? models.find((item) => item.isDefault)?.model ?? models[0]?.model ?? '');
    }
  }, [model, models, settings.defaultModel]);

  useEffect(() => {
    if (focusSignal === 0) return;
    ideaInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ideaInputRef.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  useEffect(() => {
    if (!activeModel) return;
    if (!activeModel.efforts.includes(effort)) {
      setEffort(
        activeModel.efforts.includes(settings.defaultEffort)
          ? settings.defaultEffort
          : activeModel.defaultEffort,
      );
    }
  }, [activeModel, effort, settings.defaultEffort]);

  async function submit(confirmRecording = false) {
    if (!launchReady || submittingRef.current) return;
    if (recording && !runtimeReady) {
      onOpenSettings('account');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      let draft = recordingDraft;
      if (recording && !draft) {
        setRecordingStatus('正在读取录屏并理解玩法…');
        setAnalyzingRecording(true);
        try {
          draft = await window.noobi.analyzeRecording(recording, idea.trim(), activeModel?.model ?? null);
        } finally {
          setAnalyzingRecording(false);
        }
        setRecordingDraft(draft);
        setRecordingStatus('');
        if (reviewRecording || draft.brief.uncertainty) return;
      } else if (recording && draft && (reviewRecording || draft.brief.uncertainty) && !confirmRecording) {
        return;
      }
      await onLaunch({
        idea: idea.trim(),
        model: activeModel?.model ?? null,
        effort: effort || null,
        attachments,
        ...(recording && draft ? { recordingDraftId: draft.id } : {}),
      });
    } catch (error) {
      setRecordingStatus(error instanceof Error ? error.message : String(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function addAttachments(files: readonly File[]) {
    if (busy || files.length === 0) return;
    const supported = files.filter((file) => SUPPORTED_ATTACHMENT.test(file.name));
    const unsupportedCount = files.length - supported.length;
    const known = new Set(attachments.map(attachmentKey));
    const added: File[] = [];
    for (const file of supported) {
      if (attachments.length + added.length >= MAX_HOME_ATTACHMENTS) break;
      const key = attachmentKey(file);
      if (known.has(key)) continue;
      known.add(key);
      added.push(file);
    }
    if (added.length > 0) setAttachments((current) => [...current, ...added]);
    const messages = [
      added.length > 0 ? `已添加 ${added.length} 个附件` : '',
      unsupportedCount > 0 ? `忽略 ${unsupportedCount} 个不支持的文件` : '',
      attachments.length + supported.length > MAX_HOME_ATTACHMENTS ? `最多 ${MAX_HOME_ATTACHMENTS} 个` : '',
    ].filter(Boolean);
    setAttachmentNotice(messages.join('；'));
  }

  function removeAttachment(file: File) {
    const key = attachmentKey(file);
    setAttachments((current) => current.filter((item) => attachmentKey(item) !== key));
    setAttachmentNotice('');
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function selectRecording(file: File) {
    setRecording(file);
    setRecordingDraft(null);
    setRecordingStatus('');
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (busy || submittingRef.current) return;
    const files = Array.from(event.dataTransfer.files);
    const recordings = files.filter((file) => RECORDING_FILE.test(file.name));
    if (recordings.length === 1 && recordings[0]) {
      selectRecording(recordings[0]);
    } else if (recordings.length > 1) {
      setRecordingStatus('一次只能导入一段录屏，请选出要参考的那一段。');
    }
    addAttachments(files.filter((file) => !RECORDING_FILE.test(file.name)));
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSubmitPrompt(event)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <section className="home-dashboard">
      <header className="home-toolbar">
        <button
          className="home-mobile-menu"
          type="button"
          aria-label="打开导航"
          onClick={onOpenRail}
        >
          <Menu size={18} />
        </button>
        <div className="replay-toolbar-title"><Clapperboard size={17} /><span>创作台</span></div>
        <div className="home-toolbar-actions">
          <button
            type="button"
            className={`replay-connection${runtimeReady ? ' is-ready' : ''}`}
            onClick={() => onOpenSettings('account')}
          >
            <i /> {runtimeReady ? '模型已连接' : '连接模型'}
          </button>
          <button type="button" aria-label="切换主题" title="切换主题" onClick={onToggleTheme}>
            {settings.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button type="button" aria-label="设置" title="设置" onClick={() => onOpenSettings()}>
            <Settings size={17} />
          </button>
        </div>
      </header>

      <div className="home-scroll">
        <div className="replay-home-content">
          <section className="replay-hero" aria-labelledby="home-title">
            <div className="replay-hero-copy">
              <span className="replay-kicker"><i /> REPLAY GAME STUDIO / 创作台</span>
              <h1 id="home-title">录一段屏，<br />做成<span>可玩的游戏。</span></h1>
              <p>看到想玩的玩法，录一小段屏。先上手玩两关，满意了再做更多。</p>
            </div>
            <div className="replay-hero-art" aria-hidden="true">
              <div className="replay-clip-frame">
                <img src={replayPlatformer} alt="" />
                <span><i /> REC</span>
              </div>
              <ArrowRight className="replay-art-arrow" size={24} />
              <div className="replay-play-frame">
                <span><i /><i /><i /> PLAYTEST</span>
                <img src={replayPlatformer} alt="" />
              </div>
            </div>
          </section>

          <div className="replay-intake">
            <section className="replay-create" aria-labelledby="replay-create-title">
              <header className="replay-section-heading">
                <div><span>01 / CREATE</span><h2 id="replay-create-title">创建游戏</h2></div>
              </header>
              <div
                className={`home-prompt-card${dragActive ? ' is-dragging' : ''}`}
                onDragEnter={handleDragEnter}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes('Files')) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <input
                  ref={imageInputRef}
                  className="sr-only"
                  type="file"
                  accept={IMAGE_ACCEPT}
                  multiple
                  tabIndex={-1}
                  onChange={(event) => {
                    addAttachments(Array.from(event.target.files ?? []));
                    event.target.value = '';
                  }}
                />
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  accept={FILE_ACCEPT}
                  multiple
                  tabIndex={-1}
                  onChange={(event) => {
                    addAttachments(Array.from(event.target.files ?? []));
                    event.target.value = '';
                  }}
                />
                <input
                  ref={recordingInputRef}
                  className="sr-only"
                  type="file"
                  accept=".mp4,.mov"
                  aria-label="选择录屏文件"
                  tabIndex={-1}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) selectRecording(file);
                    event.target.value = '';
                  }}
                />
                <div className="replay-upload-area">
                  <button
                    type="button"
                    className={`replay-upload${recording ? ' has-recording' : ''}`}
                    disabled={busy || submitting}
                    onClick={() => recordingInputRef.current?.click()}
                  >
                    <span className="replay-upload-icon"><Video size={22} /></span>
                    <span className="replay-upload-copy">
                      <strong>{recording?.name ?? '导入录屏'}</strong>
                      <small>{recording
                        ? `${formatFileSize(recording.size)} · 点击更换`
                        : '点选或拖入 MP4 / MOV · 1–60 秒 · 最多 100 MB'}</small>
                    </span>
                    <Upload size={17} aria-hidden="true" />
                  </button>
                  {recording ? (
                    <div className="replay-recording-options">
                      <label>
                        <input type="checkbox" checked={reviewRecording} disabled={busy || submitting}
                          onChange={(event) => setReviewRecording(event.target.checked)} />
                        先确认玩法，再制作两关
                      </label>
                      <button type="button" disabled={busy || submitting} onClick={() => {
                        setRecording(null);
                        setRecordingDraft(null);
                        setRecordingStatus('');
                      }}>移除录屏</button>
                    </div>
                  ) : null}
                </div>
                <label className="replay-prompt-label" htmlFor="replay-idea">
                  {recording ? '补充你的要求（选填）' : '也可以直接描述玩法'}
                </label>
                <textarea
                  id="replay-idea"
                  ref={ideaInputRef}
                  value={idea}
                  rows={2}
                  maxLength={12_000}
                  placeholder={recording ? '比如：跳跃手感轻一点，第二关更难一些。' : '比如：做一个点击控制跳跃、躲开障碍的游戏。'}
                  aria-label="描述你想制作的游戏"
                  disabled={busy || submitting}
                  onChange={(event) => {
                    setIdea(event.target.value);
                    setRecordingDraft(null);
                  }}
                  onKeyDown={handlePromptKeyDown}
                />
                <div className="home-setup-guide" role="status">
                  <span>Enter 发送 · Shift + Enter 换行</span>
                  {!runtimeReady ? (
                    <p>首次使用：请连接一个模型账号或 API Key。如无内置生图能力，还需配置图片服务。你的需求会保留。
                      <button type="button" onClick={() => onOpenSettings('account')}>设置模型连接</button>
                    </p>
                  ) : !imageGenerationAvailable ? (
                    <p>还缺图片服务：请填写服务商提供的 API Key、接口地址和模型，保存后测试连接。
                      <button type="button" onClick={() => onOpenSettings('media')}>配置图片 API Key</button>
                    </p>
                  ) : <p>图片生成已就绪，可直接开始；外部图片 API Key 为可选配置。</p>}
                </div>
                {attachments.length > 0 ? (
                  <div className="home-attachment-list" aria-label="已添加的参考附件">
                    {attachments.map((file) => (
                      <div className="home-attachment" key={attachmentKey(file)}>
                        <AttachmentPreview file={file} />
                        <span>
                          <strong title={file.name}>{file.name}</strong>
                          <small>{formatFileSize(file.size)}</small>
                        </span>
                        <button
                          type="button"
                          aria-label={`移除 ${file.name}`}
                          disabled={busy}
                          onClick={() => removeAttachment(file)}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {recordingStatus ? (
                  <div className="home-attachment-notice" role="status">
                    {recordingStatus}
                    {analyzingRecording ? <button type="button" onClick={() => {
                      void window.noobi.cancelRecordingAnalysis().catch(() => undefined);
                    }}>取消分析</button> : null}
                  </div>
                ) : null}
                {recordingDraft && needsRecordingConfirmation ? (
                  <section className="replay-brief" aria-label="玩法确认">
                    <h3>录屏里的玩法</h3>
                    <p>怎么操作 · {recordingDraft.brief.controls}</p>
                    <p>规则与反馈 · {recordingDraft.brief.rules}</p>
                    <p>怎样过关 · {recordingDraft.brief.goal}</p>
                    {recordingDraft.brief.uncertainty ? <p>待确认 · {recordingDraft.brief.uncertainty}</p> : null}
                    <p>需要调整时，在上方补一句并重新发送。</p>
                    <button type="button" disabled={busy || submitting} onClick={() => void submit(true)}>按这个玩法制作两关 <ArrowRight size={15} /></button>
                  </section>
                ) : null}
                {attachmentNotice ? <div className="home-attachment-notice" role="status">{attachmentNotice}</div> : null}
                <div className="home-prompt-controls">
                  <div className="home-attachment-actions">
                    <button type="button" disabled={busy} onClick={() => imageInputRef.current?.click()}>
                      <ImagePlus size={15} /> 图片
                    </button>
                    <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
                      <Paperclip size={15} /> 文件
                    </button>
                  </div>
                  <ModelPicker
                    models={models}
                    value={activeModel?.model ?? ''}
                    effort={effort}
                    defaultModel={settings.defaultModel}
                    defaultEffort={settings.defaultEffort}
                    disabled={busy}
                    onChange={setModel}
                    onEffortChange={setEffort}
                  />
                  <span className="home-prompt-spacer" aria-hidden="true" />
                  <button
                    className="home-create-button"
                    type="button"
                    aria-label={busy || submitting ? '正在处理' : needsRecordingConfirmation ? '等待确认玩法' : recording ? '开始分析录屏' : '发送游戏创意'}
                    disabled={!launchReady || needsRecordingConfirmation}
                    title={!runtimeReady
                      ? '点击后打开模型连接设置，需求会保留'
                      : !imageGenerationAvailable
                        ? '点击后配置图片 API Key，需求会保留'
                        : '发送（Enter；Shift + Enter 换行）'}
                    onClick={() => void submit()}
                  >
                    {busy || submitting ? '正在处理' : needsRecordingConfirmation ? '等待确认' : recording ? '分析录屏' : '开始制作'}
                    {busy || submitting ? <Square size={12} /> : <ArrowRight size={17} />}
                  </button>
                </div>
                {dragActive ? (
                  <div className="home-attachment-drop" role="status">
                    <Paperclip size={22} />
                    <strong>松开即可导入</strong>
                    <span>录屏、图片和其他参考文件</span>
                  </div>
                ) : null}
              </div>

            </section>

            <aside className="replay-guide" aria-labelledby="replay-guide-title">
              <header className="replay-section-heading">
                <div><span>录屏制作指南</span><h2 id="replay-guide-title">从录屏到可玩</h2></div>
              </header>
              <ol>
                {REPLAY_STEPS.map((step, index) => (
                  <li key={step.title}>
                    <span aria-hidden="true">0{index + 1}</span>
                    <div><strong>{step.title}</strong><p>{step.detail}</p></div>
                  </li>
                ))}
              </ol>
            </aside>
          </div>

          <section className="home-projects" aria-labelledby="recent-projects-title">
            <header>
              <div>
                <span>02 / LIBRARY</span>
                <h2 id="recent-projects-title">我的游戏</h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIdea('');
                  ideaInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  ideaInputRef.current?.focus({ preventScroll: true });
                }}
              >
                创建新游戏 <ArrowRight size={14} />
              </button>
            </header>
            {projects.length > 0 ? (
              <div className="home-project-grid">
                {projects.slice(0, 6).map((project, index) => (
                  <button key={project.id} type="button" onClick={() => onOpenProject(project)}>
                    <span className={`home-project-art art-${index % 4}`}>
                      <ProjectIconImage project={project} className="project-icon-img" />
                      <i className={`status-dot status-${project.status}`} />
                    </span>
                    <span className="home-project-copy">
                      <strong>{project.name}</strong>
                      <small>{project.engine === 'godot' ? 'GODOT 4' : 'WEB'} · {PROJECT_STATUS_LABELS[project.status]}</small>
                      <time dateTime={project.updatedAt}>{formatRelative(project.updatedAt)}</time>
                    </span>
                    <ArrowRight size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="home-project-empty">
                <LibraryBig size={22} />
                <strong>第一个游戏会出现在这里</strong>
                <span>导入录屏或输入创意后，随时回到这里继续制作。</span>
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

function AttachmentPreview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  const image = /^image\//iu.test(file.type) || /\.(?:png|jpe?g|webp)$/iu.test(file.name);

  useEffect(() => {
    if (!image) {
      setUrl('');
      return undefined;
    }
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file, image]);

  return url ? <img src={url} alt="" /> : <span><FileText size={15} /></span>;
}

function attachmentKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
