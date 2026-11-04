# 自我进化 🧬 (self-evolve)

DeepSeek Harness 插件：**任务完整结束后**自动复盘一次，把值得记的经验写进本地记忆和可复用技能，右下角的桌宠会播报这次进化。

- **不中途打断**——复盘只在任务结束时发生，对话流里一个字不多
- **默认不写**——只有「会让未来的你做得不一样」的经验才落盘，一次最多一条
- **数据全在本地**——记忆进 `AGENTS.md`，技能进 `~/.agents/skills/`；你手写的内容永远不会被覆盖

## 效果一览

**桌宠**：会话页右下角常驻；右上角紫色角标显示本会话累计进化次数。

![桌宠状态一览](pet-preview.png)

**右下角小卡**：同一会话第 2 次进化起，只以小卡形式自动出现，不打断阅读。

![右下角小卡](pet-bubble-preview.png)

**dock 卡片的三个阶段**：沉淀中（burst）→ 完成瞬间（flash）→ 已落定（settled）。

![dock 卡片](dock-preview.png)

**台账**：最近一次沉淀的触发原因、判定值、写入落点与本会话历史。

![台账](ledger-preview.png)

**经验库**：点桌宠进入——记忆 / 技能 / 决策统计、最近的改动、待应用提案（看 diff 后应用）、孟婆汤。

![经验库](library-preview.png)

**整屏卡片**：点开小卡后的完整沉淀报告，可一键查看全部经验。

![整屏卡片](scene-settled.png)

## 它解决什么问题

1. **越走越远**：一个任务连了十几二十次工具调用，方向早就偏了，但每一步看起来都「合理」。
2. **对着报错硬撞**：同一条 `bash` 命令换个写法再试，连续失败，却始终没换思路。
3. **流程白白流失**：一条多步骤流程好不容易走通了，下次同类任务又从头摸一遍。

## 安装

三个步骤，详见 [INSTALL.md](INSTALL.md)：

1. 把本目录放到一个固定位置（如 `~/plugins/self-evolve/`）；
2. 在 profile 的 `package.json` 里把 `@local/self-evolve` 以 `link:` 方式加进 `dependencies` 和 `dsh.profile.bundles`；
3. `pnpm install`（或手动建软链）后重启 DSH。

## 日常用法

装好后**不需要你做任何事**：

- 平时它完全隐身，只在任务结束时于右下角弹一次小卡；
- **点桌宠**打开经验库：看记忆 / 技能、应用或丢弃技能提案、就地编辑删除、用「孟婆汤」批量清空；
- **对模型说「记住……」**会直接触发一次沉淀（不必等失败或长链路）；
- 进阶：给判定模型配一个 key（不配也能用，判定降级为直接写入），详见下文 [配置](#配置)；
- 数据全部落在本地：项目记忆在工作区 `AGENTS.md`、全局记忆在 `$DSH_HOME/AGENTS.md`、技能在 `~/.agents/skills/`，落点明细见 [INSTALL.md](INSTALL.md)。

模型侧提供三个工具（`self_evolve_record` / `self_evolve_propose` / `self_evolve_status`），见下文 [两个工具](#两个工具)。

## 数据落在哪

| 内容 | 路径 |
|---|---|
| 项目记忆 | `<工作区>/AGENTS.md`（`<!-- self-evolve:begin -->` 托管区间内） |
| 全局记忆 | `$DSH_HOME/AGENTS.md` |
| 自建技能 | `~/.agents/skills/<name>/SKILL.md` |
| 长经验详情 | `$DSH_HOME/self-evolve/details/` |
| 判定流水 | `$DSH_HOME/self-evolve/judgements.jsonl` |

## 已知限制

- 计数按 agent 存在内存里（`WeakMap`），进程重启或会话切换后从零开始；这是「本轮是否跑偏」的指标，不需要持久化。
- 全局写入依赖审批通道。如果当前组合没有可用的审批回答者（approval answerer），越界写入会 fail closed 并返回 `FS_SANDBOX_DENIED` 说明；此时只能把 `scope` 切回 `workspace`，或显式把文件策略设为 `danger-full-access`。
- 「新工作流」是启发式判断（步数 + 工具种类），不做语义理解：一次长链路但确实是同一件事的重复劳动，可能被判成工作流。提示文案里已经要求模型在「一次性流程」时跳过并说明，所以误判的代价是一次无害的自我说明。
- 技能被写坏（frontmatter 不合法）时会被 `dsh-skill-filesystem` 忽略并在日志里告警；本插件只会追加合法内容，不会修改已有 frontmatter。
- 以 `link:` 方式安装时，改完 `index.js` 未必立即热生效。验证前先调 `self_evolve_status`，确认 `environment` 字段存在——没有该字段说明跑的还是旧代码，需要在插件页把该插件关掉再打开。
- Client 半（动画）的加载时机与 Host 半不同：`dsh.client` 的变更要**重新安装 bundle 并刷新页面**才生效。只重载插件不足以让新注册的 slot 出现。
- 复盘发生在 `agent/turn-stopping`，若用户中途取消本轮，这一轮不会被复盘——这符合「任务完成后才进化」的语义，但意味着被取消的工作不会沉淀经验。

## 深入设计

触发条件与阈值、进化动画的实现、记忆两档与去重合并、经验库、自我优化提案、判定模型、配置全表、设计取舍与验证方法，都在 **[DESIGN.md](DESIGN.md)**。
