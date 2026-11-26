# 编写和订阅规则

规则索引使用 `schemaVersion: 1` 并包含一个 `rules` 数组。每个条目必须有唯一、稳定的 `id`。改变选择器后递增 `version`。同一个索引既可以手工维护，也可以接受 GitHub PR。

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "schemaVersion": 1,
      "id": "example-live",
      "version": 1,
      "host": "stream.example",
      "pathPrefix": "/live/",
      "container": "#chat",
      "message": ":scope > .chat-row",
      "body": ".message-body",
      "ignore": ".moderation"
    }
  ]
}
```

- `host` 匹配精确主机名。可选的 `pathPrefix` 匹配顶层页面路径，`framePathPrefix` 匹配聊天 frame 路径。
- `container` 选出一个弹幕列表，`message` 在该列表中匹配单条消息。可用 `:scope > ...` 约束为直接子节点。
- `body` 在每条消息里匹配正文。省略时使用整行文本，适用于行节点仅包含正文的页面。用 `ignore` 排除系统或审核行。
- 提交前，用不同直播间检查提取范围。优先使用语义标签、稳定 ID 或结构属性，尤其注意用户名、输入区、推荐列表和通知。

要订阅，把已发布索引的 Raw URL 填进设置，保存并授权。扩展会按约六小时的周期以及手动刷新时检查更新。新版本会先经过格式校验，之后在打开匹配页面时验证样本。要移除已确认的本地覆盖，在设置页删除该规则。
