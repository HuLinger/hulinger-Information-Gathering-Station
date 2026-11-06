# Stirling-PDF 内部转换引擎

本站只使用 Stirling-PDF 的核心 REST 处理接口。网页、账号、上传授权、队列、文件保留和下载由本站提供；此镜像不提供成员登录，不应直接开放给浏览器或公网。

## 固定输入与许可

| 输入              | 固定值                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Stirling-PDF      | `v3.3.0`，提交 `7825214811d98fd3ec260bf315cd998ecb73b36b`                                                       |
| API-only 核心 JAR | 官方 Release 的 `Stirling-PDF-server.jar`，232311287 字节                                                       |
| JAR SHA-256       | `5cb59682f93bd7d48312d36a87585ef2e8ca9ddfa64bc210dea6bd882925557c`                                              |
| 依赖基础镜像      | `stirlingtools/stirling-pdf-base:1.1.1@sha256:6b57e965506d61170851d6e85e4ff1a29fbc66db4fc4bf3d78c0e31fd1fb32ae` |
| 基础镜像平台      | `linux/amd64`、`linux/arm64`                                                                                    |

来源：[官方 Release](https://github.com/Stirling-Tools/Stirling-PDF/releases/tag/v3.3.0)、[JAR 下载](https://github.com/Stirling-Tools/Stirling-PDF/releases/download/v3.3.0/Stirling-PDF-server.jar)、[上游 backend Dockerfile](https://github.com/Stirling-Tools/Stirling-PDF/blob/7825214811d98fd3ec260bf315cd998ecb73b36b/docker/backend/Dockerfile)、[依赖基础镜像源码](https://github.com/Stirling-Tools/Stirling-PDF/blob/7825214811d98fd3ec260bf315cd998ecb73b36b/docker/base/Dockerfile)。

应用采用官方核心构建，保留原始 JAR 字节；[LICENSE.stirling](LICENSE.stirling) 保留上游许可全文。上游仓库根许可为 MIT，并明确排除若干 proprietary/saas/engine 目录；这里没有打包这些 Stirling 应用模块。构建时先验证固定摘要，再扫描 JAR 及其嵌套依赖的 proprietary/saas 类路径，拒绝错误替换的应用产物。LibreOffice、Ghostscript、Calibre、字体及其他依赖分别遵循各自许可，不能把整个依赖镜像统称为 MIT。

基础镜像包含 Java 25、LibreOffice、unoserver 3.7、Noto CJK 中文字体和 PDF/图像工具，不包含 Stirling 应用 JAR 或前端。本目录加入固定核心 JAR 与自有启动脚本，不调用上游整站的 `init.sh`，不加载其商业模块或账号关联功能。内置 Stirling Office Convert 的源码另见[官方项目](https://github.com/Stirling-Tools/Stirling-Office-Convert)；本站固定选择 LibreOffice 路径，避免默认引擎随未来版本变化。

## 构建与运行边界

从仓库根目录构建：

```powershell
docker build --tag hulinger-stirling-core:3.3.0 integrations/conversion/stirling
```

构建会校验下载内容、应用模块边界和启动脚本语法。基础镜像、JAR 和许可对应固定上游版本；本地未重编译或修改 Stirling 源码。升级时必须同时更新版本、摘要、大小、许可和本文 API 契约，再执行真实样例转换。

生产启动由本站 Compose 统一管理，约束如下：

- 容器以 UID/GID `1000:1000` 运行。HTTP 端口为 `8080`，只连接内部转换网络；如为宿主上的本站进程映射端口，只能绑定 `127.0.0.1`。
- 引擎没有身份认证。不能将此端口反向代理为公开入口，不能向客户端暴露引擎地址、任意接口代理或内部路径。
- `/work` 为生成的配置、日志和管道目录，`/tmp/stirling-pdf` 为临时处理区；容器不挂载本站业务文件、数据库、密钥或 Docker socket。保留输入及输出 24 小时由本站任务清理实现；不依赖引擎临时文件清理充当产品保留策略。
- 保留基础镜像的 LibreOffice sandbox；默认 `STIRLING_LO_SANDBOX=enforce`。该模式在宿主缺少 Landlock 时会告警并降级，部署验证须检查实际日志；`required` 模式会在缺少所需内核能力时拒绝转换，不能在未验证的 WSL2 内核上宣称已提供该层隔离。
- 启动脚本只在容器回环启动 UNO（`2003`），等待其就绪再启动 Java。任一主进程退出则停止整个容器，由 Compose 的重启策略恢复。不要公开 UNO 端口。
- 默认 UNO 单次转换上限 `120` 秒，可通过 `UNO_CONVERSION_TIMEOUT_SECONDS` 调整。本站请求超时不能被描述为引擎已停止；超时、取消和过期结果由本站作状态与隔离处理。
- 默认单个文件上限 `100MB`、请求上限 `110MB`，由 `SPRING_SERVLET_MULTIPART_MAX_FILE_SIZE` 与 `SPRING_SERVLET_MULTIPART_MAX_REQUEST_SIZE` 配置。本站上传上限应不大于该值。
- 默认关闭应用遥测、更新提示、URL 转 PDF、移动扫描/签名及引擎文件存储。使用内部网络限制出站；这些开关不等价于对所有依赖作过网络行为审计。

健康检查同时验证 `GET /api/v1/info/status` 和回环 UNO 的响应。健康状态仅说明进程可达，不能替代文档转换验证。

## 固定版本 REST 契约

以下路径均相对内部地址，例如 `http://conversion-stirling:8080`。使用同步 `POST multipart/form-data`；不传 `async=true`，直接取得二进制结果。此核心构建不要求 API key。本站使用安全文件名保留真实扩展名，PDF 上传 MIME 设为 `application/pdf`。

| 路径                               | 字段                                                                                                                                                                                          | 响应                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/api/v1/convert/file/pdf`         | `fileInput` 单文件；`useStirlingOfficeConvert=false`                                                                                                                                          | Office、OpenDocument、RTF、CSV、文本转 PDF，`application/pdf`                  |
| `/api/v1/convert/pdf/word`         | `fileInput`；`outputFormat=doc\|docx\|odt`；`useStirlingOfficeConvert=false`                                                                                                                  | Office 文件；底层多输出时可能 ZIP                                              |
| `/api/v1/convert/pdf/presentation` | `fileInput`；`outputFormat=ppt\|pptx\|odp`；`useStirlingOfficeConvert=false`                                                                                                                  | 演示文稿；底层多输出时可能 ZIP                                                 |
| `/api/v1/convert/pdf/text`         | `fileInput`；`outputFormat=txt\|rtf`；`useStirlingOfficeConvert=false`                                                                                                                        | TXT 是 PDFBox 提取的 UTF-8 `text/plain`，不是 OCR；RTF 走 LibreOffice          |
| `/api/v1/convert/pdf/img`          | `fileInput`；`imageFormat=png\|jpeg\|jpg\|gif\|webp`；`singleOrMultiple=single\|multiple`；`colorType=color\|greyscale\|blackwhite`；`dpi=300`；`pageNumbers=all`；`includeAnnotations=false` | `single` 将选页拼成一张长图；PNG/JPEG/GIF 的 `multiple` 返回 ZIP，即使只选一页 |
| `/api/v1/convert/img/pdf`          | 一个或多个重复的 `fileInput`；`fitOption=fitDocumentToImage`；`colorType=color`；`autoRotate=false`                                                                                           | `application/pdf`                                                              |

`fitOption` 还允许 `fillPage`、`fitDocumentToPage`、`maintainAspectRatio`。页码字段可使用 `all` 或上游支持的页码表达式；本站应先限制和验证允许语法、页数、DPI 与输出大小。

Word、演示文稿及 ZIP 常使用 `application/octet-stream`。适配器应按 `Content-Disposition`、实际文件内容和允许的输出格式校验结果，不能只依据 HTTP 200 或 MIME 宣告转换成功。下载文件名必须重新规范化，不能用上游名称直接构造存储路径。

本次基础接入优先验证 PNG/JPEG、DOCX/XLSX/PPTX/OpenDocument/RTF/TXT 到 PDF，以及 PDF 到 DOCX/PPTX/TXT/PNG/JPEG。其他枚举列出的是上游接口能力，不等于本站已验收支持。尤其 WebP 多页路径会重新读取输入 PDF，页码选择需要独立回归；首批不提供。扫描 PDF 的 TXT 提取可能为空，复杂 Office 排版和字体替换需要由用户核对。

依据：[Office 到 PDF 控制器](https://github.com/Stirling-Tools/Stirling-PDF/blob/7825214811d98fd3ec260bf315cd998ecb73b36b/app/core/src/main/java/stirling/software/SPDF/controller/api/converters/ConvertOfficeController.java)、[PDF 到 Office/文本控制器](https://github.com/Stirling-Tools/Stirling-PDF/blob/7825214811d98fd3ec260bf315cd998ecb73b36b/app/core/src/main/java/stirling/software/SPDF/controller/api/converters/ConvertPDFToOffice.java)、[图片/PDF 控制器](https://github.com/Stirling-Tools/Stirling-PDF/blob/7825214811d98fd3ec260bf315cd998ecb73b36b/app/core/src/main/java/stirling/software/SPDF/controller/api/converters/ConvertImgPDFController.java)、[图像输入参数](https://github.com/Stirling-Tools/Stirling-PDF/blob/7825214811d98fd3ec260bf315cd998ecb73b36b/app/core/src/main/java/stirling/software/SPDF/model/api/converters/ConvertToPdfRequest.java)、[PDF 图像输出参数](https://github.com/Stirling-Tools/Stirling-PDF/blob/7825214811d98fd3ec260bf315cd998ecb73b36b/app/core/src/main/java/stirling/software/SPDF/model/api/converters/ConvertToImageRequest.java)。

## 验证清单

统一部署验证应记录具体镜像 ID、CPU 架构、内核与命令结果：

1. 构建通过，JAR 摘要/模块检查通过；进程 UID 为 1000，未开放 UNO 或公网引擎端口。
2. 健康检查通过；UNO 退出和容器停止时 Java、UNO、LibreOffice 子进程均能结束。
3. 使用合成的中文 DOCX/XLSX/PPTX 转 PDF，确认文件有效、中文可读、页面数合理；再将 PDF 转 TXT、DOCX、单图及多页 ZIP。
4. 合成 PNG/JPEG 到 PDF、空文件、格式伪装、加密/损坏 PDF、超大输入及超时的失败结果准确。
5. 本站账号 A/B 越权、取消、24 小时清理、重复下载与重启后的状态恢复通过；这些属于本站集成验收，不能由直接调用引擎替代。

本目录静态检查与镜像构建不代表上述运行和业务验收已经完成。
