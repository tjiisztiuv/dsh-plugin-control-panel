# dsh-plugin-control-panel

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）加一个跨会话的控制面板，思路来自 SimpleAgent 的 W5 控制面板。

## 现在能做什么（v0.6）

- 左栏多两个入口：「控制面板」和「今日」，点开后只换主区域，左栏不动。「控制面板」图标在有未读消息时右上角有红点；「今日」图标在今天的建议写好、但你还没打开「今日」看过时有红点。
- **状态带**：运行中、等待处理、未读消息、待办、近 24 小时任务数。
- **今日**：单独一页，两列显示今天的运动计划和饮食建议，条目全部展开。每天定时让 claude（不行就换 opencode）在你指定的项目目录里读资料写出来，见[今日建议](#今日建议)一节。控制面板标题下面留一行今天的两句提要（或者「正在生成」「还没生成出来」），点一下跳到「今日」；没配置建议时这一行不出现。想在手机上看，可以让它写好后再写进一个同步的 Markdown 文件、发一封邮件，见[写进文件](#写进文件)和[发到邮箱](#发到邮箱)。
- **纳指**：「今日」那一行下面再一行纳指摘要：最近一个交易日的涨跌幅、乖离分位评分、SMA 三线评分。每天 08:10 后跑一次 HappyLifeFinance 的 `nasdaq_valuation` 拿数，见[纳指](#纳指)一节；没配置时这一行不出现。
- **指挥台**：输入一句任务，回车下发到所选工作区的一个新会话。以 `@工作区名` 开头可以直接指定工作区；只写 `@工作区名` 则只切换目标工作区。
- **任务列表**：所有工作区里正在运行、等待你处理、或近 24 小时动过的会话。等待处理的排最前，点一行跳到那个会话。
- **消息**：脚本和例行任务投进来的结论。点开看全文，点开 30 分钟后自动归档，也可以手动归档或全部已读。投递就是往一个文件里追加一行 JSON，格式见下面的[消息](#消息)一节。
- **备忘**：全局的备忘清单。可以直接写，也可以从任务列表的一行或一条消息转过来；从会话建的备忘能跳回那个会话。见[备忘](#备忘)一节。

还没做：会话失败自动进消息、卡片内联审批、token 用量汇总、把消息交给指挥台。

## 消息

消息存在一个目录里的两个文件中：

| 文件 | 内容 | 谁写 |
|---|---|---|
| `inbox.jsonl` | 每行一条消息，只追加 | 你的脚本、例行任务 |
| `state.json` | 每条消息的已读和归档时间 | 只有本插件写，投递方不要碰 |

目录默认是 `~/.dsh-control-panel`。任何能往 `inbox.jsonl` 追加一行 JSON 的东西都能投递，不依赖别的工具。

### 建目录

```sh
scripts/init-inbox.sh            # 建 ~/.dsh-control-panel 和空的 inbox.jsonl
scripts/init-inbox.sh --test     # 建好后顺手投一条测试消息，用来确认面板读得到
scripts/init-inbox.sh ~/somewhere/inbox   # 建在别处，并打印让插件读它的配置
```

脚本可以重复运行，已有的目录、权限和消息都不会被改动。新建的目录权限是 `700`，因为消息里可能有命令输出。不想用脚本的话，`mkdir -p ~/.dsh-control-panel` 就够了。

### 换目录

两种办法，配置优先于环境变量：

1. 在 `cordis.patch.yml` 里覆盖本插件这一行的配置。归档时限也在这里改。和今日建议的 `advice` 写在同一个条目里，写在哪个文件、要注意什么见[今日建议的配置](#配置)：

   ```yaml
   - id: dsh-plugin-control-panel
     config:
       inboxDir: ~/somewhere/inbox
       archiveAfterMinutes: 30
   ```

2. 启动 dsh 之前设置环境变量 `DSH_CONTROL_PANEL_DIR`。`scripts/init-inbox.sh` 和下面的 shell 示例也认这个变量，适合想让投递脚本和插件用同一处设置的情况。从桌面图标启动的 dsh 读不到 shell 里的环境变量，那种情况用第 1 种。

收件箱为空时，面板会显示它实际在读的文件路径，可以用来确认配置生效了。

### 一条消息的格式

`inbox.jsonl` 的每一行是一个 JSON 对象：

```json
{"id": "ms_1791378464498_7fcb0e", "source": "backup", "title": "备份完成", "body": "NAS 增量备份 12.3 GB", "ts": "2026-10-07T21:07:44.498+08:00", "level": "success", "ref": {}}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | 字符串 | 是 | 全文件唯一。约定写成 `ms_<毫秒时间戳>_<6 位十六进制随机数>`。已读和归档状态按它记录，两条消息 id 相同会共用状态 |
| `title` | 字符串 | 建议填 | 列表里的标题。不填时界面显示 id |
| `body` | 字符串 | 否 | 正文，纯文本。列表只显示前 200 字，点开看全文。建议不超过 64 000 字 |
| `source` | 字符串 | 否 | 来源，自己起名，如 `backup`、`schedule`、`ci`。不填按 `system` |
| `level` | 字符串 | 否 | `info`、`success`、`warn`、`error` 之一，决定圆点颜色。不填或填别的按 `info` |
| `ts` | 字符串 | 建议填 | 发生时间，ISO 8601 且带时区，如 `2026-10-07T21:07:44+08:00` 或 `2026-10-07T13:07:44Z`。只用来显示「几分钟前」 |
| `ref` | 对象 | 否 | 点开消息后做什么，见下表。不填按 `{}` |

`ref` 的三种写法：

| `ref` | 点开后 |
|---|---|
| `{}` | 弹层显示全文 |
| `{"url": "https://…"}` | 弹层显示全文，并多一个「打开链接」按钮。只认 `http://` 和 `https://` 开头的地址 |
| `{"dsh_session_id": "<会话 id>"}` | 直接跳到那个 dsh 会话 |

### 写入规则

1. **一条消息一行**，UTF-8 编码，以换行符结尾。正文里的换行必须是 JSON 转义的 `\n`，用 JSON 库序列化就不会出错。
2. **只追加**。不要修改或删除已有的行，也不要写 `state.json`。
3. **整行一次写完**：以追加方式打开文件，一次 `write` 写出整行。多个进程同时投递时，这样两条消息才不会串成一行。
4. **目录要先建好**，见上面的「建目录」。
5. 「当前」列表按写入顺序排，新写的在最上面，和 `ts` 无关。
6. 写坏的行（不是 JSON 对象，或者没有 `id`）会被跳过，不影响其他消息。

消息投进去之后，开着的面板最多 30 秒刷新出来。

### 投递示例

**shell**（需要 `jq`）：

```sh
dir="${DSH_CONTROL_PANEL_DIR:-$HOME/.dsh-control-panel}"

jq -cn \
  --arg id "ms_$(date +%s)000_$(openssl rand -hex 3)" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg title "备份完成" \
  --arg body "NAS 增量备份 12.3 GB" \
  '{id: $id, source: "backup", title: $title, body: $body, ts: $ts, level: "success", ref: {}}' \
  >> "$dir/inbox.jsonl"
```

把一条命令的输出当正文：

```sh
uv run pytest 2>&1 | jq -Rsc \
  --arg id "ms_$(date +%s)000_$(openssl rand -hex 3)" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{id: $id, source: "schedule", title: "夜间测试", body: ., ts: $ts, level: "warn", ref: {}}' \
  >> "$dir/inbox.jsonl"
```

**Python**（只用标准库）：

```python
import json, os, secrets, time
from datetime import datetime
from pathlib import Path

def push(title, body="", *, source="script", level="info", ref=None,
         directory=Path.home() / ".dsh-control-panel"):
    directory.mkdir(parents=True, exist_ok=True)
    item = {
        "id": f"ms_{int(time.time() * 1000)}_{secrets.token_hex(3)}",
        "source": source,
        "title": title,
        "body": body,
        "ts": datetime.now().astimezone().isoformat(timespec="milliseconds"),
        "level": level,
        "ref": ref or {},
    }
    line = (json.dumps(item, ensure_ascii=False) + "\n").encode("utf-8")
    fd = os.open(directory / "inbox.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line)  # 整行一次写完
    finally:
        os.close(fd)

push("部署完成", "v1.4.2 已上线", level="success", ref={"url": "https://example.com/releases/1.4.2"})
```

### 已读和归档

归档是算出来的，不搬文件：`归档时间 = archived_at，没有就是 read_at + 30 分钟`。没点开过的消息永不自动归档。`state.json` 的内容是：

```json
{"ms_1791378464498_7fcb0e": {"read_at": "2026-10-07T21:10:02.118+08:00", "archived_at": null}}
```

### 和 SimpleAgent 共用一份收件箱（可选）

这套文件格式和 SimpleAgent 面板目录的一样。装了 SimpleAgent 又想两边看同一份消息，把插件的目录指过去：

```yaml
- id: dsh-plugin-control-panel
  config:
    inboxDir: ~/.simpleagent/panel
```

之后 `sa inbox push` 投的消息也会出现在这里：

```sh
uv run pytest 2>&1 | sa inbox push -t "夜间测试" --level warn --source schedule
```

共用时要知道三点：

- **指向 SimpleAgent 会话的消息在这里跳不过去**（`ref` 是 `{"space_id": …, "session_id": …}` 的那种），只能当文本看全文。反过来，带 `dsh_session_id` 的消息在 SimpleAgent 里显示为纯文本。
- **两边同时点可能丢一次状态**。`state.json` 是「读出来、改、整份写回」，SimpleAgent 的界面和本面板在同一瞬间各点一条，后写的会盖掉先写的。消息本身不会丢。
- **归档时限各算各的**。两边配置不一样时，同一条消息可能在一边已归档、另一边还在当前。

## 备忘

一份全局的备忘清单，和消息放在同一个目录里：

| 文件 | 内容 | 谁写 |
|---|---|---|
| `todos.json` | 全部备忘，一个 JSON 数组 | 只有本插件写，每次改动整份重写 |

三种加法：

- 在备忘区的输入框里写一句，回车保存。
- 任务列表里把鼠标移到一行上，点右侧的「+备忘」。这条备忘会带上「跳到会话」。
- 消息弹层里点「+备忘」，用消息标题建一条。

勾选表示完成，完成的沉到下面；点 × 删除，删除不可撤销。状态带里的「待办」是未完成的条数。面板开着时每 30 秒重读一次文件。

### 文件格式

```json
[
  {
    "id": "td_1791378464498_7fcb0e",
    "text": "周五前回邮件",
    "done": false,
    "kind": "text",
    "ref": {},
    "created_at": "2026-10-07T21:07:44.498+08:00",
    "done_at": null
  }
]
```

| 字段 | 说明 |
|---|---|
| `id` | 唯一，`td_<毫秒时间戳>_<6 位十六进制随机数>` |
| `text` | 备忘内容 |
| `done`、`done_at` | 是否完成，以及勾选的时间；取消勾选时 `done_at` 变回 `null` |
| `kind`、`ref` | 能不能跳转。`ref` 为 `{"dsh_session_id": "<会话 id>"}` 时可以跳到那个 dsh 会话，此时 `kind` 仍是 `text` |
| `created_at` | 创建时间。未完成和已完成各自按它从旧到新排 |

和消息不同，**这个文件不适合脚本直接写**：它每次改动都整份重写，脚本和插件同时写会互相覆盖。想让脚本提醒你，投一条消息，再在面板里转成备忘。

文件如果被改坏了（不是合法的 JSON 数组），插件不会覆盖它，而是在备忘区报错，等你修好或删掉。插件不认识的字段在重写时会原样保留。

### 和 SimpleAgent 共用（可选）

文件名和字段与 SimpleAgent 的一样，按[上面的办法](#和-simpleagent-共用一份收件箱可选)把目录指到 `~/.simpleagent/panel` 后，备忘也是两边共用。

- 在这里从 dsh 会话建的备忘，在 SimpleAgent 里显示为普通文字备忘。
- SimpleAgent 里指向它自己会话的备忘（`kind` 为 `session`），在这里显示为普通文字备忘，没有「跳到会话」。
- 和 `state.json` 一样，两边在同一瞬间各改一条，后写的会盖掉先写的。

## 今日建议

每天到点后，插件在你指定的项目目录里跑一次 agent，让它按那个目录自己的规则（`AGENTS.md`、`CLAUDE.md`、状态和记忆文件）写出今天的运动计划和饮食建议，显示在左栏的「今日」页。默认关闭，配好 `advice.cwd` 才会跑。

### 配置

改配置文件，然后重启 dsh。dsh 在两个地方读 `cordis.patch.yml`，写在哪个都行：

| 文件 | 作用范围 |
|---|---|
| `~/.dsh/cordis.patch.yml` | 所有 profile |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 只有这个 profile。从桌面图标启动的 dsh 用的是 `desktop` |

在其中一个文件里找到（或新加）本插件的条目，把 `advice` 写进它的 `config`：

```yaml
- id: dsh-plugin-control-panel
  config:
    inboxDir: ~/.simpleagent/panel        # 消息目录，不改就不写，见上面的「换目录」
    advice:
      cwd: "~/Library/Mobile Documents/iCloud~md~obsidian/Documents/HappyUnified/10 Projects/sport_health_cc"
      at: "08:00"
      agents: [claude, opencode]
      claudeModel: sonnet
      todayFile: ~/dev_code/SportHealth/inbox/今日建议.md   # 写好后覆盖这个文件，不要就不写，见下面的「写进文件」
      mailCommand: ~/.local/bin/mail-me   # 写好后发邮件，不要就不写，见下面的「发到邮箱」
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `cwd` | 无，不配就不跑 | agent 运行的项目目录，`~` 会展开。路径里有空格或特殊字符时加引号 |
| `at` | `08:00` | 每天几点以后开始写，本地时间 `HH:MM`，要加引号 |
| `agents` | `[claude, opencode]` | 依次尝试，前一个失败或回答格式不对就换下一个。只想用一个就写 `[opencode]` |
| `timeoutMinutes` | `10` | 每个 agent 最多跑多久 |
| `claudeModel` | `sonnet` | 传给 `claude --model`，如 `opus`、`haiku`；写 `""` 用 claude 自己的默认 |
| `opencodeModel` | `""` | 传给 `opencode -m`，如 `deepseek/deepseek-flash`；`""` 用 `opencode.json` 里的默认 |
| `claudeBin`、`opencodeBin` | 自动找 | 可执行文件不在 `~/.local/bin`、`~/.opencode/bin`、`/opt/homebrew/bin` 时写全路径 |
| `todayFile` | 无，不写文件 | 每次写好后整篇覆盖的 Markdown 文件，只放当天的内容；`~` 会展开。所在目录要已经存在 |
| `mailCommand` | 无，不发信 | 每次写好后用来发邮件的命令。写一个路径，或者写成列表带上前几个参数，如 `[~/.local/bin/mail-me, -t, 别的地址]`；路径里的 `~` 会展开 |

不认识的值会退回默认：比如 `at` 写成 `8点` 就按 `08:00`。

写的时候注意三点：

1. **本插件的配置只写在一个文件的一个条目里。** 两个文件都有本插件的 `config` 时，dsh 不会合并，`~/.dsh/cordis.patch.yml` 里的会整块替换 profile 里的。比如 `inboxDir` 写在一个文件、`advice` 写在另一个，最后只剩 `~/.dsh/cordis.patch.yml` 里那一半。
2. **文件必须是 YAML 列表**，每个条目以 `- id:` 开头。不需要任何条目时写 `[]`，不要留空文件，空文件会让 dsh 启动失败。
3. **改完重启 dsh。** 重启后看「今日」页下面那一行的「每天 08:00 自动生成（claude → opencode）」，显示的就是生效的时间和 agent 顺序，可以用来确认改对了。

### 什么时候跑

只在 dsh 开着时跑。插件启动 20 秒后检查一次，之后每 5 分钟检查一次：过了 `at` 而今天还没写成，就跑一次，一般一两分钟写完。所以：

- dsh 一直开着：每天 `at` 后几分钟内写好。Mac 那时睡着的话，醒来后补上。
- 早上才打开 dsh：打开后马上开始写，「今日」页上显示「正在生成…」，写完自动刷新。

失败的话 30 分钟后重试，一天最多自动重试 3 次。「今日」页上的「现在生成」「重新生成」随时可以点。重新生成失败时，今天已有的内容保留，下面多一行失败原因。

没有用 launchd 在 dsh 关着时跑：项目目录在 iCloud 云盘里时，macOS 不让 launchd 启动的进程读它（实测会被隐私保护拦下）。dsh 自己能读，所以由 dsh 里的插件来跑。

### 写进文件

配了 `todayFile` 之后，每次写好建议（定时的和手动点「重新生成」的都算），插件把它整篇覆盖写进这个文件，只留当天的。拿一个会同步到手机的目录（比如 Obsidian 库的本地副本）放它，手机上就能看。格式照 SportHealth 工作区 `AGENTS.md` 里 `今日建议.md` 的写法：

```markdown
# 今日建议 · 2026-10-09（周五）· 训练日

> 提醒或数据缺口说明（没有就不写这一行）

## 运动

力量B 上肢+体态 · 不练腿 · 约50分钟

- 先自检……

## 饮食

恢复周 · 约2000-2200 kcal · 蛋白110 g

- 早餐……

*claude · opus 自动生成于 08:03*
```

「训练日 / 休息日」是 agent 在回答里给的，没给就不写。

覆盖之前，文件里原来的内容和这次要写的不一样时，插件先把原来的内容存到 `advice/replaced/<时间>.md`。原来的内容可能是你在手机上记下的实际训练和饮食，覆盖掉就没了，要找回来就去那里看。原样直接写，不经过临时文件，免得同步程序把临时文件也同步过去。

「今日」页下面那一行会写「08:03 已写入 今日建议.md」，写不进去时多一行红字说原因，比如目录不存在、没有写权限。没写进去不会自动重试，点「重新生成」会再写一次。

### 发到邮箱

配了 `mailCommand` 之后，每次写好建议（定时的和手动点「重新生成」的都算），插件会调用一次这个命令：主题作为最后一个参数，正文从标准输入传进去。主题是「今日 10-09 周五：」加上运动那一句，手机邮件列表里一眼能看到；正文是两列的全部条目、提醒和谁写的。

命令要在 4 分钟内结束，退出码 0 算发出。「今日」页下面那一行会写「08:03 已发邮件」，没发出去时多一行红字说原因，命令的输出记在当天的 `.log` 里。没发出去不会自动补发，点「重新生成」会再发一次。邮件在建议写好、锁放开之后才发，邮件服务器慢不会让页面一直显示「正在生成」。

能这样调用的命令都行。本仓库带了一个 `scripts/mail-me`，走 QQ 邮箱 SMTP 发（Gmail 的 SMTP 端口在本机代理那条线路上不通，QQ 邮箱走直连，收件人照样可以是 Gmail），只用 `/usr/bin/python3` 自带的库：

```sh
ln -s "$PWD/scripts/mail-me" ~/.local/bin/mail-me   # 装成本机命令，别的脚本也能用
echo "NAS 增量备份 12.3 GB" | mail-me "备份完成"     # 用法：主题写在参数里，正文从标准输入读
mail-me --dry-run "主题" < body.txt                  # 只打印要发的信，不连服务器
```

它的配置在 `~/.config/mail-me/config.ini`：

```ini
[mail-me]
to = 收件人地址
credentials = ~/path/to/qq_mail.ini   # 里面是 [qq_mail] 段的 user 和 auth_code
```

`auth_code` 是 QQ 邮箱「设置 → 账户 → POP3/IMAP/SMTP 服务」里生成的授权码，不是 QQ 密码。也可以把 `[qq_mail]` 段直接写在 `config.ini` 里，或者设置环境变量 `QQ_MAIL_USER` 和 `QQ_MAIL_AUTH_CODE`。存了授权码的文件记得 `chmod 600`。

发送失败会重试，一共三次，间隔 20 秒和 60 秒；授权码错了不重试。退出码 0 是发出了，1 是没发出去，2 是用法或配置有问题，原因写在标准错误的最后一行。

### agent 能做什么

只读。claude 只给 `Read`、`Glob`、`Grep` 三个工具，不保存会话；opencode 用 `OPENCODE_PERMISSION` 把读文件以外的权限全部设为拒绝。提示词也要求它不改任何文件、不做项目规则里的「对话收尾」。项目里的日志和状态文件照旧由你在对话里更新。

### 文件

和消息放在同一个目录的 `advice/` 子目录里：

| 文件 | 内容 |
|---|---|
| `<日期>.json` | 当天的结果：`sport`、`diet` 各有 `headline` 和 `items`，外加 `note`、谁写的、什么时候写的、失败原因 |
| `<日期>.log` | 每次尝试的命令行、退出码、输出尾部。没写出来时先看这里 |
| `run.lock` | 正在跑时存在，记着进程号和正在试的 agent。两个 dsh 进程不会同时跑 |
| `replaced/<时间>.md` | `todayFile` 被覆盖前的内容，只在和新内容不同时才存 |
| `seen.json` | 你最后一次在「今日」页看到的是哪一次生成的建议（记它的 `generated_at`）。新写出来的和它不同，「今日」图标就亮红点。删掉它只会让红点再亮一次 |

### 常见问题

- **「没有权限访问 …（macOS 隐私保护拦下了这个进程）」**：dsh 没有读这个目录的权限。在 dsh 里对这个目录开一个会话、让它读个文件，macOS 会弹窗请求权限；或者到「系统设置 → 隐私与安全性 → 文件与文件夹」里给 DeepSeek Harness 打开对应项。
- **「找不到 claude」**：从程序坞启动的 dsh 只有很短的 PATH，插件会去常见安装位置找；装在别处就配 `claudeBin`。
- **「回答不是约定的 JSON 格式」**：模型没按格式回答，原文在当天的 `.log` 里。会自动换下一个 agent。

## 纳指

控制面板「今日」那一行下面的一行，长这样：

```
纳指   10-08 周四 -1.39%   乖离分 6.3   SMA 5/5                08:11 更新 · 刷新
```

- **日期和涨跌幅**：最近一个已收盘的美股交易日（周一早上看到的是上周五），`^NDX` 收盘价比前一交易日的涨跌，涨绿跌红，和 nasdaq_valuation 的邮件报告一致。
- **乖离分**：乖离分位评分（0–10），即价格对 250 日均线的乖离在 10 年里的分位，报告里的 `SCORE`。
- **SMA**：SMA 三线评分（0–5），报告里的 `SMA 三线评分`。
- **最右边**：今天这次更新的状态：「08:11 更新」、到点前的「08:10 自动更新」、「正在更新…」，或者红字「更新失败」。旁边的「刷新」「重试」「现在更新」随时可以点。

鼠标停在这一行上会显示收盘价和前收；更新失败时显示原因和日志位置。今天还没更新成功时，这一行继续显示最近一次拿到的数，看日期就知道是哪天的。

### 配置

和 `advice` 一样写在本插件条目的 `config` 里（注意事项见[今日建议的配置](#配置)），改完重启 dsh：

```yaml
- id: dsh-plugin-control-panel
  config:
    nasdaq:
      cwd: ~/dev_code/HappyLifeFinance/tools/nasdaq_valuation
      at: "08:10"
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `cwd` | 无，不配就不跑 | nasdaq_valuation 的目录，`~` 会展开 |
| `at` | `08:10` | 每天几点以后开始跑，本地时间 `HH:MM`，要加引号 |
| `command` | `[/usr/bin/python3, main.py]` | 在 `cwd` 里运行的命令，写成列表；路径里的 `~` 会展开。换成别的命令时，它必须重写 `latest_signals.json` |
| `timeoutMinutes` | `5` | 最多跑多久 |

### 怎么拿数

到点后在 `cwd` 里运行一次 `command`（默认就是 `python3 main.py`，平时手动跑的那个），退出码 0 之后读它留下的两个文件：

| 文件 | 读什么 |
|---|---|
| `latest_signals.json` | `report_date`（交易日）、`signals.valuation_score`、`signals.sma_score`、`signals.ndx_close`。这是 main.py 给下游程序准备的结构化输出，数字和 `latest_report.txt` 上印的逐位一致 |
| `cache/ndx_daily.csv` | 交易日那一行和它前一行的 `Close`，算涨跌幅。读不到时涨跌幅显示「—」，两个评分照常显示 |

`latest_signals.json` 的 `generated_at` 早于这次运行开始的时间，就算失败：说明命令没有重写它，读到的是旧数。

跑 main.py 会照常刷新它自己的 `latest_signals.json`、`latest_report.txt` 和 `cache/`，和平时手动跑、巡检任务跑一样。08:10 时美股已经收盘几个小时，拿到的是完整的日 K。

什么时候跑、失败怎么重试，和今日建议一样：只在 dsh 开着时跑，启动 20 秒后检查一次、之后每 5 分钟一次；失败 30 分钟后重试，一天最多自动重试 3 次。周末也照跑，显示的仍是上一个交易日的数。

### 文件

在消息目录的 `nasdaq/` 子目录里，和 `advice/` 的写法一样：

| 文件 | 内容 |
|---|---|
| `<日期>.json` | 当天的结果：`report_date`、`close`、`prev_date`、`prev_close`、`change_pct`、`valuation_score`、`sma_score`，外加什么时候拿到的、失败原因 |
| `<日期>.log` | 每次运行的命令行、退出码、输出尾部。更新失败时先看这里 |
| `run.lock` | 正在跑时存在 |

## 安装

本包是纯 JS，不需要构建。

在 dsh 的 Web 界面里：左栏「插件」→「添加插件」→ 填本目录的绝对路径 → 安装 → 立即启用。然后运行一次 `scripts/init-inbox.sh` 建好消息目录。

或者用命令行（`<profile>` 换成你启动 dsh 用的 profile 名）：

```sh
dsh plugin --profile <profile> add /绝对路径/dsh-plugin-control-panel
```

本地目录是链接安装，改了文件不用重装，但要重启 dsh 才会加载新的 JS。

## 目录

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle` 声明这是一个组合包，`dsh.client` 声明浏览器半侧 |
| `cordis.patch.yml` | 往 profile 里插入本插件的一行 |
| `index.js` | Host 半：在 `/api/control-panel.*` 下注册消息的五条路由、备忘的四条路由、今日建议的三条路由和纳指的两条路由，并启动今日建议和纳指的定时检查 |
| `inbox-store.js` | 读写 `inbox.jsonl` 和 `state.json` |
| `memo-store.js` | 读写 `todos.json` |
| `advice-store.js` | 读写 `advice/` 下的结果、日志、锁和已看标记；`nasdaq/` 也用它 |
| `advice-runner.js` | 今日建议：提示词、调用 claude / opencode、解析回答、定时，写好后写同步文件、调发信命令 |
| `nasdaq-runner.js` | 纳指那一行：定时运行 nasdaq_valuation，读它的 `latest_signals.json` 和日 K 缓存 |
| `scripts/init-inbox.sh` | 建消息目录 |
| `scripts/mail-me` | 经 QQ 邮箱 SMTP 发一封纯文本邮件，见[发到邮箱](#发到邮箱) |
| `client.js` | Client 半：左栏两个入口，「控制面板」和「今日」两页 |
| `locale/*.json`、`icon.svg` | 插件管理页里显示的名称、描述和图标 |

## 和 dsh 版本的兼容

dsh 的公共接口还在预稳定期，会变。这里有三道防线：

1. **版本闸门**：`peerDependencies` 里的 `@deepseek-ai/dsh` 范围是 `>=0.2.0-0 <0.3.0-0`。dsh 加载插件前会比对，不匹配就拒绝加载。升到 0.3 之前要先验证再放宽。
2. **依赖面收在一处**：`client.js` 文件头列出了它用到的全部宿主接口；Host 半只用 `ctx.connection.fetch.register`。宿主改了，只查这两处。
3. **出错可见**：面板有错误边界，宿主接口变了导致渲染失败时，会显示错误原因而不是一片空白。

## 测试

```sh
npm install        # 只装 react / react-dom，给测试用
npm test           # 存储单测；假宿主里渲染面板、走下发流程；消息、备忘、今日建议和纳指从文件到界面的联调；mail-me 只打印不发信的检查
```

两个探针要指向别的仓库的源码，平时不跑：

```sh
DSH_SRC=/path/to/deepseek-harness npm run test:host
SIMPLEAGENT_SRC=/path/to/SimpleAgent npm run test:simpleagent
```

- `test:host` 用 dsh 自己的代码检查：版本闸门放不放行、`dsh.client` 声明是否合法、四处 slot 注册和十四条路由的路径能否被接受。需要 Node 22.6 及以上。拉了新版 dsh 之后跑它。
- `test:simpleagent` 让 SimpleAgent 的 `store.py` 和本插件操作同一个目录，逐步比对两边看到的消息状态和备忘。需要 `python3`。只有和 SimpleAgent 共用目录时才用得上，它改了文件格式之后跑。

这些测试都不启动真实的 dsh，所以替代不了装进去点一遍。
