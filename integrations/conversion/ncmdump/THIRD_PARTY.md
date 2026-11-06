# 第三方来源与许可

## LibNCM

- 作者：xiSage，版权声明 `Copyright (c) 2024 xiSage`。
- 版本：ncmdump-net v2.0.1，提交 `8ccdd3534d5006d3f604d3790ada8778e8973e6f`。
- 许可：[MIT 原文](vendor/LICENSE.txt)。
- 来源：[固定源码](https://github.com/xiSage/ncmdump-net/tree/8ccdd3534d5006d3f604d3790ada8778e8973e6f/LibNCM)。原文件及逐文件校验和见 `upstream.json`，未修改上游源码。

## TagLibSharp

- 作者：Brian Nickel、Gabriel Burt、Stephen Shaw 及其他贡献者；NuGet 版权声明 `Copyright (c) 2006-2007 Brian Nickel. Copyright (c) 2009-2020 Other contributors`。
- 包：[`TagLibSharp 2.3.0`](https://www.nuget.org/packages/TagLibSharp/2.3.0)，许可证表达式 `LGPL-2.1-only`。
- 上游版本：`TaglibSharp-2.3.0.0`，提交 [`b5ae84f2e84087bf160bb0471420200dd2b5d809`](https://github.com/mono/taglib-sharp/tree/b5ae84f2e84087bf160bb0471420200dd2b5d809)。
- [LGPL 2.1 原文](licenses/TagLibSharp.LGPL-2.1.txt) 来自上述固定提交的 `COPYING`。
- [对应源码归档](https://github.com/mono/taglib-sharp/archive/b5ae84f2e84087bf160bb0471420200dd2b5d809.tar.gz)。本站没有修改此依赖，NuGet 包内容哈希固定在 `packages.lock.json`。

Docker 构建采用框架依赖发布，并关闭 NativeAOT，保留独立的 `TagLibSharp.dll`，可从相同源码重新编译后替换。镜像 `/app/licenses` 包含 LibNCM MIT、TagLibSharp LGPL 原文及本说明。当前仓库提供源码和构建流程，未发布预构建网关镜像；若以后分发镜像或二进制，应同时在分发位置提供相应 TagLibSharp 完整源码和许可材料，并保留使用者修改、替换该库的能力。

## 构建工具与运行时

Microsoft.SourceLink.GitHub、Microsoft.SourceLink.Common、Microsoft.Build.Tasks.Git、System.IO.Hashing 与 Microsoft.NET.ILLink.Tasks 的版本和内容哈希见 `vendor/LibNCM/packages.lock.json`。其中 SourceLink 和 ILLink 仅用于构建；NuGet 包自身声明 MIT 许可，相关源码见 [dotnet/sourcelink](https://github.com/dotnet/sourcelink) 与 [dotnet/runtime](https://github.com/dotnet/runtime)。官方 .NET SDK / ASP.NET 基础镜像保留自身许可证及第三方声明，镜像内容不全部归 LibNCM 的 MIT 许可覆盖。
