# NCM 内网转换网关

这是本站对 [xiSage/ncmdump-net](https://github.com/xiSage/ncmdump-net) 的薄 HTTP 包装，恢复用户上传的 NCM 容器中的原始 MP3 或 FLAC 音频。它不会把 FLAC 转码成 MP3，也不提高原音频音质。可用目标在本站显示为“原始音频（MP3 / FLAC）”。

## 来源与构建

- 上游版本：`v2.0.1`，固定提交 [`8ccdd3534d5006d3f604d3790ada8778e8973e6f`](https://github.com/xiSage/ncmdump-net/tree/8ccdd3534d5006d3f604d3790ada8778e8973e6f)。
- `vendor/LibNCM`、`vendor/Directory.Packages.props`、`vendor/build/Roots.xml` 和 `vendor/LICENSE.txt` 从该提交按原始字节提取，没有修改。原文件逐个 SHA-256 记录在 `upstream.json`；`vendor/LibNCM/packages.lock.json` 是本项目添加的依赖锁定文件。
- 上游采用 MIT，保留 [原许可及版权声明](vendor/LICENSE.txt)。运行时依赖 TagLibSharp 2.3.0 使用 LGPL-2.1-only；编译依赖还包括 Microsoft.SourceLink.GitHub 10.0.403。详见 [第三方说明](THIRD_PARTY.md)，MIT 声明不替代第三方依赖许可。
- 网关采用 .NET 10，`Dockerfile` 固定官方 SDK 和 ASP.NET Runtime 的多架构镜像摘要，支持镜像索引包含的 Linux amd64/arm64。摘要读取于 2026-11-06。
- 每次更新上游都必须重新核验许可、原文件哈希、依赖锁及下列 HTTP 测试，不能仅替换版本号。

从仓库根目录执行：

```sh
node integrations/conversion/ncmdump/verify-upstream.mjs
docker build -t hulinger-ncm-gateway:local integrations/conversion/ncmdump
```

此 Dockerfile 的构建上下文为本目录。生产通过根 Compose 接入，只允许本站 worker 所在的内部 Docker 网络访问；**不要发布 8080 主机端口或配置公开反向代理**。网关不提供用户鉴权，账号授权和输入归属由本站服务端执行。建议容器只读文件系统、无外部网络、丢弃 capabilities，并配置 CPU、内存和临时存储限额。默认最大输入加输出可能接近 1 GiB，临时存储预算须同时覆盖二者；容器重启不得依赖临时文件恢复。

## HTTP 契约

| 请求 | 响应 |
| --- | --- |
| `GET /health` | `200`，`{"status":"ok"}`；只表示进程可响应 |
| `POST /convert` | `multipart/form-data`，恰好一个名为 `file` 的 `.ncm` 文件字段 |
| 转换成功 | `200`，`audio/mpeg` 或 `audio/flac` 的二进制；`Content-Disposition` 为去路径、去控制字符的安全文件名 |
| 元数据无法写入 | 音频仍可下载，附带 `X-Conversion-Warning: METADATA_NOT_WRITTEN` |
| 转换失败 | 非 2xx，JSON `{"code":"稳定错误码","message":"中文原因"}` |

容器健康检查运行 `dotnet NcmGateway.dll --healthcheck`：仅请求回环地址 `http://127.0.0.1:8080/health`，确认 HTTP 成功和 `status=ok` 后退出 0，失败退出 1，最多等待 3 秒；不会启动第二个 Web 服务。

不接受 URL、磁盘路径、输出格式、额外表单字段或查询参数。没有任务状态和下载端点：转换与文件下载在同一个 HTTP 请求中完成。上层任务应允许这次请求持续到转换完成，并验证返回的 MIME 和扩展名。

| 状态 | 错误码与含义 |
| --- | --- |
| 400 | `INVALID_REQUEST` / `INVALID_MULTIPART`：字段、数量或请求格式错误 |
| 413 | `FILE_TOO_LARGE`：文件超过服务端限制 |
| 415 | `INVALID_CONTENT_TYPE` / `UNSUPPORTED_FILE`：上传类型或扩展名不支持 |
| 422 | `EMPTY_FILE` / `INVALID_NCM` / `UNSUPPORTED_AUDIO` / `EMPTY_AUDIO`：文件不能还原为支持的音频 |
| 429 | `CONVERTER_BUSY`：单并发槽已占用，`Retry-After: 2` |
| 504 | `CONVERSION_TIMEOUT`：上传或转换超过配置时限 |
| 500 | `CONVERSION_FAILED`：服务内部失败，不返回路径、上游异常或堆栈 |

`NcmProcessor.ProcessAsync` 明确使用 `FetchCoverArt=false`，同时注入拒绝网络请求的封面提供器；NCM 元数据里的封面 URL 不会被访问。网关先校验长度字段，内嵌封面上限为 16 MiB，再交给上游解析。每次请求只使用服务生成的随机目录及固定输入/输出路径，响应发送结束、失败、超时或断连后执行 `finally` 清理。清理失败记录稳定错误码，容器临时存储仍应由生命周期策略兜底。

## 配置

以下变量仅在内网网关容器使用，不包含密钥。

| 变量 | 默认值 | 约束 |
| --- | --- | --- |
| `NCM_MAX_FILE_BYTES` | `536870912`（512 MiB） | 1 至 512 MiB，只能收紧；请求本身额外允许 64 KiB multipart 头部 |
| `NCM_TIMEOUT_SECONDS` | `300` | 1 至 3600 秒，覆盖上传与转换；不可取消的上游同步步骤完成后也会检查超时 |
| `NCM_TEMP_ROOT` | Docker 内 `/tmp/hulinger-ncm` | 必须是可写绝对路径；生产使用独立临时存储 |
| `ASPNETCORE_URLS` | Docker 内 `http://+:8080` | 仅 Docker 内部网络监听；本地测试绑定 `127.0.0.1` |

非法配置在启动时失败。服务不保留文件 24 小时；上层在收到音频后按本站账号隔离和 24 小时保留策略保存最终文件。

## 验证

安装 .NET 10 SDK 和 Node.js 后，从仓库根目录运行：

```sh
dotnet restore integrations/conversion/ncmdump/NcmGateway.csproj -p:PublishAot=false -p:RestorePackagesWithLockFile=true --locked-mode
dotnet build integrations/conversion/ncmdump/NcmGateway.csproj -c Release -p:PublishAot=false --no-restore
node integrations/conversion/ncmdump/verify-upstream.mjs
node --test integrations/conversion/ncmdump/tests/smoke.test.mjs
```

若 SDK 不在 PATH，可用 `NCM_DOTNET` 指定 `dotnet` 可执行文件，必要时设置对应 `DOTNET_ROOT`。测试自行启动并关闭仅监听回环地址的网关；测试数据由 Node 的 AES 实现生成合成 NCM，再由实际 LibNCM 解码。它验证 MP3/FLAC 字节、下载名、防止封面外连、非法输入、大小与封面长度限制、并发、超时以及临时文件清理。测试不使用真实音乐，也不能替代真实用户文件兼容性、容器隔离或生产部署验收。

2026-11-06 本地验证：.NET 10.0.403 构建 0 警告、0 错误，5 项真实 HTTP 测试通过；Docker 镜像尚未在本机构建或运行。
