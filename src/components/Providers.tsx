'use client';

import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import tokens from '../../design/tokens.json';

export default function Providers({ children }: { children: React.ReactNode }) {
  const colors = tokens.themes.light;
  return (
    <ConfigProvider locale={zhCN} theme={{
      token: {
        colorPrimary: colors.primary,
        colorSuccess: colors.success,
        colorWarning: colors.warning,
        colorError: colors.danger,
        colorText: colors.textPrimary,
        colorTextSecondary: colors.textSecondary,
        colorTextPlaceholder: colors.textSecondary,
        colorTextDescription: colors.textSecondary,
        colorBorder: colors.borderInteractive,
        colorBgContainer: colors.surface,
        fontFamily: tokens.typography.fontFamily,
        fontSize: tokens.typography.body.fontSize,
        borderRadius: tokens.radius.default,
        controlHeight: tokens.controls.defaultHeight,
      },
      components: {
        Button: { primaryShadow: 'none', defaultShadow: 'none' },
        Input: { activeShadow: '0 0 0 2px rgba(9, 88, 217, 0.12)' },
        Tabs: { horizontalItemGutter: 32 },
      },
    }}>
      <App>{children}</App>
    </ConfigProvider>
  );
}
