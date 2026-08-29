# OpenCode Codex Bridge

一个本地中转服务，让 [OpenCode](https://opencode.ai) 使用你的 ChatGPT Plus/Pro 订阅，直接调用 Codex 后端模型。

**不需要 CC Switch，不依赖任何第三方配置管理器。** 中转站自己完成 Codex OAuth 登录和 token 刷新，向 OpenCode 暴露标准 OpenAI Responses API。

## 架构

```text
OpenCode (@ai-sdk/openai)
  ↓ POST /v1/responses
本机中转站 127.0.0.1:15722 (Node.js)
  ↓ Bearer access_token
https://chatgpt.com/backend-api/codex
```

## 功能

- **独立 OAuth 登录**：设备码流程，一次授权自动刷新 token，不碰 CC Switch 文件
- **全部模型可选**：启动时自动从 Codex 同步可用模型列表，每个模型预设四档思考强度（low/medium/high/xhigh）
- **Fast 1.5x 模式**：控制页一键开关，动态注入 `service_tier: priority`
- **流式传输**：完整 SSE 支持，逐 token 实时返回
- **自动重试**：TLS 瞬时断开自动重连，最多 5 次，间隔递增
- **控制页面**：`http://127.0.0.1:15722/` 查看状态、手动刷新官方额度、切换 Fast 模式、手动同步模型
- **按需同步**：服务启动不会自动请求或写入模型配置，只有点击控制页的“点击同步模型”才会同步
- **安全**：仅监听 `127.0.0.1`，不对外暴露

## 快速开始

### 前提

- Node.js 22+
- 本机 HTTP 代理（默认 `127.0.0.1:7890`），可通过 `HTTPS_PROXY` 环境变量修改
- ChatGPT Plus/Pro 订阅

### 安装

```bash
git clone https://github.com/wthsama/opencode-codex-bridge.git
cd opencode-codex-bridge
npm install
```

### 1. 登录 Codex OAuth

```bash
node src/cli-login.js
```

打开浏览器访问输出的 URL，输入设备码完成授权。token 保存到 `data/auth.json`，之后自动刷新。

### 2. 启动中转站

```bash
# 方式一：命令行
node src/index.js

# 方式二：双击 start.bat（Windows）
```

启动后浏览器自动打开控制页面 `http://127.0.0.1:15722/`。打开页面后点击“点击同步模型”，等待状态变为**就绪**。

### 3. 配置 OpenCode

OpenCode 桌面版会自动读取 `~/.config/opencode/opencode.json`。中转站启动时会自动写入 `codex-local` 配置，无需手写。

如果使用 CLI 版，在 `opencode.json` 中添加：

```json
{
  "provider": {
    "codex-local": {
      "npm": "@ai-sdk/openai",
      "options": {
        "apiKey": "PROXY_MANAGED",
        "baseURL": "http://127.0.0.1:15722/v1"
      },
      "models": {}
    }
  }
}
```

**注意**：每次中转站启动后会自动同步模型并更新 `opencode.json`，因此需要**重启 OpenCode** 才能看到最新模型列表。

## 代理配置

默认使用 `http://127.0.0.1:7890`。可通过环境变量修改：

```bash
set HTTPS_PROXY=http://127.0.0.1:7890  # Windows CMD
$env:HTTPS_PROXY="http://127.0.0.1:7890"  # PowerShell
```

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 控制页面 |
| `/health` | GET | 健康检查 |
| `/status` | GET | JSON 状态 |
| `/login` | POST | 启动 OAuth 登录 |
| `/login/status` | GET | 登录状态 |
| `/fast` | GET/POST | Fast 模式开关 |
| `/sync` | POST | 手动同步模型，服务启动不自动触发 |
| `/quota` | GET/POST | 查看缓存额度 / 手动刷新官方额度 |
| `/v1/models` | GET | 模型列表 |
| `/v1/responses` | POST | Responses API 代理 |

## 文件结构

```
├── src/
│   ├── index.js        # Express 服务、路由、控制页面
│   ├── auth.js         # Codex OAuth 登录、token 管理
│   ├── proxy.js        # Responses API 代理、SSE 流式、自动重试
│   ├── models.js       # 模型列表拉取
│   ├── sync.js         # 自动同步模型到 opencode.json
│   ├── settings.js     # Fast 模式持久化
│   └── cli-login.js    # 独立登录脚本
├── data/
│   ├── auth.json       # OAuth token（自动生成）
│   └── settings.json   # Fast 模式状态（自动生成）
├── start.bat           # Windows 一键启动
└── opencode-provider-example.json  # OpenCode 配置示例
```

## 故障排查

| 问题 | 解决 |
|------|------|
| TLS 连接错误 | 自动重试。如果持续失败，检查代理 7890 是否正常运行 |
| Model not found | 该模型在当前 Responses API 不可用，使用列表中其他模型 |
| 未登录 | 运行 `node src/cli-login.js` |
| 控制页显示降级运行 | 检查网络和代理，点击重新同步 |

## 许可

MIT
