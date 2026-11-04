# self-evolve 回归测试

三个独立脚本，各管一层，跑真实现场（不是 mock 出来的假通过）：

| 脚本 | 覆盖 | 依赖 |
|---|---|---|
| `test-routes.mjs` | 桌宠形象路由：7 个状态返回 GIF、穿越路径被挡、API 仍要求 `x-self-evolve` 头 | 需要插件在跑 |
| `test-pet.mjs` | 桌宠状态机：状态→GIF 映射、静置入睡、点击唤醒、图片失败退回 SVG | jsdom + react |
| `test-library.mjs` | 经验库面板：首页数据、记忆/技能/设置/判断日志四个页面与返回 | jsdom + react |

```bash
cd test && pnpm install && pnpm test
```

`test-routes.mjs` 默认打 `http://127.0.0.1:62771`，换端口用
`SELF_EVOLVE_BASE=http://127.0.0.1:xxxx node test-routes.mjs`。

注意：面板测试里的 fetch 桩必须在**加载 client.js 之前**装进 `window`——客户端在模块初始化时就会抓一次 fetch，晚装等于没装。
