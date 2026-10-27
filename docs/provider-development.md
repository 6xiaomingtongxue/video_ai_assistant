# Provider Development

MVP 通过 OpenAI-compatible `/chat/completions` 接口调用模型。

当前配置项：

```ts
interface AIProviderConfig {
  provider: "openai";
  preset?: "custom" | "deepseek" | "openai";
  apiKey?: string;
  baseUrl?: string;
  model: string;
  supportsVision?: boolean;
}
```

扩展新 provider 时应保持：

- API Key 只发送到用户配置的服务地址。
- 文本模型不应接收图像输入。
- 模型错误需要转换为用户可读提示。
- 本地模型可以允许空 API Key，但应限制在本地地址或明确配置。

`provider: "openai"` 表示兼容协议，并不限制服务商。Base URL 可以是 DeepSeek 根地址或中转站的路径前缀；`normalizeProviderBaseURL` 规范化完整 endpoint，`requestModelJSON` 统一处理认证、超时与错误。

API 接入通过 `listAPIModels` 可选获取模型列表；连接测试用实际 Chat Completions 小请求验证所选模型。订阅账号经 `resolveSettings` 校验账号、渠道与模型，再仅路由到本机 Bridge。详见 [模型接入](model-access.md)。
