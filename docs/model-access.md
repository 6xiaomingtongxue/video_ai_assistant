# 两种模型接入方式

VideoLens 的聊天、视频问答和长期记忆摘要共用同一条模型调用入口，入口只按用户选择的方式路由：API 接入或订阅账号。不会在订阅额度不足时自动改用 API Key。

## API 接入

填写服务商或中转站提供的 Base URL、API Key 和模型名称，使用 OpenAI-compatible Chat Completions 协议。支持 DeepSeek、提供兼容接口的中转站和本地模型服务。

设置中的“快速填写”可填入 DeepSeek 或 OpenAI 的地址和示例模型；所有字段仍可修改。切换到不同站点的预设会清空旧 API Key，避免把上一家服务的密钥发送到另一家。

DeepSeek 示例：

```text
Base URL: https://api.deepseek.com
API Key: 该账号在 DeepSeek 平台创建的 API Key
模型: deepseek-flash（或服务实际返回的模型 ID）
```

参考 [DeepSeek 官方调用文档](https://api-docs.deepseek.com/)。模型名称和图像能力以服务商实际支持为准，可用“获取模型”查询并选择，也可直接填写。

地址处理规则：

- 保留用户的路径前缀，例如 `https://relay.example/api/v1`。
- 接受包含 `/chat/completions` 的完整地址并规范化，避免重复拼接。
- 不强制添加 `/v1`；DeepSeek 根地址和中转站的 `/v1` 地址都可使用。
- 远程服务使用 HTTPS；本机服务可用 HTTP，并允许本机服务不填写密钥。
- 连接时禁止重定向，不发送浏览器 Cookie。API Key 只用于当前配置的模型服务。

“获取模型”使用 `/models`。部分中转站未实现此接口时，手动填写模型仍可使用。“测试所选模型”会实际发送一条很小的 Chat Completions 请求，以确认所选模型确实能调用；测试会产生对应服务的少量用量。

## 订阅账号

使用用户自己的 ChatGPT/Codex、Claude/Claude Code 或 Gemini/Gemini CLI 账号完成官方授权，无需填写模型 API Key。账号必须具备对应渠道的访问权限，可用模型及额度以授权账号和上游返回为准。

1. 安装 VideoLens Bridge。
2. 在设置中选择“订阅账号”，点击所需渠道的授权入口。
3. 在新页面完成官方登录和授权。
4. 扩展等待 Bridge 保存账号凭证并同步可用模型；确认完成后显示“已连接”并自动选择该渠道的模型，可继续修改后保存。
5. 如浏览器已完成授权但未自动返回，可展开“授权后未自动完成？”，粘贴本次授权的本机回调地址。

ChatGPT / Codex 的模型选项通过当前账号的上游模型目录读取，兼容目录协议版本 `0.164.0`，不使用 CPA 内置的套餐模型清单。只显示上游标记 `visibility: list`、支持文本请求的条目，保留服务端顺序和显示名称，过滤隐藏审查模型及图像生成等用途的模型。账号令牌始终留在 Bridge，扩展只收到模型名称和能力。

正常使用缓存目录最多 5 分钟，“刷新状态”会跳过缓存重新请求；切换账号时不共用目录。更新后的模型同时登记到 CPA 的请求路由，令牌刷新也不会把列表换回旧目录。目录获取失败会显示错误，不用旧清单冒充当前权限。模型可见性与实际推理的额度、工作区策略限制分别由上游判断。

更新本地 Bridge 和扩展后，点击“刷新状态”，选择当前目录中的模型并保存即可保留现有登录继续使用。原模型已不在目录中时会提示重新选择，不会把旧模型名称自动映射成另一模型。

授权页面显示成功只代表回调已接收。扩展会继续确认本机凭证和模型，等待期间分别显示“正在等待授权”“正在确认授权”或“正在同步可用模型”。关闭设置或重新打开助手后，会恢复尚未超时的授权；旧状态请求不会覆盖新连接。令牌交换失败、凭证未保存或模型同步失败会显示对应错误。

Bridge 的回调页显示“授权结果已接收”，不会在令牌交换完成前声称连接成功。出现 `403 unsupported_country_region_territory` 时，扩展显示中文的地区拒绝提示并停止本次授权；这表示 OpenAI 未接受该请求地区，含义见 [官方错误说明](https://developers.openai.com/api/docs/guides/error-codes)。服务是否可用以官方支持范围为准。

Bridge 启动时自动沿用代理环境变量；没有显式变量时读取 Windows 已启用的手动系统代理，支持统一地址及 HTTP/HTTPS/SOCKS 分项配置。不会修改 Windows 设置。显式变量优先级为 `VIDEOLENS_PROXY_URL`、`HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`（同时识别对应小写变量）；`VIDEOLENS_PROXY_URL=direct` 可用于显式直连。自动代理脚本 PAC 不在当前读取范围内。修改系统代理后，重新授权会重启 Bridge 并重新读取。

开发时更新代码后，在 `chrome://extensions` 重新加载扩展并刷新视频页面，再重新授权 ChatGPT / Codex。若仍失败，查看设置页的具体错误；Bridge 在线但没有凭证时，需要重新完成授权。网络问题应检查 Bridge 所在 Windows 环境到授权服务的连接，浏览器能打开授权页并不能确认 Bridge 的令牌交换已成功。

开发安装：

```powershell
npm run bridge:build
npm run bridge:install
```

构建需要 Go 1.26+；安装后重新加载扩展。正式安装包的使用方式见 [Windows 发布说明](release.md)。Bridge 是本项目自带的 Native Messaging 宿主，由扩展按需启动，用户无需另行运行 CPA 或 CC Switch。

扩展只连接本机 Bridge。厂商访问令牌及刷新令牌由 Bridge 内嵌的 CPA SDK 管理，保存在 `%LOCALAPPDATA%\VideoLens\Bridge\auths`，不进入浏览器扩展的设置或视频页面。扩展不会读取浏览器 Cookie，也不会读取或改写其他 CLI、CPA、CC Switch 的账号配置。

目前三个订阅账号渠道互斥：授权其他渠道前清理 VideoLens 自己的旧授权文件；退出账号时清理本地授权并返回 API 接入。单纯切换“API 接入”和“订阅账号”保留各自配置，切换回去后可继续使用。

订阅请求在发送前校验所选渠道是否已登录、所选模型是否在当前账号列表中。未授权、模型不匹配、授权失效和额度/速率限制会显示对应提示，不会把浏览器中保存的 API Key 发给订阅渠道。

## 参考实现与边界

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)：沿用仓库已经内嵌的 `v7.1.54` SDK，负责 OAuth、令牌刷新、协议转换和模型路由。管理接口按该锁定版本的代码实现，不混用 v8 的接口路径。
- [CPA OAuth 回调实现](https://github.com/router-for-me/CLIProxyAPI/blob/v7.1.54/internal/api/handlers/management/oauth_callback.go)：手动提交回调时校验本次 state、渠道和本机回调地址，然后仅提交给本机管理端点。
- [CC Switch 的登录与第三方路由分离](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/provider/codex_login.rs)：参考其将第三方 API 路由与官方账号登录分开管理的思路。本项目独立管理凭证，不复制或接管其他应用的登录文件。

这两种方式只控制聊天模型。完整视频文本由 Bridge 自动配置和启动，继续从视频 `00:00` 获取整段文本，不因切换模型接入方式改变。

订阅账号的 HTTP 请求处理实例也会加载自己的账号模型目录。即使原生消息由另一个 Bridge 实例处理，首次调用或目录过期时也会在模型路由前同步，避免“列表中可选、实际调用却找不到提供商”的情况。只有携带本机正确客户端凭证的请求才能触发同步；上游暂不可用时返回目录错误，保留账号授权。

## 验证

```powershell
npm run validate
npm test
```

测试包括：DeepSeek 根地址、中转站路径前缀、完整 endpoint 规范化、模型列表去重、没有 `/models` 的服务、实际模型测试请求、问答和摘要共用 API 路由、订阅模型可用性校验、Bridge 地址规范化、授权回调、凭证与模型延迟就绪、授权恢复、过期与交换失败、并发状态刷新、旧 Bridge 断开事件、密钥隔离及错误分类。

真实订阅登录需要用户本人在官方页面完成授权；模拟测试不代表任意订阅套餐均具备所有模型的访问权限。
