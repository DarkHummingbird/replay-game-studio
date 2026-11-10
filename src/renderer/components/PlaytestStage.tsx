import { CircleAlert, Clapperboard, ScanLine } from 'lucide-react';
import React from 'react';

import { PIPELINE_STAGES, type PipelineStage, type ProjectStatus } from '../../shared/contracts';

const stageCopy: Record<ProjectStatus, { label: string; title: string; description: string }> = {
  draft: { label: '待启动', title: '试玩台已准备好', description: '在制作对话中开始任务。生成可玩的构建后，就能在这里体验。' },
  running: { label: '制作中', title: '正在准备可玩的版本', description: '构建和试玩检查通过后，游戏会出现在这里。' },
  waiting: { label: '等待处理', title: '制作需要你确认', description: '查看制作对话里的提示，完成确认后继续。' },
  completed: { label: '等待预览', title: '正在准备游戏预览', description: '如果预览没有出现，可以用上方的刷新按钮重试。' },
  failed: { label: '交付未通过', title: '这次制作未完成', description: '查看制作对话中的原因，再决定如何继续。' },
  stopped: { label: '已停止', title: '制作已暂停', description: '回到制作对话继续任务，或查看已经生成的构建。' },
};

export function PlaytestStage({ stage, status, loading }: {
  stage: PipelineStage;
  status: ProjectStatus;
  loading: boolean;
}) {
  const copy = stageCopy[status];
  const currentStage = PIPELINE_STAGES.find((item) => item.id === stage);
  const Icon = status === 'failed' ? CircleAlert : status === 'running' ? ScanLine : Clapperboard;
  return (
    <section className="replay-stage" aria-label="试玩台状态" aria-busy={loading}>
      <div className="replay-stage-frame">
        <header>
          <span>REPLAY / PLAYTEST</span>
          <span className={`replay-stage-status status-${status}`}><i aria-hidden="true" />{copy.label}</span>
        </header>
        <div className="replay-stage-copy" role="status">
          <span className="replay-stage-icon"><Icon size={29} strokeWidth={1.6} aria-hidden="true" /></span>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
          {status === 'running' && currentStage ? <strong>{currentStage.label}</strong> : null}
        </div>
        <footer>试玩、反馈、追加关卡，都在这个项目里进行。</footer>
      </div>
    </section>
  );
}
