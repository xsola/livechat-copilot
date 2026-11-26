<p align="center"><img src="public/icons/logo.svg" alt="LiveChat Copilot" width="96" height="96"></p>

<h1 align="center">LiveChat Copilot</h1>

Chrome 直播弹幕翻译扩展。首个内置目标是 YouTube 直播。其他网站可以从工具栏启动自动识别，或在页面里手动选择弹幕容器和正文。确认后保存为本地规则。

## 本地安装

需要 Node.js 22.12 或更新版本，以及桌面 Chrome 120 或更新版本。

```sh
npm ci
npm run build
```

打开 Chrome 的 `chrome://extensions`，开启开发者模式，点「加载已解压的扩展程序」，选择 **`dist/chrome-mv3`**。该目录的第一层应能看到 `manifest.json`、`background.js` 和 `popup.html`。如果提示「清单文件缺失或不可读取」，确认选中的是这一层目录，然后重新加载。开发时可用 `npm run dev`。Windows PowerShell 如果拦截 `npm.ps1`，可用 `npm.cmd`。

## 在 YouTube 直播间试用

1. 打开扩展设置。DeepSeek 预设地址为 `https://api.deepseek.com`，模型 ID 为 `deepseek-flash`。填入自己的 API Key，点击「测试当前模型」，查看连接、图片输入和单条示例翻译耗时，然后保存。也可配置兼容 Chat Completions 的服务。
2. 打开一个有文字聊天的直播间并展开实时聊天。打开扩展工具栏菜单，勾选「在本站启用翻译」。阅读语言默认跟随 Chrome 界面语言。在「翻译偏好」里可指定语言，选择合并多条自动翻译、逐条翻译或点击翻译。
3. 如果想检查匹配或自定义区域，点「识别弹幕区」或「选择弹幕区域」。移动鼠标查看高亮，用 ↑ 和 ↓ 调整层级，点击或按 Enter 确认。预览有误时，可以再点选一条正文作为示例。确认保存后，刷新页面会复用规则。
4. 如果希望用截图核验选区，测试模型确认支持图片后，打开「用截图核验新弹幕区」并保存。首次识别或重新选区会自动核验一次。模型收到候选弹幕区裁图、少量正文和可见且没有草稿的发送区裁图，结果供保存规则时参考。已有规则直接复用。Chrome 当前页尚无截图权限时，可以从直播标签页的工具栏启动识别。
5. 从「房间语言」查看或修正回复语言记忆。阅读翻译使用设置里的阅读语言，房间语言供之后的双语回复使用。

参考 [DeepSeek 模型文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

## 规则、用量和范围

- **页面规则**首次发现新区域时会先预览，本地规则可在设置中管理。社区规则索引目前为空，订阅入口暂不展示。参见 [规则编写和发布](docs/rules.md)。
- **用量**保留本地汇总，可查看近 7 天或 30 天，并预览和复制诊断摘要。模型请求数包含实际重试，缓存命中和已显示译文分别统计。诊断摘要不会自动上传。参见 [数据处理说明](docs/privacy.md)。
- **当前范围**为桌面 Chrome 中可读取 DOM 的文字弹幕。通用匹配支持顶层页面与同源 iframe。Agent 草稿已有内部任务入口和连接测试，用户界面、主题与情绪分析、语音转录尚未发布。

## 开发和验证

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Chromium 端到端测试使用合成的 YouTube 聊天 iframe、通用站点、兼容模型 API 和社区规则索引。模型连接也可以独立验证。在当前进程设置 `DEEPSEEK_API_KEY` 后运行 `npm run smoke:deepseek`。可选的 `DEEPSEEK_SMOKE_IMAGE` 指向合成测试 PNG。测试只输出状态和用量。

当前无登录测试环境未能载入真实 YouTube 弹幕。真实直播间的页面兼容性仍需在能正常看到直播聊天的环境验证。

入口、模块依赖、数据流和 Agent 扩展点见 [代码架构](docs/architecture.md)。

修改 `public/icons/logo.svg` 后，可运行 `node scripts/render-icons.mjs` 重新生成 Chrome 使用的 PNG。
