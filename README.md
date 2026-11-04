# Hulinger 信息集合工具

面向个人日常使用的私有信息集合工具，首版聚焦 AI 模型更新、GitHub 开源项目及相关工具动态。以「自动收集 → 整理汇总 → 双端阅读与查找 → 个人整理 → 导出」为核心闭环，按正式上线项目的要求建设。

**当前阶段：产品设计。** 已建立本地 Git 与规范基线，并形成首版功能、来源策略和电脑/手机体验设计。用户已选择自动收集并入站、人工可修正。本阶段仅维护设计文档，尚未实现采集器、业务页面、后端或部署；远程仓库与服务器尚未配置。

## 规范入口

| 文件 | 作用 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 后续开发者和自动化代理必须遵守的入口约定 |
| [项目章程](docs/project-charter.md) | 产品定位、初始范围、阶段验收和变更方式 |
| [首版产品设计](docs/design/v1-product-design.md) | AI 资讯中心的功能、流程、数据关系与验收 |
| [来源策略](docs/design/v1-source-strategy.md) | 候选官方来源、自动采集、去重、热度及异常 |
| [双端体验规格](docs/design/v1-responsive-experience.md) | 电脑和手机的导航、页面、操作与验收矩阵 |
| [Git 工作流](docs/git-workflow.md) | 主分支、工作分支、提交、合并和版本标签 |
| [UI 标准](docs/ui-standard.md) | Ant Design、布局、交互、无障碍及验收 |
| [设计令牌](design/tokens.json) | 颜色、间距、字号等统一数值来源 |
| [开发规范](docs/engineering.md) | 工程边界、质量检查和完成标准 |
| [上线门禁](docs/production-readiness.md) | 环境、安全、备份、监控、发布和恢复 |
| [安全规范](SECURITY.md) | 私有数据、凭据和安全问题处理 |
| [初始决策](docs/adr/0001-project-baseline.md) | 已定原则、默认选择和待定技术事项 |
| [首版范围决策](docs/adr/0002-ai-information-v1.md) | 聚焦 AI 资讯、自动汇总及双端适配的依据 |

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

1. 收敛首批来源及范围，继续设计主要页面的电脑/手机视觉稿。
2. 确定定时采集、数据模型、登录与部署方案，记录包含成本和恢复方式的 ADR。
3. 进入开发后建立应用骨架与真实质量检查，实现自动采集和双端信息管理闭环。
4. 在预发布验证 UI、采集异常、权限、持久化、导出和恢复，完成上线门禁后发布首个生产版本。

历史变更见 [CHANGELOG.md](CHANGELOG.md)。当前没有生产版本。
