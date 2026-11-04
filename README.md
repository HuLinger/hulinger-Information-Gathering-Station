# Hulinger 信息集合工具

面向个人日常使用的私有信息集合工具，以「收集 → 整理 → 查找 → 使用 → 导出」为核心闭环，按正式上线项目的要求建设。

**当前阶段：规范基线。** 已建立本地独立 Git 仓库、协作约定、Ant Design UI 标准、设计令牌、基础检查和上线门禁。尚未实现业务页面、后端或部署；远程仓库与服务器尚未配置。

## 规范入口

| 文件 | 作用 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 后续开发者和自动化代理必须遵守的入口约定 |
| [项目章程](docs/project-charter.md) | 产品定位、初始范围、阶段验收和变更方式 |
| [Git 工作流](docs/git-workflow.md) | 主分支、工作分支、提交、合并和版本标签 |
| [UI 标准](docs/ui-standard.md) | Ant Design、布局、交互、无障碍及验收 |
| [设计令牌](design/tokens.json) | 颜色、间距、字号等统一数值来源 |
| [开发规范](docs/engineering.md) | 工程边界、质量检查和完成标准 |
| [上线门禁](docs/production-readiness.md) | 环境、安全、备份、监控、发布和恢复 |
| [安全规范](SECURITY.md) | 私有数据、凭据和安全问题处理 |
| [初始决策](docs/adr/0001-project-baseline.md) | 已定原则、默认选择和待定技术事项 |

## 本地开始

规范工具使用 Node.js 22 或更高版本及 Git；当前没有第三方 npm 依赖，无需安装业务框架。

```powershell
git rev-parse --show-toplevel
npm run setup
npm run check
git switch -c codex/feat/collect-information
```

`setup` 只设置本仓库的 Git hooks 与换行策略。`check` 验证仓库边界、必备文件、文本格式、JSON、本地文档链接、常见敏感文件和预设颜色对比度；它不替代业务测试、安全审计或浏览器无障碍检查。新克隆需重新运行 `setup`。

`.github/workflows/quality.yml` 提供 GitHub Actions 检查模板。推送到 GitHub 后才能产生远程运行记录；保护分支需在远程单独配置。

## 接下来的里程碑

1. 根据实际收集内容和部署条件，确定技术栈、数据模型、登录方式及托管方案，记录 ADR。
2. 建立应用骨架、真实质量检查和 Ant Design 基础页面，使用合成数据完成 UI 验收。
3. 实现信息管理闭环，在预发布环境验证权限、持久化、导出和恢复。
4. 完成上线门禁后发布首个生产版本。

历史变更见 [CHANGELOG.md](CHANGELOG.md)。当前没有生产版本。
