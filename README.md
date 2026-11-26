# LiveChat Copilot

Chrome 直播弹幕翻译扩展。首个内置目标是 YouTube 直播。其他网站可以从工具栏启动自动识别，或在页面里手动选择弹幕容器和正文。确认后保存为本地规则。

## 本地安装

需要 Node.js 22.12 或更新版本，以及桌面 Chrome 120 或更新版本。

```sh
npm ci
npm run build
```

打开 Chrome 的 `chrome://extensions`，开启开发者模式，点「加载已解压的扩展程序」，选择 `.output/chrome-mv3`。开发时可用 `npm run dev`。Windows PowerShell 如果拦截 `npm.ps1`，可用 `npm.cmd`。

## 在 YouTube 直播间试用

1. 打开扩展设置。DeepSeek 预设地址为 `https://api.deepseek.com`，模型 ID 为 `deepseek-flash`。填入自己的 API Key，点「保存并授权」，然后点「测试已保存的模型」。也可配置兼容 Chat Completions 的服务。
2. 打开一个有文字聊天的直播间并展开实时聊天。打开扩展工具栏菜单，勾选「在本站启用翻译」。默认把正文原地译为简体中文，阅读语言及逐条、微批、点击翻译模式均可在设置中修改。
3. 如果想检查匹配或自定义区域，点「识别弹幕区」或「选择弹幕区域」。移动鼠标查看高亮，用 ↑ 和 ↓ 调整层级，点击或按 Enter 确认。预览有误时，可以再点选一条正文作为示例。确认保存后，刷新页面会复用规则。
4. 配置了支持图像的模型时，可以在候选预览里点一次「AI 复核一次」，把候选区裁图和少量正文样本发送给该模型，获取建议。保存和启用由你确认。
5. 从「房间语言」查看或修正回复语言记忆。阅读翻译使用设置里的阅读语言，房间语言供之后的双语回复使用。

参考 [DeepSeek 模型文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。

## 规则、用量和范围

- **规则优先级**为本地规则、已验证社区规则、内置规则。首次发现新区域时先预览。可在设置中填入可信 GitHub 仓库的 Raw 索引 URL 并订阅，参见 [规则编写和发布](docs/rules.md)。当前仓库的社区索引为空，订阅地址留给发布时配置。
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
