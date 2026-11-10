import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import type {
  AgentEvent,
  AppSettings,
  ApprovalAnswers,
  ApprovalDecision,
  BootstrapPayload,
  CreateProjectInput,
  EnvironmentStatusSnapshot,
  EnvironmentToolStatus,
  ExtensionSettingsSnapshot,
  GameAssetRecord,
  GameplayExperienceReport as SharedGameplayExperienceReport,
  McpServerSetting,
  MediaCapability,
  ModelConnectionInput,
  ModelConnectionKind,
  MediaProviderSetting,
  MediaProviderTestResult,
  NoobiCrewMember,
  PipelineStage,
  PromptTemplateId,
  PromptTemplateSetting,
  ProjectInspectorPayload,
  ProjectIconData,
  ProjectRecord,
  ProjectStatus,
  RunProjectInput,
  RuntimeStatus,
  RecordingDraft,
  SaveMcpServerInput,
  SaveMediaProviderInput,
  SkillSetting,
} from '../shared/contracts.js';
import {
  isNoobiCrew,
  isNoobiPackId,
  isNoobiSceneId,
  isNoobiStageMode,
  NOOBI_PACK_IDS,
  NOOBI_SCENE_IDS,
} from '../shared/contracts.js';
import { AssetStore } from './assetStore.js';
import { AssetPlanStore } from './assetPlanStore.js';
import { ApprovalBroker } from './approvalBroker.js';
import { CodexAppServer } from './codexAppServer.js';
import { EventLog } from './eventLog.js';
import { notificationToEvent, routeThreadId, type ThreadRoute } from './eventMapper.js';
import {
  GameEngineAdvisor,
  type EngineAdvisorAttachment,
} from './gameEngineAdvisor.js';
import { GodotEnvironmentService } from './godotEnvironmentService.js';
import {
  archiveLatestGameplayExperienceReport,
  GameplayExperienceEvaluator,
  type GameplayExperienceReport,
  readLatestGameplayExperienceReport,
  writeGameplayExperienceFailureReport,
} from './gameplayExperienceEvaluator.js';
import {
  GameHarness,
  GAME_HARNESS_TOOLSET_VERSION,
  GameHarnessStoppedError,
  reusableImplementerThreadId,
  type GameHarnessStateEvent,
  type GameHarnessThreadEvent,
  type HostAudioGenerationRequirement,
  type HostDeliveryValidation,
  type HostImageGenerationRequirement,
} from './gameHarness.js';
import { imageGenerationGateFromVerification } from './imageGenerationGate.js';
import { ImageGenerationAttestationStore } from './imageGenerationAttestation.js';
import {
  assertRequiredImageGenerationSkillToggleAllowed,
  resolveRequiredImageGenerationSkill,
} from './imageGenerationSkillPolicy.js';
import { KimiRuntime } from './kimiRuntime.js';
import { ActiveRuntime, ModelConnections, assertConnectionKind, validateConnectionInput } from './modelConnections.js';
import { McpConfigManager } from './mcpConfigManager.js';
import { MediaGenerationService } from './mediaGenerationService.js';
import { configuredMediaProviderDiagnostic } from './mediaProviderDiagnostics.js';
import {
  listMediaProviderPresets,
  MediaProviderStore,
  type MediaProviderSummary,
} from './mediaProviderStore.js';
import { MEDIA_DYNAMIC_TOOLS, MediaToolBroker } from './mediaToolBroker.js';
import { PreviewServer } from './previewServer.js';
import {
  generateAiProjectIcon,
  generateProceduralProjectIcon,
  readProjectIconBytes,
} from './projectIcon.js';
import { generateCodexProjectIcon } from './projectIconAgent.js';
import {
  importProjectReferences,
  isProjectReferencePath,
} from './projectReferenceStore.js';
import {
  ProjectStore,
  resolveEmptyProjectDirectory,
  resolveExistingProjectDirectory,
} from './projectStore.js';
import { describeRecording, parseRecordingBrief, withRecordingFrames } from './recording.js';
import { RecordingProjects, recordingFingerprint, recordingRunPrompt, requestedRecordingAppend, verifyRecordingJourney, verifyRecordingLevels, type RecordingRun } from './recordingDelivery.js';
import { PromptTemplateStore } from './promptTemplateStore.js';
import { verifyVisualAssetCoverage } from './visualAssetCoverage.js';
import { verifyWebProductionBuild } from './webProductionBuild.js';
import {
  synchronizeGodotPresentationPolicy,
  synchronizeWorkspaceHostPolicy,
} from './workspaceTemplate.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const smokeCapture = process.env.NOOBI_SMOKE_CAPTURE?.trim() || null;
if (smokeCapture) {
  app.setPath('userData', resolve('.noobi-smoke/user-data'));
} else {
  // Keep the location used by existing installations before renaming the app.
  app.setName('Noobi.ai');
  app.setPath('userData', app.getPath('userData'));
}
app.setName('Replay Game Studio');

const runtimeRouter = new ActiveRuntime(new CodexAppServer({
  codexHome: join(app.getPath('userData'), 'codex-home'),
}));
const runtime = runtimeRouter.server;
const modelConnections = new ModelConnections(app.getPath('userData'), {
  seal: (value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护暂不可用。');
    return safeStorage.encryptString(value).toString('base64');
  },
  open: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
});
let activeConnection: ModelConnectionKind = 'chatgpt';
let switchingConnection = false;
let connectionStartupError: string | null = null;
let projectCreationCount = 0;
const engineAdvisor = new GameEngineAdvisor(runtime);
const recordingProjects = new RecordingProjects(join(app.getPath('userData'), 'recording-projects'));
let preparedRecording: (RecordingDraft & { notes: string; frames: Buffer[] }) | null = null;
let recordingAnalysis: AbortController | null = null;
const harness = new GameHarness(runtime);
const previews = new PreviewServer();
const playtestPreviews = new PreviewServer();
const gameplayExperienceEvaluator = new GameplayExperienceEvaluator({
  createWindow: (options) => new BrowserWindow(options),
  decodePng: (png) => nativeImage.createFromBuffer(png),
});
const assetStore = new AssetStore();
const threadRoutes = new Map<string, ThreadRoute>();
const threadActivityStages = new Map<string, PipelineStage>();
const backgroundRuns = new Set<Promise<void>>();
const assetIngestionRuns = new Map<string, Set<Promise<void>>>();
const experienceEvaluationRuns = new Map<string, Promise<SharedGameplayExperienceReport | GameplayExperienceReport>>();
const manualExperienceControllers = new Map<string, AbortController>();
const recordingRuns = new Set<string>();
const projectRunReservations = new Set<string>();
const projectDeletionReservations = new Set<string>();
const projectFilesystemAccessCounts = new Map<string, number>();
let projectStore: ProjectStore;
let assetPlanStore: AssetPlanStore;
let eventLog: EventLog;
let godotEnvironmentService: GodotEnvironmentService;
let approvalBroker: ApprovalBroker;
let mediaToolBroker: MediaToolBroker;
let mediaProviderStore: MediaProviderStore;
let mediaGenerationService: MediaGenerationService;
let mcpConfigManager: McpConfigManager;
let promptTemplateStore: PromptTemplateStore;
let imageGenerationAttestations: ImageGenerationAttestationStore;
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;
const mediaProviderTests = new Map<MediaCapability, MediaProviderTestResult>();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.exit(0);
} else {
  void app.whenReady().then(launch).catch((error) => {
    if (smokeCapture) process.stderr.write(`Noobi UI smoke failed: ${asError(error).message}\n`);
    else dialog.showErrorBox('Replay Game Studio 无法启动', asError(error).message);
    app.exit(1);
  });
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.on('activate', () => {
  if (!mainWindow && !shuttingDown) void createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void shutdown().finally(() => app.exit(0));
});

async function launch(): Promise<void> {
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(join(app.getAppPath(), 'build', 'icon.png'));
  }

  const userData = app.getPath('userData');
  const defaultWorkspace = smokeCapture
    ? join(userData, 'smoke-projects')
    : join(homedir(), 'Replay Game Studio Projects');
  projectStore = new ProjectStore({
    storageFile: join(userData, 'projects.json'),
    defaultWorkspace,
  });
  eventLog = new EventLog(join(userData, 'events'));
  assetPlanStore = new AssetPlanStore(join(userData, 'asset-plans.json'));
  godotEnvironmentService = new GodotEnvironmentService({
    storageFile: join(userData, 'godot-environment.json'),
  });
  imageGenerationAttestations = new ImageGenerationAttestationStore(
    join(userData, 'image-generation-attestations.json'),
  );
  mediaProviderStore = new MediaProviderStore(join(userData, 'media-providers.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    seal: (plaintext) => `electron-safe-storage:v1:${safeStorage.encryptString(plaintext).toString('base64')}`,
    open: (sealed) => {
      const prefix = 'electron-safe-storage:v1:';
      if (!sealed.startsWith(prefix)) throw new Error('Unsupported safeStorage envelope');
      const encoded = sealed.slice(prefix.length);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
        throw new Error('Invalid safeStorage envelope');
      }
      const encrypted = Buffer.from(encoded, 'base64');
      if (!encrypted.length || encrypted.toString('base64') !== encoded) {
        throw new Error('Invalid safeStorage envelope');
      }
      return safeStorage.decryptString(encrypted);
    },
  });
  mediaGenerationService = new MediaGenerationService({
    providerStore: mediaProviderStore,
    assetStore,
  });
  promptTemplateStore = new PromptTemplateStore(join(userData, 'prompt-templates.json'));
  mcpConfigManager = new McpConfigManager(runtime);
  approvalBroker = new ApprovalBroker(runtime, (threadId) => threadRoutes.get(threadId)?.projectId ?? null);
  mediaToolBroker = new MediaToolBroker({
    server: runtime,
    assetStore,
    assetPlanStore,
    generationService: mediaGenerationService,
    resolveProject: async (threadId) => {
      const route = threadRoutes.get(threadId);
      if (!route || route.role !== 'implementer') return null;
      const project = await projectStore.get(route.projectId);
      return { id: project.id, root: project.root };
    },
    onAssetsChanged: (projectId, assets) => {
      broadcast('noobi:event:assets', { projectId, assets });
    },
    onAssetPlansChanged: (projectId, assetPlans) => {
      broadcast('noobi:event:asset-plans', { projectId, assetPlans });
    },
    onGeneratedAsset: async (projectId, asset, provider) => {
      const isImage = asset.kind === 'image';
      const isMiniMaxAudio = asset.kind === 'audio'
        && isMiniMaxAudioPreset(provider.presetId);
      if (!isImage && !isMiniMaxAudio) return;
      await imageGenerationAttestations.record({
        projectId,
        relativePath: asset.relativePath,
        sha256: asset.sha256,
        provider: `api:${provider.presetId}:${provider.id}`,
      });
      emitAgentEvent({
        id: randomUUID(),
        projectId,
        kind: 'file',
        title: isImage ? '图片 API 素材已保存' : 'MiniMax 音乐素材已保存',
        message: `${asset.name} 已由 ${provider.displayName} / ${provider.model} 生成并加入素材库。`,
        stage: 'assets',
        timestamp: new Date().toISOString(),
        method: isImage ? 'assets/image-api-generated' : 'assets/audio-api-generated',
      });
    },
  });
  await Promise.all([
    projectStore.init(),
    eventLog.init(),
    assetPlanStore.init(),
    godotEnvironmentService.init(),
    imageGenerationAttestations.init(),
    mediaProviderStore.init(),
    promptTemplateStore.init(),
  ]);
  await recoverInterruptedProjects();
  void backfillProjectIcons();

  bindRuntimeEvents();
  bindHarnessEvents();
  bindIpc();
  await modelConnections.init();
  activeConnection = modelConnections.active;
  if (activeConnection !== 'chatgpt') {
    try {
      await runtimeRouter.replace(await createConnectionRuntime(activeConnection));
    } catch {
      connectionStartupError = '无法恢复当前模型连接，请重新配置或选择其他连接。';
    }
  }
  await ensureSmokeProject();
  await createWindow();
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1510,
    height: 940,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#132c29',
    title: 'Replay Game Studio',
    show: false,
    webPreferences: {
      preload: join(moduleDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//iu.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  const rendererUrl = process.env.NOOBI_RENDERER_URL;
  if (rendererUrl) await window.loadURL(rendererUrl);
  else await window.loadFile(join(moduleDirectory, '../renderer/index.html'));

  if (smokeCapture) await captureSmoke(window, smokeCapture);
}

function bindRuntimeEvents(): void {
  runtime.on('status', (status) => {
    if (status.state !== 'ready') approvalBroker.invalidateAll();
    broadcast('noobi:event:runtime', runtimeStatusForUi(status));
  });
  runtime.on('diagnostic', (message: string) => {
    if (process.env.NOOBI_DEBUG === '1') process.stderr.write(`[codex] ${message}\n`);
  });
  runtime.on('serverRequest', (request) => {
    if (!mediaToolBroker.handle(request)) approvalBroker.handle(request);
  });
  runtime.on('notification', (notification: { method: string; params?: unknown }) => {
    if (notification.method === 'serverRequest/resolved') {
      const requestId = readRequestId(asRecord(notification.params)?.requestId);
      if (requestId !== null) approvalBroker.resolveFromServer(requestId);
    }
    const threadId = routeThreadId(notification);
    if (!threadId) return;
    const route = threadRoutes.get(threadId);
    if (!route) return;
    if (route.role === 'implementer' && notification.method === 'item/completed') {
      const task = ingestGeneratedImage(notification, route.projectId).catch((error) => {
        if (process.env.NOOBI_DEBUG === '1') {
          process.stderr.write(`[assets] ${asError(error).message}\n`);
        }
      });
      trackAssetIngestion(route.projectId, task);
    }
    const currentStage = threadActivityStages.get(threadId)
      ?? (route.role === 'planner' ? 'brief' : route.role === 'reviewer' ? 'verify' : 'code');
    const event = notificationToEvent(notification, route, currentStage);
    if (event) {
      threadActivityStages.set(threadId, event.stage);
      emitAgentEvent(event);
    }
  });

  approvalBroker.on('approval', (approval) => broadcast('noobi:event:approval', approval));
  approvalBroker.on('closed', (token: string) => broadcast('noobi:event:approval-closed', token));
  approvalBroker.on('diagnostic', (message: string) => {
    if (process.env.NOOBI_DEBUG === '1') process.stderr.write(`[approval] ${message}\n`);
  });
  approvalBroker.on('expired', (approval) => {
    if (!approval.projectId) return;
    emitAgentEvent({
      id: randomUUID(),
      projectId: approval.projectId,
      kind: 'approval',
      title: '审批已超时',
      message: '该请求已安全拒绝。',
      stage: 'code',
      timestamp: new Date().toISOString(),
      method: 'approval/expired',
    });
  });
}

function bindHarnessEvents(): void {
  harness.on('thread', (event: GameHarnessThreadEvent) => {
    threadRoutes.set(event.threadId, { projectId: event.projectId, role: event.role });
    threadActivityStages.set(
      event.threadId,
      event.role === 'planner' ? 'brief' : event.role === 'reviewer' ? 'verify' : 'code',
    );
    if (event.role === 'implementer') {
      void updateProject(event.projectId, {
        threadId: event.threadId,
        toolsetVersion: GAME_HARNESS_TOOLSET_VERSION,
      });
    }
  });
  harness.on('threadClosed', ({ threadId }: { threadId: string }) => {
    threadRoutes.delete(threadId);
    threadActivityStages.delete(threadId);
  });
  harness.on('event', (event: AgentEvent) => emitAgentEvent(event));
  harness.on('state', (event: GameHarnessStateEvent) => {
    // Completion is provisional until the host validates all fixed generated-
    // media requirements after pending outputs have been ingested.
    if (event.state === 'completed') return;
    const stage = stageForHarnessState(event);
    const status =
      event.state === 'failed'
          ? 'failed'
          : event.state === 'stopped'
            ? 'stopped'
            : 'running';
    void updateProject(event.projectId, {
      status,
      stage,
      ...(event.threadId ? { threadId: event.threadId } : {}),
      activeTurnId: event.activeTurnId,
      lastError: event.error,
    });
  });
}

async function createConnectionRuntime(kind: ModelConnectionKind, input?: ModelConnectionInput, testProfile?: string): Promise<CodexAppServer> {
  return kind === 'kimi'
    ? new KimiRuntime(join(app.getPath('userData'), 'kimi-code-home'))
    : modelConnections.createCodex(kind, input, testProfile);
}

function assertConnectionIdle(): void {
  if (switchingConnection || recordingAnalysis || projectCreationCount > 0 || projectRunReservations.size
    || backgroundRuns.size || gameIconRuns.size) {
    throw new Error('请先等待当前制作结束，或停止任务，再切换模型连接。');
  }
}

async function switchConnection(kind: ModelConnectionKind, input?: ModelConnectionInput): Promise<RuntimeStatus> {
  assertConnectionIdle();
  switchingConnection = true;
  let next: CodexAppServer | null = null;
  let testProfile: string | null = null;
  try {
    if (!input && kind === activeConnection && !connectionStartupError) return runtimeStatusForUi(await runtime.refresh());
    if (input) {
      testProfile = await mkdtemp(join(tmpdir(), 'noobi-model-test-'));
      next = await createConnectionRuntime(kind, input, testProfile);
      const status = await next.start();
      const model = status.models.find((entry) => entry.isDefault)?.model ?? status.models[0]?.model;
      if (!status.account || !model) throw new Error('供应商没有返回可用模型，请检查 API Key 或模型 ID。');
      const cwd = join(app.getPath('userData'), 'connection-probe');
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const id = await next.startThread({ cwd, model, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
      try {
        const check = await next.runTurn({ threadId: id, cwd, model, approvalPolicy: 'never', timeoutMs: 30_000,
          prompt: 'Reply with OK. Do not call tools.' });
        if (check.status !== 'completed' || !check.text.trim()) throw new Error('模型测试没有完成。请检查权限、额度或连接配置。');
      } finally {
        await next.unsubscribeThread(id).catch(() => undefined);
      }
      await next.stop();
      next = null;
    }
    next = await createConnectionRuntime(kind, input);
    await next.start();
    await modelConnections.use(kind, input);
    await runtimeRouter.replace(next);
    activeConnection = kind;
    connectionStartupError = null;
    next = null;
    const snapshot = runtimeStatusForUi(runtime.status);
    broadcast('noobi:event:runtime', snapshot);
    return snapshot;
  } catch (error) {
    if (input) throw new Error(asError(error).message.replaceAll(input.apiKey, '[已隐藏]').slice(0, 500));
    throw error;
  } finally {
    await next?.stop().catch(() => undefined);
    if (testProfile) await rm(testProfile, { recursive: true, force: true }).catch(() => undefined);
    switchingConnection = false;
  }
}

function bindIpc(): void {
  handle('noobi:bootstrap', async (): Promise<BootstrapPayload> => {
    const projects = await projectStore.list();
    const settings = await projectStore.getSettings();
    if (!connectionStartupError) await runtime.start().catch(() => runtime.status);
    const events = Object.fromEntries(
      await Promise.all(projects.map(async (project) => [project.id, await eventLog.read(project.id)] as const)),
    );
    return { projects, settings, runtime: runtimeStatusForUi(runtime.status), events };
  });

  handle('noobi:model-connections:list', () => modelConnections.list());
  handle('noobi:model-connections:use', (_event, kind: unknown) => {
    assertConnectionKind(kind);
    return switchConnection(kind);
  });
  handle('noobi:model-connections:key', (_event, input: ModelConnectionInput) => {
    const valid = validateConnectionInput(input);
    return switchConnection(valid.kind, valid);
  });
  handle('noobi:runtime:refresh', async () => connectionStartupError
    ? switchConnection(activeConnection)
    : runtimeStatusForUi(await runtime.refresh()));
  handle('noobi:runtime:login', async () => {
    if (connectionStartupError) throw new Error(connectionStartupError);
    if (activeConnection !== 'chatgpt' && activeConnection !== 'kimi') throw new Error('请使用 API Key 连接。');
    const result = await runtime.startLogin();
    const url = result.verificationUrl ?? result.authUrl;
    if (activeConnection === 'chatgpt' && url && /^https:\/\//iu.test(url)) await shell.openExternal(url);
    return result;
  });
  handle('noobi:runtime:logout', async () => {
    assertConnectionIdle();
    if (['openai', 'deepseek', 'bailian'].includes(activeConnection)) {
      const kind = activeConnection;
      await switchConnection('chatgpt');
      await modelConnections.clear(kind);
      return runtimeStatusForUi(runtime.status);
    }
    return runtimeStatusForUi(await runtime.logout());
  });
  handle('noobi:dialog:directory', async () => {
    const settings = await projectStore.getSettings();
    const options: Electron.OpenDialogOptions = {
      title: '选择默认项目存放位置',
      defaultPath: settings.defaultWorkspace,
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('noobi:dialog:project-directory', async () => {
    const settings = await projectStore.getSettings();
    while (true) {
      const options: Electron.OpenDialogOptions = {
        title: '创建或选择游戏项目文件夹',
        message: '这个文件夹将直接保存游戏代码、素材和构建文件，请选择一个空文件夹。',
        buttonLabel: '使用这个文件夹',
        defaultPath: settings.defaultWorkspace,
        properties: ['openDirectory', 'createDirectory'],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return null;
      const selected = result.filePaths[0];
      if (!selected) return null;
      try {
        return await resolveEmptyProjectDirectory(selected);
      } catch (error) {
        const messageOptions: Electron.MessageBoxOptions = {
          type: 'warning',
          title: '请选择空文件夹',
          message: '这个文件夹里已经有内容',
          detail: `${asError(error).message}\n\n你可以返回 Finder 新建一个文件夹，再选择它。`,
          buttons: ['重新选择', '取消'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        };
        const choice = mainWindow
          ? await dialog.showMessageBox(mainWindow, messageOptions)
          : await dialog.showMessageBox(messageOptions);
        if (choice.response === 1) return null;
      }
    }
  });

  handle('noobi:recording:cancel', () => {
    recordingAnalysis?.abort(new Error('已取消录屏分析。'));
  });
  handle('noobi:recording:analyze', async (_event, path: unknown, notes: unknown, model: unknown) => {
    if (typeof path !== 'string' || typeof notes !== 'string' || notes.length > 12_000
      || (model !== null && typeof model !== 'string')) throw new Error('录屏分析参数无效。');
    if (connectionStartupError) throw new Error(connectionStartupError);
    if (recordingAnalysis) throw new Error('已有录屏正在分析。');
    const controller = new AbortController();
    recordingAnalysis = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    preparedRecording = null;
    try {
      const status = await runtime.start();
      if (!status.account) throw new Error('请在设置里连接模型账号或 API Key。');
      const visionModel = activeConnection === 'deepseek'
        ? status.models.find((entry) => entry.model === 'deepseek-flash')?.model ?? model
        : model;
      return await withRecordingFrames(path, signal, async (frames, cwd) => {
        const threadId = await runtime.startThread({ cwd, model: visionModel, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
        try {
          const result = await runtime.runTurn({
            threadId, cwd, model: visionModel, approvalPolicy: 'never', timeoutMs: 45_000, signal,
            localImages: frames.map((frame) => frame.path),
            prompt: [
              '根据按时间排列的游戏录屏图片和玩家补充，提取玩法。只返回 JSON，键为 controls、rules、goal、uncertainty，值均为简明中文。',
              'uncertainty 只写需要玩家确认的核心操作、规则或胜负歧义；若无需确认，返回空字符串。不要猜测关键规则。',
              `图片时间（秒）：${frames.map((frame) => frame.seconds).join('、')}`,
              `玩家补充：${JSON.stringify(notes)}`,
            ].join('\n'),
          });
          if (result.status !== 'completed') throw new Error('录屏分析未完成，请重试。');
          const brief = parseRecordingBrief(result.text);
          const id = randomUUID();
          preparedRecording = { id, brief, notes, frames: await Promise.all(frames.map((frame) => readFile(frame.path))) };
          return { id, brief } satisfies RecordingDraft;
        } finally {
          await runtime.unsubscribeThread(threadId).catch(() => undefined);
        }
      });
    } catch (error) {
      if (signal.aborted) throw new Error(controller.signal.aborted ? '已取消录屏分析。' : '录屏分析超时，请重试。');
      throw error;
    } finally {
      recordingAnalysis = null;
    }
  });

  handle('noobi:project:create', async (
    _event,
    input: CreateProjectInput,
    attachmentPaths: unknown = [],
  ) => {
    if (connectionStartupError) throw new Error(connectionStartupError);
    if (switchingConnection) throw new Error('模型连接正在切换，请稍候。');
    projectCreationCount += 1;
    try {
      const recording = input.recordingDraftId === undefined ? null : preparedRecording;
      if (input.recordingDraftId !== undefined && recording?.id !== input.recordingDraftId) {
        throw new Error('录屏分析已失效，请重新分析。');
      }
      const idea = recording ? describeRecording(recording.brief, recording.notes) : input.idea;
      const attachments = await inspectCreationAttachments(attachmentPaths);
      const projectDirectory = typeof input?.projectDirectory === 'string'
        ? input.projectDirectory
        : '';
      if (!projectDirectory.trim()) throw new Error('请选择游戏项目文件夹');
      const selectedProjectDirectory = await resolveEmptyProjectDirectory(projectDirectory);
      const projectName = basename(selectedProjectDirectory).trim().slice(0, 100);
      if (!projectName) throw new Error('请选择游戏项目文件夹');
      const [settings, godot] = await Promise.all([
        projectStore.getSettings(),
        godotEnvironmentService.refresh(),
      ]);
      const decision = await engineAdvisor.decide({
        cwd: selectedProjectDirectory,
        idea: typeof idea === 'string' ? idea : '',
        model: input?.model,
        effort: settings.defaultEffort,
        attachments: attachments.metadata,
        godot: {
          canCreateProjects: godot.canCreateProjects,
          canExportWeb: godot.canExportProjects && godot.exportTemplates.targets.web,
          version: godot.tool.version,
        },
      });
      if (decision.engine === 'godot' && !godot.canCreateProjects) {
        throw new Error('引擎判断 Agent 选择了 Godot，但 Godot 4 环境尚未就绪；请先打开设置 → 环境管理。');
      }
      const exportGodotStarter = decision.engine === 'godot'
        && godot.canExportProjects
        && godot.exportTemplates.targets.web;
      if (recording) {
        if (preparedRecording?.id !== recording.id) throw new Error('录屏分析已失效，请重新分析。');
        preparedRecording = null;
      }
      const project = await withProceduralIcon(
        await projectStore.create({
          name: projectName,
          idea,
          projectDirectory: selectedProjectDirectory,
          model: input.model,
          engine: decision.engine,
        }),
      );
      await modelConnections.bindProject(project.id, activeConnection);
      if (recording) {
        try {
          await recordingProjects.init(project.id);
          const directory = join(project.root, 'references', 'recording');
          await mkdir(directory, { recursive: true });
          await Promise.all(recording.frames.map((frame, index) =>
            writeFile(join(directory, `frame-${index + 1}.jpg`), frame, { flag: 'wx' })));
        } catch (error) {
          return updateProject(project.id, {
            status: 'failed', stage: 'brief', lastError: `录屏参考资料保存失败：${asError(error).message}`,
          });
        }
      }
      const initialEvent: AgentEvent = {
        id: randomUUID(),
        projectId: project.id,
        kind: 'user',
        title: '游戏创意',
        message: project.idea,
        stage: 'brief',
        timestamp: project.createdAt,
        method: 'project/created',
      };
      emitAgentEvent(initialEvent);
      emitAgentEvent({
        id: randomUUID(),
        projectId: project.id,
        kind: 'assistant',
        title: `引擎规划 · ${decision.engine === 'godot' ? 'Godot 4' : 'Web'}`,
        message: decision.rationale,
        stage: 'brief',
        timestamp: new Date().toISOString(),
        method: 'engine-advisor/selected',
      });
      if (attachments.paths.length > 0) {
        try {
          await importInitialProjectAttachments(project, attachments.paths);
        } catch (error) {
          const message = `附件导入失败：${asError(error).message}`;
          const failed = await updateProject(project.id, {
            status: 'failed',
            stage: 'assets',
            lastError: message,
          });
          broadcast('noobi:event:project', failed);
          return failed;
        }
      }
      if (project.engine === 'godot') {
        try {
          await verifyGodotProject(project, exportGodotStarter);
        } catch (error) {
          const failed = await updateProject(project.id, {
            status: 'failed',
            stage: 'verify',
            lastError: asError(error).message,
          });
          return failed;
        }
      }
      broadcast('noobi:event:project', project);
      return project;
    } finally {
      projectCreationCount -= 1;
    }
  });

  handle('noobi:project:rename', (_event, projectId: string, name: unknown) => {
    const id = validateProjectId(projectId);
    if (typeof name !== 'string') throw new Error('游戏名称必须是文字');
    if (projectDeletionReservations.has(id)) throw new Error('项目正在删除');
    return updateProject(id, { name });
  });
  handle('noobi:project:pin', async (_event, projectId: string, pinned: boolean) => {
    if (typeof pinned !== 'boolean') throw new Error('无效的置顶状态');
    const id = validateProjectId(projectId);
    if (projectDeletionReservations.has(id)) throw new Error('项目正在删除');
    return updateProject(id, { pinned });
  });
  handle('noobi:project:delete', async (_event, projectId: string) => {
    const id = validateProjectId(projectId);
    if (projectDeletionReservations.has(id)) throw new Error('项目正在删除');
    projectDeletionReservations.add(id);
    try {
      const project = await projectStore.get(id);
      if (
        isProjectBusyForMutation(project.id, { ignoreDeletionReservation: true })
        || (projectFilesystemAccessCounts.get(project.id) ?? 0) > 0
      ) {
        throw new Error('项目仍在运行或写入，请停止当前任务后再删除');
      }
      await Promise.allSettled([previews.stop(project.id), playtestPreviews.stop(project.id)]);
      const deleted = await projectStore.delete(project.id);
      const cleanup = await Promise.allSettled([
        eventLog.remove(project.id),
        recordingProjects.delete(project.id),
        modelConnections.forgetProject(project.id),
        assetPlanStore.removeProject(project.id),
        imageGenerationAttestations.removeProject(project.id),
      ]);
      if (process.env.NOOBI_DEBUG === '1') {
        cleanup.forEach((result) => {
          if (result.status === 'rejected') {
            process.stderr.write(`[project-delete] sidecar cleanup failed: ${asError(result.reason).message}\n`);
          }
        });
      }
      for (const [threadId, route] of threadRoutes) {
        if (route.projectId !== project.id) continue;
        threadRoutes.delete(threadId);
        threadActivityStages.delete(threadId);
      }
      return deleted;
    } finally {
      projectDeletionReservations.delete(id);
    }
  });

  handle('noobi:recording:confirm', async (_event, projectId: string, releaseId: unknown) => {
    validateProjectId(projectId);
    if (isProjectBusyForMutation(projectId)) throw new Error('当前正在制作，请稍后确认。');
    projectRunReservations.add(projectId);
    try {
      await projectStore.get(projectId);
      const current = await recordingProjects.read(projectId);
      if (!current?.releaseId || current.releaseId !== releaseId || current.levelCount !== 2) {
        throw new Error('请先试玩最新的两关版本。');
      }
      const confirmed = { ...current, confirmed: true };
      await recordingProjects.save(projectId, confirmed);
      return confirmed;
    } finally {
      projectRunReservations.delete(projectId);
    }
  });

  handle('noobi:project:run', async (_event, input: RunProjectInput) => {
    validateRunInput(input);
    if (connectionStartupError) throw new Error(connectionStartupError);
    let project = await projectStore.get(input.projectId);
    if (switchingConnection || isProjectBusyForMutation(project.id)) {
      throw new Error('项目正在制作或模型连接正在切换，请稍候。');
    }
    projectRunReservations.add(project.id);
    try {
      const baseline = await recordingProjects.read(project.id);
      const request = input.recordingAppend;
      const requestedCount = baseline ? requestedRecordingAppend(input.prompt) : null;
      const appendWithoutCount = baseline && !request && /^(?:请\s*)?(?:追加|加|新增|再做|再生成)(?:新)?关卡[。！!]?$/u.test(input.prompt.trim());
      if (appendWithoutCount) {
        throw new Error(baseline.confirmed ? '请在预览区选择追加数量。' : '请先试玩两关并点击「确认玩法」。');
      }
      if (request && !baseline) throw new Error('该项目不支持录屏加关流程。');
      if (request && baseline?.lastRequestId === request.requestId) return project;
      if ((request || requestedCount !== null) && !baseline?.confirmed) {
        throw new Error('请先试玩两关并点击「确认玩法」，再追加关卡。');
      }
      if (request && baseline?.releaseId !== request.releaseId) {
        throw new Error('试玩版本已更新，请重新选择追加。');
      }
      const count = request?.count ?? requestedCount;
      if (count !== null && (!Number.isInteger(count) || count < 1 || count > 20)) {
        throw new Error('每次可追加 1–20 关。');
      }
      const recordingRun: RecordingRun | undefined = baseline ? {
        baseline,
        ...(count === null ? {} : { append: {
          count,
          requestId: request?.requestId ?? (baseline.pendingAppend?.count === count
            ? baseline.pendingAppend.requestId : randomUUID()),
        } }),
      } : undefined;
      const locatedProject = await ensureProjectLocation(project, { ignoreRunReservation: true });
      if (!locatedProject) throw new Error('尚未重新连接项目文件夹，本次制作没有启动。');
      project = locatedProject;
      if (project.engine === 'godot') {
        const godot = await godotEnvironmentService.refresh();
        if (!godot.canCreateProjects) {
          throw new Error('Godot 4 环境未就绪；请先在设置 → 环境管理中修复引擎路径。');
        }
        if (!godot.canExportProjects || !godot.exportTemplates.targets.web) {
          throw new Error(
            `Godot ${godot.tool.version ?? '4'} 的 Web Export Templates 未就绪；请先在设置 → 环境管理中安装精确匹配的导出模板。`,
          );
        }
      }
      const status = await runtime.start();
      if (!status.account) throw new Error('请在设置里连接模型账号或 API Key，再开始制作。');
      const settings = await projectStore.getSettings();
      const sameConnection = modelConnections.getProject(project.id) === activeConnection;
      const model = [input.model, sameConnection ? project.model : null, settings.defaultModel]
        .find((value) => value && status.models.some((entry) => entry.model === value))
        ?? defaultModel(status.models);
      if (!model) throw new Error('当前连接没有可用的制作模型。');
      const targetFrameRate = project.targetFrameRate;
      const imageProvider = activeMediaProvider('image');
      const audioProvider = activeMediaProvider('audio');
      const miniMaxMusicRequired = Boolean(
        audioProvider && isMiniMaxAudioPreset(audioProvider.presetId),
      );
      const imageGenerationSkill = await resolveImageGenerationSkill();
      if (!imageProvider && (!status.capabilities.imageGeneration || !imageGenerationSkill)) {
        throw new Error('没有可用的图像 API，当前 Codex 运行时也没有 ImageGen 能力；请先在设置中配置图像 API 或修复 Codex ImageGen');
      }
      const imageGenerationRequirement = await resolveHostImageGenerationRequirement(project);
      const audioGenerationRequirement = await resolveHostAudioGenerationRequirement(
        project,
        miniMaxMusicRequired,
      );
      const promptAdditions = await promptTemplateStore.enabledAdditions();
      const restoredThread = sameConnection ? project.threadId : modelConnections.getProjectThread(project.id, activeConnection);
      if (!sameConnection) {
        await updateProject(project.id, { threadId: null });
        await modelConnections.bindProject(project.id, activeConnection, project.threadId);
      }
      const prepared = await updateProject(project.id, {
        model,
        threadId: restoredThread,
        lastError: null,
      });
      try {
        await synchronizeWorkspaceHostPolicy(prepared.root, prepared);
        if (prepared.engine === 'godot') {
          await synchronizeGodotPresentationPolicy(prepared.root);
        }
      } catch (error) {
        const message = `无法同步游戏引擎展示策略：${asError(error).message}`;
        await updateProject(project.id, {
          status: 'failed',
          activeTurnId: null,
          lastError: message,
        }).catch(() => undefined);
        throw new Error(message);
      }
      await archiveLatestGameplayExperienceReport(prepared.root).catch((error) => {
        throw new Error(`无法归档上一轮体验评测：${asError(error).message}`);
      });
      if (recordingRun?.append) {
        await recordingProjects.save(project.id, { ...recordingRun.baseline, pendingAppend: recordingRun.append });
      }
      const running = await updateProject(project.id, {
        status: 'running',
        stage: 'brief',
        activeTurnId: null,
        lastError: null,
      });
      emitAgentEvent({
        id: randomUUID(),
        projectId: project.id,
        kind: 'user',
        title: '制作指令',
        message: input.prompt.trim(),
        stage: running.stage,
        timestamp: new Date().toISOString(),
        method: 'harness/user-request',
      });
      trackBackgroundRun(
        executeHarness(
          running,
          recordingRun ? recordingRunPrompt(input.prompt.trim(), running.idea, recordingRun) : input.prompt.trim(),
          model,
          input.effort ?? settings.defaultEffort,
          imageGenerationSkill,
          imageGenerationRequirement,
          audioGenerationRequirement,
          targetFrameRate,
          imageProvider ? 'configured-api' : 'codex-imagegen',
          promptAdditions,
          recordingRun,
        ),
      );
      return running;
    } finally {
      projectRunReservations.delete(project.id);
    }
  });

  handle('noobi:project:stop', async (_event, projectId: string) => {
    validateProjectId(projectId);
    if (recordingRuns.has(projectId) && !harness.isRunning(projectId)) {
      return projectStore.get(projectId);
    }
    await harness.stop(projectId);
    const project = await projectStore.get(projectId);
    return project.status === 'running'
      ? updateProject(projectId, { status: 'stopped', activeTurnId: null })
      : project;
  });
  handle('noobi:project:reveal', async (_event, projectId: string) => {
    const id = validateProjectId(projectId);
    const release = acquireProjectFilesystemAccess(id);
    try {
      const storedProject = await projectStore.get(id);
      const project = await ensureProjectLocation(storedProject);
      if (!project) return null;
      const error = await shell.openPath(project.root);
      if (error) throw new Error(error);
      return project;
    } finally {
      release();
    }
  });
  handle('noobi:project:assets:import', async (_event, projectId: string) => {
    const id = validateProjectId(projectId);
    const release = acquireProjectFilesystemAccess(id);
    try {
      const project = await projectStore.get(id);
      if (isProjectBusyForMutation(project.id)) {
        throw new Error('Agent 正在写入项目，请等待当前任务结束后再导入素材');
      }
      const options: Electron.OpenDialogOptions = {
        title: '导入游戏素材',
        defaultPath: project.root,
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '支持的游戏素材', extensions: ['png', 'jpg', 'jpeg', 'webp', 'wav', 'mp3', 'ogg', 'glb'] },
          { name: '图像', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          { name: '音频', extensions: ['wav', 'mp3', 'ogg'] },
          { name: '3D 模型', extensions: ['glb'] },
        ],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return assetStore.list(project.id, project.root);
      }
      return importProjectAssetPaths(project, result.filePaths, '图像、音频或 3D 素材');
    } finally {
      release();
    }
  });
  handle('noobi:project:assets:import-paths', async (_event, projectId: string, paths: unknown) => {
    const id = validateProjectId(projectId);
    const release = acquireProjectFilesystemAccess(id);
    try {
      const project = await projectStore.get(id);
      if (isProjectBusyForMutation(project.id)) {
        throw new Error('Agent 正在写入项目，请等待当前任务结束后再拖入图片');
      }
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 50) {
        throw new Error('一次只能拖入 1–50 张图片');
      }
      const imagePaths = paths.map((path) => {
        if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4_000 || path.includes('\0')) {
          throw new Error('拖入图片路径无效');
        }
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase())) {
          throw new Error('拖拽仅支持 PNG、JPEG 和 WebP 图片');
        }
        return path;
      });
      return importProjectAssetPaths(project, imagePaths, '拖入图片');
    } finally {
      release();
    }
  });
  handle('noobi:project:asset-plan:retry', async (_event, projectId: string, planId: string) => {
    const project = await projectStore.get(validateProjectId(projectId));
    if (isProjectBusyForMutation(project.id)) {
      throw new Error('Agent 正在写入项目，请等待当前任务结束后再重新生成素材');
    }
    const queued = await assetPlanStore.queue(project.id, validateAssetPlanId(planId));
    const assetPlans = await assetPlanStore.list(project.id);
    broadcast('noobi:event:asset-plans', { projectId: project.id, assetPlans });
    emitAgentEvent({
      id: randomUUID(),
      projectId: project.id,
      kind: 'lifecycle',
      title: '素材已加入重新生成队列',
      message: `${queued.name} 将在下一次 Agent 执行中重新生成。`,
      stage: 'assets',
      timestamp: new Date().toISOString(),
      method: 'assets/plan-retry-queued',
    });
    return queued;
  });
  handle('noobi:project:inspect', async (_event, projectId: string): Promise<ProjectInspectorPayload> => {
    const id = validateProjectId(projectId);
    const release = acquireProjectFilesystemAccess(id);
    try {
      const project = await projectStore.get(id);
      if (!await projectDirectoryAvailable(project)) {
        throw new Error('项目文件夹已被移动或改名。请点击右上角文件夹按钮，选择改名后的文件夹重新连接。');
      }
      const useSourceAssetOverlay = project.status !== 'completed';
      const recording = await recordingProjects.read(id);
      const [files, previewUrl, assets, experienceReport] = await Promise.all([
        projectStore.listProjectFiles(project.id),
        recording ? (recording.releaseId
          ? previews.start(project.id, recordingProjects.releaseRoot(project.id, recording.releaseId), {
              directory: 'build', sourceFallback: false, sourceAssetOverlay: false,
              hideGodotSplash: project.engine === 'godot',
            }).catch(() => '')
          : Promise.resolve(''))
          : project.engine === 'godot'
          ? previews.start(project.id, project.root, {
              directory: 'build/web',
              sourceFallback: false,
              hideGodotSplash: true,
              sourceAssetOverlay: useSourceAssetOverlay,
            }).catch(() => '')
          : previews.start(project.id, project.root, {
              directory: 'dist',
              sourceFallback: project.status !== 'completed',
              sourceAssetOverlay: useSourceAssetOverlay,
            }).catch(() => ''),
        assetStore.list(project.id, project.root),
        readLatestGameplayExperienceReport(project.root).catch(() => null),
      ]);
      const [assetPlans, imageVerification] = await Promise.all([
        assetPlanStore.reconcile(project.id, project.root, assets),
        verifyHostGeneratedImage(project, assets),
      ]);
      const imageGenerationGate = imageGenerationGateFromVerification(imageVerification);
      return { files, previewUrl, assets, assetPlans, imageGenerationGate, experienceReport, ...(recording ? { recording } : {}) };
    } finally {
      release();
    }
  });
  handle('noobi:project:experience:evaluate', async (_event, projectId: string) => {
    const project = await projectStore.get(validateProjectId(projectId));
    if (isProjectBusyForMutation(project.id)) {
      throw new Error('Agent 正在写入或启动项目，请等待当前任务结束后再进行体验评测');
    }
    if (experienceEvaluationRuns.has(project.id)) {
      throw new Error('该项目已有正在执行的体验评测');
    }
    const controller = new AbortController();
    manualExperienceControllers.set(project.id, controller);
    try {
      return await evaluateProjectExperience(project, {
        signal: controller.signal,
        preflight: 'required',
      });
    } finally {
      if (manualExperienceControllers.get(project.id) === controller) {
        manualExperienceControllers.delete(project.id);
      }
    }
  });
  handle('noobi:project:experience:cancel', (_event, projectId: string) => {
    const id = validateProjectId(projectId);
    manualExperienceControllers.get(id)?.abort();
  });
  handle('noobi:project:read', async (_event, projectId: string, relativePath: string) => {
    const id = validateProjectId(projectId);
    if (typeof relativePath !== 'string' || relativePath.length > 4_000) {
      throw new Error('无效的项目文件路径');
    }
    const release = acquireProjectFilesystemAccess(id);
    try {
      return await projectStore.readProjectFile(id, relativePath);
    } finally {
      release();
    }
  });
  handle('noobi:project:icon', async (_event, projectId: string): Promise<ProjectIconData | null> => {
    const id = validateProjectId(projectId);
    const release = acquireProjectFilesystemAccess(id);
    try {
      const project = await projectStore.get(id);
      if (!project.icon) return null;
      const bytes = await readProjectIconBytes(project);
      if (!bytes) return null;
      return {
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
        updatedAt: project.icon.updatedAt,
      };
    } finally {
      release();
    }
  });
  handle('noobi:project:noobi-pack:save', (
    _event,
    projectId: string,
    packId: unknown,
  ) => {
    const id = validateProjectId(projectId);
    if (packId !== null && !isNoobiPackId(packId)) {
      throw new Error('无效的主题包');
    }
    return updateProject(id, { noobiPackOverrideId: packId });
  });
  handle('noobi:project:noobi-crew:save', (
    _event,
    projectId: string,
    crew: unknown,
  ) => {
    const id = validateProjectId(projectId);
    if (crew !== null && !isNoobiCrew(crew)) throw new Error('无效的协作编队');
    return updateProject(id, {
      noobiCrewOverride: crew === null
        ? null
        : crew.map(({ packId, role }: NoobiCrewMember) => ({ packId, role })),
    });
  });
  handle('noobi:settings:save', (_event, patch: Partial<AppSettings>) =>
    projectStore.saveSettings(validateSettingsPatch(patch)),
  );
  handle('noobi:environment:get', () => environmentStatusSnapshot());
  handle('noobi:environment:refresh', async () => {
    await Promise.all([
      godotEnvironmentService.refresh(),
      runtime.refresh().catch(() => runtime.status),
    ]);
    return environmentStatusSnapshot();
  });
  handle('noobi:environment:godot:choose', async () => {
    const status = await godotEnvironmentService.getStatus();
    const options: Electron.OpenDialogOptions = {
      title: '选择 Godot 4 可执行文件或 Godot.app',
      defaultPath: status.tool.configuredPath
        ?? status.tool.binaryPath
        ?? (process.platform === 'darwin' ? '/Applications' : homedir()),
      properties: ['openFile'],
      ...(process.platform === 'win32'
        ? { filters: [{ name: 'Godot Engine', extensions: ['exe'] }] }
        : {}),
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle('noobi:environment:godot:save', async (_event, binaryPath: string | null) => {
    if (binaryPath !== null && typeof binaryPath !== 'string') {
      throw new Error('Godot 可执行文件路径无效');
    }
    await godotEnvironmentService.saveBinaryPath(binaryPath);
    return environmentStatusSnapshot();
  });
  handle('noobi:extensions:get', async (): Promise<ExtensionSettingsSnapshot> => {
    const [skills, mcpServers, promptTemplates] = await Promise.all([
      listSkillSettings(),
      listMcpSettings(),
      listPromptSettings(),
    ]);
    return {
      mediaProviders: listMediaProviderSettings(),
      skills,
      mcpServers,
      promptTemplates,
    };
  });
  handle('noobi:media-provider:save', async (_event, input: SaveMediaProviderInput) => {
    const normalized = validateMediaProviderInput(input);
    // Reuse secrets only for the exact same preset. Carrying an omitted key
    // from one vendor to another could disclose it to the wrong endpoint.
    const existing = mediaProviderStore.list(normalized.capability)
      .find((provider) => provider.presetId === normalized.provider)
      ?? null;
    const saved = await mediaProviderStore.upsert({
      ...(existing ? { id: existing.id } : {}),
      presetId: normalized.provider,
      displayName: listMediaProviderPresets(normalized.capability)
        .find((preset) => preset.id === normalized.provider)?.label,
      endpoint: normalized.endpoint,
      model: normalized.model,
      ...(normalized.apiKey === undefined ? {} : { apiKey: normalized.apiKey }),
      enabled: normalized.enabled,
      setActive: normalized.enabled,
    });
    mediaProviderTests.delete(normalized.capability);
    broadcast('noobi:event:runtime', runtimeStatusForUi(runtime.status));
    return mediaProviderSetting(saved);
  });
  handle('noobi:media-provider:test', async (_event, capability: MediaCapability) => {
    const kind = validateMediaCapability(capability);
    const started = Date.now();
    const provider = activeMediaProvider(kind);
    let ok = Boolean(provider);
    let message = ok
      ? configuredMediaProviderDiagnostic(provider!.displayName)
      : kind === 'image' && runtime.status.capabilities.imageGeneration
        ? '未发现可用图像 API；制作时将回退 Codex ImageGen。'
        : '当前服务未启用，或缺少所需 API Key。';
    if (kind === 'audio' && (provider?.presetId === 'minimax-audio' || provider?.presetId === 'minimax-audio-cn')) {
      try {
        const probe = await mediaGenerationService.probeActiveAudioProvider();
        ok = probe.outcome === 'ready';
        message = probe.outcome === 'ready'
          ? 'MiniMax Speech 鉴权与短音频探测通过；Music 3.0 的账户资格将在首次实际音乐生成时确认。'
          : probe.outcome === 'not-configured'
            ? 'MiniMax 音频服务未启用，或缺少所需 API Key。'
            : '当前音频服务不支持在线鉴权探测。';
      } catch (error) {
        ok = false;
        message = `MiniMax Speech 连通性检查失败：${asError(error).message}`;
      }
    }
    const result: MediaProviderTestResult = {
      capability: kind,
      ok,
      message,
      latencyMs: Date.now() - started,
      testedAt: new Date().toISOString(),
    };
    mediaProviderTests.set(kind, result);
    return result;
  });
  handle('noobi:skills:list', () => listSkillSettings());
  handle('noobi:skills:set-enabled', async (_event, input: { id: string; enabled: boolean }) => {
    if (!input || typeof input !== 'object' || typeof input.id !== 'string' || typeof input.enabled !== 'boolean') {
      throw new Error('无效的 Skill 设置');
    }
    const skills = await runtime.listSkills({ forceReload: true });
    const selected = skills.find((skill) => skill.path === input.id);
    if (!selected) throw new Error('该 Skill 不在当前 Codex 技能目录中');
    await assertRequiredImageGenerationSkillToggleAllowed(
      runtime.status.codexHome,
      selected,
      input.enabled,
    );
    await runtime.setSkillEnabled({ path: selected.path }, input.enabled);
    const refreshed = await listSkillSettings();
    const result = refreshed.find((skill) => skill.id === selected.path);
    if (!result) throw new Error('Skill 状态刷新失败');
    return result;
  });
  handle('noobi:mcp:list', () => listMcpSettings());
  handle('noobi:mcp:save', async (_event, input: SaveMcpServerInput) => {
    await mcpConfigManager.save(input);
    const result = (await listMcpSettings()).find((server) => server.id === input.id);
    if (!result) throw new Error('MCP Server 保存后未出现在 Codex 配置中');
    return result;
  });
  handle('noobi:mcp:remove', async (_event, id: string) => {
    await mcpConfigManager.remove(id);
  });
  handle('noobi:prompts:list', () => listPromptSettings());
  handle('noobi:prompts:save', async (_event, input: {
    id: PromptTemplateId;
    content: string;
    enabled: boolean;
  }) => promptTemplateStore.save(input));
  handle('noobi:prompts:reset', (_event, id: PromptTemplateId) => promptTemplateStore.reset(id));
  handle(
    'noobi:approval:resolve',
    (_event, token: string, decision: ApprovalDecision, answers?: ApprovalAnswers): void => {
      if (typeof token !== 'string' || token.length > 200) throw new Error('无效的审批令牌');
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) {
        throw new Error('无效的审批决定');
      }
      approvalBroker.resolve(token, decision, answers);
    },
  );
}

async function importProjectAssetPaths(
  project: ProjectRecord,
  paths: readonly string[],
  description: string,
): Promise<GameAssetRecord[]> {
  await assetStore.importFiles(project.id, project.root, [...paths]);
  const assets = await assetStore.list(project.id, project.root);
  broadcast('noobi:event:assets', { projectId: project.id, assets });
  emitAgentEvent({
    id: randomUUID(),
    projectId: project.id,
    kind: 'file',
    title: '素材已导入',
    message: `已安全导入 ${paths.length} 个${description}。`,
    stage: 'assets',
    timestamp: new Date().toISOString(),
    method: 'assets/imported',
  });
  return assets;
}

const CREATION_ATTACHMENT_MIME_TYPES = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.glb', 'model/gltf-binary'],
  ['.pdf', 'application/pdf'],
  ['.md', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
]);

async function inspectCreationAttachments(value: unknown): Promise<{
  paths: string[];
  metadata: EngineAdvisorAttachment[];
}> {
  if (!Array.isArray(value) || value.length > 50) throw new Error('一次最多上传 50 个附件');
  const paths: string[] = [];
  const metadata: EngineAdvisorAttachment[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate) || candidate.length > 4_000 || candidate.includes('\0')) {
      throw new Error('上传附件路径无效');
    }
    const extension = extname(candidate).toLowerCase();
    const mimeType = CREATION_ATTACHMENT_MIME_TYPES.get(extension);
    if (!mimeType) throw new Error(`不支持的附件格式：${extension || '无扩展名'}`);
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0) {
      throw new Error(`上传附件必须是非空普通文件：${basename(candidate)}`);
    }
    paths.push(candidate);
    metadata.push({
      name: basename(candidate).slice(0, 180),
      extension,
      mimeType,
      size: info.size,
    });
  }
  return { paths, metadata };
}

async function importInitialProjectAttachments(
  project: ProjectRecord,
  paths: readonly string[],
): Promise<void> {
  const assetPaths = paths.filter((path) => !isProjectReferencePath(path));
  const referencePaths = paths.filter(isProjectReferencePath);
  if (assetPaths.length > 0) {
    await importProjectAssetPaths(project, assetPaths, '图片、音频或 3D 素材');
  }
  if (referencePaths.length > 0) {
    const references = await importProjectReferences(project.root, referencePaths);
    emitAgentEvent({
      id: randomUUID(),
      projectId: project.id,
      kind: 'file',
      title: '参考文件已导入',
      message: `已安全导入 ${references.length} 个参考文件到 references/uploads；内容视为不可信输入。`,
      stage: 'brief',
      timestamp: new Date().toISOString(),
      method: 'references/imported',
    });
  }
}

function listMediaProviderSettings(): MediaProviderSetting[] {
  return (['image', 'audio', 'model3d'] as const).map((capability) => {
    const providers = mediaProviderStore.list(capability);
    const provider = providers.find((candidate) => candidate.active) ?? providers[0] ?? null;
    if (provider) return mediaProviderSetting(provider);
    const preset = listMediaProviderPresets(capability)[0]!;
    return {
      capability,
      provider: preset.id,
      model: preset.defaultModel,
      endpoint: preset.defaultEndpoint ?? '',
      enabled: false,
      hasApiKey: false,
      keyHint: null,
      status: 'unconfigured',
      statusMessage: capability === 'image'
        ? '未配置外部 API；将使用 Codex ImageGen。'
        : '尚未配置生成服务。',
      lastTestedAt: null,
    };
  });
}

function mediaProviderSetting(provider: MediaProviderSummary): MediaProviderSetting {
  const test = mediaProviderTests.get(provider.kind);
  const usable = provider.active
    && provider.enabled
    && (provider.auth === 'none' || provider.hasApiKey);
  return {
    capability: provider.kind,
    provider: provider.presetId,
    model: provider.model,
    endpoint: provider.endpoint,
    enabled: provider.enabled,
    hasApiKey: provider.hasApiKey,
    keyHint: null,
    status: test ? (test.ok ? 'ready' : 'error') : usable ? 'untested' : 'unconfigured',
    statusMessage: test?.message
      ?? (usable ? '已配置；等待实际生成验证。' : '服务未启用或缺少 API Key。'),
    lastTestedAt: test?.testedAt ?? null,
  };
}

function activeMediaProvider(kind: MediaCapability): MediaProviderSummary | null {
  const provider = mediaProviderStore.list(kind).find((candidate) => candidate.active) ?? null;
  if (!provider || !provider.enabled || (provider.auth !== 'none' && !provider.hasApiKey)) return null;
  return provider;
}

function isMiniMaxAudioPreset(presetId: string): boolean {
  return presetId === 'minimax-audio' || presetId === 'minimax-audio-cn';
}

function validateMediaCapability(value: unknown): MediaCapability {
  if (value !== 'image' && value !== 'audio' && value !== 'model3d') {
    throw new Error('未知媒体能力');
  }
  return value;
}

function validateMediaProviderInput(input: SaveMediaProviderInput): SaveMediaProviderInput {
  if (!input || typeof input !== 'object') throw new Error('无效的媒体服务设置');
  const capability = validateMediaCapability(input.capability);
  if (typeof input.provider !== 'string'
    || !listMediaProviderPresets(capability).some((preset) => preset.id === input.provider)) {
    throw new Error('媒体服务提供商与能力类型不匹配');
  }
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200) {
    throw new Error('媒体模型 ID 无效');
  }
  if (typeof input.endpoint !== 'string' || input.endpoint.length > 2_000) {
    throw new Error('媒体 API Endpoint 无效');
  }
  if (typeof input.enabled !== 'boolean') throw new Error('媒体服务 enabled 无效');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 16_384)) {
    throw new Error('媒体 API Key 无效');
  }
  return {
    ...input,
    capability,
    provider: input.provider,
    model: input.model.trim(),
    endpoint: input.endpoint.trim(),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey.trim() }),
  };
}

async function listSkillSettings(): Promise<SkillSetting[]> {
  const skills = await runtime.listSkills({ forceReload: false });
  const unique = new Map<string, SkillSetting>();
  for (const skill of skills) {
    if (!skill.path || unique.has(skill.path)) continue;
    // Codex 官方插件缓存（Canva/Figma 等）与游戏制作无关：不展示、不加载。
    if (skill.path.includes(`${sep}plugins${sep}`)) continue;
    const source: SkillSetting['source'] = skill.scope === 'system' || skill.scope === 'admin'
      ? 'built-in'
      : skill.scope === 'repo'
        ? 'workspace'
        : 'user';
    unique.set(skill.path, {
      id: skill.path,
      name: skill.name,
      description: skill.description,
      source,
      path: skill.path,
      enabled: skill.enabled,
    });
  }
  return [...unique.values()].sort((left, right) =>
    Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name));
}

async function listMcpSettings(): Promise<McpServerSetting[]> {
  return (await mcpConfigManager.list()).map((server) => ({
    id: server.id,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    enabled: server.enabled,
    bearerTokenEnvVar: server.bearerTokenEnvVar,
    status: server.connected ? 'connected' : 'stopped',
    statusMessage: server.connected
      ? `${server.toolCount} 个工具 · ${server.authStatus}`
      : server.enabled
        ? '尚未建立连接；保存后已请求 Codex 重载。'
        : '已停用',
  }));
}

async function listPromptSettings(): Promise<PromptTemplateSetting[]> {
  return promptTemplateStore.list();
}

function runtimeStatusForUi(status: RuntimeStatus): RuntimeStatus {
  return {
    ...status,
    connection: activeConnection,
    ...(connectionStartupError ? { state: 'error' as const, error: connectionStartupError, account: null, models: [] } : {}),
    capabilities: {
      ...status.capabilities,
      externalImageGeneration: Boolean(mediaProviderStore && activeMediaProvider('image')),
    },
  };
}

async function environmentStatusSnapshot(): Promise<EnvironmentStatusSnapshot> {
  const godot = await godotEnvironmentService.getStatus();
  const nodeTool: EnvironmentToolStatus = {
    id: 'node',
    label: 'Node.js',
    state: 'ready',
    version: process.version,
    binaryPath: process.execPath,
    configuredPath: null,
    source: 'process',
    message: `Electron 内置 Node.js ${process.version} 已就绪。`,
  };
  const codexTool = codexEnvironmentTool(runtime.status);
  const tools = [nodeTool, codexTool, godot.tool];
  const canCreateGodotProjects = tools.every((tool) => tool.state === 'ready')
    && godot.canCreateProjects;
  const canExportGodotProjects = canCreateGodotProjects && godot.canExportProjects;
  const state: EnvironmentStatusSnapshot['state'] = !canCreateGodotProjects
    ? 'blocked'
    : !canExportGodotProjects || godot.exportTemplates.issues.length > 0
      ? 'attention'
      : 'ready';
  return {
    state,
    tools,
    exportTemplates: godot.exportTemplates,
    canCreateGodotProjects,
    canExportGodotProjects,
    checkedAt: new Date().toISOString(),
  };
}

function codexEnvironmentTool(status: RuntimeStatus): EnvironmentToolStatus {
  const configuredPath = process.env.NOOBI_CODEX_BIN?.trim() || null;
  const state: EnvironmentToolStatus['state'] = status.state === 'error'
    ? 'error'
    : !status.binaryPath
      ? 'missing'
      : status.version
        ? 'ready'
        : 'incompatible';
  const source: EnvironmentToolStatus['source'] = configuredPath
    ? 'configured'
    : status.binaryPath && /(?:node_modules[/\\]@openai[/\\]codex|ChatGPT\.app|Codex\.app)/u.test(status.binaryPath)
      ? 'bundled'
      : status.binaryPath
        ? 'path'
        : null;
  const message = state === 'ready'
    ? `Codex ${status.version} 已就绪。`
    : status.error
      ? status.error
      : '未检测到可用的 Codex App Server。';
  return {
    id: 'codex',
    label: 'Codex App Server',
    state,
    version: status.version,
    binaryPath: status.binaryPath,
    configuredPath,
    source,
    message,
  };
}

async function executeHarness(
  project: ProjectRecord,
  prompt: string,
  model: string | null,
  effort: string,
  imageGenerationSkill: { name: string; path: string } | null,
  imageGenerationRequirement: HostImageGenerationRequirement,
  audioGenerationRequirement: HostAudioGenerationRequirement,
  targetFrameRate: ProjectRecord['targetFrameRate'],
  imageGenerationRoute: 'configured-api' | 'codex-imagegen',
  promptAdditions: Parameters<GameHarness['run']>[0]['promptAdditions'],
  recordingRun?: RecordingRun,
): Promise<void> {
  if (recordingRun) recordingRuns.add(project.id);
  let candidate: string | null = null;
  const output = join(project.root, project.engine === 'godot' ? 'build/web' : 'dist');
  try {
    const result = await harness.run({
      projectId: project.id,
      cwd: project.root,
      prompt: activeConnection === 'kimi'
        ? `${prompt}\n\nNoobi host media tools are available through the noobi-media MCP server. Use its tools when the production contract names a Noobi media tool.`
        : prompt,
      model,
      effort,
      threadId: reusableImplementerThreadId(project.threadId, project.toolsetVersion),
      dynamicTools: MEDIA_DYNAMIC_TOOLS,
      ...(imageGenerationSkill ? { imageGenerationSkill } : {}),
      imageGenerationRequirement,
      audioGenerationRequirement,
      imageGenerationRoute,
      targetFrameRate,
      promptAdditions,
      refreshImageGenerationRequirement: async () => {
        await waitForAssetIngestions(project.id);
        return resolveHostImageGenerationRequirement(project);
      },
      refreshAudioGenerationRequirement: async () => {
        await waitForAssetIngestions(project.id);
        return resolveHostAudioGenerationRequirement(
          project,
          audioGenerationRequirement.state !== 'not-required',
        );
      },
      validateHostDelivery: (signal) => validateProjectDelivery(
        project, audioGenerationRequirement.state !== 'not-required', signal,
        recordingRun ? async (report, fingerprint) => {
          verifyRecordingJourney(report, 2);
          if (candidate) {
            await recordingProjects.discard(project.id, candidate);
            candidate = null;
          }
          const count = recordingRun.append
            ? recordingRun.baseline.levelCount + recordingRun.append.count
            : 2;
          await verifyRecordingLevels(project.root, count);
          if (recordingRun.append) {
            const url = await startProductionPreview(project);
            try {
              for (let level = recordingRun.baseline.levelCount + 1; level <= count; level += 1) {
                await archiveLatestGameplayExperienceReport(project.root);
                const target = new URL(url);
                target.searchParams.set('noobiLevel', String(level - 1));
                const levelReport = await gameplayExperienceEvaluator.evaluate({
                  projectRoot: project.root, previewUrl: target.href, expectedEngine: project.engine,
                  expectedEntrypoint: project.engine === 'godot' ? 'build/web/index.html' : 'dist/index.html',
                  manifestName: `recording-level-${level}.json`, signal,
                });
                verifyRecordingJourney(levelReport, level);
              }
            } finally {
              await playtestPreviews.stop(project.id).catch(() => undefined);
            }
          }
          signal.throwIfAborted();
          candidate = await recordingProjects.capture(project.id, output, fingerprint);
          signal.throwIfAborted();
        } : undefined,
      ),
    });
    await Promise.allSettled([previews.stop(project.id), playtestPreviews.stop(project.id)]);
    await waitForAssetIngestions(project.id);
    if (recordingRun) {
      if (!candidate) throw new Error('没有通过验收的录屏试玩版本。');
      await recordingProjects.save(project.id, {
        releaseId: candidate,
        confirmed: Boolean(recordingRun.append),
        levelCount: recordingRun.append ? recordingRun.baseline.levelCount + recordingRun.append.count : 2,
        ...(recordingRun.append ? { lastRequestId: recordingRun.append.requestId } : {}),
      });
      candidate = null;
    }
    await updateProject(project.id, {
      status: 'completed',
      stage: 'complete',
      threadId: result.threadId,
      activeTurnId: null,
      lastError: null,
    });
    void maybeGenerateGameIcon(project.id);
  } catch (error) {
    if (error instanceof GameHarnessStoppedError) return;
    const message = asError(error).message;
    await updateProject(project.id, {
      status: isExternalDeliveryBlocker(message) ? 'waiting' : 'failed',
      stage: 'verify',
      activeTurnId: null,
      lastError: message,
    }).catch(() => undefined);
  } finally {
    if (candidate) {
      try {
        const state = await recordingProjects.read(project.id);
        if (state?.releaseId !== candidate) await recordingProjects.discard(project.id, candidate);
      } catch { /* Leave the snapshot intact if the published pointer cannot be read. */ }
    }
    if (recordingRun) recordingRuns.delete(project.id);
  }
}

function isExternalDeliveryBlocker(message: string): boolean {
  return /(?:API\s*Key|鉴权|账户|余额|额度|套餐|使用资格|无权|权限|rate.?limit|too many requests|HTTP\s*(?:401|402|403|429)|status_code:\s*(?:1004|1008|1039|2049|2056|2153))/iu.test(message);
}

function isProjectBusyForMutation(
  projectId: string,
  options: {
    ignoreRunReservation?: boolean;
    ignoreDeletionReservation?: boolean;
  } = {},
): boolean {
  return harness.isRunning(projectId)
    || recordingRuns.has(projectId)
    || (!options.ignoreRunReservation && projectRunReservations.has(projectId))
    || (!options.ignoreDeletionReservation && projectDeletionReservations.has(projectId))
    || experienceEvaluationRuns.has(projectId)
    || assetIngestionRuns.has(projectId)
    || gameIconRuns.has(projectId);
}

function acquireProjectFilesystemAccess(projectId: string): () => void {
  if (projectDeletionReservations.has(projectId)) {
    throw new Error('项目正在删除，暂时不能访问项目文件');
  }
  projectFilesystemAccessCounts.set(
    projectId,
    (projectFilesystemAccessCounts.get(projectId) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (projectFilesystemAccessCounts.get(projectId) ?? 1) - 1;
    if (remaining > 0) projectFilesystemAccessCounts.set(projectId, remaining);
    else projectFilesystemAccessCounts.delete(projectId);
  };
}

function startProductionPreview(project: ProjectRecord): Promise<string> {
  return project.engine === 'godot'
    ? playtestPreviews.start(project.id, project.root, {
        directory: 'build/web',
        sourceFallback: false,
        hideGodotSplash: true,
        sourceAssetOverlay: false,
      })
    : playtestPreviews.start(project.id, project.root, {
        directory: 'dist',
        sourceFallback: false,
        sourceAssetOverlay: false,
      });
}

type ExperienceEvaluationPreflight = 'required' | 'already-validated';

interface ExperienceEvaluationOptions {
  signal?: AbortSignal;
  preflight: ExperienceEvaluationPreflight;
}

function evaluateProjectExperience(
  project: ProjectRecord,
  options: ExperienceEvaluationOptions,
): Promise<SharedGameplayExperienceReport | GameplayExperienceReport> {
  const existing = experienceEvaluationRuns.get(project.id);
  if (existing) return existing;
  const run = performProjectExperienceEvaluation(project, options).finally(() => {
    experienceEvaluationRuns.delete(project.id);
  });
  experienceEvaluationRuns.set(project.id, run);
  return run;
}

async function performProjectExperienceEvaluation(
  project: ProjectRecord,
  options: ExperienceEvaluationOptions,
): Promise<SharedGameplayExperienceReport | GameplayExperienceReport> {
  const { signal, preflight } = options;
  emitAgentEvent({
    id: randomUUID(),
    projectId: project.id,
    kind: 'lifecycle',
    title: '体验评测 · 自动试玩',
    message: '正在用隔离浏览器加载正式构建，并按项目试玩路径执行操作与截图。',
    stage: 'verify',
    timestamp: new Date().toISOString(),
    method: 'playtest/experience/started',
  });

  let report: SharedGameplayExperienceReport | GameplayExperienceReport;
  try {
    await playtestPreviews.stop(project.id).catch(() => undefined);
    throwIfExperienceEvaluationAborted(signal);
    if (preflight === 'required') {
      await verifyProductionBuildForExperience(project, signal);
    }
    throwIfExperienceEvaluationAborted(signal);
    const previewUrl = await startProductionPreview(project);
    report = await gameplayExperienceEvaluator.evaluate({
      projectRoot: project.root,
      previewUrl,
      expectedEngine: project.engine === 'godot' ? 'godot' : 'web',
      expectedEntrypoint: project.engine === 'godot'
        ? 'build/web/index.html'
        : 'dist/index.html',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = `正式构建无法完成自动试玩：${asError(error).message}`;
    report = await writeGameplayExperienceFailureReport(project.root, message);
  } finally {
    await playtestPreviews.stop(project.id).catch(() => undefined);
  }

  const failed = report.checks.filter((check) => check.status === 'repair');
  emitAgentEvent({
    id: randomUUID(),
    projectId: project.id,
    kind: report.verdict === 'pass' ? 'assistant' : 'error',
    title: report.verdict === 'pass' ? '体验评测 · 通过' : '体验评测 · 需要修复',
    message: report.verdict === 'pass'
      ? `自动试玩完成，体验评分 ${Math.round(report.score)}/100。`
      : `自动试玩评分 ${Math.round(report.score)}/100；${failed.map((check) => check.label).join('、') || '存在未通过步骤'}。`,
    stage: 'verify',
    timestamp: new Date().toISOString(),
    method: `playtest/experience/${report.verdict}`,
  });
  return report;
}

async function verifyProductionBuildForExperience(
  project: ProjectRecord,
  signal?: AbortSignal,
): Promise<void> {
  throwIfExperienceEvaluationAborted(signal);
  if (project.engine === 'godot') {
    await verifyGodotProject(project, true, signal);
    throwIfExperienceEvaluationAborted(signal);
    return;
  }

  const webBuild = await verifyWebProductionBuild(project.root, { signal });
  throwIfExperienceEvaluationAborted(signal);
  if (!webBuild.ok) {
    throw new Error(
      `Web 正式构建预检未通过：${webBuild.detail} 请先更新 dist，再重新体验评测。`,
    );
  }
}

function throwIfExperienceEvaluationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Gameplay experience evaluation was stopped');
  error.name = 'AbortError';
  throw error;
}

async function validateProjectDelivery(
  project: ProjectRecord,
  requireGeneratedAudio: boolean,
  signal: AbortSignal,
  validateRecording?: (report: GameplayExperienceReport, fingerprint: string) => Promise<void>,
): Promise<HostDeliveryValidation> {
  const findings: string[] = [];
  let productionBuildReady = true;
  throwIfDeliveryAborted(signal);
  await playtestPreviews.stop(project.id).catch(() => undefined);
  await waitForAssetIngestions(project.id);
  throwIfDeliveryAborted(signal);

  if (project.engine === 'godot') {
    try {
      await verifyGodotProject(project, true, signal);
    } catch (error) {
      productionBuildReady = false;
      findings.push(
        `GODOT_BUILD: ${asError(error).message} 修复工程、场景、脚本或资源引用，然后重新导出可运行的 Web 成品。`,
      );
    }
  } else {
    const webBuild = await verifyWebProductionBuild(project.root, { signal });
    if (!webBuild.ok) {
      productionBuildReady = false;
      findings.push(
        `WEB_BUILD: ${webBuild.detail} 更新 Web 正式构建 dist，确保源码、素材与本次交付一致后再运行体验评测。`,
      );
    }
  }
  throwIfDeliveryAborted(signal);

  let assets: GameAssetRecord[];
  try {
    assets = await assetStore.list(project.id, project.root);
  } catch (error) {
    return {
      ok: false,
      findings: [...findings, `ASSET_MANIFEST: ${asError(error).message} 修复素材清单与磁盘文件的一致性。`],
    };
  }

  try {
    const assetPlans = await assetPlanStore.reconcile(project.id, project.root, assets);
    broadcast('noobi:event:asset-plans', { projectId: project.id, assetPlans });
    const unresolvedRequired = assetPlans.filter((plan) => plan.required && plan.status !== 'ready');
    if (unresolvedRequired.length > 0) {
      findings.push(
        'ASSET_PLANS: 以下必需素材工单尚未完成并接入生产代码：'
          + unresolvedRequired.slice(0, 12).map((plan) => {
            const error = plan.error ? `，错误 ${plan.error.code}: ${plan.error.message}` : '';
            return `${plan.id} (${plan.kind}/${plan.status}${error})`;
          }).join('；')
          + `${unresolvedRequired.length > 12 ? `；另有 ${unresolvedRequired.length - 12} 项` : ''}。`
          + '使用原 planId 重新生成或接入，直至工单状态通过宿主引用校验变为 ready。',
      );
    }
  } catch (error) {
    findings.push(`ASSET_PLANS: ${asError(error).message}`);
  }

  try {
    const visualCoverage = await verifyVisualAssetCoverage({
      name: project.name,
      idea: project.idea,
      engine: project.engine,
      root: project.root,
      assets,
    });
    if (!visualCoverage.ok) {
      findings.push(
        `VISUAL_COVERAGE: ${visualCoverage.detail} `
          + '为每个核心角色、敌人、卡牌或场景补齐可区分素材并由生产代码实际加载；卡牌可使用带稳定 subjectId 和可寻址区域的图集。',
      );
    }
  } catch (error) {
    findings.push(`VISUAL_COVERAGE: ${asError(error).message}`);
  }

  try {
    const codexHome = runtime.status.codexHome;
    if (codexHome) {
      await imageGenerationAttestations.bootstrapFromManagedOutputs({
        projectId: project.id,
        root: project.root,
        generatedImagesRoot: join(codexHome, 'generated_images'),
        assets,
      });
    }
    const imageVerification = await imageGenerationAttestations.verify({
      projectId: project.id,
      root: project.root,
      assets,
    });
    if (!imageVerification.ok) {
      const detail = imageVerification.reason === 'missing-attestation'
        ? '没有宿主签发的图像 API / Codex ImageGen 生成证明'
        : imageVerification.reason === 'asset-mismatch'
          ? '当前图片文件的路径或 SHA-256 与宿主生成证明不匹配'
          : '受信图片的完整资源路径没有出现在生产源码或构建产物中';
      findings.push(
        `IMAGE_GENERATION: ${detail}。调用配置的图像 API（无 API 时使用 Codex ImageGen），保留宿主入库素材，并在游戏生产代码中真实引用。`,
      );
    }
  } catch (error) {
    findings.push(`IMAGE_GENERATION: ${asError(error).message}`);
  }

  if (requireGeneratedAudio) {
    try {
      const audioVerification = await imageGenerationAttestations.verifyAudio({
        projectId: project.id,
        root: project.root,
        assets,
      });
      if (!audioVerification.ok) {
        const detail = audioVerification.reason === 'missing-attestation'
          ? '没有宿主签发的 MiniMax 音乐生成证明'
          : audioVerification.reason === 'asset-mismatch'
            ? '当前音频文件的路径或 SHA-256 与宿主 MiniMax 生成证明不匹配'
            : '受信 MiniMax 音乐的完整资源路径没有出现在生产源码或构建产物中';
        findings.push(
          `MINIMAX_MUSIC: ${detail}。调用 noobi_audio_generate（purpose=music），保留宿主入库音频，并由游戏生产代码真实加载播放。`,
        );
      }
    } catch (error) {
      findings.push(`MINIMAX_MUSIC: ${asError(error).message}`);
    }
  }

  if (productionBuildReady) {
    throwIfDeliveryAborted(signal);
    const fingerprint = validateRecording
      ? await recordingFingerprint(join(project.root, project.engine === 'godot' ? 'build/web' : 'dist'))
      : '';
    const experienceReport = await evaluateProjectExperience(project, {
      signal,
      preflight: 'already-validated',
    });
    throwIfDeliveryAborted(signal);
    if (experienceReport.verdict !== 'pass') {
      const failed = experienceReport.checks
        .filter((check) => check.status === 'repair')
        .map((check) => `${check.label}: ${check.message}`)
        .join('；');
      findings.push(
        `PLAYTEST_EXPERIENCE: 自动试玩评分 ${Math.round(experienceReport.score)}/100。${failed || experienceReport.summary || '存在未通过的体验步骤。'} `
          + '检查 artifacts/playtest/latest/report.json 及其截图，修复真实控制、反馈、动画、暂停/恢复、重开或运行错误，并保持 .noobi/playtest.json 与正式构建一致。',
      );
    } else if (validateRecording && findings.length === 0) {
      try {
        if (!('journey' in experienceReport)) throw new Error('未取得正式试玩步骤。');
        await validateRecording(experienceReport, fingerprint);
      } catch (error) {
        throwIfDeliveryAborted(signal);
        findings.push(`RECORDING_LEVELS: ${asError(error).message}`);
      }
    }
  } else {
    await writeGameplayExperienceFailureReport(
      project.root,
      `${project.engine === 'godot' ? 'Godot' : 'Web'} 正式构建未通过，因此没有对旧构建执行体验评测。`,
    );
  }

  return { ok: findings.length === 0, findings };
}

function throwIfDeliveryAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Host delivery validation was stopped');
  error.name = 'AbortError';
  throw error;
}

async function verifyGodotProject(
  project: ProjectRecord,
  exportWeb: boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfExperienceEvaluationAborted(signal);
  await synchronizeGodotPresentationPolicy(project.root);
  throwIfExperienceEvaluationAborted(signal);
  emitAgentEvent({
    id: randomUUID(),
    projectId: project.id,
    kind: 'lifecycle',
    title: 'Godot · 构建验证',
    message: exportWeb
      ? '正在执行资源导入、场景检查和 Web 正式导出。'
      : '正在执行资源导入和场景检查；导出模板就绪后再生成 Web 构建。',
    stage: 'verify',
    timestamp: new Date().toISOString(),
    method: 'godot/verify/started',
  });
  const imported = await godotEnvironmentService.execute({
    kind: 'import',
    projectPath: project.root,
  });
  throwIfExperienceEvaluationAborted(signal);
  assertGodotTask(imported, project.root, '资源导入');

  const validated = await godotEnvironmentService.execute({
    kind: 'validate',
    projectPath: project.root,
  });
  throwIfExperienceEvaluationAborted(signal);
  assertGodotTask(validated, project.root, '场景与脚本检查');

  if (!exportWeb) {
    emitAgentEvent({
      id: randomUUID(),
      projectId: project.id,
      kind: 'lifecycle',
      title: 'Godot · 工程验证通过',
      message: '资源导入和场景检查通过；安装精确匹配的 Web Export Templates 后即可生成预览。',
      stage: 'verify',
      timestamp: new Date().toISOString(),
      method: 'godot/verify/completed-without-export',
    });
    return;
  }

  const outputPath = join(project.root, 'build', 'web', 'index.html');
  throwIfExperienceEvaluationAborted(signal);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o755 });
  throwIfExperienceEvaluationAborted(signal);
  const exported = await godotEnvironmentService.execute({
    kind: 'export',
    projectPath: project.root,
    preset: 'Web',
    outputPath,
  });
  throwIfExperienceEvaluationAborted(signal);
  assertGodotTask(exported, project.root, 'Web 正式导出');

  emitAgentEvent({
    id: randomUUID(),
    projectId: project.id,
    kind: 'lifecycle',
    title: 'Godot · 验证通过',
    message: `资源导入、场景检查和 Web 导出通过；已验证 ${exported.artifacts.length} 个构建产物。`,
    stage: 'verify',
    timestamp: new Date().toISOString(),
    method: 'godot/verify/completed',
  });
}

function assertGodotTask(
  result: Awaited<ReturnType<GodotEnvironmentService['execute']>>,
  projectRoot: string,
  label: string,
): void {
  if (result.ok) return;
  const output = `${result.stderr}\n${result.stdout}`
    .replaceAll(projectRoot, '.')
    .trim()
    .slice(0, 1_200);
  const reason = result.timedOut
    ? '执行超时'
    : result.exitCode !== 0
      ? `退出码 ${result.exitCode ?? 'unknown'}`
      : result.task === 'export' && result.artifacts.length < 3
        ? '没有生成完整、可验证的构建产物'
        : '检测到 Godot 错误诊断';
  throw new Error(`Godot ${label}失败：${reason}${output ? `。\n${output}` : ''}`);
}

async function resolveHostImageGenerationRequirement(
  project: ProjectRecord,
): Promise<HostImageGenerationRequirement> {
  const assets = await assetStore.list(project.id, project.root);
  const verification = await verifyHostGeneratedImage(project, assets);
  if (verification.ok) {
    return {
      state: 'trusted-and-referenced',
      relativePath: verification.asset.relativePath,
    };
  }
  if (verification.reason === 'missing-production-reference') {
    return {
      state: 'trusted-reference-required',
      relativePaths: verification.candidatePaths,
    };
  }
  return { state: 'fresh-generation-required' };
}

async function resolveHostAudioGenerationRequirement(
  project: ProjectRecord,
  miniMaxMusicRequired: boolean,
): Promise<HostAudioGenerationRequirement> {
  if (!miniMaxMusicRequired) return { state: 'not-required' };
  const assets = await assetStore.list(project.id, project.root);
  const verification = await imageGenerationAttestations.verifyAudio({
    projectId: project.id,
    root: project.root,
    assets,
  });
  if (verification.ok) {
    return {
      state: 'trusted-and-referenced',
      relativePath: verification.asset.relativePath,
    };
  }
  if (verification.reason === 'missing-production-reference') {
    return {
      state: 'trusted-reference-required',
      relativePaths: verification.candidatePaths,
    };
  }
  return { state: 'fresh-generation-required' };
}

async function verifyHostGeneratedImage(
  project: ProjectRecord,
  assets: readonly GameAssetRecord[],
) {
  const codexHome = runtime.status.codexHome;
  if (codexHome) {
    await imageGenerationAttestations.bootstrapFromManagedOutputs({
      projectId: project.id,
      root: project.root,
      generatedImagesRoot: join(codexHome, 'generated_images'),
      assets,
    });
  }
  return imageGenerationAttestations.verify({
    projectId: project.id,
    root: project.root,
    assets,
  });
}

async function resolveImageGenerationSkill(): Promise<{ name: string; path: string } | null> {
  return resolveRequiredImageGenerationSkill(runtime, runtime.status);
}

async function ingestGeneratedImage(
  notification: { method: string; params?: unknown },
  projectId: string,
): Promise<void> {
  if (notification.method !== 'item/completed') return;
  const item = asRecord(asRecord(notification.params)?.item);
  if (item?.type !== 'imageGeneration' || readString(item.status) !== 'completed') return;
  const sourcePath = readString(item.savedPath);
  if (!sourcePath) return;

  const codexHome = runtime.status.codexHome;
  if (!codexHome) throw new Error('Codex image output arrived without a managed CODEX_HOME');
  const [canonicalHome, canonicalSource] = await Promise.all([
    realpath(codexHome),
    realpath(sourcePath),
  ]);
  const sourceRelative = relative(canonicalHome, canonicalSource);
  if (
    !sourceRelative
    || sourceRelative === '..'
    || sourceRelative.startsWith(`..${sep}`)
    || isAbsolute(sourceRelative)
  ) {
    throw new Error('Rejected an image output outside the managed Codex home');
  }

  const project = await projectStore.get(projectId);
  const asset = await assetStore.ingestGeneratedImage({
    projectId,
    root: project.root,
    sourcePath: canonicalSource,
    ...(readString(item.revisedPrompt) ? { prompt: readString(item.revisedPrompt)! } : {}),
    provider: 'codex-imagegen',
  });
  await imageGenerationAttestations.record({
    projectId,
    relativePath: asset.relativePath,
    sha256: asset.sha256,
    provider: 'codex-imagegen',
  });
  const revisedPrompt = readString(item.revisedPrompt);
  const waitingImagePlans = (await assetPlanStore.list(projectId))
    .filter((plan) => plan.kind === 'image'
      && plan.status === 'waiting-agent'
      && plan.route === 'codex-imagegen')
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const matchingPlan = (revisedPrompt
    ? waitingImagePlans.find((plan) => plan.prompt === revisedPrompt)
    : undefined) ?? waitingImagePlans[0];
  if (matchingPlan) {
    await assetPlanStore.generated(projectId, matchingPlan.id, asset, 'codex-imagegen');
    const assetPlans = await assetPlanStore.list(projectId);
    broadcast('noobi:event:asset-plans', { projectId, assetPlans });
  }
  const assets = await assetStore.list(projectId, project.root);
  broadcast('noobi:event:assets', { projectId, assets });
  emitAgentEvent({
    id: randomUUID(),
    projectId,
    kind: 'file',
    title: '图片素材已保存',
    message: `${asset.name} 已加入项目素材库：${asset.relativePath}`,
    stage: 'assets',
    timestamp: new Date().toISOString(),
    method: 'assets/image-generated',
  });
}

async function updateProject(
  projectId: string,
  patch: Parameters<ProjectStore['update']>[1],
): Promise<ProjectRecord> {
  const project = await projectStore.update(projectId, patch);
  broadcast('noobi:event:project', project);
  return project;
}

async function projectDirectoryAvailable(project: Pick<ProjectRecord, 'id' | 'root'>): Promise<boolean> {
  try {
    await resolveExistingProjectDirectory(project.root, project.id);
    return true;
  } catch {
    return false;
  }
}

async function ensureProjectLocation(
  project: ProjectRecord,
  options: { ignoreRunReservation?: boolean } = {},
): Promise<ProjectRecord | null> {
  if (await projectDirectoryAvailable(project)) return project;
  if (isProjectBusyForMutation(project.id, {
    ignoreRunReservation: options.ignoreRunReservation,
  })) {
    throw new Error('项目正在工作，暂时不能重新定位文件夹。请先停止当前任务。');
  }

  while (true) {
    const options: Electron.OpenDialogOptions = {
      title: `重新连接“${project.name}”的项目文件夹`,
      message: '请选择这个游戏改名或移动后的文件夹，NooBi 会核对项目身份并更新保存路径。',
      buttonLabel: '重新连接',
      defaultPath: dirname(project.root),
      properties: ['openDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    const selectedDirectory = result.filePaths[0];
    if (!selectedDirectory) return null;

    try {
      const relocated = await projectStore.relocate(project.id, selectedDirectory);
      await Promise.allSettled([previews.stop(project.id), playtestPreviews.stop(project.id)]);
      broadcast('noobi:event:project', relocated);
      return relocated;
    } catch (error) {
      const messageOptions: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '无法连接这个文件夹',
        message: '请选择同一个游戏改名或移动后的文件夹',
        detail: asError(error).message,
        buttons: ['重新选择', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const choice = mainWindow
        ? await dialog.showMessageBox(mainWindow, messageOptions)
        : await dialog.showMessageBox(messageOptions);
      if (choice.response === 1) return null;
    }
  }
}

/**
 * Projects created before icons existed receive their deterministic procedural
 * pixel icon once at startup; failures never block the app.
 */
async function backfillProjectIcons(): Promise<void> {
  try {
    const projects = await projectStore.list();
    for (const project of projects) {
      if (project.icon || gameIconRuns.has(project.id)) continue;
      gameIconRuns.add(project.id);
      try {
        const icon = await generateProceduralProjectIcon(project);
        await updateProject(project.id, { icon });
      } catch (error) {
        if (process.env.NOOBI_DEBUG === '1') {
          process.stderr.write(`[project-icon] backfill failed for ${project.id}: ${asError(error).message}\n`);
        }
      } finally {
        gameIconRuns.delete(project.id);
      }
    }
  } catch (error) {
    if (process.env.NOOBI_DEBUG === '1') {
      process.stderr.write(`[project-icon] backfill failed: ${asError(error).message}\n`);
    }
  }
}

/**
 * Every new game immediately receives its deterministic procedural pixel icon;
 * failures never block project creation.
 */
async function withProceduralIcon(project: ProjectRecord): Promise<ProjectRecord> {
  try {
    const icon = await generateProceduralProjectIcon(project);
    return await projectStore.update(project.id, { icon });
  } catch (error) {
    if (process.env.NOOBI_DEBUG === '1') {
      process.stderr.write(`[project-icon] procedural generation failed: ${asError(error).message}\n`);
    }
    return project;
  }
}

const gameIconRuns = new Set<string>();

/**
 * Replaces the procedural placeholder with a pixel avatar that actually
 * represents the game: a configured image API when available, otherwise a
 * short Codex turn with the $imagegen skill. Never throws; the placeholder
 * stays on any failure.
 */
async function maybeGenerateGameIcon(projectId: string): Promise<void> {
  if (gameIconRuns.has(projectId)) return;
  gameIconRuns.add(projectId);
  try {
    const current = await projectStore.get(projectId);
    if (current.icon?.source === 'ai') return;
    let icon = await generateAiProjectIcon(current, mediaGenerationService);
    if (!icon) {
      const status = runtime.status;
      const skill = status.capabilities.imageGeneration
        ? await resolveImageGenerationSkill()
        : null;
      if (!skill) return;
      icon = await generateCodexProjectIcon(current, runtime, skill);
    }
    if (!icon) return;
    const latest = await projectStore.get(projectId);
    if (latest.icon?.source === 'ai' && latest.icon.updatedAt > icon.updatedAt) return;
    await updateProject(projectId, { icon });
    emitAgentEvent({
      id: randomUUID(),
      projectId,
      kind: 'file',
      title: '游戏图标已生成',
      message: `根据「${current.name}」生成的像素风图标已保存：${icon.path}`,
      stage: latest.stage,
      timestamp: new Date().toISOString(),
      method: 'project/icon-generated',
    });
  } catch (error) {
    if (process.env.NOOBI_DEBUG === '1') {
      process.stderr.write(`[project-icon] generation failed: ${asError(error).message}\n`);
    }
  } finally {
    gameIconRuns.delete(projectId);
  }
}

function emitAgentEvent(event: AgentEvent): void {
  void eventLog.append(event).catch((error) => {
    if (process.env.NOOBI_DEBUG === '1') process.stderr.write(`[event-log] ${asError(error).message}\n`);
  });
  broadcast('noobi:event:agent', event);
}

function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRenderer(event);
    if (switchingConnection && channel.startsWith('noobi:') && !channel.startsWith('noobi:model-connections:')) {
      throw new Error('模型连接正在切换，请稍候。');
    }
    if (shuttingDown) throw new Error('Replay Game Studio 正在退出');
    return listener(event, ...args);
  });
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Rejected IPC from an untrusted renderer');
  }
  const source = event.senderFrame.url;
  const expected = process.env.NOOBI_RENDERER_URL;
  if (expected ? !source.startsWith(expected) : !source.startsWith('file:')) {
    throw new Error('Rejected IPC from an unexpected origin');
  }
}

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function ensureSmokeProject(): Promise<void> {
  if (!smokeCapture) return;
  let project = (await projectStore.list())[0];
  if (!project) {
    const settings = await projectStore.getSettings();
    project = await projectStore.create({
      name: 'Signal Garden',
      idea: '操控信号采集器，在移动障碍中收集五个能量节点并完成一局可立即重玩的游戏。',
      parentDirectory: settings.defaultWorkspace,
      model: null,
    });
  }
  const smokeStage = process.env.NOOBI_SMOKE_STAGE?.trim();
  const smokeStatus = process.env.NOOBI_SMOKE_STATUS?.trim();
  const validStages: readonly PipelineStage[] = [
    'brief', 'scaffold', 'gdd', 'assets', 'world', 'code', 'verify', 'complete',
  ];
  const validStatuses: readonly ProjectStatus[] = [
    'draft', 'running', 'waiting', 'completed', 'failed', 'stopped',
  ];
  const smokePatch: {
    stage?: PipelineStage;
    status?: ProjectStatus;
  } = {};
  if (validStages.includes(smokeStage as PipelineStage)) smokePatch.stage = smokeStage as PipelineStage;
  if (validStatuses.includes(smokeStatus as ProjectStatus)) smokePatch.status = smokeStatus as ProjectStatus;
  if (Object.keys(smokePatch).length > 0) {
    project = await projectStore.update(project.id, smokePatch);
  }
  if (process.env.NOOBI_SMOKE_TAB === 'assets') {
    const plan = await assetPlanStore.upsert({
      id: 'smoke-card-art',
      projectId: project.id,
      name: 'Signal Guardian Card Art',
      kind: 'image',
      prompt: 'A production card illustration for the Signal Guardian unit',
      required: true,
    });
    if (plan.status !== 'failed') {
      await assetPlanStore.fail(project.id, plan.id, {
        code: 'provider-timeout',
        message: '图片服务暂时没有返回结果；素材工单已保留。',
        retryable: true,
      });
    }
  }
}

async function captureSmoke(window: BrowserWindow, target: string): Promise<void> {
  if (process.env.NOOBI_SMOKE_NARROW === '1') {
    window.setSize(760, 800, false);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
  const healthy = await window.webContents.executeJavaScript(
    `Boolean(document.querySelector('.app-shell')) && !document.querySelector('.loading-error')`,
    true,
  ) as boolean;
  if (!healthy) throw new Error('Renderer did not reach the Noobi workbench');
  const smokeTheme = process.env.NOOBI_SMOKE_THEME;
  if (smokeTheme === 'light' || smokeTheme === 'dark') {
    await window.webContents.executeJavaScript(
      `if (document.documentElement.dataset.theme !== ${JSON.stringify(smokeTheme)}) {
        document.querySelector('[title="切换主题"]')?.click();
      }`,
      true,
    );
    await delay(300);
  }
  if (process.env.NOOBI_SMOKE_COLLAPSED === '1') {
    const collapsed = await window.webContents.executeJavaScript(
      `(() => {
        const trigger = document.querySelector('[aria-label="收起首页侧栏"]');
        if (!(trigger instanceof HTMLButtonElement)) return false;
        trigger.click();
        return true;
      })()`,
      true,
    ) as boolean;
    if (!collapsed) throw new Error('Home rail collapse control was not available');
    await delay(300);
    const railCollapsed = await window.webContents.executeJavaScript(
      `document.querySelector('.project-rail.mode-dashboard')?.classList.contains('is-collapsed') === true`,
      true,
    ) as boolean;
    if (!railCollapsed) throw new Error('Home rail did not enter its collapsed state');
    const compactHomeVisible = await window.webContents.executeJavaScript(
      `(() => {
        const home = document.querySelector('.compact-project-list [aria-label="首页"]');
        return home instanceof HTMLButtonElement
          && Boolean(home.querySelector('.lucide-house'))
          && !home.querySelector('.lucide-plus');
      })()`,
      true,
    ) as boolean;
    if (!compactHomeVisible) throw new Error('Collapsed home rail did not show the home icon');
    const roundTrip = await window.webContents.executeJavaScript(
      `(() => {
        const brand = document.querySelector('[aria-label="展开首页侧栏"]');
        if (!(brand instanceof HTMLButtonElement)) return false;
        brand.click();
        return true;
      })()`,
      true,
    ) as boolean;
    if (!roundTrip) throw new Error('Collapsed Noobi monogram was not available');
    await delay(200);
    const railExpanded = await window.webContents.executeJavaScript(
      `document.querySelector('.project-rail.mode-dashboard')?.classList.contains('is-collapsed') === false`,
      true,
    ) as boolean;
    if (!railExpanded) throw new Error('Collapsed Noobi monogram did not expand the home rail');
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="收起首页侧栏"]')?.click()`,
      true,
    );
    await delay(200);
  }
  if (process.env.NOOBI_SMOKE_REPLAY_INTAKE === '1') {
    const intake = await window.webContents.executeJavaScript(
      `(() => {
        const card = document.querySelector('.replay-create .home-prompt-card');
        if (!card) return false;
        const files = new DataTransfer();
        files.items.add(new File(['fixture'], 'sample.mov', { type: 'video/quicktime' }));
        card.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: files }));
        return true;
      })()`,
      true,
    ) as boolean;
    await delay(150);
    const controls = await window.webContents.executeJavaScript(
      `document.querySelector('.replay-upload')?.innerText.includes('sample.mov')
        && document.querySelector('.replay-recording-options input[type="checkbox"]')
        && !document.querySelector('[aria-label="开始分析录屏"]')?.disabled`,
      true,
    ) as boolean;
    if (!intake || !controls) throw new Error('Recording drop did not activate the intake controls');
    await window.webContents.executeJavaScript(
      `document.querySelector('.replay-recording-options button')?.click()`,
      true,
    );
    await delay(150);
    const reset = await window.webContents.executeJavaScript(
      `!document.querySelector('.replay-recording-options')
        && document.querySelector('.replay-upload')?.innerText.includes('导入录屏')`,
      true,
    ) as boolean;
    if (!reset) throw new Error('Removing the recording did not reset intake');
    process.stdout.write('Replay recording intake passed: drop, review option, submit state, remove\n');
  }
  if (process.env.NOOBI_SMOKE_MODEL_MENU === '1') {
    let opened = false;
    for (let attempt = 0; attempt < 20 && !opened; attempt += 1) {
      opened = await window.webContents.executeJavaScript(
        `(() => {
          const trigger = document.querySelector('[aria-label="切换模型与推理强度"]');
          if (!(trigger instanceof HTMLButtonElement) || trigger.disabled) return false;
          trigger.click();
          return true;
        })()`,
        true,
      ) as boolean;
      if (!opened) await delay(250);
    }
    if (!opened) throw new Error('Model picker trigger was not available');
    await delay(300);
    const modelSectionOpened = await window.webContents.executeJavaScript(
      `(() => {
        const trigger = [...document.querySelectorAll('.home-model-row')]
          .find((item) => item.querySelector('span')?.textContent?.trim() === '模型');
        if (!(trigger instanceof HTMLButtonElement)) return false;
        trigger.click();
        return true;
      })()`,
      true,
    ) as boolean;
    if (!modelSectionOpened) throw new Error('Model picker model section was not available');
    await delay(200);
    const menu = await window.webContents.executeJavaScript(
      `(() => {
        const element = document.querySelector('.home-model-menu');
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          options: element.querySelectorAll('[role="option"]').length,
        };
      })()`,
      true,
    ) as { width: number; height: number; display: string; visibility: string; opacity: string; options: number } | null;
    if (!menu || menu.width <= 0 || menu.height <= 0 || menu.display === 'none' || menu.visibility === 'hidden' || menu.opacity === '0' || menu.options === 0) {
      throw new Error(`Model picker did not open correctly: ${JSON.stringify(menu)}`);
    }
    process.stdout.write(`Noobi model picker opened ${JSON.stringify(menu)}\n`);
  }
  if (process.env.NOOBI_SMOKE_VIEW === 'settings-appearance') {
    await window.webContents.executeJavaScript(
      `document.querySelector('.home-toolbar [aria-label="设置"]')?.click()`,
      true,
    );
    await delay(200);
    const settingsUpdated = await window.webContents.executeJavaScript(
      `(() => {
        const tabs = Array.from(document.querySelectorAll('.settings-nav button'));
        const appearance = tabs.find((item) => item.textContent.includes('外观'));
        appearance?.click();
        return Boolean(appearance) && !tabs.some((item) => item.textContent.includes('制作伙伴'));
      })()`,
      true,
    ) as boolean;
    if (!settingsUpdated) throw new Error('Replay settings still expose the legacy character picker');
    await delay(150);
  }
  if (process.env.NOOBI_SMOKE_VIEW === 'workbench') {
    await window.webContents.executeJavaScript(
      `document.querySelector('.project-item')?.click()`,
      true,
    );
    await delay(650);
    const hasPlayablePreview = await window.webContents.executeJavaScript(
      `document.querySelector('.preview-pane iframe') instanceof HTMLIFrameElement`,
      true,
    ) as boolean;
    if (process.env.NOOBI_SMOKE_STATUS === 'stopped') {
      const resumeVisible = await window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.composer-action.is-resume[aria-label="继续制作"]'))`,
        true,
      ) as boolean;
      if (!resumeVisible) throw new Error('Stopped project did not show the resume action');
    }
    if (process.env.NOOBI_SMOKE_REPLAY_WORKBENCH === '1') {
      const layout = await window.webContents.executeJavaScript(
        `(() => {
          const canvas = document.querySelector('.studio-canvas');
          const conversation = document.querySelector('.production-center');
          if (!(canvas instanceof HTMLElement) || !(conversation instanceof HTMLElement)) return false;
          return canvas.getBoundingClientRect().left < conversation.getBoundingClientRect().left
            && Boolean(canvas.querySelector('.replay-stage'))
            && !canvas.querySelector('.production-diorama, .inspector-crew-toggle, .inspector-solo-indicator');
        })()`,
        true,
      ) as boolean;
      if (!layout || hasPlayablePreview) throw new Error('Replay workbench did not start with the new playtest stage');
      const toggled = await window.webContents.executeJavaScript(
        `(() => {
          const toggle = document.querySelector('.preview-mode-toggle');
          toggle?.click();
          return Boolean(toggle);
        })()`,
        true,
      ) as boolean;
      await delay(200);
      const previewAvailable = await window.webContents.executeJavaScript(
        `Boolean(document.querySelector('.preview-pane iframe'))`,
        true,
      ) as boolean;
      if (!toggled || !previewAvailable) throw new Error('Current build preview did not open from the new playtest stage');
      await window.webContents.executeJavaScript(`document.querySelector('.preview-mode-toggle')?.click()`, true);
      await delay(150);
      process.stdout.write('Replay workbench passed: new playtest stage and existing build preview\n');
    } else if (process.env.NOOBI_SMOKE_EXPERIENCE_REPORT === 'expand' && !hasPlayablePreview) {
      await window.webContents.executeJavaScript(`document.querySelector('.preview-mode-toggle')?.click()`, true);
      await delay(200);
    }
  }
  if (process.env.NOOBI_SMOKE_PROJECT_RAIL === '1') {
    const opened = await window.webContents.executeJavaScript(
      `(() => {
        const trigger = document.querySelector(
          '[aria-label="打开项目列表"], [aria-label="打开项目导航"]',
        );
        if (!(trigger instanceof HTMLButtonElement)) return false;
        trigger.click();
        return true;
      })()`,
      true,
    ) as boolean;
    if (!opened) throw new Error('Project rail trigger was not available');
    await delay(350);
    const railState = await window.webContents.executeJavaScript(
      `(() => {
        const rail = document.querySelector('.project-rail.mode-workbench');
        if (!(rail instanceof HTMLElement)) return null;
        const rect = rail.getBoundingClientRect();
        const style = getComputedStyle(rail);
        return {
          open: rail.classList.contains('is-open'),
          width: Math.round(rect.width),
          visible: style.display !== 'none' && style.visibility !== 'hidden',
          projectRows: rail.querySelectorAll('.project-list .project-item').length,
          closeVisible: Boolean(rail.querySelector('[aria-label="关闭项目导航"]')),
        };
      })()`,
      true,
    ) as {
      open: boolean;
      width: number;
      visible: boolean;
      projectRows: number;
      closeVisible: boolean;
    } | null;
    if (!railState
      || !railState.open
      || railState.width < 260
      || !railState.visible
      || railState.projectRows < 1
      || !railState.closeVisible) {
      throw new Error(`Project rail did not open correctly: ${JSON.stringify(railState)}`);
    }
    process.stdout.write(`Noobi project rail opened ${JSON.stringify(railState)}\n`);
  }
  if (process.env.NOOBI_SMOKE_PROJECT_MENU === '1') {
    const opened = await window.webContents.executeJavaScript(
      `(() => {
        const trigger = document.querySelector('.project-item-more');
        if (!(trigger instanceof HTMLButtonElement)) return false;
        trigger.click();
        return true;
      })()`,
      true,
    ) as boolean;
    if (!opened) throw new Error('Project action menu trigger was not available');
    await delay(250);
    const menuState = await window.webContents.executeJavaScript(
      `(() => {
        const menu = document.querySelector('.project-actions-menu');
        if (!(menu instanceof HTMLElement)) return null;
        const rect = menu.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          labels: Array.from(menu.querySelectorAll('[role="menuitem"]'))
            .map((item) => item.textContent?.trim() ?? ''),
          insideViewport: rect.left >= 0 && rect.top >= 0
            && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
        };
      })()`,
      true,
    ) as { width: number; height: number; labels: string[]; insideViewport: boolean } | null;
    if (!menuState
      || menuState.width < 190
      || menuState.height < 120
      || !menuState.insideViewport
      || !['重命名', '置顶', '删除'].every((label) => menuState.labels.includes(label))) {
      throw new Error(`Project action menu did not open correctly: ${JSON.stringify(menuState)}`);
    }
    process.stdout.write(`Noobi project action menu opened ${JSON.stringify(menuState)}\n`);
  }
  if (process.env.NOOBI_SMOKE_GEAR_ALIGNMENT === '1') {
    const alignment = await window.webContents.executeJavaScript(
      `(() => {
        const rail = document.querySelector('.project-rail.mode-workbench');
        const settingsIcon = document.querySelector('.rail-settings svg');
        const runtimeIcon = document.querySelector('.runtime-mini svg');
        if (!(rail instanceof HTMLElement)
          || !(settingsIcon instanceof SVGElement)
          || !(runtimeIcon instanceof SVGElement)) return null;
        const center = (element) => {
          const rect = element.getBoundingClientRect();
          return Math.round((rect.left + rect.width / 2) * 10) / 10;
        };
        return {
          railCenter: center(rail),
          settingsCenter: center(settingsIcon),
          runtimeCenter: center(runtimeIcon),
        };
      })()`,
      true,
    ) as { railCenter: number; settingsCenter: number; runtimeCenter: number } | null;
    if (!alignment
      || Math.abs(alignment.settingsCenter - alignment.railCenter) > 1
      || Math.abs(alignment.settingsCenter - alignment.runtimeCenter) > 1) {
      throw new Error(`Collapsed settings icon is not centered: ${JSON.stringify(alignment)}`);
    }
    process.stdout.write(`Noobi collapsed settings icon aligned ${JSON.stringify(alignment)}\n`);
  }
  if (process.env.NOOBI_SMOKE_RENAME_TITLE === '1') {
    const workbenchBrandCanExpand = await window.webContents.executeJavaScript(
      `(() => {
        const brand = document.querySelector('.project-rail.mode-workbench .brand');
        return brand instanceof HTMLButtonElement
          && brand.getAttribute('aria-label') === '打开项目列表';
      })()`,
      true,
    ) as boolean;
    if (!workbenchBrandCanExpand) throw new Error('Collapsed workbench rail cannot be expanded');
    const opened = await window.webContents.executeJavaScript(
      `(() => {
        const trigger = document.querySelector('.agent-project-name');
        if (!(trigger instanceof HTMLButtonElement)) return false;
        trigger.click();
        return true;
      })()`,
      true,
    ) as boolean;
    if (!opened) throw new Error('Workbench project title rename trigger was not available');
    await delay(250);
    const dialogVisible = await window.webContents.executeJavaScript(
      `Boolean(document.querySelector('.rename-project-modal [aria-label="项目名称"]'))`,
      true,
    ) as boolean;
    if (!dialogVisible) throw new Error('Workbench title did not open the rename dialog');
  }
  await window.webContents.executeJavaScript(
    `document.querySelectorAll('.brief-card footer > span').forEach((node) => {
      node.textContent = 'LOCAL WORKSPACE / signal-garden';
      node.removeAttribute('title');
    })`,
    true,
  );
  if (process.env.NOOBI_SMOKE_TAB === 'assets') {
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.inspector-tabs button'))
        .find((node) => node.textContent?.includes('素材'))?.click()`,
      true,
    );
    await delay(350);
  }
  if (process.env.NOOBI_SMOKE_EXPERIENCE_REPORT === 'expand') {
    let reportControlsReady = false;
    for (let attempt = 0; attempt < 20 && !reportControlsReady; attempt += 1) {
      reportControlsReady = await window.webContents.executeJavaScript(
        `document.querySelector('.experience-report-trigger') instanceof HTMLButtonElement
          && document.querySelector('.preview-pane iframe, .production-diorama') instanceof HTMLElement`,
        true,
      ) as boolean;
      if (!reportControlsReady) await delay(250);
    }
    if (!reportControlsReady) throw new Error('Experience report controls were not available');
    const collapsed = await window.webContents.executeJavaScript(
      `(() => {
        const report = document.querySelector('.experience-report');
        const toggle = document.querySelector('.experience-report-trigger');
        const preview = document.querySelector('.preview-pane iframe, .production-diorama');
        if (!(toggle instanceof HTMLButtonElement) || !(preview instanceof HTMLElement)) return null;
        const previewHeight = Math.round(preview.getBoundingClientRect().height);
        toggle.click();
        return {
          reportVisible: report instanceof HTMLElement,
          previewHeight,
          expanded: toggle.getAttribute('aria-expanded'),
        };
      })()`,
      true,
    ) as { reportVisible: boolean; previewHeight: number; expanded: string | null } | null;
    await delay(250);
    const expanded = await window.webContents.executeJavaScript(
      `(() => {
        const report = document.querySelector('.experience-report');
        const toggle = document.querySelector('.experience-report-trigger');
        const details = document.querySelector('.experience-report-details');
        const preview = document.querySelector('.preview-pane iframe, .production-diorama');
        if (!(report instanceof HTMLElement)
          || !(toggle instanceof HTMLButtonElement)
          || !(preview instanceof HTMLElement)) return null;
        report.scrollIntoView({ block: 'center' });
        return {
          height: Math.round(report.getBoundingClientRect().height),
          width: Math.round(report.getBoundingClientRect().width),
          previewHeight: Math.round(preview.getBoundingClientRect().height),
          expanded: toggle.getAttribute('aria-expanded'),
          details: details instanceof HTMLElement,
        };
      })()`,
      true,
    ) as {
      height: number;
      width: number;
      previewHeight: number;
      expanded: string | null;
      details: boolean;
    } | null;
    if (!collapsed
      || !expanded
      || collapsed.reportVisible
      || collapsed.expanded !== 'false'
      || expanded.expanded !== 'true'
      || !expanded.details
      || expanded.height < 200
      || Math.abs(expanded.previewHeight - collapsed.previewHeight) > 1) {
      throw new Error(`Experience report did not expand correctly: ${JSON.stringify({ collapsed, expanded })}`);
    }
    process.stdout.write(
      `Noobi experience report opened as ${expanded.width}x${expanded.height}px without resizing the ${expanded.previewHeight}px preview\n`,
    );
    await delay(250);
  }
  const image = await window.webContents.capturePage();
  const output = resolve(target);
  await mkdir(dirname(output), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(output, image.toPNG());
  process.stdout.write(`Noobi UI smoke captured ${output}\n`);
  if (process.env.NOOBI_SMOKE_HOLD === '1') {
    process.stdout.write('Noobi UI smoke window left open for inspection\n');
    return;
  }
  app.quit();
}

async function shutdown(): Promise<void> {
  recordingAnalysis?.abort();
  approvalBroker?.closeAll();
  for (const controller of manualExperienceControllers.values()) controller.abort();
  manualExperienceControllers.clear();
  const projects = projectStore ? await projectStore.list().catch(() => []) : [];
  const stopRuns = Promise.allSettled(projects.map((project) => harness.stop(project.id)));
  await Promise.race([stopRuns, delay(5_000)]);
  await Promise.allSettled([previews.stopAll(), playtestPreviews.stopAll(), runtime.stop()]);
  await Promise.race([Promise.allSettled([...backgroundRuns]), delay(2_000)]);
  await projectStore?.list().catch(() => undefined);
  await eventLog?.flush().catch(() => undefined);
}

async function recoverInterruptedProjects(): Promise<void> {
  const projects = await projectStore.list();
  await Promise.all(
    projects
      .filter((project) => project.status === 'running')
      .map((project) => projectStore.update(project.id, {
        status: 'stopped',
        activeTurnId: null,
        lastError: 'Replay Game Studio 上次退出时，该任务没有确认完成。请检查文件后再继续。',
      })),
  );
}

function trackBackgroundRun(run: Promise<void>): void {
  backgroundRuns.add(run);
  const release = (): void => { backgroundRuns.delete(run); };
  void run.then(release, release);
}

function trackAssetIngestion(projectId: string, run: Promise<void>): void {
  const runs = assetIngestionRuns.get(projectId) ?? new Set<Promise<void>>();
  runs.add(run);
  assetIngestionRuns.set(projectId, runs);
  const release = (): void => {
    runs.delete(run);
    if (runs.size === 0) assetIngestionRuns.delete(projectId);
  };
  void run.then(release, release);
  trackBackgroundRun(run);
}

async function waitForAssetIngestions(projectId: string): Promise<void> {
  while (assetIngestionRuns.has(projectId)) {
    await Promise.allSettled([...(assetIngestionRuns.get(projectId) ?? [])]);
  }
}

function stageForHarnessState(event: GameHarnessStateEvent): PipelineStage {
  if (event.state === 'completed') return 'complete';
  if (event.phase === 'planner') return 'brief';
  if (event.phase === 'reviewer') return 'verify';
  return 'code';
}

function validateRunInput(value: RunProjectInput): void {
  if (!value || typeof value !== 'object') throw new Error('无效的执行参数');
  validateProjectId(value.projectId);
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 50_000) {
    throw new Error('制作指令必须为 1–50000 个字符');
  }
  if (value.recordingAppend !== undefined) {
    const append = value.recordingAppend;
    if (!append || typeof append.releaseId !== 'string' || typeof append.requestId !== 'string'
      || !/^[a-f0-9-]{36}$/u.test(append.requestId) || !Number.isInteger(append.count)) {
      throw new Error('追加请求无效。');
    }
  }
  if (value.model !== undefined && value.model !== null && typeof value.model !== 'string') {
    throw new Error('无效的模型');
  }
}

function validateProjectId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) {
    throw new Error('无效的项目 ID');
  }
  return value;
}

function validateAssetPlanId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u.test(value)) {
    throw new Error('无效的素材计划 ID');
  }
  return value;
}

function validateSettingsPatch(value: Partial<AppSettings>): Partial<AppSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的设置');
  const allowed = new Set([
    'defaultWorkspace',
    'defaultModel',
    'defaultEffort',
    'defaultNoobiStageMode',
    'defaultNoobiSoloSceneId',
    'defaultNoobiSceneId',
    'defaultNoobiPackId',
    'defaultNoobiCrew',
    'theme',
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`未知设置：${key}`);
  if (value.defaultNoobiStageMode !== undefined
    && !isNoobiStageMode(value.defaultNoobiStageMode)) {
    throw new Error('无效的舞台模式');
  }
  if (value.defaultNoobiSoloSceneId !== undefined
    && !isNoobiPackId(value.defaultNoobiSoloSceneId)) {
    throw new Error('无效的单人场景');
  }
  if (value.defaultNoobiSceneId !== undefined
    && !isNoobiSceneId(value.defaultNoobiSceneId)) {
    throw new Error('无效的场景');
  }
  return value;
}

function defaultModel(models: Array<{ model: string; isDefault: boolean }>): string | null {
  return models.find((model) => model.isDefault)?.model ?? models[0]?.model ?? null;
}

function readRequestId(value: unknown): string | number | null {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
    ? value
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref();
  });
}
