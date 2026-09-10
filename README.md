# OpenCode Codex Bridge

一个本地中转服务，让 [OpenCode](https://opencode.ai) 使用你的 ChatGPT Plus/Pro 订阅，直接调用 Codex 后端模型。

**不需要 CC Switch，不依赖任何第三方配置管理器。** 中转站自己完成 Codex OAuth 登录和 token 刷新，向 OpenCode 暴露标准 OpenAI Responses API。

## 架构

```text
OpenCode (@ai-sdk/openai)
  ↓ POST /v1/responses
本机中转站 127.0.0.1:15722 (Node.js)
  ↓ Bearer access_token (支持代理热切换)
https://chatgpt.com/backend-api/codex
```

## 功能

- **网页端可视化登录**：支持在控制台点击一键唤起登录，弹窗展示授权验证码与一键复制，自动检测登录成功并平滑刷新
- **代理热加载与弹窗提醒**：
  - 页面右上角提供⚙️**设置面板**，支持动态修改代理端口（如 Clash `7890`、v2rayN `10809` 等），输入 `direct` 即可免代理直连，**修改后立即生效无需重启服务**
  - 首次启动若未配置代理会自动弹窗引导设置
- **全部模型可选**：点击控制台“点击同步模型”自动从 Codex 同步可用模型列表，每个模型预设四档思考强度（low/medium/high/xhigh）
- **Fast 1.5x 模式**：控制页一键开关，动态注入 `service_tier: priority`
- **额度实时查询**：支持在控制页查看官方用量及剩余重置周期，并支持手动刷新
- **流式传输**：完整 SSE 支持，逐 token 实时返回
- **自动重试**：TLS 瞬时断开自动重连，最多 5 次，间隔递增
- **开箱即用**：Windows 用户双击 `start.bat` 自动检测 Node 环境并自动补全 `npm install` 依赖，防竞态延迟唤起浏览器

## 快速开始

### 前提

- Node.js 18+ (推荐 v20 或 v22)
- ChatGPT Plus/Pro 订阅
- 本地科学上网代理软件（国内环境），或海外直连网络

### 安装与启动

#### 方式一：Windows 用户（最简，双击即用）

1. 克隆或下载本项目解压：
   ```bash
   git clone https://github.com/wthsama/opencode-codex-bridge.git
   cd opencode-codex-bridge
   ```
2. 直接双击运行根目录下的 **`start.bat`**。
   * 脚本会自动检查 Node.js 环境并自动执行 `npm install` 安装依赖。
   * 服务启动后会自动在浏览器中打开控制台页面 `http://127.0.0.1:15722/`。

#### 方式二：命令行启动

```bash
git clone https://github.com/wthsama/opencode-codex-bridge.git
cd opencode-codex-bridge
npm install
npm start # 或 node src/index.js
```

启动后在浏览器访问 `http://127.0.0.1:15722/`。

---

### 使用流程

1. **设置网络代理**：
   * 首次打开网页会弹出代理配置面板。
   * 如果你在国内并开启了代理软件，填写对应本地端口（例如 `http://127.0.0.1:7890` 或 `http://127.0.0.1:10809`）。
   * 如果你在海外或不需要代理，填入 `direct` 即可直连。点击保存立即生效。
2. **账号登录**：
   * 在控制页面点击 **“浏览器登录”** 按钮。
   * 弹窗会显示您的 **授权验证码** 并提供一键复制，点击“打开授权页面”进入 OpenAI 验证页面粘贴并确认授权。
   * 授权完毕后网页端会自动感知并提示登录成功，控制台显示您的账号邮箱。
   *(亦可通过命令行执行 `npm run login` 进行登录)*
3. **同步模型到 OpenCode**：
   * 在控制页点击 **“点击同步模型”**，中转站会自动将最新可用模型写入 `~/.config/opencode/opencode.json`。
   * 同步状态显示**就绪**后，**重启 OpenCode** 即可在模型列表中选择 Codex 模型使用！

---

## 代理配置说明

除了在网页右上角⚙️**齿轮图标**中随时修改保存外，也可以通过系统环境变量指定默认代理：

```bash
# Windows CMD
set HTTPS_PROXY=http://127.0.0.1:7890

# PowerShell
$env:HTTPS_PROXY="http://127.0.0.1:7890"

# Linux / macOS
export HTTPS_PROXY=http://127.0.0.1:7890
```

网页设置面板中优先级高于环境变量。

---

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 控制页面 |
| `/health` | GET | 健康检查 |
| `/status` | GET | JSON 状态 |
| `/login/start` | POST | 发起 OAuth 登录流程 |
| `/login/session`| GET | 获取当前登录会话状态与验证码 |
| `/login/cancel` | POST | 取消登录会话 |
| `/login/status` | GET | 查询账号认证状态 |
| `/settings/proxy` | GET/POST | 查询 / 热更新代理配置 |
| `/fast` | GET/POST | Fast 模式开关 |
| `/sync` | POST | 手动同步模型到 OpenCode |
| `/quota` | GET/POST | 查看缓存额度 / 手动刷新官方额度 |
| `/v1/models` | GET | 模型列表接口 |
| `/v1/responses` | POST | Responses API 代理 |

## 文件结构

```
├── src/
│   ├── index.js        # Express 服务、控制面板、代理及登录路由
│   ├── auth.js         # Codex OAuth 设备流登录、验证码下发、token 管理
│   ├── proxy.js        # Responses API 代理、SSE 流式转发、自动重试
│   ├── models.js       # 模型列表与额度拉取
│   ├── sync.js         # 同步模型配置到 opencode.json
│   ├── settings.js     # Fast 模式与代理配置持久化、Agent 热加载
│   └── cli-login.js    # CLI 独立登录脚本
├── start.bat           # Windows 一键启动脚本（含环境与依赖自检）
└── package.json
```

## 故障排查

| 问题 | 解决 |
|------|------|
| 连接超时 / 无法访问 OpenAI | 点击网页右上角⚙️齿轮，确认本地代理端口设置正确；若无需代理请输入 `direct` |
| 启动时黑框一闪而过 | 检查系统是否安装了 Node.js（v18 及以上）并配置到了系统 PATH |
| 登录时验证码没有出来 | 检查网络代理是否联通，若代理端口有变动请在⚙️设置中更新后重试 |
| Model not found | 该模型在当前 Responses API 不可用，请点击“点击同步模型”重新拉取 |

## 许可

MIT

