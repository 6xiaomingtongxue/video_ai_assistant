# Windows Release

VideoLens 的账号授权模式由 Chrome 扩展和本地 Native Messaging Host 两部分组成。Bridge 已内嵌所需的账号授权、令牌刷新、模型路由和协议转换能力，最终用户不需要另外安装、配置或启动 CLIProxyAPI。

## Build Packages

先确认 `extension/manifest.json` 中的版本号正确，再运行：

```powershell
npm run release:windows
```

如果 Chrome Web Store 分配的扩展 ID 与开发 ID 不同，必须将真实商店 ID 写入 Bridge 安装包：

```powershell
npm run release:windows -- -ExtensionId <32-character-store-extension-id>
```

输出目录为 `release/`：

- `videolens-extension-<version>.zip`：上传 Chrome Web Store，压缩包根目录直接包含 `manifest.json`。
- `videolens-bridge-windows-<version>.zip`：提供给 Windows 用户安装本地 Bridge，压缩包根目录包含 `install.ps1` 和 `uninstall.ps1`。

## User Installation

Chrome Web Store 扩展不能自行写注册表或安装 Native Messaging 可执行文件，因此账号授权模式仍需用户安装 VideoLens Bridge。这是浏览器安全边界，不代表用户还需要运行 CPA。

用户解压 Bridge 包后，以当前 Windows 用户执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会：

1. 将 Bridge 安装到 `%LOCALAPPDATA%\VideoLens\Bridge`。
2. 为 Chrome 和 Edge 注册 `com.videolens.bridge` Native Messaging Host。
3. 将允许连接的来源限制为打包时指定的扩展 ID。

安装包同时包含视频文本处理组件。没有完整字幕时，Bridge 自动下载并校验独立运行环境、启动本机服务，并向扩展提供地址与凭证；用户无需手动配置服务或安装 Docker。已有 Bridge 用户需要更新本地 Bridge 后重新加载扩展。

安装完成后，用户需要重启浏览器或重新加载扩展。Bridge 不作为常驻服务运行；扩展调用 `chrome.runtime.connectNative()` 时由浏览器按需启动，连接断开后退出。

## Sign-out And Uninstall

扩展内退出账号会删除 `%LOCALAPPDATA%\VideoLens\Bridge\auths` 中的本地账号令牌，并清除扩展保存的账号渠道和模型选择。GPT、Claude、Gemini 三种账号渠道互斥，授权新渠道前会先清理旧渠道。

扩展退出不会清除厂商网页 Cookie，也不保证调用厂商的远程撤销端点。需要彻底撤销授权时，用户还应在对应账号的安全设置中撤销应用或会话。

卸载 Bridge 并删除本地账号数据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## Release Security Checklist

发布前必须确认：

1. 扩展 ZIP 不包含 `extension.pem`、`extension.crx`、`.pfx`、`.key` 或任何访问令牌。
2. Bridge 安装包中的扩展 ID 与商店实际 ID 完全一致，否则浏览器会拒绝扩展连接 Native Host。
3. 不把 API Key、Bridge 管理密钥、OAuth Token、用户邮箱或 `%LOCALAPPDATA%\VideoLens` 数据打进发布包。
4. `extension.pem` 是扩展签名私钥，不能上传商店、发送给用户或提交到公开仓库。Manifest 中的 `key` 是公钥，不包含私钥。
5. 正式公开发行前，对 Bridge EXE 和安装程序进行 Windows 代码签名，并通过可信 HTTPS 渠道分发。
6. 当前 ZIP 加 PowerShell 脚本适合开发和受控测试；面向普通用户发布时应制作签名安装器，明确展示安装、升级和卸载行为。

## Verification

发布脚本会自动运行扩展校验、Node 测试、Go 测试和 Bridge 构建。生成后还应检查 ZIP 根目录和敏感文件：

```powershell
npm run validate
npm test
npm run bridge:build
```

在干净的 Windows 测试账号或虚拟机中安装 Bridge，确认账号授权、模型刷新、切换渠道、退出清理和浏览器重启后的重新连接均正常。
