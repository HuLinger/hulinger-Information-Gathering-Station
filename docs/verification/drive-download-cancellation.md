# 下载取消与文件句柄验证

日期：2026-11-05。环境：Windows、Node.js 22.14.0、隔离 PostgreSQL 18 测试库、合成文件。本文验证服务端取消处理；浏览器普通下载的完整验收见 [v0.2 验证记录](v0.2-validation.md)，两者不能互相替代。

## 问题与改动

浏览器结束传输后，旧的 `Readable.toWeb()` 可能在已经关闭的 Web stream controller 上继续 `enqueue`，产生不能由 `pipeTo()` 的 Promise 捕获的 `ERR_INVALID_STATE`。本机内置 Node adapter 的 `onData` 没有取消状态检查，与 [Node 官方问题 #64529](https://github.com/nodejs/node/issues/64529) 描述一致。

下载保持实际文件流、256 KiB 读取缓冲、请求取消信号、`autoClose`、鉴权和 Range 行为，只把桥接改为 `ReadableStream.from()` 按异步迭代器拉取。显式迭代器 `return()` 销毁底层流并等待文件句柄关闭，避免未读取首块就取消时，尚未启动的 Node 迭代器不执行清理。

## 可重复证据

| 验证 | 实际结果 |
| --- | --- |
| 独立 Node 慢消费者探针，每种 adapter 40 轮取消 | 旧 `toWeb`：40 次未捕获异常；`from`：0 次 |
| 同一生产 `DriveStore.download()` 方法，真实 2 MiB 文件、16 KiB 有界缓冲模拟背压；子进程对照旧 adapter | 最后一次运行旧 adapter 39/40 次异常，当前实现 0/40 次；两组未关闭文件句柄均为 0。竞态触发次数随调度变化。 |
| 真实 PostgreSQL/文件系统，生产下载路径的 40 轮取消 | 覆盖首块前取消、首块后取消，以及两种情况下的请求 abort；实际文件句柄均关闭，无未捕获异常，随后完整下载与原字节相同。 |
| 未读取首块就取消的失败/通过对照 | 单独改成 `from(stream)` 时，2 秒后句柄仍开放，测试失败；加入显式迭代器清理后通过，不再出现依赖 GC 关闭 FileHandle 的警告。 |

执行：

```text
npx tsx --test tests/drive.integration.test.ts tests/drive-download-cancellation.test.ts
```

数据库测试显式配置本机隔离测试连接，只创建并删除随机测试库。结果：17 项，15 通过、0 失败、2 跳过。Windows 文件符号链接权限及 POSIX 只读目录权限负例在本机不适用，不能记为通过；由 Linux CI 执行相应负例。

背压探针在独立子进程内记录旧 adapter 的异常，生产应用没有安装吞掉未捕获异常的处理器，也没有实现手写 Web stream controller。测试直接调用生产下载方法；元数据和输入文件定位由合成夹具提供，不需要生产配置、账号或数据库。

这些结果证明取消竞态与句柄生命周期得到覆盖，不能单独证明最初浏览器 0 B 下载失败的触发原因。响应 CSP、实际网络头和浏览器下载结果应分别通过真实浏览器验收。

## HTTP 出口与背压回归

Next.js 16.4.5 App Router 的响应转换会移除 `Content-Length`，因此文件出口改用 Pages API 的原生 HTTP 响应，继续复用相同的拥有者授权和 `DriveStore.download()`。Web 文件源直接交给 Node 官方 `pipeline()`，由其负责原生响应的背压、结束、错误和取消；不再先经过 `Readable.fromWeb()` 形成重复桥接。[Node pipeline 文档](https://nodejs.org/api/stream.html#streampipelinesource-transforms-destination-callback)

已对照测试 `response.body.pipeTo(Writable.toWeb(response))`：在 Node 22.14.0 上，32 MiB 合成源在 HTTP 客户端暂停后仍被全部读取，背压断言失败。该版本的 `Writable.toWeb()` 使用原生字节高水位作为默认块计数高水位，允许过多数据排队，因此未采用此方案，也没有调整监听器阈值或吞掉警告。

`tests/auth.integration.test.ts` 复用隔离 PostgreSQL、真实 MFA 会话和文件，调用实际 Pages handler 启动本地 HTTP 监听，并通过 `tests/helpers/drive-http-checks.ts` 覆盖八个场景：完整 GET、HEAD、Range、未认证拒绝、方法拒绝、慢客户端背压与断开、首块前源错误、首块后源错误。只有慢源和失败源使用临时合成 store 响应，授权与 HTTP handler 均为生产代码。确认内容长度和字节正确、暂停客户端不会提前耗尽 32 MiB 源、断开会取消请求并关闭源、源错误会结束连接，首块前失败也不会沿用文件长度发送错误 JSON。

在 Windows 的 Node 22.14.0 与 Node 24.22.2 上分别执行以下命令，均为 1 项集成测试通过、0 失败、0 跳过；该项包含上述八个 HTTP 场景及原有身份验证断言。类型检查、定向 ESLint 和差异空白检查通过。

```text
node --import tsx --test tests/auth.integration.test.ts
```

另在实际 Next 开发服务上通过真实合成账号下载 96 MiB：HEAD 无正文且 `Content-Length` 为 `100663296`；GET 收到同样字节数，SHA-256 为 `896f545d8b03886d92d205934fc9c010da02f324d15bbfb7fdfc150161c9aff7`。2026-11-05 07:50:40（Asia/Shanghai）请求后的服务日志没有再出现原先每次 GET 的 `MaxListenersExceededWarning`，没有未捕获异常。该结果属于本地服务验证，不代表生产网络吞吐或目标服务器验收。
