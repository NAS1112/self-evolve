/**
 * 自我进化 🧬 — Client 半。
 *
 * 展示位置是 `conversation.chat.turnTail`（完成的 Turn 操作行之前），也就是
 * **本轮所有输出结束之后**：先让用户把任务结果读完，再播进化动画，最后留下
 * 一块浅色的经验台账（本轮沉淀了什么 + 累计积累了多少）。
 *
 * 数据不靠组件间传递，而是直接从会话快照里读 `self_evolve_record` 的工具结果：
 *   1. 归属准确——扫描全快照只取**最新**的那一条记录；
 *   2. 不怕刷新——记录在会话日志里，刷新后落定的浅色台账还在；
 *   3. 不用信箱——早先「工具节点投递、轮尾取走」的信箱方案有真 bug：每个历史
 *      turn 的轮尾都监听同一个信箱，最早挂载的会把数据抢走，动画就演在旧 turn
 *      的位置（往往在屏幕外），用户什么都看不到。
 *
 * `self_evolve_record` 自己的工具行注册成返回 null 的空视图：它是内部记账
 * 工具，在对话流里摆一张原始 JSON 卡片只是噪声。
 */
window.__ModuleLoader__.load({
  id: '@local/self-evolve',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;

    /**
     * 「完成」那一下的停留时长（毫秒）。沉淀中**不计时**——从 🧬 标记出现一直演到
     * 经验真正落盘，写多久演多久，所以这里只留闪一下的时长。
     */
    const FLASH_MS = 900;
    /**
     * 这条 last-record 该不该演庆祝。
     *
     * 纯函数，只比时间戳、不碰存储：「领记录」（写 seen）必须由真正演动画的那一处做，
     * 否则第二个读者看到的永远是「已经演过」，于是记完了却没有任何反馈。
     * 早于页面加载的旧记录不演（避免每次刷新都跳），但给 60 秒宽限——
     * 刚沉淀完就刷新页面很常见，这一条仍然要演。
     */
    function shouldFlash(record, seen, bootAt) {
      if (record === undefined || record === null || typeof record.atMs !== 'number') return false;
      if (record.atMs <= (typeof seen === 'number' ? seen : 0)) return false;
      if (record.atMs < bootAt - 60000) return false;
      return true;
    }

    /** 页面加载时刻：早于它的记录属于历史，直接落定，不重播动画。 */
    const BOOT_AT = Date.now();
    /** 只关心这一个工具的结果。 */
    const TOOL_NAME = 'self_evolve_record';
    /** 注入消息的来源标签：用来认出「进化触发标记」这条消息。 */
    const SOURCE_KIND = 'self-evolve';

    /** 主题 token 取不到时的兜底色。 */
    const FALLBACK = {
      accent: '#3b82f6',
      text: 'currentColor',
      border: 'rgba(127, 127, 127, 0.35)',
    };

    // -----------------------------------------------------------------------
    // 数据：从会话快照读出这一条记录
    // -----------------------------------------------------------------------

    /**
     * 从结果 JSON 文本里读出这次写了什么。
     *
     * 工具结果的正文在节点的 content 文本块里，是 Host `renderJson` 序列化出来的
     * JSON 字符串——所以要先拼文本再 parse。读不到就返回 undefined，卡片不渲染：
     * 宁可不显示，也不要显示错的信息。
     */
    function outcomeFromText(text) {
      if (typeof text !== 'string' || text.length === 0) return undefined;

      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return undefined;
      }
      if (value === null || typeof value !== 'object' || value.ok !== true) return undefined;
      // 演练模式没有真正落盘，不该播放「已进化」动画。
      if (value.dryRun === true) return undefined;

      const written = Array.isArray(value.written) ? value.written : [];
      // 纯去重（action === 'unchanged'）说明什么都没新增，不值得庆祝。
      const fresh = written.filter((w) => w && w.action !== 'unchanged');
      if (fresh.length === 0) return undefined;

      const entries = fresh.map((w) => ({
        kind: w.kind,
        title: typeof w.title === 'string' && w.title.length > 0 ? w.title : '',
        path: typeof w.path === 'string' ? w.path : '',
        action: typeof w.action === 'string' ? w.action : '',
        // 上限淘汰的明细：界面要说清「哪几条被挪走了」。
        evicted: Array.isArray(w.evicted)
          ? w.evicted.filter((item) => item !== null && typeof item === 'object' && typeof item.title === 'string')
            .map((item) => ({ title: item.title, bytes: typeof item.bytes === 'number' ? item.bytes : 0 }))
          : [],
        archivePath: typeof w.archivePath === 'string' ? w.archivePath : '',
        // 为什么被挪走：取代 / 满 / 超字数。文案要说对，否则用户以为「满了」。
        evictedBy: typeof w.evictedBy === 'string' ? w.evictedBy : '',
        // 长经验被拆成「结论 + 指引」时，指引指向的详情文件（没有就是空串）。
        detailPath: typeof w.detailPath === 'string' ? w.detailPath : '',
        // 技能：证明这次是「优化已有技能」还是「新建」。
        skillName: typeof w.skillName === 'string' ? w.skillName : '',
        previousEntries: typeof w.previousEntries === 'number' ? w.previousEntries : undefined,
        entries: typeof w.entries === 'number' ? w.entries : undefined,
      }));

      const stats = value.stats !== null && typeof value.stats === 'object' ? value.stats : undefined;
      // 为什么沉淀：Host 在「就绪那一刻」拍的快照。
      const rawTrigger = value.trigger !== null && typeof value.trigger === 'object' ? value.trigger : undefined;
      const trigger = rawTrigger === undefined ? undefined : {
        reasons: Array.isArray(rawTrigger.reasons) ? rawTrigger.reasons.filter((r) => typeof r === 'string') : [],
        steps: typeof rawTrigger.steps === 'number' ? rawTrigger.steps : undefined,
        distinctTools: typeof rawTrigger.distinctTools === 'number' ? rawTrigger.distinctTools : undefined,
        shellFailures: typeof rawTrigger.shellFailures === 'number' ? rawTrigger.shellFailures : undefined,
        toolFailures: typeof rawTrigger.toolFailures === 'number' ? rawTrigger.toolFailures : undefined,
      };

      // 判定模型的结论：用来回答「机器觉得这条值不值得」。
      const rawJudge = value.judgement !== null && typeof value.judgement === 'object' ? value.judgement : undefined;
      const judgement = rawJudge === undefined ? undefined : {
        verdict: typeof rawJudge.verdict === 'string' ? rawJudge.verdict : '',
        reason: typeof rawJudge.reason === 'string' ? rawJudge.reason : '',
        worth: typeof rawJudge.worth === 'number' ? rawJudge.worth : undefined,
        scope: typeof rawJudge.scope === 'string' ? rawJudge.scope : '',
        confidence: typeof rawJudge.confidence === 'number' ? rawJudge.confidence : undefined,
        enforced: rawJudge.enforced === true,
        ms: typeof rawJudge.ms === 'number' ? rawJudge.ms : undefined,
      };

      return {
        memory: entries.filter((e) => e.kind === 'memory').length,
        skill: entries.filter((e) => e.kind === 'skill').length,
        entries,
        judgement,
        // 累计积累量（Host 写入后统计；老记录没有这个字段）。
        trigger,
        total: stats === undefined ? undefined : {
          memory: typeof stats.memoryEntries === 'number' ? stats.memoryEntries : undefined,
          memoryLimit: typeof stats.memoryLimit === 'number' ? stats.memoryLimit : undefined,
          skills: typeof stats.skills === 'number' ? stats.skills : undefined,
          skillsTotal: typeof stats.skillsTotal === 'number' ? stats.skillsTotal : undefined,
        },
        // 标识这一批结果（类型 + 路径 + 动作 + 标题），用作 React key。
        signature: entries.map((e) => `${e.kind}:${e.path}:${e.action}:${e.title}`).join('|'),
      };
    }

    /**
     * 诊断选择器：把「桥到底读到了什么」压成一个**字符串**（必须是原始值，
     * 否则 useChat 的 selector 每次都返回新对象，React 会无限重渲染）。
     *
     * 形如 `n=42 c=7 s=1 r=1 e=0`：
     *   n 扫描到的节点数、c tool-call 节点数、s 名字是 self_evolve_record 的调用数、
     *   r 已有结果根的、e 其中 isError 的。
     * 这五个数字能一眼分出「快照读不到 / 节点形状不符 / 结果被判错」。
     */
    function selectDiag(snapshot) {
      let nodes = 0;
      let calls = 0;
      let named = 0;
      let results = 0;
      let errored = 0;
      forEachNode(snapshot, (node) => {
        nodes += 1;
        if (node === undefined || node === null) return;
        if (node.kind !== 'tool-call') return;
        calls += 1;
        const root = node.data?.root;
        if (root === undefined || root === null) return;
        const name = typeof root.name === 'string' && root.name.length > 0
          ? root.name
          : (root.call && typeof root.call.name === 'string' ? root.call.name : '');
        if (name === TOOL_NAME) named += 1;
        if (root.kind === 'tool-result') {
          results += 1;
          if (root.isError === true) errored += 1;
        }
      });
      return `n=${nodes} c=${calls} s=${named} r=${results} e=${errored}`;
    }

    /**
     * 全局扫描：会话里**最近一次**成功写入了经验的结果根（不看轮次）。
     *
     * 这里是刻意不依赖 turn / location / timeline 的：那套语义一旦对不上，
     * 结果就是「什么都没发生」而且毫无提示。节点形状只有一种，读它最稳。
     */
    function selectLatestRecordGlobal(snapshot) {
      let best;
      let bestSeq = -1;
      forEachNode(snapshot, (node) => {
        const root = recordRootOf(node);
        if (root === undefined) return;
        const seq = typeof root.seq === 'number' ? root.seq : 0;
        if (seq > bestSeq) {
          best = root;
          bestSeq = seq;
        }
      });
      return best;
    }

    /**
     * 桥的展示阶段（纯函数，便于单测）。
     *
     * `running` 优先：**整屏**不许盖住正在流式输出的回答。模型是在给出最终回答
     * *之前*调用记录工具，如果一有记录就弹整屏，动画会压住答案——正是「任务结果
     * 还没出来就弹进化」的老问题。
     *
     * 但小卡不遮正文，所以它可以在本轮里就把「沉淀中 → 完成」这条线走完：
     * 写入中显示 waiting，写完后立刻接 fresh（闪一下再落定），中间不断档。
     * 整屏仍然等本轮结束。
     *
     * @returns 'none' | 'waiting' | 'fresh' | 'settled'
     */
    function bridgeView(input) {
      const running = input.running;
      if (running === true) {
        if (input.dockable !== true) return 'none';
        // 写完立刻接上「完成」：不能让小卡在工具返回后突然消失，
        // 那正是「沉淀动画简单结束」——动画应该衔接，而不是断掉。
        if (input.hasOutcome === true && input.fresh === true) return 'fresh';
        if (input.writing === true) return 'waiting';
        return 'none';
      }
      if (input.writing === true) return 'waiting';
      if (input.hasOutcome === true && input.fresh === true) return 'fresh';
      if (input.hasRecord === true) return 'settled';
      return 'none';
    }

    /**
     * 本会话的进化历史（按 seq 从新到旧）。
     *
     * `useChat` 要求选择器返回**值稳定**的东西，所以这个函数只给内部用：
     * 对外暴露的是 `selectHistorySignature`——返回一串 seq，列表本身放在缓存里。
     */
    const historyCache = { list: [] };

    function collectRecordList(snapshot) {
      const list = [];
      forEachNode(snapshot, (node) => {
        const root = recordRootOf(node);
        if (root === undefined) return;
        const outcome = outcomeFromText(resultText(root));
        if (outcome === undefined) return;
        list.push({
          seq: typeof root.seq === 'number' ? root.seq : 0,
          time: asTime(root.time),
          count: outcome.entries.length,
          tag: triggerTag(outcome.trigger),
          tagTitle: triggerTagTitle(outcome.trigger),
          titles: outcome.entries.map((entry) => entry.title).filter(Boolean),
          kinds: outcome.entries.map((entry) => entry.kind),
        });
      });
      // seq 大的是新的；seq 缺失时按插入顺序兜底（后出现的更新）。
      list.sort((a, b) => (b.seq - a.seq) || 0);
      return list;
    }

    /** 历史列表的稳定签名（seq 串），顺带把列表写进缓存。 */
    function selectHistorySignature(snapshot) {
      const list = collectRecordList(snapshot);
      historyCache.list = list;
      return list.map((item) => String(item.seq)).join(',');
    }

    /** 沉淀中：在飞那次调用的标题（模型传进 args 的 title）。 */
    function selectPendingTitle(snapshot) {
      let title = '';
      forEachNode(snapshot, (node) => {
        if (title !== '') return;
        if (node === undefined || node === null || node.kind !== 'tool-call') return;
        const root = node.data?.root;
        if (root === undefined || root === null || root.kind === 'tool-result') return;
        const name = typeof root.name === 'string' ? root.name : '';
        if (name !== TOOL_NAME) return;
        const args = root.args;
        if (args !== null && typeof args === 'object' && typeof args.title === 'string') {
          title = args.title.slice(0, 60);
        }
      });
      return title;
    }

    /** 沉淀中：这次要写哪几样（memory / skill / both）。 */
    function selectPendingKind(snapshot) {
      let kind = '';
      forEachNode(snapshot, (node) => {
        if (kind !== '') return;
        if (node === undefined || node === null || node.kind !== 'tool-call') return;
        const root = node.data?.root;
        if (root === undefined || root === null || root.kind === 'tool-result') return;
        const name = typeof root.name === 'string' ? root.name : '';
        if (name !== TOOL_NAME) return;
        const args = root.args;
        if (args !== null && typeof args === 'object' && typeof args.kind === 'string') kind = args.kind;
      });
      return kind;
    }

    /**
     * 全局扫描：**本会话**（当前快照）里成功落盘的进化次数。
     *
     * 这就是「同一个会话多次进化」的累计数：每次成功的 `self_evolve_record`
     * 留下一个结果根，数一遍即可。返回数字——`useChat` 要求选择器值稳定。
     */
    function selectSessionCount(snapshot) {
      let count = 0;
      forEachNode(snapshot, (node) => {
        const root = recordRootOf(node);
        if (root === undefined) return;
        if (root.isError === true) return;
        // 演练（dry_run）和纯去重（unchanged）都没有真的写进任何东西，
        // 不能算「进化了一次」——否则次数会被自检和重复记录灌水。
        if (outcomeFromText(resultText(root)) === undefined) return;
        count += 1;
      });
      return count;
    }

    /**
     * 全局扫描：此刻是否有一个 `self_evolve_record` 调用**还没出结果**。
     *
     * 这是动画的真正起点——工具一开始执行（用户点完确认那一刻）就该开始演，
     * 而不是等结果落盘后才补一段。
     */
    function selectWritingGlobal(snapshot) {
      let writing = false;
      forEachNode(snapshot, (node) => {
        if (writing === true) return;
        if (node === undefined || node === null) return;
        if (node.kind !== 'tool-call') return;
        const root = node.data?.root;
        if (root !== undefined && root !== null && root.kind === 'tool-result') return;
        const name = typeof root?.name === 'string' && root.name.length > 0
          ? root.name
          : (root?.call && typeof root.call.name === 'string' ? root.call.name : '');
        if (name === TOOL_NAME) writing = true;
      });
      return writing;
    }

    /** 把事件时间归一成毫秒；读不出返回 0（按历史处理，不重播动画）。 */
    function asTime(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return 0;
    }

    /**
     * 本轮里「进化触发标记」（🧬）出现了没有。
     *
     * 这就是动画的**起点**：标记一出现说明模型已经开始复盘/落盘，动画立即开始，
     * 而不是等落盘完成后再回放一段固定时长的过场。返回标记节点的 anchorSeq（稳定数字）。
     */
    function selectMarker(turn) {
      return (snapshot) => {
        const keys = snapshot?.locations?.getTurn?.(turn);
        if (!Array.isArray(keys)) return undefined;
        for (const key of keys) {
          const node = snapshot.nodes?.get?.(key);
          if (node === undefined || node === null) continue;
          if (node.kind !== 'user' && node.kind !== 'steering') continue;
          const source = node.data?.source;
          if (source !== undefined && source !== null && source.kind === SOURCE_KIND) return node.anchorSeq ?? 0;
          const blocks = Array.isArray(node.data?.content) ? node.data.content : [];
          for (const block of blocks) {
            if (typeof block?.text === 'string' && block.text.includes('🧬')) return node.anchorSeq ?? 0;
          }
        }
        return undefined;
      };
    }

    /** 本轮是否正在写这条经验：`self_evolve_record` 已发起、结果还没回来。 */
    function selectWriting(turn) {
      return (snapshot) => {
        const keys = snapshot?.locations?.getTurn?.(turn);
        if (!Array.isArray(keys)) return false;
        for (const key of keys) {
          const node = snapshot.nodes?.get?.(key);
          if (node === undefined || node === null || node.kind !== 'tool-call') continue;
          const root = node.data?.root;
          if (root !== undefined && root !== null && root.kind === 'tool-result') continue;
          const name = typeof root?.name === 'string' && root.name.length > 0
            ? root.name
            : (root?.call && root.call.name) ?? '';
          if (name === TOOL_NAME) return true;
        }
        return false;
      };
    }

    /** 把结果节点正文拼成 JSON 文本。兼容 text 块和已解析的 value/json 块两种形状。 */
    function resultText(root) {
      const blocks = Array.isArray(root?.content) ? root.content : [];
      return blocks
        .map((b) => {
          if (!b || typeof b !== 'object') return '';
          if (typeof b.text === 'string') return b.text;
          // 有些投影会把结果挂成已解析对象而不是文本块。
          for (const key of ['value', 'json', 'data']) {
            if (b[key] !== undefined && b[key] !== null && typeof b[key] === 'object') {
              try { return JSON.stringify(b[key]); } catch { return ''; }
            }
          }
          return '';
        })
        .join('');
    }

    /** 从工具节点里取「已完结的结果根部」；不是 self_evolve_record 的成功结果就返回 undefined。 */
    function recordRootOf(node) {
      if (node === undefined || node === null || node.kind !== 'tool-call') return undefined;
      const root = node.data?.root;
      if (root === undefined || root === null || root.kind !== 'tool-result') return undefined;
      if (root.isError === true) return undefined;

      const name = typeof root.name === 'string' && root.name.length > 0
        ? root.name
        : (root.call && typeof root.call.name === 'string' ? root.call.name : '');

      // 主判据是工具名；名字读不到时退一步看正文形状（本工具的结果是固定 JSON），
      // 这样即使宿主改了投影字段也不会整块消失。
      if (name === TOOL_NAME) return root;
      if (name !== '') return undefined;
      const parsed = outcomeFromText(resultText(root));
      return parsed === undefined ? undefined : root;
    }

    /** 遍历快照里的所有节点：优先用 ordered keys，退路用 Map 迭代。 */
    function forEachNode(snapshot, visit) {
      const nodes = snapshot?.nodes;
      if (nodes === undefined || nodes === null || typeof nodes.get !== 'function') return;
      const order = Array.isArray(snapshot.order) ? snapshot.order : undefined;
      if (order !== undefined) {
        for (const key of order) visit(nodes.get(key));
        return;
      }
      if (typeof nodes.values === 'function') {
        for (const node of nodes.values()) visit(node);
      }
    }

    /** 节点所属 turn 的号；读不到返回 undefined。 */
    function turnOfNode(node) {
      const located = node?.location;
      if (located === undefined || located === null) return undefined;
      if (typeof located.turn === 'number') return located.turn;
      if (typeof located.turn?.turn === 'number') return located.turn.turn;
      return undefined;
    }

    /**
     * 全快照里**最新**的一条记录（按事件 seq 取最大），返回 { root, turn }。
     *
     * 用全局最新而不是「本轮的记录」：记录可能落在更早的 turn 里（模型可以随时
     * 调用这个工具），而界面只该在对话末尾显示一次台账。返回的是快照里的稳定
     * 引用，selector 不会因为每次返回新对象而无限重渲染。
     */
    function selectLatestRecord(turn) {
      return (snapshot) => {
        let best;
        let bestSeq = -1;
        forEachNode(snapshot, (node) => {
          const root = recordRootOf(node);
          if (root === undefined) return;
          const seq = typeof root.seq === 'number' ? root.seq : 0;
          if (seq > bestSeq) { best = root; bestSeq = seq; }
        });
        return best;
      };
    }

    /** 最新那条记录所属的 turn 号；读不到返回 undefined。 */
    function selectRecordTurn(turn) {
      return (snapshot) => {
        let best;
        let bestSeq = -1;
        let bestTurn;
        forEachNode(snapshot, (node) => {
          const root = recordRootOf(node);
          if (root === undefined) return;
          const seq = typeof root.seq === 'number' ? root.seq : 0;
          if (seq > bestSeq) { best = node; bestSeq = seq; bestTurn = turnOfNode(node); }
        });
        return best === undefined ? undefined : bestTurn;
      };
    }

    /**
     * 这一轮是否是时间线上的**最后一轮**。
     *
     * 卡片只挂在最后一轮的轮尾：任务结束 → 台账出现在输出末尾；之后开始新任务，
     * 台账跟到新的末尾，而不是在中途的旧 turn 里冒出来。
     */
    function selectLastTurn(turn) {
      return (snapshot) => {
        const order = snapshot?.timeline?.turnOrder;
        if (!Array.isArray(order) || order.length === 0) return true; // 时间线不可读时不拦
        return order[order.length - 1] === turn;
      };
    }

    /**
     * 这一轮是否已经收尾。宿主在 turn 进行中也会渲染轮尾节点（`closing === null`
     * 的分支），所以必须自己判断：只有收尾之后才允许播动画——这正是
     * 「任务结果输出后再触发」的落点。
     */
    function selectClosed(turn) {
      return (snapshot) => {
        if (snapshot === undefined || snapshot === null) return false;

        // 主判据：时间线里这一轮已经有 turn/end。`turns` 是 turn -> {start, end}。
        const end = snapshot.timeline?.turns?.get?.(turn)?.end;
        if (end !== undefined && end !== null) {
          // 「停下来等用户」的结束（提问 / 计划确认被阻塞）不是任务完成，
          // 不能在这里播进化——否则动画会插在任务结果前面。
          const kind = end.reason?.kind;
          return kind !== 'blocked';
        }

        // 退路：轮尾节点的 closing（宿主投影含轮尾节点时）。
        const keys = snapshot.locations?.getTurn?.(turn);
        if (!Array.isArray(keys)) return false;
        for (const key of keys) {
          const node = snapshot.nodes?.get?.(key);
          if (node === undefined || node === null || node.kind !== 'turn-tail') continue;
          const closing = node.data?.closing;
          return closing !== null && closing !== undefined;
        }
        return false;
      };
    }

    // -----------------------------------------------------------------------
    // 动画关键帧
    // -----------------------------------------------------------------------

    /**
     * 注入动画关键帧。
     *
     * 用组件内的 `<style>` 而不是往 document.head 塞标签：React 卸载这个组件时
     * 样式随之移除，不会在页面里留下孤儿规则。
     */
    /**
     * 进度环：用 SVG 的 stroke-dasharray 画，而不是给 div 加 border。
     *
     * 为什么不用 border：`border-top-color` 那条弧在圆角接缝处粗细不匀，
     * 小尺寸下看起来像一圈被压扁的椭圆——就是「不规整」的来源。
     * SVG 是真正的圆周描边，`pathLength=100` 让弧长可以按百分比写，
     * 端点用圆头，转起来任何一帧都是干净的一段弧。
     */
    let spinnerSeq = 0;
    function EvolveSpinner(props) {
      const size = props.size ?? 44;
      const stroke = props.stroke ?? 2.5;
      const track = props.track ?? 'rgba(124,58,237,0.16)';
      // 描边默认**实色**：渐变是跟着元素一起转的，转起来就像一块颜色在绕圈，
      // 视觉上很不安分。实色才是标准加载环。
      const arc = props.arc ?? '#7c3aed';
      const spin = props.spin ?? 1400;
      const reverse = props.reverse === true;
      const breathe = props.breathe !== false;
      const radius = size / 2 - stroke / 2 - 1;
      const center = size / 2;
      return h('svg', {
        width: size, height: size, viewBox: `0 0 ${size} ${size}`,
        style: { display: 'block', overflow: 'visible' },
      },
        props.track === null
          ? null
          : h('circle', {
            cx: center, cy: center, r: radius,
            fill: 'none', stroke: track, strokeWidth: stroke,
          }),
        h('circle', {
          cx: center, cy: center, r: radius,
          fill: 'none',
          stroke: arc,
          strokeWidth: stroke,
          strokeLinecap: 'round',
          pathLength: 100,
          strokeDasharray: props.dashMode === 'sm' ? '5 100' : '8 100',
          style: {
            transformOrigin: '50% 50%',
            animation: [
              `self-evolve-ring-spin ${spin}ms linear infinite${reverse ? ' reverse' : ''}`,
              breathe ? `${props.dashMode === 'sm' ? 'self-evolve-dash-sm' : 'self-evolve-dash'} ${spin}ms ease-in-out infinite` : '',
            ].filter(Boolean).join(', '),
          },
        }),
        props.arc === undefined
          ? null
          : h('defs', null,
            h('linearGradient', { id: props.gradientId ?? 'self-evolve-ring-grad', x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
              h('stop', { offset: '0%', stopColor: '#3b82f6' }),
              h('stop', { offset: '100%', stopColor: '#7c3aed' }))));
    }

    const PET_POS_KEY = 'self-evolve:pet-pos';
    const PET_HIDE_KEY = 'self-evolve:pet-hidden';
    const DEFAULT_PET_POS = { right: 26, bottom: 108 };

    function clampPet(value, min, max) {
      if (!Number.isFinite(value)) return min;
      return Math.min(Math.max(Math.round(value), min), Math.max(min, max));
    }

    function viewportSize() {
      const win = typeof window === 'undefined' ? undefined : window;
      if (win === undefined) return { width: 1280, height: 800 };
      return {
        width: typeof win.innerWidth === 'number' ? win.innerWidth : 1280,
        height: typeof win.innerHeight === 'number' ? win.innerHeight : 800,
      };
    }

    const PANEL_POS_KEY = 'self-evolve:panel-pos';
    const DEFAULT_PANEL_POS = { right: 20, bottom: 216 };

    /**
     * 拖一块固定定位的面板。
     *
     * 以前用 `setPointerCapture` + 元素上的 onPointerMove：capture 一旦没生效（老内核、
     * 合成事件里 pointerId 缺失、元素在拖拽中被重建），指针一离开标题栏就再也不更新，
     * 用户看到的就是「拖不动」。改成**挂 window 监听**，与元素是否捕获无关。
     */
    /**
     * 原生拖拽钩子：在 **document 捕获阶段** 监听 pointerdown/mousedown。
     *
     * 为什么不用 React 的 onPointerDown：宿主（或上层某个容器）一旦在捕获/冒泡里
     * stopPropagation，合成事件就到不了我们这层，表现为「按钮能点、就是拖不动」。
     * 捕获阶段先于任何元素上的处理函数，除非有人把 document 也拦了。
     */
    function usePanelDrag(pos, setPos, save, onActive) {
      const nodeRef = useRef(undefined);
      const posRef = useRef(pos);
      posRef.current = pos;
      useEffect(() => {
        const node = nodeRef.current;
        if (node === undefined || node === null) return undefined;
        const down = (event) => {
          const target = event.target;
          if (target === null || target === undefined) return;
          if (node.contains(target) !== true) return;
          const tag = target.tagName === undefined ? '' : String(target.tagName).toLowerCase();
          if (tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'a') return;
          if (typeof event.button === 'number' && event.button !== 0) return;
          if (typeof event.preventDefault === 'function') event.preventDefault();
          if (typeof onActive === 'function') onActive(true);
          trackPanelDrag(event, { ...posRef.current }, (next) => setPos(next), (last, moved) => {
            if (typeof onActive === 'function') onActive(false);
            if (moved) save(last);
          });
        };
        document.addEventListener('pointerdown', down, true);
        document.addEventListener('mousedown', down, true);
        return () => {
          document.removeEventListener('pointerdown', down, true);
          document.removeEventListener('mousedown', down, true);
        };
      }, [onActive, save, setPos]);
      return nodeRef;
    }

    let dragOwner = undefined;

    function trackPanelDrag(event, base, apply, done) {
      if (dragOwner !== undefined) return;
      dragOwner = event;
      const release = () => {
        dragOwner = undefined;
      };
      const startX = event.clientX;
      const startY = event.clientY;
      let last = { right: base.right, bottom: base.bottom };
      let moved = false;
      const move = (moveEvent) => {
        if (typeof moveEvent.clientX !== 'number' || typeof moveEvent.clientY !== 'number') return;
        const dx = startX - moveEvent.clientX;
        const dy = startY - moveEvent.clientY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        last = {
          right: clampPet(base.right + dx, 8, viewportSize().width - 400),
          bottom: clampPet(base.bottom + dy, 8, viewportSize().height - 180),
        };
        apply(last);
      };
      const moveTypes = ['pointermove', 'mousemove'];
      const stopTypes = ['pointerup', 'mouseup', 'pointercancel', 'blur'];
      const finish = () => {
        moveTypes.forEach((type) => window.removeEventListener(type, move, true));
        stopTypes.forEach((type) => window.removeEventListener(type, finish, true));
        release();
        done(last, moved);
      };
      // 两套事件都挂：有的容器会吞掉 pointer 系列（自己做了 capture），鼠标事件仍是通的。
      moveTypes.forEach((type) => window.addEventListener(type, move, true));
      stopTypes.forEach((type) => window.addEventListener(type, finish, true));
    }

    function loadPanelPos() {
      try {
        const raw = window.localStorage.getItem(PANEL_POS_KEY);
        if (raw === null) return DEFAULT_PANEL_POS;
        const parsed = JSON.parse(raw);
        return {
          right: clampPet(parsed.right, 8, viewportSize().width - 400),
          bottom: clampPet(parsed.bottom, 8, viewportSize().height - 180),
        };
      } catch {
        return DEFAULT_PANEL_POS;
      }
    }

    function savePanelPos(pos) {
      try {
        window.localStorage.setItem(PANEL_POS_KEY, JSON.stringify(pos));
      } catch {
        // 存不下就回到默认位置。
      }
    }

    function loadPetPos() {
      try {
        const raw = window.localStorage.getItem(PET_POS_KEY);
        if (raw === null) return DEFAULT_PET_POS;
        const parsed = JSON.parse(raw);
        return {
          right: clampPet(parsed.right, 4, viewportSize().width - 110),
          bottom: clampPet(parsed.bottom, 4, viewportSize().height - 150),
        };
      } catch {
        return DEFAULT_PET_POS;
      }
    }

    function savePetPos(pos) {
      try {
        window.localStorage.setItem(PET_POS_KEY, JSON.stringify(pos));
      } catch {
        // 存不下就算了，下次回到默认位置。
      }
    }

    // 注意：**不持久化**。曾经把「藏起来」写进 localStorage，结果点过一次 × 之后
    // 刷新也回不来，用户看到的是「桌宠没了」——藏起来必须是能自己回来的临时状态。
    function forgetPetHiddenFlag() {
      try {
        window.localStorage.removeItem(PET_HIDE_KEY);
      } catch {
        // 没有 localStorage 就没什么可清的。
      }
    }

    function Keyframes() {
      return h('style', null, `
        @keyframes self-evolve-card-in {
          0%   { opacity: 0; transform: translateY(10px) scale(0.97); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes self-evolve-ring-spin { to { transform: rotate(360deg); } }
        /* 桌宠：呼吸、写字抖肩、高兴跳一下、眨眼 */
        /* 沉淀时从身上升起的小碎片：往上飘、轻微横移、淡出 */
        @keyframes self-evolve-pet-mote {
          0%   { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.6); }
          22%  { opacity: 1; }
          100% { opacity: 0; transform: translate3d(var(--se-dx, 6px), -46px, 0) scale(1); }
        }
        /* 进度弧的呼吸：整体亮度随节奏起伏，让人一眼看出「在动」 */
        @keyframes self-evolve-ring-pulse {
          0%, 100% { opacity: 0.55; }
          50%      { opacity: 1; }
        }
        @keyframes self-evolve-pet-bob {
          0%, 100% { transform: translateY(0) scale(1, 1); }
          50%      { transform: translateY(-3px) scale(1.02, 0.98); }
        }
        @keyframes self-evolve-pet-hop {
          0%   { transform: translateY(0) scale(1, 1); }
          28%  { transform: translateY(-16px) scale(0.94, 1.08); }
          58%  { transform: translateY(0) scale(1.10, 0.90); }
          78%  { transform: translateY(-4px) scale(0.99, 1.01); }
          100% { transform: translateY(0) scale(1, 1); }
        }
        @keyframes self-evolve-pet-scribble {
          0%, 100% { transform: rotate(-7deg); }
          50%      { transform: rotate(13deg); }
        }
        @keyframes self-evolve-pet-blink {
          0%, 93%, 100% { transform: scaleY(1); }
          96%           { transform: scaleY(0.08); }
        }
        @keyframes self-evolve-pet-in {
          from { opacity: 0; transform: translateY(12px) scale(0.9); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes self-evolve-bubble-in {
          from { opacity: 0; transform: translateY(6px) scale(0.96); }
          to   { opacity: 1; transform: none; }
        }
        /* 想事情：手在太阳穴上轻轻敲两下。 */
        @keyframes self-evolve-pet-tap {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          45%      { transform: translateY(-2px) rotate(-8deg); }
        }
        /* 想事情：灯泡一点点亮起来，不抢戏。 */
        @keyframes self-evolve-pet-bulb {
          0%, 100% { opacity: 0.45; transform: translateY(0) scale(0.94); }
          50%      { opacity: 1; transform: translateY(-3px) scale(1.06); }
        }
        /* 忘掉：缩小 + 冒烟，像被「啵」地擦掉。 */
        @keyframes self-evolve-pet-forget {
          0%   { opacity: 1; transform: none; }
          30%  { opacity: 0.55; transform: translateY(2px) scale(0.96); }
          100% { opacity: 0; transform: translateY(-10px) scale(1.06); }
        }
        @keyframes self-evolve-pet-stars {
          0%   { opacity: 0; transform: translateY(4px) scale(0.7); }
          35%  { opacity: 1; transform: translateY(-4px) scale(1.05); }
          100% { opacity: 0; transform: translateY(-14px) scale(0.9); }
        }
        .self-evolve-pet-hide { pointer-events: auto; }
        /* 右键动作菜单：整块不透明，避免和后面的聊天文本糊在一起 */
        .self-evolve-pet-menu-item:hover { background: rgba(124,58,237,0.10) !important; }
        .self-evolve-pet-menu { backdrop-filter: blur(8px); }
        .self-evolve-pet-wrap:hover .self-evolve-pet-hide { opacity: 1 !important; }
        /* 弧长自己伸缩 + 轻微追赶：这是「加载」的标准语汇，比一条固定弧干转更像在干活。 */
        @keyframes self-evolve-dash {
          0%   { stroke-dasharray: 8 100; stroke-dashoffset: 0; }
          50%  { stroke-dasharray: 58 100; stroke-dashoffset: -8; }
          100% { stroke-dasharray: 58 100; stroke-dashoffset: -62; }
        }
        /* 大环用小弧：半径一大，同样的百分比就成了一把扫帚。 */
        @keyframes self-evolve-dash-sm {
          0%   { stroke-dasharray: 5 100; stroke-dashoffset: 0; }
          50%  { stroke-dasharray: 26 100; stroke-dashoffset: -4; }
          100% { stroke-dasharray: 26 100; stroke-dashoffset: -30; }
        }
        @keyframes self-evolve-pulse {
          0%, 100% { box-shadow: 0 0 0 0 var(--se-glow-0, rgba(59,130,246,0.30)); }
          50%      { box-shadow: 0 0 0 10px var(--se-glow-1, rgba(59,130,246,0)); }
        }
        @keyframes self-evolve-sweep {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(220%); }
        }
        @keyframes self-evolve-pop {
          0%   { opacity: 0; transform: scale(0.6); }
          60%  { opacity: 1; transform: scale(1.12); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes self-evolve-dna {
          0%, 100% { transform: translateY(0) rotate(-8deg) scale(1); }
          50%      { transform: translateY(-6px) rotate(8deg) scale(1.06); }
        }
        @keyframes self-evolve-halo {
          0%   { transform: scale(0.82); opacity: 0.9; }
          70%  { transform: scale(1.18); opacity: 0; }
          100% { transform: scale(1.18); opacity: 0; }
        }
        @keyframes self-evolve-fade {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        /* 收起时淡出：突然消失会让人以为界面崩了。 */
        @keyframes self-evolve-fade-out {
          0%   { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(0.98); }
        }
        /* 完成瞬间的绿色扩散：原地亮一下，不换卡不重播。 */
        @keyframes self-evolve-flash-out {
          0%   { opacity: 1; }
          100% { opacity: 0; }
        }
        /* 右下角小卡：从右边滑进来 + 轻微过冲，余光就能注意到。 */
        @keyframes self-evolve-dock-in {
          0%   { opacity: 0; transform: translate3d(34px, 12px, 0) scale(0.94); }
          62%  { opacity: 1; transform: translate3d(0, 0, 0) scale(1.025); }
          100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
        }
        @keyframes self-evolve-dock-out {
          0%   { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
          100% { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.96); }
        }
        /* 呼吸光晕：不闪、不刺眼，但一直在动，所以余光抓得到。 */
        @keyframes self-evolve-glow {
          0%, 100% { box-shadow: 0 14px 38px rgba(0,0,0,0.26), 0 0 0 0 rgba(124,58,237,0.42); }
          55%      { box-shadow: 0 14px 38px rgba(0,0,0,0.26), 0 0 0 12px rgba(124,58,237,0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .self-evolve-anim * { animation: none !important; }
        }
      `);
    }

    // -----------------------------------------------------------------------
    // 三个阶段的视图
    // -----------------------------------------------------------------------

    const LABEL = { memory: '记忆', skill: '技能' };

    /** 一条台账行：类型徽章 + 标题 + 落点路径。 */
    function EntryRow(props) {
      const entry = props.entry;
      const dim = props.dim;
      return h('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '3px 0',
          fontSize: 12.5, lineHeight: 1.55, opacity: dim ? 0.5 : 1,
        },
      },
      h('span', {
        style: {
          flex: '0 0 auto', marginTop: 1, padding: '0 6px', borderRadius: 999,
          fontSize: 11, lineHeight: '18px', fontWeight: 600,
          color: entry.kind === 'skill' ? '#7c3aed' : '#2563eb',
          background: entry.kind === 'skill' ? 'rgba(124,58,237,0.12)' : 'rgba(37,99,235,0.12)',
        },
      }, LABEL[entry.kind] ?? entry.kind),
      h('span', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('span', { style: { fontWeight: 600 } }, entry.title || '（未命名经验）'),
        entry.path === '' ? null : h('span', {
          style: {
            display: 'block', fontSize: 11, opacity: 0.65, marginTop: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
          title: entry.path,
        }, entry.path),
        // 常驻记忆里只有一句话，全文在这（按需读取，不占每轮上下文）。
        entry.detailPath === undefined || entry.detailPath === ''
          ? null
          : h('span', {
            style: {
              display: 'block', fontSize: 10.5, opacity: 0.5, marginTop: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
            title: entry.detailPath,
          }, `全文：${entry.detailPath}`)));
    }

    /**
     * 累计一行：动画结束后显示「积累情况」。
     *
     * 数字优先取**实时**值（`live`）：工具结果里记的是落盘那一刻的快照，历史记录
     * 会一直带着当时的数字——早期版本还把技能目录总数当成自建数，于是老记录上
     * 永远显示「自建技能 38 个」。实时值拿不到（离线 / 老页面）才退回快照，并
     * 明确标注「记录时」，不再让快照冒充当前存量。
     */
    function Totals(props) {
      const live = props.live;
      const total = live === undefined ? props.total : live;
      if (total === undefined) return null;
      const isSnapshot = live === undefined && props.total !== undefined;
      const parts = [];
      if (typeof total.memory === 'number') {
        // 带上上限：用户一眼看出「还有多少余量 / 什么时候开始淘汰」。
        const limit = typeof total.memoryLimit === 'number' && total.memoryLimit > 0
          ? `/${total.memoryLimit}`
          : '';
        parts.push(`记忆 ${total.memory}${limit} 条`);
      }
      // 字节上限通常比条数上限先撞上（一条记忆动辄几百字），接近时把它显出来。
      if (typeof total.memoryBytes === 'number' && typeof total.memoryBytesLimit === 'number' && total.memoryBytesLimit > 0) {
        const ratio = total.memoryBytes / total.memoryBytesLimit;
        if (ratio >= 0.75) {
          parts.push(`${Math.round(total.memoryBytes / 1024)}/${Math.round(total.memoryBytesLimit / 1024)} KB（${Math.round(ratio * 100)}%）`);
        }
      }
      // 只报**本插件写的**技能：技能目录里还有用户自己的一堆，混在一起数就是虚高。
      if (typeof total.skills === 'number') parts.push(`自建技能 ${total.skills} 个`);
      // 本会话的进化次数：同一会话反复沉淀时，用户能看到「这是第几回」。
      if (typeof props.sessionCount === 'number' && props.sessionCount > 0) {
        parts.push(`本会话第 ${props.sessionCount} 次`);
      }
      if (parts.length === 0) return null;
      return h('div', {
        style: {
          marginTop: 8, paddingTop: 7, borderTop: '1px dashed ' + (props.border ?? FALLBACK.border),
          fontSize: 11.5, letterSpacing: 0.2, opacity: 0.72,
        },
      }, `累计沉淀 · ${parts.join(' · ')}${isSnapshot ? '（记录时）' : ''}`);
    }

    /** 经验库路由：见 Host 半 `registerLessonRoutes`。 */

    const API_ROOT = '/api/self-evolve';
    const LESSON_API = `${API_ROOT}/lessons`;
    /** 自定义头：跨站请求会被预检挡掉，等同源即可用。 */
    const LESSON_HEADERS = { 'x-self-evolve': '1' };

    /** 把异常翻译成一句能给用户看的话。 */
    function describeFailure(error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/failed to fetch|networkerror|load failed/i.test(text)) {
        return '拿不到经验库：Host 侧的路由没有响应（插件可能刚重载过，刷新页面再试）。';
      }
      return text;
    }

    /** 把会话 id 挂到查询串上：Host 半按这个会话解析沙箱策略（否则写必被拒）。 */
    /**
     * 拼路由 URL。
     *
     * 不能靠「先拼好 ?session= 再补 /mutate」——那会把后段拼进查询串里，服务端只看得到
     * `/lessons`，于是 404。路径在前、查询参数统一用 URLSearchParams 拼。
     */
    function lessonUrl(sessionId, path = '', params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) search.set(key, String(value));
      if (typeof sessionId === 'string' && sessionId.length > 0) search.set('session', sessionId);
      const query = search.toString();
      return `${API_ROOT}${path === '' ? '/lessons' : path}${query === '' ? '' : `?${query}`}`;
    }

    async function requestLessons(sessionId) {
      const response = await fetch(lessonUrl(sessionId), { headers: LESSON_HEADERS, cache: 'no-store' });
      const value = await response.json().catch(() => undefined);
      if (response.status === 403) throw new Error('经验库路由拒绝了这次请求（缺少 x-self-evolve 头）。');
      if (response.status === 404) {
        throw new Error('经验库路由没挂上：宿主启动时 web 服务可能还没就绪。在设置里把 self-evolve 关掉再打开一次即可。');
      }
      if (!response.ok || value === undefined || value.ok !== true) {
        throw new Error(value !== undefined && typeof value.error === 'string' ? value.error : `经验库返回 ${response.status}`);
      }
      return {
        lessons: Array.isArray(value.lessons) ? value.lessons : [],
        memoryLimit: typeof value.memoryLimit === 'number' ? value.memoryLimit : 0,
        proposals: Array.isArray(value.proposals) ? value.proposals : [],
        // 已应用的改动 + 原因：经验库里的「最近的改动」用它渲染。
        applied: Array.isArray(value.applied) ? value.applied : [],
        // 上次自动整理的时间与结果（合并了几条）。
        audit: value.audit !== null && typeof value.audit === 'object' ? value.audit : undefined,
        protocol: value.protocol !== null && typeof value.protocol === 'object' ? value.protocol : undefined,
        stats: value.stats !== null && typeof value.stats === 'object' ? value.stats : undefined,
        // 最近一次沉淀的时间戳：桌宠动画的唯一触发源。漏掉这一行，动画永远不会响
        // ——Host 明明写了 last-record.json，Client 却从来没拿到过。
        lastRecord: value.lastRecord !== null && typeof value.lastRecord === 'object' ? value.lastRecord : undefined,
        // 判断模型的执行流水（时间 / 判定 / 分数 / 耗时 / 理由）。
        judgements: Array.isArray(value.judgements) ? value.judgements : [],
      };
    }

    /** 取一份提案的完整新旧正文（diff 用）。 */
    async function requestProposal(sessionId, id) {
      const response = await fetch(lessonUrl(sessionId, '/proposal', { id }), {
        headers: LESSON_HEADERS, cache: 'no-store',
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value === undefined || value.ok !== true) {
        throw new Error(value !== undefined && typeof value.error === 'string' ? value.error : `提案返回 ${response.status}`);
      }
      return value.proposal;
    }

    async function requestApply(sessionId, id) {
      const response = await fetch(lessonUrl(sessionId, '/proposal/apply'), {
        method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, LESSON_HEADERS),
        body: JSON.stringify({ id }),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value === undefined || value.ok !== true) {
        throw new Error(value !== undefined && typeof value.error === 'string' ? value.error : `应用失败（${response.status}）`);
      }
      return value;
    }

    async function requestDiscard(sessionId, id) {
      const response = await fetch(lessonUrl(sessionId, '/proposal/discard'), {
        method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, LESSON_HEADERS),
        body: JSON.stringify({ id }),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value === undefined || value.ok !== true) {
        throw new Error(value !== undefined && typeof value.error === 'string' ? value.error : `丢弃失败（${response.status}）`);
      }
      return value;
    }

    async function requestMutate(sessionId, payload) {
      const response = await fetch(lessonUrl(sessionId, '/lessons/mutate'), {
        method: 'POST',
        headers: { ...LESSON_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value === undefined || value.ok !== true) {
        throw new Error(value !== undefined && typeof value.error === 'string' ? value.error : `保存失败（${response.status}）`);
      }
      return value;
    }

    /** 体检：让 Host 把存量记忆配对并问判定模型，返回建议（不动文件）。 */
    async function requestHealth(sessionId) {
      const response = await fetch(lessonUrl(sessionId, '/healthcheck'), {
        method: 'POST',
        headers: { ...LESSON_HEADERS, 'content-type': 'application/json' },
        body: '{}',
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value?.ok !== true) {
        throw new Error(value?.error ?? `体检失败（${response.status}）`);
      }
      return value;
    }

    /** 合并两条记忆：保留一条，其余进归档。 */
    /** 负样本：用户说「不认这个合并建议」，记下来供以后调阈值。失败不影响交互。 */
    async function sendPairFeedback(sessionId, pair) {
      try {
        await fetch(lessonUrl(sessionId, '/pair-feedback'), {
          method: 'POST',
          headers: { ...LESSON_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({ left: pair.left.title, right: pair.right.title, score: pair.score }),
        });
      } catch {
        // 只是统计，丢一次无所谓。
      }
    }

    async function requestMerge(sessionId, keep, drop) {
      const response = await fetch(lessonUrl(sessionId, '/merge'), {
        method: 'POST',
        headers: { ...LESSON_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ keep, drops: [drop] }),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value?.ok !== true) {
        throw new Error(value?.error ?? `合并失败（${response.status}）`);
      }
      return value;
    }

    /** 孟婆汤：批量清空记忆（Host 会先归档再清空，技能不动）。 */
    async function requestJudgeConfig(sessionId) {
      const response = await fetch(lessonUrl(sessionId, '/config'), { headers: { ...LESSON_HEADERS } });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value?.ok !== true) {
        throw new Error(value?.error ?? `读取失败（${response.status}）`);
      }
      return value;
    }

    async function probeJudge(sessionId) {
      const response = await fetch(lessonUrl(sessionId, '/config/probe'), {
        method: 'POST',
        headers: { ...LESSON_HEADERS },
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value?.ok !== true) {
        throw new Error(value?.error ?? `自检失败（${response.status}）`);
      }
      return value.judgement;
    }

    async function saveJudgeConfig(sessionId, patch) {
      const response = await fetch(lessonUrl(sessionId, '/config'), {
        method: 'POST',
        headers: { ...LESSON_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value?.ok !== true) {
        throw new Error(value?.error ?? `保存失败（${response.status}）`);
      }
      return value;
    }

    async function requestPurge(sessionId, scope) {
      const response = await fetch(lessonUrl(sessionId, '/lessons/purge'), {
        method: 'POST',
        headers: { ...LESSON_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ scope: scope ?? 'all' }),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok || value === undefined || value.ok !== true) {
        throw new Error(value !== undefined && typeof value.error === 'string' ? value.error : `清空失败（${response.status}）`);
      }
      return value;
    }

    /** 一句「为什么触发」。数值缺失时退回不带数字的说法，不编造。 */
    function describeTrigger(trigger) {
      if (trigger === undefined || !Array.isArray(trigger.reasons) || trigger.reasons.length === 0) return '';
      const parts = [];
      for (const reason of trigger.reasons) {
        if (reason === 'failure') {
          const detail = [];
          if (typeof trigger.shellFailures === 'number' && trigger.shellFailures > 0) detail.push(`shell 失败 ${trigger.shellFailures} 次`);
          if (typeof trigger.toolFailures === 'number' && trigger.toolFailures > 0) detail.push(`工具失败 ${trigger.toolFailures} 次`);
          parts.push(detail.length === 0 ? '连续失败' : `连续失败（${detail.join(' · ')}）`);
        } else if (reason === 'explicit') {
          parts.push('你要求记住');
        } else if (reason === 'workflow') {
          const detail = [];
          if (typeof trigger.steps === 'number') detail.push(`${trigger.steps} 步`);
          if (typeof trigger.distinctTools === 'number') detail.push(`${trigger.distinctTools} 种工具`);
          parts.push(detail.length === 0 ? '多工具长链路' : `多工具长链路（${detail.join(' / ')}）`);
        } else if (reason === 'chain') {
          parts.push(typeof trigger.steps === 'number' ? `长链路（${trigger.steps} 步）` : '长链路');
        } else {
          parts.push(reason);
        }
      }
      return parts.join('；');
    }

    /** 历史列表里的极简标签：说明「这次为什么复盘」。 */
    function triggerTag(trigger) {
      if (trigger === undefined || !Array.isArray(trigger.reasons) || trigger.reasons.length === 0) return '';
      // 之前写成「失败」，用户会以为「这条沉淀失败了」——它其实是**触发原因**。
      const map = { failure: '失败触发', workflow: '多工具长链路', chain: '长链路', explicit: '用户要求' };
      return trigger.reasons.map((reason) => map[reason] ?? reason).join('+');
    }

    /** 标签的完整解释（悬停可见），避免再被误读成「记录失败」。 */
    function triggerTagTitle(trigger) {
      if (trigger === undefined || !Array.isArray(trigger.reasons) || trigger.reasons.length === 0) return '';
      const parts = [];
      if (trigger.reasons.includes('failure')) parts.push('这次复盘是因为连续失败触发的');
      if (trigger.reasons.includes('workflow')) parts.push('这次复盘是因为多工具长链路触发的');
      if (trigger.reasons.includes('chain')) parts.push('这次复盘是因为链路够长触发的');
      if (trigger.reasons.includes('explicit')) parts.push('这次复盘是因为你明确要求记住');
      return parts.join('；');
    }

    /**
     * 判定模型的结论，压成一行浅色说明。
     *
     * 三种状态必须能分开：正常判定（值 / 不值）、影子模式（不拦截）、
     * 降级（接口没通，按老逻辑照写）——否则用户会以为「闸门在工作」，
     * 实际上它一直没生效。
     */
    function describeJudgement(judgement) {
      if (judgement === undefined) return '';
      const pct = (value) => (typeof value === 'number' ? value.toFixed(2) : '?');
      if (judgement.verdict === 'degraded') {
        const why = judgement.reason === 'no-api-key' ? '未配置 key'
          : judgement.reason === 'timeout' ? '超时'
            : judgement.reason === 'network' ? '网络失败'
              : judgement.reason.startsWith('http-') ? `接口返回 ${judgement.reason.slice(5)}` : (judgement.reason || '未知原因');
        return `判定降级（${why}）· 按原逻辑写入`;
      }
      const scopeText = judgement.scope === 'global' ? '全局' : judgement.scope === 'project' ? '项目' : '';
      const parts = [
        judgement.verdict === 'not-worth' ? `判定不值得（${pct(judgement.worth)}）` : `判定值得（${pct(judgement.worth)}）`,
      ];
      if (scopeText !== '') parts.push(`建议${scopeText}${judgement.confidence === undefined ? '' : ` ${pct(judgement.confidence)}`}`);
      // 只有明确「影子模式」时才说：老记录没有这个字段，不能默认成影子。
      if (judgement.enforced === false) parts.push('影子模式，未拦截');
      if (typeof judgement.ms === 'number') parts.push(`${judgement.ms}ms`);
      return parts.join(' · ');
    }

    /** 时间戳 → `HH:MM:SS`；读不出就返回空串（不显示假时间）。 */
    function formatClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    /** 记录里存的 `2026-10-21 16:07:39` → 列表里显示 `10-21 16:07:39`（省点横向空间）。 */
    function shortStamp(stamp) {
      return typeof stamp === 'string' ? stamp.replace(/^\d{4}-/, '') : '';
    }

    /**
     * 本会话的进化历史：只列次数，不展开每条明细。
     *
     * 之前点开只能看到「最近一次」，次数涨上去以后就失去了回顾价值——用户想知道
     * 「这三次分别沉淀了什么」，而不是只有最后一次。
     */
    function HistoryList(props) {
      const history = Array.isArray(props.history) ? props.history : [];
      if (history.length <= 1) return null;
      const shown = history.slice(0, 8);
      const rest = history.length - shown.length;
      return h('div', {
        style: {
          marginTop: 10, paddingTop: 8, borderTop: '1px dashed ' + (props.border ?? FALLBACK.border),
          textAlign: 'left', width: 560, maxWidth: '86vw',
        },
      },
        h('div', { style: { fontSize: 11.5, opacity: 0.72, marginBottom: 4 } },
          `本会话 ${history.length} 次进化`),
        ...shown.map((item, index) => h('div', {
          key: 'h' + index,
          style: {
            display: 'flex', alignItems: 'baseline', gap: 8,
            fontSize: 11.5, lineHeight: '18px', opacity: index === 0 ? 0.85 : 0.6,
          },
        },
          h('span', { style: { flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, formatClock(item.time) || '--:--'),
          item.tag === undefined || item.tag === ''
            ? null
            : h('span', {
              style: {
                flex: '0 0 auto', fontSize: 10.5, lineHeight: '16px', padding: '0 5px', borderRadius: 999,
                border: '1px solid rgba(124,58,237,0.28)', background: 'rgba(124,58,237,0.08)',
              },
              title: item.tagTitle === undefined || item.tagTitle === '' ? undefined : item.tagTitle,
            }, item.tag),
          h('span', { style: { flex: '0 0 auto' } }, `${item.count} 条`),
          h('span', {
            style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            title: item.titles.join(' · '),
          }, item.titles.slice(0, 1).join('') || '（未命名）'),
          item.titles.length > 1
            ? h('span', { style: { flex: '0 0 auto', opacity: 0.7 } }, `+${item.titles.length - 1}`)
            : null)),
        rest > 0
          ? h('div', { style: { fontSize: 11, opacity: 0.5, marginTop: 3 } }, `还有 ${rest} 次更早的`)
          : null);
    }

    // -----------------------------------------------------------------------
    // 经验库：查看正文 + 就地编辑/删除
    // -----------------------------------------------------------------------

    const LIB_BORDER = 'rgba(127,127,127,0.22)';
    /**
     * 面板底色。
     *
     * 之前用 `Canvas` / `color-mix()`：这两个在旧内核里会整条声明失效，
     * 结果卡片变成**全透明**——文字直接压在对话上，看不清。
     * 这里改成主题令牌 + 十六进制兜底，任何内核都至少是不透明的一层。
     */
    const PANEL_BG = 'var(--dsw-alias-bg-layer-1, #ffffff)';
    // 主题里的 layer-1 可能是半透明的（毛玻璃风），单独用它当卡片底色会透出聊天。
    // 不透明底 + layer-1 叠层：两层合成后一定是不透明的，颜色仍跟随主题。
    const PANEL_BASE = 'var(--dsw-alias-bg-base, #ffffff)';
    const PANEL_SHEEN = 'linear-gradient(var(--dsw-alias-bg-layer-1, #ffffff), var(--dsw-alias-bg-layer-1, #ffffff))';
    const PANEL_FG = 'var(--dsw-alias-label-primary, #111827)';
    const PANEL_TINT = 'linear-gradient(135deg, rgba(59,130,246,0.05), rgba(124,58,237,0.07))';
    const LIB_ACTION = {
      border: '1px solid ' + LIB_BORDER,
      background: 'transparent',
      color: 'inherit',
      borderRadius: 7,
      padding: '2px 9px',
      fontSize: 11.5,
      cursor: 'pointer',
      opacity: 0.85,
    };
    const LIB_INPUT = {
      width: '100%', boxSizing: 'border-box', fontSize: 12.5, lineHeight: 1.65,
      padding: '6px 9px', borderRadius: 8, border: '1px solid ' + LIB_BORDER,
      background: 'transparent', color: 'inherit', fontFamily: 'inherit',
    };

    /** 一个小按钮，样式统一。 */

      // 视觉层：玻璃拟态 + 渐变描边 + 微交互（参考 uiverse 的现代组件风格）。
      // 全部走 class，避免内联样式散落各处的重复。
      const PANEL_CSS = `
@property --se-ai-angle{syntax:'<angle>';inherits:false;initial-value:0deg}
.se-panel{
  --se-radius:18px;
  position:relative;
  background:color-mix(in srgb, var(--dsw-alias-bg-layer-1,#fff) 82%, transparent);
  -webkit-backdrop-filter:blur(22px) saturate(160%);
  backdrop-filter:blur(22px) saturate(160%);
  border:1px solid color-mix(in srgb, var(--dsw-alias-brand-primary,#3b82f6) 16%, transparent);
  box-shadow:0 1px 0 rgba(255,255,255,.5) inset, 0 24px 60px -18px rgba(15,23,42,.35);
}
.se-panel::before{
  content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:radial-gradient(120% 70% at 12% -10%, rgba(59,130,246,.16), transparent 60%),
             radial-gradient(90% 60% at 100% 0%, rgba(168,85,247,.13), transparent 62%);
}
.se-head{position:relative;display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  padding:11px 13px 10px;border-bottom:1px solid rgba(127,127,127,.14);cursor:grab}
.se-title{font-size:14.5px;font-weight:750;letter-spacing:.2px;
  background:linear-gradient(120deg,#0ea5e9,#6366f1 55%,#a855f7);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.se-tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
@media (max-width:520px){.se-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
.se-tile{position:relative;min-width:0;min-height:82px;text-align:left;cursor:pointer;
  display:flex;flex-direction:column;gap:3px;padding:13px 13px 11px;border-radius:14px;
  border:1px solid rgba(127,127,127,.16);color:inherit;font:inherit;
  background:linear-gradient(165deg,rgba(255,255,255,.55),rgba(255,255,255,.08));
  transition:transform .16s cubic-bezier(.22,1,.36,1),box-shadow .16s ease,border-color .16s ease;
  overflow:hidden}
.se-tile>*{position:relative;z-index:1}
.se-tile::after{content:"";position:absolute;inset:0;border-radius:inherit;opacity:0;z-index:0;
  background:radial-gradient(90% 90% at 20% 0%,var(--se-accent,rgba(59,130,246,.25)),transparent 65%);
  transition:opacity .18s ease;pointer-events:none}
.se-tile:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--se-accent,#3b82f6) 45%,transparent);
  box-shadow:0 14px 30px -14px var(--se-accent,rgba(59,130,246,.5))}
.se-tile:hover::after{opacity:1}
.se-tile:active{transform:translateY(0) scale(.994)}
.se-tile-on{border-color:color-mix(in srgb,var(--se-accent,#3b82f6) 62%,transparent);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--se-accent,#3b82f6) 14%,transparent)}
.se-tile-on::after{opacity:1}
.se-tile-num{font-size:18px;font-weight:750;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-.2px}
.se-back{cursor:pointer;font:inherit;color:inherit;display:flex;align-items:center;gap:3px;
  padding:2px 9px 2px 7px;border-radius:9px;border:1px solid rgba(127,127,127,.2);
  background:transparent;font-size:11.5px;opacity:.72;transition:all .15s ease}
.se-back:hover{opacity:1;background:rgba(127,127,127,.1);transform:translateX(-1px)}
.se-btn{cursor:pointer;border-radius:8px;border:1px solid rgba(127,127,127,.22);
  background:rgba(255,255,255,.4);transition:all .15s ease;white-space:nowrap}
.se-btn:hover{background:rgba(99,102,241,.12);border-color:rgba(99,102,241,.45);transform:translateY(-1px)}
.se-btn:active{transform:translateY(0) scale(.98)}
.se-panel>*:not(style){position:relative;z-index:1}
.se-panel>*:not(style){position:relative;z-index:1}
.se-ai{border-width:0!important;
  /* 底色只铺到 padding-box：否则半透明白底会透到边框带上，在渐变环外侧留一圈白边 */
  background-clip:padding-box;
  box-shadow:0 0 0 1px rgba(99,102,241,.4),0 0 34px -8px rgba(139,92,246,.65),
             0 0 64px -24px rgba(34,211,238,.7),0 24px 54px -18px rgba(15,23,42,.4)}
/* 3px 渐变环：只画在边框带上；发光用 drop-shadow 跟着环走，不会渗进内容区 */
.se-ai::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:3px;
  background:conic-gradient(from var(--se-ai-angle,#0deg),
    #22d3ee,#6366f1 22%,#a855f7 42%,#ec4899 62%,#22d3ee 82%,#22d3ee);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude;
  filter:drop-shadow(0 0 6px rgba(139,92,246,.75)) drop-shadow(0 0 14px rgba(34,211,238,.45));
  animation:se-ai-spin 2.2s linear infinite;pointer-events:none;z-index:0}
@keyframes se-ai-spin{to{--se-ai-angle:360deg}}
@media (prefers-reduced-motion:reduce){.se-ai::after{animation:none}}
.se-row{padding:8px 11px 10px;border-radius:12px;border:1px solid rgba(127,127,127,.17);
  background:rgba(127,127,127,.055);
  transition:transform .15s cubic-bezier(.22,1,.36,1),box-shadow .15s ease,border-color .15s ease}
.se-row:hover{transform:translateY(-1px);border-color:rgba(99,102,241,.35);
  box-shadow:0 10px 24px -16px rgba(79,70,229,.55)}
/* 不留槽位：覆盖式滚动条不会挤动布局，留槽反而会在内侧多出一条白带。 */
.se-scroll{scrollbar-width:thin;scrollbar-gutter:auto}
.se-scroll::-webkit-scrollbar{width:8px}
.se-scroll::-webkit-scrollbar-track,.se-scroll::-webkit-scrollbar-corner{background:transparent}
.se-scroll::-webkit-scrollbar-thumb{background:rgba(127,127,127,.28);border-radius:8px}
.se-scroll::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.45)}
`;

    function libButton(text, onClick, extra) {
      return h('button', { onClick, className: 'se-btn', style: Object.assign({}, LIB_ACTION, extra) }, text);
    }

    /**
     * 行级 diff（LCS）：只用来给「待应用」显示旧→新，输入都是小文件。
     *
     * 不做词级 diff：改的是提示词和 markdown，按行看反而清楚。
     */
    function diffLines(before, after) {
      const a = String(before ?? '').replace(/\r\n/g, '\n').split('\n');
      const b = String(after ?? '').replace(/\r\n/g, '\n').split('\n');
      if (a.length * b.length > 250000) {
        // 太大就不做对齐了：全删全加，至少不卡死。
        return [
          ...a.map((text) => ({ type: 'del', text })),
          ...b.map((text) => ({ type: 'add', text })),
        ];
      }
      const rows = a.length + 1;
      const cols = b.length + 1;
      const table = new Uint16Array(rows * cols);
      for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
          table[i * cols + j] = a[i] === b[j]
            ? table[(i + 1) * cols + (j + 1)] + 1
            : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
        }
      }
      const ops = [];
      let i = 0;
      let j = 0;
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
          ops.push({ type: 'same', text: a[i] });
          i += 1;
          j += 1;
        } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
          ops.push({ type: 'del', text: a[i] });
          i += 1;
        } else {
          ops.push({ type: 'add', text: b[j] });
          j += 1;
        }
      }
      while (i < a.length) { ops.push({ type: 'del', text: a[i] }); i += 1; }
      while (j < b.length) { ops.push({ type: 'add', text: b[j] }); j += 1; }
      return ops;
    }

    const DIFF_STYLE = {
      del: { color: '#ef4444', background: 'rgba(239,68,68,0.10)' },
      add: { color: '#22c55e', background: 'rgba(34,197,94,0.10)' },
      same: { color: 'inherit', background: 'transparent' },
    };

    /** 一条待应用提案：标题 + 理由 + 字数变化 + 展开看 diff + 应用/丢弃。 */
    function ProposalRow(props) {
      const proposal = props.proposal;
      const diff = props.diff;
      const isPrompt = proposal.kind === 'prompt';
      const badge = h('span', {
        style: {
          fontSize: 11.5, lineHeight: '20px', padding: '1px 7px', borderRadius: 999, fontWeight: 600, flex: '0 0 auto',
          color: isPrompt ? '#0ea5e9' : '#7c3aed',
          background: isPrompt ? 'rgba(14,165,233,0.12)' : 'rgba(124,58,237,0.12)',
        },
      }, isPrompt ? '提示词' : '技能');

      const delta = (proposal.charsAfter ?? 0) - (proposal.charsBefore ?? 0);
      const deltaText = delta === 0 ? '±0 字' : `${delta > 0 ? '+' : ''}${delta} 字`;

      // 折叠态也要能一眼看到「机器觉得值不值得」：不然要点开才知道判定是不是拦过。
      const judgeChip = proposal.judgement === null || typeof proposal.judgement !== 'object'
        || proposal.judgement.verdict === undefined
        ? null
        : h('span', {
          style: {
            flex: '0 0 auto', fontSize: 10.5, lineHeight: '17px', padding: '0 6px', borderRadius: 999,
            color: proposal.judgement.verdict === 'worth' ? '#15803d' : (proposal.judgement.verdict === 'not-worth' ? '#b91c1c' : '#64748b'),
            background: proposal.judgement.verdict === 'worth' ? 'rgba(34,197,94,0.14)' : (proposal.judgement.verdict === 'not-worth' ? 'rgba(239,68,68,0.12)' : 'rgba(100,116,139,0.12)'),
          },
          title: '决策模型对这次改写的判断',
        }, proposal.judgement.verdict === 'worth'
          ? `值得 ${proposal.judgement.worth === undefined ? '' : proposal.judgement.worth.toFixed(2)}`
          : proposal.judgement.verdict === 'not-worth'
            ? `不值得 ${proposal.judgement.worth === undefined ? '' : proposal.judgement.worth.toFixed(2)}`
            : '未判定');

      const head = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
        onClick: () => props.onToggle(proposal.id),
      },
        badge,
        judgeChip,
        h('span', { style: { fontSize: 13, fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          proposal.title || proposal.path),
        h('span', {
          style: {
            fontSize: 11.5, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums',
            color: delta <= 0 ? '#22c55e' : '#f59e0b',
          },
        }, deltaText),
        h('span', { style: { fontSize: 11, opacity: 0.45 } }, props.open ? '收起' : '看差异'));

      if (!props.open) {
        return h('div', { style: { padding: '6px 6px 8px', borderBottom: '1px solid ' + LIB_BORDER } }, head);
      }

      // 附属文件（脚本/模板）：应用时点一下会连着这些文件一起写，必须先列出来。
      const files = Array.isArray(proposal.files) ? proposal.files : [];
      const fileList = files.length === 0 ? null : h('div', {
        style: { fontSize: 11.5, marginBottom: 6, padding: '5px 8px', borderRadius: 8, background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.18)' },
      },
        h('div', { style: { color: '#6d28d9', fontWeight: 600, marginBottom: 2 } }, `附带 ${files.length} 个文件`),
        files.map((file, index) => h('div', {
          key: 'f' + index,
          style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', opacity: 0.8 },
        }, `${file.path}　${file.exists ? `${file.charsBefore} → ${file.charsAfter} 字` : `新建 ${file.charsAfter} 字`}`)));

      // 判定模型的结论：为什么这次改动值得（或不值得）应用。
      const judge = proposal.judgement !== null && typeof proposal.judgement === 'object' ? proposal.judgement : undefined;
      const judgeLine = judge === undefined || judge.verdict === undefined
        ? null
        : h('div', {
          style: {
            fontSize: 11.5, marginBottom: 6, padding: '4px 8px', borderRadius: 8,
            color: judge.verdict === 'worth' ? '#15803d' : (judge.verdict === 'not-worth' ? '#b91c1c' : '#64748b'),
            background: judge.verdict === 'worth' ? 'rgba(34,197,94,0.10)' : (judge.verdict === 'not-worth' ? 'rgba(239,68,68,0.10)' : 'rgba(100,116,139,0.10)'),
          },
          title: judge.reason === '' || judge.reason === undefined ? '' : `判定失败原因：${judge.reason}`,
        }, [
          judge.verdict === 'worth' ? '判定值得应用' : judge.verdict === 'not-worth' ? '判定不值得应用' : '判定未完成（放行）',
          judge.worth === undefined ? '' : `（${judge.worth.toFixed(2)}）`,
          judge.ms === undefined ? '' : ` · ${judge.ms}ms`,
          judge.enforced === false ? ' · 影子模式，未拦截' : '',
        ].filter((part) => part !== '').join(''));

      const body = h('div', { style: { marginTop: 6 } },
        proposal.reason === '' ? null : h('div', { style: { fontSize: 11.5, opacity: 0.62, marginBottom: 6, lineHeight: 1.6 } }, proposal.reason),
        judgeLine,
        fileList,
        props.loading
          ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: '8px 2px' } }, '读取差异…')
          : null,
        props.detailError === ''
          ? null
          : h('div', { style: { fontSize: 12, color: '#ef4444', padding: '4px 2px' } }, props.detailError),
        diff === undefined
          ? null
          : h('div', {
            style: {
              maxHeight: 260, overflowY: 'auto', borderRadius: 8, padding: '6px 8px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, lineHeight: 1.55,
              background: 'rgba(127,127,127,0.06)', border: '1px solid ' + LIB_BORDER,
            },
          }, diff.ops.map((op, index) => h('div', {
            key: 'd' + index,
            style: Object.assign({ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }, DIFF_STYLE[op.type]),
          }, `${op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '} ${op.text}`)),
            diff.truncated
              ? h('div', { style: { opacity: 0.55, marginTop: 4 } }, `…只显示前 ${diff.ops.length} 行`)
              : null),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
          libButton(props.busy ? '应用中…' : '应用', () => props.onApply(proposal.id), {
            color: '#22c55e', borderColor: 'rgba(34,197,94,0.5)',
          }),
          libButton('丢弃', () => props.onDiscard(proposal.id), { color: '#ef4444', borderColor: 'rgba(239,68,68,0.4)' }),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { fontSize: 10.5, opacity: 0.45, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, proposal.path)));

      return h('div', { style: { padding: '6px 6px 8px', borderBottom: '1px solid ' + LIB_BORDER } }, head, body);
    }

    /** 一行经验：折叠时只显示标题，展开后显示正文或编辑框。 */
    function LibraryRow(props) {
      const lesson = props.lesson;
      const actions = props.actions;
      const badgeColor = lesson.kind === 'skill' ? '#7c3aed' : '#2563eb';
      const badge = h('span', {
        style: {
          fontSize: 11.5, lineHeight: '20px', padding: '1px 7px', borderRadius: 999,
          fontWeight: 600, flex: '0 0 auto', color: badgeColor,
          background: lesson.kind === 'skill' ? 'rgba(124,58,237,0.12)' : 'rgba(37,99,235,0.12)',
        },
      }, lesson.kind === 'skill' ? '技能' : '记忆');

      // 记忆分两档：项目级只在本仓库加载，全局则每个会话都加载。
      const documentChip = lesson.document === true
        ? h('span', {
          style: {
            fontSize: 10.5, lineHeight: '17px', padding: '0 6px', borderRadius: 999, flex: '0 0 auto',
            color: '#6d28d9', border: '1px solid rgba(109,40,217,0.3)', background: 'rgba(109,40,217,0.08)',
          },
          title: '整篇写成的技能：内容在 SKILL.md 里，不是一条经验行',
        }, '整篇')
        : null;

      const scopeChip = lesson.kind === 'memory' && (lesson.scope === 'global' || lesson.scope === 'project')
        ? h('span', {
          style: {
            fontSize: 10.5, lineHeight: '17px', padding: '0 6px', borderRadius: 999, flex: '0 0 auto',
            color: lesson.scope === 'global' ? '#b45309' : '#4b5563',
            border: `1px solid ${lesson.scope === 'global' ? 'rgba(180,83,9,0.35)' : 'rgba(75,85,99,0.28)'}`,
            background: lesson.scope === 'global' ? 'rgba(180,83,9,0.09)' : 'transparent',
          },
          title: lesson.scope === 'global' ? '全局记忆：每个项目的每个会话都会加载' : '项目记忆：只有这个仓库的会话加载',
        }, lesson.scope === 'global' ? '全局' : '项目')
        : null;

      const head = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
        onClick: () => actions.toggle(lesson.id),
      },
        badge,
        scopeChip,
        documentChip,
        h('span', {
          style: { fontSize: 11, opacity: 0.55, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' },
          title: lesson.date,
        }, shortStamp(lesson.date)),
        h('span', {
          style: { fontSize: 12.5, fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, lesson.title || lesson.body.slice(0, 40)),
        h('span', { style: { fontSize: 11, opacity: 0.45, flex: '0 0 auto', paddingLeft: 4 } }, props.open ? '收起' : '展开'));

      if (!props.open) {
        return h('div', { style: { borderBottom: '1px solid ' + LIB_BORDER, padding: '6px 6px 8px' } }, head);
      }

      let body;
      if (props.editing) {
        const titleField = lesson.kind !== 'memory'
          ? null
          : h('input', {
            value: props.draft.title,
            placeholder: '标题',
            onChange: (event) => actions.editTitle(event.target.value),
            style: Object.assign({}, LIB_INPUT, { marginBottom: 6 }),
          });
        body = h('div', { style: { marginTop: 6 } },
          titleField,
          h('textarea', {
            value: props.draft.body,
            rows: 6,
            onChange: (event) => actions.editBody(event.target.value),
            style: Object.assign({}, LIB_INPUT, { resize: 'vertical' }),
          }),
          props.error === '' ? null : h('div', { style: { fontSize: 11.5, color: '#ef4444', marginTop: 4 } }, props.error),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
            libButton(props.busy ? '保存中…' : '保存', actions.save, { borderColor: 'rgba(37,99,235,0.5)', color: '#2563eb', fontWeight: 600 }),
            libButton('取消', actions.cancelEdit),
            h('span', { style: { flex: '1 1 auto' } }),
            h('span', { style: { fontSize: 10.5, opacity: 0.45, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, lesson.path)));
      } else {
        const removeButton = lesson.document === true
          ? null
          : (props.confirm
            ? libButton(props.busy ? '删除中…' : '确认删除', actions.remove, { color: '#ef4444', borderColor: 'rgba(239,68,68,0.5)' })
            : libButton('删除', actions.askRemove));
        const editButton = lesson.document === true ? null : libButton('编辑', actions.startEdit);
        body = h('div', { style: { marginTop: 6 } },
          h('div', {
            style: {
              fontSize: 12.5, lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: 220, overflowY: 'auto', padding: '6px 8px', borderRadius: 8,
              background: 'rgba(127,127,127,0.06)',
            },
          }, lesson.body),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
            editButton,
            removeButton,
            lesson.document === true
              ? h('span', { style: { fontSize: 10.5, opacity: 0.5 } }, '整篇技能 · 直接改文件')
              : null,
            h('span', { style: { flex: '1 1 auto' } }),
            h('span', { style: { fontSize: 10.5, opacity: 0.45, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, lesson.path)));
      }

      return h('div', { className: 'se-row' }, head, body);
    }

    /**
     * 技能分组：同一个技能（同一 path）的多条经验收成一张卡。
     * 头部显示技能名与「N 条」，点开后列出每条的现有行（编辑/删除仍按条走）。
     */
    function SkillGroup(props) {
      const [open, setOpen] = useState(false);
      const entries = props.entries;
      const head = h('button', {
        type: 'button',
        className: 'se-skill-group',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 10px',
          width: '100%', border: 'none', background: 'transparent', textAlign: 'left',
        },
        onClick: () => setOpen(!open),
      },
        h('span', {
          style: {
            fontSize: 11.5, lineHeight: '20px', padding: '1px 7px', borderRadius: 999,
            fontWeight: 600, flex: '0 0 auto', color: '#7c3aed', background: 'rgba(124,58,237,0.12)',
          },
        }, '技能'),
        h('span', {
          style: { fontSize: 12.5, fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, props.name),
        h('span', { style: { fontSize: 11.5, color: '#7c3aed', flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, `${entries.length} 条`),
        h('span', { style: { fontSize: 11, opacity: 0.45, flex: '0 0 auto', paddingLeft: 4 } }, open ? '收起' : '展开'));
      return h('div', {
        className: 'se-skill-group-wrap',
        style: { borderBottom: '1px solid ' + LIB_BORDER },
      },
        head,
        open
          ? h('div', { style: { paddingLeft: 10, borderLeft: '2px solid rgba(124,58,237,0.18)', marginLeft: 14 } }, props.renderEntries(entries))
          : null);
    }

    /**
     * 经验库面板。
     *
     * 正文来自 Host 半的同源路由（Client 半没有文件系统）：`GET /api/self-evolve/lessons`
     * 取列表，`POST .../mutate` 保存或删除。写回时用「原始行」定位，列表过期也安全。
     */
    /**
     * 判断日志的时间戳：统一显示「月-日 时:分:秒」。
     * 老流水是 ISO(UTC)，新流水是本地时间字符串，两种都要认——否则会出现「差了 8 小时」。
     */
    function judgementStamp(at) {
      if (typeof at !== 'string' || at === '') return '';
      if (at.includes('T')) {
        const when = new Date(at);
        if (Number.isFinite(when.getTime())) {
          const pad = (value) => String(value).padStart(2, '0');
          return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
        }
      }
      return at.length >= 19 ? at.slice(5, 19) : at;
    }

    function LessonLibrary(props) {
      const [data, setData] = useState(props.initialData ?? { status: 'loading', lessons: [], memoryLimit: 0, proposals: [], protocol: undefined });
      const [openProposalId, setOpenProposalId] = useState('');
      const [proposalDiff, setProposalDiff] = useState(undefined);
      const [proposalLoading, setProposalLoading] = useState(false);
      const [proposalError, setProposalError] = useState('');
      const [proposalBusy, setProposalBusy] = useState(false);
      const [openId, setOpenId] = useState('');
      const [draft, setDraft] = useState(undefined);
      const [confirmId, setConfirmId] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [note, setNote] = useState('');
      const [purgeAsk, setPurgeAsk] = useState(false);
      const [purging, setPurging] = useState(false);
      // 体检结果：pairs [{verdict,left,right}]，只占一块小区域，不抢列表。
      const [health, setHealth] = useState(undefined);
      const [healthBusy, setHealthBusy] = useState(false);
      // 判断模型的执行流水：默认收起，点开才看，不占日常视野。
      // 首页两栏 → 点进某一栏看明细。0 首页 / memory / skill。
      const [tab, setTab] = useState(typeof props.initialTab === 'string' ? props.initialTab : 'home');
      const tabTitle = tab === 'memory' ? '记忆' : tab === 'skill' ? '技能'
        : tab === 'settings' ? '设置' : tab === 'log' ? '判断日志' : '';
      // 判定模型的配置：key 只在输入框里存在，保存后不再回显。
      const [judge, setJudge] = useState(props.initialJudge);
      const [judgeOpen, setJudgeOpen] = useState(false);
      const [judgeKey, setJudgeKey] = useState('');
      const [judgeBusy, setJudgeBusy] = useState(false);
      const [judgeError, setJudgeError] = useState('');
      const [judgeProbe, setJudgeProbe] = useState(undefined);
      const [probeBusy, setProbeBusy] = useState(false);
      // 面板拖得动：它挡着哪块聊天，用户自己挪。
      const [pos, setPos] = useState(loadPanelPos);
      // 拖拽双保险：React 合成事件 + document 捕获监听（见 usePanelDrag 的注释）。
      const [dragging, setDragging] = useState(false);
      const panelRef = usePanelDrag(pos, setPos, savePanelPos, setDragging);
      const startDrag = (event) => {
        const tag = event.target?.tagName?.toLowerCase?.() ?? '';
        if (tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'a') return;
        if (typeof event.button === 'number' && event.button !== 0) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setDragging(true);
        trackPanelDrag(event, { right: pos.right, bottom: pos.bottom }, setPos, (last, moved) => {
          setDragging(false);
          if (moved) savePanelPos(last);
        });
      };

      function loadJudge() {
        requestJudgeConfig(props.sessionId).then(
          (value) => setJudge(value),
          (failure) => setJudgeError(describeFailure(failure)),
        );
      }

      function reload() {
        loadJudge();
        setData((prev) => Object.assign({}, prev, { status: 'loading' }));
        requestLessons(props.sessionId).then(
          (value) => setData(Object.assign({ status: 'ready' }, value)),
          (failure) => setData({ status: 'error', lessons: [], memoryLimit: 0, proposals: [], error: describeFailure(failure) }),
        );
      }

      /** 展开提案：只有展开时才拉两版全文，列表本身不带正文。 */
      function toggleProposal(id) {
        if (openProposalId === id) {
          setOpenProposalId('');
          return;
        }
        setOpenProposalId(id);
        setProposalDiff(undefined);
        setProposalError('');
        setProposalLoading(true);
        requestProposal(props.sessionId, id).then(
          (value) => {
            const ops = diffLines(value.before, value.after);
            // 差异太长就截断显示，别把面板撑爆。
            const limit = 400;
            setProposalDiff({ ops: ops.slice(0, limit), truncated: ops.length > limit });
            setProposalLoading(false);
          },
          (failure) => {
            setProposalError(describeFailure(failure));
            setProposalLoading(false);
          },
        );
      }

      async function applyProposalAction(id) {
        if (proposalBusy) return;
        setProposalBusy(true);
        setError('');
        try {
          await requestApply(props.sessionId, id);
          setNote('已应用');
          setOpenProposalId('');
          setProposalDiff(undefined);
          reload();
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setProposalBusy(false);
        }
      }

      /** 一键自检：真调一次判定接口，回答「它到底生效没有」。 */
      async function probeJudgeAction() {
        if (probeBusy) return;
        setProbeBusy(true);
        setJudgeError('');
        setJudgeProbe(undefined);
        try {
          const result = await probeJudge(props.sessionId);
          setJudgeProbe(result);
          loadJudge();
        } catch (failure) {
          setJudgeError(describeFailure(failure));
        } finally {
          setProbeBusy(false);
        }
      }

      /** 保存判定模型配置：写回 profile patch，重载后生效。 */
      async function saveJudgeAction() {
        if (judgeBusy) return;
        setJudgeBusy(true);
        setJudgeError('');
        try {
          const patch = { shadow: judge?.decision?.shadow === true ? true : false };
          if (judgeKey.trim().length > 0) patch.apiKey = judgeKey.trim();
          const value = await saveJudgeConfig(props.sessionId, patch);
          setJudge(value);
          setJudgeKey('');
          setNote('判定配置已保存');
          setJudgeOpen(false);
          loadJudge();
        } catch (failure) {
          setJudgeError(describeFailure(failure));
        } finally {
          setJudgeBusy(false);
        }
      }

      /** 体检：拉一份建议。合并动作单独确认（它真的会改文件）。 */
      async function runHealth() {
        if (healthBusy) return;
        setHealthBusy(true);
        setError('');
        try {
          const report = await requestHealth(props.sessionId);
          setHealth(report);
          if (report.merged !== undefined && report.merged.length > 0) {
            setNote(`整理完成：合并 ${report.merged.length} 对`);
          } else if (report.pairs.length === 0) {
            setNote('体检完成：没有发现疑似重复的条目');
          }
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setHealthBusy(false);
        }
      }

      /** 合并一条建议：保留较新的那条，另一条进归档。 */
      async function mergePair(pair) {
        if (healthBusy) return;
        setHealthBusy(true);
        setError('');
        try {
          const newer = String(pair.left.date ?? '') >= String(pair.right.date ?? '') ? pair.left : pair.right;
          const older = newer === pair.left ? pair.right : pair.left;
          const result = await requestMerge(props.sessionId, newer, older);
          setNote(result.removed.length > 0 ? `已合并：${older.title} 进归档` : '没有可合并的条目');
          setHealth({ ...health, pairs: health.pairs.filter((item) => item !== pair) });
          reload();
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setHealthBusy(false);
        }
      }

      /** 孟婆汤：二次确认后按档清空。归档由 Host 负责，这里只报结果。 */
      async function purgeAction(scope) {
        if (purging) return;
        setPurging(true);
        setError('');
        try {
          const result = await requestPurge(props.sessionId, scope);
          const label = scope === 'global' ? '全局' : scope === 'project' ? '项目' : '';
          setNote(result.cleared > 0 ? `已清空${label} ${result.cleared} 条（已归档）` : '没有可清空的记忆');
          if (result.cleared > 0) announceForget(result.cleared);
          setPurgeAsk(false);
          reload();
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setPurging(false);
        }
      }

      async function discardProposalAction(id) {
        if (proposalBusy) return;
        setProposalBusy(true);
        setError('');
        try {
          await requestDiscard(props.sessionId, id);
          setNote('已丢弃');
          setOpenProposalId('');
          setProposalDiff(undefined);
          reload();
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setProposalBusy(false);
        }
      }

      useEffect(reload, []);

      useEffect(() => {
        if (note === '') return undefined;
        const timer = setTimeout(() => setNote(''), 2000);
        return () => clearTimeout(timer);
      }, [note]);

      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          setDraft(undefined);
          props.onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [props]);

      const lessons = data.lessons;
      const memoryCount = lessons.filter((lesson) => lesson.kind === 'memory').length;
      // 首页「技能」数 = 技能个数（按 SKILL.md 去重），不是条目数；
      // 条目数在技能页每张卡上的「N 条」里体现。
      const skillPaths = new Set(
        lessons.filter((lesson) => lesson.kind !== 'memory').map((lesson) => lesson.path || lesson.title),
      );
      const skillCount = skillPaths.size;

      async function save() {
        if (draft === undefined || busy) return;
        setBusy(true);
        setError('');
        try {
          await requestMutate(props.sessionId, { path: draft.path, original: draft.original, title: draft.title, body: draft.body, action: 'update' });
          setDraft(undefined);
          setNote('已保存');
          reload();
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setBusy(false);
        }
      }

      async function remove() {
        if (draft !== undefined || busy) return;
        const lesson = lessons.find((item) => item.id === confirmId);
        if (lesson === undefined) return;
        setBusy(true);
        setError('');
        try {
          await requestMutate(props.sessionId, { path: lesson.path, original: lesson.original, action: 'delete' });
          setConfirmId('');
          setOpenId('');
          setNote('已删除');
          // 桌宠也要知道「你刚让它忘了一条」。
          announceForget(1);
          reload();
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setBusy(false);
        }
      }

      // 判断日志：每条一行，把「判了什么、多久、为什么」摊开。
      const judgements = Array.isArray(data.judgements) ? data.judgements : [];
      const judgementLogBlock = h('div', {
        style: {
          margin: '2px 0', padding: '9px 11px', borderRadius: 12,
          background: 'rgba(14,165,233,0.06)', border: '1px solid rgba(14,165,233,0.22)',
        },
      },
        h('div', { style: { fontSize: 11.5, fontWeight: 600, color: '#0369a1', marginBottom: 4 } },
          `判断日志 ${judgements.length} 条（最近在前）`),
        judgements.length === 0
          ? h('div', { style: { fontSize: 11.5, opacity: 0.6 } }, '暂无记录')
          : judgements.map((row, index) => {
            const verdict = row.verdict === 'worth' ? '值得' : row.verdict === 'not-worth' ? '不值得' : (row.verdict || '—');
            const score = typeof row.worth === 'number' ? row.worth.toFixed(2) : '—';
            const extra = row.kind === 'pair' ? `配对 ${row.left ?? ''} × ${row.right ?? ''}` : (row.title || '');
            const meta = `${row.scope === 'global' ? '全局' : row.scope === 'project' ? '项目' : '—'}${typeof row.ms === 'number' ? ` · ${row.ms}ms` : ''}${row.kind === 'skill' ? ' · 技能' : ''}`;
            return h('div', {
              key: `log-${index}`,
              style: { display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 11, padding: '2px 0', opacity: 0.88 },
            },
              h('span', { style: { flex: '0 0 auto', opacity: 0.5, fontVariantNumeric: 'tabular-nums' } }, judgementStamp(row.at)),
              h('span', { style: { flex: '0 0 auto', color: row.verdict === 'worth' ? '#15803d' : '#b91c1c' } }, verdict),
              h('span', { style: { flex: '0 0 auto', opacity: 0.6, fontVariantNumeric: 'tabular-nums' } }, score),
              h('span', { style: { flex: '0 0 auto', opacity: 0.55 } }, meta),
              h('span', {
                style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: extra,
              }, extra),
              row.reason ? h('span', { style: { flex: '0 0 auto', color: '#b45309' } }, row.reason) : null);
          }));
      // 同一套行组件，按集合复用：记忆栏、技能栏各取一份。
      const rowsOf = (list) => list.map((lesson) => h(LibraryRow, {
        key: lesson.id,
        lesson,
        open: openId === lesson.id,
        editing: draft !== undefined && draft.id === lesson.id,
        confirm: confirmId === lesson.id,
        draft: draft !== undefined && draft.id === lesson.id ? draft : { title: lesson.title, body: lesson.body },
        busy,
        error: draft !== undefined && draft.id === lesson.id ? error : '',
        actions: {
          toggle(id) { setOpenId(openId === id ? '' : id); setConfirmId(''); },
          startEdit() { setError(''); setDraft({ id: lesson.id, path: lesson.path, original: lesson.original, title: lesson.title, body: lesson.body }); },
          cancelEdit() { setDraft(undefined); setError(''); },
          editTitle(value) { setDraft((prev) => Object.assign({}, prev, { title: value })); },
          editBody(value) { setDraft((prev) => Object.assign({}, prev, { body: value })); },
          askRemove() { setConfirmId(lesson.id); },
          remove,
          save,
        },
      }));

      const memoryLessons = lessons.filter((lesson) => lesson.kind === 'memory');
      const skillLessons = lessons.filter((lesson) => lesson.kind !== 'memory');
      const rows = rowsOf(lessons);

      const status = [];
      if (data.status === 'loading' && lessons.length === 0) status.push('读取中…');
      if (data.status === 'error') status.push(data.error);
      if (data.status === 'ready' && lessons.length === 0) status.push('还没有沉淀过任何经验。');
      const statusNodes = status.map((text, index) => h('div', {
        key: 'status' + index,
        style: { padding: 16, fontSize: 12.5, lineHeight: 1.7, opacity: 0.75 },
      }, text));

      const proposals = data.proposals ?? [];
      // 条数和字节数两个上限都要看到：一条记忆动辄几百字，字节上限常常先撞上。
      const stats = data.stats;
      const kbText = stats !== undefined
        && typeof stats.memoryBytes === 'number'
        && typeof stats.memoryBytesLimit === 'number'
        && stats.memoryBytesLimit > 0
        ? ` · ${Math.round(stats.memoryBytes / 1024)}/${Math.round(stats.memoryBytesLimit / 1024)} KB`
        : '';
      // 分档数字：全局记忆每个项目都要背，项目记忆只在这个仓库加载——意义完全不同。
      const globalMemoryCount = lessons.filter((lesson) => lesson.kind === 'memory' && lesson.scope === 'global').length;
      const projectMemoryCount = lessons.filter((lesson) => lesson.kind === 'memory' && lesson.scope === 'project').length;
      const splitText = globalMemoryCount === 0 && projectMemoryCount === 0
        ? ''
        : ` · 全局 ${globalMemoryCount} / 项目 ${projectMemoryCount}`;
      const summaryText = data.memoryLimit > 0
        ? `记忆 ${memoryCount}/${data.memoryLimit} 条${splitText}${kbText} · 自建技能 ${skillCount} 个`
        : `共 ${lessons.length} 条`;
      // 接近上限时提前说明「接下来会发生什么」，别等条目被挪走才让用户发现。
      const stats2 = data.stats;
      const usageRatio = stats2 === undefined
        ? 0
        : Math.max(
          data.memoryLimit > 0 ? memoryCount / data.memoryLimit : 0,
          typeof stats2.memoryBytes === 'number' && typeof stats2.memoryBytesLimit === 'number' && stats2.memoryBytesLimit > 0
            ? stats2.memoryBytes / stats2.memoryBytesLimit
            : 0,
        );
      const capHint = usageRatio < 0.75
        ? null
        : h('div', {
          style: { fontSize: 11, letterSpacing: 0.2, marginTop: 4, opacity: 0.7, color: usageRatio >= 0.95 ? '#b45309' : undefined },
        }, usageRatio >= 0.95
          ? '记忆已到上限：新经验会淘汰最老的一条，原文自动存进插件归档（self-evolve/archive/memory.md）'
          : `记忆已用 ${Math.round(usageRatio * 100)}%：到上限后会淘汰最老的条目（原文进归档，不会消失）`);
      const protocolText = data.protocol === undefined || typeof data.protocol.chars !== 'number'
        ? ''
        : `协议 ${data.protocol.chars}/${data.protocol.budget} 字`;
      // 自动整理痕迹：不弹窗，就在标题行留一句，证明记忆会自己收拾。
      const auditText = data.audit === undefined || typeof data.audit.at !== 'string'
        ? ''
        : `整理 ${shortStamp(data.audit.at)}${data.audit.merged > 0 ? ` · 合并 ${data.audit.merged}` : ''}`;

      // 待应用：模型提交的自我改写提案，看 diff 后点「应用」才真的落盘。
      const proposalBlock = proposals.length === 0
        ? null
        : h('div', {
          style: {
            margin: '8px 6px 4px', padding: '8px 10px', borderRadius: 10,
            border: '1px solid rgba(14,165,233,0.35)', background: 'rgba(14,165,233,0.06)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
            h('span', { style: { fontSize: 12, fontWeight: 700, color: '#0ea5e9' } }, `待应用 ${proposals.length}`),
            h('span', { style: { fontSize: 11, opacity: 0.6 } }, '不应用就一直是候选')),
          proposals.map((proposal) => h(ProposalRow, {
            key: proposal.id,
            proposal,
            open: openProposalId === proposal.id,
            diff: openProposalId === proposal.id ? proposalDiff : undefined,
            loading: openProposalId === proposal.id && proposalLoading,
            detailError: openProposalId === proposal.id ? proposalError : '',
            busy: proposalBusy,
            onToggle: toggleProposal,
            onApply: applyProposalAction,
            onDiscard: discardProposalAction,
          })));

      // 已应用的改动：改完还要能回答「当初为什么改」。理由与时间跟着改动一起显示。
      const appliedList = Array.isArray(data.applied) ? data.applied : [];
      const appliedBlock = appliedList.length === 0
        ? null
        : h('div', {
          style: {
            margin: '8px 6px 4px', padding: '8px 10px', borderRadius: 10,
            border: '1px solid rgba(34,197,94,0.32)', background: 'rgba(34,197,94,0.06)',
          },
        },
          h('div', { style: { fontSize: 12, fontWeight: 700, color: '#15803d', marginBottom: 4 } }, `最近的改动 ${appliedList.length}`),
          appliedList.map((item, index) => h('div', {
            key: 'ap' + index,
            style: { padding: '5px 0', borderTop: index === 0 ? 'none' : '1px solid rgba(34,197,94,0.16)' },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12 } },
              h('span', {
                style: {
                  flex: '0 0 auto', fontSize: 10.5, lineHeight: '16px', padding: '0 6px', borderRadius: 6,
                  background: item.kind === 'prompt'
                    ? 'rgba(14,165,233,0.14)'
                    : item.kind === 'memory' ? 'rgba(34,197,94,0.14)' : 'rgba(124,58,237,0.12)',
                  color: item.kind === 'prompt' ? '#0369a1' : item.kind === 'memory' ? '#15803d' : '#6d28d9',
                },
              }, item.kind === 'prompt' ? '提示词' : item.kind === 'memory' ? '记忆' : '技能'),
              h('span', { style: { fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.path),
              h('span', { style: { fontSize: 10.5, opacity: 0.5, flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' } }, typeof item.at === 'string' ? item.at.slice(5) : '')),
            // 为什么改：这一行就是用户要的「改动后我要知道为什么」。
            h('div', { style: { fontSize: 11.5, opacity: 0.72, marginTop: 2 } }, `原因：${item.reason || '（未写原因）'}`),
            Array.isArray(item.files) && item.files.length > 0
              ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 1 } }, `附带 ${item.files.length} 个文件：${item.files.map((file) => file.path).join('、')}`)
              : null)));

      // 体检块：把「疑似重复/过期」摆出来，点合并才真的动文件。
      const verdictLabel = {
        same: '同一件事',
        update: '有新有旧',
        complement: '互补',
        unrelated: '无关',
        unchecked: '未判定',
        error: '判定失败',
      };
      const healthBlock = health === undefined
        ? null
        : h('div', {
          style: {
            margin: '8px 6px 4px', padding: '8px 10px', borderRadius: 10,
            border: '1px solid rgba(234,179,8,0.35)', background: 'rgba(234,179,8,0.07)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
            h('span', { style: { fontSize: 12, fontWeight: 700, color: '#a16207' } }, `体检 ${health.pairs.length}`),
            h('span', { style: { fontSize: 11, opacity: 0.6 } }, '疑似重复，合并后旧条目进归档'),
            h('span', { style: { flex: '1 1 auto' } }),
            libButton('收起', () => setHealth(undefined), { fontSize: 11, padding: '1px 8px' })),
          health.pairs.length === 0
            ? h('div', { style: { fontSize: 11.5, opacity: 0.65 } }, '没有发现疑似重复的条目。')
            : health.pairs.map((pair, index) => h('div', {
              key: `hp-${index}`,
              style: { padding: '6px 0', borderTop: index === 0 ? 'none' : '1px solid rgba(234,179,8,0.16)' },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                h('span', {
                  style: {
                    flex: '0 0 auto', fontSize: 10.5, padding: '0 6px', borderRadius: 999,
                    color: pair.verdict === 'complement' || pair.verdict === 'unrelated' ? '#64748b' : '#a16207',
                    background: 'rgba(234,179,8,0.16)',
                  },
                }, verdictLabel[pair.verdict] ?? pair.verdict),
                h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } },
                  `${pair.left.title} ⟷ ${pair.right.title}`)),
              h('div', { style: { fontSize: 11, opacity: 0.62, marginTop: 2 } }, pair.left.preview),
              h('div', { style: { fontSize: 11, opacity: 0.62, marginTop: 1 } }, pair.right.preview),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
                libButton(healthBusy ? '合并中…' : '合并（留新的）', () => mergePair(pair), { fontSize: 11, padding: '1px 8px' }),
                libButton('忽略', () => {
                  // 点了忽略 = 判定判错了，这条要进负样本。
                  void sendPairFeedback(props.sessionId, pair);
                  setHealth({ ...health, pairs: health.pairs.filter((item) => item !== pair) });
                }, { fontSize: 11, padding: '1px 8px' })))));

      const headerRow = h('div', {
        onDoubleClick: () => {
          const corners = [
            { right: 20, bottom: 216 },
            { right: 20, bottom: 40 },
            { right: 420, bottom: 40 },
            { right: 420, bottom: 216 },
          ];
          const index = corners.findIndex((corner) => Math.abs(corner.right - pos.right) < 40 && Math.abs(corner.bottom - pos.bottom) < 40);
          const next = corners[(index + 1) % corners.length];
          setPos(next);
          savePanelPos(next);
        },
        title: '按住拖动卡片（拖不动就双击，会在四个角之间跳）',
        className: 'se-head',
        style: { touchAction: 'none', userSelect: 'none' },
      },
        tab === 'home'
          ? null
          : h('button', {
            className: 'se-back',
            onClick: () => setTab('home'),
            title: '回到总览',
          }, '‹ 返回'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', { className: 'se-title' }, tab === 'home' ? '🧬 经验库' : `🧬 ${tabTitle}`)),
        h('span', { style: { flex: '1 1 auto' } }),
        note === '' ? null : h('span', { style: { fontSize: 11.5, color: '#22c55e' } }, note),
        // 判断模型的执行流水：判了什么、判多久、为什么。
        libButton('判断日志', () => setTab(tab === 'log' ? 'home' : 'log'), {
          padding: '2px 8px', fontSize: 10.5, color: '#0369a1',
          borderColor: tab === 'log' ? 'rgba(14,165,233,.55)' : undefined,
          background: tab === 'log' ? 'rgba(14,165,233,.12)' : undefined,
        }),
        // 体检：写入时判断只管新条目，存量里的重复/过期只能靠它扫一遍。
        libButton(healthBusy ? '体检中…' : '体检', runHealth, { padding: '2px 8px', fontSize: 10.5, color: '#a16207' }),
        // 孟婆汤：批量清空记忆。0 条时也留着按钮（不然用户以为没这功能），
        // 点了就直说「没有可清空的」，而不是弹一个空确认框。
        libButton(purging ? '清空中…' : '孟婆汤', () => {
          if (memoryCount === undefined || memoryCount === 0) {
            setNote('没有可清空的记忆');
            setPurgeAsk(false);
            return;
          }
          setPurgeAsk(true);
        }, { padding: '2px 10px', fontSize: 11, color: '#b91c1c' }),
        libButton('⚙', () => {
          setTab(tab === 'settings' ? 'home' : 'settings');
          setJudgeError('');
        }, {
          padding: '2px 7px', fontSize: 12, title: '设置：判定模型 key、影子模式、自检',
          borderColor: tab === 'settings' ? 'rgba(99,102,241,.55)' : undefined,
          background: tab === 'settings' ? 'rgba(99,102,241,.12)' : undefined,
        }),
        libButton('✕', props.onClose, { padding: '2px 8px', fontSize: 11, title: '关闭' }));

      // 清空确认：文案说清「先归档再清空」和「技能不受影响」，避免误以为连技能一起没了。
      const purgeBar = purgeAsk !== true
        ? null
        : h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            margin: '0 16px 10px', padding: '8px 10px', borderRadius: 8, fontSize: 11.5,
            color: '#b91c1c', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.3)',
          },
        },
          h('span', { style: { flex: '1 1 240px' } },
            '清空哪一档？先归档到 self-evolve/archive 再清空，技能一条不动。'),
          projectMemoryCount === 0
            ? null
            : libButton(purging ? '清空中…' : `清空项目 (${projectMemoryCount})`, () => purgeAction('project'), {
              padding: '1px 10px', fontSize: 11, color: '#b91c1c',
            }),
          globalMemoryCount === 0
            ? null
            : libButton(purging ? '清空中…' : `清空全局 (${globalMemoryCount})`, () => purgeAction('global'), {
              padding: '1px 10px', fontSize: 11, color: '#b91c1c',
            }),
          libButton('算了', () => setPurgeAsk(false), { padding: '1px 10px', fontSize: 11, color: 'inherit' }));

      // 判定模型：key 在界面里填，保存后写回 profile patch（与手改 yml 等价）。
      const judgeDecision = judge === undefined ? undefined : judge.decision;
      const judgeState = judgeDecision === undefined
        ? '读取中…'
        : judgeDecision.hasKey
          ? `已配置 ${judgeDecision.keyHint === '' ? '' : judgeDecision.keyHint}（${judgeDecision.keySource}）`
          : '未配置 key（判定不会生效）';
      // 最近一次判定：回答「它到底跑没跑过」，比只看「已配置 key」有用。
      const lastJudge = judge === undefined ? undefined : judge.lastJudgement;
      const lastJudgeText = lastJudge === undefined
        ? '尚无判定记录'
        : `${lastJudge.verdict === 'not-worth' ? '不值得' : lastJudge.verdict === 'degraded' ? '降级' : '值得'} ${typeof lastJudge.worth === 'number' ? lastJudge.worth.toFixed(2) : ''}${lastJudge.reason === undefined || lastJudge.reason === '' ? '' : `（${lastJudge.reason}）`} · ${String(lastJudge.at ?? '').slice(11, 16)}`;
      const probeText = judgeProbe === undefined
        ? ''
        : judgeProbe.verdict === 'degraded'
          ? `自检降级：${judgeProbe.reason}（${typeof judgeProbe.ms === 'number' ? judgeProbe.ms : '?'}ms 内没返回，本次按放行处理）`
          : `自检通过：值得 ${typeof judgeProbe.worth === 'number' ? judgeProbe.worth.toFixed(2) : '?'} · ${judgeProbe.scope === 'global' ? '全局' : judgeProbe.scope === 'project' ? '项目' : '未判档'} ${typeof judgeProbe.ms === 'number' ? `${judgeProbe.ms}ms` : ''}`;

      // 设置独立成一页：模型 key、影子模式、自检，都在这里改。
      const settingsPanel = h('div', {
            style: {
              marginTop: 6, padding: '8px 10px', borderRadius: 8, fontSize: 11.5,
              border: '1px solid ' + LIB_BORDER, display: 'flex', flexDirection: 'column', gap: 8,
            },
          },
            h('input', {
              type: 'password',
              value: judgeKey,
              placeholder: judgeDecision !== undefined && judgeDecision.hasKey
                ? '已保存过 key；要换就粘贴新的，留空表示不改'
                : '粘贴火山方舟 API Key（只保存在本机 profile 配置里）',
              onChange: (event) => setJudgeKey(event.target.value),
              style: Object.assign({}, LIB_INPUT, { marginBottom: 0 }),
            }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: judgeDecision?.shadow === true,
                  onChange: (event) => {
                    const next = event.target.checked;
                    setJudge((prev) => (prev === undefined ? prev : Object.assign({}, prev, {
                      decision: Object.assign({}, prev.decision, { shadow: next }),
                    })));
                  },
                }),
                '影子模式（只记录判定，不拦截写入）'),
              h('span', { style: { flex: '1 1 auto' } }),
              libButton(judgeBusy ? '保存中…' : '保存', () => saveJudgeAction(), { padding: '1px 10px', fontSize: 11 }),
              libButton('取消', () => setTab('home'), { padding: '1px 10px', fontSize: 11, color: 'inherit' })),
            judgeError === ''
              ? null
              : h('div', { style: { color: '#ef4444', fontSize: 11.5, lineHeight: 1.6 } }, judgeError),
            h('div', { style: { fontSize: 10.5, opacity: 0.5, lineHeight: 1.65 } },
              '保存后写进 profile 配置并重载插件；key 以明文存在 ~/.dsh/profiles/<profile>/cordis.patch.yml（文件权限 600）。'));

      // 单行、可省略：配置前后高度不变，避免切状态时整块面板跳一下。
      const judgeBar = h('div', { style: { padding: '0 16px 8px' } },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, opacity: 0.62,
            whiteSpace: 'nowrap', minWidth: 0,
          },
        },
          h('span', { style: { flex: '0 0 auto' } }, '判定模型'),
          h('span', {
            style: { opacity: 0.75, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
            title: judgeDecision === undefined ? '' : judgeState,
          }, judgeDecision === undefined
            ? '读取中…'
            : `${judgeDecision.shadow ? '影子模式' : '拦截'} · ${judgeState}`),
          h('span', {
            style: { opacity: 0.6, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto' },
            title: `最近：${lastJudgeText}`,
          }, `最近：${lastJudgeText}`),
          probeText === ''
            ? null
            : h('span', {
              style: {
                color: judgeProbe.verdict === 'degraded' ? '#b45309' : '#15803d',
                minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
              },
              title: probeText,
            }, probeText),
          h('span', { style: { flex: '1 1 auto' } }),
          libButton(probeBusy ? '自检中…' : '试一次', () => probeJudgeAction(), { padding: '0 8px', fontSize: 11 })));


      // 首页两栏：记忆 / 技能。点进去看明细，退回来还是一张总览。
      const tile = (key, icon, label, count, sub, accent, onPick, open) => h('button', {
        key,
        className: 'se-tile' + (open === true ? ' se-tile-on' : ''),
        onClick: onPick,
        style: { '--se-accent': accent },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', minWidth: 0 } },
          h('span', { style: { fontSize: 12.5, flex: '0 0 auto' } }, icon),
          h('span', { style: { fontSize: 11, fontWeight: 600, letterSpacing: 0.2, color: accent, flex: '0 0 auto' } }, label),
          h('span', { style: { flex: '1 1 auto', minWidth: 4 } }),
          h('span', { className: 'se-tile-num', style: { flex: '0 0 auto' } }, String(count))),
        h('div', { style: { fontSize: 10.5, opacity: 0.58, lineHeight: 1.5, minHeight: 15 } }, sub));

      // 只留「协议字数 / 自动整理」这类过程信息；条数已在卡片上，不重复。
      const capBit = data.memoryLimit > 0 ? `记忆上限 ${data.memoryLimit} 条` : '';
      const metaBits = [capBit, protocolText, auditText].filter((item) => typeof item === 'string' && item !== '');
      const metaLine = metaBits.length === 0
        ? null
        : h('div', {
          style: {
            fontSize: 10.5, opacity: 0.42, lineHeight: 1.6, marginTop: -4,
            fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word',
          },
          title: '自动整理每 6 小时最多一次；记忆到上限会淘汰最老的一条并归档原文',
        }, metaBits.join(' · '));

      // 决策模型的实时画像：直接从判断流水里算，不额外请求。
      const judgeRows = judgements.filter((row) => typeof row.ms === 'number');
      const avgMs = judgeRows.length === 0 ? undefined : Math.round(judgeRows.reduce((sum, row) => sum + row.ms, 0) / judgeRows.length);
      const worthRows = judgements.filter((row) => row.verdict === 'worth').length;
      const successRate = judgements.length === 0 ? undefined : Math.round((worthRows / judgements.length) * 100);
      const lastJudgeAt = judgements.length === 0 ? '' : judgementStamp(judgements[0].at);
      const modelName = judgeDecision?.model ?? 'Policy Brain';

      const homeTiles = h('div', { className: 'se-tiles' },
        tile('tile-memory', '🧠', '记忆', memoryCount,
          `全局 ${globalMemoryCount} · 项目 ${projectMemoryCount}`,
          '#2563eb', () => setTab('memory')),
        tile('tile-skill', '🛠', '技能', skillCount,
          skillCount === 0 ? '暂无技能' : `${lessons.length - memoryCount} 条经验 · ${skillCount} 个技能`,
          '#7c3aed', () => setTab('skill')),
        tile('tile-model', '🧭', '决策', judgements.length,
          `${modelName}${avgMs === undefined ? '' : ` · ${avgMs}ms`}${successRate === undefined ? '' : ` · ${successRate}%`}`,
          '#0ea5e9', () => setTab('log')));

      const emptyHint = h('div', {
        style: { padding: '22px 12px', fontSize: 12, lineHeight: 1.8, opacity: 0.6, textAlign: 'center' },
      }, tab === 'memory' ? '这个会话还没有记忆。' : '还没有沉淀过技能。');

      // 同一技能（同一 SKILL.md 路径）的多条经验聚成一张卡，而不是平铺成多行同名。
      const skillGroups = [];
      const skillGroupByPath = new Map();
      for (const lesson of skillLessons) {
        const key = lesson.path || lesson.title;
        let group = skillGroupByPath.get(key);
        if (group === undefined) {
          group = { name: lesson.title, path: key, entries: [] };
          skillGroupByPath.set(key, group);
          skillGroups.push(group);
        }
        group.entries.push(lesson);
      }
      const groupedSkillRows = skillGroups.map((group) => h(SkillGroup, {
        key: 'group:' + group.path,
        name: group.name,
        entries: group.entries,
        renderEntries: (list) => rowsOf(list),
      }));

      const collectionBody = tab === 'memory'
        ? (memoryLessons.length === 0 ? emptyHint : rowsOf(memoryLessons))
        : (skillLessons.length === 0 ? emptyHint : groupedSkillRows);

      // 头部 = 标题行（+ 接近上限时的一行说明）。
      const header = h('div', { style: { borderBottom: '1px solid ' + LIB_BORDER } },
        headerRow,
        purgeBar,
        capHint === null ? null : h('div', { style: { padding: '0 16px 10px' } }, capHint),
        judgeBar);

      // 失败提示条：保存/删除出错时顶部有明确的红条，而不是静默失败。
      const errorBar = error === ''
        ? null
        : h('div', {
          style: {
            margin: '10px 16px 0', padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.65,
            color: '#ef4444', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)',
            display: 'flex', alignItems: 'flex-start', gap: 8,
          },
        },
          h('span', { style: { flex: '1 1 auto', wordBreak: 'break-word' } }, error),
          libButton('知道了', () => setError(''), { padding: '1px 8px', fontSize: 11, color: 'inherit' }));

      const tileCss = h('style', { key: 'panel-css' }, PANEL_CSS);

      const panel = h('div', {
        ref: panelRef,
        onPointerDown: startDrag,
        onMouseDown: startDrag,
        title: '按住卡片任意处拖动',
        className: 'se-panel' + (judgeDecision?.hasKey === true ? ' se-ai' : ''),
        style: {
          width: 424, maxWidth: 'calc(100vw - 32px)',
          // 固定高度：切页（首页 ↔ 集合）时窗口不许跟着内容变，否则像在跳。
          height: 'min(460px, calc(100vh - 200px))',
          display: 'flex', flexDirection: 'column', color: PANEL_FG, borderRadius: 18,
          cursor: dragging ? 'grabbing' : 'grab',
          borderColor: dragging ? 'var(--dsw-alias-brand-primary, #3b82f6)' : undefined,
          overflow: 'hidden', animation: 'self-evolve-pop 200ms cubic-bezier(.22,1.2,.36,1)',
        },
      },
        tileCss,
        header,
        errorBar,
        h('div', { className: 'se-scroll', style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 14px 16px' } },
          tab === 'log'
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, judgementLogBlock)
            : tab === 'settings'
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, settingsPanel)
            : tab === 'home'
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              homeTiles,
              metaLine,
              proposalBlock,
              appliedBlock,
              healthBlock,
              ...statusNodes)
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              collectionBody)));

      // 就挂在桌宠头顶：不铺满、不模糊背景，聊天还能继续看。
      return h('div', {
        key: 'library',
        style: {
          position: 'fixed', right: pos.right, bottom: pos.bottom, zIndex: 63,
          pointerEvents: 'auto',
          animation: 'self-evolve-fade 140ms ease-out',
        },
      }, panel);
    }


    // -----------------------------------------------------------------------
    // 状态桥：会话层 → 整帧浮层
    //
    // `shell.overlay` 是 root 作用域，拿不到 `useChat`；而聊天数据只有会话层能读。
    // 所以聊天层（轮尾）只做「读快照 → 发布状态」，浮层（shell.overlay）只负责画。
    //
    // 这个 store 存的不是「一次性的结果」，而是**当前这一刻的展示状态**：重复发布
    // 同一个状态是幂等的，不会出现早先信箱方案那种「被别的 Turn 抢走」的问题。
    // -----------------------------------------------------------------------

    const overlayState = { current: undefined, listeners: new Set() };

    /**
     * 每个会话「见过的最大进化次数」。
     *
     * 快照可能只保留最近一段节点（长会话会裁剪），直接数会偏小；而沉淀次数只增
     * 不减，所以取见过的最大值做保底。刷新页面后靠快照重新数出来。
     */
    const sessionCounts = new Map();

    function rememberSessionCount(sessionId, count) {
      if (typeof count !== 'number' || count <= 0) return count;
      const key = sessionId === undefined ? '' : String(sessionId);
      const seen = sessionCounts.get(key) ?? 0;
      if (count > seen) {
        sessionCounts.set(key, count);
        return count;
      }
      return seen;
    }

    function publishOverlay(next) {
      if (sameOverlay(next, overlayState.current)) return;
      overlayState.current = next;
      for (const listener of [...overlayState.listeners]) {
        try {
          listener();
        } catch {
          // 单个订阅者出错不能拖垮发布。
        }
      }
    }

    function subscribeOverlay(listener) {
      overlayState.listeners.add(listener);
      return () => {
        overlayState.listeners.delete(listener);
      };
    }

    function sameOverlay(a, b) {
      if (a === b) return true;
      if (a === undefined || b === undefined) return false;
      return a.signature === b.signature
        && a.view === b.view
        && a.sessionId === b.sessionId
        && a.sessionCount === b.sessionCount
        && a.historySig === b.historySig
        && a.pendingTitle === b.pendingTitle
        && a.pendingKind === b.pendingKind
        && (a.mood === undefined ? '' : a.mood.at) === (b.mood === undefined ? '' : b.mood.at);
    }

    /**
     * 删/清空记忆也要有反应：桌宠缩一下、冒一团灰烟，说「忘掉啦」。
     *
     * 删除是最容易被忽略的动作（界面上只是少了一行），所以给它一个**可见的代价**。
     * 这不是装饰：用户需要确认「真的删了」，而不是怀疑自己点空了。
     */
    function announceForget(count) {
      const current = overlayState.current;
      if (current === undefined || current === null) return;
      const at = Date.now();
      publishOverlay(Object.assign({}, current, { mood: { kind: 'forget', count: count, at: at } }));
      setTimeout(() => {
        const latest = overlayState.current;
        if (latest === undefined || latest === null || latest.mood === undefined) return;
        if (latest.mood.at !== at) return;
        publishOverlay(Object.assign({}, latest, { mood: undefined }));
      }, 5200);
    }

    /** 订阅当前展示状态。 */
    function useOverlayState() {
      const [value, setValue] = useState(overlayState.current);
      useEffect(() => subscribeOverlay(() => setValue(overlayState.current)), []);
      return value;
    }

    /**
     * 纯函数：由快照信号决定这一轮轮尾该显示什么。抽出来是为了能在 node 里单测
     * ——「什么时候开始演、什么时候结束」是这个插件最容易写错的一半。
     *
     * @returns 'none' | 'waiting' | 'fresh' | 'replay' | 'settled'
     *   none    不显示（不是最后一轮 / 未收尾 / 没有结果）
     *   waiting 沉淀进行中（🧬 已出现、结果还没落完）→ 一直演，完成后才结束
     *   fresh   本次运行刚写入 → 演动画
     *   replay  刷新后补演末轮这一条
     *   settled 直接显示浅色台账
     */
    function decideView(input) {
      const { turn, recordTurn, closed, isLast, marker, writing, hasOutcome, fresh } = input;
      if (isLast !== true) return 'none';
      const settledHere = recordTurn === turn;
      // 沉淀中：标记已出现但本轮记录还没落完，**且本轮还没收尾**。
      // 收尾了还没有记录，说明这一轮最终决定「什么都不写」，动画必须停——
      // 否则卡片会永远卡在「经验沉淀中…」。
      const waiting = settledHere !== true && closed !== true && (marker !== undefined || writing === true);
      if (waiting) return 'waiting';
      if (closed !== true || hasOutcome !== true) return 'none';
      if (fresh === true) return 'fresh';
      if (settledHere) return 'replay';
      return 'settled';
    }

    // -----------------------------------------------------------------------
    // 全屏进化场景：独立一屏，占据整个画面
    // -----------------------------------------------------------------------

    const SCENE_HOLD_MS = 2000;

    /** 右下角小卡停留时长：足够看清写了什么，又不至于碍事。 */
    const DOCK_HOLD_MS = 3000;

    /**
     * 整屏台账：**只有用户点开时才会出现**（自动浮层是右下角的桌宠）。
     *
     * 这一屏负责「看清楚」：这次沉淀了什么、为什么触发、判定模型怎么说、
     * 有哪些旧结论被取代、本会话一共进化了几次。
     */
    function EvolutionScene(props) {
      const state = props.state;
      const outcome = state.outcome;
      const view = state.view;
      const signature = state.signature;
      const onClose = props.onClose;

      // 点开前是桌宠；点开（expanded）之后才铺满。
      const [expanded, setExpanded] = useState(state.view === 'settled');
      const [pinned, setPinned] = useState(state.view === 'settled');
      const [phase, setPhase] = useState(view === 'settled' ? 'settled' : 'burst');
      const [closing, setClosing] = useState(false);
      // 动画序列的单一控制器：每次触发先清掉旧定时器，再按 id 判定回调是否仍有效。
      // 否则连续沉淀两次时，第一次的 900ms 会把第二次正在演的 flash 按回 settled，
      // 表现为「第二次动画被截断」。
      const seqRef = useRef({ id: 0, timers: [] });
      const celebrate = () => {
        seqRef.current.timers.forEach((timer) => window.clearTimeout(timer));
        const id = seqRef.current.id + 1;
        seqRef.current = { id, timers: [] };
        const at = (fn, ms) => {
          const timer = window.setTimeout(() => {
            if (seqRef.current.id === id) fn();
          }, ms);
          seqRef.current.timers.push(timer);
        };
        setPhase('burst');
        at(() => setPhase('flash'), 260);
        at(() => setPhase('settled'), 1160);
      };
      useEffect(() => () => {
        seqRef.current.timers.forEach((timer) => window.clearTimeout(timer));
      }, []);
      // 台账也是桌宠的对话框：能拖、位置记住（和经验库共用同一个位置键）。
      const [pos, setPos] = useState(loadPanelPos);
      const [dragging, setDragging] = useState(false);
      const cardRef = usePanelDrag(pos, setPos, savePanelPos, setDragging);
      const startDrag = (event) => {
        const tag = event.target?.tagName?.toLowerCase?.() ?? '';
        if (tag === 'button' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'a') return;
        if (typeof event.button === 'number' && event.button !== 0) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setDragging(true);
        trackPanelDrag(event, { right: pos.right, bottom: pos.bottom }, setPos, (last, moved) => {
          setDragging(false);
          if (moved) savePanelPos(last);
        });
      };

      // 动画的触发源：Host 每次成功沉淀都会写 last-record.json（时间戳 + 条数），
      // 这里只比时间戳。以前靠解析工具卡片文本，返回结构一改或刷新页面就断。
      const SEEN_KEY = 'self-evolve:seen-record';
      const flashFromRecord = (live) => {
        const record = live?.lastRecord;
        let seen = 0;
        try {
          seen = Number(window.localStorage?.getItem(SEEN_KEY) ?? '0') || 0;
        } catch {
          seen = 0;
        }
        if (!shouldFlash(record, seen, BOOT_AT)) return false;
        try {
          window.localStorage?.setItem(SEEN_KEY, String(record.atMs));
        } catch {
          // 存不下就这一次演，下次再说。
        }
        return true;
      };

      // 记录里的数字是**当时**的，存下来就不会自愈：面板打开时现取一次。
      const [liveTotals, setLiveTotals] = useState(undefined);
      useEffect(() => {
        if (outcome === undefined) return undefined;
        let alive = true;
        requestLessons(props.sessionId).then((value) => {
          if (!alive) return;
          const lessons = Array.isArray(value.lessons) ? value.lessons : [];
          const stats = value.stats === undefined || value.stats === null ? undefined : value.stats;
          // 优先用 Host 的统计：它分得清「插件自建的技能」和「技能目录里的全部技能」，
          // 自己数 lessons 会把用户自己的技能也算进去（曾经显示成 38 个）。
          // 注意：这里**不许**领记录（flashFromRecord）——它会把记录标成已看，
          // 轮询随后就认为「演过了」，用户看到的就成了「记完了但没反馈」。
          setLiveTotals({
            memory: stats !== undefined && typeof stats.memoryEntries === 'number'
              ? stats.memoryEntries
              : lessons.filter((item) => item.kind === 'memory').length,
            memoryLimit: value.memoryLimit,
            skills: stats !== undefined && typeof stats.skills === 'number'
              ? stats.skills
              : lessons.filter((item) => item.kind === 'skill').length,
            memoryBytes: stats === undefined ? undefined : stats.memoryBytes,
            memoryBytesLimit: stats === undefined ? undefined : stats.memoryBytesLimit,
          });
        }).catch(() => {
          // 取不到就退回快照，界面上会标注「（记录时）」——不能让旧数字冒充当前值。
        });
        return () => {
          alive = false;
        };
      }, [props.sessionId, signature]);

      // 独立轮询：动画**不能**依赖 outcome。对话里没解析出工具卡片时（正是原先
      // 「经验写进去了但桌宠不动」的原因），上面那个 effect 会直接 return，
      // 动画就永远没机会触发。这里按 last-record 的时间戳自己转。
      useEffect(() => {
        let alive = true;
        const tick = () => {
          requestLessons(props.sessionId).then((value) => {
            if (!alive) return;
            if (flashFromRecord(value)) celebrate();
          }).catch((error) => {
            // 取不到就等下一轮；但必须留痕，否则「动画不响」永远查不到原因。
            console.warn('[self-evolve] 轮询失败', error);
          });
        };
        tick();
        const timer = window.setInterval(tick, 2000);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [props.sessionId]);

      const isRepeat = typeof props.sessionCount === 'number' && props.sessionCount >= 1;
      // 自动出现的浮层一律是桌宠；用户点开才升成整屏。
      const compact = props.compactOnly === true ? !expanded : (isRepeat && !expanded);
      const compactRef = useRef(compact);
      compactRef.current = compact;

      // 新一轮沉淀开始时，把上一轮点开的整屏状态清掉。
      const seenSignature = useRef(signature);
      useEffect(() => {
        if (seenSignature.current === signature) return;
        seenSignature.current = signature;
        if (view === 'waiting') {
          setExpanded(false);
          setPinned(false);
          setClosing(false);
        }
      }, [signature, view]);

      useEffect(() => {
        // 正在演庆祝序列时，签名/视图变化不许抢方向盘——否则 flash 刚亮起就被
        // 这个 effect 按回 settled，用户看到的就是「没有庆祝动画」。
        if (seqRef.current.timers.length > 0) return undefined;
        if (view === 'waiting') {
          setPhase('burst');
          return undefined;
        }
        if (view === 'settled') {
          setPhase('settled');
          return undefined;
        }
        setPhase('flash');
        const timer = setTimeout(() => setPhase('settled'), compactRef.current ? 620 : FLASH_MS);
        return () => clearTimeout(timer);
      }, [signature, view]);

      // 桌宠**不会自己走**：它待在那里，只是把气泡收起来（说完了就不唠叨）。
      const settled = phase !== 'burst';
      const [bubbleMuted, setBubbleMuted] = useState(false);
      useEffect(() => {
        if (phase === 'burst') {
          setBubbleMuted(false);
          return undefined;
        }
        if (settled !== true) return undefined;
        // 整屏是用户点开的，气泡不自动收；桌宠说完了就把气泡淡掉，本体留着。
        if (compactRef.current !== true) return undefined;
        const timer = setTimeout(() => setBubbleMuted(true), 12000);
        return () => clearTimeout(timer);
      }, [settled, phase, signature]);

      useEffect(() => {
        if (compact) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') onClose?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [compact, onClose]);

      // ---- 桌宠形态 -------------------------------------------------------
      if (compact) {
        return h('div', { key: 'pet-root-wrap' },
          h(Keyframes),
          h(EvolutionPet, {
            phase,
            muted: bubbleMuted,
            count: typeof props.sessionCount === 'number' ? props.sessionCount : 0,
            entries: outcome === undefined ? [] : outcome.entries,
            pendingTitle: props.pendingTitle,
            outcome,
            closing,
            onExpand: () => {
              setExpanded(true);
              setPinned(true);
              setClosing(false);
            },
            onHide: () => {
              setClosing(true);
              if (typeof props.onHide === 'function') props.onHide();
            },
          }));
      }

      // ---- 整屏形态 -------------------------------------------------------
      const entries = outcome === undefined ? [] : outcome.entries;
      const count = entries.length;
      const trigger = outcome === undefined ? undefined : outcome.trigger;
      const judgement = outcome === undefined ? undefined : outcome.judgement;

      const evictedAll = entries.flatMap((entry) => (Array.isArray(entry.evicted) ? entry.evicted : []));
      const archivePath = entries.map((entry) => entry.archivePath).find((path) => typeof path === 'string' && path.length > 0);
      const supersededOnly = entries.length > 0 && entries.every((entry) => entry.evictedBy === 'superseded');
      const evictedNote = evictedAll.length === 0
        ? null
        : h('div', {
          style: { fontSize: 11.5, opacity: 0.75, marginTop: 8, lineHeight: 1.6 },
          title: archivePath,
        },
          supersededOnly
            ? `${evictedAll.length} 条旧结论被新结论取代，原文进归档（不是删除）：`
            : `记忆已满，最老的 ${evictedAll.length} 条挪进归档（不是删除）：`,
          evictedAll.map((item) => item.title).filter((title) => title.length > 0).join(' · '),
          archivePath === undefined ? '' : ` → ${archivePath}`);

      const rows = entries.map((entry, index) => {
        // 「优化了已有技能」必须看得出来：绿标后面直接跟「更新 · 第 3 条」，
        // 新建才是「新建」。只回一个 kind:'skill' 的话，两种动作在卡片上完全一样。
        const updated = entry.kind === 'skill' && entry.action === 'update';
        const verb = entry.kind !== 'skill'
          ? null
          : h('span', {
            style: {
              flex: '0 0 auto', fontSize: 10.5, lineHeight: '16px', padding: '0 6px', borderRadius: 6,
              background: updated ? 'rgba(34,197,94,0.22)' : 'rgba(148,163,184,0.18)',
              border: '1px solid ' + (updated ? 'rgba(34,197,94,0.45)' : 'rgba(148,163,184,0.32)'),
              color: updated ? '#15803d' : '#475569', fontWeight: 600,
            },
            title: updated
              ? `这是对已有技能的追加：条数 ${entry.previousEntries ?? '?'} → ${entry.entries ?? '?'}`
              : '这是新建的技能文件',
          }, updated
            ? `更新 · 第 ${entry.entries === undefined ? '?' : entry.entries} 条`
            : '新建');
        const title = entry.kind === 'skill' && entry.skillName !== ''
          ? entry.skillName
          : (entry.title === '' ? '（未命名）' : entry.title);
        return h('div', {
          key: 'row' + index,
          style: { marginTop: index === 0 ? 10 : 8, textAlign: 'left' },
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 } },
            h('span', {
              style: {
                flex: '0 0 auto', fontSize: 10.5, lineHeight: '16px', padding: '0 6px', borderRadius: 6,
                background: entry.kind === 'skill' ? 'rgba(34,197,94,0.14)' : 'rgba(59,130,246,0.14)',
                border: '1px solid ' + (entry.kind === 'skill' ? 'rgba(34,197,94,0.30)' : 'rgba(59,130,246,0.30)'),
              },
            }, entry.kind === 'skill' ? '技能' : '记忆'),
            verb,
            h('span', { style: { fontWeight: 600 } }, title)),
          // 技能追加时把「这次学到的那条」写出来，否则只看到技能名，不知道加了什么。
          entry.kind === 'skill' && entry.skillName !== '' && entry.title !== ''
            ? h('div', { style: { fontSize: 11.5, opacity: 0.78, marginTop: 2, marginLeft: 2 } }, '追加：' + entry.title)
            : null,
          entry.path === '' ? null : h('div', {
            style: { fontSize: 11, opacity: 0.6, marginTop: 2, marginLeft: 2 },
          }, entry.path));
      });

      const body = h('div', {
        ref: cardRef,
        onClick: (event) => event.stopPropagation(),
        onPointerDown: startDrag,
        onMouseDown: startDrag,
        title: '按住卡片任意处拖动',
        style: {
          position: 'relative', width: 392, maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 250px)', display: 'flex', flexDirection: 'column',
          borderRadius: 18, textAlign: 'center',
          backgroundColor: PANEL_BASE, backgroundImage: PANEL_SHEEN,
          border: '1px solid ' + FALLBACK.border,
          boxShadow: '0 22px 54px rgba(15,23,42,0.24)',
          overflow: 'hidden',
          animation: 'self-evolve-pop 200ms cubic-bezier(.22,1.2,.36,1)',
        },
      },
        h('div', {
          style: {
            position: 'absolute', inset: 0, borderRadius: 18, pointerEvents: 'none',
            background: 'linear-gradient(130deg, rgba(59,130,246,0.10), rgba(124,58,237,0.07) 60%, transparent)',
          },
        }),
        // 标题栏就是拖拽把手：跟经验库卡片同一套手感。
        h('div', {
          title: '按住拖动卡片',
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 12px', borderBottom: '1px solid ' + FALLBACK.border,
            cursor: 'grab', touchAction: 'none', userSelect: 'none', textAlign: 'left',
          },
        },
          h('span', {
            style: {
              width: 18, height: 18, borderRadius: '50%', flex: '0 0 auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10,
              background: phase === 'burst' ? 'rgba(124,58,237,0.14)' : 'rgba(34,197,94,0.16)',
              border: '1px solid ' + (phase === 'burst' ? 'rgba(124,58,237,0.3)' : 'rgba(34,197,94,0.32)'),
            },
          }, phase === 'burst' ? '🧬' : '✓'),
          h('span', { style: { fontSize: 13, fontWeight: 700, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            phase === 'burst' ? '经验沉淀中…' : (count === 0 ? '这次没有写入' : `最近一次沉淀 ${count} 条经验`)),
          h('button', {
            type: 'button',
            onClick: () => onClose?.(),
            title: '关闭（Esc）',
            style: {
              flex: '0 0 auto', width: 22, height: 22, padding: 0, borderRadius: 6, cursor: 'pointer',
              border: 'none', background: 'transparent', color: PANEL_FG, opacity: 0.5, fontSize: 14, lineHeight: '20px',
            },
          }, '×')),
        h('div', { style: { position: 'relative', overflowY: 'auto', padding: '12px 14px 12px' } },
          typeof props.sessionCount === 'number' && props.sessionCount > 1
            ? h('div', { style: { fontSize: 11.5, opacity: 0.55, textAlign: 'center' } }, `本会话第 ${props.sessionCount} 次进化`)
            : null,
          phase !== 'burst' && count === 0
            ? h('div', { style: { marginTop: 8, fontSize: 12.5, opacity: 0.7, textAlign: 'center' } }, '这次没有新条目：判定为已有的重复结论')
            : null,
          // 正在写哪一条：比一句「沉淀中…」有用得多。
          phase !== 'burst' || typeof props.pendingTitle !== 'string' || props.pendingTitle === ''
            ? null
            : h('div', { style: { marginTop: 8, fontSize: 12.5, opacity: 0.85 } },
              `正在写入：${props.pendingTitle}`),
          phase !== 'burst'
            ? null
            : h('div', { style: { marginTop: 8, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, fontSize: 11.5, opacity: 0.75 } },
              ...(props.pendingKind === 'both' ? ['记忆', '技能'] : [props.pendingKind === 'skill' ? '技能' : '记忆'])
                .map((label, index) => [
                  index === 0 ? null : h('span', { key: 'arrow' + label, style: { opacity: 0.6 } }, '→'),
                  h('span', {
                    key: 'k' + label,
                    style: {
                      padding: '0 7px', borderRadius: 999, lineHeight: '18px',
                      border: '1px solid rgba(124,58,237,0.28)', background: 'rgba(124,58,237,0.08)',
                    },
                  }, label),
                ]).flat().filter(Boolean),
              h('span', { style: { opacity: 0.6 } }, '→ 统计')),
          phase !== 'burst'
            ? null
            : h('div', { style: { marginTop: 10, fontSize: 11.5, opacity: 0.6 } },
              '写入完成后会自动统计累计数量'),
          trigger === undefined
            ? null
            : h('div', {
              style: { marginTop: 8, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, fontSize: 11.5, opacity: 0.8 },
            },
              h('span', { style: { opacity: 0.7 } }, '触发原因'),
              h('span', {
                style: {
                  padding: '0 6px', borderRadius: 999, fontSize: 10.5, lineHeight: '16px',
                  border: '1px solid rgba(124,58,237,0.28)', background: 'rgba(124,58,237,0.08)',
                },
                title: triggerTagTitle(trigger),
              }, triggerTag(trigger)),
              h('span', null, describeTrigger(trigger))),
          judgement === undefined
            ? null
            : h('div', { style: { marginTop: 6, fontSize: 11.5, opacity: 0.72 } },
              `判定${judgement.verdict === 'worth' ? '值得' : '不值得'}（${Number(judgement.worth).toFixed(2)}）`,
              judgement.scope === undefined ? '' : ` · 建议${judgement.scope === 'global' ? '全局' : '项目'} ${Number(judgement.confidence).toFixed(2)}`,
              judgement.shadow === true ? ' · 影子模式，未拦截' : '',
              typeof judgement.ms === 'number' ? ` · ${judgement.ms}ms` : ''),
          rows.length === 0 ? null : h('div', { style: { marginTop: 6 } }, rows),
          evictedNote,
          h(Totals, {
            live: liveTotals,
            total: outcome === undefined ? props.total : outcome.total,
            sessionCount: props.sessionCount,
            border: FALLBACK.border,
          }),
          props.history === undefined
            ? null
            : h(HistoryList, { history: props.history, border: FALLBACK.border }),
          h('div', { style: { marginTop: 12, display: 'flex', justifyContent: 'center', gap: 10 } },
            h('button', {
              type: 'button',
              onClick: () => props.onOpenLibrary?.(),
              style: {
                padding: '6px 12px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer',
                border: '1px solid ' + FALLBACK.border, background: 'rgba(127,127,127,0.06)', color: PANEL_FG,
              },
            }, '查看全部经验 · 可编辑')),
          h('div', {
            style: { marginTop: 10, fontSize: 11, opacity: 0.5 },
          }, '拖标题栏可移动 · Esc 关闭')));



      // 卡片挂在桌宠头顶，桌宠在旁边笑——不是整屏弹层。
      return [
        h(Keyframes, { key: 'ledger-keyframes' }),
        h('div', {
          key: 'ledger-card',
          style: {
            position: 'fixed', right: pos.right, bottom: pos.bottom, zIndex: 9999,
            pointerEvents: 'auto',
            animation: closing ? 'self-evolve-fade-out 200ms ease-in forwards' : 'self-evolve-fade 140ms ease-out',
          },
        }, body),
        h(EvolutionPet, {
          key: 'ledger-pet',
          mood: 'smile',
          phase: 'settled',
          count: typeof props.sessionCount === 'number' ? props.sessionCount : 0,
          entries: [],
          pendingTitle: '',
          closing: false,
          onExpand: () => onClose?.(),
          onHide: () => {
            if (typeof props.onHide === 'function') props.onHide();
            else onClose?.();
          },
        }),
      ];
    }

    /**
     * 桌宠：沉淀这件事的「人形」。
     *
     * 为什么不再用卡片：卡片只能表达「有进度」，而桌面宠物能表达**情绪**——
     * 它在写东西、写完了很高兴、闲着的时候会打哈欠。同一件事，记忆点是卡片的一百倍。
     *
     * 状态全部由 `phase` 驱动，不自己计时：
     *   burst   → 低头写（铅笔抖动 + 眼成两条线 + 嘴抿成小圆 + 环在转）
     *   flash   → 高兴跳一下（嘴张大 + 眼睛变 ^ ^ + 星星）
     *   settled → 平静，气泡里报「记了几条」
     */
    function EvolutionPet(props) {
      const phase = props.phase ?? 'burst';
      const writing = phase === 'burst';
      const settled = phase !== 'burst';
      const happy = phase === 'flash';
      const closing = props.closing === true;
      const idle = props.idle === true;
      const forgetting = props.mood === 'forget';
      const thinking = props.mood === 'think';
      const smiling = props.mood === 'smile';
      // 说完了就把气泡收起，但**本体留着**——桌宠是不会下班的。
      const muted = props.muted === true || (idle && props.count === undefined);
      const count = typeof props.count === 'number' ? props.count : 0;
      const entries = Array.isArray(props.entries) ? props.entries : [];
      const pendingTitle = typeof props.pendingTitle === 'string' ? props.pendingTitle : '';
      const newest = entries.length > 0 ? entries[0] : undefined;

      // 拖得动，位置记在本地：桌宠被人挪走之后不该自己跳回去。
      const [pos, setPos] = useState(loadPetPos);
      // 按住时换成「被拎起来」的姿态；长时间没人管就睡着，被碰到或来了新事件再醒。
      const [dragging, setDragging] = useState(false);
      const [asleep, setAsleep] = useState(false);
      const [waking, setWaking] = useState(false);
      // 右键菜单：手动把形象钉在某个动作上（对应 dsh-pet 的「切换动作」）。
      const [pinned, setPinned] = useState(undefined);
      const [menuOpen, setMenuOpen] = useState(false);
      const wakeTimer = useRef(undefined);
      // 时长可注入：线上是 3 分钟 / 1.5 秒，测试能压到几十毫秒。
      const sleepAfterMs = typeof props.sleepAfterMs === 'number' ? props.sleepAfterMs : 180000;
      const wakeMs = typeof props.wakeMs === 'number' ? props.wakeMs : 1500;

      const wakeUp = () => {
        if (!asleep) return;
        setAsleep(false);
        setWaking(true);
        if (wakeTimer.current !== undefined) clearTimeout(wakeTimer.current);
        wakeTimer.current = setTimeout(() => {
          setWaking(false);
          wakeTimer.current = undefined;
        }, wakeMs);
      };

      useEffect(() => () => {
        if (wakeTimer.current !== undefined) clearTimeout(wakeTimer.current);
      }, []);

      // 睡着条件：真的闲着（没有在写/在庆祝/在想/在忘/在拖/在醒），静置 3 分钟。
      const canSleep = idle === true && writing !== true && happy !== true && thinking !== true
        && forgetting !== true && smiling !== true && dragging !== true && waking !== true
        && (typeof pinned !== 'string' || pinned === '');
      useEffect(() => {
        if (canSleep !== true || asleep) return undefined;
        const timer = setTimeout(() => setAsleep(true), sleepAfterMs);
        return () => clearTimeout(timer);
      }, [canSleep, asleep, sleepAfterMs]);

      // 来了新的沉淀事件，把它叫醒：睡着时也得把「记住啦」说完。
      // 顺手解除手动钉住——真有事发生了，就该演真的。
      useEffect(() => {
        wakeUp();
        setPinned(undefined);
      }, [props.count, props.phase]);

      // 点别处 / Esc 关掉右键菜单。
      useEffect(() => {
        if (menuOpen !== true) return undefined;
        // 点在菜单自己身上不能关：capture 阶段就关掉的话，click 还没派发元素已经没了，
        // 表现就是「菜单看得见、点不动」。
        const close = (event) => {
          const target = event === undefined ? undefined : event.target;
          if (target !== undefined && target !== null && typeof target.closest === 'function'
            && target.closest('.self-evolve-pet-menu') !== null) return;
          setMenuOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setMenuOpen(false);
        };
        window.addEventListener('pointerdown', close, true);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('pointerdown', close, true);
          window.removeEventListener('keydown', onKey);
        };
      }, [menuOpen]);

      const onPointerDown = (event) => {
        if (typeof event.button === 'number' && event.button !== 0) return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        wakeUp();
        setDragging(true);
        trackPanelDrag(event, { right: pos.right, bottom: pos.bottom }, setPos, (last, moved) => {
          setDragging(false);
          if (moved) savePetPos(last);
          // 没拖动就是「点了一下」：展开台账。
          else if (typeof props.onExpand === 'function') props.onExpand();
        });
      };

      // 想事情的时候不挂气泡：脑袋上已经顶着灯泡了，别再加一块白板。
      const showBubble = idle !== true && muted !== true && thinking !== true && smiling !== true
        && asleep !== true;
      const bubble = forgetting
        ? {
          title: `忘掉啦 · ${count} 条`,
          detail: '进归档了，不是消失',
          tone: 'forget',
        }
        : writing
        ? {
          title: '记一下…',
          detail: pendingTitle === '' ? '正在写进记忆' : pendingTitle,
          tone: 'busy',
        }
        : {
          // `count` 是**本会话第几次进化**，不是条数：写成「8 条」会被读成记忆里一共 8 条。
          // 数不出来（老记录的工具结果当时是 error，快照里认不出来）就只说「记住啦」，
          // 不显示「第 0 次」这种明显是坏了的数字。
          title: count > 0 ? `记住啦 · 本会话第 ${count} 次` : '记住啦',
          detail: newest === undefined
            ? ''
            : newest.kind === 'skill' && newest.action === 'update'
              // 技能被「优化」而不是新建：把动作写进气泡，用户一眼能核对。
              ? `更新技能 ${newest.skillName === '' ? newest.title : newest.skillName} · 第 ${newest.entries ?? '?'} 条`
              : newest.kind === 'skill'
                ? `新建技能 ${newest.skillName === '' ? newest.title : newest.skillName}`
                : `${entries.length} 条｜记忆｜${newest.title}`,
          tone: 'done',
        };

      const PET_MENU = [
        ['跟随状态', ''],
        ['待机', 'idle'],
        ['思考', 'think'],
        ['沉淀成功', 'happy'],
        ['遗忘', 'forget'],
        ['睡觉', 'sleep'],
        ['醒来', 'wake'],
      ];
      const menuItem = (label, value) => h('button', {
        key: `pet-menu-${value === '' ? 'auto' : value}`,
        type: 'button',
        className: 'self-evolve-pet-menu-item',
        onClick: (event) => {
          event.stopPropagation();
          setPinned(value === '' ? undefined : value);
          setMenuOpen(false);
        },
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '6px 9px', borderRadius: 8, border: 'none',
          background: (pinned ?? '') === value ? 'rgba(124,58,237,0.12)' : 'transparent',
          color: PANEL_FG, fontSize: 12, lineHeight: '16px', textAlign: 'left',
          cursor: 'pointer',
        },
      }, h('span', null, label), (pinned ?? '') === value ? h('span', { style: { fontSize: 11, opacity: 0.7 } }, '✓') : null);

      return h('div', {
        key: 'pet-root',
        className: 'self-evolve-pet-wrap',
        onContextMenu: (event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen((value) => !value);
        },
        style: {
          position: 'fixed',
          right: pos.right,
          bottom: pos.bottom,
          zIndex: 9998,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
          pointerEvents: 'auto',
          opacity: closing ? 0 : 1,
          transform: closing ? 'translateY(8px) scale(0.94)' : 'none',
          transition: 'opacity 240ms ease-out, transform 240ms ease-out',
          animation: 'self-evolve-pet-in 380ms cubic-bezier(.22,1.2,.36,1)',
        },
      },
        // 待机时挂一枚计数徽标：不点开也知道「攒了几条」。
        idle === true && typeof props.count === 'number' && props.count > 0
          ? h('div', {
            style: {
              position: 'absolute', right: 8, top: -2, minWidth: 19, padding: '1px 5px',
              borderRadius: 999, fontSize: 11, lineHeight: '16px', textAlign: 'center',
              background: 'rgba(124,58,237,0.92)', color: '#fff',
              boxShadow: '0 3px 8px rgba(124,58,237,0.35)',
            },
          }, String(props.count))
          : null,
        // 气泡：说的话比「已沉淀 N 条」这种报表口吻亲切得多。
        showBubble ? h('div', {
          onClick: (event) => {
            event.stopPropagation();
            if (typeof props.onExpand === 'function') props.onExpand();
          },
          style: {
            position: 'relative', maxWidth: 232,
            padding: '9px 12px 10px', borderRadius: 14,
            background: PANEL_BG,
            border: '1px solid ' + (bubble.tone === 'busy'
              ? 'rgba(124,58,237,0.30)'
              : bubble.tone === 'forget' ? 'rgba(148,163,184,0.55)' : 'rgba(34,197,94,0.34)'),
            boxShadow: '0 10px 26px rgba(15,23,42,0.16)',
            cursor: 'pointer',
            animation: 'self-evolve-bubble-in 260ms ease-out',
          },
        },
          h('div', { style: { fontSize: 12, fontWeight: 700, color: PANEL_FG, whiteSpace: 'nowrap' } }, bubble.title),
          bubble.detail === ''
            ? null
            : h('div', {
              style: {
                marginTop: 3, fontSize: 11.5, lineHeight: 1.5, opacity: 0.72, color: PANEL_FG,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              },
            }, bubble.detail),
          // 气泡的小尖角：朝向宠物。
          h('div', {
            style: {
              position: 'absolute', right: 22, bottom: -5, width: 9, height: 9,
              background: PANEL_BG,
              borderRight: '1px solid ' + (bubble.tone === 'busy'
                ? 'rgba(124,58,237,0.30)'
                : bubble.tone === 'forget' ? 'rgba(148,163,184,0.55)' : 'rgba(34,197,94,0.34)'),
              borderBottom: '1px solid ' + (bubble.tone === 'busy'
                ? 'rgba(124,58,237,0.30)'
                : bubble.tone === 'forget' ? 'rgba(148,163,184,0.55)' : 'rgba(34,197,94,0.34)'),
              transform: 'rotate(45deg)',
            },
          })) : null,
        h('div', { style: { position: 'relative', width: 136, height: 120 } },
          // 写的时候身后转一圈进度弧，写完就消失。
          writing && idle !== true
            ? h('div', { style: { position: 'absolute', inset: 2, opacity: 0.9 } },
              h('div', { style: { position: 'absolute', inset: 0, animation: 'self-evolve-ring-pulse 1600ms ease-in-out infinite' } },
                h(EvolveSpinner, { size: 132, stroke: 3, spin: 1200, arc: '#a78bfa', track: 'rgba(124,58,237,0.10)' })))
            : null,
          // 沉淀中：身上升起记忆碎片（6 颗，错开时间与横向偏移，避免整齐得像列队）。
          writing && idle !== true
            ? h('div', { style: { position: 'absolute', inset: 0, pointerEvents: 'none' } },
              [0, 1, 2, 3, 4, 5].map((index) => h('span', {
                key: `mote-${index}`,
                className: 'self-evolve-pet-mote',
                style: {
                  position: 'absolute',
                  left: [38, 62, 50, 72, 30, 56][index],
                  bottom: [26, 34, 46, 20, 38, 52][index],
                  fontSize: [10, 12, 9, 11, 10, 13][index],
                  color: '#a78bfa',
                  '--se-dx': `${[-10, 8, -4, 12, -12, 6][index]}px`,
                  animation: `self-evolve-pet-mote ${[1900, 2200, 1700, 2400, 2100, 1850][index]}ms `
                    + `cubic-bezier(.22,.8,.3,1) ${[0, 320, 640, 180, 900, 1100][index]}ms infinite`,
                },
              }, ['✦', '✧', '·', '✦', '✧', '·'][index])),
            )
            : null,
          // 想事情：头顶一颗会亮的灯泡。
          thinking
            ? h('div', {
              style: {
                position: 'absolute', right: 2, top: -10,
                fontSize: 17, lineHeight: '18px', pointerEvents: 'none',
                animation: 'self-evolve-pet-bulb 1600ms ease-in-out infinite',
              },
            }, '💡')
            : null,
          // 忘掉时：头顶冒一团灰烟散开，身体缩一下。
          forgetting
            ? h('div', {
              style: {
                position: 'absolute', inset: 0, pointerEvents: 'none',
                animation: 'self-evolve-pet-forget 620ms ease-out',
              },
            },
              h('span', { style: { position: 'absolute', left: 26, top: 8, fontSize: 12, opacity: 0.8 } }, '💨'))
            : null,
          // 完成时炸三颗星星（一次性）。
          happy
            ? h('div', { style: { position: 'absolute', inset: 0, pointerEvents: 'none', animation: 'self-evolve-pet-stars 620ms ease-out forwards' } },
              h('span', { style: { position: 'absolute', left: 2, top: 20, fontSize: 13 } }, '✦'),
              h('span', { style: { position: 'absolute', right: 4, top: 10, fontSize: 11 } }, '✦'),
              h('span', { style: { position: 'absolute', right: 12, bottom: 18, fontSize: 12 } }, '✧'))
            : null,
          h(PetBody, {
            writing: writing && forgetting !== true,
            settled,
            happy,
            forgetting,
            thinking,
            smiling,
            dragging,
            sleeping: asleep,
            waking,
            pinned,
            onPointerDown,
            onMouseDown: onPointerDown,
          }),
          menuOpen
            ? h('div', {
              className: 'self-evolve-pet-menu',
              onPointerDown: (event) => event.stopPropagation(),
              style: {
                position: 'absolute', right: 0, bottom: '100%', marginBottom: 8,
                width: 128, padding: 4, borderRadius: 12,
                background: PANEL_BG, border: '1px solid ' + FALLBACK.border,
                boxShadow: '0 14px 34px rgba(15,23,42,0.20)', zIndex: 3,
                display: 'flex', flexDirection: 'column', gap: 1,
                animation: 'self-evolve-bubble-in 140ms ease-out',
              },
            }, PET_MENU.map(([label, value]) => menuItem(label, value)))
            : null,
          // 隐藏：只在悬停时出现，不打扰。
          h('button', {
            type: 'button',
            className: 'self-evolve-pet-hide',
            title: '隐藏桌宠（可在设置里恢复）',
            onClick: (event) => {
              event.stopPropagation();
              if (typeof props.onHide === 'function') props.onHide();
            },
            style: {
              position: 'absolute', right: -6, top: -6, width: 18, height: 18, padding: 0,
              borderRadius: 999, border: '1px solid ' + FALLBACK.border,
              background: PANEL_BG, color: PANEL_FG, fontSize: 11, lineHeight: '16px',
              cursor: 'pointer', opacity: 0, transition: 'opacity 160ms ease-out',
            },
          }, '×')));
    }

    /**
     * 宠物形象：dsh-pet 的 Q 版角色（MIT，见 assets/pet/）。
     *
     * 形象外包给图片，状态语义仍归我们：思考/开心/遗忘/待机各一张 GIF，
     * 图片加载失败就退回下面那颗手绘史莱姆——形象不能成为新的故障点。
     */
    const PET_FRAME_BASE = '/api/self-evolve/pet';
    // 素材换过版本就改这个数字：图片是按 URL 缓存的（max-age 一天），
    // 不改 query 的话换了文件，浏览器还会拿旧的那张。
    const PET_ASSET_VERSION = '4';

    function PetBody(props) {
      // 状态优先级：手动钉住 > 刚睡醒 > 按住 > 睡着 > 忘掉 > 沉淀成功 > 思考 > 待机。
      const state = typeof props.pinned === 'string' && props.pinned !== ''
        ? props.pinned
        : props.waking === true
          ? 'wake'
          : props.dragging === true
            ? 'drag'
            : props.sleeping === true
              ? 'sleep'
              : props.forgetting === true
                ? 'forget'
                : props.happy === true
                  ? 'happy'
                  : props.thinking === true
                    ? 'think'
                    : 'idle';
      const [failed, setFailed] = useState(false);
      if (failed) return h(PetBodySvg, props);
      return h('img', {
        src: `${PET_FRAME_BASE}/${state}.webp?v=${PET_ASSET_VERSION}`,
        alt: '',
        draggable: false,
        onError: () => setFailed(true),
        onPointerDown: props.onPointerDown,
        onMouseDown: props.onMouseDown,
        style: {
          display: 'block', width: 136, height: 120, margin: '0 auto',
          objectFit: 'contain', objectPosition: 'center bottom',
          cursor: 'grab', touchAction: 'none', userSelect: 'none',
          WebkitUserDrag: 'none',
          // GIF 自带呼吸；只保留「沉淀成功」的跳一下和醒来的轻微弹起。
          animation: props.happy === true
            ? 'self-evolve-pet-hop 560ms ease-out'
            : props.waking === true ? 'self-evolve-pet-hop 420ms ease-out' : undefined,
        },
      });
    }

    /** 兜底形象：一颗蓝绿色的小史莱姆。纯 SVG，不依赖任何图片资源。 */
    function PetBodySvg(props) {
      const eyesClosed = props.writing === true;
      const happy = props.happy === true;
      const forgetting = props.forgetting === true;
      const thinking = props.thinking === true;
      const smiling = props.smiling === true;
      return h('svg', {
        width: 76, height: 76, viewBox: '0 0 100 100',
        onPointerDown: props.onPointerDown,
        onMouseDown: props.onMouseDown,

        style: {
          display: 'block', width: 76, height: 76, margin: '0 auto',
          cursor: 'grab', touchAction: 'none',
          animation: happy
            ? 'self-evolve-pet-hop 560ms ease-out'
            : (props.writing === true
              ? 'self-evolve-pet-bob 900ms ease-in-out infinite'
              : 'self-evolve-pet-bob 2600ms ease-in-out infinite'),
        },
      },
        h('defs', null,
          h('linearGradient', { id: 'self-evolve-pet-body', x1: '0%', y1: '0%', x2: '30%', y2: '100%' },
            h('stop', { offset: '0%', stopColor: '#7dd3fc' }),
            h('stop', { offset: '100%', stopColor: '#3ba3dd' }))),
        // 影子
        h('ellipse', { cx: 50, cy: 95, rx: 26, ry: 5, fill: 'rgba(15,23,42,0.12)' }),
        // 脚：露在身体下沿外面，才有「站着」的感觉
        h('ellipse', { cx: 34, cy: 92, rx: 10, ry: 6, fill: '#2b8cc4' }),
        h('ellipse', { cx: 66, cy: 92, rx: 10, ry: 6, fill: '#2b8cc4' }),
        // 身体
        h('path', {
          d: 'M50 8 C73 8 86 27 86 52 C86 78 70 91 50 91 C30 91 14 78 14 52 C14 27 27 8 50 8 Z',
          fill: 'url(#self-evolve-pet-body)',
          stroke: '#2b8cc4', strokeWidth: 2,
        }),
        // 高光
        h('ellipse', { cx: 36, cy: 28, rx: 9, ry: 6, fill: 'rgba(255,255,255,0.45)' }),
        // 眼睛：写的时候眯成两条线，忘掉的时候变成两个叉，笑的时候弯成两道弧
        smiling
          ? h('g', { stroke: '#123b52', strokeWidth: 3, strokeLinecap: 'round', fill: 'none' },
            h('path', { d: 'M30 46 Q37 38 44 46' }),
            h('path', { d: 'M56 46 Q63 38 70 46' }))
          : thinking
          ? h('g', null,
            h('ellipse', { cx: 37, cy: 44, rx: 5, ry: 6, fill: '#123b52' }),
            h('ellipse', { cx: 63, cy: 44, rx: 5, ry: 6, fill: '#123b52' }),
            // 瞳孔偏上：标准的「在想事情」眼神
            h('circle', { cx: 37, cy: 41, r: 1.9, fill: '#ffffff' }),
            h('circle', { cx: 63, cy: 41, r: 1.9, fill: '#ffffff' }),
            h('path', { d: 'M32 33 L41 33', stroke: '#123b52', strokeWidth: 2, strokeLinecap: 'round', fill: 'none', opacity: 0.55 }),
            h('path', { d: 'M59 33 L68 33', stroke: '#123b52', strokeWidth: 2, strokeLinecap: 'round', fill: 'none', opacity: 0.55 }))
          : forgetting
          ? h('g', { stroke: '#123b52', strokeWidth: 2.6, strokeLinecap: 'round' },
            h('path', { d: 'M31 38 L43 50 M43 38 L31 50' }),
            h('path', { d: 'M57 38 L69 50 M69 38 L57 50' }))
          : eyesClosed
            ? h('g', { stroke: '#123b52', strokeWidth: 3, strokeLinecap: 'round' },
            h('path', { d: 'M30 42 Q37 38 44 42' }),
            h('path', { d: 'M56 42 Q63 38 70 42' }))
          : h('g', { style: { animation: 'self-evolve-pet-blink 4200ms ease-in-out infinite' } },
            h('ellipse', { cx: 37, cy: 44, rx: 5, ry: 6, fill: '#123b52' }),
            h('ellipse', { cx: 63, cy: 44, rx: 5, ry: 6, fill: '#123b52' }),
            h('circle', { cx: 35, cy: 42, r: 1.6, fill: '#ffffff' }),
            h('circle', { cx: 61, cy: 42, r: 1.6, fill: '#ffffff' })),
        // 嘴
        smiling
          ? h('path', { d: 'M42 60 Q50 70 58 60', stroke: '#123b52', strokeWidth: 3, fill: 'none', strokeLinecap: 'round' })
          : thinking
          ? h('path', { d: 'M45 64 L57 62', stroke: '#123b52', strokeWidth: 3, fill: 'none', strokeLinecap: 'round' })
          : forgetting
          ? h('path', { d: 'M44 64 Q50 58 56 64', stroke: '#123b52', strokeWidth: 3, fill: 'none', strokeLinecap: 'round' })
          : happy
          ? h('g', null,
            h('path', { d: 'M34 56 Q50 82 66 56 Z', fill: '#4c1d2b' }),
            h('path', { d: 'M41 72 Q50 80 59 72 Z', fill: '#f472b6' }))
          : (eyesClosed
            ? h('ellipse', { cx: 50, cy: 63, rx: 4, ry: 5, fill: '#123b52' })
            : h('path', { d: 'M43 62 Q50 69 57 62', stroke: '#123b52', strokeWidth: 3, fill: 'none', strokeLinecap: 'round' })),
        // 想事情：右手抬到太阳穴上，轻轻敲
        thinking
          ? h('g', {
            style: { animation: 'self-evolve-pet-tap 1100ms ease-in-out infinite', transformOrigin: '78px 32px' },
          },
            h('ellipse', { cx: 82, cy: 34, rx: 6.5, ry: 5.5, fill: '#4fb3e8', stroke: '#2b8cc4', strokeWidth: 1.3 }))
          : null,
        // 手：写的时候右手举铅笔
        h('ellipse', { cx: 10, cy: 57, rx: 7, ry: 6, fill: '#4fb3e8' }),
        h('g', {
          style: eyesClosed
            ? { animation: 'self-evolve-pet-scribble 420ms ease-in-out infinite', transformOrigin: '84px 56px' }
            : undefined,
        },
          h('ellipse', { cx: 90, cy: 55, rx: 7, ry: 6, fill: '#4fb3e8' }),
          eyesClosed
            ? h('g', null,
              h('rect', {
                x: 80, y: 34, width: 5, height: 20, rx: 2.5,
                fill: '#f59e0b', transform: 'rotate(22 82 44)',
              }),
              h('path', {
                d: 'M86 30 L92 34 L87 40 Z', fill: '#fbbf24', stroke: '#d97706', strokeWidth: 1,
              }))
            : null));
    }


    /**
     * `shell.overlay` 的入口：只订阅状态，不读聊天快照（root 作用域拿不到）。
     *
     * 桌宠是**常驻**的：没有沉淀事件时它就在角落待机，有事件时它开始写字。
     * 整屏台账是「点开」的结果，不是自动弹出来的东西。
     */
    function EvolutionOverlay() {
      const state = useOverlayState();
      const [opened, setOpened] = useState(undefined); // 手动点开的那条
      const [closed, setClosed] = useState(undefined); // 手动关掉的那条
      const [library, setLibrary] = useState(false); // 经验库面板
      // 桌宠常驻：`view === 'none'` 也要画它，否则「默认形态」就又回到什么都没有了。
      // 藏起来只是本轮的事，刷新就回来（顺手清掉旧版本留下的持久标记）。
      const [hidden, setHidden] = useState(false);
      useEffect(() => {
        forgetPetHiddenFlag();
      }, []);
      // 下一次沉淀把它叫回来：藏起来是暂时的，不是卸载。
      useEffect(() => {
        if (state === undefined || state === null) return;
        if (state.live === true && hidden) setHidden(false);
      }, [state === undefined || state === null ? '' : state.signature, hidden]);
      if (state === undefined || state === null) return null;
      // 藏起来时留一颗小按钮，否则就是「关掉之后再也找不回来」。
      if (hidden) {
        return h('button', {
          type: 'button',
          title: '把桌宠叫回来',
          onClick: () => setHidden(false),
          style: {
            position: 'fixed', right: 18, bottom: 96, zIndex: 9998,
            width: 30, height: 30, borderRadius: '50%', cursor: 'pointer',
            fontSize: 14, lineHeight: '28px', padding: 0,
            background: PANEL_BG, color: PANEL_FG,
            border: '1px solid ' + FALLBACK.border,
            boxShadow: '0 6px 18px rgba(15,23,42,0.18)',
            opacity: 0.75,
          },
        }, '🧬');
      }

      // 删除记忆：宠物当场做一个「忘掉」的表情，五秒后恢复待机。
      if (state.mood !== undefined && state.mood !== null) {
        return h(EvolutionPet, {
          key: 'pet-mood:' + state.mood.at,
          mood: state.mood.kind,
          count: state.mood.count,
          phase: 'settled',
          entries: [],
          pendingTitle: '',
          closing: false,
          onExpand: () => setLibrary(true),
          onHide: () => setHidden(true),
        });
      }
      if (library) {
        // 关经验库 = 连台账一起关。
        // 经验库是从台账卡片的「查看全部经验」点开的，只关面板的话，身后那张卡片
        // 会留在原地，看起来就是「两个页面只关掉了一个」。
        const closeLibrary = () => {
          setLibrary(false);
          if (typeof state.signature === 'string') setClosed(state.signature);
        };
        // 卡片和桌宠并排站着：卡片在它头顶，点它就把卡片收起来。
        return h('div', { key: 'library-stack' },
          h(LessonLibrary, { sessionId: state.sessionId, onClose: closeLibrary }),
          h(EvolutionPet, {
            key: 'pet-with-library',
            mood: 'think',
            phase: 'settled',
            count: state.sessionCount,
            entries: [],
            pendingTitle: '',
            closing: false,
            onExpand: () => setLibrary(false),
            onHide: () => setHidden(true),
          }));
      }

      // 新记录的签名不同 → 自动演；用户关掉后靠 closed 记住，不会立刻又弹回来。
      const isClosed = closed === state.signature;
      const playing = isClosed !== true && (state.live === true || opened === state.signature);

      if (playing) {
        return h(EvolutionScene, {
          // 用 sessionId 而不是 signature：signature 在「沉淀中 → 完成」时会变，
          // 一变就整棵重建，滑入动画会重播一次——正是刚才修掉的「断档」换个地方又来。
          key: 'scene:' + state.sessionId,
          state,
          sessionId: state.sessionId,
          sessionCount: state.sessionCount,
          // 自动出现的浮层永远是小卡；整屏是「点开」的结果。
          compactOnly: true,
          history: state.history,
          pendingTitle: state.pendingTitle,
          pendingKind: state.pendingKind,
          onOpenLibrary: () => setLibrary(true),
          // 只关卡片。藏桌宠是它自己那个 ×，两者不能共用一个回调。
          onClose: () => setClosed(state.signature),
          onHide: () => setHidden(true),
        });
      }
      // 没有正在演的事件时，桌宠**留在原地待机**——它就是这个功能默认的样子。
      // 早先这里退回一颗「🧬 进化记录」药丸，用户会以为桌宠只活在动画里。
      return h(EvolutionPet, {
        key: 'pet-idle:' + state.sessionId,
        idle: true,
        phase: 'settled',
        count: state.sessionCount,
        entries: [],
        pendingTitle: '',
        closing: false,
        onExpand: () => {
          // 本会话还没有沉淀记录：点它进经验库，别打开一张空台账。
          if (state.view === 'none') {
            setLibrary(true);
            return;
          }
          setClosed(undefined);
          setOpened(state.signature);
        },
        onHide: () => {
          setHidden(true);
          setClosed(state.signature);
        },
      });
    }

    /**
     * 会话层的**状态桥**：读聊天快照，把「现在该不该进化、演到哪一步」发布出去。
     *
     * 关键设计：**不依赖轮次**。早期版本用 turn / timeline / closing 判断"这一轮结束
     * 了没有"，只要宿主那边的形状和假设差一点，桥就永远发布不出状态，
     * 表现出来就是「点了确认，什么反应都没有」。
     *
     * 现在只看两件事：
     *   1. 有没有一个 `self_evolve_record` 调用还没出结果 → 沉淀中（动画开始）；
     *   2. 有没有一条成功的结果，且是本次页面加载之后写的 → 演一遍并落定。
     *
     * 它自己不画任何像素，展示交给整帧浮层。
     */
    function TurnTailEvolution(props) {
      const useChat = props.useChat;
      const sessionId = props.sessionId;
      const hooks = typeof useChat === 'function';

      // 诊断必须**无条件**先取：hooks 顺序不能随 if 变化。
      const diag = hooks ? useChat(selectDiag) : undefined;
      const record = hooks ? useChat(selectLatestRecordGlobal) : undefined;
      const writing = hooks ? useChat(selectWritingGlobal) : false;
      const counted = hooks ? useChat(selectSessionCount) : 0;
      // 历史签名与在飞标题都返回字符串：`useChat` 只认值稳定的返回值。
      const historySig = hooks ? useChat(selectHistorySignature) : '';
      const pendingTitle = hooks ? useChat(selectPendingTitle) : '';
      const pendingKind = hooks ? useChat(selectPendingKind) : '';
      // `running` 来自会话快照（不是 chat 快照）；拿不到时退回旧行为。
      const useSession = props.useSession;
      const running = typeof useSession === 'function'
        ? useSession((snapshot) => snapshot?.running === true)
        : undefined;
      // 单调保底：先记住再发布，避免「切走再回来数字变小」。
      const sessionCount = useMemo(
        () => rememberSessionCount(sessionId, counted),
        [counted, sessionId],
      );

      const outcome = useMemo(() => outcomeFromText(resultText(record)), [record]);
      const fresh = record !== undefined && asTime(record.time) >= BOOT_AT;

      // 本轮还在跑就什么都不显示；结束后才允许演（顺序由模型输出 → 动画）。
      const view = bridgeView({
        running,
        // 一律小卡（dockable: true）。
        // 早先「第 1 次弹整屏、第 2 次起小卡」的做法有两个毛病：用户不知道还有第二种形态，
        // 而那一次整屏恰好会盖住正在流式输出的回答。整屏现在只在用户点开时出现。
        dockable: true,
        writing,
        hasOutcome: outcome !== undefined,
        fresh,
        hasRecord: record !== undefined,
      });

      const signature = outcome === undefined ? `none:${view}` : outcome.signature;

      useEffect(() => {
        publishOverlay({
          sessionId,
          signature: view === 'none' ? 'debug' : signature,
          view,
          outcome,
          isThisTurn: fresh,
          live: view !== 'settled' && view !== 'none',
          sessionCount,
          // 历史与「正在写哪条」都带上：台账要列全部，沉淀中要显示标题。
          history: historyCache.list,
          historySig,
          pendingTitle,
          pendingKind,
          diag,
        });
      }, [view, signature, sessionId, outcome, fresh, sessionCount, diag, running, historySig, pendingTitle, pendingKind]);

      // 卸载时**不清空**浮层：这个组件会随着聊天列表重渲染被反复卸载/挂载，
      // 一清空桌宠就消失，而且要等到下一次状态变化才会回来——正是「过一会儿就没了」。
      // 换会话时新会话的桥会立刻发布自己的状态，旧状态活不过一帧。

      // 诊断：只在 URL 带 ?self-evolve-debug 时打日志，平时不许刷控制台。
      useEffect(() => {
        try {
          if (!String(window.location?.search ?? '').includes('self-evolve-debug')) return;
          console.log('[self-evolve] bridge', {
            view,
            writing,
            hasRecord: record !== undefined,
            hasOutcome: outcome !== undefined,
            fresh,
            at: record === undefined ? undefined : record.time,
            bootAt: BOOT_AT,
          });
        } catch {
          // 控制台不可用就算了。
        }
      }, [view, writing, record, outcome, fresh]);

      // 临时探针：把桥看到的数字直接画在输入框下面，界面截图就能定位问题。
      // 定位完可以删掉这一行（它不影响任何功能）。
      return null;
    }

    /**
     * `self_evolve_record` 的工具行视图：**永远渲染 null**。
     *
     * 注册它只是为了把这一行原始 JSON 从对话流里藏掉——展示归轮尾管。
     */
    function RecordSink() {
      return null;
    }

    // -----------------------------------------------------------------------
    // 注册
    // -----------------------------------------------------------------------

    return {
      name: 'self-evolve',

      // 必须声明 inject：Cordis 里访问未注入的服务会**直接抛错**
      // （`cannot get property "slots" without inject`），
      // 于是整个 entry 被判 failed，页面启动时报
      // 「web boot: 1 entry did not activate — @local/self-evolve: failed」，
      // 界面上一片空白、所有槽位注册消失，看起来就像「插件损坏」。
      inject: ['slots'],

      // 供本地逻辑测试用（宿主只关心 apply）：selector 是最容易静默失效的一块，
      // 用合成快照在 node 里跑一遍，比刷新页面猜快得多。
      __internal: {
      judgementStamp,
        shouldFlash,
        EvolutionOverlay,
        outcomeFromText,
        resultText,
        recordRootOf,
        selectLatestRecord,
        selectRecordTurn,
        selectClosed,
        selectLastTurn,
        asTime,
        selectMarker,
        selectWriting,
        selectLatestRecordGlobal,
        selectWritingGlobal,
        selectSessionCount,
        selectDiag,
        bridgeView,
        collectRecordList,
        selectHistorySignature,
        selectPendingTitle,
        selectPendingKind,
        HistoryList,
        LessonLibrary,
        LibraryRow,
        describeTrigger,
        describeJudgement,
        triggerTag,
        triggerTagTitle,
        diffLines,
        ProposalRow,
        requestLessons,
        requestMutate,
        requestPurge,
        decideView,
        FLASH_MS,
        // 组件本身也暴露，方便在 node 里渲染一遍做冒烟测试
        // （「组件返回 null」是最隐蔽的失效——必须能被测出来）。
        EvolutionScene,
        EvolutionPet,
        EvolveSpinner,
        Keyframes,
        Totals,
        // 状态桥（会话层 → 浮层）也一并暴露，方便单测幂等与通知。
        publishOverlay,
        subscribeOverlay,
        sameOverlay,
        overlayState,
      },
      apply(ctx) {
        // 每一步都自己兜住：apply 抛错会让整个 Client 半 failed，代价是整页报错，
        // 而一个槽位没挂上只是少一块 UI——绝不能让前者发生。
        const register = (slot, factory) => {
          try {
            ctx.slots.inject(slot, factory);
          } catch (error) {
            try {
              console.error('[self-evolve] failed to register ' + slot, error);
            } catch {
              // 控制台都没有就算了，注册失败不影响其它功能。
            }
          }
        };

        register('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: TOOL_NAME,
        }, RecordSink));

        // 会话层：读快照的状态桥（只画一行诊断字，不画进化 UI）。
        // 只挂一个座位：composer.dock 在会话打开时就在场，且两个座位同时发布会
        // 互相覆盖（store 是单槽位的）。
        register('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'self-evolve-bridge',
          order: 90,
        }, TurnTailEvolution));

        // 整帧浮层：任务输出完之后**单独加载**的进化 UI。
        // `shell.overlay` 是全帧浮层（在所有栏目之上、不受滚动容器影响），
        // 天生就是「独立一层 UI」的座位。
        register('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'self-evolve-overlay',
          order: 80,
        }, EvolutionOverlay));
      },
    };
  },
});
