# ADR 0004：公开代码仓库与最终名称

- 日期：2026-11-04
- 状态：采用，已按用户明确授权执行。

## 背景与决定

首版最初上传到私有仓库 `HuLinger/hulinger-ai-hub`。用户随后要求更名为 `hulinger-Information-Gathering-Station`，并进一步明确要求公开仓库。

将同一个仓库更名并设为 public，保留 Git 历史、PR 和 CI 记录。最终地址为 <https://github.com/HuLinger/hulinger-Information-Gathering-Station>；README 使用公开 HTTPS 克隆地址，不要求部署者提供 GitHub 令牌。

## 范围与影响

公开范围为代码、设计和脱敏验证材料。生产数据、个人真实内容、环境秘密、附件和备份继续禁止进入 Git。应用仍是本人登录、MFA 和服务端授权后的个人工具；本次不增加公共资料入口、多用户注册或分享功能。

公开是用户对代码仓库的明确决定，不是为绕过付费能力而自行变更。`main` 保护要求 PR、必需检查、解决会话，应用到管理员，禁止强推和删除；单人阶段不要求不存在的第二位审核者。

## 验证与维护

GitHub API 已确认仓库为 public、名称正确，`main` 分支保护实际生效。本地 remote、README、章程、Git 流程和上线记录同步新名称与可见性。CI 密钥扫描通过；截图仅含合成测试身份及公开来源。后续可见性和权限变更仍须明确授权，生产上线另按原门禁验收。
