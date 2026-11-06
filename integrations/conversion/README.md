# 转换工具引擎部署

这套独立 Compose 为现有网站提供 ConvertX、Transmute、Stirling-PDF 与 NCM 内网处理服务。网站继续负责成员身份、文件归属、队列、下载和 **24 小时**保留；引擎不挂载网站数据库、云盘、转换结果目录或密钥。

固定来源与摘要见 [UPSTREAM.json](UPSTREAM.json)，Stirling 和 NCM 的本地包装分别见 [Stirling 说明](stirling/README.md)、[NCM 说明](ncmdump/README.md)。

## Windows / WSL2 安装

前提是受支持的 Node.js 22 或更新版本，以及已经安装并运行 Linux 容器模式的 Docker Desktop / WSL2。先确认 `docker version` 能取得 Server 信息，`docker compose version` 可用。初始化脚本不会安装或自动启动 Docker Desktop。

在仓库根目录执行：

```powershell
node -- scripts/setup-converters.mjs
```

默认操作只准备两个被 Git 忽略的私密文件：

- `.env.conversion`：引擎签名密钥、专用 Transmute 管理员凭据，以及初始化后取得的 API key。已有非空值不会被替换。
- `.env.conversion.runtime`：只有网站需要的四个 URL 与 `TRANSMUTE_API_KEY`；初始化之前 key 为空。

脚本不打印密码、令牌或 API key。POSIX 文件权限为 `0600`；Windows 使用当前用户 SID 设定文件 ACL。不要把这两个文件提交到 Git、粘贴到聊天或收集到命令日志。使用自定义位置时，传 `--env-file <路径>`；运行配置默认写到该路径后加 `.runtime`，也可通过 `--runtime-env-file <路径>` 指定。仓库内路径必须已被 Git 忽略。

审查 [compose.yml](compose.yml) 后，可以只验证配置语法：

```powershell
docker compose --env-file .env.conversion -f integrations/conversion/compose.yml config --quiet
```

保留 `--quiet`，普通 `config` 会展开私密环境变量。确认资源预算后，显式构建和启动：

```powershell
node -- scripts/setup-converters.mjs --build --start
```

`--build` 构建本地网关、Stirling 与 NCM 镜像，均以固定摘要为基础；ConvertX、Transmute 直接使用固定摘要的上游镜像。`--start` 启动项目名为 `hulinger-conversion` 的四个引擎及网关，等待健康检查后初始化 Transmute。只构建一个本地镜像可用 `--build-engine gateway`、`--build-engine stirling` 或 `--build-engine ncmdump`；对已经运行的引擎补做初始化可用：

```powershell
node -- scripts/setup-converters.mjs --initialize
```

脚本始终使用本目录的独立 Compose，不修改根 Compose、现有 Windows 服务、网站环境或 worker 环境。构建/启动失败保留配置和数据卷，不自动清空或重置。

## 接入现有网站与 worker

初始化成功后，将私密 `.env.conversion.runtime` 文件中的以下五项合并到现有网站与 worker 的服务端环境，按原来的服务更新流程重新加载配置：

| 变量                | 本机独立引擎默认地址               |
| ------------------- | ---------------------------------- |
| `CONVERTX_URL`      | `http://127.0.0.1:8091`            |
| `TRANSMUTE_URL`     | `http://127.0.0.1:8092`            |
| `TRANSMUTE_API_KEY` | 脚本保存的原始 key，只在服务端使用 |
| `STIRLING_PDF_URL`  | `http://127.0.0.1:8093`            |
| `NCMDUMP_URL`       | `http://127.0.0.1:8094`            |

两个现有进程都应使用相同的 URL 与 key。不要把它们加入任何 `NEXT_PUBLIC_*` 变量，不要让浏览器直接访问引擎。这里的回环地址只适用于网站和 worker 运行在同一 Windows 宿主的情况。网站也运行在 Docker 中时，使用下节的内部 DNS 接入；宿主回环端口用于初始化和本机诊断，不开放到其他主机。

引擎自身不能证明站点账号隔离。所有上传、状态、下载和删除必须经本站授权；共用引擎服务账号不意味着成员可以访问彼此文件。网站存储路径、输入/输出上限、账号配额与任务预算按根环境说明配置。此 bundle 的 Stirling 上传上限明确覆盖为 `512MB`、multipart 请求上限 `520MB`，与本站 512 MiB 输入上限配套。

## Linux / Docker 主站接入

引擎和既有网站保持独立项目，复用上一步已经初始化的引擎与数据库。先用 `node -- scripts/setup-converters.mjs --build --start` 启动项目 `hulinger-conversion`；确认现有网站的根 `.env` 已按安装说明配置，再在仓库根目录运行：

```sh
docker compose --env-file .env --env-file .env.conversion -f compose.yml -f integrations/conversion/site.compose.yml config --quiet
docker compose --env-file .env --env-file .env.conversion -f compose.yml -f integrations/conversion/site.compose.yml up --detach --build
```

[site.compose.yml](site.compose.yml) 只给现有 `web` 和 `worker` 添加引擎网络、服务 DNS 地址及服务端 API key。它保留主项目名和已有数据库/文件卷，不复制 Transmute，也不给任何引擎加入业务 `backend` 网络。运行配置为 `http://convertx:3000`、`http://transmute:3313`、`http://stirling:8080`、`http://ncmdump:8080`；Windows 用的 `.runtime` 回环地址不用于 Docker 容器。

外部网络默认名为 `hulinger-conversion_conversion`，由独立 bundle 以 `internal: true` 创建。可用 `docker network inspect hulinger-conversion_conversion --format '{{.Internal}}'` 确认返回 `true`。若引擎使用显式的其他项目名，应在主站配置中设置 `CONVERSION_NETWORK_NAME=<项目名>_conversion`；开发验证使用 `hulinger_conversion_dev_conversion`。这里的 external 表示跨 Compose 项目复用已有网络，不表示网络可以访问公网。

`--env-file` 使用了自定义凭据路径时，将上述命令第二个环境文件同步替换为相同路径。不要省略 `site.compose.yml` 后误以为主站已经连接转换网络，也不要把它作为独立文件启动。

## Transmute 初始化与恢复

固定 v2.1.1 的初始化顺序为：

1. `GET /api/health/ready`，然后 `GET /api/users/bootstrap-status`。
2. 只有 `requires_setup=true` 时，使用已先写入私密文件的随机密码创建专用首位管理员。已有账号的引擎不会再次创建或替换管理员。
3. 使用保存的专用账号认证，或复用已保存的管理员 API key。错误凭据、停用账号或权限不足会中止并报告，不执行重置。
4. 已保存的 API key 只作认证检查；没有 key 时先查询同名 `hulinger-worker`。只有不存在同名 key 才创建，并立即原子保存一次性返回的 `raw_key`。
5. `PATCH /api/settings` 设置 `cleanup_enabled=true`、`cleanup_ttl_minutes=1440`、`keep_originals=true`，核对返回值后生成网站运行配置。

首次 bootstrap 的 key 继承专用管理员权限，必须只保存在本站服务端。没有公开注册或访客模式；`AUTH_SECRET_KEY` 固定保存在凭据文件。设置接口必须有管理员权限，不能把访客 token 当作 API key。

如果同名 key 已存在但本地原始 key 丢失，脚本拒绝继续增发；请恢复凭据文件，或由管理员明确撤销旧 key 后重新初始化。若数据库为空却保存着旧 key，脚本同样拒绝自动重建，要求恢复匹配的数据库与凭据。不要通过删除 Transmute 数据卷解决认证失败。

Transmute 的账号、API key 哈希和设置位于独立 `transmute-db` 卷的 `/app/data/db/app.db`。备份时应同时保留此卷的一致快照与 `.env.conversion`，按敏感数据保管。恢复使用匹配版本、数据库与密钥。脚本不备份、不迁移既有引擎数据库，也不会从哈希或 key 前缀恢复一次性原始 key。

源码依据：[用户与 bootstrap](https://github.com/transmute-app/transmute/blob/7de1265fbfbbfd073c5c9a65ed1f7e45bc3ca50c/backend/api/routes/users.py)、[API key](https://github.com/transmute-app/transmute/blob/7de1265fbfbbfd073c5c9a65ed1f7e45bc3ca50c/backend/api/routes/api_keys.py)、[清理设置](https://github.com/transmute-app/transmute/blob/7de1265fbfbbfd073c5c9a65ed1f7e45bc3ca50c/backend/api/routes/settings.py)。

## 网络、资源与临时文件

四个引擎只加入 `internal: true` 的 `conversion` 网络，不发布宿主端口。独立 `gateway` 使用与主站相同版本及摘要的 Caddy，加入 `conversion` 与普通 `access` 网络；只有它将四个端口映射到 `127.0.0.1`。固定配置见 [Caddyfile](Caddyfile)，每个端口只代理对应引擎，不接受动态目标，关闭管理 API 和自动 HTTPS。它不加入网站业务网络，也不持有 API key、文件卷或网站密钥。

网关的 [Dockerfile](gateway/Dockerfile) 仅移除官方 Caddy 二进制附带的 `cap_net_bind_service=ep` 文件能力，保留二进制原始内容。本网关只监听 8090–8094，不需要特权端口能力；保留 `cap_drop: ALL`、非 root 和 `no-new-privileges`。直接用带该文件能力的上游镜像会被 Linux 拒绝执行，不能通过授予额外运行权限绕过这一问题。对应固定源码见 [Caddy v2.11.7 Dockerfile](https://github.com/caddyserver/caddy-docker/blob/9234f5785658cae8129bfae366e196d0670468ac/2.11/alpine/Dockerfile)。

这一层用于 Windows 宿主访问和初始化：仅接入内部网络的容器在部分 Docker Engine / Desktop 版本中不会实际发布端口，即使配置仍显示端口绑定。不能把 `conversion.internal` 关掉来绕过限制。Docker 主站继续使用内部 DNS 直达引擎。UNO 等内部子进程端口不映射；引擎运行时没有外网通路，下载模型、远程 URL 转换和远程内容抓取不在本次接入范围。可参考 [Docker 内部网络说明](https://docs.docker.com/reference/cli/docker/network/create/#internal)和[上游同类问题](https://github.com/moby/moby/discussions/53256)。

网关的容器内 `8090/__gateway_health` 仅验证代理进程就绪，不映射到宿主，也不代表转换引擎健康。部署必须同时核对四个引擎各自的健康检查，并从宿主访问对应回环 URL。

| 引擎      | 容器端口  | CPU 上限 | 内存/含 swap 上限 | 有限临时文件系统                                                          |
| --------- | --------- | -------- | ----------------- | ------------------------------------------------------------------------- |
| ConvertX  | 3000      | 2        | 4 GiB             | `/app/data` 3 GiB，`/tmp` 512 MiB，home 128 MiB                           |
| Transmute | 3313      | 2        | 4 GiB             | `/app/data` 3 GiB，`/tmp` 512 MiB，root home 128 MiB；DB 子目录独立持久化 |
| Stirling  | 8080      | 2        | 6 GiB             | `/tmp` 3 GiB，`/work` 128 MiB，home 64 MiB；Java heap 2 GiB               |
| NCM       | 8080      | 1        | 2 GiB             | `/tmp` 1280 MiB，同时覆盖 NCM 输入与还原输出                              |
| 回环网关  | 8090–8094 | 0.5      | 128 MiB           | `/data` 和 `/config` 各 16 MiB                                            |

内存按实际使用占用，四个引擎不会启动就预留总计 16 GiB，网关另有 128 MiB 上限，但 tmpfs 使用内存；Docker/WSL2 资源必须能覆盖实际并发。大文件、图片展开和复杂 PDF 可能在输入上限以内耗尽处理预算，错误应由本站如实反馈，不能把配置上限当作所有文件都能成功转换的承诺。

各服务都设置只读根文件系统、`cap_drop: ALL`、`no-new-privileges`、进程数限制及 Docker 日志轮转（每份 10 MiB，3 份）。ConvertX 显式使用 UID 1000，Stirling/NCM 使用其非 root 用户。Transmute 保留固定上游镜像的默认 root 启动方式，以便创建持久 DB 和运行现有入口；不授予 capabilities，也不挂载宿主系统目录。实际转换兼容性和内核隔离仍须逐项运行验证。

所有转换 payload 都在 tmpfs 中，停止/重建容器会丢失引擎暂存文件；Transmute 的数据库保留，因此可能记录已失去临时文件的旧任务。本站已经落盘的个人结果不在这些容器里，按网站自己的 24 小时策略保留。重启中的任务应由本站标记失败或重试，不能把旧引擎 ID 当作结果仍存在。

ConvertX 内部清理值 `AUTO_DELETE_EVERY_N_HOURS=1` 同时影响 TTL 与扫描周期，残留可能接近 2 小时；Transmute 的 TTL 为 1440 分钟，文件和任务各自按上游时间字段计算。这些都是临时文件兜底，不替代本站用户可见的精确过期时间。

## 日常操作与验证

查看状态或停止独立 bundle：

```powershell
docker compose --env-file .env.conversion -f integrations/conversion/compose.yml ps
docker compose --env-file .env.conversion -f integrations/conversion/compose.yml stop
```

重新执行 `node -- scripts/setup-converters.mjs --start` 会复用保存的凭据并核对清理设置。初始化有文件锁，若进程被强制终止，先确认没有其他初始化进程，再移除相应的 `.lock` 文件。日志中不要输出完整环境、上传正文、密码或 API key。

升级按 [UPSTREAM.json](UPSTREAM.json) 更新确定版本与摘要，保留上游许可和对应源码链接；先在隔离环境核验能力/API、现有数据库、失败处理和真实合成文件，再替换已验证镜像。ConvertX 为 AGPL v3，Transmute 和 Stirling 核心为 MIT，NCM 的 TagLibSharp 依赖为 LGPL-2.1-only；各镜像自带的系统工具仍遵循各自许可。

交付验收必须实际覆盖：四个健康接口、中文文档与图像转换、NCM 合成样例、未授权/跨账号请求拒绝、API key 复用、已有账号失败时不重置、超时/取消状态、24 小时过期清理、容器重启以及资源用尽。单纯语法检查、镜像拉取或健康检查不能视为完整转换验收。

本目录定义了可检查的部署与初始化流程；容器构建和实际运行结果应记录到项目验收文档，不能从本文推断目标服务器已经安装或上线。
