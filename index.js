/**
 * self-evolve — 自我进化
 *
 * 检测两类「不收敛」信号，触发一次经验总结，并把结论固化到全局记忆 / 技能：
 *
 *   1. 工具执行链路（自最近一次用户输入以来的工具执行次数）超过阈值（默认 15）。
 *   2. shell / bash 连续失败达到阈值（默认 3 次）。
 *
 * 触发时只做两件事：
 *   - 通过 `tools/post-execute` 的 `additionalContexts` 注入一条带来源标签的
 *     提示（source.kind = 'self-evolve'，form = 'notice'），要求模型总结经验；
 *   - 提供 `self_evolve_record` 工具，由模型把总结写进 `$DSH_HOME/AGENTS.md`
 *     与 skills 根目录下的 SKILL.md。
 *
 * 设计约束（见 cordis-plugin-development/references/practices.md）：
 *   - 会话日志是唯一事实来源：本插件不写自定义 session 事件，只注入上下文。
 *   - 提示必须带 `source.kind`，否则在派生历史里会被渲染成用户提问。
 *   - 不引入任何 `@deepseek-ai/*` 运行时依赖：bundle 以软链接方式装进 profile，
 *     realpath 在 workspace 内，bare specifier 解析不到 profile 的 node_modules。
 *     因此这里只用 `node:` 内建模块，工具定义直接以 JSON Schema 对象注册。
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

/** Cordis 插件名。 */
export const name = 'self-evolve';

/** 依赖 tools 服务；缺失时插件保持未激活，而不是抛错。 */
export const inject = ['tools'];

// 其余服务（`fs` / `sandboxPolicy` / `workingDirectory`）都是可选的，统一用
// `ctx.get(name)` 读取：Cordis 的 `inject` 只表达硬依赖，没有 optional 形式，
// 而 `ctx.get` 本就不要求声明。三者都缺失时插件仍可运行，只是落点回落到
// home、写入走 `node:fs`。

/** 注入上下文时使用的来源标签；缺了它派生历史会把提示当成用户提问。 */
const SOURCE_KIND = 'self-evolve';

const MEMORY_BEGIN = '<!-- self-evolve:begin -->';
const MEMORY_END = '<!-- self-evolve:end -->';
// 协议里的核心段：这一段是硬护栏，自优化提案不允许改动（校验按原文比对）。
const KEEP_BEGIN = '<!-- keep:begin -->';
const KEEP_END = '<!-- keep:end -->';
const LESSON_HEADING_ZH = '## 经验教训（self-evolve 自动维护）';
const LESSON_HEADING_EN = '## Lessons learned (maintained by self-evolve)';

/** 默认配置。所有字段都可在 cordis.patch.yml 的 config 里覆盖。 */
const DEFAULTS = {
  enabled: true,
  // 纯长度**不再**是触发条件：一个正常的长任务本来就走十几二十步，把它当成
  // 「值得沉淀」只会制造噪声。长度提成的触发由 triggerOnLengthOnly 显式开启。
  chainSteps: 15,
  triggerOnLengthOnly: false,
  shellFailureThreshold: 3,
  // 任意工具失败（不只是 shell）到这个次数，说明确实出了问题。
  toolFailureThreshold: 2,
  shellTools: ['bash', 'shell'],
  repeatEvery: 15,
  language: 'zh',
  dryRun: false,
  // 'auto' = 记忆分两档：项目级（默认落点）与全局（跨项目通用 / 个人偏好）。
  // 'global' / 'workspace' 是强制单档，保留给想锁死落点的场景。
  scope: 'auto',
  memoryPath: '',
  skillRoot: '',
  maxMemoryEntries: 50,
  maxMemoryBytes: 65536,
  maxLessonChars: 800,
  // 记忆条目正文的实际预算：超出的部分不再塞进常驻上下文，改写成「结论 + 指引」。
  // 一条记忆每次都会随 AGENTS.md 进上下文，600 字的长篇在这里是纯成本。
  maxMemoryLessonChars: 220,
  // 自优化预算：注入的协议正文、以及自建技能正文的上限。想加内容必须先删。
  maxPromptChars: 1200,
  maxSkillChars: 6000,
  // 技能附属文件（脚本/模板）：单个和合计都有上限，避免「优化」变成塞一个大仓库进来。
  // 自动整理记忆：沉淀后顺手巡检（6 小时一次），判为「同一件事」的自动合并。
  // 判定流程开关：两段式（先 worth，再 scope/relation/stale）+ 取代置信度门槛。
  stagedJudge: true,
  relationMinConfidence: 0.5,
  autoAudit: true,
  autoMergeAudit: true,
  maxSkillFileChars: 120000,
  maxSkillFilesChars: 300000,
  // 归档文件上限：超了就按月轮转（旧内容进 archive/memory-YYYY-MM.md），
  // 否则「不删除」会变成「一个文件无限长大」。
  maxArchiveBytes: 262144,
  // 一轮最多落一条。复盘的价值在于取舍，写第二条通常只是把同一件事说两遍。
  maxRecordsPerTurn: 1,
  // 新工作流识别：链路要足够长、工具种类足够多。门槛定得比「一次正常开发」更高，
  // 这样十几步的普通过程不会触发，只有真正的多工具长链路才会。
  workflowMinSteps: 25,
  workflowMinDistinctTools: 4,
};
// ---------------------------------------------------------------------------
// 配置归一化
// ---------------------------------------------------------------------------

/** 解析 `$DSH_HOME`（默认 `~/.dsh`）。 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  return configured && configured.trim().length > 0 ? configured : join(homedir(), '.dsh');
}

/** 解析 `$DSH_AGENTS_HOME`（默认 `~/.agents`）。 */
function resolveAgentsHome() {
  const configured = process.env.DSH_AGENTS_HOME;
  return configured && configured.trim().length > 0 ? configured : join(homedir(), '.agents');
}

/** 把 `~` / `~/x` 展开成 home 下的绝对路径。 */
function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/** 校验正整数，失败即报错（fail-loud，配置写错不该静默降级）。 */
function positiveInteger(field, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`self-evolve: \`${field}\` must be an integer >= ${min}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** 合并默认值并逐项校验。 */
export function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw ?? {}) };

  if (typeof config.enabled !== 'boolean') throw new Error('self-evolve: `enabled` must be a boolean');
  if (typeof config.dryRun !== 'boolean') throw new Error('self-evolve: `dryRun` must be a boolean');
  if (typeof config.triggerOnLengthOnly !== 'boolean') {
    throw new Error('self-evolve: `triggerOnLengthOnly` must be a boolean');
  }
  if (config.language !== 'zh' && config.language !== 'en') {
    throw new Error(`self-evolve: \`language\` must be "zh" or "en", got ${JSON.stringify(config.language)}`);
  }
  positiveInteger('chainSteps', config.chainSteps, 1);
  positiveInteger('shellFailureThreshold', config.shellFailureThreshold, 1);
  positiveInteger('toolFailureThreshold', config.toolFailureThreshold, 1);
  positiveInteger('maxRecordsPerTurn', config.maxRecordsPerTurn, 1);
  positiveInteger('repeatEvery', config.repeatEvery, 1);
  positiveInteger('maxMemoryEntries', config.maxMemoryEntries, 1);
  positiveInteger('maxMemoryBytes', config.maxMemoryBytes, 1024);
  positiveInteger('maxLessonChars', config.maxLessonChars, 80);
  positiveInteger('maxMemoryLessonChars', config.maxMemoryLessonChars, 120);
  positiveInteger('maxPromptChars', config.maxPromptChars, 200);
  positiveInteger('maxSkillChars', config.maxSkillChars, 400);
  positiveInteger('maxSkillFileChars', config.maxSkillFileChars, 1024);
  positiveInteger('maxSkillFilesChars', config.maxSkillFilesChars, 1024);
  positiveInteger('maxArchiveBytes', config.maxArchiveBytes, 4096);
  positiveInteger('workflowMinSteps', config.workflowMinSteps, 1);
  positiveInteger('workflowMinDistinctTools', config.workflowMinDistinctTools, 1);

  if (!Array.isArray(config.shellTools) || config.shellTools.length === 0) {
    throw new Error('self-evolve: `shellTools` must be a non-empty array of tool names');
  }
  for (const tool of config.shellTools) {
    if (typeof tool !== 'string' || tool.length === 0) {
      throw new Error('self-evolve: every entry of `shellTools` must be a non-empty string');
    }
  }
  if (typeof config.memoryPath !== 'string') throw new Error('self-evolve: `memoryPath` must be a string');
  if (config.decision !== undefined && (config.decision === null || typeof config.decision !== 'object')) {
    throw new Error('self-evolve: `decision` must be an object');
  }
  if (typeof config.skillRoot !== 'string') throw new Error('self-evolve: `skillRoot` must be a string');
  if (config.scope !== 'workspace' && config.scope !== 'global' && config.scope !== 'auto') {
    throw new Error(`self-evolve: \`scope\` must be "auto", "global" or "workspace", got ${JSON.stringify(config.scope)}`);
  }

  const decision = { ...DECISION_DEFAULTS, ...(config.decision ?? {}) };
  if (typeof decision.enabled !== 'boolean') throw new Error('self-evolve: `decision.enabled` must be a boolean');
  if (typeof decision.shadow !== 'boolean') throw new Error('self-evolve: `decision.shadow` must be a boolean');
  if (typeof decision.model !== 'string' || decision.model.length === 0) {
    throw new Error('self-evolve: `decision.model` must be a non-empty string');
  }
  if (typeof decision.baseURL !== 'string' || !/^https?:\/\//.test(decision.baseURL)) {
    throw new Error('self-evolve: `decision.baseURL` must be an http(s) URL');
  }
  if (typeof decision.apiKey !== 'string') throw new Error('self-evolve: `decision.apiKey` must be a string');
  if (typeof decision.timeoutMs !== 'number' || decision.timeoutMs < 100) {
    throw new Error('self-evolve: `decision.timeoutMs` must be a number >= 100');
  }
  if (typeof decision.worthThreshold !== 'number' || decision.worthThreshold < 0 || decision.worthThreshold > 1) {
    throw new Error('self-evolve: `decision.worthThreshold` must be within [0, 1]');
  }
  if (typeof decision.scopeMinConfidence !== 'number' || decision.scopeMinConfidence < 0 || decision.scopeMinConfidence > 1) {
    throw new Error('self-evolve: `decision.scopeMinConfidence` must be within [0, 1]');
  }

  return {
    ...config,
    decision,
    shellTools: new Set(config.shellTools),
    // 显式配置优先；否则按 scope 决定是会话工作区还是 home。
    memoryPath: config.memoryPath.length > 0 ? expandHome(config.memoryPath) : '',
    skillRoot: config.skillRoot.length > 0 ? expandHome(config.skillRoot) : '',
    globalMemoryPath: join(resolveDshHome(), 'AGENTS.md'),
    globalSkillRoot: join(resolveAgentsHome(), 'skills'),
  };
}

/**
 * 解析本次调用真正使用的落点。
 *
 * `scope: 'workspace'`（默认）把经验留在会话工作区里 —— `workspace-write`
 * 策略下可直接写入，不需要提权；`scope: 'global'` 写 home，跨项目生效但需要
 * 更宽的文件策略。显式配置的 `memoryPath` / `skillRoot` 永远优先。
 */
export function resolveTargets(settings, workspace) {
  const root = typeof workspace === 'string' && workspace.length > 0 ? workspace : undefined;
  const globalMemory = settings.memoryPath.length > 0 ? settings.memoryPath : settings.globalMemoryPath;
  // 项目级记忆 = 工作区里的 AGENTS.md：只在这个项目里被加载。
  const projectMemory = root === undefined ? undefined : join(root, 'AGENTS.md');
  const projectSkillRoot = root === undefined ? undefined : join(root, '.dsh', 'skills');

  const forced = settings.scope === 'global' || settings.scope === 'workspace';
  const defaultKey = settings.scope === 'global'
    ? 'global'
    : (settings.scope === 'workspace' && projectMemory !== undefined ? 'project' : (projectMemory === undefined ? 'global' : 'project'));

  const memoryTargets = { global: globalMemory, ...(projectMemory === undefined ? {} : { project: projectMemory }) };
  const memoryPath = memoryTargets[defaultKey] ?? globalMemory;
  // 技能仍留在全局技能根：技能目录也是每轮注入的，项目级技能目录支持另说。
  const skillRoot = settings.skillRoot.length > 0
    ? settings.skillRoot
    : settings.scope === 'workspace' && projectSkillRoot !== undefined
      ? projectSkillRoot
      : settings.globalSkillRoot;
  return {
    memoryPath,
    skillRoot,
    scope: settings.scope,
    // 本次默认写哪一档（auto 下默认项目级：宁可少全局污染，也不要事后清理）
    defaultScope: defaultKey,
    memoryTargets,
    // 强制单档时，模型传来的 scope 参数不生效。
    forcedScope: forced ? defaultKey : undefined,
  };
}

/**
 * 决定这一条经验写进哪个记忆文件。
 *
 * `auto` 下由模型按「是不是跨项目通用 / 是不是用户的长期偏好」自己选，默认项目级；
 * 配置成 `global` / `workspace` 时锁死，模型选什么都不影响落点。
 */
export function memoryTargetFor(targets, requested) {
  const wanted = targets.forcedScope
    ?? (requested === 'global' ? 'global' : requested === 'project' || requested === 'workspace' ? 'project' : targets.defaultScope);
  const key = targets.memoryTargets[wanted] === undefined ? targets.defaultScope : wanted;
  return { scope: key, path: targets.memoryTargets[key] ?? targets.memoryPath };
}

// ---------------------------------------------------------------------------
// 提示文案
// ---------------------------------------------------------------------------

/**
 * 自我进化协议正文。
 *
 * 这段文本通过 `ctx.systemPrompt.section()` 进入**系统提示**，而不是作为可见
 * 消息插进对话流——用户在界面上永远看不到这段协议，只会在触发时看到一个
 * 极简的 🧬 标记。这是「任务结果输出后再进化、且不往对话里塞噪声」的关键。
 */
function protocolSection(settings) {
  if (settings.language === 'en') {
    return [
      '## Self-evolve protocol (self-evolve plugin)',
      '',
    KEEP_BEGIN,
      '- On "Self-evolve · ready": call `self_evolve_record` at most ONCE, with the single most',
      '  valuable lesson; the default is to write NOTHING — length is not value.',
      '- Record only what would change what a future you does differently: not what the task',
      '  accomplished, not restated errors, not another phrasing of what memory already says.',
      '- Never mention it in the conversation: no protocol explanation, no 🧬, no "recorded N',
      '  lessons" — it shows up in the evolution-record UI only.',
    KEEP_END,
      '',
      'The host injects that block mid-run (the user never sees it); handle the distillation before',
      'your final answer.',
      '',
      'If this protocol or a self-created skill looks redundant, submit a slimmer version with',
      '`self_evolve_propose`: it only queues a candidate until the user clicks apply.',
    ].join('\n');
  }
  return [
    '## 自我进化协议（self-evolve 插件）',
    '',
  KEEP_BEGIN,
    '- 看到「本轮已就绪」：至多调用一次 `self_evolve_record`，只沉**最有价值的一条**；',
    '  **默认什么都不写**——跑得久不等于有价值。',
    '- 只记「会让未来的你做得不一样」的教训：不记任务做成了什么、不记报错原文、不重述记忆里',
    '  已有的道理。',
    '- 不要在对话里提这件事：不解释协议、不提 🧬、不写「已沉淀 N 条」，它只出现在进化记录 UI。',
  KEEP_END,
    '',
    '「本轮已就绪」由宿主在执行途中注入，用户看不到；看到它就在**最终回答之前**处理完沉淀。',
    '',
    '这段协议或某个自建技能显得冗余时，可用 `self_evolve_propose` 提交精简稿：只入队，用户点',
    '「应用」才生效。',
  ].join('\n');
}

/** 深度冻结，保证消息发布后不可变。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 失败判定
// ---------------------------------------------------------------------------

/** 从工具结果的内容块里拼出可见文本。 */
function resultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += `${block.text}\n`;
  }
  return text;
}

/** 判断一次工具执行是否算失败。 */
function failedExecution(result) {
  if (result?.isError === true) return true;
  const text = resultText(result);
  const exit = /\[exit code: (-?\d+)\]/.exec(text);
  if (exit !== null && Number(exit[1]) !== 0) return true;
  if (/\[timed out after \d+ms\]/.test(text)) return true;
  if (/\[killed by signal: [^\]]+\]/.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/**
 * 文件读写的唯一入口。
 *
 * 优先走 Harness 的 `fs` 服务（`ctx.fs`），这样写入受当前会话的文件策略约束。
 * 关键点：`SandboxedFileSystem.writeText` 的第五个参数是**逐调用策略**，不传就会
 * 回落到部署默认模式（通常是 `read-only`），连工作区内的写入都会被拒。所以这里
 * 显式用 `ctx.sandboxPolicy.resolve({ session })` 解析出本会话真正生效的模式。
 *
 * 默认落点是全局（`$DSH_HOME`），在 `workspace-write` 下属于越界写入，会触发
 * 一次审批升级；用户批准后本会话内不再重复询问。
 *
 * `fs` 服务不可用时退回 `node:fs`，保证插件在最小 profile 里也能跑。
 *
 * @param ctx - 插件上下文。
 * @param agent - 本次调用所属 agent，审批需要它来定位会话。
 * @param grants - 跨调用共享的授权缓存（按会话记住已批准的升级）。
 */
function createStorage(ctx, agent, grants, options) {
  const session = agent?.session;
  const { granted, pending } = grants;
  // 显式指定这次调用的沙箱模式（只给「人点出来的」写入用：经验库的保存/删除）。
  // 原因：沙箱约束的是**智能体的自主行为**；而这条路由是人类在插件自己的面板里
  // 点保存/删除触发的，写的是插件自己托管、且经过白名单校验的文件。人点一下还要
  // 被 agent 的只读策略挡住，只会表现为「点了没反应」。
  const explicitMode = typeof options?.mode === 'string' ? options.mode : undefined;

  /** 取服务；未安装时为 undefined。 */
  const service = (name) => {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };

  /** 解析本会话的逐调用沙箱策略；服务缺失时返回 undefined（后端自行回落）。 */
  function policy() {
    const sandboxPolicy = service('sandboxPolicy');
    if (sandboxPolicy === undefined) return undefined;
    try {
      const request = {};
      if (session !== undefined) request.session = session;
      if (explicitMode !== undefined) request.mode = explicitMode;
      return sandboxPolicy.resolve(request);
    } catch {
      return undefined;
    }
  }

  /** 读取文本；文件不存在返回空串。 */
  async function read(path, signal) {
    const fs = service('fs');
    if (fs === undefined) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return '';
        throw error;
      }
    }
    const target = await fs.resolve(path, { signal });
    const info = await fs.stat(target, signal);
    if (info === undefined) return '';
    if (info.type !== 'file') throw new Error(`self-evolve: "${path}" is not a regular file`);
    return await fs.readText(target, signal);
  }

  /** 写入文本；按文件当前状态选择 createIfAbsent 或版本校验。 */
  async function write(path, content, signal) {
    const fs = service('fs');
    if (fs === undefined) {
      await mkdir(dirnameOf(path), { recursive: true });
      await writeFile(path, content, 'utf8');
      return;
    }
    const target = await fs.resolve(path, { signal });
    const info = await fs.stat(target, signal);
    const expected = info === undefined
      ? { kind: 'createIfAbsent' }
      : { kind: 'replaceIfVersion', version: info.version };
    // 第五个参数决定这次写入受哪套策略约束；漏传会被 read-only 默认值挡下。
    const base = policy();
    try {
      await fs.writeText(target, content, expected, signal, base);
    } catch (error) {
      // 目标在可写根之外（典型：全局记忆落在 $DSH_HOME）。workspace-write 下
      // 这是策略拒绝而不是路径错误，唯一正路是申请一次更宽的授权。
      if (error?.code !== 'FS_SANDBOX_DENIED') throw error;
      const widened = await escalate(base, path, signal);
      if (widened === undefined) throw error;
      await fs.writeText(target, content, expected, signal, widened);
    }
  }

  /**
   * 为一次越界写入申请 `danger-full-access`。
   *
   * 审批按会话走：用户点一次「允许」，本次进程内后续同类写入不再重复打扰，
   * 否则每次记录经验都弹窗会让人很快把插件关掉。
   *
   * @returns 升级后的策略；拿不到授权时返回 undefined，由调用方抛原始拒绝。
   */
  async function escalate(base, path, signal) {
    if (base === undefined || base.mode === 'danger-full-access') return undefined;
    // 没有会话就没有审批对象（经验库路由就是这种调用）：只能用基础策略，
    // 不能拿 undefined 当 WeakMap 的键——那会抛 "Invalid value used as weak map key"。
    if (session === undefined) return undefined;
    const approval = service('approval');
    if (approval === undefined) return undefined;

    // 同一会话内一旦批准过，后续越界写入直接沿用。
    if (granted.has(session)) return { ...base, mode: 'danger-full-access' };
    if (pending.has(session)) {
      const settled = await pending.get(session);
      return settled === true ? { ...base, mode: 'danger-full-access' } : undefined;
    }

    const ask = (async () => {
      try {
        const outcome = await approval.request({
          agent,
          toolName: 'self_evolve_record',
          reason: `self-evolve: write outside the workspace (${path})`,
          displayReason: {
            en: `Allow self-evolve to write the global memory/skills outside the workspace?\n\n${path}`,
            zh: `允许「自我进化」把全局记忆 / 技能写到工作区之外吗？\n\n${path}`,
          },
          ...signal ? { signal } : {},
        });
        return outcome === 'allowed-once';
      } catch {
        return false;
      }
    })();
    pending.set(session, ask);
    const ok = await ask;
    pending.delete(session);
    if (!ok) return undefined;
    granted.add(session);
    return { ...base, mode: 'danger-full-access' };
  }

  return { read, write };
}

/** 极简 dirname（`fs` 服务不可用时的兜底写入用）。 */
function dirnameOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? path.slice(0, index + 1) || '.' : path.slice(0, index);
}

/**
 * 取本次调用所属会话的工作目录。
 *
 * `workingDirectory.get(session)` 是同步的、只读已提交状态，正好适合在工具
 * 执行期解析落点。服务缺失时返回 undefined，由 `resolveTargets` 回落到 home。
 */
function workspaceOf(ctx, exec) {
  const session = exec?.agent?.session;
  if (session === undefined) return undefined;
  try {
    const service = ctx.get('workingDirectory');
    if (service === undefined) return undefined;
    return service.get(session);
  } catch {
    return undefined;
  }
}

/** 取本次调用所属的会话对象，供沙箱策略解析使用。 */
function sessionOf(exec) {
  return exec?.agent?.session;
}

/**
 * 诊断信息：插件看到的服务与解析出的沙箱策略。
 *
 * 写入被拒时最需要回答的问题是「这次调用实际用的是什么 mode」。把它暴露在
 * `self_evolve_status` 里，用户不必翻日志就能定位是策略没解析到、还是路径越界。
 */
function describeEnvironment(ctx, exec) {
  const read = (name) => {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };
  const session = sessionOf(exec);
  const fs = read('fs');
  const sandboxPolicy = read('sandboxPolicy');
  let policy;
  if (sandboxPolicy !== undefined) {
    try {
      policy = sandboxPolicy.resolve(session === undefined ? {} : { session });
    } catch (error) {
      policy = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    hasSession: session !== undefined,
    hasFsService: fs !== undefined,
    hasSandboxPolicyService: sandboxPolicy !== undefined,
    fsDefaultMode: typeof fs?.sandboxMode === 'string' ? fs.sandboxMode : '',
    resolvedMode: typeof policy?.mode === 'string' ? policy.mode : '',
    workspaceRoot: typeof policy?.workspaceRoot === 'string' ? policy.workspaceRoot : '',
  };
}

/**
 * 把写入失败翻译成面向模型的一句话。
 * 沙箱拒绝是最常见的一种，单独点名并给出补救办法。
 */
function describeWriteFailure(error, path) {
  const code = error?.code;
  if (code === 'FS_SANDBOX_DENIED') {
    return `${path}: 当前文件策略不允许写入（FS_SANDBOX_DENIED），且未获得越界授权。批准审批弹窗，或把会话文件策略切到 danger-full-access，或把配置里的 memoryPath / skillRoot 指到工作区内。`;
  }
  if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED') {
    return `${path}: 文件在读取后被改动（${code}），本次写入已放弃，重试即可。`;
  }
  if (code === 'FS_NOT_FOUND') return `${path}: 路径不存在（FS_NOT_FOUND）。`;
  return `${path}: ${error instanceof Error ? error.message : String(error)}`;
}

/** 去重键：折叠空白、统一大小写。 */
function dedupeKey(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 把多行总结压成一行，并按上限截断。 */
function oneLine(text, limit) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/** 解析全局记忆里本插件维护的条目。 */
function parseMemoryEntries(existing) {
  const begin = existing.indexOf(MEMORY_BEGIN);
  const end = existing.indexOf(MEMORY_END);
  if (begin < 0 || end < begin) return [];
  const block = existing.slice(begin + MEMORY_BEGIN.length, end);
  const entries = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) entries.push(trimmed);
  }
  return entries;
}

/**
 * 把触发信号翻译成一句人话（模型侧提示与界面用的是同一套措辞）。
 *
 * 早先这里直接塞 `workflow` / `failure` 这种内部代号，模型只能猜，用户更是
 * 一头雾水——「为什么沉淀这条」本身就是要说清楚的信息。
 */
function signalText(trigger) {
  if (trigger === undefined || !Array.isArray(trigger.reasons)) return '';
  const parts = [];
  for (const reason of trigger.reasons) {
    if (reason === 'failure') {
      const detail = [];
      if (trigger.shellFailures > 0) detail.push(`shell 失败 ${trigger.shellFailures} 次`);
      if (trigger.toolFailures > 0) detail.push(`工具失败 ${trigger.toolFailures} 次`);
      parts.push(detail.length === 0 ? '连续失败' : `连续失败（${detail.join(' / ')}）`);
    } else if (reason === 'workflow') {
      parts.push(`多工具长链路（${trigger.steps} 步 / ${trigger.distinctTools} 种工具）`);
    } else if (reason === 'explicit') {
      parts.push('用户要求记住');
    } else if (reason === 'chain') {
      parts.push(`长链路（${trigger.steps} 步）`);
    } else {
      parts.push(reason);
    }
  }
  return parts.join('；');
}

/** 最近一次判定的落盘位置：界面上要能回答「它到底跑没跑过」。 */
function lastJudgementPath() {
  return join(resolveStateDir(), 'last-judgement.json');
}

/** 记下这次判定的结果（best-effort：写不进去不影响主流程）。 */
async function rememberJudgement(judgement, title) {
  // 探针只验证接口通不通，它的分数是假的，进了流水就会把 worth 分布带偏。
  if (judgement.probe === true) return;
  try {
    // 用本地时间写：日志是给人看的，UTC 会让人以为差了 8 小时。
    const at = stampNow();
    await mkdir(resolveStateDir(), { recursive: true });
    // B4：除了「最近一次」，再追加一份流水。调 worthThreshold / 自动合并的激进程度
    // 需要的就是这份数据——只看最后一次等于每次都从零开始猜。
    const historyPath = join(resolveStateDir(), 'judgements.jsonl');
    let history = '';
    try {
      history = readTextSync(historyPath);
    } catch {
      history = '';
    }
    const line = JSON.stringify(compact({
      at,
      kind: judgement.kind ?? 'memory',
      title,
      verdict: judgement.verdict,
      worth: judgement.worth,
      scope: judgement.scope,
      confidence: judgement.confidence,
      ms: judgement.ms,
      reason: judgement.reason,
      merged: judgement.mergeInto?.title,
      stale: judgement.staleInto?.title,
    }));
    // 只留最近 500 行：这是诊断流水，不是账本。
    const kept = `${history}${line}\n`.split('\n').filter((row) => row.trim().length > 0).slice(-500);
    await writeFile(historyPath, `${kept.join('\n')}\n`, 'utf8');

    await writeFile(lastJudgementPath(), `${JSON.stringify(compact({
      at,
      verdict: judgement.verdict,
      worth: judgement.worth,
      scope: judgement.scope,
      confidence: judgement.confidence,
      ms: judgement.ms,
      reason: judgement.reason,
      enforced: judgement.enforced,
      probe: judgement.probe === true ? true : undefined,
      title,
    }))}\n`, 'utf8');
  } catch {
    // 记录本身只是诊断信息。
  }
}

/** 读回最近一次判定；没有就是 undefined。 */
async function readLastJudgement() {
  try {
    const text = await readFile(lastJudgementPath(), 'utf8');
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 用户是否明确要求「记住」。
 *
 * 触发条件一直是「失败 / 复杂链路」，但这套机制最该记住的其实是**用户亲口
 * 说出来的偏好与规矩**——那种消息往往只有一两步、不会有任何失败信号，
 * 按旧逻辑永远不会触发。这里补一个显式信号：命中了就本轮直接就绪。
 *
 * 只认祈使式表达（记住/以后都/我习惯…），不认「你还记得吗」这类回忆问句。
 */
const REMEMBER_INTENT = [
  /记住|记一下|记下来|记牢|帮我记|请记|记到记忆|写进记忆|以后都|以后别|以后不要|下次别|别再|我的习惯|我习惯|我的偏好|我偏好|我喜好|我喜欢|我讨厌|我倾向/,
  /\b(?:remember (?:that|this|my)|from now on|i prefer|my preference|note that i)\b/i,
];

/** 偏好类：这类该进全局记忆（每个项目都加载），而不是某个仓库的记忆。 */
const PREFERENCE_INTENT = [/(?:喜好|偏好|习惯|喜欢|讨厌|倾向|风格|以后都|以后别|以后不要|别再|i prefer|my preference)/i];

/** 把一条消息的正文取出来（字符串或分段数组都兼容）。 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join(' ');
  }
  return '';
}

/** 命中「记住我…」时返回 { snippet, preference }，否则 undefined。 */
function rememberIntent(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  if (!REMEMBER_INTENT.some((pattern) => pattern.test(text))) return undefined;
  const snippet = oneLine(text, 80);
  return {
    snippet,
    preference: PREFERENCE_INTENT.some((pattern) => pattern.test(text)),
  };
}

// ---------------------------------------------------------------------------
// 决策模型（火山方舟「决策评估」beta / System One API）
// ---------------------------------------------------------------------------

/**
 * 判定用一次 HTTP 调用回答两个问题：这条记忆值不值得留、该写哪一档。
 *
 * 为什么用决策模型而不是让主模型自证：主模型写完之后再自评「值不值」，
 * 等于让它给自己打分；判定模型给的是同一份 rubric 下的概率，跨条可比、
 * 可设阈值，而且 `output_tokens` 恒为 0（只有概率没有生成），很快也很便宜。
 *
 * 为什么只判「已经写好的候选」而不是从轨迹里找价值：state 是压扁的，
 * 让它从轨迹里找价值只会退化成看「这轮有没有报错」；候选是模型已经
 * 提炼过的结论，判断题才有意义。
 */
const DECISION_DEFAULTS = {
  enabled: false,
  // 影子模式：照常判定、只记录不拦截。先跑几天对一遍直觉，再打开拦截。
  shadow: true,
  model: 'doubao-seed-2-1-lite-260915',
  baseURL: 'https://ark.cn-beijing.volces.com/api/v1',
  // 直接写 key（插件配置里配），或以 `env:NAME` 引用环境变量。
  apiKey: '',
  apiKeyEnv: 'A_API_KEY',
  // 超时必须短：判定是锦上添花，不能让进化机制卡住回答。
  // 实测 System One 延迟波动很大（543 / 1381 / 5434ms 都出现过）：900ms 会频繁降级。
  timeoutMs: 1800,
  worthThreshold: 0.5,
  // 落点判定低于这个置信度就退回模型自己选的那档。
  scopeMinConfidence: 0.6,
};

/** 解析 key：显式配置优先，其次环境变量。返回 { key, source }。 */
function resolveDecisionKey(decision) {
  const inline = typeof decision.apiKey === 'string' ? decision.apiKey.trim() : '';
  if (inline.startsWith('env:')) {
    const name = inline.slice(4).trim();
    const value = name.length === 0 ? '' : process.env[name] ?? '';
    return { key: value, source: value === '' ? 'missing-env' : `env:${name}` };
  }
  if (inline.length > 0) return { key: inline, source: 'config' };
  const envName = typeof decision.apiKeyEnv === 'string' ? decision.apiKeyEnv.trim() : '';
  const fromEnv = envName.length === 0 ? '' : process.env[envName] ?? '';
  return { key: fromEnv, source: fromEnv === '' ? 'missing-env' : `env:${envName}` };
}

/** 去掉值为 undefined 的键：工具输出必须是 lossless JSON，undefined 会被判非法。 */
function compact(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out;
}

function clamp01(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined;
}

/** 调一次判定接口；任何失败都返回 degraded，调用方据此照常写入（fail-open）。 */
async function judgeLesson(decision, lesson, existing, signal) {
  const started = Date.now();
  const base = {
    verdict: 'degraded',
    reason: '',
    worth: undefined,
    scope: undefined,
    confidence: undefined,
    model: decision.model,
    ms: 0,
    enforced: decision.shadow !== true,
  };
  const { key } = resolveDecisionKey(decision);
  if (key === '') return compact({ ...base, reason: 'no-api-key', ms: Date.now() - started });

  const url = `${String(decision.baseURL).replace(/\/+$/, '')}/systemone`;
  // 按官方最佳实践重构判定流程：
  //  1. question 短、正文放 state（长问题直接拖慢时延）；
  //  2. 固定内容前置、动态内容末尾，两段请求共享同一前缀，命中 prefix cache；
  //  3. 多问题之间无上下文，所以判定树自己做：worth 闸门 → scope 定档 →
  //     relation 取代 → stale 过期，低置信度的「取代/过期」一律不执行。
  // 标题全量、正文按相关性取前 12 条：
  //  - 全量标题 ≈ 50 × 24 字，代价很小，但能彻底消掉「记过却看不见」的盲区；
  //  - 正文才是贵的那部分，只给最可能相关（以及最近）的条目。
  const full = existing.slice(0, 60).map((item, index) => ({ id: `e${index}`, ...item }));
  const roster = recallEntries(full, lesson, 12).map((item) => ({
    id: item.id,
    scope: item.scope,
    title: item.title,
    body: cutText(item.body ?? '', 200),
  }));
  const titles = full.map((item) => `${item.id} [${item.scope === 'global' ? '全局' : '项目'}] ${item.title}`);
  const worthQuestion = {
    type: 'noul',
    instructions: '这条记忆值得单独记一条吗？先看 state.titles 已经记过什么。',
    criteria: {
      true: '带来新信息，或要更新已有条目（换命令、避坑、新结论、新偏好）',
      false: 'state.titles 里已有条目完整涵盖，或只是本次任务的结论、报错原文',
    },
  };
  // 选项只写编号，标题在 state.titles 里（那里带档位前缀）——criteria 越长越慢。
  const choices = Object.fromEntries(full.map((item) => [item.id, item.id]));
  const scopeQuestion = {
    type: 'choice',
    instructions: '这条记忆写哪一档？',
    criteria: {
      global: '用户的长期偏好与习惯，或跨项目都成立的协作方式',
      project: '其余一律项目：具体工具/接口用法、命令、路径、本仓库约定',
    },
  };
  // 归属判断交给模型：很多经验其实是「某个技能本身的缺陷」，写进记忆就永远不会被修。
  const kindQuestion = {
    type: 'choice',
    instructions: '这条经验该改某个技能本身，还是只记一条记忆？',
    criteria: {
      skill: '指出某个已装技能自身的缺陷或可改进处：它的脚本、模板、report 生成逻辑、README 说明有错或会误导',
      memory: '其余一律记忆：用户偏好、事实、命令用法、踩坑记录；不涉及改写某个技能的文件',
    },
  };
  const relationQuestion = {
    type: 'choice',
    instructions: '新记忆在更新已有哪一条？看 state.existing，没有就 none。',
    criteria: { none: '没有讲同一件事的', ...choices },
  };
  const staleQuestion = {
    type: 'choice',
    instructions: '这次写入让已有哪一条的前提不再成立？没有就 none。',
    criteria: { none: '没有因此过期的', ...choices },
  };
  const state = {
    candidate: { title: lesson.title, summary: lesson.summary, kind: lesson.kind ?? 'memory' },
    titles,
    existing: roster,
  };

  /** 单次提问：自己的超时，自己的 abort；失败抛错由外层统一降级。 */
  const ask = async (questions) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), decision.timeoutMs);
    const forward = () => controller.abort();
    if (signal !== undefined && typeof signal.addEventListener === 'function') signal.addEventListener('abort', forward);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
          'ark-beta-systemone-api': 'true',
        },
        body: JSON.stringify({ model: decision.model, questions, state }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`http-${response.status}`);
      const json = await response.json();
      return json?.answers ?? {};
    } finally {
      clearTimeout(timer);
      if (signal !== undefined && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', forward);
    }
  };

  try {
    let answers = {};
    // 低分但被关系判定救回来的条目：值得写，因为它是同一件事的更新版。
    let rescued = false;
    if (decision.stagedJudge === false) {
      answers = await ask({ worth_v1: worthQuestion, scope_v1: scopeQuestion, kind_v1: kindQuestion, relation_v1: relationQuestion, stale_v1: staleQuestion });
    } else {
      // 阶段一：只问「值不值得」。不值得的那部分占四成，省掉的是整次请求。
      answers = await ask({ worth_v1: worthQuestion });
      const firstWorth = clamp01(answers?.worth_v1?.noul);
      if (firstWorth !== undefined && firstWorth < decision.worthThreshold) {
        // 「已有条目已涵盖」可能是同一件事的第二版：低分但标题高度重合时，
        // 再问一次关系。命中就按更新处理（取代旧条目），而不是把新结论丢掉。
        const related = full.find((item) => tokenOverlap(item.title, lesson.title) >= 0.5);
        if (related === undefined) {
          return compact({ ...base, verdict: 'not-worth', worth: firstWorth, confidence: clamp01(answers?.worth_v1?.confidence), reason: '', ms: Date.now() - started });
        }
        const relationOnly = await ask({ kind_v1: kindQuestion, relation_v1: relationQuestion, stale_v1: staleQuestion });
        const hit = Object.values(relationOnly).some((answer) => typeof answer?.choice === 'string' && /^e\d+$/.test(answer.choice));
        if (!hit) {
          return compact({ ...base, verdict: 'not-worth', worth: firstWorth, confidence: clamp01(answers?.worth_v1?.confidence), reason: '', ms: Date.now() - started });
        }
        // 命中：当成 worth 继续走下面的取代逻辑，但预算里已经花掉一次请求。
        answers = { ...answers, ...relationOnly };
        rescued = true;
      } else {
        // 阶段二：worth_v1 原样打头，与阶段一请求前缀逐字节一致 → prefix cache 命中。
        answers = { ...answers, ...await ask({ worth_v1: worthQuestion, scope_v1: scopeQuestion, kind_v1: kindQuestion, relation_v1: relationQuestion, stale_v1: staleQuestion }) };
      }
    }
    const json = { answers };
    const worth = clamp01(json?.answers?.worth_v1?.noul);
    const scope = typeof json?.answers?.scope_v1?.choice === 'string' ? json.answers.scope_v1.choice : undefined;
    const kindChoice = typeof json?.answers?.kind_v1?.choice === 'string' ? json.answers.kind_v1.choice : undefined;
    const kindConfidence = clamp01(json?.answers?.kind_v1?.confidence);
    const kindVerdict = (kindConfidence ?? 1) >= 0.6 && (kindChoice === 'skill' || kindChoice === 'memory')
      ? kindChoice
      : undefined;
    const confidence = clamp01(json?.answers?.scope_v1?.confidence);
    const verdict = lesson.probe === true || rescued || worth === undefined || worth >= decision.worthThreshold ? 'worth' : 'not-worth';
    // 交叉校验（文档第 3 条：多问题之间没有上下文，逻辑树得自己做）：
    // 置信度不够的「取代 / 过期」不执行——删错一条记忆比多留一条贵得多。
    const minConfidence = typeof decision.relationMinConfidence === 'number' ? decision.relationMinConfidence : 0.5;
    const relationConfidence = clamp01(json?.answers?.relation_v1?.confidence);
    const staleConfidence = clamp01(json?.answers?.stale_v1?.confidence);
    // 指认重复：只有落在候选列表范围内才认，索引越界一律当「没有重复」。
    const mergeChoice = (relationConfidence ?? 1) < minConfidence ? undefined : pickChoice(json, ['relation_v1', 'merge_v1']);
    const mergeMatch = /^e(\d+)$/.exec(mergeChoice);
    const mergeIndex = mergeMatch === null ? -1 : Number(mergeMatch[1]);
    const mergeTarget = mergeIndex >= 0 && mergeIndex < full.length ? full[mergeIndex] : undefined;
    // 过期条目：这次写入让它的一句前提不再成立，需要归档。跨档同样允许。
    const staleChoice = (staleConfidence ?? 1) < minConfidence ? undefined : pickChoice(json, ['stale_v1']);
    const staleMatch = /^e(\d+)$/.exec(staleChoice);
    const staleIndex = staleMatch === null ? -1 : Number(staleMatch[1]);
    const staleTarget = staleIndex >= 0 && staleIndex < full.length ? full[staleIndex] : undefined;
    return compact({
      ...base,
      verdict,
      worth,
      scope: scope === 'global' || scope === 'project' ? scope : undefined,
      // 归属：这条经验该改技能本身，还是只记一条记忆。模型说了算。
      kind: kindVerdict,
      confidence,
      // 命中重复时带上「哪一档、第几条」，写盘时直接取代它。
      mergeInto: mergeTarget === undefined
        ? undefined
        : { file: mergeTarget.file, index: mergeTarget.index, title: mergeTarget.title, scope: mergeTarget.scope },
      // 过期条目：单独归档，不参与「谁取代谁」。
      staleInto: staleTarget === undefined
        ? undefined
        : { file: staleTarget.file, index: staleTarget.index, title: staleTarget.title, scope: staleTarget.scope },
      reason: '',
      ms: Date.now() - started,
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network';
    return compact({ ...base, reason, ms: Date.now() - started });
  }
}

/**
 * 技能改写也过决策模型：**这次改动值得做吗**。
 *
 * 为什么必须判：记忆是「加一条」，改技能是「替换已有的东西」——把一份跑得好好的
 * 技能换成更啰嗦的版本，或只是换个措辞，都是在制造回归。判定模型看的是
 * 「改完之后同类任务的做法会不会变」，而不是「新版本读起来顺不顺」。
 *
 * 与记忆判定一致：900ms 超时、失败放行（fail-open）、影子模式只记录不拦截。
 */
async function judgeSkillRewrite(decision, payload, signal) {
  const started = Date.now();
  const base = {
    verdict: 'degraded',
    reason: '',
    worth: undefined,
    confidence: undefined,
    model: decision.model,
    ms: 0,
    enforced: decision.shadow !== true,
  };
  const { key } = resolveDecisionKey(decision);
  if (key === '') return compact({ ...base, reason: 'no-api-key', ms: Date.now() - started });

  const cut = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}\n…（截断）`);
  const url = `${String(decision.baseURL).replace(/\/+$/, '')}/systemone`;
  const body = {
    model: decision.model,
    state: {
      skill: payload.skillName,
      // 只给判定用的摘要：整份技能可能有几千字，全塞进去会拖慢 900ms 的预算。
      reason: payload.reason,
      files: payload.files.map((file) => ({ path: file.path, charsBefore: file.before.length, charsAfter: file.after.length })),
      before: cut(payload.before, 3000),
      after: cut(payload.after, 3000),
    },
    questions: {
      worth_v2: {
        type: 'noul',
        instructions: '这次对已有技能的改写是否值得应用？',
        criteria: {
          true: '修掉了一个真实的坑、删掉了真实的重复或补上了缺失的能力/脚本；改完之后同类任务的做法会不同',
          false: '只是换措辞、调格式、加免责声明，或把已经写清楚的内容再写一遍；让技能变长却没有新信息的改动',
        },
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), decision.timeoutMs);
  const forward = () => controller.abort();
  if (signal !== undefined && typeof signal.addEventListener === 'function') signal.addEventListener('abort', forward);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'ark-beta-systemone-api': 'true',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return compact({ ...base, reason: `http-${response.status}`, ms: Date.now() - started });
    const json = await response.json();
    const worth = clamp01(json?.answers?.worth_v2?.noul);
    const verdict = worth !== undefined && worth < decision.worthThreshold ? 'not-worth' : 'worth';
    return compact({ ...base, verdict, worth, reason: '', ms: Date.now() - started });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network';
    return compact({ ...base, reason, ms: Date.now() - started });
  } finally {
    clearTimeout(timer);
    if (signal !== undefined && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', forward);
  }
}

/**
 * 已有记忆的标题（带文件与行内序号）：判定时作为查重上下文，避免「换个说法又记一条」。
 *
 * 必须带 `index`：模型指认「重复的是第 3 条」时，要靠它定位到那一档里的第几条，
 * 光有标题没法删对行（两档可能各有一条同名）。
 */
async function memoryTitles(storage, targets, signal) {
  const items = [];
  for (const [scope, file] of Object.entries(targets.memoryTargets ?? { global: targets.memoryPath })) {
    try {
      const text = await storage.read(file, signal);
      bulletLines(text, 'memory').forEach(({ line }, index) => {
        const parsed = parseLessonBullet(line, 'memory');
        // body 也带上：判定「是不是同一件事」必须看正文，光看标题会把
        // 「财报取数链路」和「联网搜索走豆包 CLI」当成两条无关的东西。
        if (parsed !== undefined) items.push({ title: parsed.title, body: parsed.body, date: parsed.date, file, index, scope });
      });
    } catch {
      // 读不到就当没有。
    }
  }
  return items;
}

/** 截断到 n 个字（按 code point，中文算一个），给判定模型省预算用。 */
function cutText(text, n) {
  const chars = [...String(text ?? '')];
  return chars.length <= n ? chars.join('') : `${chars.slice(0, n).join('')}…`;
}

/** 从 answers 里按优先级取第一个非空 choice（兼容旧问题名）。 */
function pickChoice(json, names) {
  for (const name of names) {
    const value = json?.answers?.[name]?.choice;
    if (typeof value === 'string' && value !== '') return value;
  }
  return 'none';
}

/** 从一条记忆 bullet 里取正文（`：` 之后的部分），用于判重。 */
function bodyKey(line) {
  const at = line.indexOf('：');
  return at >= 0 ? line.slice(at + 1) : line;
}

/** 从一条记忆 bullet 里取标题（`- 2026-10-20 · 标题：正文`）。 */
function entryTitle(line) {
  const match = /^-\s+\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?\s+·\s+(.*?)[：:]/.exec(line);
  return match === null ? '' : match[1].trim();
}

/** 像「偏好 / 喜好 / 习惯」这类条目：同一个话题只该留最后一条，否则会互相打脸。 */
const PREFERENCE_LIKE = /偏好|喜好|习惯|喜欢|不喜欢|讨厌|倾向|\bprefer|\bpreference|\bfavorite/i;

/**
 * 能不能进全局记忆。
 *
 * 用户的规则很明确：**只有「用户个人偏好 / 习惯 / 协作方式」才配全局**，其余一律
 * 项目级。判定模型的 scope 建议只是参考，最终由这条正则把关——否则「某个文档站点
 * 的接口怎么调」这种一次性知识会被判成跨项目事实，每轮都跟着上下文走。
 */
const GLOBAL_SCOPE_OK = /偏好|喜好|习惯|喜欢|不喜欢|讨厌|倾向|更愿意|希望|称呼|语气|风格|格式|语言|回答|回复|措辞|\bprefer|\bpreference|\bfavorite/i;

/**
 * 本机环境事实：哪条命令能用、key 放哪、工具装在哪。
 *
 * 这类知识也是跨项目的——换个仓库，`web_search 不可用` 依然成立。用户全局记忆里
 * 的「联网搜索走豆包 Custom CLI」就是这个形状。只看「偏好词」会把它们全压成
 * 项目级，等于每个项目重新踩一遍同样的坑。
 */
const ENV_FACT_OK = /本机|这台机器|环境变量|API[_ ]?KEY|密钥|key 在|一律用|统一用|只能用|不可用|用不了|失效|装在|装到|安装在|命令行|\bCLI\b|~\.?\/?\.dsh|\/tmp\b|PATH|代理|沙箱|web_search|dsearch|\.py\b|\.sh\b/i;

/** 明显只属于当前仓库的：工作区路径、仓库名、端口。这些即便像环境事实也不进全局。 */
const PROJECT_LOCAL = /工作区|这个仓库|本仓库|本项目|这个项目|workspace|\/Users\/[^\s/]+\/Documents\/|localhost:\d+|127\.0\.0\.1:\d+/i;

/**
 * 档位闸门：判定模型可信就听它的，正则只在它没给出结论时兜底。
 *
 * 之前正则永远有最终否决权，于是「提交前先跑 node --check」这种明明跨项目成立、
 * 却不含「偏好 / web_search」等关键词的规矩会被强行塞回项目级。正则只会看词，
 * 判定模型看的是语义——用词表覆盖语义是本末倒置。绝对路径与本机端口除外，
 * 那是「这条绑死在这台机器的工作区」的硬证据。
 */
export function gateScope(settings, lesson) {
  if (lesson.scope !== 'global') return lesson.scope ?? 'project';
  const text = `${lesson.title} ${lesson.summary} ${lesson.full ?? ''}`;
  // 工作区/端口这类词是「这条绑死在本仓库」的强证据，对模型也保留否决权；
  // 但「偏好/web_search」这类正向词表不再有最终否决权——那是判定模型该管的事。
  if (HARD_LOCAL.test(text) || PROJECT_LOCAL.test(text)) return 'project';
  const confidence = typeof lesson.scopeConfidence === 'number' ? lesson.scopeConfidence : 0;
  const trusted = lesson.scopeJudged === true && confidence >= (settings.scopeMinConfidence ?? 0.6);
  if (trusted) return 'global';
  const allowed = (GLOBAL_SCOPE_OK.test(text) || ENV_FACT_OK.test(text)) && !PROJECT_LOCAL.test(text);
  return allowed ? 'global' : 'project';
}

/** 硬证据：绝对的本机工作区路径 / 本机端口。对判定模型也保留否决权。 */
const HARD_LOCAL = /\/Users\/[^\s/]+\/Documents\/|localhost:\d+|127\.0\.0\.1:\d+/i;

/** 话题判定用的停用词：这些词几乎每条偏好都有，不能用来判断说的是同一件事。 */
const TOPIC_STOPWORDS = new Set([
  '偏好', '喜好', '习惯', '喜欢', '不喜欢', '讨厌', '倾向', '语言', '用户', '默认', '不要',
  '优先', '写法', '风格', '代码', '脚本', '工具', '例子', '示例', 'the', 'and', 'for', 'with',
  'prefer', 'preference', 'user', 'use', 'using', 'not', 'default',
]);

/** 把一段文字切成可比较的话题词：英文单词 + 中文双字以上片段。 */
function topicTokens(text) {
  const tokens = new Set();
  for (const word of String(text).toLowerCase().match(/[a-z][a-z0-9+#./-]{1,}/g) ?? []) {
    if (!TOPIC_STOPWORDS.has(word)) tokens.add(word);
  }
  for (const run of String(text).match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 2) {
      const pair = run.slice(index, index + 2);
      if (!TOPIC_STOPWORDS.has(pair)) tokens.add(pair);
    }
  }
  return tokens;
}

/**
 * 话题重合度打分：共用的技术词（java / ts/js / python 这种 ≥3 字符的英文词）算 2 分，
 * 共用的中文双字词算 1 分。分开计分是因为「语言偏好」这类中文词太泛，不能单独作数，
 * 而「都提到了 ts/js」本身就说明在说同一件事。
 */
function topicScore(left, right) {
  let score = 0;
  for (const token of left) {
    if (!right.has(token)) continue;
    score += /[a-z]/.test(token) ? 2 : 1;
  }
  return score;
}

/**
 * 哪些旧条目应该被这条新结论取代。
 *
 * 两条规则：
 * 1. 标题完全相同 → 原地更新（老行为）；
 * 2. 两边都是「偏好类」且话题词重合 ≥ 2 → 取代。
 *
 * 为什么要第二条：用户先说喜欢 TS，再说喜欢 Java，又说不要 Java——只按标题去重会
 * 攒出三条互相矛盾的偏好，等于把用户的立场写乱了。偏好本来就是「最新一次表态算数」。
 */
function supersededIndexes(entries, lesson) {
  const title = typeof lesson.title === 'string' ? lesson.title : '';
  const lessonText = `${title} ${lesson.summary ?? ''}`;
  const lessonIsPreference = PREFERENCE_LIKE.test(lessonText);
  const lessonTokens = topicTokens(lessonText);
  const found = [];
  entries.forEach((line, index) => {
    const lineTitle = entryTitle(line);
    if (title !== '' && lineTitle === title) {
      found.push(index);
      return;
    }
    if (!lessonIsPreference) return;
    const lineText = `${lineTitle} ${bodyKey(line)}`;
    if (!PREFERENCE_LIKE.test(lineText)) return;
    if (topicScore(lessonTokens, topicTokens(lineText)) >= 2) found.push(index);
  });
  return found;
}

/** 更新全局记忆，返回写入结果。 */
/**
 * 把被上限淘汰的条目原文落进归档文件。
 *
 * 为什么必须留底：条目数 / 字节数到顶时，插件会淘汰**最老的**条目——那是用户
 * 几个星期前真金白银总结出来的东西，静默消失是最差的处理。「淘汰」应该是
 * 「挪出常驻上下文」，不是「删掉」。
 */
async function archiveEvicted(lines, settings, reason) {
  if (lines.length === 0) return '';
  const path = join(resolveStateDir(), 'archive', 'memory.md');
  let existing = '';
  try {
    existing = readTextSync(path);
  } catch {
    existing = '';
  }
  const head = existing.length === 0 ? '# 记忆归档（self-evolve 因上限淘汰的原文）\n' : existing;
  // 和记忆条目用同一套时钟：本地时间、精确到秒。
  const stamp = stampNow();
  const title = reason === 'purge'
    ? '手动清空（孟婆汤）'
    : reason === 'superseded'
      ? '被新结论取代'
      : reason === 'stale'
        ? '前提已过期'
        : reason === 'bytes' ? '字节上限' : '条数上限';
  const block = `\n## ${stamp} · ${title}淘汰 ${lines.length} 条（上限 ${settings.maxMemoryEntries} 条 / ${settings.maxMemoryBytes} 字节）\n\n${lines.map((line) => `${line}\n`).join('')}`;
  try {
    await writeStateFile(path, await rotateArchive(head + block, settings));
    return path;
  } catch {
    // 归档写不进去（权限等）不该连累主写入：条目信息仍会随结果返回。
    return '';
  }
}

/**
 * 从**另一份**记忆文件里移除一条（跨档取代/过期时用），原文同时进归档。
 *
 * 返回 `{path, title}` 便于结果里说明「已经把它挪走了」；索引越界或读不到文件
 * 一律当没发生过——跨档判断错了不该让这次写入失败。
 */
/**
 * 按目标文件串行化读改写。
 *
 * 为什么必须有：`writeMemory` 是「读整文件 → 拼一段 → 写回」，两次并发写各自
 * 基于同一份旧内容，后写的那次会把前一次整条覆盖掉——后台整理（A2 那条
 * `void` 任务）正好会和下一轮沉淀撞在一起，用户看到的就是「刚记的没了」。
 */
const fileQueues = new Map();

function withFileLock(file, task) {
  const key = resolve(file);
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  // 队列只关心顺序，失败要吞掉，否则一次失败会卡死这个文件的后续所有写入。
  fileQueues.set(key, next.then(() => {}, () => {}));
  return next;
}

async function removeEntryAt(storage, file, index, settings, signal) {
  return withFileLock(file, () => removeEntryAtUnlocked(storage, file, index, settings, signal));
}

async function removeEntryAtUnlocked(storage, file, index, settings, signal) {
  if (!Number.isInteger(index) || index < 0) return undefined;
  let text = '';
  try {
    text = await storage.read(file, signal);
  } catch {
    return undefined;
  }
  const bullets = bulletLines(text, 'memory');
  if (index >= bullets.length) return undefined;
  const target = bullets[index].line;
  const nextText = text
    .split('\n')
    .filter((line) => line !== target)
    .join('\n');
  try {
    await storage.write(file, nextText.endsWith('\n') ? nextText : `${nextText}\n`, signal);
  } catch {
    return undefined;
  }
  await archiveEvicted([target], settings, 'superseded');
  return { path: file, title: entryTitle(target) };
}


/**
 * 体检：把存量记忆两两配对，让判定模型说「这俩是不是在讲同一件事」。
 *
 * 写入时判断只能管新条目；已经堆在文件里的重复/过期（尤其人手工改文件写进来的那种）
 * 只能靠一次全量扫描。这里先用本地相似度粗筛（省模型调用），再把候选对交给模型。
 */
function memoryTokens(text) {
  const out = new Set();
  const ascii = String(text).toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? [];
  ascii.forEach((word) => out.add(word));
  const cjk = String(text).replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    for (let index = 0; index + 2 <= run.length; index += 1) out.add(run.slice(index, index + 2));
  }
  return out;
}

function tokenOverlap(a, b) {
  const left = memoryTokens(a);
  const right = memoryTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * 稀有词：`web_search`、`dsearch`、`getDocDetail` 这种长 ASCII 词。
 *
 * 为什么还要它：中文二元组相似度抓不到「两条都在讲 web_search」——一条说
 * 「web_search 缺 key 所以 curl 东财」，另一条说「web_search 不可用所以改走 dsearch」，
 * 字面重合只有 web_search 一个词（相似度 0.04），但语义上是同一件事。
 */
function rareTokens(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9_]{6,}/g) ?? [];
  // 路径和公共域名会把所有条目连成一团（每条都带 `details/…`、`bytedance`），
  // 这些词不携带「讲的是同一件事」的信息，直接丢掉。
  const stop = new Set(['bytedance', 'details', 'documents', 'harness', 'default', 'workspace', 'https', 'volces']);
  return new Set(words.filter((word) => !stop.has(word)));
}

/** 配对用的文本：去掉「详见 …」那段路径指引，它会污染相似度。 */
function pairText(entry) {
  return `${entry.title} ${String(entry.body ?? '').split('详见')[0]}`;
}

/**
 * 相关性召回：挑最可能与新条目有关的已有条目，交给判定模型。
 *
 * 记忆一多，「取前 12 条」就等于随机——真正该接替的那条可能排在第 30。
 * 打分用字面相似度（中文二元组 + 稀有词），再补上最近的几条兜底。
 */
function recallEntries(entries, lesson, limit = 12) {
  if (entries.length <= limit) return entries;
  const text = pairText({ title: lesson.title, body: lesson.summary });
  const scored = entries.map((item) => {
    const left = rareTokens(pairText(item));
    const right = rareTokens(text);
    let shared = 0;
    for (const token of right) if (left.has(token)) shared += 1;
    return { item, score: tokenOverlap(pairText(item), text) + shared * 0.3 };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, limit).map((row) => row.item);
  // 最近的几条也塞进来：它们最可能是「被接替的那条」。
  const recent = [...entries].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, 4);
  for (const item of recent) {
    if (!picked.some((x) => x.file === item.file && x.index === item.index)) picked.push(item);
  }
  return picked.slice(0, limit + 4);
}

/** 候选配对：只把本地看起来像的交给模型，避免 O(n²) 次调用。 */
function candidatePairs(entries, limit) {
  const pairs = [];
  const others = entries.filter((item, index) => entries.findIndex((x) => x.file === item.file && x.index === item.index) === index);
  for (let i = 0; i < others.length; i += 1) {
    for (let j = i + 1; j < others.length; j += 1) {
      const leftText = pairText(others[i]);
      const rightText = pairText(others[j]);
      const overlap = tokenOverlap(leftText, rightText);
      const leftRare = rareTokens(leftText);
      const rightRare = rareTokens(rightText);
      let shared = 0;
      for (const token of leftRare) if (rightRare.has(token)) shared += 1;
      // 共用一个稀有词算强信号：它通常就是「同一件事」的锚点。
      const score = Math.max(overlap, shared > 0 ? 0.35 + Math.min(shared, 3) * 0.1 : 0);
      if (score >= 0.34) pairs.push({ left: others[i], right: others[j], score });
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function judgePair(decision, pair, signal) {
  const { key } = resolveDecisionKey(decision);
  if (key === '') return undefined;
  const url = `${String(decision.baseURL).replace(/\/+$/, '')}/systemone`;
  const body = {
    model: decision.model,
    // 同样按缓存建议：固定问题在前，变化的条目在最后。
    questions: {
      verdict_v3: {
        type: 'choice',
        instructions: '这两条长期记忆是什么关系？',
        criteria: {
          same: '讲的是同一件事，只是措辞不同；留一条就够',
          update: 'B 是 A 的更新版（或反过来），旧的那条已经过时',
          complement: '各自补充了对方没有的信息，两条都该留',
          unrelated: '主题不同，不该合并',
        },
      },
    },
    state: {
      a: { scope: pair.left.scope, title: pair.left.title, body: cutText(pair.left.body, 300) },
      b: { scope: pair.right.scope, title: pair.right.title, body: cutText(pair.right.body, 300) },
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), decision.timeoutMs);
  const forward = () => controller.abort();
  signal?.addEventListener?.('abort', forward);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'ark-beta-systemone-api': 'true' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return { verdict: 'error', reason: `http-${response.status}` };
    const json = await response.json();
    const verdict = json?.answers?.verdict_v3?.choice;
    return { verdict: ['same', 'update', 'complement', 'unrelated'].includes(verdict) ? verdict : 'unrelated' };
  } catch (error) {
    return { verdict: 'error', reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', forward);
  }
}

/**
 * 整理记忆：配对 → 判定 → （可选）自动合并。
 *
 * `autoMerge` 只在判定为 `same` 时动手：两条讲同一件事，留新的、旧的进归档。
 * `update` 不自动合并——它多半意味着旧条目还有别的信息，交给人决定。
 */
export async function healthcheckMemory(storage, settings, targets, signal, options) {
  const autoMerge = options?.autoMerge === true;
  const entries = (await memoryTitles(storage, targets, signal)).filter((item) => item.title !== '');
  // 后台整理不挡人：预算放大，少一次降级比快 2 秒重要。
  const decision = { ...settings.decision, timeoutMs: Math.max(settings.decision.timeoutMs, 5000) };
  const pairs = candidatePairs(entries, 6);
  const rows = [];
  const verdicts = [];
  for (let index = 0; index < pairs.length; index += 3) {
    const chunk = pairs.slice(index, index + 3);
    verdicts.push(...await Promise.all(chunk.map((pair) => judgePair(decision, pair, signal))));
  }
  pairs.forEach((pair, index) => {
    const judged = verdicts[index];
    rows.push({
      verdict: judged?.verdict ?? 'unchecked',
      reason: judged?.reason ?? '',
      score: Number(pair.score.toFixed(2)),
      left: { file: pair.left.file, index: pair.left.index, scope: pair.left.scope, title: pair.left.title, date: pair.left.date, preview: cutText(pair.left.body, 120) },
      right: { file: pair.right.file, index: pair.right.index, scope: pair.right.scope, title: pair.right.title, date: pair.right.date, preview: cutText(pair.right.body, 120) },
    });
  });

  const merged = [];
  if (autoMerge) {
    for (const row of rows) {
      if (row.verdict !== 'same') continue;
      const newer = String(row.left.date ?? '') >= String(row.right.date ?? '') ? row.left : row.right;
      const older = newer === row.left ? row.right : row.left;
      const result = await mergeMemoryEntries(storage, settings, newer, [older], signal);
      if (result.removed.length > 0) merged.push({ kept: newer.title, removed: result.removed.map((item) => item.title) });
    }
  }
  const report = { total: entries.length, pairs: rows, merged, at: stampNow() };
  await writeAudit(report);
  return report;
}

/** 上次整理的时间与结果：界面上回答「记忆最近被谁整理过」。 */
function auditFilePath() {
  return join(resolveStateDir(), 'audit.json');
}

/** 判断模型的执行流水：界面上要能看见「它判了什么、判多久、为什么」。 */
export function readJudgements(limit = 30) {
  try {
    const text = readTextSync(join(resolveStateDir(), 'judgements.jsonl'));
    const rows = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') rows.push(parsed);
      } catch {
        // 坏行跳过，不让一行脏数据毁掉整份日志。
      }
    }
    return rows.slice(-Math.max(1, limit)).reverse();
  } catch {
    return [];
  }
}

export function readAudit() {
  try {
    const parsed = JSON.parse(readTextSync(auditFilePath()));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 最近一次成功沉淀：桌宠动画只认这个文件，不再从对话卡片里反推。 */
function lastRecordPath() {
  return join(resolveStateDir(), 'last-record.json');
}

/**
 * 静默失败也要留痕。
 *
 * 之前大量 `catch {}` 把问题吞掉（动画 bug 就是这么查了三轮的）。这里统一记到
 * errors.log，只留最近 200 行，界面上「设置」和开发者都能看。
 */
async function noteError(scope, error) {
  try {
    const path = join(resolveStateDir(), 'errors.log');
    let history = '';
    try {
      history = readTextSync(path);
    } catch {
      history = '';
    }
    const message = error instanceof Error ? error.message : String(error);
    const line = JSON.stringify({ at: new Date().toISOString(), scope, message });
    const kept = `${history}${line}\n`.split('\n').filter((row) => row.trim() !== '').slice(-200);
    await writeStateFile(path, `${kept.join('\n')}\n`);
  } catch {
    // 记日志本身失败就算了，不能因此再抛。
  }
}

async function rememberRecord(written, lesson) {
  try {
    const entries = written.filter((entry) => entry.action !== 'unchanged');
    if (entries.length === 0) return;
    await writeStateFile(lastRecordPath(), JSON.stringify({
      at: stampNow(),
      atMs: Date.now(),
      count: entries.length,
      titles: entries.map((entry) => entry.title ?? lesson.title),
    }, null, 2));
  } catch {
    // 动画记录失败不影响写入。
  }
}

function readLastRecord() {
  try {
    const parsed = JSON.parse(readTextSync(lastRecordPath()));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeAudit(report) {
  try {
    await writeStateFile(auditFilePath(), JSON.stringify({
      at: report.at,
      total: report.total,
      pairs: report.pairs.length,
      merged: report.merged.length,
    }, null, 2));
  } catch {
    // 记录写不进去不影响整理本身。
  }
}

/** 合并：保留一条，其余归档。索引从大到小删，避免同一份文件里删一条后编号错位。 */
export async function mergeMemoryEntries(storage, settings, keep, drops, signal) {
  const sorted = [...drops].sort((a, b) => (a.file === b.file ? b.index - a.index : 0));
  const removed = [];
  for (const item of sorted) {
    if (resolve(item.file) === resolve(keep.file) && item.index === keep.index) continue;
    const cleared = await removeEntryAt(storage, item.file, item.index, settings, signal);
    if (cleared !== undefined) removed.push(cleared);
  }
  return { removed };
}

/**
 * 归档封顶：超过上限就把**最老**的小节挪进按月命名的归档分片。
 *
 * 「淘汰不等于删除」这条规矩要一直成立，但也不能让主归档文件无限膨胀——
 * 轮转后主文件恒定大小，历史仍在 `archive/memory-YYYY-MM.md` 里可查。
 */
async function rotateArchive(text, settings) {
  if (Buffer.byteLength(text, 'utf8') <= settings.maxArchiveBytes) return text;
  const parts = text.split(/\n(?=## )/);
  const header = parts.length > 0 && parts[0].startsWith('## ') ? '' : parts.shift() ?? '';
  // parts 现在全是 `## …` 小节，越靠后越新。
  const kept = [];
  let size = Buffer.byteLength(header, 'utf8');
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const bytes = Buffer.byteLength(part, 'utf8') + 1;
    if (size + bytes > settings.maxArchiveBytes && kept.length > 0) break;
    kept.unshift(part);
    size += bytes;
  }
  const moved = parts.slice(0, parts.length - kept.length);
  if (moved.length > 0) {
    const month = stampNow().slice(0, 7);
    const shardPath = join(resolveStateDir(), 'archive', `memory-${month}.md`);
    let shard = '';
    try {
      shard = readTextSync(shardPath);
    } catch {
      shard = '';
    }
    const shardHead = shard.length === 0 ? `# 记忆归档分片 ${month}（主归档轮转出来的旧小节）\n` : shard;
    await writeStateFile(shardPath, `${shardHead}${moved.map((part) => `\n${part}`).join('')}`);
  }
  return `${header}${kept.map((part) => `\n${part}`).join('')}`;
}

/**
 * 详情文件清扫：被取代/淘汰的条目如果指向一个 `details/*.md`，而留下来的人都不再引用它，
 * 这个文件就成了谁也找不到的孤儿。挪进 `archive/details/` 而不是删掉——留底，但不占地方。
 */
async function sweepDetailFiles(evictedLines, keptLines) {
  if (evictedLines.length === 0) return [];
  const kept = keptLines.join('\n');
  const moved = [];
  for (const line of evictedLines) {
    const match = /self-evolve\/details\/(.+?\.md)/.exec(line);
    if (match === null) continue;
    const name = match[1];
    if (kept.includes(name)) continue;
    const from = join(resolveStateDir(), 'details', name);
    const to = join(resolveStateDir(), 'archive', 'details', name);
    try {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      moved.push(name);
    } catch {
      // 文件本来就不在（比如详情没写成功）：没什么可搬的。
    }
  }
  return moved;
}

/** 技能根目录下所有已安装技能名（含用户自己的）：用来把经验对到具体技能。 */
async function installedSkillNames(targets, signal) {
  const names = [];
  try {
    const entries = await readdir(targets.skillRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await access(join(targets.skillRoot, entry.name, 'SKILL.md'));
        names.push(entry.name);
      } catch {
        // 没有 SKILL.md 的目录不算技能。
      }
    }
  } catch {
    return names;
  }
  return names.sort((a, b) => b.length - a.length);
}

/** 从经验正文里认技能名：优先命中名字最长的那个，避免 xxx-debug 抢了 xxx-debug-v2。 */
function matchSkillName(text, names) {
  const haystack = String(text ?? '').toLowerCase();
  // 长名优先：否则 `xxx-debug` 会抢走 `xxx-debug-v2` 的命中。
  const ordered = [...names].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    if (name.length >= 4 && haystack.includes(name)) return name;
  }
  return undefined;
}

/** 按 code point 数长度：中文一个字算一个，跟界面上的「字」一致。 */
function charLen(text) {
  return [...text].length;
}

/**
 * 在句末切开：优先「。」「；」「！」「？」，其次逗号顿号。
 *
 * 只在句末切会切出半个分句（实测出现过「…② deepseek-* 落到 openai 风格只发」这种
 * 断在半截的条目），所以退而求其次按逗号切；两者都找不到就硬切并标记 dangling，
 * 由调用方补省略号，保证「读起来是断了，而不是像写错了」。
 */
function cutToSentence(text, budget) {
  if (charLen(text) <= budget) return { text, truncated: false, dangling: false };
  const window = [...text].slice(0, budget).join('');
  const floor = Math.floor(budget * 0.5);
  const pick = (chars) => Math.max(...chars.map((mark) => window.lastIndexOf(mark)));
  const strong = pick(['。', '；', '！', '？', '\n']);
  const weak = pick(['，', '、', ',', '：', ':']);
  const at = strong >= floor ? strong : weak;
  if (at < floor) return { text: window, truncated: true, dangling: true };
  const cut = window.slice(0, at + 1);
  const dangling = !'。；！？\n'.includes(cut.slice(-1));
  return { text: cut, truncated: true, dangling };
}

/** 详情文件名：日期 + 标题（中文保留，路径分隔符和空格换成 -）。 */
function detailFileFor(date, title, seed) {
  const slug = title.replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'lesson';
  // 同一秒内两条同标题（一次调用里写两条很常见）会撞同一个文件名，后写的把前一条
  // 的详情覆盖掉。补 4 位内容哈希：仍然可读，又不会互相踩。
  let hash = 0;
  const source = typeof seed === 'string' && seed.length > 0 ? seed : `${date}${title}`;
  for (let index = 0; index < source.length; index += 1) hash = (hash * 31 + source.charCodeAt(index)) % 46656;
  const tag = hash.toString(36).padStart(3, '0');
  // 日期里现在带时分秒（`2026-10-21 16:44:04`）：文件名不能有空格和冒号，
  // 否则「按路径找详情文件」的那些逻辑（清扫、引用检查）全对不上。
  const stamp = String(date).replace(/[\s:]+/g, '-');
  // 同一秒内两条同标题（很正常：一次调用里写两条）会撞同一个文件名，
  // 后写的把前一条的详情覆盖掉。补 4 位内容哈希，保留可读性又不撞车。
  return join(resolveStateDir(), 'details', `${stamp}-${tag}-${slug}.md`);
}

/** 详情文件的正文：开头写清楚「这条为什么存在」，避免它变成孤儿文件。 */
function renderDetail(lesson, full) {
  return [
    `# ${lesson.title}`,
    '',
    `- 日期：${lesson.date}`,
    '- 来源：self-evolve（常驻记忆里只留结论，全文在这里按需读取）',
    '',
    full,
    '',
  ].join('\n');
}

/**
 * 写记忆。**长经验不整段进 AGENTS.md**。
 *
 * 记忆文件和技能目录不一样：它每一轮都在上下文里。一条 600 字的经验，等于让
 * 之后每个请求都多背 1.9 KB。所以正文预算（`maxMemoryLessonChars`，默认 220 字）
 * 之外的部分不再塞进常驻记忆，改成「一句话结论 + 指引」：
 *
 *   - 同时写了技能（kind='both'）→ 指引到技能名，模型需要时用 skill 工具加载；
 *   - 否则 → 全文落到 `$DSH_HOME/self-evolve/details/<日期>-<标题>.md`，指引写绝对路径。
 */
async function writeMemory(storage, settings, targets, lesson, signal, target) {
  // memoryTargetFor 返回的是 {path, …}，锁要按真实文件路径排队。
  const resolved = target ?? memoryTargetFor(targets, lesson.scope);
  const file = typeof resolved === 'string' ? resolved : resolved?.path ?? targets?.memoryPath ?? 'memory';
  return withFileLock(file, () => writeMemoryUnlocked(storage, settings, targets, lesson, signal, target));
}

async function writeMemoryUnlocked(storage, settings, targets, lesson, signal, target) {
  const resolved = target ?? memoryTargetFor(targets, lesson.scope);
  const path = resolved.path;
  const existing = await storage.read(path, signal);
  const budget = settings.maxMemoryLessonChars > 0 ? settings.maxMemoryLessonChars : 220;
  const full = typeof lesson.full === 'string' && lesson.full.length > 0 ? lesson.full : lesson.summary;

  const pointerSkill = isSkillName(lesson.pointerSkill) ? lesson.pointerSkill : undefined;
  const hasDetail = typeof lesson.detail === 'string' && lesson.detail.trim().length > 0;
  // 预算按「整条正文」算：结论 + 指引一起不能超过 maxMemoryLessonChars。
  // 指引（技能名 / 绝对路径）先定下来，结论再拿剩下的额度去切句。
  const detailPathCandidate = detailFileFor(lesson.date, lesson.title, full);
  const candidatePointer = pointerSkill !== undefined
    ? `详见技能 \`${pointerSkill}\``
    : `详见 ${detailPathCandidate}`;
  const allowance = Math.max(budget - charLen(candidatePointer) - 1, 60);
  const cut = cutToSentence(lesson.summary, allowance);
  const needsDetail = cut.truncated || hasDetail;
  const pointer = pointerSkill !== undefined
    ? (needsDetail ? candidatePointer : '')
    : (needsDetail ? candidatePointer : '');

  let detailPath = '';
  if (needsDetail && pointerSkill === undefined) {
    detailPath = detailPathCandidate;
    if (settings.dryRun !== true) {
      try {
        await writeStateFile(detailPath, renderDetail(lesson, full));
      } catch {
        // 详情写不进去不该连累主写入：记忆仍然落盘，只是少了正文备份。
        detailPath = '';
      }
    }
  }

  // 断在半句时补省略号：让人一眼看出「后面还有，在指引里」。
  const shortBody = cut.truncated
    ? (cut.dangling ? `${cut.text.replace(/[，、,：:]+$/, '')}…` : cut.text)
    : lesson.summary;
  const bodyText = pointer === '' ? shortBody : `${shortBody} ${pointer}`;

  const entry = `- ${lesson.date} · ${lesson.title}：${bodyText}`;
  const key = dedupeKey(bodyText);
  const entries = parseMemoryEntries(existing);

  // 跨档：判出去的旧条目在另一份文件里，得先把那边清掉（原文进归档）。
  // 顺序很讲究：先读、先改另一份文件，再写自己这份——中途失败也不会两边都缺。
  const clearedElsewhere = [];
  for (const hint of [lesson.mergeInto, lesson.staleInto]) {
    if (hint === undefined || resolve(hint.file) === resolve(path)) continue;
    const cleared = await removeEntryAt(storage, hint.file, hint.index, settings, signal);
    if (cleared !== undefined) clearedElsewhere.push({ ...cleared, reason: hint === lesson.mergeInto ? 'superseded' : 'stale', scope: hint.scope });
  }
  if (entries.some((item) => dedupeKey(bodyKey(item)) === key)) {
    return {
      kind: 'memory', path, action: 'unchanged', bytes: Buffer.byteLength(existing, 'utf8'),
      reason: 'duplicate', scope: resolved.scope,
    };
  }

  let dropped = 0;
  let kept;
  const evicted = [];
  let evictedBy = 'count';
  // 同一主题已经存在 → **取代**，而不是再加一条近似条目。
  // 记忆的价值在于密度：同一个话题写两遍只会稀释真正有用的那条，
  // 而且偏好这类东西写三条互相矛盾的，等于把用户的立场记乱了。
  const superseded = supersededIndexes(entries, lesson);
  // 判定模型指认的重复条目也算取代（语义重复，标题/关键词都看不出来的那种）。
  // 允许指向**另一份文件**：那就是「项目级条目升级成全局条目」，或者反过来。
  const mergeHint = lesson.mergeInto;
  if (
    mergeHint !== undefined
    && resolve(mergeHint.file) === resolve(path)
    && Number.isInteger(mergeHint.index)
    && mergeHint.index >= 0
    && mergeHint.index < entries.length
    && !superseded.includes(mergeHint.index)
  ) {
    superseded.push(mergeHint.index);
  }
  // 过期条目（同一份文件里的）：也归档，但它不是「被新条目取代」，而是前提失效。
  const staleHint = lesson.staleInto;
  if (
    staleHint !== undefined
    && resolve(staleHint.file) === resolve(path)
    && Number.isInteger(staleHint.index)
    && staleHint.index >= 0
    && staleHint.index < entries.length
    && !superseded.includes(staleHint.index)
  ) {
    superseded.push(staleHint.index);
    evictedBy = 'stale';
  }
  if (superseded.length > 0) {
    // 被取代的原文进归档（不静默删除），新条目排到末尾。
    const replaced = superseded.map((index) => entries[index]);
    evicted.push(...replaced);
    dropped += replaced.length;
    evictedBy = 'superseded';
    kept = entries.filter((_, index) => !superseded.includes(index));
    kept.push(entry);
  } else {
    kept = [...entries, entry];
    // 条数上限：先进先出，最老的让位（新经验通常覆盖旧状态）。
    while (kept.length > settings.maxMemoryEntries) {
      evicted.push(kept.shift());
      dropped += 1;
    }
  }
  const heading = settings.language === 'en' ? LESSON_HEADING_EN : LESSON_HEADING_ZH;
  const block = [MEMORY_BEGIN, heading, '', ...kept, '', MEMORY_END].join('\n');

  let next;
  const begin = existing.indexOf(MEMORY_BEGIN);
  const end = existing.indexOf(MEMORY_END);
  if (begin >= 0 && end > begin) {
    next = existing.slice(0, begin) + block + existing.slice(end + MEMORY_END.length);
  } else {
    const prefix = existing.trim().length === 0 ? '' : `${existing.replace(/\s+$/, '')}\n\n`;
    next = `${prefix}${block}\n`;
  }

  let bytes = Buffer.byteLength(next, 'utf8');
  while (bytes > settings.maxMemoryBytes && kept.length > 1) {
    evicted.push(kept.shift());
    dropped += 1;
    evictedBy = 'bytes';
    const trimmedBlock = [MEMORY_BEGIN, heading, '', ...kept, '', MEMORY_END].join('\n');
    next = begin >= 0 && end > begin
      ? existing.slice(0, begin) + trimmedBlock + existing.slice(end + MEMORY_END.length)
      : `${existing.trim().length === 0 ? '' : `${existing.replace(/\s+$/, '')}\n\n`}${trimmedBlock}\n`;
    bytes = Buffer.byteLength(next, 'utf8');
  }
  if (bytes > settings.maxMemoryBytes) {
    throw new Error(
      `self-evolve: memory file would exceed maxMemoryBytes (${settings.maxMemoryBytes}); raise the limit or trim ${path}`,
    );
  }

  const evictedDetail = evicted.map((line) => ({ title: entryTitle(line), bytes: Buffer.byteLength(line, 'utf8') }));
  const extra = {
    ...(detailPath === '' ? {} : { detailPath }),
    shortened: pointer !== '',
    // 常驻记忆这一条实际占多少字：用户/模型都能看出「指引是不是真的更短」。
    lessonChars: charLen(bodyText),
    // 被从全局改判成项目级时，把原因一起返回：工具结果里能直接看到。
    ...(typeof lesson.scopeNote === 'string' && lesson.scopeNote !== '' ? { scopeNote: lesson.scopeNote } : {}),
  };
  if (settings.dryRun) {
    return { kind: 'memory', path, action: 'dry-run', bytes, dropped, evicted: evictedDetail, evictedBy, ...extra };
  }
  const archivePath = await archiveEvicted(evicted, settings, evictedBy);
  try {
    await storage.write(path, next, signal);
  } catch (error) {
    throw new Error(describeWriteFailure(error, path));
  }
  // 淘汰掉的条目如果带着详情文件、又没有别人引用，就把它挪进归档：不删，但不留孤儿。
  const sweptDetails = await sweepDetailFiles(evicted, kept);
  return {
    kind: 'memory',
    path,
    action: existing.length === 0 ? 'create' : 'update',
    bytes,
    dropped,
    scope: resolved.scope,
    ...(evictedDetail.length === 0 ? {} : { evicted: evictedDetail, evictedBy }),
    ...(archivePath === '' ? {} : { archivePath }),
    ...(clearedElsewhere.length === 0 ? {} : { clearedElsewhere }),
    ...(sweptDetails.length === 0 ? {} : { sweptDetails }),
    ...extra,
  };
}


/**
 * 孟婆汤：清空全部记忆条目。
 *
 * 三条纪律：
 *  1. **先归档再清空**——清空是「忘掉」，不是「销毁」，原文进 archive；
 *  2. **只动托管区间**：`<!-- self-evolve:begin -->` 之外的内容一个字都不碰；
 *  3. **保留空区间**：清空后仍留 begin/end 与标题，之后写入才有落脚点，
 *     否则下一次记录会在文件末尾再造一个区间。
 */
async function clearMemory(storage, settings, targets, signal, requested) {
  const wanted = requested === 'global' || requested === 'project' || requested === 'workspace'
    ? (requested === 'workspace' ? 'project' : requested)
    : 'all';
  const memoryTargets = targets.memoryTargets ?? { global: targets.memoryPath };
  const keys = wanted === 'all' ? Object.keys(memoryTargets) : [wanted].filter((key) => memoryTargets[key] !== undefined);
  const clearedBy = {};
  let cleared = 0;
  let archivePath = '';
  for (const key of keys) {
    const result = await clearMemoryFile(storage, settings, memoryTargets[key], signal);
    if (result.cleared === 0) continue;
    cleared += result.cleared;
    clearedBy[key] = result.cleared;
    if (result.archivePath !== '') archivePath = result.archivePath;
  }
  return { cleared, clearedBy, path: targets.memoryPath, archivePath };
}

/** 清空单个记忆文件（托管区间），原文先进归档。 */
async function clearMemoryFile(storage, settings, path, signal) {
  const existing = await storage.read(path, signal);
  const entries = parseMemoryEntries(existing);
  if (entries.length === 0) return { cleared: 0, path, archivePath: '' };

  const heading = settings.language === 'en' ? LESSON_HEADING_EN : LESSON_HEADING_ZH;
  const block = [MEMORY_BEGIN, heading, '', MEMORY_END].join('\n');
  const begin = existing.indexOf(MEMORY_BEGIN);
  const end = existing.indexOf(MEMORY_END);
  const next = begin >= 0 && end > begin
    ? existing.slice(0, begin) + block + existing.slice(end + MEMORY_END.length)
    : `${existing.trim().length === 0 ? '' : `${existing.replace(/\s+$/, '')}\n\n`}${block}\n`;

  const archivePath = await archiveEvicted(entries, settings, 'purge');
  try {
    await storage.write(path, next, signal);
  } catch (error) {
    throw new Error(describeWriteFailure(error, path));
  }
  return { cleared: entries.length, path, archivePath, bytes: Buffer.byteLength(next, 'utf8') };
}

/**
 * 本插件创建的技能文件里带这一行标记。
 *
 * 为什么需要：技能目录 `/Users/bytedance/.agents/skills` 里还有用户自己的技能，
 * 按目录数会把别人的算成「本插件积累的」。带标记才计数，历史文件用正文里的
 * 托管标题兜底识别。
 */
const SKILL_MARKER = '<!-- self-evolve:skill -->';

/** 这个 SKILL.md 是不是本插件写的（新文件看标记，老文件看托管标题）。 */
function isOwnedSkill(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (text.includes(SKILL_MARKER)) return true;
  return text.includes(LESSON_HEADING_ZH) || text.includes(LESSON_HEADING_EN);
}

/**
 * 解析一条托管 bullet。
 *
 * 记忆是 `- 日期 · 标题：正文`，技能是 `- 日期 · 正文`（标题就是技能名）。
 * 正文里允许再出现冒号，所以只按第一个分隔符切。
 */
/**
 * 记录时间：精确到秒的**本地时间**（`2026-10-21 16:07:39`）。
 *
 * 以前只写日期，同一天里三条记录谁先谁后完全看不出来，也没法和会话日志对时间。
 * 旧条目（只有日期）仍然能解析，新条目一律带时分秒。
 */
function stampNow(now) {
  const at = now instanceof Date ? now : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function parseLessonBullet(line, kind) {
  const rest = line.replace(/^-\s+/, '');
  // 日期必填、时分秒可选：老条目 `2026-10-21` 与新条目 `2026-10-21 16:07:39` 都能读。
  const match = /^(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)\s+·\s+([\s\S]*)$/.exec(rest);
  if (match === null) return undefined;
  const date = match[1];
  const tail = match[2];
  if (kind === 'skill') return { date, title: '', body: tail };
  const cut = tail.indexOf('：');
  const alt = tail.indexOf(': ');
  const at = cut >= 0 ? cut : alt;
  if (at < 0) return { date, title: '', body: tail };
  return { date, title: tail.slice(0, at).trim(), body: tail.slice(at + 1).trim() };
}

/** 反向渲染：改完的条目写回同一行格式。 */
function renderLessonBullet(kind, date, title, body) {
  if (kind === 'skill') return `- ${date} · ${body}`;
  return `- ${date} · ${title}：${body}`;
}

/** 取某个已托管文件里的 bullet 行（只认 `- ` 开头）。 */
function bulletLines(text, kind) {
  const heading = LESSON_HEADING_ZH;
  const alt = LESSON_HEADING_EN;
  const at = text.indexOf(heading) >= 0 ? text.indexOf(heading) : text.indexOf(alt);
  if (at < 0) return [];
  const lines = text.split('\n');
  const startIndex = text.slice(0, at).split('\n').length - 1;
  const out = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > startIndex && line.startsWith('## ')) break;
    if (line.startsWith('- ')) out.push({ line, index });
  }
  return out;
}

/**
 * 列出所有可以被界面查看/编辑的经验。
 *
 * 记忆从托管区间里读；技能只读**本插件写过**的 SKILL.md（带归属标记），
 * 绝不把用户自己的技能列进来，更不允许改它们。
 */
async function listLessons(storage, targets, signal) {
  const lessons = [];

  const memoryTargets = targets.memoryTargets ?? { global: targets.memoryPath };
  for (const [key, file] of Object.entries(memoryTargets)) {
    try {
      const text = await storage.read(file, signal);
      bulletLines(text, 'memory').forEach(({ line }, index) => {
        const parsed = parseLessonBullet(line, 'memory');
        if (parsed === undefined) return;
        lessons.push({
          id: `memory:${key}:${index}`,
          kind: 'memory',
          // 记忆分两档：项目级只在本仓库生效，全局则每个会话都加载。
          scope: key,
          path: file,
          date: parsed.date,
          title: parsed.title,
          body: parsed.body,
          original: line,
        });
      });
    } catch {
      // 读不到就不列：文件不存在等于这一档还没沉淀过东西。
    }
  }

  try {
    const entries = await readdir(targets.skillRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(targets.skillRoot, entry.name, 'SKILL.md');
      let text;
      try {
        text = await storage.read(path, signal);
      } catch {
        continue;
      }
      if (!isOwnedSkill(text)) continue;
      const bullets = bulletLines(text, 'skill');
      // 整篇写成的技能（`kind: both` 带 skill_description 时就是这种）：没有
      // 「- 日期 · 标题：正文」行，但它是实打实沉淀下来的技能，必须出现在经验库里。
      if (bullets.length === 0) {
        lessons.push({
          id: `skill:${entry.name}:document`,
          kind: 'skill',
          path,
          date: '',
          title: entry.name,
          // 展开时给全文（去掉 frontmatter）：整篇技能没有「一行结论」可展示。
          body: stripFrontmatter(text),
          original: '',
          document: true,
        });
        continue;
      }
      bullets.forEach(({ line }, index) => {
        const parsed = parseLessonBullet(line, 'skill');
        if (parsed === undefined) return;
        lessons.push({
          id: `skill:${entry.name}:${index}`,
          kind: 'skill',
          path,
          date: parsed.date,
          title: entry.name,
          body: parsed.body,
          original: line,
        });
      });
    }
  } catch {
    // 技能根目录不存在：只返回记忆部分。
  }

  // 新的在前：日期相同则按原始顺序倒序。
  return lessons.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * 判定一个可写路径是否属于本插件的托管范围。
 *
 * 界面可以把 path 传回来，所以这里必须**白名单**：只允许记忆文件本身和
 * skillRoot 下一层的 SKILL.md，避免这条路由变成任意文件写入。
 */
/** 去掉 YAML frontmatter 与归属标记：正文才是给人看的。 */
function stripFrontmatter(text) {
  let body = text;
  const front = /^---\n[\s\S]*?\n---\n?/.exec(body);
  if (front !== null) body = body.slice(front[0].length);
  return body.replace(SKILL_MARKER, '').replace(/^\n+/, '').trim();
}

function lessonPathKind(targets, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  const target = resolve(path);
  const memoryFiles = Object.values(targets.memoryTargets ?? { global: targets.memoryPath }).map((file) => resolve(file));
  if (memoryFiles.includes(target)) return 'memory';
  const root = resolve(targets.skillRoot) + sep;
  if (target.startsWith(root) && target.endsWith(`${sep}SKILL.md`)) {
    const rest = target.slice(root.length);
    if (rest.split(sep).length === 2) return 'skill';
  }
  return undefined;
}

/**
 * 修改或删除一条经验。
 *
 * 用「原始行」定位而不是索引：界面列表可能是几秒前的快照，索引会漂移，
 * 而整行文本是稳定的。找不到就报 refused，让界面刷新后再试。
 */
async function mutateLesson(storage, targets, request, signal) {
  const kind = lessonPathKind(targets, request?.path);
  if (kind === undefined) throw new Error('self-evolve: 只允许修改本插件托管过的记忆与技能文件');
  if (typeof request?.original !== 'string' || request.original.trim().length === 0) {
    throw new Error('self-evolve: 缺少 original，无法定位要改的那一条');
  }

  const action = request.action === 'delete' ? 'delete' : 'update';
  const text = await storage.read(request.path, signal);
  const lines = text.split('\n');
  const targetLine = request.original.trim();
  const index = lines.findIndex((line) => line.trim() === targetLine);
  if (index < 0) throw new Error('self-evolve: 这一条已经变了，请刷新后重试');

  if (action === 'delete') {
    lines.splice(index, 1);
  } else {
    const parsed = parseLessonBullet(targetLine, kind);
    if (parsed === undefined) throw new Error('self-evolve: 这一条的格式无法解析');
    const title = typeof request.title === 'string' && request.title.trim().length > 0
      ? request.title.trim()
      : parsed.title;
    const body = typeof request.body === 'string' ? request.body.trim() : '';
    if (body.length === 0) throw new Error('self-evolve: 正文不能为空（要删掉这条请用删除）');
    if (body.length > 4000) throw new Error('self-evolve: 正文太长（上限 4000 字符）');
    lines[index] = renderLessonBullet(kind, parsed.date, title, body);
  }

  const next = lines.join('\n');
  try {
    await storage.write(request.path, next, signal);
  } catch (error) {
    throw new Error(describeWriteFailure(error, request.path));
  }
  return { kind, action, path: request.path, bytes: Buffer.byteLength(next, 'utf8') };
}

/** 校验 skill 名（与 dsh-skill 的 SKILL_NAME 一致）。 */
function isSkillName(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/**
 * 把任意文本渲染成合法的 YAML 双引号标量。
 * JSON 字符串是 YAML 双引号标量的子集，转义规则兼容，因此直接复用。
 */
function yamlString(value) {
  return JSON.stringify(String(value));
}

/** 构造新技能文件的完整内容。 */
function renderNewSkill(settings, lesson) {
  const heading = settings.language === 'en' ? LESSON_HEADING_EN : LESSON_HEADING_ZH;
  return [
    '---',
    `name: ${lesson.skillName}`,
    `description: ${yamlString(lesson.skillDescription)}`,
    `whenToUse: ${yamlString(lesson.whenToUse)}`,
    '---',
    '',
    SKILL_MARKER,
    '',
    `# ${lesson.title}`,
    '',
    heading,
    '',
    `- ${lesson.date} · ${lesson.full ?? lesson.summary}`,
    '',
  ].join('\n');
}

/** 向已有技能追加一条经验，不改动 frontmatter 与既有正文。 */
function appendSkillLesson(existing, settings, lesson) {
  const heading = settings.language === 'en' ? LESSON_HEADING_EN : LESSON_HEADING_ZH;
  const tagged = existing.includes(SKILL_MARKER) ? existing : stampSkillMarker(existing);
  const bullet = `- ${lesson.date} · ${lesson.full ?? lesson.summary}`;
  const index = tagged.indexOf(heading);
  if (index >= 0) {
    const sectionStart = index + heading.length;
    const rest = existing.slice(sectionStart);
    const nextHeading = rest.search(/\n## /);
    if (nextHeading >= 0) {
      const insertAt = sectionStart + nextHeading;
      return `${tagged.slice(0, insertAt).replace(/\s+$/, '')}\n${bullet}${tagged.slice(insertAt)}`;
    }
    return `${tagged.replace(/\s+$/, '')}\n${bullet}\n`;
  }
  return `${tagged.replace(/\s+$/, '')}\n\n${heading}\n\n${bullet}\n`;
}

/** 给老技能文件补上归属标记（frontmatter 之后）。 */
function stampSkillMarker(text) {
  const close = text.indexOf('\n---', 4);
  if (text.startsWith('---') && close >= 0) {
    const at = close + '\n---'.length;
    return `${text.slice(0, at)}\n\n${SKILL_MARKER}${text.slice(at)}`;
  }
  return `${SKILL_MARKER}\n\n${text}`;
}

/** 更新或新建技能，返回写入结果。 */
async function writeSkill(storage, settings, targets, lesson, signal) {
  const dir = join(targets.skillRoot, lesson.skillName);
  const path = join(dir, 'SKILL.md');
  const existing = await storage.read(path, signal);

  // 用户自己写的技能不能被悄悄接管：没有归属标记的 SKILL.md 一律拒写，
  // 除非调用方显式 adopt:true（那是一个有意识的决定，不是顺手）。
  // 为什么必须先拦：appendSkillLesson 会顺手补上归属标记，一旦写进去，
  // 这份技能从此算插件的——统计、改写提案、列表全都会把它当成自产的。
  if (existing.length > 0 && !isOwnedSkill(existing) && lesson.adopt !== true) {
    throw new Error(
      `技能 "${lesson.skillName}" 是你自己的（SKILL.md 里没有归属标记），插件不会自动接管。`
      + '要归并进插件维护，请显式传 adopt: true；否则换一个 skill_name 新建。',
    );
  }

  // 「更新了已有技能」要能被证明：带上技能名、原本几条、现在几条。
  // 只回一个 action:'update' 的话，界面上和「新建」长得一模一样，用户无法核对。
  const identity = { skillName: lesson.skillName, title: lesson.title };

  if (existing.length === 0) {
    const content = renderNewSkill(settings, lesson);
    if (settings.dryRun) {
      return { kind: 'skill', path, action: 'dry-run', bytes: Buffer.byteLength(content, 'utf8'), ...identity, previousEntries: 0, entries: 1 };
    }
    try {
      await storage.write(path, content, signal);
    } catch (error) {
      throw new Error(describeWriteFailure(error, path));
    }
    return { kind: 'skill', path, action: 'create', bytes: Buffer.byteLength(content, 'utf8'), ...identity, previousEntries: 0, entries: 1 };
  }

  const previousEntries = bulletLines(existing, 'skill').length;
  if (dedupeKey(existing).includes(dedupeKey(lesson.summary))) {
    return {
      kind: 'skill', path, action: 'unchanged', bytes: Buffer.byteLength(existing, 'utf8'), reason: 'duplicate', ...identity, previousEntries, entries: previousEntries,
    };
  }
  const next = appendSkillLesson(existing, settings, lesson);
  if (settings.dryRun) {
    return {
      kind: 'skill', path, action: 'dry-run', bytes: Buffer.byteLength(next, 'utf8'), ...identity, previousEntries, entries: previousEntries + 1,
    };
  }
  try {
    await storage.write(path, next, signal);
  } catch (error) {
    throw new Error(describeWriteFailure(error, path));
  }
  return {
    kind: 'skill', path, action: 'update', bytes: Buffer.byteLength(next, 'utf8'), ...identity, previousEntries, entries: previousEntries + 1,
  };
}

// ---------------------------------------------------------------------------
// 自优化：协议 / 技能改写的「提案」
//
// 为什么要绕一层提案：模型给自己的提示词做减法，错一次就会把护栏改没（比如删掉
// 「不要在对话里提」），而这类损坏不会报错、只会慢慢变吵。所以这里的设计是：
//   - 模型只能**提交**提案，落盘前一律不改任何东西；
//   - 提交时在 Host 侧做硬校验（核心段逐字不变、长度不超预算、技能必须是自己建的）；
//   - 用户在经验库里看到 diff，点「应用」才写盘；不点就一直是候选。
// ---------------------------------------------------------------------------

/** 插件自己的状态目录（协议、提案、历史）。 */
function resolveStateDir() {
  return join(resolveDshHome(), 'self-evolve');
}

function protocolFilePath() {
  return join(resolveStateDir(), 'protocol.md');
}

function protocolPrevPath() {
  return join(resolveStateDir(), 'protocol.prev.md');
}

function proposalsFilePath() {
  return join(resolveStateDir(), 'proposals.json');
}

/** 同步读文本（用于装配系统提示时同步取协议）；不存在返回空串。 */
function readTextSync(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/** 取核心段（含标记），用于「不许改」的逐字比对。 */
export function keepBlock(text) {
  const start = text.indexOf(KEEP_BEGIN);
  const end = text.indexOf(KEEP_END);
  if (start < 0 || end < 0 || end < start) return '';
  return text.slice(start, end + KEEP_END.length).replace(/\r\n/g, '\n').trim();
}

/** 当前生效的协议正文：文件优先，缺失/空文件回落内置文案。 */
export function activeProtocol(settings) {
  let text = '';
  try {
    text = readTextSync(protocolFilePath());
  } catch {
    // 读不了就当没有：宁可回落到内置文案，也不能因为这个文件让插件起不来。
    text = '';
  }
  return text.trim().length === 0 ? protocolSection(settings) : text;
}

/** 校验协议提案；不合法直接抛错（错误文案会原样回到模型/界面）。 */
export function validateProtocol(settings, before, after) {
  if (typeof after !== 'string' || after.trim().length === 0) throw new Error('新协议是空的');
  if (after.trim() === before.trim()) throw new Error('新协议与当前协议相同，没有需要改动的地方');
  if (after.length > settings.maxPromptChars) {
    throw new Error(`新协议 ${after.length} 字，超过预算 ${settings.maxPromptChars} 字：先删掉冗余再提交`);
  }
  const core = keepBlock(before);
  if (core === '') throw new Error('当前协议缺少核心段（<!-- keep:begin --> … <!-- keep:end -->），拒绝改写');
  if (keepBlock(after) !== core) {
    throw new Error('核心段（keep 标记之间的那几条）不允许修改：那是防止退化成刷屏的硬约束，可以改核心段之外的任何内容');
  }
}

/** 校验技能改写提案。 */
/**
 * 校验技能改写。
 *
 * 允许改**任何**已存在的技能：用户要的就是「把我已有的技能不断优化」，包括提示词
 * （SKILL.md 正文）和脚本（files）。安全性不靠「只允许自建技能」来保证，而是靠
 * 提案流程本身——模型只能提交，落盘必须由人在界面上点「应用」。
 *
 * 但两条底线不变：
 *   - 自建技能必须保留归属标记（否则之后统计/追加/改写都会当它是用户自己的）；
 *   - 用户自己的技能，改写不许偷偷塞进归属标记（那就成了收编）。
 */
export function validateSkillRewrite(settings, before, after) {
  if (typeof after !== 'string' || after.trim().length === 0) throw new Error('新技能正文是空的');
  if (after.trim() === before.trim()) throw new Error('新正文与当前文件相同');
  if (!after.startsWith('---')) throw new Error('必须保留 SKILL.md 的 frontmatter（以 --- 开头）');
  if (!/\nname:\s*\S/.test(after)) throw new Error('frontmatter 里必须有 name');
  // 归属标记要跟着走：新技能用 marker，早期技能只写了经验小节标题，两者都不能丢，
  // 否则这份文件之后就脱离插件维护了（统计、改写、追加都会当它是用户自己的）。
  if (isOwnedSkill(before)) {
    const kept = before.includes(SKILL_MARKER)
      ? after.includes(SKILL_MARKER)
      : after.includes(LESSON_HEADING_ZH) || after.includes(LESSON_HEADING_EN);
    if (!kept) throw new Error(`必须保留归属标记（${SKILL_MARKER} 或经验小节标题），否则这份技能就不再由插件维护`);
  } else if (after.includes(SKILL_MARKER)) {
    // 用户自己的技能：改写不许顺手收编。
    throw new Error('这份技能是你自己的，改写里不许加入 self-evolve 归属标记（那是接管，不是优化）');
  }
  if (after.length > settings.maxSkillChars) {
    throw new Error(`新技能 ${after.length} 字，超过预算 ${settings.maxSkillChars} 字：先删掉过时条目再提交`);
  }
}

/**
 * 校验技能改写里携带的附属文件（脚本、模板、参考文档）。
 *
 * 为什么要有这一段：SKILL.md 里写着 `scripts/fetch.py`，改写时把「## 脚本」小节删掉，
 * 文件还在磁盘上、引用却断了——能力表面还在，实际调用时找不到入口。反过来，塞进来一个
 * 谁都不引用的脚本，也只是垃圾。所以两边都要对得上：
 *   - 正文里点名的脚本，必须在磁盘上或在这份提案里；
 *   - 提案里带的文件，必须在正文里被点名。
 */
export function validateSkillFiles(settings, skillDir, body, files) {
  if (files === undefined || files.length === 0) return [];
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const entry of files) {
    if (entry === null || typeof entry !== 'object') throw new Error('files 里每一项都必须是 {path, content}');
    const raw = String(entry.path ?? '').trim();
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (raw === '') throw new Error('files[].path 不能为空');
    if (raw.includes('\\') || raw.startsWith('/') || raw.includes('..')) {
      throw new Error(`文件路径必须是技能目录内的相对路径，不接受 ${JSON.stringify(raw)}`);
    }
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(raw)) {
      throw new Error(`文件路径只允许字母数字与 . _ - 以及单层目录分隔：${JSON.stringify(raw)}`);
    }
    if (raw === 'SKILL.md') throw new Error('SKILL.md 的正文请用 body 传，不要放进 files');
    if (seen.has(raw)) throw new Error(`files 里重复声明了 ${raw}`);
    seen.add(raw);
    if (content.trim() === '') throw new Error(`${raw} 的内容是空的：要删文件请直接改磁盘（提案只负责写入/更新）`);
    if (content.length > settings.maxSkillFileChars) {
      throw new Error(`${raw} 有 ${content.length} 字，超过单文件上限 ${settings.maxSkillFileChars} 字`);
    }
    total += content.length;
    if (total > settings.maxSkillFilesChars) {
      throw new Error(`附属文件合计 ${total} 字，超过上限 ${settings.maxSkillFilesChars} 字：只挑真正需要改的`);
    }
    out.push({ path: raw, abs: join(skillDir, raw), after: content });
  }

  // 正文点名了文件却既不在磁盘、也不在提案里 → 应用后就是断链。
  const referenced = new Set(
    (body.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]+/g) ?? [])
      .map((item) => item.replace(/^\.\//, '')),
  );
  for (const item of out) {
    if (!body.includes(item.path) && !body.includes(item.path.split('/').pop())) {
      throw new Error(`提案带了 ${item.path}，但正文没有提到它：要么删掉这个文件，要么在 SKILL.md 里写清怎么用`);
    }
  }
  return out;
}

/**
 * 正文点名的附属文件必须真的存在（或就在这份提案里），否则应用后就是断链。
 * 这一步要读盘，所以单独做成异步的，校验器本身保持同步。
 */
export async function checkSkillReferences(storage, skillDir, body, files, signal) {
  const provided = new Set((files ?? []).map((item) => item.path));
  const referenced = new Set(
    (body.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]+/g) ?? [])
      .map((item) => item.replace(/^\.\//, '')),
  );
  for (const item of referenced) {
    if (provided.has(item)) continue;
    if (!item.includes('scripts/') && !item.includes('references/') && !item.includes('assets/')) continue;
    const text = await storage.read(join(skillDir, item), signal);
    if (text.length === 0) {
      throw new Error(`正文引用了 ${item}，但这个文件不存在（也没有随提案提供）：改写后就是断链`);
    }
  }
}

/** 读提案列表（单文件 JSON 数组，避免依赖目录列举）。 */
export async function readProposals() {
  let text;
  try {
    text = readTextSync(proposalsFilePath());
  } catch {
    return [];
  }
  if (text.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string')
      : [];
  } catch {
    return [];
  }
}

async function writeProposals(list) {
  await mkdir(resolveStateDir(), { recursive: true });
  await writeFile(proposalsFilePath(), JSON.stringify(list.slice(-20), null, 2), 'utf8');
}

/** 写插件自己的状态文件（协议、备份）。 */
async function writeStateFile(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

/** 提交一份提案（只入队，不写目标文件）。 */
export async function submitProposal(proposal) {
  const id = `p-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  const record = {
    id,
    kind: proposal.kind,
    path: proposal.path,
    title: proposal.title,
    reason: proposal.reason,
    createdAt: new Date().toISOString(),
    charsBefore: proposal.before.length,
    charsAfter: proposal.after.length,
    before: proposal.before,
    after: proposal.after,
    // 附属文件（脚本/模板）：连同改前内容一起存，应用时用来检测「提案后被改过」。
    files: Array.isArray(proposal.files)
      ? proposal.files.map((item) => ({ path: item.path, before: item.before, after: item.after }))
      : [],
    // 判定模型的结论跟着提案走：界面要显示「机器觉得这改动值不值得」。
    judgement: proposal.judgement ?? undefined,
  };
  const list = await readProposals();
  // 同一目标只保留最新一份：连着提交两版，看的人只该看到最后那版。
  const kept = list.filter((item) => item.path !== record.path);
  await writeProposals([...kept, record]);
  return {
    id,
    kind: record.kind,
    path: record.path,
    charsBefore: record.charsBefore,
    charsAfter: record.charsAfter,
    // 为什么改：这条理由一路带到「应用后的历史」里，改完还能回答「当初为什么动它」。
    reason: record.reason,
    files: record.files.map((item) => item.path),
    judgement: record.judgement,
  };
}

/** 应用一份提案：写盘 + 历史留档 + 从队列里移除。 */
export async function applyProposal(storage, settings, id, signal, hooks) {
  const list = await readProposals();
  const found = list.find((item) => item.id === id);
  if (found === undefined) throw new Error('这份提案已经不在了（可能已经被应用或丢弃），刷新看看');

  if (found.kind === 'prompt') {
    const current = activeProtocol(settings);
    validateProtocol(settings, current, found.after);
    await writeStateFile(protocolPrevPath(), current);
    await writeStateFile(protocolFilePath(), found.after);
  } else {
    const current = await storage.read(found.path, signal);
    if (current !== found.before) throw new Error('这份技能在提案之后被改过，请重新生成提案');
    validateSkillRewrite(settings, found.before, found.after);
    // 附属文件逐个做冲突检测：只要有一个在提案之后被改过，就整份拒绝，不写半截。
    const files = Array.isArray(found.files) ? found.files : [];
    await checkSkillReferences(storage, dirname(found.path), found.after, files, signal);
    for (const item of files) {
      const abs = join(dirname(found.path), item.path);
      const now = await storage.read(abs, signal);
      if (now !== item.before) {
        throw new Error(`${item.path} 在提案之后被改过（或不存在），请重新生成提案：不写半截状态`);
      }
    }
    await writeStateFile(
      historyPath(id),
      JSON.stringify({
        id,
        kind: found.kind,
        path: found.path,
        title: found.title,
        // 「为什么改」必须和改动一起留档：事后只剩一个 diff，看不出动机。
        reason: found.reason,
        before: found.before,
        after: found.after,
        files,
        at: stampNow(),
      }, null, 2),
    );
    await storage.write(found.path, found.after, signal);
    for (const item of files) {
      // storage.write 自己会按目标是否存在选择 createIfAbsent / 版本校验，也会建目录。
      await storage.write(join(dirname(found.path), item.path), item.after, signal);
    }
  }
  await writeProposals(list.filter((item) => item.id !== id));
  // 应用即留痕：谁、什么时候、因为什么、动了几个文件。
  try {
    await appendApplied({
      id: found.id,
      kind: found.kind,
      title: found.title,
      path: found.path,
      reason: found.reason ?? '',
      at: stampNow(),
      files: (Array.isArray(found.files) ? found.files : []).map((item) => ({ path: item.path, charsBefore: item.before.length, charsAfter: item.after.length })),
      charsBefore: found.charsBefore,
      charsAfter: found.charsAfter,
    });
  } catch {
    // 日志写不进去不该让已经落盘的改动回滚。
  }
  if (found.kind === 'prompt' && typeof hooks?.onProtocolChanged === 'function') hooks.onProtocolChanged(found.after);
  return {
    kind: found.kind,
    path: found.path,
    charsBefore: found.charsBefore,
    charsAfter: found.charsAfter,
    // 为什么改：应用后紧接着显示给用户的那一句。
    reason: found.reason ?? '',
  };
}

/** 已应用的改动日志：改完之后能回答「改了什么、为什么改」。 */
function appliedFilePath() {
  return join(resolveStateDir(), 'applied.json');
}

export function readApplied() {
  try {
    const text = readTextSync(appliedFilePath());
    if (text.trim() === '') return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item) => item !== null && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

async function appendApplied(entry) {
  const list = readApplied();
  list.push(entry);
  await writeStateFile(appliedFilePath(), JSON.stringify(list.slice(-50), null, 2));
}

function historyPath(id) {
  return join(resolveStateDir(), 'history', `${id}.json`);
}

/** 丢弃一份提案。 */
export async function discardProposal(id) {
  const list = await readProposals();
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) throw new Error('这份提案已经不在了');
  await writeProposals(next);
  return { removed: id };
}

// ---------------------------------------------------------------------------
// 经验库 HTTP 路由（只给自带界面用）
// ---------------------------------------------------------------------------

/** 读取请求体（JSON），上限 256 KB。 */
function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 262144) {
        rejectBody(new Error('self-evolve: 请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', rejectBody);
    req.on('end', () => {
      try {
        resolveBody(chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(new Error('self-evolve: 请求体不是合法 JSON'));
      }
    });
  });
}

/** 路由用的授权缓存：同一个页面会话里点过一次「允许」就不再重复问。 */
const ROUTE_GRANTS = { granted: new WeakSet(), pending: new WeakMap() };

/**
 * 从查询串里取回发起这次请求的 Agent。
 *
 * 界面的「保存」是代表某个会话做的，沙箱策略必须按那个会话来解析——否则
 * 无会话上下文的解析会退化成默认的只读模式，写入必然被拒（实测就是
 * FS_SANDBOX_DENIED）。
 */
function routeAgent(ctx, url) {
  const id = url.searchParams.get('session');
  if (typeof id !== 'string' || id.length === 0) return undefined;
  try {
    const agents = ctx.get('agents');
    return typeof agents?.get === 'function' ? agents.get(id) : undefined;
  } catch {
    return undefined;
  }
}

/** 工作区作用域下路由用哪个目录（没有会话上下文，只能取默认目录）。 */
function routeWorkspace(ctx, settings, url) {
  // auto 也要项目目录：列表/清空都得能看见项目级那份。
  if (settings.scope !== 'workspace' && settings.scope !== 'auto') return undefined;
  try {
    const service = ctx.get('workingDirectory');
    // 优先按 `?session=` 找那个会话的工作区：没有它，界面看到的就是「另一个项目」的记忆。
    const agent = url === undefined ? undefined : routeAgent(ctx, url);
    const session = agent?.session;
    if (session !== undefined && typeof service?.get === 'function') {
      const dir = service.get(session);
      if (typeof dir === 'string' && dir.length > 0) return dir;
    }
    return typeof service?.defaultDirectory === 'string' ? service.defaultDirectory : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 处理 `/api/self-evolve/*`。
 *
 * 为什么要有这条路由：bundle 的 Client 半**拿不到写文件的能力**（client 侧
 * 只有 layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces 这些
 * 服务；`host.call` 只属于动态插件），所以「点开看正文 / 就地编辑」必须回到
 * Host 半来做。同源 fetch + 自定义请求头，跨站请求会在预检阶段被挡掉。
 */
/** 桌宠形象的白名单：只有这几个状态，路径参数一律不认。 */
const PET_FRAMES = ['idle', 'think', 'happy', 'drag', 'forget', 'sleep', 'wake'];

async function handleLessonRequest(ctx, settings, req, res, hooks) {
  const send = (status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  const url = new URL(req.url ?? '/', 'http://localhost');

  // 桌宠形象：`<img src>` 发不了自定义请求头，所以图片单独放行。
  // 只读、只认白名单里的固定文件名，不接受路径参数。
  if (req.method === 'GET' && url.pathname.startsWith('/api/self-evolve/pet/')) {
    // 素材是动画 WebP（从 640x360 原始片段重导出，2 倍尺寸）；老版本留下的 .gif 也照旧能取。
    const match = /\.([a-z0-9]+)$/i.exec(url.pathname);
    const ext = match === null ? 'webp' : match[1].toLowerCase();
    const name = url.pathname.slice('/api/self-evolve/pet/'.length).replace(/\.[a-z0-9]+$/i, '');
    // 只认这两种后缀：别的（.js 之类）一律当未知帧，不能因为名字对就回素材。
    if ((ext === 'webp' || ext === 'gif') && PET_FRAMES.includes(name)) {
      try {
        const bytes = await readFile(new URL(`./assets/pet/${name}.${ext}`, import.meta.url));
        res.writeHead(200, {
          'content-type': ext === 'gif' ? 'image/gif' : 'image/webp',
          'cache-control': 'public, max-age=86400',
          'content-length': bytes.length,
        });
        res.end(bytes);
        return;
      } catch (error) {
        send(404, { ok: false, error: String(error?.message ?? error) });
        return;
      }
    }
    send(404, { ok: false, error: 'unknown frame' });
    return;
  }

  if (req.headers['x-self-evolve'] !== '1') {
    send(403, { ok: false, error: 'forbidden' });
    return;
  }

  const agent = routeAgent(ctx, url);
  // 人类点出来的写入：显式要完全权限，不走 agent 的只读策略。
  const storage = createStorage(ctx, agent, ROUTE_GRANTS, { mode: 'danger-full-access' });
  const targets = resolveTargets(settings, routeWorkspace(ctx, settings, url));

  try {
    if (req.method === 'GET' && url.pathname === '/api/self-evolve/lessons') {
      const lessons = await listLessons(storage, targets, undefined);
      const proposals = (await readProposals()).map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        path: item.path,
        reason: item.reason,
        createdAt: item.createdAt,
        charsBefore: item.charsBefore,
        charsAfter: item.charsAfter,
        judgement: item.judgement ?? undefined,
        // 附属文件：界面要列出「顺便改了哪些脚本」，否则应用脚本改动时等于盲点。
        files: Array.isArray(item.files)
          ? item.files.map((file) => ({
            path: file.path,
            exists: typeof file.before === 'string' && file.before.length > 0,
            charsBefore: typeof file.before === 'string' ? file.before.length : 0,
            charsAfter: typeof file.after === 'string' ? file.after.length : 0,
          }))
          : [],
      }));
      const protocol = activeProtocol(settings);
      // 实时计数：界面上「累计沉淀」要显示当前存量，而不是某条历史记录写下的快照。
      const stats = await collectStats(storage, targets, undefined, settings);
      send(200, {
        ok: true,
        lessons,
        stats: {
          memoryEntries: stats.memoryEntries,
          memoryBytes: stats.memoryBytes,
          memoryBytesLimit: stats.memoryBytesLimit,
          skills: stats.skills,
          skillsTotal: stats.skillsTotal,
        },
        proposals,
        // 最近的改动（含原因）：界面上「为什么改」就从这里来。
        // 只留最近 3 条：最近改动是「刚发生了什么」，不是流水账。
        applied: readApplied().slice(-3).reverse(),
        // 上次整理：界面回答「记忆最近被整理过吗」。
        audit: readAudit(),
        // 最近一次沉淀：桌宠动画据此触发（时间戳比对话解析可靠）。
        lastRecord: readLastRecord(),
        // 判断模型的执行流水：判了什么、判多久、为什么。
        judgements: readJudgements(30),
        protocol: { chars: protocol.length, budget: settings.maxPromptChars },
        memoryPath: targets.memoryPath,
        skillRoot: targets.skillRoot,
        memoryLimit: settings.maxMemoryEntries,
        // 调试用：会话没对上时沙箱策略会退化成只读，写入必然被拒。
        session: agent === undefined ? 'missing' : 'live',
      });
      return;
    }

    // 单份提案的完整正文：diff 要拿 before/after 两版全文。
    if (req.method === 'GET' && url.pathname === '/api/self-evolve/proposal') {
      const id = url.searchParams.get('id') ?? '';
      const found = (await readProposals()).find((item) => item.id === id);
      if (found === undefined) throw new Error('这份提案已经不在了，刷新看看');
      send(200, {
        ok: true,
        proposal: {
          id: found.id,
          kind: found.kind,
          title: found.title,
          path: found.path,
          reason: found.reason,
          before: found.before,
          after: found.after,
        },
      });
      return;
    }

    // 体检：只返回候选对与模型意见，不动文件。
    if (req.method === 'POST' && url.pathname === '/api/self-evolve/healthcheck') {
      const report = await healthcheckMemory(storage, settings, targets, undefined, { autoMerge: settings.autoMergeAudit !== false });
      send(200, { ok: true, ...report });
      return;
    }

    // 负样本：用户在面板上点「忽略」，等于说「判定说它俩重复，但我不认」。
    // 这是唯一能拿到的准确率标签，攒起来才知道该不该调阈值。
    if (req.method === 'POST' && url.pathname === '/api/self-evolve/pair-feedback') {
      const payload = await readJsonBody(req);
      const left = typeof payload?.left === 'string' ? payload.left : '';
      const right = typeof payload?.right === 'string' ? payload.right : '';
      if (left === '' || right === '') {
        send(400, { ok: false, error: 'pair-feedback 需要 left 与 right 标题' });
        return;
      }
      const historyPath = join(resolveStateDir(), 'judgements.jsonl');
      let history = '';
      try {
        history = readTextSync(historyPath);
      } catch {
        history = '';
      }
      const line = JSON.stringify({
        at: stampNow(),
        kind: 'pair',
        verdict: 'dismissed',
        left,
        right,
        score: typeof payload.score === 'number' ? payload.score : undefined,
      });
      const kept = `${history}${line}\n`.split('\n').filter((row) => row.trim().length > 0).slice(-500);
      await writeFile(historyPath, `${kept.join('\n')}\n`, 'utf8');
      send(200, { ok: true });
      return;
    }

    // 合并：保留一条、其余归档（不删除）。
    if (req.method === 'POST' && url.pathname === '/api/self-evolve/merge') {
      const payload = await readJsonBody(req);
      if (payload?.keep === undefined || !Array.isArray(payload?.drops)) {
        send(400, { ok: false, error: 'merge 需要 keep 与 drops' });
        return;
      }
      const result = await mergeMemoryEntries(storage, settings, payload.keep, payload.drops, undefined);
      if (result.removed.length > 0) {
        // 体检合并也进「最近的改动」：用户要知道这条是什么时候、因为什么消失的。
        void appendApplied({
          kind: 'memory',
          title: payload.keep.title,
          scope: payload.keep.scope,
          reason: `合并 ${result.removed.length} 条（${result.removed.map((item) => item.title).join('、')}）`,
          at: stampNow(),
        });
      }
      send(200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/self-evolve/proposal/apply') {
      const payload = await readJsonBody(req);
      const applied = await applyProposal(storage, settings, payload.id, undefined, hooks);
      send(200, { ok: true, applied });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/self-evolve/proposal/discard') {
      const payload = await readJsonBody(req);
      send(200, { ok: true, ...(await discardProposal(payload.id)) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/self-evolve/lessons/purge') {
      // 批量清空记忆：只清托管区间，先归档；技能一条不动。
      // scope: 'project' | 'global' | 'all'（默认 all，保持老行为）。
      let purgeScope;
      try {
        const payload = await readJsonBody(req);
        purgeScope = typeof payload?.scope === 'string' ? payload.scope : undefined;
      } catch {
        purgeScope = undefined;
      }
      const result = await clearMemory(storage, settings, targets, undefined, purgeScope);
      send(200, { ok: true, ...result });
      return;
    }

    if (url.pathname === '/api/self-evolve/config') {
      // 判定模型的配置（key / 影子模式 / 阈值）：写进 profile patch，
      // 与手改 cordis.patch.yml 等价，但经过校验并立即生效。
      const editor = configEditorOf(ctx);
      if (editor === undefined) {
        send(400, {
          ok: false,
          error: '宿主没有 configEditor 服务，无法从这里保存；请改 self-evolve/cordis.patch.yml 后重载插件',
          writable: false,
          decision: describeDecision(settings.decision),
        });
        return;
      }
      const entry = findSelfEntry(editor);
      if (entry === undefined) {
        send(400, { ok: false, error: '找不到 self-evolve 的 profile 条目，无法保存配置', writable: false });
        return;
      }
      if (req.method === 'GET') {
        send(200, {
          ok: true,
          writable: true,
          decision: describeDecision(settings.decision),
          lastJudgement: await readLastJudgement(),
        });
        return;
      }
      if (req.method === 'POST') {
        const payload = await readJsonBody(req);
        const patch = decisionPatch(payload);
        if (Object.keys(patch).length === 0) {
          send(400, { ok: false, error: '没有可保存的字段' });
          return;
        }
        await editor.edit(entry, (current) => ({
          ...current,
          decision: { ...(current?.decision ?? {}), ...patch },
        }));
        send(200, { ok: true, saved: Object.keys(patch), decision: describeDecision({ ...settings.decision, ...patch }) });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/self-evolve/config/probe') {
      // 「它到底生效没有」的一键自检：真调一次判定接口，把原始结果摆出来。
      if (resolveDecisionKey(settings.decision).key === '') {
        send(400, { ok: false, error: '还没有配置 key：先在面板里粘贴，或改 cordis.patch.yml' });
        return;
      }
      const probe = await judgeLesson(
        // 探针是用户手点的一次性诊断：给足预算，宁可慢也别报 timeout。
        { ...settings.decision, shadow: true, timeoutMs: Math.max(settings.decision.timeoutMs, 6000) },
        {
          // probe 只验证「接口通不通」，不该被 worth 闸门判死（真实记忆里没这条）。
          probe: true,
          title: '探针：确认判定接口可用',
          summary: '这是一条用于验证 key 与网络连通性的探针，不是真实经验。如果没有配置 key 或网络不通会明确报错。',
          kind: 'memory',
        },
        [],
        undefined,
      );
      send(200, { ok: true, judgement: probe });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/self-evolve/lessons/mutate') {
      const payload = await readJsonBody(req);
      const result = await mutateLesson(storage, targets, payload, undefined);
      send(200, { ok: true, ...result });
      return;
    }

    send(404, { ok: false, error: 'unknown route' });
  } catch (error) {
    send(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** 宿主是否有配置编辑器（能写 profile patch）。 */
function configEditorOf(ctx) {
  try {
    const editor = ctx.get('configEditor');
    return editor !== undefined && typeof editor?.edit === 'function' ? editor : undefined;
  } catch {
    return undefined;
  }
}

/** 找到 self-evolve 自己的 profile 条目（patch 里的 `id: self-evolve`）。 */
function findSelfEntry(editor) {
  try {
    const entries = typeof editor.entries === 'function' ? editor.entries() : [];
    return entries.find((entry) => entry?.options?.id === 'self-evolve');
  } catch {
    return undefined;
  }
}

/** 配置的对外形态：永远不返回 key 本身，只返回「有没有、从哪来、尾四位」。 */
function describeDecision(decision) {
  const { key, source } = resolveDecisionKey(decision);
  return compact({
    enabled: decision.enabled,
    shadow: decision.shadow,
    model: decision.model,
    baseURL: decision.baseURL,
    timeoutMs: decision.timeoutMs,
    worthThreshold: decision.worthThreshold,
    scopeMinConfidence: decision.scopeMinConfidence,
    hasKey: key !== '',
    keySource: source,
    keyHint: key.length >= 8 ? `••••${key.slice(-4)}` : '',
  });
}

/** 把界面提交的字段收敛成合法 patch（只接受白名单，越界直接丢）。 */
function decisionPatch(payload) {
  const patch = {};
  if (typeof payload?.apiKey === 'string') {
    const value = payload.apiKey.trim();
    // 空串表示「不改」：避免用户只切影子模式时把 key 清掉。
    if (value.length > 0) patch.apiKey = value;
  }
  if (typeof payload?.enabled === 'boolean') patch.enabled = payload.enabled;
  if (typeof payload?.shadow === 'boolean') patch.shadow = payload.shadow;
  if (typeof payload?.model === 'string' && payload.model.trim().length > 0) patch.model = payload.model.trim();
  if (typeof payload?.baseURL === 'string' && /^https?:\/\//.test(payload.baseURL)) patch.baseURL = payload.baseURL.trim();
  if (typeof payload?.timeoutMs === 'number' && payload.timeoutMs >= 100) patch.timeoutMs = Math.round(payload.timeoutMs);
  if (typeof payload?.worthThreshold === 'number' && payload.worthThreshold >= 0 && payload.worthThreshold <= 1) {
    patch.worthThreshold = payload.worthThreshold;
  }
  if (typeof payload?.scopeMinConfidence === 'number' && payload.scopeMinConfidence >= 0 && payload.scopeMinConfidence <= 1) {
    patch.scopeMinConfidence = payload.scopeMinConfidence;
  }
  return patch;
}

/** 注册经验库路由；宿主没有 web 承载时安静跳过。 */
/**
 * 把经验库路由挂到 web 服务器上。
 *
 * **不能只 try 一次**：插件开机加载时 `webServer` 可能还没挂上（实测重启 App 后
 * 经验库整片 404，因为 `ctx.get('webServer')` 在 apply 阶段是空的；而在运行中
 * 重载插件反而一切正常——这正是「重载过就好了」的错觉来源）。所以这里先试一次，
 * 拿不到就轮询补挂，挂上后保留 disposer 交给 effect 清理。
 */
function registerLessonRoutes(ctx, settings, hooks) {
  let routeDisposer;
  let mounted = false;

  const readServer = () => {
    try {
      const server = ctx.get('webServer');
      return server !== undefined && typeof server.register === 'function' ? server : undefined;
    } catch {
      return undefined;
    }
  };

  const mount = () => {
    if (mounted) return true;
    const server = readServer();
    if (server === undefined) return false;
    try {
      routeDisposer = server.register({
        kind: 'prefix',
        path: '/api/self-evolve',
        handler: (req, res) => handleLessonRequest(ctx, settings, req, res, hooks),
      });
      mounted = true;
    } catch {
      mounted = false;
      return false;
    }
    return true;
  };

  ctx.effect(() => () => {
    if (typeof routeDisposer === 'function') routeDisposer();
    routeDisposer = undefined;
  }, 'self-evolve: experience library route cleanup');

  if (mount()) return true;

  // 服务晚到：每 500ms 再看一次，最多 120 次（60 秒）；挂上就停。
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (mount() || tries >= 120) clearInterval(timer);
  }, 500);
  if (typeof timer.unref === 'function') timer.unref();
  ctx.effect(() => () => clearInterval(timer), 'self-evolve: experience library route retry');
  return false;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

/** `self_evolve_record` 的参数 schema。 */
/**
 * 统计「已经积累了多少经验」，给界面的收尾状态用。
 *
 * 记忆条数直接从记忆文件的托管区间里数；技能数按 `SKILL.md` 存在与否数目录。
 * 两者都读不到就返回 0——统计失败绝不能让写入本身失败。
 */
async function collectStats(storage, targets, signal, settings) {
  let memoryEntries = 0;
  let memoryBytes = 0;
  // 分档统计：项目级与全局各自有多少条、多少字节，界面要能分开显示。
  // 用数组而不是对象：输出 schema 是 strict 的，动态键名声明不出来。
  const memoryByScope = [];
  const memoryTargets = targets.memoryTargets ?? { global: targets.memoryPath };
  for (const [key, file] of Object.entries(memoryTargets)) {
    let entries = 0;
    let bytes = 0;
    try {
      const text = await storage.read(file, signal);
      entries = parseMemoryEntries(text).length;
      bytes = Buffer.byteLength(text, 'utf8');
    } catch {
      entries = 0;
      bytes = 0;
    }
    memoryByScope.push({ scope: key, entries, bytes, path: file });
    memoryEntries += entries;
    memoryBytes += bytes;
  }

  // 只数**本插件写的**技能：技能根目录里通常还有用户自己的一堆技能，
  // 按目录数会把别人的算成「这次积累的」（实测 39 个里有 33 个是用户原有的）。
  let skills = 0;
  let skillsTotal = 0;
  try {
    const entries = await readdir(targets.skillRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = join(targets.skillRoot, entry.name, 'SKILL.md');
      try {
        await access(file);
      } catch {
        continue; // 目录存在但没有 SKILL.md：不是技能。
      }
      skillsTotal += 1;
      try {
        if (isOwnedSkill(await storage.read(file, signal))) skills += 1;
      } catch {
        // 读不出内容就当不是自己的：计数宁少不多。
      }
    }
  } catch {
    skills = 0;
    skillsTotal = 0;
  }

  return {
    memoryEntries,
    memoryBytes,
    memoryByScope,
    memoryBytesLimit: settings === undefined ? 0 : settings.maxMemoryBytes,
    memoryLimit: settings === undefined ? 0 : settings.maxMemoryEntries,
    skills,
    skillsTotal,
    memoryPath: targets.memoryPath,
    skillRoot: targets.skillRoot,
  };
}

const RECORD_PARAMETERS = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'The distilled lesson: trigger scenario, the correct approach, and what to avoid. Keep it to one short paragraph (<=200 chars) — the memory file is loaded on EVERY turn, so length costs context. Put long chains of detail in `detail` instead.',
    },
    detail: {
      type: 'string',
      description:
        'Full detail for a long lesson (commands, links, long timelines). Stored in a detail file under the plugin state dir; the memory entry keeps only the short conclusion plus a pointer to it. Omit for short lessons.',
    },
    title: {
      type: 'string',
      description: 'Short label for this lesson, used as the memory bullet prefix and the skill title.',
    },
    kind: {
      type: 'string',
      enum: ['memory', 'skill', 'both'],
      description:
        "Where to persist: 'memory' = the memory file (workspace AGENTS.md by default), 'skill' = <skills root>/<skill_name>/SKILL.md, 'both' = both. Defaults to 'memory'.",
    },
    skill_name: {
      type: 'string',
      description: "Kebab-case skill name, required when kind is 'skill' or 'both' (e.g. 'fix-flaky-pnpm-install').",
    },
    scope: {
      type: 'string',
      enum: ['project', 'global'],
      description:
        "Which memory file this lesson belongs to. 'project' (default) = this repository's AGENTS.md: repo-specific commands, paths, traps, workflows. 'global' = $DSH_HOME/AGENTS.md, loaded in EVERY project: only cross-project truths — tool/environment behaviour, collaboration style, and the user's personal preferences (language, format, habits). When unsure, use 'project'; polluted global memory costs context on every turn.",
    },
    skill_description: {
      type: 'string',
      description: 'One-sentence skill description used in the SKILL.md frontmatter when the skill is created.',
    },
    when_to_use: {
      type: 'string',
      description: 'When this skill applies, used as the SKILL.md whenToUse frontmatter when the skill is created.',
    },
    adopt: {
      type: 'boolean',
      description: "Only for kind='skill'/'both': take over a skill the user wrote (no self-evolve marker). Default false — a user-owned SKILL.md is refused rather than silently adopted.",
    },
    dry_run: {
      type: 'boolean',
      description: 'Report what would be written without touching any file.',
    },
  },
  required: ['summary'],
  additionalProperties: false,
};

/** `self_evolve_record` 的输出 schema。 */
const RECORD_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    written: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          path: { type: 'string' },
          action: { type: 'string' },
          bytes: { type: 'number' },
          dropped: { type: 'number' },
          // 长经验被拆成「结论 + 指引」时，指引指向哪里、记忆这条实际多长。
          detailPath: { type: 'string' },
          shortened: { type: 'boolean' },
          lessonChars: { type: 'number' },
          // 这条落在哪一档：project（本仓库）/ global（每个项目都加载）。
          scope: { type: 'string' },
          // 上限淘汰的明细：界面要能说清「哪几条被挪走了、挪到哪了」。
          evicted: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, bytes: { type: 'number' } },
              additionalProperties: false,
            },
          },
          archivePath: { type: 'string' },
          // 为什么被挪走：'superseded'（新结论取代）/ 'count'（记忆已满）/ 'bytes'（超字数）。
          evictedBy: { type: 'string' },
          reason: { type: 'string' },
          // 跨档清理：新条目取代/作废了另一份记忆文件里的条目，这里说明挪走了谁。
          clearedElsewhere: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                title: { type: 'string' },
                reason: { type: 'string' },
                scope: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          // 淘汰条目带走的详情文件（已挪进 archive/details，未删除）。
          sweptDetails: { type: 'array', items: { type: 'string' } },
          // 必须声明：写成功时带 title 回来，Client 半靠它渲染「沉淀了什么」。
          // 漏声明会被输出校验整体拒绝（additionalProperties: false），UI 只能
          // 看到 invalid output 错误——动画一次都不会播。
          title: { type: 'string' },
          // 技能专用：证明「这次是优化了已有技能」而不是新建。
          // skillName = 技能名；previousEntries/entries = 改前/改后该技能的条目数。
          skillName: { type: 'string' },
          previousEntries: { type: 'number' },
          entries: { type: 'number' },
          // 从全局改判成项目档时给的原因：结果里能直接看到为什么换了档。
          scopeNote: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    errors: { type: 'array', items: { type: 'string' } },
    // 为什么沉淀：界面要能说清「这次是因为多工具长链路 / 连续失败」。
    // 同样是 strict schema，字段必须全部声明。
    trigger: {
      type: 'object',
      properties: {
        reasons: { type: 'array', items: { type: 'string' } },
        steps: { type: 'number' },
        distinctTools: { type: 'number' },
        shellFailures: { type: 'number' },
        toolFailures: { type: 'number' },
      },
      additionalProperties: false,
    },
    // 决策模型的判定结果：值不值得（worth/not-worth）、建议落点、耗时。
    // 影子模式（shadow）下 enforced=false：只记录不拦截。
    judgement: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        reason: { type: 'string' },
        worth: { type: 'number' },
        scope: { type: 'string' },
        confidence: { type: 'number' },
        model: { type: 'string' },
        ms: { type: 'number' },
        enforced: { type: 'boolean' },
        // 归属建议：这条经验该改技能本身还是只记一条记忆。
        kind: { type: 'string' },
        // 命中重复时要取代的那一条；以及因此过期的条目。
        mergeInto: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            index: { type: 'number' },
            title: { type: 'string' },
            scope: { type: 'string' },
          },
          additionalProperties: false,
        },
        staleInto: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            index: { type: 'number' },
            title: { type: 'string' },
            scope: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    // 判定模型认为「该改技能」时，回给调用方的下一步指引。
    kindHint: { type: 'string' },
    // 达到 maxRecordsPerTurn 被跳过时的说明；也要声明，理由同上。
    skipped: { type: 'string' },
    // 累计积累量：界面在动画结束后显示「累计 N 条记忆 / K 个技能」。
    // 同样是 additionalProperties: false 的严格 schema，字段必须逐个声明。
    stats: {
      type: 'object',
      properties: {
        memoryEntries: { type: 'number' },
        // 记忆上限：界面显示「记忆 15/50 条」，一眼看出还有多少余量。
        memoryLimit: { type: 'number' },
        // 字节占用：条数没满、字节先满也是会淘汰的，界面要两个都看得到。
        memoryBytes: { type: 'number' },
        memoryBytesLimit: { type: 'number' },
        // 分档：项目级 / 全局各自几条。
        memoryByScope: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scope: { type: 'string' },
              entries: { type: 'number' },
              bytes: { type: 'number' },
              path: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        // 本插件写的技能数（用户原有技能不算进来）。
        skills: { type: 'number' },
        // 技能根目录里的技能总数，含用户自己的，便于对照。
        skillsTotal: { type: 'number' },
        memoryPath: { type: 'string' },
        skillRoot: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** `self_evolve_status` 的输出 schema。 */
const PROPOSE_OUTPUT = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'kind', 'path', 'note'],
  properties: {
    ok: { type: 'boolean' },
    id: { type: 'string' },
    kind: { type: 'string' },
    path: { type: 'string' },
    charsBefore: { type: 'number' },
    charsAfter: { type: 'number' },
    // 为什么改：模型给的理由，会随提案一起展示与留档。
    reason: { type: 'string' },
    // 随提案一起改的附属文件（脚本/模板）的路径。
    files: { type: 'array', items: { type: 'string' } },
    // 决策模型的结论：这次改动值不值得做（verdict/worth/ms/enforced）。
    judgement: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        worth: { type: 'number' },
        confidence: { type: 'number' },
        model: { type: 'string' },
        ms: { type: 'number' },
        enforced: { type: 'boolean' },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
    note: { type: 'string' },
  },
});

const STATUS_OUTPUT = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    // 经验库路由是否已注册（界面查看/编辑依赖它）。
    lessonApi: { type: 'boolean' },
    config: {
      type: 'object',
      properties: {
        chainSteps: { type: 'number' },
        shellFailureThreshold: { type: 'number' },
        repeatEvery: { type: 'number' },
        shellTools: { type: 'array', items: { type: 'string' } },
        language: { type: 'string' },
        dryRun: { type: 'boolean' },
        scope: { type: 'string' },
        memoryPath: { type: 'string' },
        skillRoot: { type: 'string' },
        workflowMinSteps: { type: 'number' },
        workflowMinDistinctTools: { type: 'number' },
        triggerOnLengthOnly: { type: 'boolean' },
        toolFailureThreshold: { type: 'number' },
        maxRecordsPerTurn: { type: 'number' },
        maxMemoryEntries: { type: 'number' },
        maxMemoryBytes: { type: 'number' },
        maxLessonChars: { type: 'number' },
        maxMemoryLessonChars: { type: 'number' },
        globalMemoryPath: { type: 'string' },
        projectMemoryPath: { type: 'string' },
        // 判定模型：是否开启、是不是影子模式、key 从哪来（不打印 key 本身）。
        decision: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            shadow: { type: 'boolean' },
            model: { type: 'string' },
            baseURL: { type: 'string' },
            timeoutMs: { type: 'number' },
            hasKey: { type: 'boolean' },
            keySource: { type: 'string' },
            worthThreshold: { type: 'number' },
            scopeMinConfidence: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    // `probe: true` 时真调一次判定接口，用来确认 key 与网络是否通。
    decisionProbe: {
      type: 'object',
      properties: {
        verdict: { type: 'string' },
        reason: { type: 'string' },
        worth: { type: 'number' },
        scope: { type: 'string' },
        confidence: { type: 'number' },
        ms: { type: 'number' },
      },
      additionalProperties: false,
    },
    environment: {
      type: 'object',
      properties: {
        hasSession: { type: 'boolean' },
        hasFsService: { type: 'boolean' },
        hasSandboxPolicyService: { type: 'boolean' },
        fsDefaultMode: { type: 'string' },
        resolvedMode: { type: 'string' },
        workspaceRoot: { type: 'string' },
      },
      additionalProperties: false,
    },
    counters: {
      type: 'object',
      properties: {
        steps: { type: 'number' },
        shellFailures: { type: 'number' },
        toolFailures: { type: 'number' },
        pendingNotice: { type: 'string' },
        evolutions: { type: 'number' },
        peakShellFailures: { type: 'number' },
        recordsThisTurn: { type: 'number' },
        distinctTools: { type: 'number' },
        // 本轮是否已就绪（系统提示里正在提示模型沉淀），以及跨轮累计次数。
        ready: { type: 'boolean' },
        evolutionsTotal: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** 渲染 JSON 结果。 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * 安装触发器与两个工具。
 * @param ctx - 插件上下文。
 * @param config - `cordis.patch.yml` 中该行的 config。
 */
/** 仅供测试：把判定链路暴露出来，避免为了测一条分支起整个 ctx。 */
export const __test = { judgeLesson, memoryTitles, rememberJudgement, rememberRecord, readLastRecord, matchSkillName };

/** 仅供测试：并发写测试要直接打 writeMemory，绕开工具层。 */
export const writeMemoryForTest = (...args) => writeMemory(...args);

export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  if (!settings.enabled) return;

  const systemPrompt = ctx.get('systemPrompt');

  // 协议正文进系统提示（用户不可见）。`systemPrompt` 是可选服务：宿主没提供
  // （例如纯 headless 环境）就跳过，触发退回没有协议的哑标记。
  //
  // 正文优先取 `~/.dsh/self-evolve/protocol.md`（自己可以提案改它），文件不存在
  // 就用内置文案。应用提案后要重新装配这一段——section() 注册的是**文本快照**，
  // 不重挂的话新协议要等下一次插件重载才生效。
  const protocol = { disposer: undefined, text: activeProtocol(settings) };

  function mountProtocol() {
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return;
    try {
      if (typeof protocol.disposer === 'function') protocol.disposer();
    } catch {
      // 旧的已经卸载过了，忽略。
    }
    protocol.disposer = systemPrompt.section({
      name: 'self-evolve:protocol',
      order: 900,
      interpolate: false,
      text: protocol.text,
    });
  }

  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    mountProtocol();

    // 触发信号**不产生任何消息**：它是一条按步刷新的动态上下文，只在这一轮
    // 真正就绪时出现。为什么不用 agent.steer() 发标记——steer 会追加一步，
    // 那一步的回复会变成「本轮最后一条助手消息」，把真正的结论挤进折叠的
    // 「已调用工具」分组里，用户不点展开就看不到答案。
    if (typeof systemPrompt.context === 'function') {
      systemPrompt.context({
        name: 'self-evolve:ready',
        order: 950,
        required: false,
        interpolate: false,
        text: (assembly) => readyText(assembly?.scope),
      });
    }
  }

  // 经验库路由：界面「点开查看 / 编辑」靠它拿正文、写回文件；应用协议提案后
  // 通过 hooks 重新装配系统提示段。
  const lessonApi = registerLessonRoutes(ctx, settings, {
    onProtocolChanged(text) {
      protocol.text = text;
      mountProtocol();
    },
  });

  /** 每个 agent 的执行链状态。 */
  const states = new WeakMap();

  /**
   * 越界写入的授权缓存，跨调用共享。
   *
   * `granted` 记住已批准的会话，`pending` 折叠同一会话的并发询问——一次
   * `self_evolve_record` 可能同时写记忆和技能，不该弹两次窗。
   */
  const grants = { granted: new WeakSet(), pending: new WeakMap() };

  /** 取（或创建）某个 agent 的状态。 */
  function stateOf(agent) {
    let state = states.get(agent);
    if (state === undefined) {
      state = {
        steps: 0,
        shellFailures: 0,
        peakShellFailures: 0,
        // 任意工具失败次数（不只 shell）。
        toolFailures: 0,
        pendingNotice: '',
        // 本轮已就绪：动态上下文里会出现「该沉淀了」的段落（用户不可见）。
        ready: false,
        // evolutions 按轮统计（reset 清零），evolutionsTotal 跨轮累计。
        evolutions: 0,
        evolutionsTotal: 0,
        // 已经进化过的 turn 号；-1 表示本轮还没进化过。
        evolvedTurn: -1,
        // 本轮已经写入的条数，用于限制「一次复盘只留一条」。
        recordsThisTurn: 0,
        // 本轮用到的工具集合，用于判断这是否是一条「新工作流」。
        tools: new Set(),
        // 本轮是否停下来等过用户（ask_user_question / 计划确认）。
        // 等用户的停顿不是「任务结束」，不能触发进化。
        awaitingUser: false,
        // 用户明确要求记住（{ snippet, preference }）：不必等失败信号，本轮就该记。
        explicit: undefined,
      };
      states.set(agent, state);
    }
    return state;
  }

  /** 重置某个 agent 的链路计数。 */
  function reset(agent) {
    const state = stateOf(agent);
    state.steps = 0;
    state.shellFailures = 0;
    state.peakShellFailures = 0;
    state.toolFailures = 0;
    state.pendingNotice = '';
    state.trigger = undefined;
    state.ready = false;
    state.evolutions = 0;
    state.evolvedTurn = -1;
    state.recordsThisTurn = 0;
    state.awaitingUser = false;
    state.explicit = undefined;
    state.tools.clear();
  }

  /**
   * 「本轮已就绪」段落的正文；未就绪时返回空串（装配器会丢弃空上下文）。
   *
   * `scope` 就是装配时的 Agent：状态按 agent 存在 WeakMap 里，取不到即视为
   * 未就绪——纯全局装配（没有 scope）永远不会看到这段。
   */
  function readyText(scope) {
    if (scope === undefined || scope === null || typeof scope !== 'object') return '';
    const state = states.get(scope);
    if (state === undefined || state.ready !== true || state.awaitingUser) return '';

    const explicit = state.trigger?.explicit;
    if (state.trigger?.reasons?.includes('explicit') && explicit !== undefined) {
      // 用户亲口要求记住：这时候不该再问「值不值得记」，而该判断「记哪一档」。
      const preference = explicit.preference === true;
      return [
        '## 自我进化 · 用户要求记住',
        '',
        `用户原话：「${explicit.snippet}」`,
        '在给出最终回答**之前**，调用一次 `self_evolve_record` 把这件事记下来：',
        '',
        preference
          ? '- 这是**个人偏好 / 长期习惯**：`scope: "global"`（写 $DSH_HOME/AGENTS.md，每个项目都生效）。'
          : '- 只在这个仓库成立的约定用 `scope: "project"`；跨项目通用的规矩用 `scope: "global"`。',
        '- 一句话写结论即可，别把整段对话抄进去：将来要用的是「该怎么做」，不是「当时说了什么」。',
        '- 记完不要在回复里提这件事，也不要复述记忆内容。',
      ].join('\n');
    }

    return [
      '## 自我进化 · 本轮已就绪',
      '',
      `本轮信号：${signalText(state.trigger) || state.pendingNotice}（已执行 ${state.steps} 步）。`,
      '在给出最终回答**之前**，调用一次 `self_evolve_record` 固化最有价值的一条经验：',
      '',
      '- 默认什么都不写；没有「会让未来的你做得不一样」的东西就直接跳过。',
      '- 写完之后不要在回复里提及这件事，一个字都不留。',
    ].join('\n');
  }

  /**
   * 观察一次工具执行，只累计统计，不注入任何提示。
   *
   * 关键设计：进化发生在**任务结束之后**，不在执行途中打断。一个正常的长任务
   * 本来就会走十几二十步，中途插入「先停下来总结」只会破坏正在进行的工作。
   * 计数放在 post-execute，因为被拒绝的调用也会走这条 waterfall。
   */
  function observe(exec, result) {
    const agent = exec.agent;
    if (agent === undefined) return;
    const state = stateOf(agent);
    state.steps += 1;
    if (typeof exec.name === 'string') {
      state.tools.add(exec.name);
      // 这两个工具的语义就是「停下来向用户要答案/确认」，它们之后的 turn 结束
      // 是任务中途的暂停，不是任务完成——绝不能在这时触发进化，否则复盘提示
      // 和记录会插在任务结果前面（用户看到的正是这个 bug）。
      if (exec.name === 'ask_user_question' || exec.name === 'exit_plan_mode') {
        state.awaitingUser = true;
      }
    }

    // 任意工具失败都算「出过问题」，不只是 shell。一个 `edit` 因为文件变了而失败
    // 同样值得复盘——那正是「读之前先确认版本」这类经验的来源。
    if (failedExecution(result)) state.toolFailures += 1;

    const isShell = settings.shellTools.has(exec.name);
    if (!isShell) return;
    if (failedExecution(result)) {
      state.shellFailures += 1;
      // 记下峰值，供任务结束时判断这一轮是否真的反复撞墙。
      if (state.shellFailures > state.peakShellFailures) state.peakShellFailures = state.shellFailures;
    } else {
      // 一次成功就把连续失败链清零，下一段连续失败仍能重新累计。
      state.shellFailures = 0;
    }
  }

  /**
   * 本轮结束时评估是否需要进化，返回要注入的提示（不需要则 undefined）。
   *
   * 三种情形合并成一次复盘：链路够长、shell 反复失败、或者走通了一条新的多步骤
   * 工作流。它们都指向「这一轮值得沉淀」，所以只发一条提示，让模型一次写完，
   * 而不是连着弹三条。
   */
  function evaluate(agent, turn) {
    const state = stateOf(agent);
    // 每轮只进化一次。`steer()` 让复盘在**同一个 turn 内**继续跑，复盘本身又会
    // 走工具、又会让 steps 增长；若只看 steps 就会无限自我触发。用 turn 号做
    // 幂等键：同一轮已经复盘过，就不再触发。
    if (state.evolvedTurn === turn) return undefined;

    // 触发原则：**只有确实出过问题、或者确实走通了一条复杂流程时才复盘**。
    // 「跑得久」本身不是价值信号——正常的开发任务也能轻松超过 15 步，把它当成
    // 值得沉淀只会制造噪声。所以长度默认不参与判断，除非显式开启。
    const reasons = [];
    // 用户自己开口了：这条消息的诉求就是「记住」，不需要失败或复杂链路作前提到。
    if (state.explicit !== undefined) reasons.push('explicit');
    if (state.toolFailures >= settings.toolFailureThreshold) reasons.push('failure');
    else if (state.peakShellFailures >= settings.shellFailureThreshold) reasons.push('failure');
    if (state.steps >= settings.workflowMinSteps && state.tools.size >= settings.workflowMinDistinctTools) {
      reasons.push('workflow');
    }
    if (reasons.length === 0 && settings.triggerOnLengthOnly && state.steps >= settings.chainSteps) {
      reasons.push('chain');
    }
    if (reasons.length === 0) return undefined;

    state.evolvedTurn = turn;
    state.evolutions += 1;
    state.evolutionsTotal += 1;
    state.recordsThisTurn = 0;
    state.pendingNotice = reasons.join('+');
    // 触发快照：数值取**就绪那一刻**的，后面模型再走两步也不影响「为什么触发」。
    state.trigger = {
      reasons,
      steps: state.steps,
      distinctTools: state.tools.size,
      shellFailures: state.peakShellFailures,
      toolFailures: state.toolFailures,
      explicit: state.explicit,
    };
    return {
      reasons,
      // 触发原因留作诊断（self_evolve_status 可见）；提示正文已并入系统提示协议，
      // steer 只发一个 🧬 标记。
      summary: `evolve after ${state.steps} steps`,
    };
  }

  // 工具执行只累计统计，绝不注入提示——进化必须等任务结束，不能在途中打断。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    observe(exec, result);
    // 这里也评估一次（幂等）：跨过阈值的那一步如果是本轮最后一次工具调用，
    // 只等下一个 pre-step 会让提示晚一步、甚至在收尾时错过。工具一返回就置就绪，
    // 下一步的系统提示一定能带上它。
    const agent = exec.agent;
    if (agent !== undefined) {
      const state = stateOf(agent);
      if (state.ready !== true && state.awaitingUser !== true && state.turn !== undefined) {
        const plan = evaluate(agent, state.turn);
        if (plan !== undefined) {
          state.ready = true;
          state.pendingNotice = plan.reasons.join('+');
        }
      }
    }
    return next();
  });

  /**
   * 本轮收尾：只把「已就绪」关掉，**不注入任何消息**。
   *
   * 历史坑：早先用 `agent.steer()` 在本轮结束后追加一步专门复盘。副作用是那一步
   * 的回复成了「本轮最后一条助手消息」，真正的结论被挤进折叠的「已调用工具」分组，
   * 用户不点展开就只看到一句「报告已在上面给出」——等于把答案藏了起来。
   * 现在改为在**执行途中**用动态上下文提示模型，模型在最后一次回答前顺手写完，
   * 不再产生额外的一步。
   */
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const state = stateOf(agent);
    state.ready = false;
  });

  ctx.on('agent/pre-step', ({ agent, messages, turn }, next) => {
    const state = stateOf(agent);
    // 记下 turn 号：post-execute 也要评估，但它拿不到 turn。
    state.turn = turn;
    const userMessages = (messages ?? []).filter((message) => message.source?.kind === 'user');
    if (userMessages.length > 0) {
      reset(agent);
      // 只在用户这条消息上判断一次：重置后再挂上显式信号。
      const intent = rememberIntent(messageText(userMessages[userMessages.length - 1]));
      if (intent !== undefined) state.explicit = intent;
    }
    // 本轮停下来等过用户（提问 / 计划确认）：任务还没走完，不触发。
    if (state.awaitingUser) return next();
    // 在执行途中就地就绪：模型这一步的系统提示里会多出一段，用户在对话里看不到。
    if (state.ready !== true) {
      const plan = evaluate(agent, turn);
      if (plan !== undefined) {
        state.ready = true;
        state.pendingNotice = plan.reasons.join('+');
      }
    }
    return next();
  });

  ctx.tools.register({
    name: 'self_evolve_record',
    description:
      'Persist one distilled lesson into memory and/or a reusable skill (<skills root>/<skill_name>/SKILL.md). Memory has two tiers chosen with `scope`: project (this repository\'s AGENTS.md, the default — repo-specific commands, paths and traps) and global ($DSH_HOME/AGENTS.md, loaded in every project — only cross-project truths and the user\'s personal preferences). Call this after a self-evolve trigger, or whenever a run taught something worth reusing. Writes are deduplicated, appended under a plugin-maintained section, and never rewrite user-authored text outside that section.',
    parameters: RECORD_PARAMETERS,
    output: { schema: RECORD_OUTPUT, render: renderJson },
    // 对话里只留一行状态，**不显示经验正文**：结论与明细属于进化记录
    // （Client 半的整屏场景 / 常驻入口），不属于聊天记录。
    // `presentResult` 不返回 content，宿主的通用卡片于是没有可展开的正文。
    // 标题只留一个标记：对话里不出现「经验 / 沉淀 / 条数」这类字样。
    presentCall: () => ({ card: 'generic', title: '🧬', kind: 'other' }),
    presentResult: () => ({ card: 'generic', title: '🧬' }),
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('self_evolve_record aborted');
      const summary = oneLine(args.summary, settings.maxLessonChars);
      if (summary.length === 0) throw new Error('self_evolve_record: `summary` must not be empty');

      const kind = args.kind ?? 'memory';
      const detail = typeof args.detail === 'string' ? args.detail.trim().slice(0, 8000) : undefined;
      const lesson = {
        date: stampNow(),
        title: oneLine(args.title ?? '经验', 60),
        summary,
        detail,
        full: detail !== undefined && detail.length > 0 ? detail : summary,
        // 同一次既写技能又写记忆时，记忆只留一句结论 + 「详见技能 X」。
        pointerSkill: kind === 'both' ? args.skill_name : undefined,
        skillName: args.skill_name,
        // 只给 writeSkill 判断用，不参与记忆渲染。
        adopt: args.adopt === true,
        skillDescription: oneLine(args.skill_description ?? `从实战经验沉淀的做法：${args.title ?? summary}`, 200),
        whenToUse: oneLine(args.when_to_use ?? '遇到同类任务或同类失败时', 200),
      };

      const wantsSkill = kind === 'skill' || kind === 'both';
      if (wantsSkill && !isSkillName(lesson.skillName)) {
        throw new Error(
          "self_evolve_record: `skill_name` must be kebab-case ([a-z0-9] with single dashes) when kind is 'skill' or 'both'",
        );
      }

      const scoped = args.dry_run === true ? { ...settings, dryRun: true } : settings;
      const storage = createStorage(ctx, exec?.agent, grants);
      const targets = resolveTargets(scoped, workspaceOf(ctx, exec));
      const signal = exec.signal;
      const state = exec.agent === undefined ? undefined : stateOf(exec.agent);

      // 一轮只留一条。复盘的价值在于取舍：写第二条通常只是把同一件事换个说法，
      // 结果就是记忆体里堆满近似条目，真正有用的那条反而被稀释。
      if (state !== undefined && scoped.dryRun !== true && state.recordsThisTurn >= scoped.maxRecordsPerTurn) {
        return {
          ok: false,
          dryRun: scoped.dryRun,
          written: [],
          errors: [],
          skipped: `already recorded ${state.recordsThisTurn} time(s) this turn (max ${scoped.maxRecordsPerTurn})`,
          stats: await collectStats(storage, targets, signal, scoped),
        };
      }

      // 决策模型：写盘前判一次「值不值得 / 写哪一档」。
      // 只判记忆：技能本身是一次显式的「这套流程值得复用」，不需要二次确认。
      let judgement;
      // 没配 key 就等于没开：不要给每条经验挂一行「降级」，那只是噪声。
      // （status 的 probe 会明确告诉用户「缺 key」。）
      const hasDecisionKey = scoped.decision.enabled && resolveDecisionKey(scoped.decision).key !== '';
      if (hasDecisionKey && (kind === 'memory' || kind === 'both')) {
        // 全量交给判定：截断放到 judgeLesson 内部做，那里才知道哪些需要正文、
        // 哪些只需要标题。在外面先截断会让「很久以前记过」的条目彻底看不见。
        const existing = await memoryTitles(storage, targets, signal);
        judgement = await judgeLesson(scoped.decision, { ...lesson, kind }, existing, signal);
        if (judgement !== undefined) await rememberJudgement({ ...judgement, probe: lesson.probe === true }, lesson.title);
        // 模型指认了「和已有第 N 条说的是同一件事」：写盘时取代那一条，不再堆近似条目。
        if (judgement.mergeInto !== undefined) lesson.mergeInto = judgement.mergeInto;
        // 过期条目：新知识让旧条目的前提不再成立 → 单独归档。
        if (judgement.staleInto !== undefined) lesson.staleInto = judgement.staleInto;
        // 影子模式：只记录不拦截，先把「它觉得值不值」和你的判断对一对。
        const enforced = scoped.decision.shadow !== true;
        if (
          kind === 'memory'
          && enforced
          && scoped.dryRun !== true
          && judgement.verdict === 'not-worth'
        ) {
          return {
            ok: false,
            dryRun: scoped.dryRun,
            written: [],
            errors: [],
            judgement,
            skipped: `judged not worth remembering (worth ${judgement.worth === undefined ? '?' : judgement.worth.toFixed(2)} < ${scoped.decision.worthThreshold}); rewrite it to say what a future run should do differently, or skip`,
            stats: await collectStats(storage, targets, signal, scoped),
          };
        }
        if (
          args.scope === undefined
          && judgement.verdict === 'worth'
          && judgement.scope !== undefined
          && (judgement.confidence ?? 0) >= scoped.decision.scopeMinConfidence
        ) {
          // 模型没指定档位时，用判定模型的结论兜底（低置信度则保持项目级）。
          lesson.scopeHint = judgement.scope;
          // 打上「这是模型判的」+ 置信度：下面那层正则兜底据此决定要不要覆盖。
          lesson.scopeJudged = true;
          lesson.scopeConfidence = judgement.confidence;
        }
      }

      const written = [];
      const errors = [];
      const tasks = [];
      if (kind === 'memory' || kind === 'both') {
        // 落点优先级：配置强制 > 模型显式指定 > 判定模型建议 > 默认项目级。
        lesson.scope = args.scope === 'global'
          ? 'global'
          : args.scope === 'project'
            ? 'project'
            : (lesson.scopeHint ?? 'project');
        // 档位兜底：**判定模型可信时听它的**，正则只在它没给出结论（降级/低置信）时兜底。
        //
        // 之前是反过来的——正则永远有最终否决权，于是「提交前先跑 node --check」这种
        // 明明跨项目成立、却不含「偏好/web_search」等关键词的规矩，被强行塞回项目级。
        // 正则只会看词，判定模型看的是语义，用词表覆盖语义是本末倒置。
        if (lesson.scope === 'global') {
          const gated = gateScope(scoped, lesson);
          if (gated !== 'global') {
            const text = `${lesson.title} ${lesson.summary} ${lesson.full ?? ''}`;
            lesson.scope = gated;
            lesson.scopeNote = (HARD_LOCAL.test(text) || PROJECT_LOCAL.test(text))
              ? '这条绑在当前工作区/端口上，属于项目级'
              : '全局只收用户偏好与本机环境事实，这条属于项目级';
          }
        }
        tasks.push(writeMemory(storage, scoped, targets, lesson, signal, memoryTargetFor(targets, lesson.scope)));
      }
      if (wantsSkill) tasks.push(writeSkill(storage, scoped, targets, lesson, signal));
      for (const outcome of await Promise.allSettled(tasks)) {
        // 带上 title 一起返回：Client 半要用它渲染「最终沉淀了什么」，否则界面上
        // 只有「记忆 ×1」这种数量，用户看不出到底学到了什么。
        if (outcome.status === 'fulfilled') written.push({ ...outcome.value, title: lesson.title });
        else errors.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
      }

      // 只有真的写了东西才计入本轮的配额；纯去重（unchanged）不该占名额。
      if (state !== undefined && scoped.dryRun !== true) {
        if (written.some((entry) => entry.action !== 'unchanged')) {
          state.recordsThisTurn += 1;
          // 交给动画用：只在真的写了东西时更新。
          void rememberRecord(written, lesson);
          // 记忆事件也进「最近的改动」：原来那里只有技能，记忆变更查无此据。
          const changed = written.find((entry) => entry.action !== 'unchanged');
          if (changed !== undefined) {
            const why = judgement?.mergeInto !== undefined
              ? `取代了「${judgement.mergeInto.title}」`
              : judgement?.staleInto !== undefined
                ? `让「${judgement.staleInto.title}」的前提过期`
                : '新增';
            void appendApplied({
              kind: 'memory',
              title: lesson.title,
              scope: lesson.scope,
              reason: why,
              at: stampNow(),
            });
          }
        }
        state.pendingNotice = '';
        // 写过一次就关掉「就绪」，本轮后续步骤不再催促（配额另有 recordsThisTurn 兜底）。
        state.ready = false;
      }
      // 自动整理：沉淀完顺手巡检一次（6 小时内不重复跑）。失败一律忽略——
      // 整理是后台维护，不该让本轮写入看起来出错。
      if (scoped.dryRun !== true && scoped.autoAudit !== false && written.some((entry) => entry.kind === 'memory' && entry.action !== 'unchanged')) {
        const last = readAudit();
        const stale = last?.at === undefined || Date.now() - Date.parse(String(last.at).replace(' ', 'T')) > 6 * 3600 * 1000;
        if (stale) {
          void (async () => {
            try {
              // 不继承本轮的工具 signal：turn 一结束它就会 abort，整理会在合并了
              // 一半时停住、还不写 audit.json，下次沉淀又重跑一遍。给后台自己的超时。
              const background = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(120000)
                : undefined;
              const entries = await memoryTitles(storage, targets, background);
              if (entries.length >= 6) {
                await healthcheckMemory(storage, scoped, targets, background, { autoMerge: scoped.autoMergeAudit !== false });
              }
            } catch {
              // 后台整理失败不影响本轮。
            }
          })();
        }
      }

      // 带一份「累计积累量」回去：动画结束后界面显示积累情况，而不是只显示本轮。
      const stats = scoped.dryRun === true ? undefined : await collectStats(storage, targets, signal, scoped);
      // 触发原因一起返回：界面要能回答「这次为什么沉淀」。
      const trigger = state?.trigger === undefined ? undefined : {
        reasons: [...state.trigger.reasons],
        steps: state.trigger.steps,
        distinctTools: state.trigger.distinctTools,
        shellFailures: state.trigger.shellFailures,
        toolFailures: state.trigger.toolFailures,
      };
      // 判定模型说「这是技能缺陷」，但调用方按记忆来记了：把归属建议带回去，
      // 而不是悄悄写成一条永远修不好技能的备忘。
      let kindHint;
      if (!wantsSkill && judgement?.kind === 'skill') {
        // 判定模型说「这是技能缺陷」：帮他认到具体技能，给出可直接照抄的下一步。
        const names = await installedSkillNames(targets, signal);
        const matched = matchSkillName(`${lesson.title} ${lesson.summary}`, names);
        kindHint = matched === undefined
          ? '判定模型认为这条经验应改技能本身（脚本/模板/报告逻辑），不是记一条备忘；但正文里没认出技能名——确认是哪个技能后，用 kind: "skill" + skill_name 重记。'
          : `判定模型认为这是技能 \`${matched}\` 本身的缺陷（脚本/模板/报告逻辑），不是一条备忘。下一步：self_evolve_propose({ kind: "skill", skill_name: "${matched}", body: <改好的 SKILL.md>, reason: <为什么改> })，用户点「应用」才生效。`;
      }
      return {
        ok: errors.length === 0,
        dryRun: scoped.dryRun,
        written,
        errors,
        ...judgement === undefined ? {} : { judgement },
        ...kindHint === undefined ? {} : { kindHint },
        ...stats === undefined ? {} : { stats },
        ...trigger === undefined ? {} : { trigger },
      };
    },
  });

  // 自优化提案：模型可以给自己的协议、或自己建的技能提交一版精简稿。
  // 这个工具**绝不写目标文件**——只入队，等用户在经验库里看 diff 后点应用。
  ctx.tools.register({
    name: 'self_evolve_propose',
    description:
      'Submit a rewrite proposal for the injected self-evolve protocol (its own system-prompt section) or for ANY existing skill under the skills root — the user\'s own skills included, not only self-created ones. Nothing is applied: the user reviews the diff in the evolution-record UI and clicks apply; the reason you give is stored with the change so it stays explainable afterwards. For skill rewrites, `body` replaces SKILL.md and `files` carries scripts/templates (complete contents, skill-relative paths), so both the prompt and the code it depends on can be improved. Guardrails: the keep block of the protocol must stay byte-identical, a self-evolve-owned skill must keep its ownership marker, and a user-owned skill must NOT gain one.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['prompt', 'skill'], description: "'prompt' rewrites the injected protocol; 'skill' rewrites one self-created SKILL.md." },
        body: { type: 'string', description: 'The complete new text (not a patch). For kind=prompt it replaces the protocol body; for kind=skill it replaces the whole SKILL.md including its frontmatter.' },
        reason: { type: 'string', description: 'One line on why this rewrite is worth applying. Shown next to the diff AND stored with the change, so you can still explain it after it has been applied.' },
        skill_name: { type: 'string', description: "Required when kind='skill': the kebab-case folder name under the skills root. May be a skill the user wrote themselves — optimising existing skills is the point." },
        files: {
          type: 'array',
          description: "Scripts/templates the skill needs to keep or gain, as complete new contents. Paths are relative to the skill folder (e.g. 'scripts/fetch.py'); a file you mention in the body must exist on disk or be supplied here, and every supplied file must be mentioned in the body. Omit when only SKILL.md changes.",
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: "Skill-relative path such as 'scripts/run.py'." },
              content: { type: 'string', description: 'Complete new file content (not a patch).' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['kind', 'body', 'reason'],
      additionalProperties: false,
    },
    output: { schema: PROPOSE_OUTPUT, render: renderJson },
    // 和 record 一样：对话里只留一个标记，正文属于进化记录 UI。
    presentCall: () => ({ card: 'generic', title: '🧬', kind: 'other' }),
    presentResult: () => ({ card: 'generic', title: '🧬' }),
    async execute(args, exec) {
      const kind = args.kind;
      if (kind !== 'prompt' && kind !== 'skill') throw new Error('self_evolve_propose: `kind` must be "prompt" or "skill"');
      const body = typeof args.body === 'string' ? args.body : '';
      const reason = oneLine(args.reason ?? '', 200);
      if (reason.length === 0) throw new Error('self_evolve_propose: `reason` must not be empty');

      const storage = createStorage(ctx, exec?.agent, grants);
      const targets = resolveTargets(settings, workspaceOf(ctx, exec));

      let path;
      let before;
      let title;
      let pendingFiles = [];
      let skillJudgement;
      if (kind === 'prompt') {
        path = protocolFilePath();
        before = activeProtocol(settings);
        validateProtocol(settings, before, body);
        title = settings.language === 'en' ? 'protocol slim-down' : '协议瘦身';
      } else {
        if (!isSkillName(args.skill_name)) {
          throw new Error("self_evolve_propose: `skill_name` must be kebab-case when kind is 'skill'");
        }
        const dir = join(targets.skillRoot, args.skill_name);
        path = join(dir, 'SKILL.md');
        before = await storage.read(path, exec?.signal);
        if (before.length === 0) {
          throw new Error(`self_evolve_propose: skill "${args.skill_name}" does not exist yet — create it with self_evolve_record first`);
        }
        validateSkillRewrite(settings, before, body);
        // 附属文件（脚本等）：先做静态校验，再逐条读「改前内容」用于冲突检测与 diff。
        const wanted = validateSkillFiles(settings, dir, body, args.files);
        await checkSkillReferences(storage, dir, body, wanted, exec?.signal);
        pendingFiles = [];
        for (const item of wanted) {
          const current = await storage.read(item.abs, exec?.signal);
          pendingFiles.push({ path: item.path, abs: item.abs, before: current, after: item.after });
        }
        title = args.skill_name;

        // 改已有技能要过决策模型：这次改动值不值得做。
        // 没配 key 等于没开；超时/报错一律放行（fail-open）——不能让判定挂掉卡住优化。
        const hasDecisionKey = settings.decision.enabled && resolveDecisionKey(settings.decision).key !== '';
        if (hasDecisionKey) {
          skillJudgement = await judgeSkillRewrite(settings.decision, {
            skillName: args.skill_name,
            reason,
            before,
            after: body,
            files: pendingFiles,
          }, exec?.signal);
          if (settings.decision.shadow !== true && skillJudgement.verdict === 'not-worth') {
            throw new Error(
              `这次改写被判为不值得应用（worth ${skillJudgement.worth === undefined ? '?' : skillJudgement.worth.toFixed(2)} < ${settings.decision.worthThreshold}）：`
              + '它只是换了措辞/格式，没有让同类任务的做法变不同。要么补上真正的新信息（修掉的坑、删掉的重复、缺失的脚本），要么放弃。',
            );
          }
        }
      }

      if (settings.dryRun) {
        return {
          ok: true,
          id: 'dry-run',
          kind,
          path,
          charsBefore: before.length,
          charsAfter: body.length,
          note: 'dry-run: proposal not queued',
        };
      }

      const submitted = await submitProposal({
        kind, path, title, reason, before, after: body, files: pendingFiles, judgement: skillJudgement,
      });
      return {
        ok: true,
        ...submitted,
        note: 'queued: nothing changes until the user clicks apply in the evolution record',
      };
    },
  });

  ctx.tools.register({
    name: 'self_evolve_status',
    description:
      'Report the self-evolve configuration and this session\'s trigger counters (tool-chain length, consecutive shell failures, whether a trigger notice is still unanswered), plus the exact resolved memory and skills paths. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        probe: {
          type: 'boolean',
          description: 'When true, make one real call to the decision endpoint (to verify the configured key and network path) and include the result as `decisionProbe`.',
        },
      },
      additionalProperties: false,
    },
    output: { schema: STATUS_OUTPUT, render: renderJson },
    async execute(args, exec) {
      const state = exec.agent === undefined ? undefined : stateOf(exec.agent);
      const targets = resolveTargets(settings, workspaceOf(ctx, exec));
      // probe：真调一次判定接口，用来确认 key/网络是否通。默认不调（要花钱也要等）。
      const probe = args?.probe === true && settings.decision.enabled
        ? await judgeLesson(
          { ...settings.decision, shadow: true },
          { title: '探针：确认判定接口可用', summary: '这是一条用于验证 key 与网络连通性的探针，不是真实经验。', kind: 'memory' },
          [],
          exec.signal,
        )
        : undefined;
      return {
        enabled: true,
        lessonApi,
        ...probe === undefined ? {} : {
          decisionProbe: compact({
            verdict: probe.verdict,
            reason: probe.reason,
            worth: probe.worth,
            scope: probe.scope,
            confidence: probe.confidence,
            ms: probe.ms,
          }),
        },
        config: {
          chainSteps: settings.chainSteps,
          shellFailureThreshold: settings.shellFailureThreshold,
          repeatEvery: settings.repeatEvery,
          shellTools: [...settings.shellTools],
          language: settings.language,
          dryRun: settings.dryRun,
          scope: targets.scope,
          // 两档落点都报出来：只报「默认那个」会让人以为另一档不存在。
          memoryPath: targets.memoryPath,
          globalMemoryPath: targets.memoryTargets.global,
          projectMemoryPath: targets.memoryTargets.project,
          skillRoot: targets.skillRoot,
          decision: (() => {
            const { key, source } = resolveDecisionKey(settings.decision);
            return {
              enabled: settings.decision.enabled,
              shadow: settings.decision.shadow,
              model: settings.decision.model,
              baseURL: settings.decision.baseURL,
              timeoutMs: settings.decision.timeoutMs,
              hasKey: key !== '',
              keySource: source,
              worthThreshold: settings.decision.worthThreshold,
              scopeMinConfidence: settings.decision.scopeMinConfidence,
            };
          })(),
          workflowMinSteps: settings.workflowMinSteps,
          workflowMinDistinctTools: settings.workflowMinDistinctTools,
          triggerOnLengthOnly: settings.triggerOnLengthOnly,
          toolFailureThreshold: settings.toolFailureThreshold,
          maxRecordsPerTurn: settings.maxRecordsPerTurn,
          maxMemoryEntries: settings.maxMemoryEntries,
          maxMemoryBytes: settings.maxMemoryBytes,
          maxLessonChars: settings.maxLessonChars,
          maxMemoryLessonChars: settings.maxMemoryLessonChars,
        },
        environment: describeEnvironment(ctx, exec),
        counters: {
          steps: state?.steps ?? 0,
          shellFailures: state?.shellFailures ?? 0,
          toolFailures: state?.toolFailures ?? 0,
          pendingNotice: state?.pendingNotice ?? '',
          evolutions: state?.evolutions ?? 0,
          peakShellFailures: state?.peakShellFailures ?? 0,
          recordsThisTurn: state?.recordsThisTurn ?? 0,
          distinctTools: state?.tools.size ?? 0,
          ready: state?.ready === true,
          evolutionsTotal: state?.evolutionsTotal ?? 0,
        },
      };
    },
  });
}
