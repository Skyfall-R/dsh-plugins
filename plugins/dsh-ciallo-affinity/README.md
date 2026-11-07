# dsh-ciallo-affinity：CialloAPI 会话粘性

DeepSeek Harness（DSH）直连 CialloAPI 时，请求里没有 `metadata.user_id`，网关只能按请求内容算会话键。这个键隔一阵就会变，请求被分到另一个上游账号，几十万 token 的上下文要按 1.25 倍输入价重写一遍缓存（命中缓存只要 0.1 倍）。

本插件给每个发往 Claude 的 `/v1/messages` 请求补上：

```json
{ "metadata": { "user_id": "{\"device_id\":\"dsh-<主机名>\",\"account_uuid\":\"\",\"session_id\":\"session-…\"}" } }
```

网关据此把同一会话固定在同一个账号上。

## 工作方式

DSH 不提供修改请求体的配置项，只提供 `llm-pi-ai/request-headers` 钩子（能拿到会话 id）。所以插件分两部分，都在 DSH 进程内运行：

1. 钩子：给配置的路由加内部请求头，带上会话 id。
2. 本机中转 `127.0.0.1:18765`：读出会话 id，写进请求体的 `metadata.user_id`，删除内部请求头，原样转发到 CialloAPI。流式响应直接透传。

规则：

- 请求自带 `metadata.user_id` 时不覆盖。
- 只改 `/v1/messages`。`count_tokens`、模型列表等原样转发。
- 每个 DSH 会话的 id 不同，新开对话就是新的 `session_id`。
- 子智能体（fork、spawn）沿着 `parentSession` 归到根会话，用根会话的 `session_id`。fork 继承了父会话的整段前缀，只有和父会话在同一账号上才能读到缓存。设 `subagents: own` 可改为各用各的 id。
- 没有会话 id 的请求（少数辅助调用）不加字段，由网关按内容处理。

## 安装

1. 插件页 → 添加插件，输入 `dsh-ciallo-affinity`（从 npm 安装）；或在「发现」页添加插件索引后安装。
2. 把 profile 的 `cordis.patch.yml` 里 CialloAPI 路由的 `baseURL` 改成中转地址：

   ```yaml
   - id: llm-pi-ai
     config:
       providers:
         ciallo-anthropic:          # 与插件配置 providers 中的名字一致
           api: anthropic-messages
           baseURL: http://127.0.0.1:18765
           # 其余字段不变
   ```

3. 路由名不是 `ciallo-anthropic`、或端口有冲突时，在插件配置里改 `providers` / `port`。

## 验证

- 浏览器打开 `http://127.0.0.1:18765/__ciallo-affinity`：`injected` 随对话增长，`errors` 为 0。`sessions` 列出最近的会话 id、它们映射到的根会话（`root`）和层级（`depth`）。
- 看会话里的用量：对话进行中缓存读取应占输入的绝大部分，每轮缓存写入只有新增内容那么多。
- 网关侧：这个 Key 的粘性来源应从 `cacheable_content` 变成 `metadata_user_id`。

**首次启用时**，正在进行的对话会按新会话键重新分配一次账号，可能整段重写一次缓存，之后稳定。

## 回退

把 `baseURL` 改回 `https://cialloapi.com`，再在插件页关掉本插件。

## 限制

- 插件关掉或端口被占用时，指向中转的路由会连不上。
- 粘性只防止换账号，不减少上下文本身：新会话第一轮照常写缓存；上下文越长，每轮读缓存的费用越高。

## 许可

MIT
