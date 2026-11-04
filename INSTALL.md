# 安装 self-evolve

这是一个 DSH 插件（Host 半 + Client 半），装好之后每个会话结束时会自己复盘，把经验写进记忆或技能。

## 1. 解压

```bash
unzip self-evolve-0.3.0.zip -d ~/plugins
# 得到 ~/plugins/self-evolve/
```

目录里应当有：`index.js`（Host）、`client.js`（Client）、`package.json`、`cordis.patch.yml`、`assets/pet/*.gif`、`locale/`。

## 2. 挂到某个 profile

以 profile 目录 `$DSH_HOME/profiles/desktop` 为例（其它 profile 换路径即可）。

**a. 加依赖**：编辑 `profiles/desktop/package.json`

```json
{
  "dependencies": {
    "@local/self-evolve": "link:/Users/you/plugins/self-evolve"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@local/self-evolve"
      ]
    }
  }
}
```

`bundles` 里那一行是必须的，插件才随 profile 加载。

**b. 建软链**

```bash
cd "$DSH_HOME/profiles/desktop"
pnpm install          # 有 pnpm 走这条
# 没有 pnpm 就直接建链：
ln -sfn ~/plugins/self-evolve node_modules/@local/self-evolve
```

**c. 配置（可选）**：在 `profiles/desktop/cordis.patch.yml` 里加一段覆盖。不加也能跑，走内置默认值。

```yaml
- id: self-evolve
  name: "@local/self-evolve"
  config:
    shellFailureThreshold: 3
    toolFailureThreshold: 2
    triggerOnLengthOnly: false
    chainSteps: 15
    scope: auto
    workflowMinSteps: 25
    workflowMinDistinctTools: 4
    maxRecordsPerTurn: 1
    decision:
      enabled: true
      shadow: true
      model: doubao-seed-2-1-lite-260915
      baseURL: https://ark.cn-beijing.volces.com/api/v1
      apiKey: ''            # 留空 = 用界面里配的 key，或读环境变量
      apiKeyEnv: A_API_KEY
      timeoutMs: 900
      worthThreshold: 0.5
      scopeMinConfidence: 0.6
  disabled: false
```

判定模型（火山方舟 System One）不是必需的：不配 key 时判定返回 degraded，插件照常写入（fail-open）。要开判定就在经验库 ⚙ 页里填 key，或写进 `apiKey`。

**d. 重载**：重启 `dsh web`，然后刷新页面。

## 3. 验证

```
设置 → 插件：列表里出现 self-evolve
页面右下角出现桌宠
点桌宠 → 打开经验库，四个页面（记忆 / 技能 / 判断日志 / 设置）都能进
```

命令行探一下路由：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'x-self-evolve: 1' \
  "http://127.0.0.1:62100/api/self-evolve/pet/idle.gif"
# 期望 200
```

## 4. 数据落在哪

| 内容 | 路径 |
|---|---|
| 项目记忆 | `<工作区>/AGENTS.md`（`<!-- self-evolve:begin -->` 区间内） |
| 全局记忆 | `$DSH_HOME/AGENTS.md` |
| 本插件写的技能 | `~/.agents/skills/<name>/SKILL.md` |
| 长经验详情 | `$DSH_HOME/self-evolve/details/` |
| 判定流水 | `$DSH_HOME/self-evolve/judgements.jsonl` |
| 最近一次沉淀 | `$DSH_HOME/self-evolve/last-record.json` |

插件只改自己那一段托管区间，不碰你手写的内容；自己写的 SKILL.md（没有归属标记）不会被接管。

## 5. 回归测试（可选）

```bash
cd self-evolve/test
pnpm install
pnpm test
```

`test-routes.mjs` 需要插件正在运行，默认打 `http://127.0.0.1:62100`；端口变了用 `SELF_EVOLVE_BASE=http://127.0.0.1:<端口>` 指定。
