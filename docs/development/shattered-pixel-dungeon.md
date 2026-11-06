# 破碎的像素地牢：源码、构建与继续开发

本站集成的是非官方 Web 适配。原作 Shattered Pixel Dungeon 作者为 Evan Debenham，Pixel Dungeon 作者为 Oleg Dolya（Watabou），指定 Web 移植由 glassesmonkey 提供。完整原始源码及许可证保留在 [third_party/shattered-pixel-dungeon-web](../../third_party/shattered-pixel-dungeon-web)，固定上游提交 `ce39efde1c4e9929103a1df684d94fab6aa84bed`；来源与本站改动清单见 [UPSTREAM.json](../../third_party/shattered-pixel-dungeon-web/UPSTREAM.json)。

游戏代码遵循原文件头的 GPL v3 或后续版本，完整许可见 [LICENSE.txt](../../third_party/shattered-pixel-dungeon-web/LICENSE.txt)。原作者、游戏内 credits 和资源归属均保留。小工具卡片图标 `public/tool-icons/shattered-pixel-dungeon.png` 原样来自上游 `desktop/src/main/assets/icons/icon_256.png`，属于游戏资源。libGDX、gdx-teavm、TeaVM 等构建和运行依赖继续使用各自上游许可证。本站接入不构成官方发行或作者背书。

## 构建

需要 Node.js 22+、JDK 17+、`tar` 以及首次构建时可访问 Gradle 与 Maven Central 的网络。Windows 自带的 `tar.exe` 可以使用。`JAVA_HOME` 可选，未设置时使用 PATH 中的 `java`。Java 仅用于构建，网站运行时无需单独 Java 服务。

```powershell
npm ci
npm run build:game
npm run build
```

也可独立运行 `node scripts/build-game.mjs`；`--force` 强制重新构建。脚本使用已保留的 Gradle 9.4.0 wrapper 与 Web 专用 [settings.gradle](../../third_party/shattered-pixel-dungeon-web/web-build/settings.gradle)，只加载 `SPD-classes`、`core`、`services` 和 `web`，不需要 Android SDK、iOS 工具链或桌面打包插件。原多平台构建文件仍保留，便于后续二次开发。

产物生成在忽略入库的 `.games/shattered-pixel-dungeon-web`。其中 `manifest.json` 记录上游提交、本地源码摘要和逐文件 SHA-256；只有全部文件摘要匹配才复用缓存。`source.tar.gz` 包含此构建对应的游戏源码、本站桥接源码、构建脚本与本文；游戏页的“说明”提供下载与许可证入口。不要把本地 Gradle 缓存或构建产物提交到 Git。

原版实测 Web 构建共 478 个文件、76,666,093 字节，其中 `app.js` 为 32,593,700 字节，未计算 HTTP 压缩。首次进入游戏才加载这些资源。构建中的全部 Java 类和素材保留，未通过删除游戏内容缩减体积；服务器是否开启传输压缩另以部署配置为准。

如果资源初始化超过 180 秒，页面明确显示“尚未就绪”，允许继续等待或重新载入，不跳过未完成的资源。较慢的加载随后完成时自动恢复正常游戏状态。该等待提示不能代替真实网络和设备性能验收。

## 修改游戏

- 玩法、怪物、物品、地图：`third_party/shattered-pixel-dungeon-web/core/src/main/java`。
- 图片、音乐、翻译：`third_party/shattered-pixel-dungeon-web/core/src/main/assets`；桌面字体及图标另在 `desktop/src/main/assets`。
- Web 平台与自动保存：`third_party/shattered-pixel-dungeon-web/web/src/main/java`。
- 登录后的网页外壳：[DungeonPlayer.tsx](../../src/components/tools/DungeonPlayer.tsx)。
- 账号存档桥接：[bootstrap.mjs](../../src/game/shattered-pixel-dungeon/bootstrap.mjs) 与 [storage.mjs](../../src/game/shattered-pixel-dungeon/storage.mjs)。

修改后重新运行游戏构建，再运行主项目检查与生产构建，并实际创建角色、移动、战斗、保存、刷新和继续游戏。原游戏内部版本号用于存档迁移，不要随意改回 1；改动存档结构必须另行提供兼容和恢复方案。

追踪上游时，在隔离目录取得明确的新提交，审查与当前固定提交的差异，保留本站两个 Java 接入点及 Web 专用构建入口；更新 `UPSTREAM.json` 并重新验证旧存档。不要用最新远程构建文件覆盖服务器现存存档，也不要在运行中的服务器直接修改游戏脚本。

## 存档协议与账号边界

资源由 `/api/tools/shattered-pixel-dungeon/assets/...` 鉴权提供，保存由 `/api/tools/shattered-pixel-dungeon/save` 处理。游戏启动前读取当前会话所属账号的快照，再初始化本次运行独立的 IndexedDB 和 localStorage 设置前缀，然后启动 TeaVM。网页每次启动都使用新的本地命名空间，不把其他账号或其他标签页的浏览器缓存作为云端存档。

快照保持原游戏文件格式：

```json
{
  "formatVersion": 1,
  "files": [
    {"path": "/shattered-pixel-dungeon/game1/", "type": 1, "data": null, "modifiedAt": "2026-11-06T00:00:00.000Z"},
    {"path": "/shattered-pixel-dungeon/game1/game.dat/", "type": 2, "data": "AQ==", "modifiedAt": "2026-11-06T00:00:00.000Z"}
  ],
  "prefs": {"settings.xml:musicb": "true"}
}
```

这是格式示意，`AQ==` 不是可玩的游戏存档。文件路径的首尾斜杠来自 gdx-teavm 的路径规范，不能删除。`type: 1` 是目录，`type: 2` 是文件，`data` 为原始字节的 Base64；偏好键移除当前运行命名空间后保存，载入时再加上新的前缀。

GET 返回 `{scope, revision, updatedAt, snapshot}`；`?metadata=1` 返回同样的身份与版本字段，但 `snapshot` 为 null。PUT 发送 `{scope, revision, snapshot}`。服务端始终从会话确定账号，并比较回显 scope 和 revision；scope 不能替代登录或选取其他账号。版本冲突拒绝覆盖，页面暂停游戏并允许下载本次进度备份；会话失效或账号切换则停止旧游戏。

游戏约每 3 秒在英雄可以行动的稳定回合保存，保存事件发生后同步完整文件快照；另外周期性检查设置和会话状态。网络失败明确显示“尚未同步”，不会显示云端保存成功。浏览器关闭可能丢失尚未完成的回合或上传，因此离开前使用“同步进度”或“小工具”返回按钮。下载的进度备份用于保留及人工恢复；当前页面没有自动导入功能。

手机旋转、全屏或网页提示条改变画布尺寸时，Web 接入层会等待当前回合稳定后再重建游戏场景，避免在移动动画中结束旧场景的 actor 线程而使新场景停止行动。暂停于存档冲突的运行保持原场景，重新载入后按当前尺寸创建。

服务端快照属于数据库备份范围，浏览器缓存不替代备份。游戏 iframe 和 WebAssembly 所需 CSP 仅作用于游戏入口，网站其余页面不放宽。游戏本身使用原生像素画布，保留其触摸、拖动、双指缩放和键盘设置；网页增加 viewport、自适应高度和可离开画布的 Tab 行为。完整游戏通关、所有物品和所有手机浏览器仍需逐项验证，不能从构建通过推断全部游戏内容已验收。
