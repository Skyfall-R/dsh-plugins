# dsh-plugins

DeepSeek Harness（DSH）插件，以及一份插件市场索引。

## 使用索引

在 DSH 插件页打开实验性插件「自定义插件索引」，在「发现」页添加：

```
https://raw.githubusercontent.com/Skyfall-R/dsh-plugins/main/index.json
```

## 插件

| 插件 | 说明 |
|---|---|
| [dsh-ciallo-affinity](plugins/dsh-ciallo-affinity) | CialloAPI 会话粘性：给 Claude 请求带上会话 id（`metadata.user_id`），让同一会话及其子智能体固定在同一个上游账号，避免提示缓存跨账号重写。 |

MIT