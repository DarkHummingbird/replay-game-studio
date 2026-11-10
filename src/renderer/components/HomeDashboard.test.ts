import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, RuntimeStatus } from '../../shared/contracts';
import { HomeDashboard } from './HomeDashboard';

function render(account: RuntimeStatus['account'], imageGenerationAvailable: boolean) {
  return renderToStaticMarkup(createElement(HomeDashboard, {
    runtime: { state: 'ready', account } as RuntimeStatus,
    settings: { defaultEffort: 'medium', theme: 'light' } as AppSettings,
    models: [], projects: [], imageGenerationAvailable,
    busy: false, focusSignal: 0, onLaunch: vi.fn(), onOpenProject: vi.fn(),
    onOpenRail: vi.fn(), onOpenSettings: vi.fn(), onToggleTheme: vi.fn(),
  }));
}

describe('first-use guidance', () => {
  it('explains account and API setup before an unsigned-in user starts', () => {
    const markup = render(null, false);
    expect(markup).toContain('设置模型连接');
    expect(markup).toContain('API Key');
    expect(markup).toContain('Shift + Enter');
  });
  it('provides a direct API setup action when no image route exists', () => {
    expect(render({ type: 'chatgpt', email: null, planType: null }, false)).toContain('配置图片 API Key');
  });
  it('does not require an external key when image generation is available', () => {
    const markup = render({ type: 'chatgpt', email: null, planType: null }, true);
    expect(markup).toContain('外部图片 API Key 为可选配置');
    expect(markup).not.toContain('配置图片 API Key</button>');
  });
});
