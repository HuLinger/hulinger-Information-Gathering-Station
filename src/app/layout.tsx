import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import Providers from '../components/Providers';
import tokens from '../../design/tokens.json';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hulinger · AI 情报与资料',
  description: '私有的 AI 模型更新与开源项目资讯中心。',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const colors = tokens.themes.light;
  const variables = {
    '--hub-primary': colors.primary,
    '--hub-primary-hover': colors.primaryHover,
    '--hub-text': colors.textPrimary,
    '--hub-secondary': colors.textSecondary,
    '--hub-canvas': colors.canvas,
    '--hub-surface': colors.surface,
    '--hub-sidebar': colors.sidebarSurface,
    '--hub-success': colors.success,
    '--hub-warning': colors.warning,
    '--hub-danger': colors.danger,
    '--hub-border': colors.borderDecorative,
    '--hub-control-border': colors.borderInteractive,
    '--hub-selected': colors.selectedSurface,
    '--hub-font': tokens.typography.fontFamily,
    '--hub-hero-size': `${tokens.typography.heroTitle.fontSize}px`,
    '--hub-hero-line': `${tokens.typography.heroTitle.lineHeight}px`,
    '--hub-feature-size': `${tokens.typography.featuredTitle.fontSize}px`,
    '--hub-feature-line': `${tokens.typography.featuredTitle.lineHeight}px`,
    '--hub-sidebar-width': `${tokens.layout.sidebarWidth}px`,
    '--hub-header-height': `${tokens.layout.headerHeight}px`,
  } as CSSProperties;
  return <html lang="zh-CN"><body style={variables}><AntdRegistry><Providers>{children}</Providers></AntdRegistry></body></html>;
}
