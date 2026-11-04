# 首版验证记录

日期：2026-11-04（Asia/Shanghai）。性质：本地与 CI 部署候选验证，不是用户服务器上线记录。

## 环境与数据边界

- 本地 Windows、Node.js 22.14、独立 PostgreSQL 18.6 测试集群；数据库名称明确为测试库。
- 页面运行于本机 3001 端口，使用合成拥有者和隔离凭据。页面示例与真实公开采集内容只存在本地测试库，不进入 Git，也不会在安装时注入。
- 目标服务器、域名、CPU 架构、异地备份账号与通知渠道未提供，尚未执行生产发布。

## 已取得证据

- 真实数据库领域测试：创建、重复链接、版本冲突、人工覆盖、收藏、搜索、合并/撤销、回收站恢复与永久删除、结构化导出通过。打开合并详情导致已读变化后，仍可撤销合并且保留备注。
- 10,000 条合成记录的 20 次分页搜索，2026-11-04 最新本地 p95 为 13.8 ms，小于项目 500 ms 预算；该结果不代表服务器端到端性能。
- 浏览器走通密码登录、首次 TOTP 绑定、首页、手机收藏、备注保存、备注搜索、收藏回找和后台导出下载。
- 实际下载 JSON 为 `hulinger-personal-export` v1，包含 473 条事件、4 个来源、27 个实体和 11 条修订，包含测试私人备注；不含账号、会话或密码表。数量为当次公开采集与测试快照，之后可变化。
- 真实 OpenAI 和 Microsoft 官方源可解析并入库；GitHub API 已获得项目与发布信息，匿名配额耗尽时保留游标和重试时间，页面如实显示异常。Claude 源在当前网络发生 307 跳转，安全抓取拒绝跳转，保持未启用。
- Compose 配置语法、备份脚本 Bash 语法已验证；下述 CI 已实际执行容器运行和 PostgreSQL 恢复。

## 本地全量检查

- `npm run check`：规范、ESLint、TypeScript 通过；当前 27 项测试通过、0 失败、2 项外网用例未在默认测试运行中启用。真实外网另行执行：OpenAI/Microsoft RSS 通过；GitHub 后续复核因真实配额限制跳过，先前 worker 的 Search/Repo/Release 实际结果已留库。
- `npm run build`：生产编译、类型和页面生成成功。
- `npm audit --omit=dev`：0 漏洞。完整开发依赖审计有 16 个 moderate 传递影响，根因是 ESLint 链中的 minimatch 通配模式拒绝服务公告 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)。生产安装不含这条开发依赖链，网站不接受外部输入作为 lint glob；未强制覆盖不兼容大版本或降低检查门槛。维护者应随上游兼容更新处理，不能称完整依赖审计全绿。
- 并发回归分别证明：旧实现同时手动补充/采集同 URL 会产生 2 条事件，修复后只有 1 条；旧撤销合并锁顺序触发真实 PostgreSQL deadlock，修复后通过。测试只操作隔离合成记录。
- UI 截图及修正历史见 [设计验收](../../design-qa.md)。
- 对首页代理持续注入 HTTP 200 HTML 错误响应，页面显示可重试错误；恢复真实响应后点击重试成功加载，复测无新的浏览器错误。5 项响应回归测试覆盖坏 JSON、非对象、不完整资料、服务端错误及有效内容保留。

## 远程与容器验证

仓库、工作分支和 [PR #1](https://github.com/HuLinger/hulinger-Information-Gathering-Station/pull/1) 已创建。[CI 运行 41828527974](https://github.com/HuLinger/hulinger-Information-Gathering-Station/actions/runs/41828527974) 对提交 `ae30fcf8596aaf970bb1f4bf60192e300e39197a` 全部通过：规范、lint、类型、27 项单元/真实数据库测试、生产构建、生产依赖审计、gitleaks 及 Docker 镜像构建。

- Compose 在 Ubuntu CI 中实际执行首次迁移、db/worker/web 健康启动、未登录业务 API 返回 401、web/worker 重启后健康检查。
- `pg_dump --format=custom` → 独立恢复库 → `pg_restore` → 重跑迁移实际通过；核对记录数、中文备注、收藏、人工覆盖、标签、实体与来源关系、排除状态、关注、迁移记录、pg-boss 所有权及 web/worker 权限。清理演练库与合成行并恢复 worker 后健康检查通过。
- 这证明 CI 的容器与逻辑备份恢复路径，不代表目标服务器 HTTPS、异地 restic 存储、真实告警或 RPO/RTO 已验证。

2026-11-04 用户明确要求仓库更名并公开，已执行为 `HuLinger/hulinger-Information-Gathering-Station`。`main` 已实际启用必需 PR、`Repository baseline` 状态检查、分支需最新、会话解决及管理员保护，禁止强推和删除；单人阶段批准人数设为 0。实际设置导出见 [GitHub 核验记录](github-settings.json)，决定见 [ADR 0004](../adr/0004-public-source-repository.md)。此前私有状态的套餐限制不再作为当前缺项。

## 当前部署缺项

域名/HTTPS、目标服务器可用资源与网络、每日异地加密备份、真实告警送达和目标环境恢复演练尚未配置。全部满足 [上线门禁](../production-readiness.md) 后才可称生产上线。
