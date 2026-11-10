import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkspaceTransition } from './WorkspaceTransition';

describe('workspace transition', () => {
  it.each(['covering', 'revealing'] as const)('renders a decorative overlay while %s', (phase) => {
    const markup = renderToStaticMarkup(createElement(WorkspaceTransition, {
      phase,
      runId: 1,
      onComplete: () => undefined,
    }));
    expect(markup).toContain(`phase-${phase}`);
    expect(markup).toContain('aria-hidden="true"');
  });
});
