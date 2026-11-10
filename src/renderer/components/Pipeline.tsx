import { Check, ChevronRight } from 'lucide-react';
import React from 'react';

import { PIPELINE_STAGES, type PipelineStage, type ProjectStatus } from '../../shared/contracts';
import { stageProgress } from '../ui';

const phases = [
  { label: '理解玩法', lastStage: 'gdd' },
  { label: '制作关卡', lastStage: 'code' },
  { label: '试玩检查', lastStage: 'complete' },
] as const;

export function Pipeline({ stage, status }: { stage: PipelineStage; status: ProjectStatus }) {
  const position = stageProgress(stage);
  const phaseIndex = phases.findIndex((phase) => position <= stageProgress(phase.lastStage));
  const stageLabel = PIPELINE_STAGES[position]?.label;
  const complete = status === 'completed' && stage === 'complete';

  return (
    <section className="replay-pipeline" aria-label="游戏制作流程">
      <ol>
        {phases.map((phase, index) => {
          const active = index === phaseIndex && !complete;
          const done = index < phaseIndex || complete;
          return (
            <li key={phase.lastStage} aria-current={active ? 'step' : undefined}
              className={active ? 'is-active' : done ? 'is-done' : undefined}>
              {index > 0 ? <ChevronRight className="replay-phase-divider" size={13} aria-hidden="true" /> : null}
              <span className="replay-phase-number" aria-hidden="true">{done ? <Check size={12} /> : index + 1}</span>
              <span>{phase.label}</span>
            </li>
          );
        })}
      </ol>
      {stageLabel ? <span className="replay-pipeline-detail">{stageLabel}</span> : null}
    </section>
  );
}
