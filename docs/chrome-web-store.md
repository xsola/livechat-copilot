# Chrome 商店文案草稿

## 简短介绍

在直播聊天中原地查看双语弹幕。支持 YouTube 和 Twitch 直播、自定义弹幕选区和自带兼容模型服务。

## 详细介绍

LiveChat Copilot 帮你在看直播时读懂其他语言的弹幕。译文显示在原消息下方，你可以同时看到原文和译文。

当前可用功能

- 可为当前直播间或本站所有直播间启用翻译，并选择自动合并、逐条翻译或点选翻译。YouTube 和 Twitch 直播有内置适配。
- 在其他提供可读取文字弹幕的网页上，可以尝试自动识别或手动选区，确认后保存规则供下次使用。
- 翻译目标默认跟随 Chrome 界面语言，也可在工具栏切换。自动翻译可跳过已是目标语言的弹幕，表情默认保留。
- 使用自己的 OpenAI 兼容 Chat Completions 服务，可在设置中测试连接、图片支持和单条翻译耗时。选区截图核验可按需开启。
- 模型用量保存在本地，诊断摘要可以先预览，再由你选择是否分享。

需要桌面版 Chrome 120 或更新版本，以及可用的兼容模型服务。启用翻译时，需要翻译的消息会发送到你配置的服务。开启截图核验时，候选区域裁图和少量弹幕样本也会发送到该服务。

## 后续计划

计划增加传统翻译 API、浏览器端翻译、更多直播平台适配、社区规则订阅和双语回复草稿。这些功能尚在待办阶段。完整清单见 [项目功能计划](../README.md#计划功能)。

## 发布参考

[数据处理说明](privacy.md) · [Chrome 商店商品详情填写说明](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) · [Chrome 商店商品详情要求](https://developer.chrome.com/docs/webstore/program-policies/listing-requirements)
