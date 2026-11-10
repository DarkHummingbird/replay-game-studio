import React, { useEffect } from 'react';

import type { WorkspaceViewAnimatedPhase } from '../workspaceViewTransition';

interface WorkspaceTransitionProps {
  phase: WorkspaceViewAnimatedPhase;
  runId: number;
  onComplete: (phase: WorkspaceViewAnimatedPhase, runId: number) => void;
}

export function WorkspaceTransition({ phase, runId, onComplete }: WorkspaceTransitionProps) {
  useEffect(() => {
    const timer = window.setTimeout(() => onComplete(phase, runId), 180);
    return () => window.clearTimeout(timer);
  }, [phase, runId, onComplete]);

  return <div key={phase} className={`replay-page-transition phase-${phase}`} aria-hidden="true" />;
}
