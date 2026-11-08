# AI 日报 · 每天 10:00 发到 Gmail

每天北京时间 10:00，抓取几个 AI 新闻源，挑出最新 5 条，发一封 HTML 邮件到你的 Gmail。

- 不需要开着电脑，也不需要开着 DSH / Agent
- 纯抓取 + 发信，不调用大模型，零 token 成本
- 自动去重：推过的新闻不会第二天再推一次
- 单条源失败不影响整体（某个源限流、改版会自动跳过并记日志）

## 目录结构

```
ai-news-digest/
├── digest.mjs                        # 主程序：抓取 → 筛选 → 渲染 → 发送
├── seen.json                         # 已推送标题，用于去重
├── .env.example                      # 环境变量模板
├── .github/workflows/daily-digest.yml# GitHub Actions 定时任务
└── package.json
```

## 1. 本地先跑一遍（不发信）

需要 Node.js 20 或更高版本。

```powershell
cd ai-news-digest
npm install
npm run preview
```

`preview` 会抓取、筛选、渲染，把邮件内容写到 `preview.html`，并在终端打印纯文本版本。**不会发送，也不会修改 `seen.json`。** 用浏览器打开 `preview.html` 就能看到邮件长什么样。

## 2. 配置 Gmail

发信走 Gmail 的 SMTP，需要一个**应用专用密码**，不是你的 Google 账号密码。

1. 打开 <https://myaccount.google.com/security>，先开启**两步验证**（没开两步验证就没有应用专用密码）。
2. 打开 <https://myaccount.google.com/apppasswords>，随便起个名字（比如 `ai-digest`），生成一个 16 位密码。
3. 复制 `.env.example` 为 `.env`，填入：

```ini
GMAIL_USER=your.address@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
GMAIL_TO=your.address@gmail.com
```

`GMAIL_TO` 可以写多个地址，用英文逗号分隔。不填则默认发给自己。

4. 试发一封：

```powershell
npm start
```

去 Gmail 收件箱看看（没收到先查垃圾邮件）。成功后 `seen.json` 里会多出 5 条记录，再跑一次就不会重复推送同样内容。

> 注意：Google Workspace 账号可能被管理员禁用 SMTP；开启「高级保护计划」的账号无法使用应用专用密码。遇到 535 报错基本就是这两类原因，或者你填的是账号密码而不是应用专用密码。

## 3. 部署：选哪里？

| 方案 | 费用 | 准点程度 | 需要你开机吗 | 适合 |
|---|---|---|---|---|
| **GitHub Actions**（推荐） | 免费 | 通常延迟几分钟到二十分钟 | 不需要 | 想零成本、不想维护服务器 |
| **VPS / 云主机** | 约 $3–6/月 | 准点 | 不需要 | 要求 10:00 准点、以后还想跑别的 |
| 自己的电脑 | 免费 | 准点 | 需要 | 电脑本来就 24 小时开着 |
| Cloudflare Workers | 免费 | 准点 | 不需要 | 不推荐：Workers 没有现成 SMTP 客户端，发 Gmail 得走 Gmail API + OAuth，配置成本高很多 |

### 方案 A：GitHub Actions（推荐，免费）

1. 在 GitHub 新建一个仓库（私有仓库也可以），把 `ai-news-digest/` 里的文件推上去。
   **不要提交 `.env`**（已在 `.gitignore` 里）。
2. 打开仓库的 **Settings → Secrets and variables → Actions → New repository secret**，添加三个：
   - `GMAIL_USER`
   - `GMAIL_APP_PASSWORD`（16 位，带空格也行）
   - `GMAIL_TO`
3. 打开 **Actions** 标签页，左侧选「AI 日报」，点 **Run workflow** 手动跑一次，确认收到邮件。
4. 之后每天 UTC 02:00（北京时间 10:00）自动执行。

几点实话：

- **cron 不保证准点**，GitHub 的定时任务在高峰期可能延迟 5–20 分钟。要精确到 10:00 整，用 VPS。
- **仓库 60 天无提交，定时任务会被暂停**。这个项目每天会提交一次 `seen.json`，正好避免了这个问题；如果你手动关掉了提交步骤，记得偶尔点一下。
- 定时任务跑在默认分支上；如果你在别的分支上改代码，要合并过去才会生效。
- 免费额度：公开仓库不限，私有仓库每月 2000 分钟，这个任务每天约 1 分钟。

### 方案 B：VPS（要准点就选它）

任意 1 核 1G 的小机器，装 Node 20+。

```bash
sudo mkdir -p /opt/ai-digest && sudo chown "$USER" /opt/ai-digest
# 把项目文件拷进去（scp / git clone），然后：
cd /opt/ai-digest
npm install --omit=dev

# 写入 .env（同上面的三个变量）
vim .env

# 先手动跑一次
node digest.mjs
```

加定时任务（`crontab -e`）：

```cron
# 服务器时区是 UTC 时：
0 2 * * * cd /opt/ai-digest && /usr/bin/node digest.mjs >> /var/log/ai-digest.log 2>&1

# 服务器时区是 Asia/Shanghai 时：
0 10 * * * cd /opt/ai-digest && /usr/bin/node digest.mjs >> /var/log/ai-digest.log 2>&1
```

用 `timedatectl` 确认服务器时区。Debian/Ubuntu 的 cron 不认 `CRON_TZ`，别指望用它改时区。

### 方案 C：自己的 Windows 电脑

用「任务计划程序」每天 10:00 执行：

```
程序：C:\Program Files\nodejs\node.exe
参数：D:\path\to\ai-news-digest\digest.mjs
起始于：D:\path\to\ai-news-digest
```

缺点是那一刻电脑必须开着、不能睡眠——这也是为什么更推荐 A 或 B。

## 4. 想改点什么

| 需求 | 改哪里 |
|---|---|
| 每天几条 | `digest.mjs` 里的 `MAX_ITEMS = 5` |
| 推送时间 | 改 cron；北京 10:00 = UTC 02:00 |
| 增加/删除新闻源 | `digest.mjs` 顶部的 `FEEDS` 数组，加 `{ name, url }` 即可 |
| 同一来源最多几条 | `MAX_PER_SOURCE = 3`（保证来源多样，不够 5 条时会自动放宽） |
| 用 DeepSeek 筛选并写中文摘要 | 配 `DEEPSEEK_API_KEY`，见下一节；临时关掉加 `--no-llm` |
| 收件人 | `GMAIL_TO`，逗号分隔 |
| 邮件样式 | `buildContent()` 里的 `html` 模板 |
| 加中文摘要 | 在 `buildContent` 之前接一次模型 API，把 `items` 的标题和摘要丢进去生成 5 句中文；其余不用动 |

时间窗口：先取 24 小时内的新闻，不够 5 条时扩展到 72 小时，保证每天都有一封。

## 5. 可选：让 DeepSeek 帮你筛选

不接模型时，脚本按「发布时间最新」挑 5 条，会出现评测、软文、同一事件两条的情况。配一个 DeepSeek API key 后，流程变成：

```
抓取全部候选（最多 30 条）
        ↓
DeepSeek：按重要性挑 5 条、合并同一事件、排除软文和评测
        ↓
写中文标题 + 一句话摘要
```

邮件里每条会变成「中文标题 / 原文标题 / 来源 · 时间 / 中文摘要 / 链接」。

### 配置

1. 去 <https://platform.deepseek.com/api_keys> 创建 API key（需要先充值，按量计费）。
2. 本地写进 `.env`：

```ini
DEEPSEEK_API_KEY=sk-...
```

GitHub Actions 里加一个同名 secret：`DEEPSEEK_API_KEY`。

3. 跑 `npm run preview` 看效果。日志里会出现：

```
[llm] tokens: 输入 3120 / 输出 280
[llm] DeepSeek 选出 5 条（候选 30 条）
```

### 行为和成本

- 模型**只从候选里挑**，提示词明确要求「只从候选里选，不要编造新闻」，所以不会凭空多出一条。
- **任何失败都会回退**：没配 key、超时、401、余额不足、返回不是合法 JSON，都会自动退回按时间挑选，日报不会因为模型挂掉而断掉。
- 每次大约 2–4k 输入 token、几百输出 token，按 DeepSeek 当前定价是千分之一美元的量级（以官网为准），一个月通常不到一块钱。
- 临时关掉：`node digest.mjs --no-llm`，或从 GitHub 删掉这个 secret。
- 换模型：`DEEPSEEK_MODEL=deepseek-reasoner` 会更慢更贵，日报场景没必要。

### 提示词在哪

`digest.mjs` 顶部的 `LLM_PROMPT`。想改口味（比如只关注模型发布、少一点融资新闻），直接改那段中文，不用动代码。

## 6. 常见问题

**没收到邮件？**
先看 Gmail 的「已发送」里有没有这封邮件。有，说明发出去了，去垃圾邮件里找，或把发件人加进联系人。没有，看 Actions 日志里的 `[fail]` / `[error]`。

**535-5.7.8 Username and Password not accepted**
用了账号密码而不是应用专用密码；或者没开两步验证；或者账号是 Workspace 被管理员禁了 SMTP。

**某个源一直 429 / 403**
源在限流或屏蔽。脚本会跳过它，用剩下的源照样凑够 5 条。不想要就把它从 `FEEDS` 里删掉。

**日志里出现 `[llm] 调用失败，回退到按时间挑选`**
邮件照样会发，只是没用模型筛选。常见原因：key 写错或已撤销（401）、账户余额不足（402）、超时。看这一行后面的错误信息，修好即可，脚本本身不用改。

**邮件里出现了重复新闻**
`seen.json` 没有被持久化。GitHub Actions 里要保证最后一步提交成功（需要 `contents: write` 权限）；不要在本地跑完 `npm start` 又把 `seen.json` 重置了。

**想改成 Telegram 而不是邮件**
把 `sendMail()` 换成一次 `fetch` 到 `https://api.telegram.org/bot<token>/sendMessage` 即可，其余逻辑不用动。

## 7. 安全

- 应用专用密码等同于账号的发信权限，只放在 `.env` 或 GitHub Secrets 里，**永远不要提交**。
- DeepSeek API key 也一样：只放 `.env` / Secrets。它的权限是「消耗你的余额」，泄露了去控制台删掉重建。
- 怀疑 Gmail 密码泄露就去 <https://myaccount.google.com/apppasswords> 撤销那一条，重新生成。
- 仓库是 public 也没关系，只要 `.env` 没进去；但仍建议用私有仓库，日志里会包含你的邮件地址。
