# Git 与版本管理

状态：2026-11-04 初始基线。采用适合个人维护的短期分支流程，以 `main` 为唯一长期主干。

## 仓库与分支

- 项目必须有自己的 `.git`，仓库根目录必须是本项目目录。禁止在父目录仓库执行本项目的暂存、提交、重置或推送。
- `main`：通过对应阶段检查的稳定基线；候选版本可在隔离环境验证，生产使用仍须完成上线门禁。
- 日常分支：`codex/<type>/<slug>`，type 为 `feat`、`fix`、`docs`、`refactor`、`test`、`chore`、`ci`、`perf`、`build` 或 `hotfix`。slug 使用小写英文、数字和短横线。
- 每个分支只处理一个明确目的，例如 `codex/feat/information-search`；尽量短期合并，不建立长期 `develop` 分支。
- 紧急修复从实际生产标签创建 `codex/hotfix/<slug>`，验证后合回 `main`，不得遗忘主干同步。
- 禁止向共享分支强制推送；不重写已经发布的标签。合并后确认已合入再删除工作分支。

## 初次建立及本地阶段

空仓库允许在 `main` 创建一次初始规范提交，随后切换工作分支。未配置远程时，在本地完成变更和检查，使用快进合并进入 `main`，保留核验记录；需要重整历史时仅操作自己的未发布分支。不得自动继承父仓库 remote。

克隆后运行 `npm run setup` 安装本仓库 hooks。提交钩子会拒绝在已有提交的 `main` 上继续直接提交，并检查工作分支、暂存快照与消息；它可以被本机用户绕过，不能代替远程保护。

```powershell
git switch main
git switch -c codex/feat/information-search
# 完成一个可独立审查的变更后：
npm run check
git add <本次变更的明确文件路径>
git diff --cached
git commit -m "feat(search): 支持按标题搜索信息"
```

有远程后，从最新 `main` 创建分支；检查全部差异后推送工作分支，创建 PR。合并优先 squash，PR 标题即合并提交主题；本地尚无远程阶段使用 `git merge --ff-only <branch>`，不在 `main` 上手写合并提交。

## 提交与 PR

提交格式：`type(scope): 简明描述`，scope 可省略，允许 `!` 标记破坏性变更。

type 允许 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。主题不超过 100 个字符，说明实际结果，不写「update」「修改一下」。中文描述可以使用。

PR 必须说明问题、最终行为、验证、截图（适用时）、数据迁移与风险、回滚方式。检查结果必须基于实际执行；未运行不可勾选。UI、安全、数据及架构规范变更同步更新文档。个人项目允许负责人自查，但不能伪造第二人批准。

## 接入远程后的保护设置

远程按用户明确要求更名并公开为 [HuLinger/hulinger-Information-Gathering-Station](https://github.com/HuLinger/hulinger-Information-Gathering-Station)，依据见 [ADR 0004](adr/0004-public-source-repository.md)。下列设置须核实实际生效；仓库内的 YAML 不会自动启用分支保护，结果记录在 [验收记录](verification/v1-validation.md)：

1. 代码仓库公开，默认分支 `main`；业务数据、真实配置和备份不得入库，部署网站仅允许主账号及其创建的成员登录，各账号数据独立。
2. 要求 PR 合并、会话解决、状态检查通过；必须检查名称为 `Repository baseline`，应用建立后加入真正的构建与测试检查。
3. 禁止 force push 和删除 `main`，将规则应用到管理员；禁止将常规绕过作为发布方式。
4. 单人阶段不要求不存在的第二位审核者；有协作者后对 UI、权限、数据迁移等改动要求至少一位其他人员审核。
5. 保护发布标签；配置机密扫描/推送保护（平台支持时），依赖与安全检查按实际栈接入。生产环境凭据独立于 PR 工作流。
6. 保存实际设置截图或可核验导出，记录首次 CI 运行链接；不要把本文当作远程配置完成证据。

仓库可见性变更须由用户明确授权；本次公开源于用户主动要求。后续如改回私有，须重新核实套餐和保护能力。本地 hooks 和书面自审不替代远程门禁。

## 版本与回退

- 应用发布使用 `vMAJOR.MINOR.PATCH` 标签；初始规范提交不打生产版本标签。正式首版从 `v1.0.0` 开始，预发布使用 `v1.0.0-rc.1` 等标签。
- 标签指向通过门禁的明确提交，记录构建产物标识、时间、环境、迁移和恢复方案；生产只部署对应不可变产物。
- 新功能提升 MINOR，兼容修复提升 PATCH，破坏性数据/API变化提升 MAJOR。无产品功能变化的内部维护不制造用户更新条目。
- `CHANGELOG.md` 保存每次用户可见变化；同一版本下归并新增、优化、修复。未发布内容放在「未发布」。
- 发布前执行 `git status`、适用检查和 `git diff`；不得从包含未提交改动的工作区构建生产版本。
- 已合并错误优先用新的 `revert` 提交撤销；生产应用回退使用上一健康产物。数据库恢复另按上线手册执行，不能以 Git 回退代替。

依据：[GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow)、[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)、[保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)。分支前缀、版本起点和个人审核方式为本项目约定。
