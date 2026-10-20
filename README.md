# dsh-plugin-session-fulltext

CJK-friendly full-text (literal substring) content search for the DSH sidebar.

## 背景：DSH 自带的搜索为什么“只搜会话名称”

DSH 侧边栏搜索其实由两部分组成（见 `@deepseek-ai/dsh-client-ui-workspace`）：

- **即时本地匹配**：标题 + 工作区名的子串匹配（所以看起来“只搜会话名称”）；
- **250ms 防抖后发给 Host 的内容搜索**：`sessions.search` → `@deepseek-ai/dsh-api-session-controller` → `ctx.sessionQuery.searchSessions`。

内容搜索要能工作，必须有 `@deepseek-ai/dsh-session-query-sqlite` 提供的全文索引，而 base / web bundle 默认把它设成：

```yaml
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never      # 全文搜索被关闭
```

此时内容搜索会失败，客户端按设计**静默忽略**（"a failed content search leaves metadata matches visible without an additional warning"），于是表现为“搜索只匹配会话名称”。

把 `openAt` 改成 `first-search` 能打开官方 FTS5 索引，但它使用 FTS5 的 `unicode61` 分词器：**连续中文会被当成一个 token**。
实测（SQLite 3.51）：

```sql
-- 文档: 今天我们来讨论全文搜索的实现方案
MATCH '全文搜索' → 0 命中
MATCH '搜索'     → 0 命中
```

也就是说，官方全文搜索对中文基本不可用。本插件因此不启用 FTS，而是在同一个 service 上只替换 `searchSessions`，用**字面子串扫描**（大小写不敏感）检索当前会话里的 user/assistant 消息：

- 中文 1~2 个字也能命中（`合同`、`飞书`、`搜索`）；
- 英文/代码同样可用（`HUMAIN`、`session`、`Word 文档`）；
- 精确读取、标题、trace、`filterEvents` 等原 service 能力完全不动。

## 行为

- 索引内容：`user/message` + `assistant/message`，只取当前 surface（与 `api-session-controller` 的过滤条件一致）。
- 缓存：按 Session 缓存文档；live 会话用 `session.seq` 判断失效，纯持久化会话只读一次。
- 预热：插件激活后 2.5s 开始在后台逐 Session 建缓存并让出事件循环；实测 164 个会话、约 10.3M 字符（user+assistant）约 8s 建完，内存约 30–40MB。
- 查询：每次搜索重新列一次会话（~几十 ms），随后在内存里子串扫描；实测 164 个会话单次 25–45ms。
- 排序：命中次数多者优先 → 文档时间新者优先 → 会话创建时间新者优先。每个会话取最佳文档生成 240 字符 snippet。
- 预热未覆盖的会话按需加载，因此刚启动就搜索也能出结果（只是第一次会慢一点）。
- 搜索请求被取消（新输入/失焦）时沿用 DSH 的 AbortSignal 语义。

## 安装

已安装到 Desktop profile（**一个包同时提供 Host 半和浏览器半**）：

```sh
dsh plugin --profile desktop add link:/Users/le.su/wtdshwkspace/dsh-plugins/session-fulltext
```

`package.json` 里 `dsh.bundle.patch` 负责挂 Host 侧的行，`dsh.client` + `exports["./client"]` 负责让 Web 组合把 `lib/client.js` 送进浏览器 boot graph。

该命令会：

1. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里记录 `link:...`；
2. 把 `dsh-plugin-session-fulltext` 追加到 `dsh.profile.bundles`；
3. Host 侧行通过 profile HMR 热更即可生效；**首次安装（或本次合并后）需要重启一次 App**，让 Web 组合重新扫描 `dsh.client` 声明、把 `lib/client.js` 放进浏览器 boot graph。之后再改浏览器端代码由 `dsh-client-hmr` 自动热替换，无需重启。

## 配置

bundle 的 `cordis.patch.yml` 里给插件行传配置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `debug` | `false`（本机 patch 里设为 `true`） | 往 `$DSH_HOME/session-fulltext.log` 追加激活/预热/搜索日志 |
| `warmupDelayMs` | `2500` | 启动后多久开始后台预热 |
| `snippetChars` | `240` | snippet 长度上限 |
| `types` | `['user/message','assistant/message']` | 建索引的事件类型 |

调试日志：`~/.dsh/session-fulltext.log`。

## 关闭 / 卸载

- 临时关闭：把 profile patch 里 `session-fulltext` 行的 `disabled: true`，或从 `dsh.profile.bundles` 移除后删依赖：
  `dsh plugin --profile desktop remove dsh-plugin-session-fulltext`
- 本插件不修改官方配置，`session-query-sqlite` 保持 `openAt: never` 即可。

## 点搜索结果 → 定位/高亮 + 会话内「上一个 / 下一个」

浏览器半（`lib/client.js`）补上了官方侧边栏缺失的跳转能力：

- 点搜索结果后自动翻历史把命中加载出来，滚到第一个命中并标黄（CSS Custom Highlight API），命中的 turn 行闪一次描边；
- 会话右上角浮出 `n / m  上一个  下一个  ×` 胶囊，可在本会话所有命中之间循环跳转；`Esc` 或 `×` 关闭并清除高亮，切换会话/新搜索时自动收起；
- 点完一条结果后搜索框和结果列表保留（官方点击处理会清空），可以直接点下一条；
- 搜索框占位符改成「搜索会话名称与内容」；已归档行、Unarchive 按钮不触发；
- 健康检查：页面加载后 `~/.dsh/session-fulltext.log` 会出现一次 `search "dsh-fulltext-client-probe"`。

浏览器端 bundle 由官方 `dsh-client-hmr` 每 500ms 轮询文件并在页面里热替换；**新增/合并 `dsh.client` 声明**时，Host 半会主动清掉 `clientModules` 的包元数据缓存并 `flush()` 一次，让新 graph 推到已打开的页面（日志里会有 `client graph refresh requested`），一般也不需要重启 App。

手动验证：控制台执行 `__dshSessionFulltext.reveal('合同')`。

## 已知限制

- 只索引当前 surface 的 user/assistant 消息；tool/result、tool/call 等不参与（侧边栏本来也只显示这两类）。
- 纯内存缓存：App 重启后需要重新预热；第一次启动后立刻搜索会边搜边建缓存。
- 不支持正则、分词或模糊匹配，只做大小写不敏感的字面子串；多词查询用空格分隔时是 AND 语义。
- 每次查询会调用一次 `listSessions`（持久化目录列举），在会话数量极大时会线性变慢。
