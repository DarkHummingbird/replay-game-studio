import React from 'react';

import replayMark from '../assets/replay-mark.svg';

export type LaunchTransitionPhase = 'running' | 'leaving';

interface LaunchTransitionProps {
  phase: LaunchTransitionPhase;
}

export function LaunchTransition({ phase }: LaunchTransitionProps) {
  return (
    <div className={`replay-launch is-${phase}`} role="status">
      <img className="replay-brand-mark" src={replayMark} alt="" />
      <strong>正在创建游戏项目</strong>
      <small>准备试玩区和制作对话</small>
      <span className="replay-launch-progress" aria-hidden="true" />
    </div>
  );
}
