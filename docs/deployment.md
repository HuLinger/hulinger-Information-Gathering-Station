# 部署、备份与运维

适用：Linux Docker Compose 交付，2026-11-04。现有 Windows 原生服务部署使用 [Windows 候选更新流程](windows-update.md)，不要把本页的容器操作直接套用到 Windows 服务。本文不表示本轮更新已经部署到生产。

首次安装按 [README](../README.md) 执行。Bash 示例部署目录为 `/opt/hulinger`，Compose 项目名为 `hulinger`；更改后同步备份配置。生产与恢复环境不得共用项目名。

## 服务、权限与数据

| 服务 | 职责 | 数据与权限 |
| --- | --- | --- |
| `db` | PostgreSQL 18，仅容器网络可达 | `database` 卷挂载 `/var/lib/postgresql` |
| `migrate` | 一次性迁移，失败阻止业务启动 | 管理员连接，记录迁移 SHA-256 |
| `web` | Next.js 页面与接口 | `hub_app`，缓存为临时目录 |
| `worker` | 定时采集、导出与清理 | `hub_worker`；队列、进度与心跳持久化 |
| `caddy` | HTTPS 入口，暴露 80/443 | `caddy_data`、`caddy_config` 持久卷 |
| `admin` | `tools` profile 的账号管理 | 仅管理命令执行时运行 |

web/worker 使用非 root 用户、只读根文件系统，不持有数据库管理员密码。worker 拥有独立 `pgboss` schema，不能读取身份凭据表。拥有者配置只能由管理员修改。

云盘文件保存在 `drive_files` 卷的 `/data/drive/objects`；同一文件从上传到完成使用同一个对象路径，数据库决定是否允许下载。恢复需要**同一快照**的数据库 custom dump、文件树、对应代码/镜像、Compose/Caddy 配置及原 `BETTER_AUTH_SECRET`。Caddy 证书可在域名仍受控且证书服务可达时重申请；RTO 测量要计入申请时间及限制。

## 云盘存储与反向代理

原有项目名 `hulinger` 和 `database`、`caddy_data`、`caddy_config` 卷保持不变，只新增 `drive_files`。容器中的 web/worker 以 UID/GID 1000 写入文件，Caddy 只读挂载同一目录。绑定宿主机磁盘时在本地 `compose.override.yml` 为三个服务配置同一来源，预先给应用账号必要权限；Caddy 使用只读挂载。不要把文件目录放进 `public`、源码、备份暂存目录或系统临时盘。

`.env` 可设置单文件上限、配额、磁盘预留、分片和并发，默认分别是 1 TiB、无额外配额、1 GiB、16 MiB、最多 8 并发。应用还扣除进行中上传的剩余容量，空间不足会拒绝继续写入；这些默认值不代表磁盘或带宽承诺。大文件传输使用有界缓冲，暂停/重选文件后核对分片继续上传。

仓库 Caddy 仅对精确的上传分片 PUT 路径放宽到 33 MiB，其他接口仍为 1 MB。下载每次先请求应用验证拥有者、MFA 和文件状态，再只读直出文件，支持 HEAD、Range 与 If-Range；响应强制附件、禁止缓存和压缩，不开放目录浏览。客户端 `X-Drive-*` 会在鉴权前删除。固定 Caddy 2.11.7 镜像摘要，与应用的流式下载回退保持相同 ETag。

已有 Caddy/Cloudflare Tunnel 等入口应保留现有域名、TLS、隧道和访问控制，只合并本仓库的上传/下载路由；原生 Windows 下把文件根改为实际私有目录并分别授予应用写入、Caddy 读取权限。未合并直出路由时，应用仍提供受鉴权的流式 Range 下载。最终吞吐受客户端、链路、代理、磁盘与服务器共同限制；代理的请求体/超时设置须容纳单个分片。

## 配置与安装核对

1. 确认发行版、CPU 架构、容量、时间同步、DNS 与 80/443；按 [Docker 官方文档](https://docs.docker.com/engine/install/) 安装 Engine/Compose。
2. 取得已验证的完整提交；`.env` 填四个独立秘密及实际 HTTPS 域名，权限 `600`。
3. 校验 Compose、构建、等待数据库健康并迁移。历史 SQL 被修改时迁移停止，应新增迁移，不删除记录掩盖差异。
4. 交互创建唯一拥有者，启动服务并完成 TOTP 绑定和恢复码保管。公开注册、网页初始化、邮件找回未开放。
5. 验证未登录 `/api/hub` 返回 401；完成 MFA 后再验证业务，以及重启持久化。
6. 完成备份、隔离恢复和告警，填写 [上线门禁](production-readiness.md)。

`POSTGRES_PASSWORD` 仅在**第一次初始化空卷**时创建数据库密码。之后只改 `.env` 不会改变现有 PostgreSQL 角色；不要重建卷解决密码不一致。轮换需经受控管理员连接修改数据库密码，更新 `.env` 并验证迁移/备份。`APP_DB_PASSWORD`、`WORKER_DB_PASSWORD` 由迁移更新：先停 web/worker，迁移后重建容器。

`BETTER_AUTH_SECRET` 用于 MFA 数据加密，不要例行重生成。确需轮换时先备份并在隔离环境验证恢复，安排拥有者重新绑定。凭据泄漏/遗失通过管理命令重设密码、撤销会话与旧 MFA。

## 升级与回滚

先在隔离环境验证新提交的依赖安装、`npm run check`、构建、迁移及关键路径，保存 CI 结果。服务器配置放 `.env` 和 `compose.override.yml`；两个文件均被 Git/Docker 构建排除，不能把源码定制藏在忽略规则里。

```bash
cd /opt/hulinger
sudo bash -c 'set -a; source /etc/hulinger/backup.env; set +a; bash "$HUB_DIR/scripts/update.sh" origin/main'
```

上述命令适用于**已经包含更新脚本**的干净 Linux 部署。脚本拒绝未提交/未跟踪源码和本地分叉提交，不执行 reset、clean 或 stash；只接受快进。它记录旧提交/镜像到私有 `.deploy/previous-release` 并保留镜像标签，先完成配对备份，再切换源码并构建，之后停止写入、迁移和等待健康。构建失败会返回旧提交且不停止原容器；迁移或启动失败保持 web/worker 停止，不能悄悄跳过失败。

**v0.1 首次升级**时旧目录没有 `scripts/update.sh` 和其共享 helper，不要直接运行不存在的脚本，也不要只下载单个文件。先将新发布克隆到独立候选目录并核对提交，将原部署的已提交定制正常合入候选；配置保留在原部署。完成候选检查与旧版数据库备份后，才能按下列受控步骤迁移原部署。若原目录含本地定制提交，须先合并上游并处理冲突，不能使用快进更新器绕过。现有 Windows 定制部署使用单独的候选工具。

```bash
# 仅用于已确认无本地源码定制的旧 Linux 部署；先验证备份成功。
git status --short
git fetch origin
git merge --ff-only 已验证的完整提交
bash scripts/compose.sh config --quiet
bash scripts/compose.sh build web worker migrate
bash scripts/compose.sh stop web worker
bash scripts/compose.sh run --rm --no-deps migrate
bash scripts/compose.sh up -d --no-build --wait --wait-timeout 180 web worker
bash scripts/compose.sh up -d --no-build caddy
bash scripts/compose.sh restart caddy
```

每条成功后再继续。迁移失败时保持入口关闭，检查脱敏日志和兼容性；不要继续启动。新版本验证登录、MFA、创建/编辑/搜索/导出、来源任务和持久性，记录提交与镜像。

数据库兼容旧应用时，可切回记录的旧提交，将 `HULINGER_IMAGE` 设为记录的保留镜像标签，再用原配置 `up -d --no-build --wait`。不要 `source .deploy/previous-release` 执行未知内容，直接核对文件中的值。不兼容或数据受损时先停入口及写入、保护现有数据，走隔离恢复与切换；恢复会影响备份点后的写入，代码回退不能代替数据库恢复。首次发布无上一生产版本，撤下时停 `caddy web worker` 并保留卷和副本。

普通故障不要执行 `docker compose down -v`。PostgreSQL 主版本升级须单独演练，不能只改容器标签；本项目锁定 PostgreSQL 18 镜像与对应卷路径。

## 每日加密备份

[scripts/backup.sh](../scripts/backup.sh) 在 Linux 宿主机暂停 web 和 worker（包括文件清理），生成 PostgreSQL custom dump，检查归档目录可读，并从实际容器挂载发现云盘路径。数据库、文件树、`.env`、本地 Compose 覆盖、Caddy 配置、记录数量和版本信息进入**同一个 restic 快照**。文件树直接增量备份，不生成整盘 tar 或二次完整复制。成功后恢复原来运行的服务，再保留每日 7 份、每周 4 份并检查仓库元数据；失败也只恢复原来运行的服务。成功时间写入 `/var/lib/hulinger-backup/last-success`。

首次全量备份及大量变更需要与上传量相称的维护窗口，期间上传/下载和后台采集不可用；不要用几秒的数据库 dump 时间估算整个窗口。后续 restic 去重减少传输，但仍需测量文件扫描与备份时间。已存在云盘表但无法识别挂载时脚本拒绝生成仅数据库备份。云盘回收站和进行中上传也在快照中，恢复后继续受原保留期约束。

备份目标必须位于独立故障域，例如另一台服务器的受限 SFTP 目录或对象存储；同机另一目录不能防服务器损坏。restic 发送前加密，密码与副本分开保管并留离线恢复材料。[restic 备份](https://restic.readthedocs.io/en/stable/040_backup.html)、[保留策略](https://restic.readthedocs.io/en/stable/060_forget.html)

以下采用专用 SFTP 仓库。替换域名/账号/路径，在 root 的 SSH 配置中指定受限密钥，核实主机指纹；无人值守任务不要关闭主机密钥校验。

```bash
# Debian / Ubuntu；其他系统使用对应软件包管理器。
sudo apt update
sudo apt install restic openssh-client util-linux
sudo install -d -m 0700 /etc/hulinger /var/lib/hulinger-backup
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/hulinger/restic-password'
sudoedit /etc/hulinger/backup.env
```

`/etc/hulinger/backup.env`：

```ini
HUB_DIR=/opt/hulinger
HUB_COMPOSE_PROJECT=hulinger
BACKUP_HOST=hulinger-production
RESTIC_REPOSITORY=sftp:backup@backup.example.com:/srv/backups/hulinger
RESTIC_PASSWORD_FILE=/etc/hulinger/restic-password
```

```bash
sudo chmod 600 /etc/hulinger/backup.env /etc/hulinger/restic-password
sudo bash -c 'set -a; source /etc/hulinger/backup.env; set +a; restic init'
```

`init` 仅新仓库执行一次，已有仓库检查访问即可。首次启用前用 `restic forget --host hulinger-production --tag hulinger --group-by host,tags --keep-daily 7 --keep-weekly 4 --dry-run` 核对保留范围。脚本只筛选对应 host/tag，仍建议使用专用仓库；存储支持不可变副本时，另行设置并验证留存。

创建 `/etc/systemd/system/hulinger-backup.service`：

```ini
[Unit]
Description=Hulinger encrypted PostgreSQL backup
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=root
UMask=0077
EnvironmentFile=/etc/hulinger/backup.env
ExecStart=/bin/bash /opt/hulinger/scripts/backup.sh
TimeoutStartSec=2h
```

创建 `/etc/systemd/system/hulinger-backup.timer`：

```ini
[Unit]
Description=Daily Hulinger backup

[Timer]
OnCalendar=*-*-* 03:30:00 Asia/Shanghai
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl start hulinger-backup.service
sudo systemctl status hulinger-backup.service --no-pager
sudo journalctl -u hulinger-backup.service --since today --no-pager
sudo systemctl enable --now hulinger-backup.timer
sudo systemctl list-timers hulinger-backup.timer
```

临时磁盘须容纳完整 dump。明文临时文件位于 root 的 `0700` 目录，退出时清理；主机崩溃仍可能留下文件，故障处理时核对。为任务失败和成功时间超过 26 小时设置外部告警。

`pg_restore --list` 与 `restic check` 不能证明业务恢复。每月另做一次 `restic check --read-data`，并按下一节实际恢复。备份密码、仓库访问材料不能仅存在被备份服务器上。

## 隔离恢复演练

首次上线前、每季度及数据库/认证/备份变化后演练。目标 RPO ≤ 24 小时、RTO ≤ 4 小时，须实测确认。以下只操作**新恢复服务器或独立 Compose 项目**，不覆盖现有生产数据库。

1. 安装 Docker/restic，取回单独保管的备份密码和存储访问密钥。选择明确快照，记录时间，恢复到空目录；检查 `release.txt` 并取得对应提交/镜像。

```bash
sudo install -d -m 0700 /var/lib/hulinger-restore
sudo bash -c 'set -a; source /etc/hulinger/backup.env; set +a; restic snapshots --host hulinger-production --tag hulinger'
# 替换 SNAPSHOT_ID；恢复整个快照，同时取回数据库和文件树。
sudo bash -c 'set -a; source /etc/hulinger/backup.env; set +a; restic restore SNAPSHOT_ID --sparse --target /var/lib/hulinger-restore'
```

2. 默认备份暂存内容恢复到 `/var/lib/hulinger-restore/var/lib/hulinger-backup/staging`；改变了 `HUB_BACKUP_STATE` 时按快照中的原绝对路径定位。在独立部署目录取得对应源码，将其中 `site.env` 安全复制为 `.env`（`600`），保留原 `BETTER_AUTH_SECRET`。改成恢复域名及其 `APP_URL`；可生成新的数据库密码。**不直接加载备份中的 Compose 覆盖文件**，它可能绑定生产文件目录或显式命名生产卷，必须逐项改成隔离目标后才能使用。原文件只供审查。
3. 显式使用项目名 `hulinger_restore`，并仅指定标准 `compose.yml`。`--clean` 只针对这个新数据库：先迁移空库建立运行角色，再恢复带 ownership/ACL 的 dump。不要用 `--no-owner`，否则 pg-boss 对象可能归错角色。

```bash
cd /opt/hulinger-restore
dc=(docker compose --env-file .env -p hulinger_restore -f compose.yml)
staging=/var/lib/hulinger-restore/var/lib/hulinger-backup/staging
"${dc[@]}" build web
"${dc[@]}" up -d --wait db
"${dc[@]}" run --rm --no-deps migrate
sudo cat "$staging/hulinger.dump" | "${dc[@]}" exec -T db pg_restore -U postgres -d hulinger --clean --if-exists --exit-on-error
"${dc[@]}" run --rm --no-deps migrate
# drive-path.txt 记录原实际挂载路径；restic 按原绝对路径恢复在新根下。
drive_source="$(sudo cat "$staging/drive-path.txt")"
test -n "$drive_source"
sudo test -d "/var/lib/hulinger-restore$drive_source/objects"
"${dc[@]}" run --rm --no-deps --user root \
  -v "/var/lib/hulinger-restore$drive_source:/restore:ro" web sh -c 'cp -a --sparse=always /restore/. /data/drive/'
"${dc[@]}" run --rm --no-deps web node --import tsx scripts/verify-drive-storage.ts
```

任一步失败即停止，保持 web/worker 未启动；查清后在新的空恢复环境重试。不要发布部分恢复的数据库，也不要用直接复制运行中的 PostgreSQL 目录代替恢复。

文件复制必须保留所属 UID/GID；上面的 `cp -a --sparse=always` 从快照恢复到**新建恢复卷**，与 restic 的 `--sparse` 配合，避免未完成上传的零区间占满实际磁盘。不要把旧生产文件卷挂进恢复项目，也不要把“数据库恢复成功、文件稍后再补”视为可用恢复。旧版没有云盘的快照 `drive-path.txt` 可为空，此时不执行文件复制；新版本迁移创建空云盘表后仍执行校验器。备份脚本首次引入之前的旧快照没有该清单，应先按其原版本说明恢复，再升级。

4. 对照 `counts.tsv` 核对事件、实体、来源、文件和分片数量。校验器逐一检查文件类型、大小、完整文件分片数量与全部已提交分片 SHA-256，含回收站及未完成上传；校验失败即停止，不启动 worker 清理。随后记录原来启用的来源，关闭它们并撤销旧会话，防演练自动访问来源；核对后再逐一启用。

```bash
"${dc[@]}" exec -T db psql -U postgres -d hulinger -v ON_ERROR_STOP=1 -c 'SELECT id,enabled,last_success FROM sources ORDER BY id;'
"${dc[@]}" exec -T db psql -U postgres -d hulinger -v ON_ERROR_STOP=1 -c 'UPDATE sources SET enabled=false; DELETE FROM "session";'
"${dc[@]}" up -d --wait --wait-timeout 180 web worker
"${dc[@]}" ps
```

5. 在独立服务器启动 Caddy 并用恢复域名验证 HTTPS。同机演练**不要启动第二个默认 Caddy**，它会争用 80/443；在现有受控反向代理添加独立恢复站点，或移至隔离服务器验证。不要公开数据库/应用端口。
6. 核对事件/实体/来源/个人状态数量，抽查备注、人工覆盖、关联、排除标识和时间，验证登录/MFA、搜索、编辑、导出、文件下载/断点续传及重启。原身份密钥无法恢复时用管理员恢复命令重设拥有者并重绑 MFA，记录影响。
7. 在一个明确的公开来源上重新启用并同步两次，核对去重、人工修正、队列与进度，再按计划切换域名/入口。保护原数据副本，处理备份点后的写入差异。

记录快照 ID、提交/镜像、备份点、开始/结束时间、数据库大小、抽样、MFA/业务结果、RPO/RTO、失败点和修复。dump 与私人截图不得放进公开日志。[restic 恢复说明](https://restic.readthedocs.io/en/stable/050_restore.html)

## 监控与排障

部署者配置外部探测和通知渠道；应用提供状态与诊断入口，未内置邮件/聊天告警服务。

| 检查 | 初定告警条件 | 定位方向 |
| --- | --- | --- |
| HTTPS health/ready | 每 5 分钟探测，连续 3 次失败 | Caddy、web、数据库 |
| worker / 来源 | 心跳失联，或启用来源超过两个周期未成功 | worker、任务、配额与网络 |
| 备份 | 失败或成功时间超过 26 小时 | restic、权限、磁盘与数据库 |
| 磁盘 | 使用率超过 80% | 卷、镜像、日志与备份临时空间 |
| 证书 | 剩余少于 14 天 | DNS、端口、Caddy 卷与续期 |

```bash
docker compose ps
docker compose logs --tail 80 web worker migrate caddy
docker compose exec -T db psql -U postgres -d hulinger -c "SELECT id,seen_at FROM worker_heartbeats;"
docker compose exec -T db psql -U postgres -d hulinger -c "SELECT id,enabled,last_success,next_run,error FROM sources ORDER BY id;"
df -h
docker system df
```

不记录完整连接串、Cookie 或业务正文。Compose 每服务按 3 个、每个 10 MB 轮转，是容量上限，不保证保留满 14 天；规范要求的应用 14 天、安全/发布 30 天留存，须另配受控归档并核对脱敏与容量。

- **登录/跨源错误**：核对地址与 `APP_URL`、HTTPS、手机/服务器时间；失败过多等待限速。首次登录须绑定 MFA。
- **迁移失败**：查数据库健康、已有卷的管理员密码与历史迁移；保持业务停止，不删迁移记录。
- **来源启用失败**：按页面网络/解析错误排查服务器出站访问；不要填任意内网或代理 URL 绕过白名单。GitHub 限流等退避时间再试。
- **无新内容**：新来源初始关闭；检查来源开关、worker 心跳与任务。首次观测缺少增长窗口属正常状态。
- **导出排队**：检查 worker；每分钟处理任务，在数据管理页刷新。下载需拥有者有效会话。
- **构建被杀**：检查 OOM、增加构建资源或用同架构受控构建机；不要跳过质量检查。
- **外部来源失联**：已有资料仍可读，页面显示异常；不要伪造同步成功或用样例替代。

在选择的通知渠道发送一次演练告警，确认维护者收到，才能填写对应生产证据。
