# 发布到 DSH 插件市场

## 结论：没有官方市场，但有一条完整的"索引源"分发链路

DSH 自带的是**插件市场客户端**，不是官方商店：

- 「发现（Discover）」页只在开启实验性 bundle **自定义插件市场** 后出现（插件 → 实验性插件 → 更多 → 自定义插件市场），入口是 **发现 → 添加索引源**；
- 官方 bundle 的原话是 *"There is no official market; Discover lists only the index sources the user adds."*（`@deepseek-ai/dsh-experimental-plugin-market-bundle`）；
- 所以"发布到市场"= **把这个插件写进一份 format-1 索引 JSON，托管到一个 HTTPS 地址，让用户把这个地址加为索引源**。

社区里有第三方汇总市场（非官方、不做代码审计），例如 Open Plugin Market（<https://dshopen.org>，仓库 <https://github.com/polang233/dsh-plugin-index>）——收录要求大致是：**公开源码 + 可安装的 npm 版本 + 明确许可证**，通过它的 issue/PR 提交。另有 `weft-audit/dsh-market`、`awesome-dsh-plugin` 列表、<https://www.dshplugin.store> 等社区索引可作为补充渠道。第三方市场只做完整性/格式校验，不代表代码安全。

---

## 0. 本机/团队内分发（最快，不用任何账号）

1. 把 `market-index.example.json` 改成你的实际数据（见第 3 节），放到任意 HTTPS 地址；
2. 用户：插件 → 实验性插件 → 更多 → 打开「自定义插件市场」→ 发现 → 添加索引源 → 粘贴 URL；
3. 点条目安装，底层执行 `pnpm add <包名>@<版本>`（或 `git+https://…#<commit>`）。

> Host 读取索引**拒绝 HTTP 重定向**，所以索引 URL 必须直接返回 200（GitHub raw、GitHub Pages 的稳定地址、Cloudflare/S3 直链都行）。索引读取默认缓存 10 分钟。

不想走市场也可以直接装：

```sh
# npm 包
dsh plugin --profile desktop add dsh-plugin-session-fulltext@1.0.0
# Git 仓库里的子目录（pinned commit）
dsh plugin --profile desktop add "git+https://github.com/YOU/YOUR_REPO.git#<40位commit>&path:/dsh-plugins/session-fulltext"
# 本机目录
dsh plugin --profile desktop add link:/Users/you/dsh-plugins/session-fulltext
```

---

## 1. 发布 npm 包

本插件已经是可发布形态（无构建步骤、零运行时依赖、ESM）：

```sh
cd dsh-plugins/session-fulltext
npm pack --dry-run          # 检查 files：index.js / lib/client.js / cordis.patch.yml / README.md
npm login
npm publish                 # scoped 包首次用：npm publish --access public
```

发布前确认：

- `package.json` 的 `private` 已改为 `false`（本仓库已改）、`license` 明确（MIT）；
- `engines.dsh` 与实际适配版本一致（当前 `>=0.2.1-rc.2 <0.3.0`；DSH 升级后要重新验证并放宽/收紧，否则市场会显示不兼容）；
- `version` 每次发布递增（SemVer），市场按版本展示与回滚；
- 包名建议用 scope（`@your-npm-name/dsh-plugin-session-fulltext`）避免被抢注；无 scope 的 `dsh-plugin-session-fulltext` 目前检查为未占用，但先 `npm view <name>` 确认；
- `cordis.patch.yml` 里 `debug` 默认保持 `false`（已改）；本机要日志就在 profile patch 覆盖：

  ```yaml
  - id: session-fulltext
    config:
      debug: true
  ```

- 源码要公开（社区市场要求），建议放到 GitHub 并加 LICENSE；`package.json` 可补 `repository` / `homepage` / `author`。

---

## 2. 生成 format-1 索引

索引结构（完整校验逻辑在 `@deepseek-ai/dsh-plugin-market-index`）：

```json
{
  "format": 1,
  "title": { "en": "My DSH plugins", "zh": "我的 DSH 插件" },
  "metadata": { "categories": { "search": { "title": { "en": "Search", "zh": "搜索" } } }, "labels": {}, "sortKeys": {} },
  "plugins": [{
    "name": "dsh-plugin-session-fulltext",
    "title": { "en": "Session full-text search", "zh": "会话全文搜索" },
    "description": { "en": "...", "zh": "..." },
    "author": "le.su",
    "repository": { "url": "https://github.com/YOU/YOUR_REPO", "directory": "dsh-plugins/session-fulltext" },
    "metadata": { "category": "search", "keywords": ["search", "fulltext", "cjk"], "labels": [] },
    "versions": [{
      "version": "1.0.0",
      "publishTimestamp": 1792500000,
      "source": { "type": "npm" },
      "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" }
    }]
  }]
}
```

要点：

- `versions[].source`：npm 用 `{"type":"npm"}`（可带 `registry`），Git 用 `{"type":"git","url":"https://github.com/...","commit":"<40位小写sha>"}`；
- `publishTimestamp` 是 Unix 秒；`version` 必须是已发布的精确 SemVer；
- `icon` 可省略；给了就必须是 https 或索引同源的 URL / ≤32KiB 的 base64 data URL（SVG/PNG/JPEG/WebP）；
- `metadata.categories`/`labels` 里用到的 id 必须先声明，否则校验失败。

本仓库已带一个可用的示例 `market-index.example.json`（已用官方校验器跑过 `parseMarketIndex`，输出 `VALID format 1`）。改好后可以用同样的方式自查：

```sh
node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
const doc = JSON.parse(readFileSync('market-index.example.json','utf8'))
parseMarketIndex(doc, 'https://example.com/index.json')
console.log('index ok')
"
```

---

## 3. 托管索引

- GitHub Pages：`https://<you>.github.io/<repo>/index.json`
- GitHub raw：`https://raw.githubusercontent.com/<you>/<repo>/main/index.json`（直链 200，无重定向）
- 或任意对象存储 / 反代，HTTPS、无重定向、`Content-Type: application/json`

然后在本机验证：插件 → 实验性插件 → 打开「自定义插件市场」→ 发现 → 添加索引源 → 粘贴 URL → 应看到条目与版本列表 → 点安装（会走 pnpm 安装并提示信任/兼容性）。

## 4. 提交到公共社区市场

以 Open Plugin Market 为例（<https://dshopen.org>）：

1. 插件需要有公开仓库、可安装的 npm 版本、明确许可证（LICENSE 文件）；
2. 在 <https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin.yml> 填收录申请，或在其 `data/sources.json` 加条目后发 PR；
3. 对方构建时会用官方 `parseMarketIndex` 校验格式，并核对包名/版本/`dsh` bundle 声明；
4. 收录后用户添加 `https://dshopen.org/index.json` 即可看到。

其他渠道（可同时提交）：`weft-audit/dsh-market`、`awesome-dsh-plugin` 列表、`dshplugin.store`。这些都是第三方项目，不等于官方背书，也不等于代码审计。

---

## 5. 安全提醒（写进 README 也给用户看）

- 市场安装的是 **以 Host 权限运行的插件代码**，不在工作区沙箱内；只安装你信任的源码版本；
- 建议发布时附上源码 diff/权限说明（本插件只需要 `ctx.sessionQuery` 读写、`ctx.sessions`、浏览器 DOM，不联网、不写文件，除 opt-in 的 debug 日志）；
- 版本更新时市场按索引里的 `engines.dsh` 提示兼容性，DSH 大版本升级后需要发新版并改索引。
