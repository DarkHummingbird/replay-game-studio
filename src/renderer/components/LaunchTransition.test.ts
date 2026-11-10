import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LaunchTransition } from './LaunchTransition';

describe('LaunchTransition', () => {
  it('announces project creation while the workbench opens', () => {
    const markup = renderToStaticMarkup(createElement(LaunchTransition, { phase: 'running' }));

    expect(markup).toContain('正在创建游戏项目');
    expect(markup).toContain('准备试玩区和制作对话');
    expect(markup).toContain('replay-launch-progress');
    expect(markup.match(/<img/gu)).toHaveLength(1);
  });
});
