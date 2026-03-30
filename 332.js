				const VERSION =
  'gemini-v50.7-flash-only-for-body-lite-only-for-nonbody-chapter-aware-balanced-chunking-v2.js';

const UPDATE_LOG = `
1. [Models] Gemini 3 Flash Preview 只保留给正文翻译使用。
2. [Non-Body AI] TXT 结构判断 / EPUB 宏观过滤 / EPUB 微观过滤 / 元数据抽取，全部改为 Gemini 3.1 Flash Lite Preview。
3. [Identity] 删除启动阶段 Identity AI 调用，改为 provisional identity。
4. [Identity Finalization] 导出前按“本地中文字段 -> 外置 book_metadata_zh_map.json -> 已译正文/前言样本规则抽取 -> 必要时单次 Gemini 3.1 Flash Lite Preview(temperature=0)”定稿。
5. [Identity Naming] 导出前统一重命名文件夹 / EPUB / TXT / 信息说明。
6. [Identity Source] AI-only source 默认隐藏。
7. [Book Title Policy] 书名不再单独调用 AI 翻译；仅允许从已译中文样本中抽取中文书名/作者。
8. [Chapter Title] 删除章节标题单独 AI 翻译链路，改为零额外 AI 的章节标题规范化。
9. [Long Titles] 超长标题处理改为纯规则压缩，不再调用 AI。
10. [Chunking] Chapter-Aware Balanced Chunking v2：先按 HARD_CHUNK_LIMIT 反推理论最少分段数，再按章节/段落感知评分器挑切点；优先章节边界、其次段落边界，尽量避开章节开头/结尾附近；只有整句约束下实在装不下，才从 N 升到 N+1。
11. 自检 输出熔断改为动态阈值：base 30000 / max 36000 / floor(sourceLength*1.08)+1200。
12. [Bad Block Sweep] 历史坏块扫描同步使用动态输出熔断。
13. [API Retry] 429/500/503/504/RESOURCE_EXHAUSTED/UNAVAILABLE 等错误会持续换 KEY 重试，不因为第 4 次后进入分段。
14. [Key Pool] api0.txt 改为“上方 key / 下方记录区”结构；只统计 gemini-3-flash-preview 的成功调用次数。
15. [Quota Reset] 每天北京时间 16:00 后第一次调用自动清零全部 key 计数，并记录最后一次成功时间。
16. [Book Info] 书籍信息 txt 明面保留原书名原文，不显示作者；仅按分析方案修改，不暗改核心流程。
`;

const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const EPubModule = require('epub');
const EPub = EPubModule?.default || EPubModule?.EPub || EPubModule;
const EpubGen = require('epub-gen');

// 说明：Node 18+ 原生有 fetch；若运行环境没有，则自动降级到 node-fetch。
const fetchFn =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : async (...args) => {
        const mod = await import('node-fetch');
        return mod.default(...args);
      };

// ==========================================
// 配置区 / 开关区（全部中文注释）
// ==========================================

/**
/**
 * 从 api0.txt 中读取 API Keys
 * - 只读取 ============================ 分隔线以上的 key 区
 * - 分隔线以下保留给调用记录区
 */
const API_KEY_FILE_PATH = path.join(__dirname, 'api0.txt');
const API_RECORD_SEPARATOR = '============================';
const FLASH_DAILY_MAX_PER_KEY = 25;
const FLASH_STOP_TASK_ERROR_CODE = 'FLASH_ALL_KEYS_DAILY_LIMIT_REACHED';

function splitApiKeyFile(raw = '') {
  const normalized = String(raw || '').replace(/^\uFEFF/, '');
  const idx = normalized.indexOf(API_RECORD_SEPARATOR);
  if (idx < 0) {
    return {
      keySectionText: normalized.trimEnd(),
      recordSectionText: '',
    };
  }

  return {
    keySectionText: normalized.slice(0, idx).trimEnd(),
    recordSectionText: normalized.slice(idx + API_RECORD_SEPARATOR.length).trim(),
  };
}

function extractApiKeysFromKeySection(rawKeySection = '') {
  const keys = [];
  for (const line of String(rawKeySection || '').split(/\r?\n/)) {
    const cleaned = line.replace(/["',;\[\]\(\)]/g, ' ').trim();
    const matches = cleaned.match(/AIza[0-9A-Za-z\-_]{20,}/g);
    if (matches) keys.push(...matches);
  }
  return [...new Set(keys)];
}

function loadApiKeysFromFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const parts = splitApiKeyFile(raw);
  return extractApiKeysFromKeySection(parts.keySectionText);
}

/** API Key 池：从当前脚本目录下 api0.txt 读取 */
const API_KEYS = loadApiKeysFromFile(API_KEY_FILE_PATH);

if (API_KEYS.length === 0) {
  throw new Error('api0.txt 未读取到任何有效 API Key。');
}

// ---------- 模型配置 ----------

/** 主力强模型：仅允许用于正文翻译 */
const FLASH_MODEL_NAME = 'gemini-3-flash-preview';

/** 轻量模型：仅用于结构判断 / 过滤 / 元数据抽取等非正文任务 */
const LITE_MODEL_NAME = 'gemini-3.1-flash-lite-preview';

/** 正文翻译实际使用的模型 */
const PRIMARY_MODEL_NAME = FLASH_MODEL_NAME;

/** TXT 结构识别主模型：固定为 Lite */
const TXT_STRUCTURE_MODEL_PRIMARY = LITE_MODEL_NAME;

/** TXT 结构识别回退模型：仍固定为 Lite，确保非正文任务绝不消耗 Flash */
const TXT_STRUCTURE_MODEL_FALLBACK = LITE_MODEL_NAME;

/** EPUB 宏观 / 微观过滤使用的模型列表：仅 Lite */
const NON_BODY_AI_MODELS = [LITE_MODEL_NAME];

/** 元数据抽取使用的模型：仅 Lite */
const METADATA_EXTRACT_MODEL_NAME = LITE_MODEL_NAME;

// ---------- 输出配置 ----------

/** 是否在全部处理完成后自动关机；true=关机，false=不关机 */
const AUTO_SHUTDOWN = false;

/** 主要输出格式；txt=主输出 TXT，epub 会在 EPUB 输入场景下额外生成 */
const OUTPUT_FORMAT = 'txt';

// ---------- 调试 / 日志开关 ----------

/** 是否打印每次请求最终使用哪个 project/key */
const LOG_KEY_USAGE = true;

/** 是否打印分块统计信息（总数/平均/最大/最小） */
const LOG_CHUNKING_STATS = true;

/** 是否打印 EPUB 宏观/微观过滤的详细判定过程 */
const LOG_FILTER_DETAILS = true;

/** 是否打印动态输出熔断阈值 */
const LOG_DYNAMIC_OUTPUT_FUSE = true;

/** 是否打印 API 瞬时错误自动重试日志 */
const LOG_API_RETRY = true;

/** 是否打印项目级调度器等待 / 跳过 / 配额日志 */
const LOG_PROJECT_SCHEDULER = true;

// ---------- 功能开关 ----------

/** 启动时是否扫描旧坏块并自动标记为 BAD_BLOCK 以便重翻 */
const ENABLE_STARTUP_BAD_BLOCK_SWEEP = true;

/** 是否固化 source_chunks，支持断点恢复与稳定重跑 */
const ENABLE_SOURCE_CHUNK_LOCK = true;

/** TXT 命中目录时，是否额外保存“原始目录快照” */
const SAVE_TXT_RAW_CATALOG = true;

/** 是否输出 structure_manifest.json 结构清单 */
const ENABLE_STRUCTURE_MANIFEST = true;

/** EPUB 是否启用宏观结构过滤（封面/版权页/目录/后记等） */
const ENABLE_EPUB_MACRO_FILTER = true;

/** EPUB 是否启用微观内容过滤（扫描说明/版权废话/站点来源等） */
const ENABLE_EPUB_MICRO_FILTER = false;

/** 启动时坏块扫描，是否启用“大块熔断”检测 */
const ENABLE_LARGE_BLOCK_FILTER = true;

/**
 * 导出前元数据定稿阶段：
 * true  = 允许用 1 次 Gemini 3.1 Flash Lite Preview（temperature=0）从“已译中文样本”抽取作者等信息
 * false = 完全不走这一步 AI，只用 本地字段 / map / 规则抽取
 */
const ENABLE_METADATA_GEMINI_LITE_FALLBACK = true;

/**
 * 是否允许 Gemini 3.1 Flash Lite Preview 参与“原文书名锚点确认”和“首个已译正文前部中文书名抽取”
 * true  = 正则失败时允许 AI 参与标题锚点确认 / 中文书名抽取
 * false = 完全只用规则，不调用 AI 参与书名命名
 */
const ENABLE_TITLE_ANCHOR_AI_ASSIST = true;

// ---------- 分块配置 ----------

/** 传统目标分块大小：仅供部分日志 / 对照使用；真正执行走 Chapter-Aware Balanced Chunking v2 */
const TARGET_CHUNK_SIZE = 31000;

/** 单个 chunk 的绝对硬上限：任何一个分块都不能超过这个值 */
const HARD_CHUNK_LIMIT = 32500;	

/** 每个正文分块翻译完成后的等待时间（毫秒），避免连续打太快 */
const CHUNK_DELAY_MS = 1000;

// ---------- 动态输出熔断 ----------

/** 输出熔断的基础阈值：小块至少按这个值防爆 */
const OUTPUT_FUSE_BASE = 30000;

/** 输出熔断的绝对最大阈值：即使原文很长，也不允许超过这个上限 */
const OUTPUT_FUSE_MAX = 36000;

/** 输出熔断比例：按 sourceLength * 1.08 给译文一点合理浮动空间 */
const OUTPUT_FUSE_RATIO = 1.08;

/** 输出熔断附加补偿：在比例阈值之外再增加的安全余量 */
const OUTPUT_FUSE_PADDING = 1200;

// ---------- API 瞬时错误重试 ----------

/**
 * 是否对 Gemini API 的瞬时错误做“同块重试”：
 * true  = 先保持原 chunk 不分段，自动重试
 * false = 一旦 API 报错，直接进入旧的失败分段策略
 */
const ENABLE_API_TRANSIENT_RETRY = true;

/** 单次 API 请求的最大尝试次数（包含首次） */
const API_TRANSIENT_MAX_ATTEMPTS = 4;

/** 重试退避的基础延迟（毫秒） */
const API_TRANSIENT_BASE_DELAY_MS = 2500;

/** 重试退避的最大延迟（毫秒） */
const API_TRANSIENT_MAX_DELAY_MS = 12000;

/** 重试附加随机抖动（毫秒），减少同时撞线 */
const API_TRANSIENT_JITTER_MS = 900;

// ---------- api0.txt 持久化 Key 计数 ----------
/**
 * 不再使用 60s / today / Pacific midnight 的软限调度。
 * 现在只统计 gemini-3-flash-preview 的成功调用次数：
 * - 每 key 每周期 25 次
 * - 北京时间 16:00 后第一次调用时整池清零
 * - 某 key 达到 25/25 后跳过
 * - 全部 key 达到 25/25 后停止任务
 */

// ---------- 元数据 / 导出定稿 ----------

/** 外置中文元数据映射表路径；用于手工指定中译名 / 中文作者 */
const BOOK_METADATA_ZH_MAP_PATH = path.join(__dirname, 'book_metadata_zh_map.json');

/** 元数据抽取的 temperature，固定为 0，禁止发散 */
const METADATA_EXTRACT_TEMPERATURE = 0;

/** 从已译中文样本中截取用于元数据抽取的最大字符数 */
const TRANSLATED_METADATA_SAMPLE_MAX_CHARS = 12000;

/** 若元数据来源只有 AI 抽取，是否默认隐藏“元数据锚定源”这一行 */
const HIDE_AI_ONLY_METADATA_SOURCE_BY_DEFAULT = true;

// ---------- Chapter-Aware Balanced Chunking v2 ----------

/** 切点尽量避开章节开头前几句 / 后几句；这里表示 2 句 */
const CHAPTER_EDGE_AVOID_SENTENCE_COUNT = 2;

/** DP 搜索切点时，在理想切点附近向左右最多查看多少个句子边界 */
const CHUNKING_DP_CANDIDATE_RADIUS = 120;

/** DP 每一步最多保留多少个候选切点 */
const CHUNKING_DP_MAX_CANDIDATES_PER_STEP = 36;

/** 当理论最少分段数 N 失败时，最多继续尝试到 N + 12 */
const CHUNKING_MAX_EXTRA_CHUNKS_BEYOND_THEORETICAL_MIN = 12;

// ==========================================
// api0.txt 持久化 Key 池
// ==========================================

/** 简单 sleep */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 北京时间辅助：固定按 UTC+8 计算，避免本地时区干扰 */
function getBeijingShiftedDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000);
}

function formatBeijingDateTime(date = new Date()) {
  const d = getBeijingShiftedDate(date);
  return (
    d.getUTCFullYear() +
    '-' +
    pad2(d.getUTCMonth() + 1) +
    '-' +
    pad2(d.getUTCDate()) +
    ' ' +
    pad2(d.getUTCHours()) +
    ':' +
    pad2(d.getUTCMinutes()) +
    ':' +
    pad2(d.getUTCSeconds())
  );
}

/**
 * 配额周期 key：
 * - 每天北京时间 16:00 切换新周期
 * - 16:00 前仍算前一天周期
 */
function getBeijingQuotaCycleKey(date = new Date()) {
  const d = getBeijingShiftedDate(date);
  if (d.getUTCHours() < 16) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function parseApiRecordSection(recordSectionText = '', keys = []) {
  const state = {
    quotaCycleKey: '',
    lastSuccessTimeBjt: '',
    keySuccessCounts: {},
  };

  for (const key of keys) {
    state.keySuccessCounts[key] = 0;
  }

  for (const rawLine of String(recordSectionText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let m = line.match(/^quota_cycle_bjt\s*=\s*(.+)$/i);
    if (m) {
      state.quotaCycleKey = m[1].trim();
      continue;
    }

    m = line.match(/^last_success_time_bjt\s*=\s*(.*)$/i);
    if (m) {
      state.lastSuccessTimeBjt = m[1].trim();
      continue;
    }

    m = line.match(/^(AIza[0-9A-Za-z\-_]{20,})\s*\|\s*(\d+)\s*\/\s*(\d+)\s*$/);
    if (m) {
      const key = m[1];
      const count = Number(m[2]) || 0;
      state.keySuccessCounts[key] = count;
    }
  }

  for (const key of keys) {
    if (!Number.isFinite(state.keySuccessCounts[key])) {
      state.keySuccessCounts[key] = 0;
    }
  }

  return state;
}

function buildApiRecordSection(args = {}) {
  const quotaCycleKey = args.quotaCycleKey || '';
  const lastSuccessTimeBjt = args.lastSuccessTimeBjt || '';
  const keySuccessCounts = args.keySuccessCounts || {};
  const keys = args.keys || [];

  const lines = [
    'quota_cycle_bjt=' + quotaCycleKey,
    'last_success_time_bjt=' + lastSuccessTimeBjt,
    'max_per_key=' + FLASH_DAILY_MAX_PER_KEY,
  ];

  for (const key of keys) {
    const count = Number(keySuccessCounts[key]) || 0;
    lines.push(key + ' | ' + count + '/' + FLASH_DAILY_MAX_PER_KEY);
  }

  return lines.join('\n');
}

function readApiKeyPoolStateFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      keySectionText: '',
      keys: [],
      quotaCycleKey: '',
      lastSuccessTimeBjt: '',
      keySuccessCounts: {},
    };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parts = splitApiKeyFile(raw);
  const keys = extractApiKeysFromKeySection(parts.keySectionText);
  const parsed = parseApiRecordSection(parts.recordSectionText, keys);

  return {
    filePath,
    keySectionText: parts.keySectionText,
    keys,
    quotaCycleKey: parsed.quotaCycleKey,
    lastSuccessTimeBjt: parsed.lastSuccessTimeBjt,
    keySuccessCounts: parsed.keySuccessCounts,
  };
}

function writeApiKeyPoolStateToFile(poolState) {
  const keyPart = String(poolState.keySectionText || '').trimEnd();
  const recordPart = buildApiRecordSection({
    quotaCycleKey: poolState.quotaCycleKey,
    lastSuccessTimeBjt: poolState.lastSuccessTimeBjt,
    keySuccessCounts: poolState.keySuccessCounts,
    keys: poolState.keys,
  });

  const finalText = keyPart + '\n' + API_RECORD_SEPARATOR + '\n' + recordPart + '\n';
  fs.writeFileSync(poolState.filePath, finalText, 'utf-8');
}

function createAllFlashKeysDailyLimitReachedError(message) {
  const err = new Error(
    message ||
      ('所有 ' +
        FLASH_MODEL_NAME +
        ' Key 都已达到 ' +
        FLASH_DAILY_MAX_PER_KEY +
        '/' +
        FLASH_DAILY_MAX_PER_KEY +
        '，停止任务。')
  );
  err.code = FLASH_STOP_TASK_ERROR_CODE;
  return err;
}

function isAllFlashKeysDailyLimitReachedError(error) {
  return error && error.code === FLASH_STOP_TASK_ERROR_CODE;
}

const API_KEY_POOL_STATE = readApiKeyPoolStateFromFile(API_KEY_FILE_PATH);

/** 启动时如果还没有记录区，就自动补上 */
(function ensureApiKeyRecordSectionExists() {
  const nowCycleKey = getBeijingQuotaCycleKey(new Date());
  let changed = false;

  if (!API_KEY_POOL_STATE.quotaCycleKey) {
    API_KEY_POOL_STATE.quotaCycleKey = nowCycleKey;
    changed = true;
  }

  for (const key of API_KEYS) {
    if (!Number.isFinite(API_KEY_POOL_STATE.keySuccessCounts[key])) {
      API_KEY_POOL_STATE.keySuccessCounts[key] = 0;
      changed = true;
    }
  }

  const raw = fs.existsSync(API_KEY_FILE_PATH) ? fs.readFileSync(API_KEY_FILE_PATH, 'utf-8') : '';
  const parts = splitApiKeyFile(raw);

  if (changed || !parts.recordSectionText) {
    writeApiKeyPoolStateToFile(API_KEY_POOL_STATE);
  }
})();

/** 北京时间 16:00 后第一次调用时，整池清零 */
function resetFlashCountsIfNeeded(now = new Date()) {
  const currentCycleKey = getBeijingQuotaCycleKey(now);
  if (API_KEY_POOL_STATE.quotaCycleKey === currentCycleKey) return false;

  API_KEY_POOL_STATE.quotaCycleKey = currentCycleKey;
  API_KEY_POOL_STATE.lastSuccessTimeBjt = '';

  for (const key of API_KEYS) {
    API_KEY_POOL_STATE.keySuccessCounts[key] = 0;
  }

  writeApiKeyPoolStateToFile(API_KEY_POOL_STATE);

  if (LOG_PROJECT_SCHEDULER) {
    console.log(
      '🔄 [Key Reset] 北京时间 16:00 配额周期已切换，所有 ' +
        FLASH_MODEL_NAME +
        ' key 计数已清零。当前周期: ' +
        currentCycleKey
    );
  }
  return true;
}

function getFlashSuccessCount(key) {
  return Number(API_KEY_POOL_STATE.keySuccessCounts[key]) || 0;
}

function getEligibleKeyStatesSorted() {
  resetFlashCountsIfNeeded(new Date());

  return API_KEYS
    .map((key, index) => ({
      key,
      index,
      successCount: getFlashSuccessCount(key),
    }))
    .filter((item) => item.successCount < FLASH_DAILY_MAX_PER_KEY)
    .sort((a, b) => {
      if (a.successCount !== b.successCount) return a.successCount - b.successCount;
      return a.index - b.index;
    });
}

function acquireKeyForRequest(modelName, excludedKeys = new Set()) {
  resetFlashCountsIfNeeded(new Date());

  const allEligible = getEligibleKeyStatesSorted();
  const candidates = allEligible.filter((item) => !excludedKeys.has(item.key));

  if (candidates.length === 0) {
    if (allEligible.length === 0) {
      throw createAllFlashKeysDailyLimitReachedError();
    }
    return null;
  }

  const chosen = candidates[0];

  if (LOG_KEY_USAGE) {
    if (modelName === FLASH_MODEL_NAME) {
      console.log(
        ' [Key Request] 本次使用 Key ' +
          (chosen.index + 1) +
          '/' +
          API_KEYS.length +
          ' | ' +
          modelName +
          ' | ' +
          chosen.successCount +
          '/' +
          FLASH_DAILY_MAX_PER_KEY
      );
    } else {
      console.log(
        ' [Key Request] 本次使用 Key ' +
          (chosen.index + 1) +
          '/' +
          API_KEYS.length +
          ' | ' +
          modelName +
          ' | ' +
          chosen.successCount +
          '/' +
          FLASH_DAILY_MAX_PER_KEY +
          ' | 不计入 ' +
          FLASH_MODEL_NAME +
          ' 成功次数'
      );
    }
  }

  return chosen;
}

function recordFlashSuccess(key) {
  resetFlashCountsIfNeeded(new Date());

  API_KEY_POOL_STATE.keySuccessCounts[key] = getFlashSuccessCount(key) + 1;
  API_KEY_POOL_STATE.lastSuccessTimeBjt = formatBeijingDateTime(new Date());
  writeApiKeyPoolStateToFile(API_KEY_POOL_STATE);

  return {
    count: API_KEY_POOL_STATE.keySuccessCounts[key],
    lastSuccessTimeBjt: API_KEY_POOL_STATE.lastSuccessTimeBjt,
  };
}

// ==========================================
// Gemini API 基础定义
// ==========================================

/** Gemini Safety Category 常量表 */
const HarmCategory = {
  HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
  HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
  HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
};

/** Safety Block 常量：全部不拦截 */
const HarmBlockThreshold = {
  BLOCK_NONE: 'BLOCK_NONE',
};

/** 构造安全设置：当前全部放开，由提示词和后处理控制 */
function buildSafetySettings() {
  return [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
  ];
}

/** 构造 generationConfig：默认 temperature=0，可被覆盖 */
function buildGenerationConfig(extra = {}) {
  return { temperature: 0, ...extra };
}

/** 规范化一个 part */
function normalizePart(part) {
  if (typeof part === 'string') return { text: part };
  if (part && typeof part.text === 'string') return { text: part.text };
  return { text: '' };
}

/** 规范化一个 content 消息 */
function normalizeContent(content) {
  if (!content) return null;
  if (typeof content === 'string') return { role: 'user', parts: [{ text: content }] };

  const role = content.role || 'user';
  const parts = Array.isArray(content.parts)
    ? content.parts.map(normalizePart)
    : [{ text: typeof content.text === 'string' ? content.text : '' }];

  return { role, parts };
}

/** 安全 JSON parse */
function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 去除 ```json 代码围栏 */
function stripJsonFences(text = '') {
  return String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/** 从 Gemini 返回中抽取纯文本 */
function extractResponseText(rawResponse) {
  if (!rawResponse) return '';
  if (Array.isArray(rawResponse.candidates)) {
    return rawResponse.candidates
      .map((candidate) => {
        const parts = candidate?.content?.parts || [];
        return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
      })
      .join('\n')
      .trim();
  }
  return '';
}

/** 解析 Gemini API 错误信息 */
function parseGeminiApiError(error) {
  const raw = error?.message || String(error || '');

  try {
    const json = JSON.parse(raw);
    const e = json?.error || {};
    return {
      code: Number.isFinite(Number(e.code)) ? Number(e.code) : null,
      status: typeof e.status === 'string' ? e.status : '',
      message: typeof e.message === 'string' ? e.message : raw,
      raw,
    };
  } catch {}

  const codeMatch = raw.match(/"code"\s*:\s*(\d+)/);
  const statusMatch = raw.match(/"status"\s*:\s*"([^"]+)"/);
  const msgMatch = raw.match(/"message"\s*:\s*"([^"]+)"/);

  return {
    code: codeMatch ? Number(codeMatch[1]) : null,
    status: statusMatch ? statusMatch[1] : '',
    message: msgMatch ? msgMatch[1] : raw,
    raw,
  };
}

/** 判断是否属于可重试的 Gemini 瞬时错误 */
function isRetryableGeminiError(error) {
  const info = parseGeminiApiError(error);
  if ([429, 500, 503, 504].includes(info.code)) return true;
  if (['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED'].includes(info.status))
    return true;
  return false;
}

/** 计算 API 重试退避时长 */
function computeApiRetryDelayMs(attemptNo) {
  const expDelay = Math.min(
    API_TRANSIENT_MAX_DELAY_MS,
    API_TRANSIENT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attemptNo - 1)),
  );
  const jitter = Math.floor(Math.random() * API_TRANSIENT_JITTER_MS);
  return expDelay + jitter;
}

/** 单次向 Gemini 发请求（指定 key） */
async function performGeminiRequestOnce(modelName, body, keyInfo = null) {
  const chosen = keyInfo || acquireKeyForRequest(modelName);
  const key = chosen.key;

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(modelName) +
    ':generateContent?key=' +
    encodeURIComponent(key);

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  const json = rawText ? safeJsonParse(rawText, null) : {};

  if (!response.ok) {
    throw new Error(json ? JSON.stringify(json) : rawText || ('HTTP ' + response.status));
  }

  return json || {};
}

/**
 * 非正文模型：
 * - 不增加 25/25 成功计数
 * - 重试时切换到下一个“当前成功次数最少”的 key
 */
async function callGeminiGenerateContentNonFlash(modelName, body) {
  const maxAttempts = ENABLE_API_TRANSIENT_RETRY ? API_TRANSIENT_MAX_ATTEMPTS : 1;
  let lastError = null;
  const triedKeys = new Set();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let keyInfo = acquireKeyForRequest(modelName, triedKeys);

    if (!keyInfo) {
      triedKeys.clear();
      keyInfo = acquireKeyForRequest(modelName, triedKeys);
      if (!keyInfo) {
        throw createAllFlashKeysDailyLimitReachedError();
      }
    }

    triedKeys.add(keyInfo.key);

    try {
      return await performGeminiRequestOnce(modelName, body, keyInfo);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableGeminiError(error);
      const canRetry = retryable && attempt < maxAttempts;
      if (!canRetry) throw error;

      const info = parseGeminiApiError(error);
      const delayMs = computeApiRetryDelayMs(attempt);

      if (LOG_API_RETRY) {
        console.warn(
          '⚠️ [API Retry] ' +
            modelName +
            ' 第 ' +
            attempt +
            '/' +
            maxAttempts +
            ' 次请求失败；' +
            delayMs +
            'ms 后重试。'
        );
        console.warn(
          '↳ code=' +
            (info.code || 'NA') +
            ' status=' +
            (info.status || 'NA') +
            ' message=' +
            info.message
        );
      }

      await sleep(delayMs);
    }
  }

  throw lastError || new Error('Unknown Gemini API failure');
}

/**
 * 正文 Flash 模型：
 * - 只统计 gemini-3-flash-preview 的成功调用
 * - 429/500/503/504/RESOURCE_EXHAUSTED/UNAVAILABLE 等错误，不因为第 4 次就分段
 * - 当前 key 瞬时失败后，立刻换下一个 key 继续试
 * - 一轮 key 都瞬时失败后，等一会再开下一轮
 * - 所有 key 都 25/25 时，停止任务
 */
async function callGeminiGenerateContentFlash(body) {
  let roundNo = 0;
  let lastError = null;

  while (true) {
    resetFlashCountsIfNeeded(new Date());

    const candidates = getEligibleKeyStatesSorted();
    if (candidates.length === 0) {
      throw createAllFlashKeysDailyLimitReachedError();
    }

    roundNo += 1;
    let hadRetryableErrorInThisRound = false;

    for (const candidate of candidates) {
      try {
        const result = await performGeminiRequestOnce(FLASH_MODEL_NAME, body, candidate);
        const successInfo = recordFlashSuccess(candidate.key);

        if (LOG_KEY_USAGE) {
          console.log(
            ' ✅[Key 成功] Key ' +
              (candidate.index + 1) +
              '/' +
              API_KEYS.length +
              ' | ' +
              FLASH_MODEL_NAME +
              ' | ' +
              successInfo.count +
              '/' +
              FLASH_DAILY_MAX_PER_KEY +
              ' | 最后成功=' +
              successInfo.lastSuccessTimeBjt
          );
        }

        return result;
      } catch (error) {
        lastError = error;

        if (isAllFlashKeysDailyLimitReachedError(error)) {
          throw error;
        }

        if (!isRetryableGeminiError(error)) {
          throw error;
        }

        hadRetryableErrorInThisRound = true;
        const info = parseGeminiApiError(error);

        if (LOG_API_RETRY) {
          console.warn(
            '⚠️ [API Retry] ' +
              FLASH_MODEL_NAME +
              ' 在 Key ' +
              (candidate.index + 1) +
              '/' +
              API_KEYS.length +
              ' 上失败，属于可重试错误；立即切换下一个 key 继续，不分段。'
          );
          console.warn(
            '↳ code=' +
              (info.code || 'NA') +
              ' status=' +
              (info.status || 'NA') +
              ' message=' +
              info.message
          );
        }
      }
    }

    if (!hadRetryableErrorInThisRound) {
      throw lastError || new Error('Unknown flash request failure');
    }

    const waitMs = computeApiRetryDelayMs(roundNo);
    if (LOG_API_RETRY) {
      console.warn(
        '⏳ [API Retry] ' +
          FLASH_MODEL_NAME +
          ' 本轮所有未满额 key 都返回可重试错误；' +
          waitMs +
          'ms 后开始下一轮，继续换 key，不分段。'
      );
    }
    await sleep(waitMs);
  }
}

/** 统一 Gemini 调用入口 */
async function callGeminiGenerateContent(modelName, contents, options = {}) {
  const generationConfig = options.generationConfig || {};
  const systemInstruction = options.systemInstruction || null;

  const body = {
    contents: contents.map(normalizeContent).filter(Boolean),
    generationConfig: buildGenerationConfig(generationConfig),
    safetySettings: buildSafetySettings(),
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  if (modelName === FLASH_MODEL_NAME) {
    return await callGeminiGenerateContentFlash(body);
  }

  return await callGeminiGenerateContentNonFlash(modelName, body);
}

/** 正文翻译系统提示词 */
const BASE_SYSTEM_INSTRUCTION = `
你是一位拥有二十年经验的资深中文文学翻译家，曾为国内一线出版社（如人民文学出版社、译林出版社、上海译文出版社）翻译过多部畅销外文小说。你的翻译作品以"信、达、雅"著称，深受中国读者喜爱。

## 你的翻译原则

### 忠实与自然
- 准确传达原文的语义、语气、情感和节奏，不遗漏、不增添原文没有的信息
- 翻译必须读起来像一位中国作家直接用中文写的小说，而非翻译腔
- 避免欧化长句，将英文的复杂从句拆分为符合中文阅读习惯的短句
- 人物对话要符合角色身份、年龄、性格，口语化且鲜活

### 词汇与表达
- 优先使用当代中国读者熟悉的日常用语，避免生僻词和过度文雅的书面语
- 严禁堆砌四字成语（如"跌宕起伏""引人入胜""毋庸置疑"），偶尔自然使用即可
- 禁止使用以下AI高频词汇和句式：
  · "值得注意的是""不可否认""毫无疑问""事实上""总而言之""综上所述"
  · "令人叹为观止""恰如其分""应运而生""如火如荼""与此同时"
  · "不仅……而且……""无论……都……"等过度工整的关联词组合
  · "这不禁让人……""这无疑是……"等评论式插入语
- 形容词和副词要克制，不过度渲染情绪
- 比喻和修辞保留原文的意象，必要时转化为中国读者能理解的等效表达

### 句式与结构
- 句子长度参差错落，长短句自然交替，营造阅读节奏
- 段落之间过渡自然，不使用"首先""其次""最后"等机械连接词
- 保持原文的段落划分，不自行合并或拆分段落
- 叙述视角、时态与原文保持一致

### 对话处理
- 对话使用中文双引号""
- 根据角色特点赋予不同的说话风格和用词习惯
- 语气词（"嗯""啊""呢""吧""嘛"）适当使用，不过度

### 专有名词
- 人名：首次出现时保留原文并给出中文译名，格式为"中文译名（原文名）"；之后统一使用中文译名
- 地名：有通行译名的用通行译名，无通行译名的音译并首次标注原文
- 品牌、书名、歌曲名等：有官方中文名的用官方名，没有的保留原文

### 格式要求
- 仅输出译文，不输出任何解释、注释、译者按语或元评论
- 不要在译文前后添加任何说明性文字
- 保留原文的章节标题格式
```

---

## 三、Node.js 代码实现

注意：旧的 `@google-cloud/vertexai` 中的 VertexAI 类及其所有依赖项已于 2025 年 6 月 24 日被弃用，请使用 Google Gen AI SDK 来访问 Gemini 功能。

推荐使用新版 `@google/genai` SDK：

```javascript
import { GoogleGenAI } from '@google/genai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ============ 系统提示词 ============
const SYSTEM_INSTRUCTION = `你是一位拥有二十年经验的资深中文文学翻译家，曾为国内一线出版社（如人民文学出版社、译林出版社、上海译文出版社）翻译过多部畅销外文小说。你的翻译作品以"信、达、雅"著称，深受中国读者喜爱。

## 你的翻译原则

1. 将文本中所有中文以外的外文内容翻译成自然、通顺的中文；原本就是中文的部分保持不变。
2. 保留原文结构、段落、换行、空行、编号、缩进和列表顺序。
3. 如果输入包含代码，请保持代码语法完全可用，只翻译注释、提示文案、字符串中的自然语言，不改变量名与语法结构。
4. 输出必须是纯文本结果，不要添加解释、标题、Markdown 包裹或额外注释。
5. 对小说片段可适度润色语气，但不能改变剧情信息、人物关系、数字与专有名词。

### 忠实与自然
- 准确传达原文的语义、语气、情感和节奏，不遗漏、不增添原文没有的信息
- 翻译必须读起来像一位中国作家直接用中文写的小说，而非翻译腔
- 避免欧化长句，将英文的复杂从句拆分为符合中文阅读习惯的短句
- 人物对话要符合角色身份、年龄、性格，口语化且鲜活

### 词汇与表达
- 优先使用当代中国读者熟悉的日常用语，避免生僻词和过度文雅的书面语
- 严禁堆砌四字成语，偶尔自然使用即可
- 禁止使用以下AI高频词汇和句式：
  · "值得注意的是""不可否认""毫无疑问""事实上""总而言之""综上所述"
  · "令人叹为观止""恰如其分""应运而生""如火如荼""与此同时"
  · "不仅……而且……""无论……都……"等过度工整的关联词组合
  · "这不禁让人……""这无疑是……"等评论式插入语
  · "“此外”、“然而”、“值得注意的是”、“不可否认”等生硬的书面语
  ·“以此以此”、“等等等等”、“非常非常”、“某种”等明显啰嗦重复的词语
- 形容词和副词要克制，不过度渲染情绪
- 比喻和修辞保留原文的意象，必要时转化为中国读者能理解的等效表达

### 句式与结构
- 句子长度参差错落，长短句自然交替，营造阅读节奏
- 段落之间过渡自然，不使用"首先""其次""最后"等机械连接词
- 保持原文的段落划分，不自行合并或拆分段落
- 叙述视角、时态与原文保持一致

### 对话处理
- 对话使用中文双引号""
- 根据角色特点赋予不同的说话风格和用词习惯
- 语气词适当使用，不过度

### 专有名词
- 人名：首次出现时格式为"中文译名（原文名）"；之后统一使用中文译名
- 地名：有通行译名的用通行译名，无通行译名的音译并首次标注原文
- 品牌、书名、歌曲名等：有官方中文名的用官方名，没有的保留原文

### 格式要求
- 仅输出译文，不输出任何解释、注释、译者按语或元评论
- 不要在译文前后添加任何说明性文字
- 保留原文的章节标题格式
`;

// ==========================================
// 通用文本工具
// ==========================================

/** 基础 HTML 实体解码 */
function decodeBasicHtmlEntities(text = '') {
  return String(text || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (all, hex) => {
      const code = Number.parseInt(hex, 16);
      if (!Number.isFinite(code)) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    })
    .replace(/&#(\d+);/g, (all, num) => {
      const code = Number.parseInt(num, 10);
      if (!Number.isFinite(code)) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/"/gi, '"')
    .replace(/'|&apos;/gi, "'");
}

/** 正则转义 */
function escapeRegExp(text = '') {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 松散行归一化：清空格、归一连接号、解实体 */
function normalizeLooseLine(text = '') {
  return decodeBasicHtmlEntities(String(text || ''))
    .replace(/\u00A0/g, ' ')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 文本对比 key：忽略大小写、引号、标点差异 */
function normalizeCompareKey(text = '') {
  return normalizeLooseLine(text)
    .toLowerCase()
    .replace(/[“”"'‘’`]/g, '')
    .replace(/[.,:;!?()[\]{}<>《》〈〉〖〗「」『』、，。！？：；—\-_/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 标题核心载荷归一化 */
function normalizeTitlePayload(text = '') {
  return decodeBasicHtmlEntities(text || '')
    .replace(/^#+\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/^chapter\s*[0-9ivxlcdm]+\s*[:：.\-]?\s*/i, '')
    .replace(
      /^(?:第\s*)?[0-9零〇一二两三四五六七八九十百千IVXLCDMivxlcdm]+\s*(?:章|回|节|集|卷|部|篇)\s*[:：.\-]?\s*/u,
      '',
    )
    .replace(/^[：:、.\-—\s]+/, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 去掉目录行末尾的页码痕迹 */
function stripTrailingCatalogPageNo(line = '') {
  return String(line || '')
    .replace(/\s*[.．·•\-—_]{2,}\s*\d+\s*$/, '')
    .replace(/\s+\d+\s*$/, '')
    .trim();
}

/** 边界行归一化 */
function normalizeBoundaryLine(line = '') {
  return String(line || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[‐‑–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 正文 whitespace 归一化 */
function normalizeTxtBodyWhitespace(text = '') {
  return decodeBasicHtmlEntities(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 是否含中文 */
function hasChinese(text = '') {
  return /[\u3400-\u9FFF]/u.test(String(text || ''));
}

/** 去掉文件扩展名 */
function stripFileExt(fileName = '') {
  return String(fileName || '').replace(/\.[^.]+$/, '');
}

/** 清洗导出文件名中的非法字符 */
function sanitizeExportName(text = '') {
  return normalizeLooseLine(text)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();
}

/** 取第一个非空值 */
function chooseFirstMeaningfulValue(...values) {
  for (const value of values) {
    const normalized = normalizeLooseLine(value || '');
    if (normalized) return normalized;
  }
  return '';
}

/** 取第一个“看起来像中文名”的值 */
function chooseFirstMeaningfulChineseValue(...values) {
  for (const value of values) {
    const normalized = normalizeLooseLine(value || '');
    if (normalized && hasChinese(normalized) && normalized.length >= 2) return normalized;
  }
  return '';
}

/** 判断是否是有效中文名 */
function isMeaningfulChineseName(text = '') {
  const v = normalizeLooseLine(text);
  return !!(v && hasChinese(v) && v.length >= 2);
}

// ==========================================
// 数字 / 编号工具
// ==========================================

/** 罗马数字转整数 */
function romanToInt(input) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const s = String(input || '').toUpperCase().trim();
  if (!s || !/^[IVXLCDM]+$/.test(s)) return null;

  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const current = map[s[i]] || 0;
    const next = map[s[i + 1]] || 0;
    total += current < next ? -current : current;
  }
  return total || null;
}

/** 中文数字转整数 */
function parseChineseNumberToken(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  const digitMap = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (/^[零〇一二两三四五六七八九]+$/u.test(text)) {
    return Number([...text].map((ch) => digitMap[ch]).join(''));
  }

  let total = 0;
  let section = 0;
  let number = 0;

  for (const ch of text) {
    if (digitMap[ch] !== undefined) {
      number = digitMap[ch];
      continue;
    }
    if (ch === '十') {
      section += (number || 1) * 10;
      number = 0;
      continue;
    }
    if (ch === '百') {
      section += (number || 1) * 100;
      number = 0;
      continue;
    }
    if (ch === '千') {
      section += (number || 1) * 1000;
      number = 0;
      continue;
    }
    return null;
  }

  total += section + number;
  return total || null;
}

/** 英文数字词转整数 */
function parseEnglishNumberToken(input) {
  const normalized = String(input || '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

  const units = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
  };

  const tens = {
    twenty: 20,
    thirty: 30,
    forty: 40,
    fourty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  };

  const parts = normalized.split(' ');
  let total = 0;
  let current = 0;
  let used = false;

  for (const part of parts) {
    if (!part) continue;

    if (Object.prototype.hasOwnProperty.call(units, part)) {
      current += units[part];
      used = true;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(tens, part)) {
      current += tens[part];
      used = true;
      continue;
    }

    if (part === 'hundred') {
      current = (current || 1) * 100;
      used = true;
      continue;
    }

    if (part === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
      used = true;
      continue;
    }

    return null;
  }

  total += current;
  return used ? total : null;
}

/** 松散解析章节编号 */
function parseLooseChapterNumber(input) {
  const raw = String(input || '')
    .trim()
    .replace(/^第/u, '')
    .replace(/[章节回集卷部篇]/gu, '')
    .trim();

  if (!raw) return null;
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  if (/^[IVXLCDM]+$/i.test(raw)) return romanToInt(raw);
  if (/^[零〇一二两三四五六七八九十百千]+$/u.test(raw)) return parseChineseNumberToken(raw);
  if (/^[A-Za-z][A-Za-z\s-]{1,30}$/.test(raw)) return parseEnglishNumberToken(raw);

  return null;
}

/** 解析章节编号元信息 */
function parseLooseChapterNumberMeta(rawToken = '') {
  const token = normalizeLooseLine(rawToken)
    .replace(/[()（）[\]〖〗]/g, '')
    .replace(/[：:.\-—、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!token) return { raw: '', value: null, key: '' };

  const direct = parseLooseChapterNumber(token);
  if (direct !== null) return { raw: rawToken, value: direct, key: `n:${direct}` };

  const roman = romanToInt(token);
  if (roman) return { raw: rawToken, value: roman, key: `n:${roman}` };

  const zh = parseChineseNumberToken(token);
  if (zh) return { raw: rawToken, value: zh, key: `n:${zh}` };

  const en = parseEnglishNumberToken(token);
  if (en) return { raw: rawToken, value: en, key: `n:${en}` };

  return { raw: rawToken, value: null, key: `raw:${normalizeCompareKey(token)}` };
}

/** 整数转罗马数字 */
function intToRoman(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return '';

  const table = [
    ['M', 1000],
    ['CM', 900],
    ['D', 500],
    ['CD', 400],
    ['C', 100],
    ['XC', 90],
    ['L', 50],
    ['XL', 40],
    ['X', 10],
    ['IX', 9],
    ['V', 5],
    ['IV', 4],
    ['I', 1],
  ];

  let rest = n;
  let out = '';
  for (const [sym, val] of table) {
    while (rest >= val) {
      out += sym;
      rest -= val;
    }
  }
  return out;
}

/** 整数转中文数字（简单版，用于章节名） */
function intToChinese(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return '';

  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  if (n < 10) return digits[n];
  if (n < 20) return n === 10 ? '十' : `十${digits[n - 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ''}`;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    if (!rest) return `${digits[hundreds]}百`;
    if (rest < 10) return `${digits[hundreds]}百零${digits[rest]}`;
    return `${digits[hundreds]}百${intToChinese(rest)}`;
  }

  return String(n);
}

// ==========================================
// 标题工具
// ==========================================

/** 解析一行是否像章节标题，并提取编号/标题 */
function parseChapterHeadingMeta(line = '') {
  const rawLine = normalizeLooseLine(line);
  if (!rawLine) return null;

  const cleaned = stripTrailingCatalogPageNo(rawLine);
  let m = null;

  m = cleaned.match(
    /^第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*([章节卷部回篇集])\s*(?:[：:.\-—、]\s*)?(.*)$/u,
  );
  if (m) {
    const num = parseLooseChapterNumberMeta(m[1]);
    return {
      rawLine: cleaned,
      numberText: `第${m[1]}${m[2]}`,
      numberKey: num.key,
      numberValue: num.value,
      title: normalizeLooseLine(m[3] || ''),
    };
  }

  m = cleaned.match(/^(?:chapter|chap\.?)\s+([0-9ivxlcdm]+|[a-z][a-z\s-]{0,30})\s*(?:[：:.\-—、]\s*)?(.*)$/i);
  if (m) {
    const num = parseLooseChapterNumberMeta(m[1]);
    if (num.value !== null) {
      return {
        rawLine: cleaned,
        numberText: `Chapter ${normalizeLooseLine(m[1])}`,
        numberKey: num.key,
        numberValue: num.value,
        title: normalizeLooseLine(m[2] || ''),
      };
    }
  }

  m = cleaned.match(/^([0-9ivxlcdm]+|[a-z][a-z\s-]{0,30})\s*[：:.\-—、]\s*(.+)$/i);
  if (m) {
    const num = parseLooseChapterNumberMeta(m[1]);
    if (num.value !== null) {
      return {
        rawLine: cleaned,
        numberText: normalizeLooseLine(m[1]),
        numberKey: num.key,
        numberValue: num.value,
        title: normalizeLooseLine(m[2] || ''),
      };
    }
  }

  if (cleaned.length <= 24) {
    m = cleaned.match(/^([0-9ivxlcdm]+|[a-z][a-z\s-]{0,30})$/i);
    if (m) {
      const num = parseLooseChapterNumberMeta(m[1]);
      if (num.value !== null) {
        return {
          rawLine: cleaned,
          numberText: normalizeLooseLine(m[1]),
          numberKey: num.key,
          numberValue: num.value,
          title: '',
        };
      }
    }
  }

  return null;
}

/** 仅移除章节编号前缀，保留真正标题 */
function stripChapterPrefixOnly(text = '') {
  return normalizeLooseLine(text)
    .replace(/^chapter\s+[0-9ivxlcdm]+\s*(?:[：:.\-—、]\s*)?/i, '')
    .replace(/^第\s*[零〇一二两三四五六七八九十百千万\d]+\s*[章节卷部回篇集]\s*(?:[：:.\-—、]\s*)?/u, '')
    .replace(/^[0-9ivxlcdm]+\s*(?:[：:.\-—、]\s*)/i, '')
    .trim();
}

/** 判断标题内容是否只是“纯编号”，没有真实标题 */
function isPureNumericLikeRedundantTitleFragment(text = '') {
  const normalized = normalizeLooseLine(text)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248))
    .replace(/^[\s"'“”‘’`~!@#$%^&*_=+|\\/<>\[\]{}()（）〖〗《》「」『』]+/u, '')
    .replace(/[\s"'“”‘’`~!@#$%^&*_=+|\\/<>\[\]{}()（）〖〗《》「」『』]+$/u, '')
    .replace(/[：:.\-—、·•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return false;

  if (/^(?:\d+|[ivxlcdm]+|[零〇一二两三四五六七八九十百千万]+)$/iu.test(normalized)) {
    return true;
  }

  const EN_NUMBER_TOKEN =
    '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|' +
    'eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|' +
    'twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|' +
    'hundred|thousand|' +
    'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|' +
    'eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|' +
    'twentieth|thirtieth|fortieth|fourtieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|' +
    'hundredth|thousandth|and)';

  return new RegExp(`^(?:${EN_NUMBER_TOKEN})(?:[\\s-]+(?:${EN_NUMBER_TOKEN}))*$`, 'i').test(
    normalized,
  );
}

/** 清洗 AI 或规则得到的标题候选 */
function sanitizeTranslatedTitleCandidate(title = '') {
  const normalized = normalizeLooseLine(title);
  const stripped = stripChapterPrefixOnly(normalized);
  if (isPureNumericLikeRedundantTitleFragment(stripped)) return '';
  return stripped;
}

/** 去掉标题前多余重复编号 */
function stripRedundantLeadingChapterNumber(title, expectedIndex) {
  let working = String(title || '').trim();

  const patterns = [
    /^(?:第\s*)?([0-9零〇一二两三四五六七八九十百千IVXLCDMivxlcdm]+)\s*(?:章|回|节|集|卷|部|篇)?\s*[:：、.\-]\s*(.+)$/u,
    /^([0-9零〇一二两三四五六七八九十百千IVXLCDMivxlcdm]{1,8})\s*[:：、.\-]\s*(.+)$/u,
    /^([A-Za-z][A-Za-z\s-]{1,24})\s*[:：、.\-]\s*(.+)$/u,
  ];

  for (const pattern of patterns) {
    const match = working.match(pattern);
    if (!match) continue;

    const num = parseLooseChapterNumber(match[1]);
    const rest = (match[2] || '').trim();
    if (!rest) continue;

    if (num && num <= 300 && Math.abs(num - expectedIndex) <= 3) {
      working = rest;
      break;
    }
  }

  return working.trim();
}

/** 非正文统一标题名 */
const NON_CONTENT_SECTION_TITLE = '非正文';

/** 规范化章节标题：统一生成 “第X章: 标题” */
function normalizeChapterTitleForIndex(rawTitle, expectedIndex) {
  let title = decodeBasicHtmlEntities(rawTitle || '')
    .replace(/^#+\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) return `第${expectedIndex}章`;
  if (title === NON_CONTENT_SECTION_TITLE) return NON_CONTENT_SECTION_TITLE;
  if (/^(contents?|toc)$/i.test(title) || title === '目录') return '目录';

  title = title
    .replace(/^chapter\s*[0-9ivxlcdm]+\s*[:：.\-]?\s*/i, '')
    .replace(
      /^(?:第\s*)?[0-9零〇一二两三四五六七八九十百千IVXLCDMivxlcdm]+\s*(?:章|回|节|集|卷|部|篇)\s*[:：.\-]?\s*/u,
      '',
    )
    .trim();

  title = stripRedundantLeadingChapterNumber(title, expectedIndex);
  title = stripRedundantLeadingChapterNumber(title, expectedIndex);
  title = title.replace(/^[：:、.\-—\s]+/, '').trim();

  return title ? `第${expectedIndex}章: ${title}` : `第${expectedIndex}章`;
}

/** 判断一行是否与章节标题重复 */
function isDuplicateChapterTitleLine(line, title) {
  const a = normalizeTitlePayload(line);
  const b = normalizeTitlePayload(title);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** 构造“去掉标题前缀”的宽松正则 */
function buildFlexibleTitlePrefixRegex(title) {
  const payload = normalizeTitlePayload(title);
  if (!payload) return null;

  const escapedPayload = [...payload].map((ch) => escapeRegExp(ch)).join('\\s*');
  return new RegExp(
    `^(?:#+\\s*)?(?:\\d+\\.\\s*)?(?:(?:第\\s*[0-9零〇一二两三四五六七八九十百千IVXLCDMivxlcdm]+\\s*(?:章|回|节|集|卷|部|篇))|(?:chapter\\s*[0-9ivxlcdm]+))?\\s*[:：、.\\-—]*\\s*${escapedPayload}\\s*[:：、.\\-—]*\\s*`,
    'iu',
  );
}

/** 如果一行前缀里混有标题，尝试剪掉 */
function stripPossibleTitlePrefixFromLine(line, title) {
  const decoded = decodeBasicHtmlEntities(line || '');
  const regex = buildFlexibleTitlePrefixRegex(title);
  if (!regex) return decoded;

  const stripped = decoded.replace(regex, '').trimStart();
  return stripped === decoded ? decoded : stripped;
}

/** 去掉正文最前面重复出现的一整行章节标题 */
function stripLeadingDuplicateTitleLine(body, title) {
  const lines = decodeBasicHtmlEntities(body || '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  let firstNonEmpty = 0;
  while (firstNonEmpty < lines.length && !lines[firstNonEmpty].trim()) firstNonEmpty += 1;
  if (firstNonEmpty >= lines.length) return lines.join('\n').trim();

  if (isDuplicateChapterTitleLine(lines[firstNonEmpty], title)) {
    lines.splice(firstNonEmpty, 1);
  } else {
    const stripped = stripPossibleTitlePrefixFromLine(lines[firstNonEmpty], title);
    if (stripped !== decodeBasicHtmlEntities(lines[firstNonEmpty])) {
      lines[firstNonEmpty] = stripped;
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ==========================================
// EPUB 解析
// ==========================================

/** HTML 转纯文本 */
function htmlToPlainText(html = '') {
  return decodeBasicHtmlEntities(
    String(html || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n\n')
      .replace(/<\/h[1-6]>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 解析 EPUB 结构 */
function parseEpubStructure(filePath) {
  return new Promise((resolve, reject) => {
    const epub = new EPub(filePath);

    epub.on('end', async () => {
      const chapters = [];
      const bookTitle = epub.metadata?.title || 'Unknown';
      const bookAuthor = epub.metadata?.creator || 'Unknown';

      for (const chapterRef of epub.flow || []) {
        await new Promise((r) => {
          epub.getChapter(chapterRef.id, (_err, text) => {
            if (text) {
              const clean = htmlToPlainText(text);
              if (clean.length > 0) {
                chapters.push({
                  id: chapterRef.id,
                  title: chapterRef.title || chapterRef.id,
                  content: clean,
                });
              }
            }
            r();
          });
        });
      }

      resolve({ chapters, title: bookTitle, author: bookAuthor });
    });

    epub.on('error', (err) => reject(err));
    epub.parse();
  });
}

// ==========================================
// Chunk Lock
// ==========================================

/** 保存 source_chunks 固化分块 */
function saveSourceChunks(outputDir, chunks) {
  if (!ENABLE_SOURCE_CHUNK_LOCK) return '';

  const chunkDir = path.join(outputDir, 'source_chunks');
  if (!fs.existsSync(chunkDir)) fs.ensureDirSync(chunkDir);
  fs.emptyDirSync(chunkDir);

  const fingerprint = [];
  console.log(`📦 [Chunk Lock] 正在固化 ${chunks.length} 个分块到 ${chunkDir}...`);

  chunks.forEach((chunk, idx) => {
    const text = typeof chunk === 'string' ? chunk : chunk?.text || chunk?.content || '';
    const fileName = `chunk_${String(idx + 1).padStart(3, '0')}.txt`;
    const filePath = path.join(chunkDir, fileName);
    fs.writeFileSync(filePath, text, 'utf-8');
    fingerprint.push(`${fileName} (${text.length} chars)`);
  });

  return fingerprint.join(', ');
}

/** 读取已经固化的 source_chunks */
function loadSourceChunks(outputDir) {
  if (!ENABLE_SOURCE_CHUNK_LOCK) return null;

  const chunkDir = path.join(outputDir, 'source_chunks');
  if (!fs.existsSync(chunkDir)) return null;

  const files = fs
    .readdirSync(chunkDir)
    .filter((f) => f.startsWith('chunk_') && f.endsWith('.txt'))
    .sort();

  if (files.length === 0) return null;

  console.log(`📦 [Chunk Lock] 检测到已固化分块，直接读取 (共 ${files.length} 个)...`);

  return files.map((f, idx) => {
    const text = fs.readFileSync(path.join(chunkDir, f), 'utf-8');
    return {
      id: `chunk_${String(idx + 1).padStart(3, '0')}`,
      name: `chunk_${String(idx + 1).padStart(3, '0')}`,
      text,
      content: text,
      sourceLength: text.length,
    };
  });
}

// ==========================================
// 书籍身份：provisional + 导出前定稿
// ==========================================

/** 书籍匹配 key 归一化 */
function normalizeIdentityLookupKey(text = '') {
  return normalizeLooseLine(text)
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/[^0-9a-z\u3400-\u9fff]+/gi, '');
}

/** 读取外部 book_metadata_zh_map.json */
function loadBookMetadataZhMap(filePath = BOOK_METADATA_ZH_MAP_PATH) {
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];

    const json = JSON.parse(raw);
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.items)) return json.items;

    return Object.entries(json).map(([key, value]) => ({ __mapKey: key, ...(value || {}) }));
  } catch (err) {
    console.warn(`⚠️ [Metadata Map] 读取失败: ${filePath}`, err?.message || err);
    return [];
  }
}

/** 构造元数据匹配 key 集合 */
function buildMetadataLookupKeys({ originalTitle = '', originalAuthor = '', fileName = '' } = {}) {
  const keys = new Set();
  const add = (v) => {
    const key = normalizeIdentityLookupKey(v);
    if (key) keys.add(key);
  };

  add(originalTitle);
  add(originalAuthor);
  add(fileName);
  add(stripFileExt(fileName));
  add(`${originalTitle} ${originalAuthor}`);
  add(`${stripFileExt(fileName)} ${originalAuthor}`);

  return [...keys];
}

/** 在外部映射表中尝试命中一本书 */
function matchBookMetadataZhMap({
  originalTitle = '',
  originalAuthor = '',
  fileName = '',
  mapItems = [],
} = {}) {
  const lookupKeys = new Set(buildMetadataLookupKeys({ originalTitle, originalAuthor, fileName }));

  for (const item of mapItems) {
    const candidateKeys = buildMetadataLookupKeys({
      originalTitle: item.originalTitle || item.title || item.bookName || '',
      originalAuthor: item.originalAuthor || item.author || '',
      fileName: item.fileName || item.file || item.inputFileName || item.__mapKey || '',
    });

    if (candidateKeys.some((key) => lookupKeys.has(key))) {
      return {
        cnBookName: normalizeLooseLine(item.cnBookName || item.zhBookName || item.bookNameZh || ''),
        cnAuthor: normalizeLooseLine(item.cnAuthor || item.zhAuthor || item.authorZh || ''),
        synopsis: normalizeLooseLine(item.synopsis || item.desc || ''),
        glossary: normalizeLooseLine(item.glossary || '') || '无',
        source: 'book_metadata_zh_map.json',
        sourceKind: 'map',
      };
    }
  }

  return null;
}

/** 从本地输入元数据中构造初始中文字段 */
function buildLocalMetadataFields({ title = '', author = '' } = {}) {
  return {
    cnBookName: hasChinese(title) ? normalizeLooseLine(title) : '',
    cnAuthor: hasChinese(author) ? normalizeLooseLine(author) : '',
    synopsis: '',
    glossary: '',
    source: hasChinese(title) || hasChinese(author) ? '本地中文字段' : '',
    sourceKind: hasChinese(title) || hasChinese(author) ? 'local' : '',
  };
}

/** 启动阶段 provisional identity：不调用任何 AI */
function buildProvisionalIdentity({ title = '', author = '', fileName = '' } = {}) {
  const fallbackTitle = normalizeLooseLine(title || stripFileExt(fileName));
  const fallbackAuthor = normalizeLooseLine(author || '');

  return {
    originalBookName: fallbackTitle,
    originalAuthor: fallbackAuthor,
    cnBookName: '',
    cnAuthor: '',
    synopsis: '',
    glossary: '无',
    source: 'provisional identity',
    sourceKind: 'provisional',
  };
}

/** 取一个章节的“译后正文内容” */
function pickTranslatedChapterContent(chapter = {}) {
  return (
    chapter.translatedContent ||
    chapter.translatedText ||
    chapter.zhContent ||
    chapter.content ||
    ''
  );
}

/** 构造用于作者等元数据抽取的“已译中文样本” */
function buildTranslatedMetadataSampleText(translatedChapters = []) {
  const structural = translatedChapters
    .filter((chapter) => chapter?.isStructural || isNonContentSectionTitle(chapter?.title || ''))
    .slice(0, 4);

  const body = translatedChapters.filter((chapter) => !chapter?.isStructural).slice(0, 3);

  return [...structural, ...body]
    .map((chapter) => {
      const title = normalizeLooseLine(
        chapter?.translatedTitle || chapter?.title || chapter?.originalTitle || '',
      );
      const content = normalizeLooseLine(pickTranslatedChapterContent(chapter)).slice(0, 2500);
      return [title, content].filter(Boolean).join('\n\n');
    })
    .filter(Boolean)
    .join('\n\n---\n\n')
    .slice(0, TRANSLATED_METADATA_SAMPLE_MAX_CHARS);
}

/** 只构造“首个已译正文前部”的书名探测窗口 */
function buildTranslatedTitleProbeText(translatedChapters = []) {
  const firstBody = (translatedChapters || []).find((chapter) => {
    const title = normalizeLooseLine(chapter?.translatedTitle || chapter?.title || chapter?.originalTitle || '');
    return !chapter?.isStructural && !isNonContentSectionTitle(title) && !isCatalogSectionTitle(title);
  });

  if (!firstBody) return '';

  const lines = [];
  const chapterTitle = normalizeLooseLine(
    firstBody?.translatedTitle || firstBody?.title || firstBody?.originalTitle || '',
  );
  const rawContent = String(pickTranslatedChapterContent(firstBody) || '')
    .replace(/\r\n/g, '\n')
    .trim();

  const headLines = rawContent
    .split('\n')
    .map((line) => normalizeLooseLine(line))
    .filter(Boolean)
    .slice(0, 20);

  if (chapterTitle) lines.push('章节标题: ' + chapterTitle);
  if (headLines.length) lines.push(headLines.join('\n'));

  return lines.join('\n').trim().slice(0, 1600);
}

function normalizeDetectedBookTitleCandidate(text = '') {
  return normalizeLooseLine(
    String(text || '')
      .replace(/^(标题|书名|小说名|作品名|章节标题)\s*[:：]?\s*/u, '')
      .replace(/^《/, '')
      .replace(/》$/, ''),
  ).trim();
}

/** 从首个已译正文前部规则抽取中文书名 */
function extractZhBookNameFromFirstBodyByRule(probeText = '') {
  const empty = {
    cnBookName: '',
    displaySource: '',
    sourceKind: '',
    matchedLine: '',
    matchedMode: '',
  };

  const lines = String(probeText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => normalizeLooseLine(line))
    .filter(Boolean)
    .slice(0, 12);

  if (!lines.length) return empty;

  for (const line of lines) {
    const labeled = line.match(/^(标题|书名|小说名|作品名)\s*[:：]?\s*(.+)$/u);
    if (labeled) {
      const candidate = normalizeDetectedBookTitleCandidate(labeled[2] || '');
      if (isMeaningfulChineseName(candidate)) {
        return {
          cnBookName: candidate,
          displaySource: '标题 ' + candidate,
          sourceKind: 'title-first-body-rule',
          matchedLine: line,
          matchedMode: 'labeled',
        };
      }
    }

    const bracketOnly = line.match(/^《([^》\n]{2,80})》$/u);
    if (bracketOnly) {
      const candidate = normalizeDetectedBookTitleCandidate(bracketOnly[1] || '');
      if (isMeaningfulChineseName(candidate)) {
        return {
          cnBookName: candidate,
          displaySource: candidate,
          sourceKind: 'title-first-body-rule',
          matchedLine: line,
          matchedMode: 'bracket-only',
        };
      }
    }
  }

  return empty;
}

/** 规则抽取中文作者 */
function extractZhAuthorByRule(sampleText = '') {
  const text = String(sampleText || '');
  const patterns = [
    /作者\s*[:：]\s*([\u3400-\u9FFF·•・\s]{2,40})/u,
    /原著\s*[:：]\s*([\u3400-\u9FFF·•・\s]{2,40})/u,
    /作者为\s*([\u3400-\u9FFF·•・\s]{2,40})/u,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    const candidate = normalizeLooseLine(m?.[1] || '');
    if (isMeaningfulChineseName(candidate)) return candidate;
  }

  return '';
}

/** 用 Lite 从“已译中文样本”中抽取中文作者 */
async function extractZhAuthorFromTranslatedSamplesByGeminiLite({
  sampleText = '',
  originalTitle = '',
  originalAuthor = '',
} = {}) {
  const cleanedSample = String(sampleText || '').trim();
  if (!cleanedSample || !hasChinese(cleanedSample)) {
    return { cnAuthor: '' };
  }

  const prompt = [
    '你现在不是翻译器，而是“已译中文样本中的作者抽取器”。',
    '',
    '严格规则：',
    '1. 只能从下面已经是中文的样本里抽取，不允许根据英文原作者自行翻译。',
    '2. 如果样本里没有明确或高置信中文作者，就返回空字符串。',
    '3. 不要脑补，不要润色，不要改写。',
    '4. 只输出 JSON。',
    '',
    '已知原始信息（仅供比对，不可据此翻译）：',
    '- originalTitle: ' + JSON.stringify(originalTitle || ''),
    '- originalAuthor: ' + JSON.stringify(originalAuthor || ''),
    '',
    '中文样本：',
    '"""' + cleanedSample.slice(0, TRANSLATED_METADATA_SAMPLE_MAX_CHARS) + '"""',
    '',
    '输出 JSON ONLY:',
    '{',
    '  "cnAuthor": ""',
    '}',
  ].join('\n');

  try {
    const result = await callGeminiGenerateContent(
      METADATA_EXTRACT_MODEL_NAME,
      [{ role: 'user', parts: [{ text: prompt }] }],
      {
        generationConfig: {
          temperature: 0,
          seed: 0,
        },
      },
    );

    const json = safeJsonParse(stripJsonFences(extractResponseText(result)), {
      cnAuthor: '',
    });

    return {
      cnAuthor: normalizeLooseLine(json?.cnAuthor || ''),
    };
  } catch (err) {
    console.warn('⚠️ [Identity Finalization] Lite 已译样本作者抽取失败，将继续使用规则结果。');
    return { cnAuthor: '' };
  }
}

/** 用 Lite 从“首个已译正文前部”抽取中文书名 */
async function extractZhBookNameFromFirstBodyByGeminiLite({
  probeText = '',
  originalTitle = '',
  originalFileName = '',
} = {}) {
  const cleanedProbe = String(probeText || '').trim();
  if (!cleanedProbe || !hasChinese(cleanedProbe)) {
    return {
      cnBookName: '',
      displaySource: '',
      sourceKind: '',
      matchedLine: '',
      matchedMode: '',
    };
  }

  const prompt = [
    '你现在不是翻译器，而是“首个已译正文前部书名抽取器”。',
    '',
    '严格规则：',
    '1. 只能从下面已经是中文的内容里抽取书名，不允许根据英文原名自行翻译。',
    '2. 优先抽取类似“标题：XXX / 标题 XXX / 书名：XXX / 《XXX》”这种最前部标题证据。',
    '3. 如果能看到标题句，请 evidenceLine 尽量保留为“标题 吉姆老爷”这种形式。',
    '4. 如果没有标题句，但能高置信看到中文书名，可只返回书名本身。',
    '5. 如果没有高置信中文书名，返回空字符串。',
    '6. 只输出 JSON。',
    '',
    '已知原始信息（只用于比对，不可据此翻译）：',
    '- originalTitle: ' + JSON.stringify(originalTitle || ''),
    '- originalFileName: ' + JSON.stringify(originalFileName || ''),
    '',
    '首个已译正文前部：',
    '"""' + cleanedProbe.slice(0, 1600) + '"""',
    '',
    '输出 JSON ONLY:',
    '{',
    '  "cnBookName": "",',
    '  "evidenceLine": ""',
    '}',
  ].join('\n');

  try {
    const result = await callGeminiGenerateContent(
      METADATA_EXTRACT_MODEL_NAME,
      [{ role: 'user', parts: [{ text: prompt }] }],
      {
        generationConfig: {
          temperature: 0,
          seed: 0,
        },
      },
    );

    const json = safeJsonParse(stripJsonFences(extractResponseText(result)), {
      cnBookName: '',
      evidenceLine: '',
    });

    const cnBookName = normalizeDetectedBookTitleCandidate(json?.cnBookName || '');
    if (!isMeaningfulChineseName(cnBookName)) {
      return {
        cnBookName: '',
        displaySource: '',
        sourceKind: '',
        matchedLine: '',
        matchedMode: '',
      };
    }

    const rawEvidence = normalizeLooseLine(json?.evidenceLine || '');
    const hasTitleLabel = /^(标题|书名|小说名|作品名)\s*[:：]?\s*/u.test(rawEvidence);
    const displayCore = hasTitleLabel ? '标题 ' + cnBookName : cnBookName;

    return {
      cnBookName,
      displaySource: 'AI抽取 ' + displayCore + '（来自首段前部）',
      sourceKind: 'title-first-body-ai',
      matchedLine: rawEvidence || displayCore,
      matchedMode: 'ai',
    };
  } catch (err) {
    console.warn('⚠️ [Title Probe] Lite 首段书名抽取失败，将继续使用规则结果。');
    return {
      cnBookName: '',
      displaySource: '',
      sourceKind: '',
      matchedLine: '',
      matchedMode: '',
    };
  }
}

/** 是否显示元数据来源 */
function shouldDisplayMetadataSource(identity = {}) {
  const kind = identity?.sourceKind || '';
  const source = normalizeLooseLine(identity?.source || '');

  if (!source) return false;
  if (kind === 'provisional') return false;
  if (HIDE_AI_ONLY_METADATA_SOURCE_BY_DEFAULT && kind === 'ai-only') return false;

  return true;
}

/**
 * 导出前定稿身份信息
 * 书名顺序：
 * map -> 首个已译正文前部规则抽取 -> 必要时首段 Lite 抽取 -> 本地中文字段 -> 兜底
 * 作者顺序：
 * local -> map -> 规则样本 -> Lite 样本
 */
async function finalizeBookIdentityBeforeExport({
  provisionalIdentity = {},
  localMetadata = {},
  translatedChapters = [],
  originalFileName = '',
} = {}) {
  const mapItems = loadBookMetadataZhMap();
  const mapHit = matchBookMetadataZhMap({
    originalTitle: provisionalIdentity.originalBookName || '',
    originalAuthor: provisionalIdentity.originalAuthor || '',
    fileName: originalFileName,
    mapItems,
  });

  const titleProbeText = buildTranslatedTitleProbeText(translatedChapters);
  const authorSampleText = buildTranslatedMetadataSampleText(translatedChapters);

  const titleRuleHit = extractZhBookNameFromFirstBodyByRule(titleProbeText);
  const regexAuthor = extractZhAuthorByRule(authorSampleText);

  let titleAiHit = {
    cnBookName: '',
    displaySource: '',
    sourceKind: '',
    matchedLine: '',
    matchedMode: '',
  };

  let authorAiHit = { cnAuthor: '' };

  const stillNeedBookName =
    !isMeaningfulChineseName(mapHit?.cnBookName) &&
    !isMeaningfulChineseName(titleRuleHit?.cnBookName);

  if (ENABLE_TITLE_ANCHOR_AI_ASSIST && stillNeedBookName && titleProbeText) {
    titleAiHit = await extractZhBookNameFromFirstBodyByGeminiLite({
      probeText: titleProbeText,
      originalTitle: provisionalIdentity.originalBookName || '',
      originalFileName,
    });
  }

  const stillNeedAuthor =
    !isMeaningfulChineseName(localMetadata?.cnAuthor) &&
    !isMeaningfulChineseName(mapHit?.cnAuthor) &&
    !isMeaningfulChineseName(regexAuthor);

  if (ENABLE_METADATA_GEMINI_LITE_FALLBACK && stillNeedAuthor && authorSampleText) {
    authorAiHit = await extractZhAuthorFromTranslatedSamplesByGeminiLite({
      sampleText: authorSampleText,
      originalTitle: provisionalIdentity.originalBookName || '',
      originalAuthor: provisionalIdentity.originalAuthor || '',
    });
  }

  const cnBookName = chooseFirstMeaningfulChineseValue(
    mapHit?.cnBookName,
    titleRuleHit?.cnBookName,
    titleAiHit?.cnBookName,
    localMetadata?.cnBookName,
    provisionalIdentity?.cnBookName,
  );

  const cnAuthor = chooseFirstMeaningfulChineseValue(
    localMetadata?.cnAuthor,
    mapHit?.cnAuthor,
    regexAuthor,
    authorAiHit?.cnAuthor,
    provisionalIdentity?.cnAuthor,
  );

  let source = '';
  let sourceKind = 'provisional';

  if (isMeaningfulChineseName(mapHit?.cnBookName)) {
    source = mapHit.source;
    sourceKind = mapHit.sourceKind;
  } else if (isMeaningfulChineseName(titleRuleHit?.cnBookName)) {
    source = titleRuleHit.displaySource;
    sourceKind = titleRuleHit.sourceKind;
  } else if (isMeaningfulChineseName(titleAiHit?.cnBookName)) {
    source = titleAiHit.displaySource;
    sourceKind = titleAiHit.sourceKind;
  } else if (isMeaningfulChineseName(localMetadata?.cnBookName)) {
    source = '本地中文字段';
    sourceKind = 'local';
  } else if (mapHit && mapHit.cnAuthor) {
    source = mapHit.source;
    sourceKind = mapHit.sourceKind;
  } else if (regexAuthor) {
    source = '已译样本作者规则抽取';
    sourceKind = 'translated-sample-rule';
  } else if (authorAiHit?.cnAuthor) {
    source = 'AI 从已译中文样本抽取作者';
    sourceKind = 'ai-only';
  }

  return {
    originalBookName: chooseFirstMeaningfulValue(
      provisionalIdentity.originalBookName,
      stripFileExt(originalFileName),
    ),
    originalAuthor: chooseFirstMeaningfulValue(provisionalIdentity.originalAuthor),
    cnBookName: chooseFirstMeaningfulValue(
      cnBookName,
      mapHit?.cnBookName,
      localMetadata?.cnBookName,
      provisionalIdentity?.cnBookName,
      provisionalIdentity?.originalBookName,
      stripFileExt(originalFileName),
    ),
    cnAuthor: chooseFirstMeaningfulValue(
      cnAuthor,
      localMetadata?.cnAuthor,
      mapHit?.cnAuthor,
      provisionalIdentity?.cnAuthor,
      provisionalIdentity?.originalAuthor,
    ),
    synopsis: chooseFirstMeaningfulValue(
      localMetadata?.synopsis,
      mapHit?.synopsis,
      provisionalIdentity?.synopsis,
      '暂无简介',
    ),
    glossary: chooseFirstMeaningfulValue(
      localMetadata?.glossary,
      mapHit?.glossary,
      provisionalIdentity?.glossary,
      '无',
    ),
    source,
    sourceKind,
  };
}

/** 构造最终导出命名 */
function buildFinalExportNaming(identity = {}, outputKind = 'txt', timeStr = '', originalFileBaseName = '') {
  const bookName = sanitizeExportName(identity.cnBookName || identity.originalBookName || '未命名书籍');
  const originalNameMarker = sanitizeExportName(identity.originalBookName || originalFileBaseName || 'Unknown');

  return {
    folderName: bookName,
    txtFileName: bookName + '_全本_' + timeStr + '_331.txt',
    epubFileName: bookName + '_全本_' + timeStr + '_331.epub',
    infoFileName: '原文名_' + originalNameMarker + '_信息说明_' + timeStr + '_331.txt',
    preferredOutputFileName:
      outputKind === 'epub'
        ? bookName + '_全本_' + timeStr + '_331.epub'
        : bookName + '_全本_' + timeStr + '_331.txt',
  };
}

/** 构造书籍信息报告文本 */
function buildBookInfoReportText({
  identity = {},
  finalNaming = {},
  originalFileName = '',
  sourceArchiveName = '',
  outputFormat = '',
  sourceFingerprint = '',
  chunkCount = 0,
  chapterMapStr = '',
  taskTimeStr = '',
} = {}) {
  const originalBookName = normalizeLooseLine(identity.originalBookName || '') || '未知';
  const cnBookName = normalizeLooseLine(identity.cnBookName || '') || originalBookName;

  const lines = [
    '〖书籍信息报告〗',
    '--------------------------------',
    '原始输入文件: ' + (originalFileName || '未知'),
    '文件名: ' + (finalNaming.preferredOutputFileName || originalFileName || '未知'),
    '原书名: ' + originalBookName,
    '标准译名: ' + cnBookName,
  ];

  if (shouldDisplayMetadataSource(identity)) {
    lines.push('元数据锚定源: ' + identity.source);
  }

  lines.push(
    '--------------------------------',
    '〖名著标准化〗',
    '角色/术语表: ' + (identity.glossary || '无')
  );

  if (identity.synopsis) lines.push('简介: ' + identity.synopsis);

  lines.push(
    '--------------------------------',
    '〖版本快照〗',
    '任务时间: ' + (taskTimeStr || ''),
    '依据清洗底本TXT: ' + (sourceArchiveName || ''),
    '输出格式: ' + (outputFormat || ''),
    '--------------------------------',
    '〖分块指纹 (Chunk Lock)〗',
    sourceFingerprint || '',
    '--------------------------------',
    '〖统计数据〗',
    '分块数量: ' + (chunkCount || 0),
    '--------------------------------',
    '〖清洗后章节映射表 (Visualization)〗',
    chapterMapStr || ''
  );

  return lines.join('\n');
}

/** 删除旧的信息说明文件，避免目录里残留英文版 / provisional 版 */
async function cleanupOldInfoFiles(outputDir) {
  if (!fs.existsSync(outputDir)) return;

  const files = fs.readdirSync(outputDir);
  for (const f of files) {
    if (
      (f.includes('信息说明') || f.includes('书籍信息')) &&
      f.toLowerCase().endsWith('.txt')
    ) {
      await fs.remove(path.join(outputDir, f));
    }
  }
}

/** 如果最终中文命名变化，则整体重命名输出目录 */
async function renameOutputDirIfNeeded(currentOutputDir, targetFolderName) {
  if (!currentOutputDir || !fs.existsSync(currentOutputDir)) return currentOutputDir;

  const parentDir = path.dirname(currentOutputDir);
  const newDir = path.join(parentDir, sanitizeExportName(targetFolderName));

  if (currentOutputDir === newDir) return currentOutputDir;

  await fs.ensureDir(parentDir);
  await fs.move(currentOutputDir, newDir, { overwrite: true });
  return newDir;
}

// ==========================================
// EPUB 宏观结构过滤
// ==========================================

/** 把英文/规则原因转换成中文理由 */
function getReasonCN(reasonCode, isJunk) {
  if (!isJunk) return '正文内容';

  const lower = String(reasonCode || '').toLowerCase();
  if (lower.includes('rule')) return '规则高置信命中';
  if (lower.includes('copyright')) return '版权/许可声明';
  if (lower.includes('toc') || lower.includes('catalog')) return '目录列表';
  if (lower.includes('cover')) return '封面/封页';
  if (lower.includes('acknowled')) return '致谢/附录类非正文';

  return '非正文结构 (AI判定)';
}

/** 宏观过滤：可直接规则命中的垃圾标题模式 */
const MACRO_DIRECT_JUNK_PATTERNS = [
  { pattern: /^(contents?|table of contents|toc|chapter list|目录|目次)$/i, reason: 'Rule: TOC' },
  { pattern: /^(cover|front cover|back cover)$/i, reason: 'Rule: Cover' },
  {
    pattern: /^(title page|half title|copyright|copyright page|imprint|colophon)$/i,
    reason: 'Rule: Copyright/Cover',
  },
  { pattern: /^(illustrations?|list of illustrations)$/i, reason: 'Rule: Illustration List' },
  { pattern: /^(about the author|about author)$/i, reason: 'Rule: About Author' },
  { pattern: /^(also by|other books by|other works by)/i, reason: 'Rule: Also By' },
  { pattern: /^(acknowledg?ments?|credits)$/i, reason: 'Rule: Acknowledgements' },
  { pattern: /^(index|bibliography|glossary)$/i, reason: 'Rule: Back Matter' },
  { pattern: /^praise for /i, reason: 'Rule: Praise Pages' },
];

/** 根据标题直接判断是否应该删掉 */
function getMacroRuleRemoveReason(title = '') {
  const normalized = normalizeLooseLine(title);
  if (!normalized) return null;

  for (const item of MACRO_DIRECT_JUNK_PATTERNS) {
    if (item.pattern.test(normalized)) return item.reason;
  }
  return null;
}

/** 判断一个标题是否高度像正文标题，避免 AI 错删 */
function looksLikeSureBodyHeading(title = '') {
  const normalized = normalizeLooseLine(title);
  if (!normalized) return false;
  if (parseChapterHeadingMeta(normalized)) return true;
  if (/^(prologue|epilogue)$/i.test(normalized)) return true;
  return false;
}

/** 用指定模型做宏观结构审判 */
async function runStructureFilterWithModel(modelName, candidates) {
  const prompt = `
Identify "Non-Content" (Junk) chapter wrappers to REMOVE.
You are given only front/back candidate chapter titles from an EPUB.
Remove ONLY obvious junk such as cover, title page, copyright, TOC, acknowledgements, about author, bibliography, index, illustration list.
Be conservative: if unsure, keep it.

Data: ${JSON.stringify(candidates)}
Return JSON Array of Objects only:
[
  { "index": 0, "reason": "Copyright" }
]
`.trim();

  const result = await callGeminiGenerateContent(
    modelName,
    [{ role: 'user', parts: [{ text: prompt }] }],
    { generationConfig: { temperature: 0 } },
  );

  const json = safeJsonParse(stripJsonFences(extractResponseText(result)), null);
  return Array.isArray(json) ? json : null;
}

/** 检查 AI 宏观结构结果是否异常 */
function isStructureAiResultAbnormal(resultArray, candidates, chapters) {
  if (!Array.isArray(resultArray)) return true;

  const candidateIndexSet = new Set(candidates.map((c) => c.index));
  let sureBodyRemoved = 0;
  let invalidCount = 0;

  for (const item of resultArray) {
    const idx = Number(item?.index);
    if (!candidateIndexSet.has(idx)) {
      invalidCount += 1;
      continue;
    }
    if (looksLikeSureBodyHeading(chapters[idx]?.title || '')) sureBodyRemoved += 1;
  }

  if (invalidCount > 0) return true;
  if (sureBodyRemoved > 0) return true;
  if (resultArray.length >= Math.max(4, Math.ceil(candidates.length * 0.8))) return true;

  return false;
}

/** EPUB 宏观结构过滤：仅 Lite */
async function aiStructureFilter(chapters) {
  console.log('⚖️ [AI Clean] 宏观结构审判 (前5后5，规则优先 + Lite only)...');

  const total = chapters.length;
  const candidates = [];
  const checkRange = 5;

  for (let i = 0; i < total; i++) {
    if (i < checkRange || i >= total - checkRange) {
      candidates.push({ index: i, title: chapters[i].title });
    }
  }

  if (candidates.length === 0) return chapters;

  const removeMap = new Map();
  const unresolved = [];

  for (const c of candidates) {
    const ruleReason = getMacroRuleRemoveReason(c.title);
    if (ruleReason) removeMap.set(c.index, ruleReason);
    else unresolved.push(c);
  }

  if (unresolved.length) {
    let aiResult = null;
    let aiOk = false;

    for (const modelName of NON_BODY_AI_MODELS) {
      try {
        aiResult = await runStructureFilterWithModel(modelName, unresolved);
        aiOk = !isStructureAiResultAbnormal(aiResult, unresolved, chapters);
        if (aiOk) break;
      } catch {}
    }

    if (aiOk && Array.isArray(aiResult)) {
      aiResult.forEach((item) => {
        const idx = Number(item?.index);
        if (unresolved.some((c) => c.index === idx)) {
          removeMap.set(idx, item?.reason || 'AI');
        }
      });
    }
  }

  if (LOG_FILTER_DETAILS) {
    console.log('--------------------------------------------------');
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const isJunk = removeMap.has(c.index);
      const reason = getReasonCN(removeMap.get(c.index), isJunk);
      const preview = (chapters[c.index].content || '').slice(0, 30).replace(/[\r\n]/g, '↵');
      console.log(`📘 [审判 ${i + 1}/${candidates.length}] ${isJunk ? '剔除' : '保留'}: ${c.title}`);
      console.log(`   ↳ 预览: "${preview}..."`);
      console.log(`   ↳ 理由: ${reason}`);
    }
    console.log('--------------------------------------------------');
  }

  return chapters.filter((_, i) => !removeMap.has(i));
}

// ==========================================
// EPUB 微观内容过滤
// ==========================================

/** 统计正则出现次数 */
function countRegex(text = '', regex) {
  const matches = String(text || '').match(regex);
  return matches ? matches.length : 0;
}

/** 判断一行是否像目录项 */
function isLikelyCatalogLine(line) {
  const normalized = String(line || '').trim();
  return (
    /^(?:\d+\.\s*)?第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*章(?:\s*[:：].*)?$/u.test(
      normalized,
    ) ||
    /^(?:\d+\.\s*)?chapter\s+[0-9ivxlcdm]+(?:\s*[:：].*)?$/i.test(normalized)
  );
}

/** 判断文本里是否有高置信垃圾标记 */
function hasHighConfidenceJunkMarkers(title = '', text = '') {
  const merged = `${title}\n${text}`.toLowerCase();
  const markers = [
    /project gutenberg/i,
    /www\.gutenberg\.org/i,
    /standard ?ebooks/i,
    /archive\.org/i,
    /all rights reserved/i,
    /\bcopyright\b/i,
    /\bisbn\b/i,
    /\bpublisher\b/i,
    /\blicense\b/i,
    /distributed proofreaders/i,
    /scanned by/i,
    /transcriber'?s note/i,
  ];
  return markers.some((re) => re.test(merged));
}

/** 判断文本是否呈现高密度目录形态 */
function hasHighConfidenceCatalogDensity(text = '') {
  const lines = decodeBasicHtmlEntities(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 3) return false;

  const catalogLineCount = lines.filter(isLikelyCatalogLine).length;
  return catalogLineCount >= 3 && catalogLineCount / lines.length >= 0.6;
}

/** 判断文本是否像小说正文 */
function looksLikeNarrativeBody(text = '') {
  const normalized = decodeBasicHtmlEntities(text || '')
    .replace(/\r\n/g, '\n')
    .trim();

  if (!normalized || normalized.length < 350) return false;
  if (hasHighConfidenceJunkMarkers('', normalized)) return false;
  if (hasHighConfidenceCatalogDensity(normalized)) return false;

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const longParagraphs = paragraphs.filter((p) => p.length >= 70).length;
  const sentenceEndings =
    countRegex(normalized, /[。！？!?]/g) + countRegex(normalized, /\.(?=\s|$)/g);
  const dialogueMarks = countRegex(normalized, /["“”]/g);

  if (longParagraphs >= 2 && sentenceEndings >= 3) return true;
  if (paragraphs.length >= 3 && sentenceEndings >= 4) return true;
  if (dialogueMarks >= 4 && sentenceEndings >= 3) return true;

  return false;
}

/** 规则先判断一段内容是 junk / body / unknown */
function classifyContentByRule(chapter) {
  const title = normalizeLooseLine(chapter?.title || '');
  const contentPreview = decodeBasicHtmlEntities(chapter?.content || '').slice(0, 1500).trim();

  if (!contentPreview) return { status: 'unknown', reason: 'Empty' };
  if (getMacroRuleRemoveReason(title)) return { status: 'junk', reason: 'Rule: Macro Junk Title' };
  if (hasHighConfidenceJunkMarkers(title, contentPreview))
    return { status: 'junk', reason: 'Rule: Copyright / License / Source' };
  if (hasHighConfidenceCatalogDensity(contentPreview))
    return { status: 'junk', reason: 'Rule: TOC Density' };
  if (looksLikeNarrativeBody(contentPreview)) return { status: 'body', reason: 'Rule: Narrative Body' };

  return { status: 'unknown', reason: 'Unknown' };
}

/** 用模型判定某章是否 junk */
async function runContentJudgeWithModel(modelName, chapter) {
  const contentPreview = (chapter?.content || '').slice(0, 1000);

  const prompt = `
Determine whether this chapter is Non-Content (Junk) or real book body.

Title: "${chapter?.title || ''}"
Text:
"""${contentPreview}"""

Rules:
- Junk includes copyright page, license text, TOC/navigation, source-site boilerplate, scan notes, credits.
- If unsure, prefer keep.
- Return JSON ONLY.

Return:
{"isJunk": true, "reason": "Copyright info"}
or
{"isJunk": false}
`.trim();

  const result = await callGeminiGenerateContent(
    modelName,
    [{ role: 'user', parts: [{ text: prompt }] }],
    { generationConfig: { temperature: 0 } },
  );

  return safeJsonParse(stripJsonFences(extractResponseText(result)), null);
}

/** 检查 AI 微观过滤结果是否异常 */
function isContentAiResultAbnormal(json, chapter) {
  if (!json || typeof json !== 'object') return true;
  if (typeof json.isJunk !== 'boolean') return true;

  const preview = decodeBasicHtmlEntities(chapter?.content || '').slice(0, 1000);

  if (
    json.isJunk &&
    looksLikeNarrativeBody(preview) &&
    !hasHighConfidenceJunkMarkers(chapter?.title || '', preview) &&
    !hasHighConfidenceCatalogDensity(preview)
  ) {
    return true;
  }

  return false;
}

/** EPUB 微观内容过滤：仅 Lite */
async function aiContentFilter(chapters) {
  console.log('⚖️ [AI Clean] 微观内容审判 (规则三档 + Lite only)...');

  const checkIndices = new Set([0, 1, 2, chapters.length - 1, chapters.length - 2].filter((n) => n >= 0));
  const finalChapters = [];
  let processedCount = 0;
  const totalCheck = checkIndices.size;

  if (LOG_FILTER_DETAILS) console.log('--------------------------------------------------');

  for (let i = 0; i < chapters.length; i++) {
    if (!checkIndices.has(i)) {
      finalChapters.push(chapters[i]);
      continue;
    }

    processedCount += 1;
    const chapter = chapters[i];
    let isJunk = false;
    let reasonRaw = '';

    const ruleResult = classifyContentByRule(chapter);

    if (ruleResult.status === 'junk') {
      isJunk = true;
      reasonRaw = ruleResult.reason;
    } else if (ruleResult.status === 'body') {
      isJunk = false;
      reasonRaw = ruleResult.reason;
    } else {
      let aiJson = null;
      let aiOk = false;

      for (const modelName of NON_BODY_AI_MODELS) {
        try {
          aiJson = await runContentJudgeWithModel(modelName, chapter);
          aiOk = !isContentAiResultAbnormal(aiJson, chapter);
          if (aiOk) break;
        } catch {}
      }

      if (aiOk) {
        isJunk = Boolean(aiJson.isJunk);
        reasonRaw = aiJson.reason || 'AI';
      } else {
        isJunk = false;
        reasonRaw = 'Fallback Keep';
      }
    }

    if (LOG_FILTER_DETAILS) {
      const action = isJunk ? '剔除' : '保留';
      const reason = getReasonCN(reasonRaw, isJunk);
      const preview = (chapter.content || '').slice(0, 30).replace(/[\r\n]/g, '↵');
      console.log(`📘 [审判 ${processedCount}/${totalCheck}] ${action}: ${chapter.title}`);
      console.log(`   ↳ 预览: "${preview}..."`);
      console.log(`   ↳ 理由: ${reason}`);
    }

    if (!isJunk) finalChapters.push(chapters[i]);
  }

  if (LOG_FILTER_DETAILS) console.log('--------------------------------------------------');
  return finalChapters;
}

// ==========================================
// 标题规范化（纯规则）
// ==========================================

/** 超长标题做纯规则压缩 */
function normalizeLongTitlesDeterministically(chapters) {
  for (let i = 0; i < chapters.length; i++) {
    const title = chapters[i]?.title || '';
    if (title.length <= 50) continue;

    let normalized = normalizeLooseLine(title);
    normalized = stripTrailingCatalogPageNo(normalized)
      .replace(/\s*\|\s*.*$/g, '')
      .replace(/\s+-\s+.*?(edition|ebook|project gutenberg|standard ebooks).*$/i, '')
      .trim();

    if (normalized.length > 50) {
      const withoutPrefix = stripChapterPrefixOnly(normalized) || normalized;
      const parts = withoutPrefix
        .split(/[：:|｜—\-–·•]/)
        .map((s) => normalizeLooseLine(s))
        .filter(Boolean);

      const meaningful = parts.find((p) => p.length >= 4 && p.length <= 40);
      if (meaningful) {
        normalized = meaningful;
      } else {
        const firstChunk = withoutPrefix
          .slice(0, 42)
          .replace(/[，。；：:、.\-—\s]+$/g, '')
          .trim();
        if (firstChunk && firstChunk.length >= 4) {
          normalized = firstChunk;
        }
      }
    }

    chapters[i].title = normalized;
  }

  return chapters;
}

/** 是否是“非正文”章节 */
function isNonContentSectionTitle(title = '') {
  return normalizeLooseLine(title) === NON_CONTENT_SECTION_TITLE;
}

/** 是否是“目录”章节 */
function isCatalogSectionTitle(title = '') {
  const key = normalizeCompareKey(title);
  return key === '目录' || key === 'contents' || key === 'toc' || key === 'table of contents';
}

/** 规范化整本书所有章节标题 */
function normalizeChapterTitles(chapters) {
  let chapterCounter = 0;

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (!chapter) continue;

    if (
      chapter.skipTitleTranslate ||
      isNonContentSectionTitle(chapter.title) ||
      isCatalogSectionTitle(chapter.title)
    ) {
      chapter.translatedTitle = chapter.translatedTitle || chapter.title;
      continue;
    }

    chapterCounter += 1;
    const cleanedTitleCore = sanitizeTranslatedTitleCandidate(chapter.title) || chapter.title;
    chapter.translatedTitle = normalizeChapterTitleForIndex(cleanedTitleCore, chapterCounter);
  }
}

// ==========================================
// TXT 结构化
// ==========================================

/** 目录标题正则 */
const TXT_TOC_TITLE_REGEX =
  /^(?:目\s*录|目\s*次|contents?|table\s+of\s+contents?|chapter\s+list|章节目录)$/i;

/** 标题宽松匹配 */
function titlesLooselyMatch(a = '', b = '') {
  const ka = normalizeCompareKey(
    String(a || '')
      .replace(/^第\s*[零〇一二两三四五六七八九十百千万\d]+\s*[章节卷部回篇集]\s*/u, '')
      .replace(/^chapter\s+[0-9ivxlcdm]+\s*/i, ''),
  );

  const kb = normalizeCompareKey(
    String(b || '')
      .replace(/^第\s*[零〇一二两三四五六七八九十百千万\d]+\s*[章节卷部回篇集]\s*/u, '')
      .replace(/^chapter\s+[0-9ivxlcdm]+\s*/i, ''),
  );

  if (!ka || !kb) return false;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

/** 章节编号 key 是否一致 */
function chapterKeysMatch(a = '', b = '') {
  return a && b && a === b;
}

/** 从目录块中抽取目录项 */
function extractCatalogEntriesFromLines(lines = []) {
  const entries = [];
  let pendingNumber = null;

  for (const raw of lines) {
    const line = stripTrailingCatalogPageNo(normalizeLooseLine(raw));
    if (!line) continue;

    const meta = parseChapterHeadingMeta(line);

    if (meta && meta.title) {
      entries.push({
        numberText: meta.numberText,
        numberKey: meta.numberKey,
        numberValue: meta.numberValue,
        title: meta.title,
        rawLine: line,
      });
      pendingNumber = null;
      continue;
    }

    if (meta && !meta.title) {
      pendingNumber = meta;
      continue;
    }

    if (pendingNumber && line.length <= 120) {
      entries.push({
        numberText: pendingNumber.numberText,
        numberKey: pendingNumber.numberKey,
        numberValue: pendingNumber.numberValue,
        title: line,
        rawLine: `${pendingNumber.rawLine} ${line}`.trim(),
      });
      pendingNumber = null;
    }
  }

  const seen = new Set();
  return entries.filter((item) => {
    const key = `${item.numberKey}|${normalizeCompareKey(item.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(item.title);
  });
}

/** 发现 TXT 里的目录块 */
function findTxtCatalogBlock(lines = []) {
  let startLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (TXT_TOC_TITLE_REGEX.test(normalizeLooseLine(lines[i]))) {
      startLine = i;
      break;
    }
  }

  if (startLine < 0) return null;

  let endLine = startLine;
  let matched = 0;
  let missStreak = 0;

  for (let i = startLine + 1; i < Math.min(lines.length, startLine + 600); i++) {
    const raw = lines[i];
    const line = normalizeLooseLine(raw);

    if (!line) {
      if (matched > 0) endLine = i;
      continue;
    }

    const looksLikeEntry =
      Boolean(parseChapterHeadingMeta(line)) ||
      /^[0-9ivxlcdm]+$/i.test(line) ||
      /^(?:prologue|epilogue|preface|introduction|序|前言|楔子|尾声)$/i.test(line) ||
      /(?:chapter|第.+[章节卷部回篇集])/i.test(line);

    const looksLikePageTail = /[.．·•\-—_]{2,}\s*\d+\s*$/.test(raw) || /^\d+\s*$/.test(line);

    if (looksLikeEntry || looksLikePageTail) {
      matched += 1;
      missStreak = 0;
      endLine = i;
      continue;
    }

    if (matched === 0) continue;

    missStreak += 1;
    if (missStreak >= 3) break;
    endLine = i;
  }

  const rawText = lines.slice(startLine, endLine + 1).join('\n').trim();
  const entries = extractCatalogEntriesFromLines(lines.slice(startLine + 1, endLine + 1));

  if (entries.length < 2) return null;
  return { startLine, endLine, rawText, entries };
}

/** 收集潜在章节标题候选 */
function collectPotentialHeadingCandidates(lines = [], startLine = 0) {
  const candidates = [];

  for (let i = startLine; i < lines.length; i++) {
    const current = normalizeLooseLine(lines[i]);
    if (!current) continue;

    const meta = parseChapterHeadingMeta(current);
    if (!meta) continue;

    let endLine = i;
    let title = meta.title || '';

    if (!title) {
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const next = normalizeLooseLine(lines[j]);
        if (!next) continue;
        if (parseChapterHeadingMeta(next)) break;
        if (next.length <= 120) {
          title = stripTrailingCatalogPageNo(next);
          endLine = j;
        }
        break;
      }
    }

    candidates.push({
      startLine: i,
      endLine,
      numberText: meta.numberText,
      numberKey: meta.numberKey,
      numberValue: meta.numberValue,
      title,
      rawHeading: lines.slice(i, endLine + 1).join('\n').trim(),
    });
  }

  const seen = new Set();
  return candidates.filter((item) => {
    const key = `${item.startLine}:${item.endLine}:${item.numberKey}:${normalizeCompareKey(item.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 对章节计划去重 */
function dedupeChapterPlan(plan = []) {
  const ordered = [...plan].sort((a, b) => a.startLine - b.startLine);
  const out = [];

  for (const item of ordered) {
    if (!item || !Number.isFinite(item.startLine)) continue;
    if (!item.title || !normalizeLooseLine(item.title)) continue;

    const last = out[out.length - 1];
    if (
      last &&
      item.startLine <= last.endLine &&
      (chapterKeysMatch(item.numberKey, last.numberKey) || titlesLooselyMatch(item.title, last.title))
    ) {
      continue;
    }

    out.push(item);
  }

  return out;
}

/** 用目录项与候选标题做匹配 */
function matchCandidatesWithCatalogEntries(candidates = [], entries = []) {
  const plan = [];
  let cursor = 0;

  for (const entry of entries) {
    while (cursor < candidates.length) {
      const cand = candidates[cursor++];
      const numberMatched = chapterKeysMatch(cand.numberKey, entry.numberKey);
      const titleMatched = titlesLooselyMatch(cand.title, entry.title);

      if (numberMatched || titleMatched) {
        plan.push({
          startLine: cand.startLine,
          endLine: cand.endLine,
          numberText: entry.numberText || cand.numberText,
          numberKey: entry.numberKey || cand.numberKey,
          numberValue: entry.numberValue ?? cand.numberValue,
          title: entry.title || cand.title,
          rawTitle: entry.rawLine || cand.rawHeading,
          rawHeading: cand.rawHeading,
        });
        break;
      }
    }
  }

  return dedupeChapterPlan(plan);
}

/** 直接从候选标题构造章节计划 */
function buildDirectPlanFromCandidates(candidates = []) {
  return dedupeChapterPlan(
    candidates
      .filter((item) => item.title && normalizeLooseLine(item.title))
      .map((item) => ({
        startLine: item.startLine,
        endLine: item.endLine,
        numberText: item.numberText,
        numberKey: item.numberKey,
        numberValue: item.numberValue,
        title: item.title,
        rawTitle: item.rawHeading,
        rawHeading: item.rawHeading,
      })),
  );
}

/** 调用 TXT 结构模型：仅 Lite */
async function callTxtStructureModel(prompt) {
  const modelNames = [...new Set([TXT_STRUCTURE_MODEL_PRIMARY, TXT_STRUCTURE_MODEL_FALLBACK].filter(Boolean))];

  for (const modelName of modelNames) {
    try {
      const result = await callGeminiGenerateContent(
        modelName,
        [{ role: 'user', parts: [{ text: prompt }] }],
        { generationConfig: { temperature: 0 } },
      );
      const json = safeJsonParse(stripJsonFences(extractResponseText(result)), null);
      if (json) {
        console.log(`🧭 [TXT AI] 结构兜底命中模型: ${modelName}`);
        return json;
      }
    } catch (e) {
      console.warn(`⚠️ [TXT AI] ${modelName} 调用失败: ${e?.message || String(e)}`);
    }
  }

  return null;
}

/** AI 参与兜底确定 TXT 的章节计划 */
async function aiResolveTxtChapterPlan(lines = [], catalogBlock = null, candidates = [], fileName = '') {
  if (!candidates.length) return [];

  const candidatePayload = candidates.slice(0, 1200).map((item) => ({
    startLine: item.startLine,
    endLine: item.endLine,
    numberText: item.numberText,
    title: item.title,
    rawHeading: item.rawHeading,
  }));

  const prompt = `
Role: TXT novel structure extractor.

Task:
Given a plain TXT novel, identify real chapter anchors from candidate heading lines.
You must determine:
1. non-body/front-matter before the first real chapter,
2. whether a catalog/contents block exists,
3. the real chapter heading lines,
4. each chapter MUST have both chapter number and chapter title.

STRICT RULES:
- Do not invent chapters.
- Prefer catalog/contents information if present.
- Return line numbers using ONLY candidate startLine/endLine values.
- If a chapter title cannot be determined, do not include that chapter.
- If chapter titles cannot be stably determined at all, return {"chapters":[]}.
- Output JSON only.

File: ${fileName || 'Unknown'}

Catalog block:
"""${(catalogBlock?.rawText || '').slice(0, 7000)}"""

Candidate heading lines JSON:
${JSON.stringify(candidatePayload)}

Head excerpt:
"""${lines.slice(0, 220).join('\n').slice(0, 7000)}"""

Tail excerpt:
"""${lines.slice(-160).join('\n').slice(-5000)}"""

Return JSON:
{
  "chapters": [
    { "startLine": 123, "endLine": 124, "numberText": "I", "title": "The Hacklerton Case" }
  ]
}
`.trim();

  const json = await callTxtStructureModel(prompt);
  const rawChapters = Array.isArray(json?.chapters) ? json.chapters : [];
  if (!rawChapters.length) return [];

  const candidateMap = new Map(candidates.map((item) => [String(item.startLine), item]));

  return dedupeChapterPlan(
    rawChapters
      .map((item) => {
        const startLine = Number(item?.startLine);
        const cand = candidateMap.get(String(startLine));
        if (!cand) return null;

        const title = normalizeLooseLine(item.title || cand.title || '');
        if (!title) return null;

        return {
          startLine: cand.startLine,
          endLine: cand.endLine,
          numberText: normalizeLooseLine(item.numberText || cand.numberText || ''),
          numberKey: cand.numberKey,
          numberValue: cand.numberValue,
          title,
          rawTitle: [normalizeLooseLine(item.numberText || cand.numberText || ''), title]
            .filter(Boolean)
            .join(' '),
          rawHeading: cand.rawHeading,
          aiConfirmed: true,
        };
      })
      .filter(Boolean),
  );
}

/** 抽取第一章前的非正文内容 */
function extractPreChapterNonContent(lines = [], firstChapterStart = 0, catalogBlock = null) {
  const out = [];

  for (let i = 0; i < firstChapterStart; i++) {
    if (catalogBlock && i >= catalogBlock.startLine && i <= catalogBlock.endLine) continue;
    out.push(lines[i]);
  }

  return out.join('\n').trim();
}

/** 按章节计划把 TXT 切成章节 */
function materializeTxtChaptersFromPlan(lines = [], plan = []) {
  const ordered = [...plan].sort((a, b) => a.startLine - b.startLine);
  const chapters = [];

  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i];
    const next = ordered[i + 1];

    const bodyStart = current.endLine + 1;
    const bodyEnd = next ? next.startLine : lines.length;
    const body = lines.slice(bodyStart, bodyEnd).join('\n').trim();

    const rawTitle = normalizeLooseLine(
      current.rawTitle || [current.numberText, current.title].filter(Boolean).join(' '),
    );

    chapters.push({
      title: rawTitle,
      originalTitle: rawTitle,
      rawChapterNumber: current.numberText || '',
      content: body,
    });
  }

  return chapters;
}

/** 整体构造结构化 TXT 章节 */
async function buildStructuredTxtChapters(pureSourceText, fileName = '') {
  const lines = decodeBasicHtmlEntities(pureSourceText || '').replace(/\r\n?/g, '\n').split('\n');
  const catalogBlock = findTxtCatalogBlock(lines);
  const bodyStartLine = catalogBlock ? catalogBlock.endLine + 1 : 0;
  const candidates = collectPotentialHeadingCandidates(lines, bodyStartLine);

  let plan = [];
  let method = 'regex';

  if (catalogBlock?.entries?.length) {
    plan = matchCandidatesWithCatalogEntries(candidates, catalogBlock.entries);
  }

  if (plan.length < 2) {
    plan = buildDirectPlanFromCandidates(candidates);
  }

  if (!plan.length || plan.some((item) => !item.title)) {
    const aiPlan = await aiResolveTxtChapterPlan(lines, catalogBlock, candidates, fileName);
    if (aiPlan.length) {
      plan = aiPlan;
      method = 'regex+ai';
    }
  }

  plan = dedupeChapterPlan(plan);

  if (!plan.length) {
    return {
      skip: true,
      reason: '正则与 Gemini 结构判定后，仍无法稳定确定章节数与章节名。',
    };
  }

  const realChapters = materializeTxtChaptersFromPlan(lines, plan).filter((item) => item.title);

  if (!realChapters.length || realChapters.some((item) => !normalizeLooseLine(item.title))) {
    return {
      skip: true,
      reason: '章节位置已定位，但章节名仍不完整，按要求跳过该 TXT 文件。',
    };
  }

  const frontMatterText = extractPreChapterNonContent(lines, plan[0].startLine, catalogBlock);
  const chapters = [];

  if (frontMatterText) {
    chapters.push({
      title: NON_CONTENT_SECTION_TITLE,
      translatedTitle: NON_CONTENT_SECTION_TITLE,
      skipTitleTranslate: true,
      isStructural: true,
      content: frontMatterText,
      originalTitle: NON_CONTENT_SECTION_TITLE,
    });
  }

  if (catalogBlock?.rawText) {
    chapters.push({
      title: '目录',
      translatedTitle: '目录',
      skipTitleTranslate: true,
      isStructural: true,
      content: catalogBlock.rawText,
      originalTitle: '目录',
    });
  }

  chapters.push(...realChapters);

  console.log(
    `📚 [TXT Structure] 目录: ${catalogBlock ? '命中' : '未命中'} / 章节数: ${realChapters.length} / 方式: ${method}`,
  );

  return { skip: false, method, catalogBlock, chapters };
}

// ==========================================
// 正文冗余标题清理
// ==========================================

/** 去掉 source 标题中的编号前缀 */
function stripSourceChapterPrefix(text = '') {
  const normalized = normalizeLooseLine(text);
  const hadExplicitChapterPrefix =
    /^chapter\s+[0-9ivxlcdm]+\b/i.test(normalized) ||
    /^第\s*[零〇一二两三四五六七八九十百千万\d]+\s*[章节卷部回篇集]/u.test(normalized);

  const stripped = stripChapterPrefixOnly(normalized);
  if (hadExplicitChapterPrefix && isPureNumericLikeRedundantTitleFragment(stripped)) return '';
  return stripped;
}

/** 构造用于去重的 source 标题候选集 */
function buildSourceHeadingRedundancyCandidates(chapter = {}) {
  const set = new Set();

  const add = (value) => {
    const key = normalizeCompareKey(stripTrailingCatalogPageNo(normalizeLooseLine(value || '')));
    if (key) set.add(key);
  };

  const sourceTitle = normalizeLooseLine(chapter.originalTitle || chapter.title || '');
  const meta = parseChapterHeadingMeta(sourceTitle) || null;
  const rawNumber = normalizeLooseLine(chapter.rawChapterNumber || meta?.numberText || '');
  const coreTitle = stripSourceChapterPrefix(meta?.title ? meta.title : sourceTitle);

  add(sourceTitle);
  add(rawNumber);
  add(coreTitle);

  const parsedRaw = parseLooseChapterNumberMeta(rawNumber);
  const numValue = parsedRaw.value ?? meta?.numberValue ?? null;
  const numVariants = [];

  if (rawNumber) numVariants.push(rawNumber);

  if (numValue !== null && numValue !== undefined) {
    const roman = intToRoman(numValue);
    const zh = intToChinese(numValue);

    numVariants.push(String(numValue));
    numVariants.push('Chapter ' + numValue);
    numVariants.push('第' + numValue + '章');

    if (roman) {
      numVariants.push(roman);
      numVariants.push('Chapter ' + roman);
    }

    if (zh) numVariants.push('第' + zh + '章');
  }

  numVariants.forEach(add);

  if (coreTitle) {
    add(coreTitle);
    for (const numText of numVariants) {
      add(numText + ' ' + coreTitle);
      add(numText + ': ' + coreTitle);
      add(numText + ' - ' + coreTitle);
      add(numText + '. ' + coreTitle);
    }
  }

  return [...set];
}

/** 去掉正文开头重复的 source 标题块 */
function stripLeadingSourceHeadingRedundancy(text = '', chapter = {}) {
  const content = decodeBasicHtmlEntities(text || '').replace(/\r\n?/g, '\n');
  if (!content.trim()) return '';

  const candidateKeys = new Set(buildSourceHeadingRedundancyCandidates(chapter));
  if (!candidateKeys.size) return content.trim();

  const lines = content.split('\n');

  function trimLeadingBlank() {
    while (lines.length && !lines[0].trim()) lines.shift();
  }

  function firstNonEmptyIndices(limit = 3) {
    const result = [];
    for (let i = 0; i < lines.length && result.length < limit; i++) {
      if (lines[i].trim()) result.push(i);
    }
    return result;
  }

  function keyOfLine(line = '') {
    return normalizeCompareKey(stripTrailingCatalogPageNo(normalizeLooseLine(line)));
  }

  function keyOfRange(startIdx, endIdx) {
    const joined = lines
      .slice(startIdx, endIdx + 1)
      .map((line) => stripTrailingCatalogPageNo(normalizeLooseLine(line)))
      .filter(Boolean)
      .join(' ');
    return normalizeCompareKey(joined);
  }

  for (let round = 0; round < 6; round++) {
    trimLeadingBlank();
    if (!lines.length) break;

    const idx = firstNonEmptyIndices(3);
    if (!idx.length) break;

    let removed = false;

    if (idx.length >= 3) {
      const key123 = keyOfRange(idx[0], idx[2]);
      if (key123 && candidateKeys.has(key123)) {
        lines.splice(idx[0], idx[2] - idx[0] + 1);
        removed = true;
      }
    }
    if (removed) continue;

    if (idx.length >= 2) {
      const key12 = keyOfRange(idx[0], idx[1]);
      if (key12 && candidateKeys.has(key12)) {
        lines.splice(idx[0], idx[1] - idx[0] + 1);
        removed = true;
      }
    }
    if (removed) continue;

    const key1 = keyOfLine(lines[idx[0]]);
    if (key1 && candidateKeys.has(key1)) {
      lines.splice(idx[0], 1);
      removed = true;
    }
    if (removed) continue;

    const sourceTitle = normalizeLooseLine(chapter.originalTitle || chapter.title || '');
    const titleCore = stripSourceChapterPrefix(sourceTitle);
    const prefixRegexes = [];

    if (sourceTitle) prefixRegexes.push(buildFlexibleTitlePrefixRegex(sourceTitle));
    if (titleCore) prefixRegexes.push(buildFlexibleTitlePrefixRegex(titleCore));

    for (const regex of prefixRegexes) {
      if (!regex) continue;

      const current = decodeBasicHtmlEntities(lines[idx[0]]);
      const stripped = current.replace(regex, '').trimStart();

      if (stripped !== current && stripped !== '') {
        lines[idx[0]] = stripped;
        removed = true;
        break;
      }
    }

    if (!removed) break;
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 构造译后章节标题的冗余候选集 */
function buildRedundantHeadingCandidates(title, chapterIndex) {
  const normalizedTitle = normalizeLooseLine(title);
  const pureTitleRaw = normalizedTitle
    .replace(/^第\s*\d+\s*章\s*(?:[：:.\-—、]\s*)?/u, '')
    .trim();
  const pureTitle = isPureNumericLikeRedundantTitleFragment(pureTitleRaw) ? '' : pureTitleRaw;

  const roman = intToRoman(chapterIndex);
  const zh = intToChinese(chapterIndex);

  const variants = [
    normalizedTitle,
    pureTitle,
    '第' + chapterIndex + '章',
    pureTitle ? '第' + chapterIndex + '章 ' + pureTitle : '',
    pureTitle ? '第' + chapterIndex + '章: ' + pureTitle : '',
    zh ? '第' + zh + '章' : '',
    pureTitle && zh ? '第' + zh + '章 ' + pureTitle : '',
    String(chapterIndex),
    pureTitle ? String(chapterIndex) + ' ' + pureTitle : '',
    roman,
    pureTitle && roman ? roman + ' ' + pureTitle : '',
    'Chapter ' + chapterIndex,
    roman ? 'Chapter ' + roman : '',
    pureTitle ? 'Chapter ' + chapterIndex + ': ' + pureTitle : '',
    pureTitle && roman ? 'Chapter ' + roman + ': ' + pureTitle : '',
  ];

  return [...new Set(variants.map(normalizeCompareKey).filter(Boolean))];
}

/** 去掉译文中最前面的重复标题块 */
function stripLeadingRedundantHeadingBlock(text = '', title = '', chapterIndex = 0) {
  const lines = normalizeTxtBodyWhitespace(text).split('\n');
  const candidates = buildRedundantHeadingCandidates(title, chapterIndex);

  while (lines.length) {
    while (lines.length && !lines[0].trim()) lines.shift();
    if (!lines.length) break;

    const first = normalizeCompareKey(lines[0]);
    const firstTwo = normalizeCompareKey([lines[0], lines[1] || ''].join(' '));
    let removed = false;

    if (first && candidates.includes(first)) {
      lines.shift();
      removed = true;
    } else if (firstTwo && candidates.includes(firstTwo)) {
      lines.shift();
      if (lines.length) lines.shift();
      removed = true;
    }

    if (!removed) break;
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ==========================================
// 最终输出章节整理
// ==========================================

/** 最终输出前，对章节标题和内容做统一整理 */
function prepareFinalOutputChapters(finalChapters = []) {
  const prepared = [];
  let chapterCounter = 0;

  for (const item of finalChapters || []) {
    const rawTitle = normalizeLooseLine(item?.title || '');
    if (!rawTitle) continue;

    if (isCatalogSectionTitle(rawTitle)) {
      prepared.push({
        ...item,
        title: '目录',
        content: normalizeTxtBodyWhitespace(item.content || ''),
      });
      continue;
    }

    if (isNonContentSectionTitle(rawTitle)) {
      prepared.push({
        ...item,
        title: NON_CONTENT_SECTION_TITLE,
        content: normalizeTxtBodyWhitespace(item.content || ''),
      });
      continue;
    }

    chapterCounter += 1;
    const finalTitle = normalizeChapterTitleForIndex(rawTitle, chapterCounter);
    const finalBody = stripLeadingRedundantHeadingBlock(item.content || '', finalTitle, chapterCounter);

    prepared.push({
      ...item,
      title: finalTitle,
      content: finalBody,
    });
  }

  return prepared;
}

/** 渲染最终 TXT，自动生成目录 */
function renderTxtWithCatalog(finalChapters = []) {
  const prepared = prepareFinalOutputChapters(finalChapters);
  const frontBlocks = [];
  const chapterBlocks = [];

  for (const item of prepared) {
    if (isCatalogSectionTitle(item.title)) continue;
    if (isNonContentSectionTitle(item.title)) frontBlocks.push(item);
    else chapterBlocks.push(item);
  }

  const sections = [];

  for (const item of frontBlocks) {
    if ((item.content || '').trim()) {
      sections.push(`### ${item.title}\n\n${item.content.trim()}`);
    }
  }

  if (chapterBlocks.length) {
    sections.push(`### 目录\n\n${chapterBlocks.map((item) => item.title).join('\n')}`);
  }

  for (const item of chapterBlocks) {
    const body = (item.content || '').trim();
    sections.push(`### ${item.title}\n\n${body}`);
  }

  return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 从中间合并文本重新构造章节 */
function buildFinalChapters(fullTranslatedText) {
  const splitRegex = /(?:^|\n)###\s*(.+?)(?:\n|$)/g;
  const finalChapters = [];
  let match;
  let globalChapterCount = 0;

  while ((match = splitRegex.exec(fullTranslatedText)) !== null) {
    const rawMatchedTitle = normalizeLooseLine(match[1]);
    const contentStartIndex = match.index + match[0].length;
    const nextTitleIndex = fullTranslatedText.slice(contentStartIndex).search(/(?:^|\n)###\s*/);

    let chapterContent =
      nextTitleIndex === -1
        ? fullTranslatedText.slice(contentStartIndex)
        : fullTranslatedText.slice(contentStartIndex, contentStartIndex + nextTitleIndex);

    if (chapterContent.trim().length > 0) {
      let normalizedTitle = rawMatchedTitle;

      if (isNonContentSectionTitle(rawMatchedTitle)) {
        normalizedTitle = NON_CONTENT_SECTION_TITLE;
      } else if (isCatalogSectionTitle(rawMatchedTitle)) {
        normalizedTitle = '目录';
      } else {
        globalChapterCount += 1;
        normalizedTitle = normalizeChapterTitleForIndex(rawMatchedTitle, globalChapterCount);
      }

      chapterContent = stripLeadingDuplicateTitleLine(chapterContent.trim(), normalizedTitle);

      finalChapters.push({
        title: normalizedTitle,
        content: chapterContent.trim(),
      });
    }
  }

  if (finalChapters.length === 0) {
    finalChapters.push({ title: '第1章', content: fullTranslatedText.trim() });
  }

  return finalChapters;
}

// ==========================================
// Chapter-Aware Balanced Chunking v2
// ==========================================

/** 取 UTF-8 字节长度 */
function getUtf8ByteLength(text = '') {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

/** 生成标准 chunk id */
function makeChunkId(index) {
  return `chunk_${String(index).padStart(3, '0')}`;
}

/** 判断是否是强句末标点 */
function isSentenceEndingChar(char) {
  return /[。！？!?；;…]/.test(char);
}

/** 在文本中寻找一个句子边界 */
function findSentenceBoundary(text, start) {
  let index = start;

  while (index < text.length) {
    const char = text[index];
    const nextChar = text[index + 1] || '';
    const previousChar = text[index - 1] || '';

    if (char === '\n' && nextChar === '\n') {
      let end = index + 2;
      while (end < text.length && /[\s\u3000]/.test(text[end])) end += 1;
      return end;
    }

    if (char === '.' && previousChar === '.' && nextChar === '.') {
      let end = index + 2;
      while (end < text.length && /["'”’）)\]\s]/.test(text[end])) end += 1;
      while (end < text.length && /[\s\u3000]/.test(text[end])) end += 1;
      return end;
    }

    if (char === '.') {
      const isDecimalPoint = /\d/.test(previousChar) && /\d/.test(nextChar);
      const nextLooksLikeSentenceBreak = !nextChar || /[\s\u3000\n"'”’）)\]]/.test(nextChar);
      if (!isDecimalPoint && nextLooksLikeSentenceBreak) {
        let end = index + 1;
        while (end < text.length && /["'”’）)\]\s]/.test(text[end])) end += 1;
        while (end < text.length && /[\s\u3000]/.test(text[end])) end += 1;
        return end;
      }
    }

    if (isSentenceEndingChar(char)) {
      let end = index + 1;
      while (end < text.length && /["'”’）)\]〗》」』]/.test(text[end])) end += 1;
      while (end < text.length && /[\s\u3000]/.test(text[end])) end += 1;
      return end;
    }

    index += 1;
  }

  return text.length;
}

/** 把文本切成句子单元 */
function collectSentenceUnits(text) {
  const units = [];
  let start = 0;

  while (start < text.length) {
    const end = findSentenceBoundary(text, start);
    if (end <= start) break;
    units.push(text.slice(start, end));
    start = end;
  }

  if (units.length === 0 && text.trim()) units.push(text);
  return units;
}

/** 把一个段落切成句子单元 */
function splitParagraphIntoSentenceUnits(text = '') {
  const normalized = normalizeTxtBodyWhitespace(text);
  if (!normalized) return [];
  return collectSentenceUnits(normalized);
}

/** 获取 chunking 用的章节标题 */
function getChunkChapterTitle(chapter = {}, chapterIndex = 0) {
  return normalizeLooseLine(
    chapter.translatedTitle || chapter.title || chapter.originalTitle || `Chapter ${chapterIndex + 1}`,
  );
}

/** 构造“带章节/段落位置信息”的句子单元流 */
function buildChapterAwareSentenceUnits(cleanChapters = []) {
  const units = [];

  cleanChapters.forEach((chapter, chapterIndex) => {
    const title = getChunkChapterTitle(chapter, chapterIndex);
    const rawBody = normalizeTxtBodyWhitespace(chapter?.content || '');

    if (title) {
      const headingText = `\n\n### ${title}\n\n`;
      units.push({
        type: 'chapter-heading',
        text: headingText,
        size: getUtf8ByteLength(headingText),
        chapterIndex,
        paragraphIndex: -1,
        sentenceIndexInParagraph: -1,
        paragraphSentenceCount: 0,
        sentenceIndexInChapter: -1,
        chapterSentenceCount: 0,
        isChapterHeading: true,
        isChapterStartZone: true,
        isChapterEndZone: false,
        isParagraphStart: false,
        isParagraphEnd: false,
      });
    }

    const paragraphs = rawBody
      .split(/\n{2,}/)
      .map((item) => item.trim())
      .filter(Boolean);

    const paragraphSentences = paragraphs.map((paragraph) => splitParagraphIntoSentenceUnits(paragraph));
    const chapterSentenceCount = paragraphSentences.reduce((sum, list) => sum + list.length, 0);

    let chapterSentenceCursor = 0;

    paragraphSentences.forEach((sentenceList, paragraphIndex) => {
      sentenceList.forEach((sentence, sentenceIndexInParagraph) => {
        const sentenceIndexInChapter = chapterSentenceCursor;
        chapterSentenceCursor += 1;

        const isParagraphEnd = sentenceIndexInParagraph === sentenceList.length - 1;
        const tail = isParagraphEnd ? '\n\n' : '';
        const sentenceText = `${sentence}${tail}`;

        const nearChapterStart = sentenceIndexInChapter < CHAPTER_EDGE_AVOID_SENTENCE_COUNT;
        const nearChapterEnd =
          chapterSentenceCount - sentenceIndexInChapter - 1 < CHAPTER_EDGE_AVOID_SENTENCE_COUNT;

        units.push({
          type: 'sentence',
          text: sentenceText,
          size: getUtf8ByteLength(sentenceText),
          chapterIndex,
          paragraphIndex,
          sentenceIndexInParagraph,
          paragraphSentenceCount: sentenceList.length,
          sentenceIndexInChapter,
          chapterSentenceCount,
          isChapterHeading: false,
          isChapterStartZone: nearChapterStart,
          isChapterEndZone: nearChapterEnd,
          isParagraphStart: sentenceIndexInParagraph === 0,
          isParagraphEnd,
        });
      });
    });
  });

  return units.filter((item) => item.size > 0);
}

/** 前缀和数组 */
function buildPrefixSizes(units = []) {
  const prefix = [0];
  for (const unit of units) prefix.push(prefix[prefix.length - 1] + unit.size);
  return prefix;
}

/** 求区间字节长度 */
function rangeSize(prefix = [], start = 0, end = 0) {
  return prefix[end] - prefix[start];
}

/** 前缀和 lower bound */
function lowerBoundPrefix(prefix = [], target = 0) {
  let left = 0;
  let right = prefix.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (prefix[mid] < target) left = mid + 1;
    else right = mid;
  }
  return left;
}

/** 前缀和 upper bound */
function upperBoundPrefix(prefix = [], target = 0) {
  let left = 0;
  let right = prefix.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (prefix[mid] <= target) left = mid;
    else right = mid - 1;
  }
  return left;
}

/** 给一个切点打分 */
function scoreCutBoundary(units = [], cutIndex = 0) {
  const prev = units[cutIndex - 1];
  const next = units[cutIndex];
  if (!prev || !next) return -999999;

  let score = 0;

  if (prev.chapterIndex !== next.chapterIndex) score += 9000;
  else if (prev.isParagraphEnd || next.isParagraphStart) score += 2200;

  if (next.isChapterHeading) score += 1800;
  if (prev.isParagraphEnd) score += 300;
  if (next.isParagraphStart) score += 180;

  if (next.isChapterStartZone) score -= 3500;
  if (prev.isChapterEndZone) score -= 3500;

  return score;
}

/** 给一个 chunk 大小打分 */
function scoreChunkSize(chunkSize, idealSize) {
  const diff = Math.abs(chunkSize - idealSize);
  const tooSmallPenalty = chunkSize < idealSize * 0.55 ? 1200 : 0;
  const tooLargePenalty = chunkSize > idealSize * 1.08 ? (chunkSize - idealSize) * 0.12 : 0;
  return -(diff + tooSmallPenalty + tooLargePenalty);
}

/** 是否是强边界 */
function isStrongBoundary(units = [], cutIndex = 0) {
  const prev = units[cutIndex - 1];
  const next = units[cutIndex];
  if (!prev || !next) return false;
  if (prev.chapterIndex !== next.chapterIndex) return true;
  if (prev.isParagraphEnd || next.isParagraphStart) return true;
  return false;
}

/** 构造某一步 DP 的候选切点 */
function buildCandidateEnds({
  units = [],
  prefix = [],
  start = 0,
  chunkIndex = 0,
  targetChunkCount = 1,
} = {}) {
  const totalUnits = units.length;
  const totalSize = prefix[totalUnits];
  const idealSize = totalSize / targetChunkCount;
  const remainingChunks = targetChunkCount - chunkIndex;
  const minEnd = start + 1;

  const hardMaxEnd = Math.min(
    upperBoundPrefix(prefix, prefix[start] + HARD_CHUNK_LIMIT),
    totalUnits - (remainingChunks - 1),
  );

  if (minEnd > hardMaxEnd) return [];

  const idealEndByPrefix = lowerBoundPrefix(prefix, prefix[start] + idealSize);
  const idealEnd = Math.max(minEnd, Math.min(hardMaxEnd, idealEndByPrefix));

  const candidateSet = new Set([idealEnd, hardMaxEnd]);

  for (let d = 1; d <= CHUNKING_DP_CANDIDATE_RADIUS; d++) {
    const left = idealEnd - d;
    const right = idealEnd + d;
    if (left >= minEnd) candidateSet.add(left);
    if (right <= hardMaxEnd) candidateSet.add(right);
  }

  const candidates = [...candidateSet]
    .filter((end) => end >= minEnd && end <= hardMaxEnd)
    .map((end) => {
      const cutScore = end < totalUnits ? scoreCutBoundary(units, end) : 0;
      const chunkSize = rangeSize(prefix, start, end);
      const sizeScore = scoreChunkSize(chunkSize, idealSize);
      const boundaryBoost = isStrongBoundary(units, end) ? 600 : 0;
      return { end, score: cutScore + sizeScore + boundaryBoost, chunkSize };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, CHUNKING_DP_MAX_CANDIDATES_PER_STEP);

  return candidates.map((item) => item.end);
}

/** 用 DP 规划在 targetChunkCount 段下的最佳切法 */
function planBalancedChunkEndsByDP(units = [], targetChunkCount = 1) {
  const prefix = buildPrefixSizes(units);
  const totalUnits = units.length;
  const totalSize = prefix[totalUnits];
  const idealSize = totalSize / targetChunkCount;
  const memo = new Map();

  function solve(start, chunkIndex) {
    const key = `${start}|${chunkIndex}`;
    if (memo.has(key)) return memo.get(key);

    const remainingChunkCount = targetChunkCount - chunkIndex;
    const remainingSize = totalSize - prefix[start];

    if (remainingSize > remainingChunkCount * HARD_CHUNK_LIMIT) {
      memo.set(key, null);
      return null;
    }

    if (chunkIndex === targetChunkCount - 1) {
      const finalSize = rangeSize(prefix, start, totalUnits);
      if (finalSize > HARD_CHUNK_LIMIT) {
        memo.set(key, null);
        return null;
      }

      const result = {
        score: scoreChunkSize(finalSize, idealSize),
        ends: [totalUnits],
      };
      memo.set(key, result);
      return result;
    }

    const candidateEnds = buildCandidateEnds({
      units,
      prefix,
      start,
      chunkIndex,
      targetChunkCount,
    });

    let best = null;

    for (const end of candidateEnds) {
      const currentSize = rangeSize(prefix, start, end);
      if (currentSize > HARD_CHUNK_LIMIT) continue;

      const nextRemainingSize = totalSize - prefix[end];
      const nextRemainingChunkCount = targetChunkCount - chunkIndex - 1;

      if (nextRemainingSize > nextRemainingChunkCount * HARD_CHUNK_LIMIT) continue;
      if (nextRemainingChunkCount <= 0) continue;

      const next = solve(end, chunkIndex + 1);
      if (!next) continue;

      const boundaryScore = end < totalUnits ? scoreCutBoundary(units, end) : 0;
      const localScore =
        scoreChunkSize(currentSize, idealSize) +
        boundaryScore +
        (isStrongBoundary(units, end) ? 600 : 0);

      const totalScore = localScore + next.score;

      if (!best || totalScore > best.score) {
        best = { score: totalScore, ends: [end, ...next.ends] };
      }
    }

    memo.set(key, best);
    return best;
  }

  return solve(0, 0);
}

/** 从句子单元渲染某个 chunk 文本 */
function renderChunkTextFromUnits(units = [], start = 0, end = 0) {
  return units
    .slice(start, end)
    .map((item) => item.text)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 根据切点端点把 chunk 实体化 */
function materializeBalancedChunks(cleanChapters = [], units = [], endIndexes = []) {
  const chunks = [];
  let start = 0;

  for (let i = 0; i < endIndexes.length; i++) {
    const end = endIndexes[i];
    const text = renderChunkTextFromUnits(units, start, end);
    const slice = units.slice(start, end);
    const chapterIndexes = [
      ...new Set(slice.map((item) => item.chapterIndex).filter((n) => Number.isInteger(n))),
    ];

    const chunkId = makeChunkId(i + 1);
    const sourceLength = getUtf8ByteLength(text);

    chunks.push({
      id: chunkId,
      chunkId,
      name: chunkId,
      text,
      content: text,
      sourceLength,
      startUnitIndex: start,
      endUnitIndex: end - 1,
      chapterIndexes,
      chapterTitles: chapterIndexes.map((idx) => getChunkChapterTitle(cleanChapters[idx], idx)),
      chapterStartIndex: chapterIndexes[0] ?? 0,
      chapterEndIndex: chapterIndexes[chapterIndexes.length - 1] ?? 0,
    });

    start = end;
  }

  return chunks;
}

/** 打印 chunking 统计 */
function logBalancedChunkingStats(chunks = [], totalSize = 0, theoreticalMin = 1) {
  if (!LOG_CHUNKING_STATS) return;

  const sizes = chunks.map((c) => c.sourceLength);
  const avg = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
  const min = sizes.length ? Math.min(...sizes) : 0;
  const max = sizes.length ? Math.max(...sizes) : 0;

  console.log(
    `📦 [Chunking v2] theoreticalMin=${theoreticalMin} | final=${chunks.length} | totalBytes=${totalSize} | avg=${avg} | min=${min} | max=${max}`,
  );
}

/** 章节感知均衡分块：理论最少段数优先，只有装不下才升 N+1 */
function streamChunkingStrategyByChapterAwareBalancedCount(cleanChapters = []) {
  const units = buildChapterAwareSentenceUnits(cleanChapters);
  if (!units.length) return [];

  const totalSize = units.reduce((sum, item) => sum + item.size, 0);
  const theoreticalMinChunkCount = Math.max(1, Math.ceil(totalSize / HARD_CHUNK_LIMIT));

  let plannedEnds = null;
  let chosenChunkCount = theoreticalMinChunkCount;

  for (
    let targetChunkCount = theoreticalMinChunkCount;
    targetChunkCount <= Math.min(
      units.length,
      theoreticalMinChunkCount + CHUNKING_MAX_EXTRA_CHUNKS_BEYOND_THEORETICAL_MIN,
    );
    targetChunkCount++
  ) {
    const plan = planBalancedChunkEndsByDP(units, targetChunkCount);
    if (plan?.ends?.length === targetChunkCount) {
      plannedEnds = plan.ends;
      chosenChunkCount = targetChunkCount;
      break;
    }
  }

  if (!plannedEnds) {
    throw new Error(
      `Chapter-Aware Balanced Chunking v2 失败：在整句约束下，从理论最少 ${theoreticalMinChunkCount} 段开始尝试，仍无法构造合法分块。`,
    );
  }

  const chunks = materializeBalancedChunks(cleanChapters, units, plannedEnds);

  if (chunks.length !== chosenChunkCount) {
    throw new Error(`Chunk 数异常：期待 ${chosenChunkCount}，实际 ${chunks.length}`);
  }

  const hasOverflow = chunks.some((chunk) => chunk.sourceLength > HARD_CHUNK_LIMIT);
  if (hasOverflow) {
    throw new Error('Chunking v2 结果异常：存在超过 HARD_CHUNK_LIMIT 的 chunk。');
  }

  logBalancedChunkingStats(chunks, totalSize, theoreticalMinChunkCount);
  return chunks;
}

/** 把一个 chunk 按整句二分 */
function splitChunkIntoTwoSentenceAware(text) {
  const sentences = collectSentenceUnits(text);
  if (sentences.length < 2 || text.length < 1200) return null;

  const totalLength = sentences.reduce((sum, item) => sum + item.length, 0);
  const target = totalLength / 2;

  let running = 0;
  let splitIndex = -1;

  for (let i = 0; i < sentences.length; i++) {
    running += sentences[i].length;
    if (running >= target) {
      splitIndex = i + 1;
      break;
    }
  }

  if (splitIndex <= 0 || splitIndex >= sentences.length) {
    splitIndex = Math.floor(sentences.length / 2);
  }

  const left = sentences.slice(0, splitIndex).join('').trim();
  const right = sentences.slice(splitIndex).join('').trim();

  if (!left || !right) return null;
  return [left, right];
}

// ==========================================
// 自检 / 正文翻译
// ==========================================

/** 计算文本 KB 大小 */
function byteSizeKb(text) {
  return Buffer.byteLength(text || '', 'utf-8') / 1024;
}

/** 动态输出熔断阈值 */
function getDynamicOutputFuse(sourceLength) {
  const safeSourceLength = Math.max(0, Number(sourceLength) || 0);
  return Math.max(
    OUTPUT_FUSE_BASE,
    Math.min(
      OUTPUT_FUSE_MAX,
      Math.floor(safeSourceLength * OUTPUT_FUSE_RATIO) + OUTPUT_FUSE_PADDING,
    ),
  );
}

/** 对译文做自检 */
function evaluateTranslatedBlock(sourceText, translatedText) {
  const sourceLength = (sourceText || '').length;
  const output = (translatedText || '').trim();
  const outputLength = output.length;
  const ratio = sourceLength > 0 ? (outputLength / sourceLength) * 100 : 100;
  const sizeKb = byteSizeKb(output);
  const dynamicOutputFuse = getDynamicOutputFuse(sourceLength);

  if (!output) throw new Error('Self-Check: Empty Output');
  if (/^(i('| a)m sorry|sorry,|i can'?t|i cannot|as an ai|here is the translation)/i.test(output)) {
    throw new Error('Self-Check: Refusal / Meta Response');
  }
  if (outputLength > dynamicOutputFuse) {
    throw new Error(`Self-Check: Output Fuse > ${dynamicOutputFuse}`);
  }
  if (sourceLength > 500 && ratio > 110) {
    throw new Error(`Self-Check: Length Fuse ${ratio.toFixed(1)}% > 110%`);
  }
  if (sourceLength >= 22000 && (ratio < 18 || sizeKb < 16)) {
    throw new Error(`Self-Check: Small File Fuse ${sizeKb.toFixed(2)} KB / ${ratio.toFixed(1)}%`);
  }
  if (sourceLength >= 16000 && (ratio < 14 || sizeKb < 10)) {
    throw new Error(`Self-Check: Small File Fuse ${sizeKb.toFixed(2)} KB / ${ratio.toFixed(1)}%`);
  }
  if (sourceLength >= 8000 && outputLength < 800) {
    throw new Error(`Self-Check: Output Too Short ${outputLength} chars`);
  }

  return { ratio, sizeKb, dynamicOutputFuse };
}

/** 清理译文尾部废话 */
function cleanTranslatedText(text) {
  return String(text || '')
    .replace(/〖?\s*全\s*书\s*完\s*〗?[\s\S]*/i, '')
    .replace(/（\s*注\s*：\s*.*）/g, '')
    .replace(/出版说明/g, '')
    .trim();
}

/** 单次正文翻译尝试：注意这里只用 FLASH_MODEL_NAME */
async function translateChunkOnce(text, customInstruction, temperature, label = '') {
  const result = await callGeminiGenerateContent(
    PRIMARY_MODEL_NAME,
    [{ role: 'user', parts: [{ text }] }],
    { generationConfig: { temperature }, systemInstruction: customInstruction },
  );

  const translatedText = extractResponseText(result)
    .replace(/^(Here is|Okay|Sure|Translation).*?[\r\n]+/gi, '')
    .replace(/^```markdown|```$/gi, '')
    .trim();

  const selfCheck = evaluateTranslatedBlock(text, translatedText);
  const fuseLog = LOG_DYNAMIC_OUTPUT_FUSE ? ` | 熔断阈值: ${selfCheck.dynamicOutputFuse}` : '';

  console.log(
    `✅ 自检${label || '正常'} | temperature=${temperature} | 长度比: ${selfCheck.ratio.toFixed(
      1,
    )}% | 文件大小: ${selfCheck.sizeKb.toFixed(2)} KB${fuseLog}`,
  );

  return {
    text: translatedText,
    ratio: selfCheck.ratio,
    sizeKb: selfCheck.sizeKb,
  };
}

/** 合并多个分段译文，并再次做总自检 */
function mergeTranslationResults(sourceText, parts, label = '') {
  const mergedText = parts.map((part) => part.text).join('\n\n').trim();
  const selfCheck = evaluateTranslatedBlock(sourceText, mergedText);
  const fuseLog = LOG_DYNAMIC_OUTPUT_FUSE ? ` | 熔断阈值: ${selfCheck.dynamicOutputFuse}` : '';

  console.log(
    `✅ 自检 ${label || '合并通过'} | 长度比: ${selfCheck.ratio.toFixed(1)}% | 文件大小: ${selfCheck.sizeKb.toFixed(
      2,
    )} KB${fuseLog}`,
  );

  return {
    text: mergedText,
    ratio: selfCheck.ratio,
    sizeKb: selfCheck.sizeKb,
  };
}

function rethrowIfShouldAbortTranslation(error) {
  if (isAllFlashKeysDailyLimitReachedError(error)) throw error;
  if (isRetryableGeminiError(error)) throw error;
}

/** 第三次失败后的策略 */
async function translateChunkAfterThirdFailure(text, customInstruction, pathLabel) {
  console.warn('⚠️ [Fail 3] ' + pathLabel + ' 进入三次策略：temperature=0.2，并按整句二分继续任务。');

  const split = splitChunkIntoTwoSentenceAware(text);
  if (!split) {
    return translateChunkOnce(text, customInstruction, 0.2, pathLabel + ' | 末次直译');
  }

  const results = [];
  for (let i = 0; i < split.length; i++) {
    results.push(
      await translateChunkOnce(
        split[i],
        customInstruction,
        0.2,
        pathLabel + '.' + (i + 1) + ' | 末次子段'
      )
    );
  }

  return mergeTranslationResults(text, results, pathLabel + ' | 末次二分合并');
}

/** 第二次失败后的策略 */
async function translateChunkAfterSecondFailure(text, customInstruction, pathLabel) {
  console.warn('⚠️ [Fail 2] ' + pathLabel + ' 进入二次策略：temperature=0.1，并按整句二分继续任务。');
  const split = splitChunkIntoTwoSentenceAware(text);

  if (!split) {
    console.warn('⚠️ [Split Skip] ' + pathLabel + ' 无法可靠整句二分，先直接以 temperature=0.1 重试；若仍失败则进入第三次策略。');
    try {
      return await translateChunkOnce(text, customInstruction, 0.1, pathLabel + ' | 二次直译');
    } catch (e) {
      rethrowIfShouldAbortTranslation(e);
      console.warn('↳ ' + pathLabel + ' 二次直译失败: ' + (e?.message || String(e)));
      return translateChunkAfterThirdFailure(text, customInstruction, pathLabel + '.fallback');
    }
  }

  const results = [];
  for (let i = 0; i < split.length; i++) {
    const piece = split[i];
    const pieceLabel = pathLabel + '.' + (i + 1);

    try {
      results.push(await translateChunkOnce(piece, customInstruction, 0.1, pieceLabel + ' | 二分子段'));
    } catch (e) {
      rethrowIfShouldAbortTranslation(e);
      console.warn('↳ ' + pieceLabel + ' 二分子段失败: ' + (e?.message || String(e)));
      results.push(await translateChunkAfterThirdFailure(piece, customInstruction, pieceLabel));
    }
  }

  return mergeTranslationResults(text, results, pathLabel + ' | 二分合并');
}

/** 第一次失败后的策略 */
async function translateChunkAfterFirstFailure(text, customInstruction, pathLabel) {
  console.warn('⚠️ [Fail 1] ' + pathLabel + ' 进入首次失败策略：temperature=0，并按整句二分继续任务。');

  const split = splitChunkIntoTwoSentenceAware(text);
  if (!split) {
    console.warn('⚠️ [Split Skip] ' + pathLabel + ' 无法可靠整句二分，先直接以 temperature=0 重试；若仍失败则进入第二次策略。');
    try {
      return await translateChunkOnce(text, customInstruction, 0, pathLabel + ' | 首次直译');
    } catch (e) {
      rethrowIfShouldAbortTranslation(e);
      console.warn('↳ ' + pathLabel + ' 首次直译失败: ' + (e?.message || String(e)));
      return translateChunkAfterSecondFailure(text, customInstruction, pathLabel + '.fallback');
    }
  }

  const results = [];
  for (let i = 0; i < split.length; i++) {
    const piece = split[i];
    const pieceLabel = pathLabel + '.' + (i + 1);

    try {
      results.push(await translateChunkOnce(piece, customInstruction, 0, pieceLabel + ' | 首次二分子段'));
    } catch (e) {
      rethrowIfShouldAbortTranslation(e);
      console.warn('↳ ' + pieceLabel + ' 首次二分子段失败: ' + (e?.message || String(e)));
      results.push(await translateChunkAfterSecondFailure(piece, customInstruction, pieceLabel));
    }
  }

  return mergeTranslationResults(text, results, pathLabel + ' | 首次二分合并');
}

/** 正文智能翻译器：这里只走 Flash 主力 */
async function translateChunkSmart(chunk, customInstruction) {
  const text = typeof chunk === 'string' ? chunk : chunk?.text || chunk?.content || '';

  try {
    return await translateChunkOnce(text, customInstruction, 0, '初始尝试');
  } catch (e1) {
    rethrowIfShouldAbortTranslation(e1);
    console.warn('↳ 原始错误: ' + (e1?.message || String(e1)));

    try {
      return await translateChunkAfterFirstFailure(text, customInstruction, 'root');
    } catch (e2) {
      rethrowIfShouldAbortTranslation(e2);
      console.warn('↳ 首次失败策略仍未通过: ' + (e2?.message || String(e2)));

      try {
        return await translateChunkAfterSecondFailure(text, customInstruction, 'root.retry2');
      } catch (e3) {
        rethrowIfShouldAbortTranslation(e3);
        console.warn('↳ 二次失败策略仍未通过: ' + (e3?.message || String(e3)));
        return translateChunkAfterThirdFailure(text, customInstruction, 'root.retry3');
      }
    }
  }
}

// ==========================================
// 边界审计 / 清洗
// ==========================================

/** 头部可能的非正文边界模式 */
const HEAD_BOUNDARY_PATTERNS = [
  /^contents?$/i,
  /^table of contents$/i,
  /^introduction$/i,
  /^preface$/i,
  /^prologue$/i,
  /^foreword$/i,
  /^transcriber'?s notes?$/i,
  /^project gutenberg/i,
  /^standard ebooks/i,
  /^archive\.org/i,
  /^illustrations?$/i,
];

/** 尾部可能的非正文边界模式 */
const TAIL_BOUNDARY_PATTERNS = [
  /^the end\.?$/i,
  /^end\.?$/i,
  /^transcriber'?s notes?$/i,
  /^end of (the )?(project gutenberg|project gutenberg ebook)/i,
  /^project gutenberg/i,
  /^standard ebooks/i,
  /^archive\.org/i,
];

/** 在一定范围内寻找边界命中位置 */
function findBoundaryIndex(lines, patterns, direction = 'forward', rangeRatio = 0.1) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;

  const span = Math.max(10, Math.ceil(lines.length * rangeRatio));

  if (direction === 'forward') {
    for (let i = 0; i < Math.min(span, lines.length); i++) {
      const line = normalizeBoundaryLine(lines[i]);
      if (patterns.some((pattern) => pattern.test(line))) return i;
    }
    return -1;
  }

  const start = Math.max(0, lines.length - span);
  for (let i = lines.length - 1; i >= start; i--) {
    const line = normalizeBoundaryLine(lines[i]);
    if (patterns.some((pattern) => pattern.test(line))) return i;
  }

  return -1;
}

/** 只做审计日志，不实际截断 */
function auditTxtBoundaries(rawText) {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  const headIndex = findBoundaryIndex(lines, HEAD_BOUNDARY_PATTERNS, 'forward', 0.1);
  const tailIndex = findBoundaryIndex(lines, TAIL_BOUNDARY_PATTERNS, 'backward', 0.1);

  console.log('🧹 [Boundary Audit] 纯净原文边界巡检...');
  console.log(`   ↳ 前 10% 命中: ${headIndex >= 0 ? `L${headIndex + 1}` : '未命中'}`);
  console.log(`   ↳ 后 10% 命中: ${tailIndex >= 0 ? `L${tailIndex + 1}` : '未命中'}`);

  return rawText;
}

/** 实际裁掉头尾明显的非正文边界 */
function trimPureSourceBoundaries(rawText) {
  let text = String(rawText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const illustrationMatch = text.slice(0, 5000).match(/^[^\n]*illustration[^\n]*$/im);

  if (illustrationMatch && illustrationMatch.index > 0) {
    const prefix = text.slice(0, illustrationMatch.index);
    if (prefix.replace(/\s+/g, '').length < 1200) {
      text = text.slice(illustrationMatch.index);
    }
  }

  const lines = text.split('\n');
  let startIndex = 0;
  let endIndex = lines.length;

  const headIndex = findBoundaryIndex(lines, HEAD_BOUNDARY_PATTERNS, 'forward', 0.1);
  if (headIndex >= 0) startIndex = Math.min(lines.length, headIndex + 1);

  const tailIndex = findBoundaryIndex(lines, TAIL_BOUNDARY_PATTERNS, 'backward', 0.1);
  if (tailIndex >= 0 && tailIndex > startIndex) endIndex = tailIndex;

  return lines.slice(startIndex, endIndex).join('\n').trim();
}

/** 核心文本清洗 */
function cleanTextCore(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*Page\s+\d+\s*$/gim, '')
    .replace(/^\s*\d+\s*$/gm, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/^\s*(Project Gutenberg|Produced by|Distributed Proofreaders|standardebooks\.org|archive\.org).*$/gim, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ==========================================
// 资源输出
// ==========================================

/** 输出纯净原文 TXT */
async function savePureSourceTxt(cleanChapters, originalBookTitle, originalAuthor, outputDir, taskTimeStr) {
  const fileName = `纯净原文_${taskTimeStr}_331.txt`;
  const filePath = path.join(outputDir, fileName);

  const body = [
    `Title: ${originalBookTitle || 'Unknown'}`,
    `Author: ${originalAuthor || 'Unknown'}`,
    '',
    ...cleanChapters.map((chapter) => `### ${chapter.title}\n\n${chapter.content}`),
  ].join('\n\n');

  await fs.writeFile(filePath, body, 'utf-8');
  console.log(`📄 [Pure TXT] 已输出清洗底本: ${fileName}`);
  return fileName;
}

/** 输出结构清单 manifest */
function saveStructureManifest(outputDir, bookName, identity, cleanChapters) {
  if (!ENABLE_STRUCTURE_MANIFEST) return;

  const manifestPath = path.join(outputDir, 'structure_manifest.json');
  const manifest = {
    bookId: `${bookName}_${Date.now()}`,
    meta: {
      originalTitle: identity.originalBookName || '',
      cnTitle: identity.cnBookName || '',
      author: identity.cnAuthor || identity.originalAuthor || '',
      source: identity.source || '',
    },
    chapters: cleanChapters.map((ch, idx) => ({
      index: idx,
      originalTitle: ch.title,
      translatedFile: `Chapter_${String(idx + 1).padStart(3, '0')}.md`,
      preview: (ch.content || '').slice(0, 100),
    })),
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`🗂️ [Manifest] 结构蓝图已生成: structure_manifest.json (共 ${manifest.chapters.length} 章)`);
}

/** 生成译后 EPUB */
async function generateTranslatedEpub(bookName, author, finalChapters, epubPath) {
  const content = finalChapters
    .filter((chapter) => !isCatalogSectionTitle(chapter.title) && !isNonContentSectionTitle(chapter.title))
    .map((chapter) => ({
      title: chapter.title,
      data: chapter.content
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `<p>${line.replace(/\*\*(.*?)\*\*/g, '$1')}</p>`)
        .join(''),
    }));

  await new EpubGen(
    {
      title: bookName,
      author,
      tocTitle: '目录',
      content,
    },
    epubPath,
  ).promise;

  console.log(`📘 [EPUB] 生成成功: ${path.basename(epubPath)}`);
  return { epubPath };
}

/** 识别由生成器自动插入的 TOC 章节 */
function isLikelyGeneratedTocChapter(chapter) {
  const title = normalizeBoundaryLine(chapter.title || '');
  if (/^(contents?|toc|目录|cover|title page)$/i.test(title)) return true;

  const lines = decodeBasicHtmlEntities(chapter.content || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length >= 3) {
    const catalogLineCount = lines.filter(isLikelyCatalogLine).length;
    if (catalogLineCount >= 3 && catalogLineCount / lines.length >= 0.6) return true;
  }

  return false;
}

/** EPUB 回读为 TXT 前，先归一化正文 */
function normalizeReadbackTxtBody(text) {
  const lines = decodeBasicHtmlEntities(text || '')
    .replace(/\u00A0/g, ' ')
    .split('\n')
    .map((line) => line.trim());

  const cleaned = [];
  for (const line of lines) {
    if (!line && cleaned[cleaned.length - 1] === '') continue;
    cleaned.push(line);
  }

  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 把生成好的 EPUB 再回读导出成 TXT */
async function exportGeneratedEpubToTxt(epubPath, txtPath) {
  const epubData = await parseEpubStructure(epubPath);
  const filteredChapters = epubData.chapters.filter((chapter) => !isLikelyGeneratedTocChapter(chapter));

  const finalChapters = filteredChapters.map((chapter, index) => ({
    title: normalizeChapterTitleForIndex(chapter.title, index + 1),
    content: normalizeReadbackTxtBody(chapter.content),
  }));

  const content = renderTxtWithCatalog(finalChapters);
  await fs.writeFile(txtPath, content, 'utf-8');
  console.log(`📄 [TXT] 由精修 EPUB 回读导出成功: ${path.basename(txtPath)}`);
  return txtPath;
}

// ==========================================
// 恢复 / 书籍信息读取
// ==========================================

/** 规范化原文标题候选 */
function sanitizeOriginalTitleCandidate(text = '') {
  return normalizeLooseLine(
    String(text || '')
      .replace(/^[\s"'“”‘’《》「」『』【】\[\]\(\)]+/g, '')
      .replace(/[\s"'“”‘’《》「」『』【】\[\]\(\)]+$/g, ''),
  ).trim();
}

function looksLikeRawBookTitleLine(line = '') {
  const text = sanitizeOriginalTitleCandidate(line);
  if (!text) return false;
  if (text.length > 120) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (
    /^(author|by|chapter|book\s+\w+|contents?|table of contents|preface|introduction|prologue|epilogue|copyright|translator|editor|project gutenberg|produced by|distributed proofreaders|illustrations?|list of illustrations|www\.|https?:)/i.test(
      text,
    )
  ) {
    return false;
  }
  return true;
}

/** 从 TXT 原文前部解析一个“原文书名锚点候选” */
function resolveOriginalTitleAnchorCandidate(args = {}) {
  const rawText = args.rawText || '';
  const fallbackTitle = args.fallbackTitle || '';
  const fileBaseName = args.fileBaseName || '';
  const candidates = [];

  function pushCandidate(title, evidenceLine, confidence) {
    const cleaned = sanitizeOriginalTitleCandidate(title);
    if (!cleaned) return;
    if (/^unknown$/i.test(cleaned)) return;
    if (/\(Original\)$/i.test(cleaned)) return;
    if (candidates.some((item) => item.title.toLowerCase() === cleaned.toLowerCase())) return;
    candidates.push({
      title: cleaned,
      evidenceLine: sanitizeOriginalTitleCandidate(evidenceLine || cleaned),
      confidence: Number(confidence) || 0,
    });
  }

  const raw = String(rawText || '').replace(/\r\n/g, '\n');

  const explicitTitleMatch =
    raw.match(/^\s*Title\s*:\s*(.+)$/im) || raw.match(/^\s*TITLE\s*[:：]\s*(.+)$/im);
  if (explicitTitleMatch) {
    pushCandidate(explicitTitleMatch[1], explicitTitleMatch[0], 100);
  }

  if (fallbackTitle) {
    pushCandidate(fallbackTitle, fallbackTitle, 85);
  }

  const frontLines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 60);

  for (let i = 0; i < frontLines.length; i++) {
    const line = frontLines[i];
    if (!looksLikeRawBookTitleLine(line)) continue;
    pushCandidate(line, line, 60 - i * 0.3);
  }

  if (fileBaseName) {
    pushCandidate(fileBaseName, fileBaseName, 40);
  }

  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.title.length - b.title.length;
  });

  const best = candidates[0] || {
    title: '',
    evidenceLine: '',
    confidence: 0,
  };

  return {
    anchorTitle: best.title || '',
    evidenceLine: best.evidenceLine || '',
    confidence: best.confidence || 0,
  };
}

/** 可选：用 Lite 确认原文书名锚点 */
async function confirmOriginalTitleAnchorByGeminiLite(args = {}) {
  const candidate = args.candidate || '';
  const rawText = args.rawText || '';
  const fileBaseName = args.fileBaseName || '';
  const evidenceLine = args.evidenceLine || '';
  const confidence = Number(args.confidence) || 0;

  const normalizedCandidate = sanitizeOriginalTitleCandidate(candidate || '');
  if (!normalizedCandidate) return '';
  if (!ENABLE_TITLE_ANCHOR_AI_ASSIST) return normalizedCandidate;
  if (confidence >= 100) return normalizedCandidate;

  const rawHead = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 80)
    .join('\n')
    .slice(0, 5000);

  const prompt = [
    '你现在不是翻译器，而是“原文书名锚点确认器”。',
    '',
    '任务：',
    '1. 只能从下面原文前部内容里确认整本书的原文标题。',
    '2. 不允许翻译，不允许改写，不允许脑补。',
    '3. 如果 candidate 明显就是整本书标题，就原样返回。',
    '4. 如果 candidate 不是整本书标题，但前文里有更明确的整本书标题，就返回更明确的那个原文标题。',
    '5. 如果无法确认，就返回 candidate 本身。',
    '6. 只输出 JSON。',
    '',
    '已知候选：' + JSON.stringify(normalizedCandidate),
    '文件名：' + JSON.stringify(fileBaseName || ''),
    '证据行：' + JSON.stringify(evidenceLine || ''),
    '',
    '原文前部：',
    '"""' + rawHead + '"""',
    '',
    '输出 JSON ONLY:',
    '{',
    '  "confirmedTitle": "",',
    '  "evidenceLine": ""',
    '}',
  ].join('\n');

  try {
    const result = await callGeminiGenerateContent(
      METADATA_EXTRACT_MODEL_NAME,
      [{ role: 'user', parts: [{ text: prompt }] }],
      {
        generationConfig: {
          temperature: 0,
          seed: 0,
        },
      },
    );

    const json = safeJsonParse(stripJsonFences(extractResponseText(result)), {
      confirmedTitle: '',
      evidenceLine: '',
    });

    const confirmedTitle = sanitizeOriginalTitleCandidate(json?.confirmedTitle || '');
    return confirmedTitle || normalizedCandidate;
  } catch (err) {
    console.warn('⚠️ [Title Anchor] Lite 原文书名锚点确认失败，将继续使用规则候选。');
    return normalizedCandidate;
  }
}

/** 兼容旧调用：从 TXT 原文中取原文 Title */
function getOriginalTitle(rawText, chineseBookName) {
  const resolved = resolveOriginalTitleAnchorCandidate({
    rawText,
    fallbackTitle: '',
    fileBaseName: chineseBookName || '',
  });
  return resolved.anchorTitle || (chineseBookName ? chineseBookName + ' (Original)' : 'Unknown');
}

function buildOriginalTitleAnchorLine(originalTitle = '') {
  const title = sanitizeOriginalTitleCandidate(originalTitle);
  return title ? '标题：' + title : '';
}

function normalizeDetectedBookTitleCandidate(text = '') {
  return normalizeLooseLine(
    String(text || '')
      .replace(/^(标题|书名|小说名|作品名|章节标题)\s*[:：]?\s*/u, '')
      .replace(/^《/, '')
      .replace(/》$/, ''),
  ).trim();
}

/** 仅在真正发给 3flash 的首个正文 chunk 前部注入书名锚点 */
function injectOriginalTitleAnchorIntoFirstBodyChunk(chunks = [], cleanChapters = [], originalTitle = '') {
  const anchorLine = buildOriginalTitleAnchorLine(originalTitle);
  if (!anchorLine || !Array.isArray(chunks) || !chunks.length) return chunks;

  let targetIndex = chunks.findIndex((chunk) => {
    const chapterIndexes = Array.isArray(chunk?.chapterIndexes) ? chunk.chapterIndexes : [];
    if (!chapterIndexes.length) return false;

    return chapterIndexes.some((idx) => {
      const chapter = cleanChapters[idx];
      const title = normalizeLooseLine(chapter?.title || '');
      return chapter && !chapter.isStructural && !isCatalogSectionTitle(title) && !isNonContentSectionTitle(title);
    });
  });

  if (targetIndex < 0) targetIndex = 0;

  const cloned = chunks.map((chunk) => (typeof chunk === 'string' ? chunk : { ...chunk }));
  const target = cloned[targetIndex];
  const currentText = typeof target === 'string' ? target : target?.text || target?.content || '';

  const firstNonEmptyLine =
    String(currentText || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => normalizeLooseLine(line))
      .find(Boolean) || '';

  if (/^(标题|书名|小说名|作品名)\s*[:：]/u.test(firstNonEmptyLine)) {
    return cloned;
  }

  const injectedText = anchorLine + '\n\n' + String(currentText || '').trim();

  if (typeof target === 'string') {
    cloned[targetIndex] = injectedText;
  } else {
    cloned[targetIndex] = {
      ...target,
      text: injectedText,
      content: injectedText,
      sourceLength: typeof getUtf8ByteLength === 'function' ? getUtf8ByteLength(injectedText) : injectedText.length,
    };
  }

  return cloned;
}

/** 在锁定中文书名后，把首段前部注入的书名锚点删掉 */
function stripInjectedTitleAnchorFromFinalChapters(finalChapters = [], resolvedCnBookName = '', originalTitle = '') {
  const bookName = normalizeDetectedBookTitleCandidate(resolvedCnBookName || '');
  const originalName = sanitizeOriginalTitleCandidate(originalTitle || '').toLowerCase();

  if (!bookName && !originalName) return finalChapters;

  const firstBodyIndex = (finalChapters || []).findIndex((chapter) => {
    const title = normalizeLooseLine(chapter?.title || '');
    return !isCatalogSectionTitle(title) && !isNonContentSectionTitle(title);
  });

  if (firstBodyIndex < 0) return finalChapters;

  return (finalChapters || []).map((chapter, idx) => {
    if (idx !== firstBodyIndex) return chapter;

    const lines = String(chapter?.content || '')
      .replace(/\r\n/g, '\n')
      .split('\n');

    while (lines.length && !normalizeLooseLine(lines[0])) lines.shift();

    const firstLine = normalizeLooseLine(lines[0] || '');
    let removed = false;

    const labeled = firstLine.match(/^(标题|书名|小说名|作品名)\s*[:：]?\s*(.+)$/u);
    if (labeled) {
      const candidate = normalizeDetectedBookTitleCandidate(labeled[2] || '');
      const candidateLower = sanitizeOriginalTitleCandidate(candidate).toLowerCase();
      if ((bookName && candidate === bookName) || (originalName && candidateLower === originalName)) {
        lines.shift();
        removed = true;
      }
    } else {
      const bracketOnly = firstLine.match(/^《([^》\n]{2,80})》$/u);
      if (bracketOnly) {
        const candidate = normalizeDetectedBookTitleCandidate(bracketOnly[1] || '');
        if (bookName && candidate === bookName) {
          lines.shift();
          removed = true;
        }
      }
    }

    if (removed) {
      while (lines.length && !normalizeLooseLine(lines[0])) lines.shift();
    }

    return {
      ...chapter,
      content: lines.join('\n').trim(),
    };
  });
}

/** 从信息说明里抽取某个字段 */
function extractInfoField(infoContent, label) {
  const match = String(infoContent || '').match(new RegExp(`${escapeRegExp(label)}:\\s*(.*)`));
  return match ? match[1].trim() : '';
}

/** 从信息说明里抽 glossary */
function extractGlossaryFromInfo(infoContent) {
  const m = String(infoContent || '').match(/角色\/术语表:\s*([\s\S]*?)(?:\n-{5,}|\n〖|$)/);
  return m ? m[1].trim() : '';
}

/** 北京时间戳字符串 */
function getBeijingTimeStr() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const beijingTime = new Date(utc + 3600000 * 8);

  return (
    beijingTime.getFullYear().toString() +
    (beijingTime.getMonth() + 1).toString().padStart(2, '0') +
    beijingTime.getDate().toString().padStart(2, '0') +
    beijingTime.getHours().toString().padStart(2, '0') +
    beijingTime.getMinutes().toString().padStart(2, '0') +
    beijingTime.getSeconds().toString().padStart(2, '0')
  );
}

/** 在已翻目录里查找是否已有历史任务 */
function findExistingTask(originalFileBaseName, originalFileName) {
  const outputDirRoot = './已翻小说';
  if (!fs.existsSync(outputDirRoot)) return null;

  const dirs = fs.readdirSync(outputDirRoot);

  for (const d of dirs) {
    const dirPath = path.join(outputDirRoot, d);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath).filter((f) => f.toLowerCase().endsWith('.txt'));
    for (const infoFile of files) {
      const infoPath = path.join(dirPath, infoFile);
      let content = '';

      try {
        content = fs.readFileSync(infoPath, 'utf-8');
      } catch {
        continue;
      }

      if (!content.includes('〖书籍信息报告〗')) continue;

      const sourceInput = extractInfoField(content, '原始输入文件');
      const oldFileName = extractInfoField(content, '文件名');
      const originalTitle = extractInfoField(content, '原书名');
      const standardTitle = extractInfoField(content, '标准译名');

      const hit =
        sourceInput === originalFileName ||
        sourceInput === originalFileBaseName ||
        oldFileName === originalFileName ||
        (sourceInput && sourceInput.startsWith(originalFileBaseName)) ||
        (oldFileName && oldFileName.startsWith(originalFileBaseName)) ||
        (originalTitle && normalizeCompareKey(originalTitle) === normalizeCompareKey(originalFileBaseName)) ||
        (standardTitle && normalizeCompareKey(standardTitle) === normalizeCompareKey(originalFileBaseName));

      if (hit) {
        return { dirPath, infoFile, content, bookName: d };
      }
    }
  }

  return null;
}

/** 从历史信息说明重建 identity */
function buildIdentityFromInfo(infoContent = '') {
  return {
    originalBookName: extractInfoField(infoContent, '原书名') || '',
    originalAuthor:
      extractInfoField(infoContent, '原作者') ||
      extractInfoField(infoContent, '作者') ||
      '',
    cnBookName: extractInfoField(infoContent, '标准译名') || '',
    cnAuthor:
      extractInfoField(infoContent, '中文作者名') ||
      extractInfoField(infoContent, '作者') ||
      '',
    source: extractInfoField(infoContent, '元数据锚定源') || 'Resume',
    sourceKind: 'resume',
    glossary: extractGlossaryFromInfo(infoContent) || '无',
    synopsis: extractInfoField(infoContent, '简介') || '',
  };
}

// ==========================================
// 主流程：处理单本书
// ==========================================

/** 处理单本书 */
async function processOneBook(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const originalFileName = path.basename(filePath);
  const originalFileBaseName = path.basename(filePath, ext);
  let taskTimeStr = getBeijingTimeStr();

  console.log(`\n📥 正在解析文件: ${originalFileName}`);

  const existingTask = findExistingTask(originalFileBaseName, originalFileName);

  let cleanChapters = [];
  let originalBookTitle = '';
  let originalAuthor = 'Unknown';
  let originalTitleAnchor = '';
  let workingBookName = '';
  let dynamicSystemInstruction = '';
  let outputDir = '';
  let isResumed = false;
  let sourceArchiveName = '';
  let sourceFingerprint = '';
  let identity = null;
  let localMetadata = null;
  let mapMetadataSeed = null;
  let translationChunks = [];

  if (existingTask) {
    console.log(`✨ [Resume] 发现历史任务: ${existingTask.bookName}`);

    outputDir = existingTask.dirPath;
    workingBookName = existingTask.bookName;
    const infoContent = existingTask.content;
    taskTimeStr = extractInfoField(infoContent, '任务时间') || taskTimeStr;

    originalBookTitle = extractInfoField(infoContent, '原书名') || workingBookName;
    originalAuthor = extractInfoField(infoContent, '原作者') || extractInfoField(infoContent, '作者') || 'Unknown';
    originalTitleAnchor = normalizeLooseLine(originalBookTitle || stripFileExt(originalFileName));
    identity = buildIdentityFromInfo(infoContent);

    localMetadata = {
      cnBookName: identity.cnBookName || '',
      cnAuthor: identity.cnAuthor || '',
      synopsis: identity.synopsis || '',
      glossary: identity.glossary || '无',
      source: '本地历史任务',
      sourceKind: 'local',
    };

    dynamicSystemInstruction = `${BASE_SYSTEM_INSTRUCTION}\n[名著术语表 (严格执行)]: ${identity.glossary || '无'}`;

    const pureMatch = infoContent.match(/依据清洗底本TXT:\s*(.*)/);
    if (pureMatch) sourceArchiveName = pureMatch[1].trim();

    cleanChapters = loadSourceChunks(outputDir);
    if (cleanChapters) {
      console.log(`✅ [Chunk Match] 成功从 source_chunks 加载 ${cleanChapters.length} 个分块。`);
      isResumed = true;
    } else {
      console.warn('⚠️ [Chunk Missing] source_chunks 文件夹丢失，必须重新解析！');
      isResumed = false;
    }
  }

  let chunks = [];
  let initialCleanChapters = [];

  if (!isResumed) {
    let initialChapters = [];
    let txtStructureMeta = null;

    if (ext === '.epub') {
      try {
        const epubData = await parseEpubStructure(filePath);
        originalBookTitle = normalizeLooseLine(epubData.title || '');
        originalAuthor = epubData.author;
        originalTitleAnchor = normalizeLooseLine(originalBookTitle || stripFileExt(originalFileName));
        initialChapters = epubData.chapters;
      } catch (e) {
        console.error(e);
        return;
      }
    } else {
      const rawText = await fs.readFile(filePath, 'utf-8');
      const auditedText = auditTxtBoundaries(rawText);
      const pureSourceText = trimPureSourceBoundaries(auditedText);

      const anchorMeta = resolveOriginalTitleAnchorCandidate({
        rawText: auditedText || rawText,
        fallbackTitle: getOriginalTitle(rawText, 'Unknown'),
        fileBaseName: originalFileBaseName,
      });

      originalTitleAnchor = await confirmOriginalTitleAnchorByGeminiLite({
        candidate: anchorMeta.anchorTitle || '',
        rawText: auditedText || rawText,
        fileBaseName: originalFileBaseName,
        evidenceLine: anchorMeta.evidenceLine || '',
        confidence: anchorMeta.confidence || 0,
      });

      originalBookTitle = normalizeLooseLine(
        originalTitleAnchor || anchorMeta.anchorTitle || getOriginalTitle(rawText, 'Unknown') || originalFileBaseName,
      );

      txtStructureMeta = await buildStructuredTxtChapters(pureSourceText, originalFileName);
      if (txtStructureMeta.skip) {
        console.warn(`⚠️ [TXT Skip] ${originalFileName} 已跳过：${txtStructureMeta.reason}`);
        return;
      }

      initialChapters = txtStructureMeta.chapters;
    }

    // 启动阶段只做 provisional identity，不打 AI
    identity = buildProvisionalIdentity({
      title: originalBookTitle,
      author: originalAuthor,
      fileName: originalFileName,
    });

    localMetadata = buildLocalMetadataFields({
      title: originalBookTitle,
      author: originalAuthor,
    });

    mapMetadataSeed = matchBookMetadataZhMap({
      originalTitle: originalBookTitle,
      originalAuthor,
      fileName: originalFileName,
      mapItems: loadBookMetadataZhMap(),
    });

    const glossaryForTranslation = chooseFirstMeaningfulValue(
      localMetadata.glossary,
      mapMetadataSeed?.glossary,
      identity.glossary,
      '无',
    );

    const seedCnName = chooseFirstMeaningfulChineseValue(
      localMetadata.cnBookName,
      mapMetadataSeed?.cnBookName,
    );

    workingBookName = sanitizeExportName(
      seedCnName || originalFileBaseName || originalBookTitle || 'Unknown',
    );
    outputDir = path.join('./已翻小说', workingBookName);
    await fs.ensureDir(outputDir);

    dynamicSystemInstruction = `${BASE_SYSTEM_INSTRUCTION}\n[名著术语表 (严格执行)]: ${glossaryForTranslation}`;

    if (SAVE_TXT_RAW_CATALOG && txtStructureMeta?.catalogBlock?.rawText) {
      const rawCatalogFile = path.join(outputDir, `TXT原始目录_${taskTimeStr}_331.txt`);
      if (!fs.existsSync(rawCatalogFile)) {
        await fs.writeFile(rawCatalogFile, txtStructureMeta.catalogBlock.rawText, 'utf-8');
      }
    }

    let validChapters = initialChapters;

    if (ext === '.epub') {
      if (ENABLE_EPUB_MACRO_FILTER) validChapters = await aiStructureFilter(initialChapters);
      if (ENABLE_EPUB_MICRO_FILTER && validChapters.length > 1) {
        validChapters = await aiContentFilter(validChapters);
      }
      validChapters = normalizeLongTitlesDeterministically(validChapters);
    }

    cleanChapters = validChapters
      .map((ch) => {
        const coreCleaned = cleanTextCore(ch.content);
        const dedupedContent =
          ch.isStructural || isNonContentSectionTitle(ch.title) || isCatalogSectionTitle(ch.title)
            ? coreCleaned
            : stripLeadingSourceHeadingRedundancy(coreCleaned, ch);

        return {
          ...ch,
          title: ch.title,
          content: dedupedContent,
        };
      })
      .filter((ch) => ch.isStructural || ch.content.length > 50);

    initialCleanChapters = cleanChapters;

    const expectedPureName = `纯净原文_${taskTimeStr}_331.txt`;
    if (fs.existsSync(path.join(outputDir, expectedPureName))) {
      console.log(`♻️ [Resource] 检测到已有清洗底本，直接复用: ${expectedPureName}`);
      sourceArchiveName = expectedPureName;
    } else {
      sourceArchiveName = await savePureSourceTxt(
        cleanChapters,
        originalBookTitle,
        originalAuthor,
        outputDir,
        taskTimeStr,
      );
    }

    if (cleanChapters.length > 1) normalizeChapterTitles(cleanChapters);
    saveStructureManifest(outputDir, workingBookName, identity, cleanChapters);

    // 新分块调用：章节感知均衡分块 v2
    chunks = streamChunkingStrategyByChapterAwareBalancedCount(cleanChapters);
    sourceFingerprint = saveSourceChunks(outputDir, chunks);
    translationChunks = injectOriginalTitleAnchorIntoFirstBodyChunk(chunks, cleanChapters, originalTitleAnchor);

    const chapterMapStr = cleanChapters
      .map((ch, idx) => {
        const transTitle = ch.translatedTitle || ch.title;
        return '[' + (idx + 1) + '] ' + ch.title + ' -> ' + transTitle;
      })
      .join('\n');

    const provisionalInfoPath = path.join(
      outputDir,
      '原文名_' + sanitizeExportName(originalBookTitle || originalFileBaseName) + '_信息说明_' + taskTimeStr + '_331.txt',
    );
    const provisionalInfoContent = buildBookInfoReportText({
      identity: {
        ...identity,
        cnBookName: chooseFirstMeaningfulValue(
          localMetadata.cnBookName,
          mapMetadataSeed?.cnBookName,
          identity.cnBookName,
          identity.originalBookName,
        ),
        cnAuthor: chooseFirstMeaningfulValue(
          localMetadata.cnAuthor,
          mapMetadataSeed?.cnAuthor,
          identity.cnAuthor,
          identity.originalAuthor,
        ),
        glossary: chooseFirstMeaningfulValue(
          localMetadata.glossary,
          mapMetadataSeed?.glossary,
          identity.glossary,
          '无',
        ),
        source: chooseFirstMeaningfulValue(localMetadata.source, mapMetadataSeed?.source, identity.source),
        sourceKind: chooseFirstMeaningfulValue(
          localMetadata.sourceKind,
          mapMetadataSeed?.sourceKind,
          identity.sourceKind,
        ),
      },
      finalNaming: {
        preferredOutputFileName: originalFileName,
      },
      originalFileName,
      sourceArchiveName,
      outputFormat: ext === '.epub' ? 'epub+txt' : OUTPUT_FORMAT,
      sourceFingerprint,
      chunkCount: chunks.length,
      chapterMapStr,
      taskTimeStr,
    });

    await fs.writeFile(provisionalInfoPath, provisionalInfoContent, 'utf-8');
  } else {
    chunks = cleanChapters;
    translationChunks = injectOriginalTitleAnchorIntoFirstBodyChunk(chunks, cleanChapters, originalTitleAnchor);
  }

  // 断点续跑：如果所有分块都已经翻完，直接进入最终合并
  let allChunksExist = true;
  for (let i = 0; i < chunks.length; i++) {
    const fileIndex = String(i + 1).padStart(3, '0');
    const standardFile = path.join(outputDir, `Chapter_${fileIndex}.md`);
    if (!fs.existsSync(standardFile) || fs.statSync(standardFile).size < 100) {
      allChunksExist = false;
      break;
    }
  }

  if (allChunksExist) {
    console.log(`✨ [Smart Resume] 检测到全部分块 (${chunks.length}/${chunks.length}) 已存在，准备进入最终合并流程...`);

    const existingTxt331 = fs
      .readdirSync(outputDir)
      .find((f) => f.includes('_全本_') && f.endsWith('_331.txt'));
    const existingEpub331 = fs
      .readdirSync(outputDir)
      .find((f) => f.includes('_全本_') && f.endsWith('_331.epub'));

    const alreadyDone = ext === '.epub' ? existingTxt331 && existingEpub331 : existingTxt331;
    if (alreadyDone) {
      console.log('⚡ [Short Circuit] 检测到最终文件已存在，任务直接归档。');
      await fs.move(filePath, path.join('./已翻译（原）', originalFileName), { overwrite: true });
      return;
    }
  } else {
    for (let i = 0; i < chunks.length; i++) {
      const fileIndex = String(i + 1).padStart(3, '0');
      const standardFile = path.join(outputDir, `Chapter_${fileIndex}.md`);

      if (fs.existsSync(standardFile) && fs.statSync(standardFile).size > 100) {
        console.log(`✅ [Part ${i + 1}] 已存在，跳过。`);
        continue;
      }

      const labelBookName =
        identity?.cnBookName ||
        identity?.originalBookName ||
        workingBookName ||
        originalBookTitle ||
        originalFileBaseName;

      console.log('>>> [' + labelBookName + '] 翻译中✍️ Part ' + (i + 1) + '/' + translationChunks.length + '...');
      const result = await translateChunkSmart(translationChunks[i], dynamicSystemInstruction);
      await fs.writeFile(standardFile, result.text, 'utf-8');
      console.log(`💾 保存 Chapter_${fileIndex}.md (文件大小: ${result.sizeKb.toFixed(2)} KB)`);
      await sleep(CHUNK_DELAY_MS);
    }
  }

  console.log(ext === '.epub' ? '📦 执行 EPUB + TXT 合并...' : '📦 执行 TXT 合并...');

  const validFiles = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith('Chapter_') && f.endsWith('.md') && !f.includes('_BAD_BLOCK'))
    .sort();

  let fullTranslatedText = '';
  for (const f of validFiles) {
    fullTranslatedText += cleanTranslatedText(await fs.readFile(path.join(outputDir, f), 'utf-8')) + '\n\n';
  }

  let finalChapters = buildFinalChapters(fullTranslatedText);

  if (!localMetadata) {
    localMetadata = buildLocalMetadataFields({
      title: originalBookTitle,
      author: originalAuthor,
    });
  }

  identity = await finalizeBookIdentityBeforeExport({
    provisionalIdentity:
      identity ||
      buildProvisionalIdentity({
        title: originalBookTitle,
        author: originalAuthor,
        fileName: originalFileName,
      }),
    localMetadata: {
      cnBookName: chooseFirstMeaningfulValue(localMetadata?.cnBookName, mapMetadataSeed?.cnBookName),
      cnAuthor: chooseFirstMeaningfulValue(localMetadata?.cnAuthor, mapMetadataSeed?.cnAuthor),
      synopsis: chooseFirstMeaningfulValue(localMetadata?.synopsis, mapMetadataSeed?.synopsis),
      glossary: chooseFirstMeaningfulValue(localMetadata?.glossary, mapMetadataSeed?.glossary, '无'),
    },
    translatedChapters: finalChapters,
    originalFileName,
  });

  finalChapters = stripInjectedTitleAnchorFromFinalChapters(
    finalChapters,
    identity.cnBookName,
    originalTitleAnchor || originalBookTitle,
  );

  const preparedFinalChapters = prepareFinalOutputChapters(finalChapters);

  const finalNaming = buildFinalExportNaming(
    identity,
    ext === '.epub' ? 'epub' : 'txt',
    taskTimeStr,
    originalFileBaseName,
  );

  // 最终统一重命名目录
  outputDir = await renameOutputDirIfNeeded(outputDir, finalNaming.folderName);
  await cleanupOldInfoFiles(outputDir);

  const finalTxtPath = path.join(outputDir, finalNaming.txtFileName);
  const finalEpubPath = path.join(outputDir, finalNaming.epubFileName);
  const finalInfoPath = path.join(outputDir, finalNaming.infoFileName);

  if (ext === '.epub') {
    try {
      await generateTranslatedEpub(
        identity.cnBookName || identity.originalBookName || workingBookName,
        identity.cnAuthor || identity.originalAuthor || originalAuthor,
        preparedFinalChapters,
        finalEpubPath,
      );
      await exportGeneratedEpubToTxt(finalEpubPath, finalTxtPath);
    } catch (e) {
      console.error(`❌ [EPUB Dual Output] 生成失败: ${e?.message || String(e)}`);
      const fallbackTxt = renderTxtWithCatalog(preparedFinalChapters);
      await fs.writeFile(finalTxtPath, fallbackTxt, 'utf-8');
      console.log(`⚠️ [Fallback TXT] 已输出回退 TXT: ${path.basename(finalTxtPath)}`);
    }
  } else {
    const finalTxt = renderTxtWithCatalog(preparedFinalChapters);
    await fs.writeFile(finalTxtPath, finalTxt, 'utf-8');
    console.log(`📄 [TXT] 文本生成成功: ${path.basename(finalTxtPath)}`);
  }

  const chapterMapStrFinal = (initialCleanChapters.length ? initialCleanChapters : [])
    .map((ch, idx) => {
      const transTitle = ch.translatedTitle || ch.title;
      return `[${idx + 1}] ${ch.title} -> ${transTitle}`;
    })
    .join('\n');

  const infoContent = buildBookInfoReportText({
    identity,
    finalNaming,
    originalFileName,
    sourceArchiveName,
    outputFormat: ext === '.epub' ? 'epub+txt' : OUTPUT_FORMAT,
    sourceFingerprint,
    chunkCount: chunks.length,
    chapterMapStr: chapterMapStrFinal,
    taskTimeStr,
  });

  await fs.writeFile(finalInfoPath, infoContent, 'utf-8');
  await fs.move(filePath, path.join('./已翻译（原）', originalFileName), { overwrite: true });
}

// ==========================================
// 启动时坏块扫描
// ==========================================

/** 根据 Chapter_XXX.md 找回对应 source chunk 的原文长度 */
function getChunkSourceLength(outputDir, chapterFileName) {
  const fileIndex = chapterFileName.match(/Chapter_(\d+)\.md/i)?.[1];
  if (!fileIndex) return 0;

  const chunkPath = path.join(outputDir, 'source_chunks', `chunk_${fileIndex}.txt`);
  if (!fs.existsSync(chunkPath)) return 0;

  try {
    return fs.readFileSync(chunkPath, 'utf-8').length;
  } catch {
    return 0;
  }
}

/** 全局坏块扫描 */
async function globalBadBlockSweep(booksDir) {
  const outputDirRoot = './已翻小说';
  if (!fs.existsSync(outputDirRoot) || !fs.existsSync(booksDir)) return;

  const sourceFiles = fs.readdirSync(booksDir).map((f) => path.basename(f, path.extname(f)));
  console.log('🔎 [Startup Check] 正在根据 books 列表扫描旧坏块...');

  let markedCount = 0;
  const dirs = fs.readdirSync(outputDirRoot);

  for (const d of dirs) {
    const dirPath = path.join(outputDirRoot, d);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const files = fs.readdirSync(dirPath);
    const isTarget = sourceFiles.some((base) =>
      files.some((f) => f.includes('信息说明') || f.includes('书籍信息') || f.startsWith(base)),
    );
    if (!isTarget) continue;

    const mdFiles = files.filter(
      (f) => f.startsWith('Chapter_') && f.endsWith('.md') && !f.includes('_BAD_BLOCK'),
    );

    for (const f of mdFiles) {
      const filePath = path.join(dirPath, f);
      const outputText = fs.readFileSync(filePath, 'utf-8');
      const stats = fs.statSync(filePath);
      const sourceLength = getChunkSourceLength(dirPath, f);
      const outputChars = outputText.length;
      const sizeKb = stats.size / 1024;
      const dynamicFuse = getDynamicOutputFuse(sourceLength || outputChars);
      const tooLarge = ENABLE_LARGE_BLOCK_FILTER && outputChars > dynamicFuse;
      const tooSmallForLargeChunk = sourceLength >= 22000 && sizeKb < 16;
      const tooSmallForMediumChunk = sourceLength >= 16000 && sizeKb < 10;

      if (tooLarge || tooSmallForLargeChunk || tooSmallForMediumChunk) {
        const newName = f.replace('.md', '_BAD_BLOCK.md');
        const reason = tooLarge ? '过大' : '过小';

        console.warn(
          `⚠️ [Mark Bad Block] 标记旧坏块(${reason}): ${d}/${f} (${sizeKb.toFixed(
            2,
          )} KB, 输出 ${outputChars} chars, 熔断阈值 ${dynamicFuse}, 源 ${sourceLength} chars) -> ${newName}`,
        );

        await fs.rename(filePath, path.join(dirPath, newName));
        markedCount++;
      }
    }
  }

  if (markedCount > 0) {
    console.log(`✅ 标记了 ${markedCount} 个旧坏块，将在本次任务中重翻。`);
  }
}

// ==========================================
// main
// ==========================================

/** 主入口 */
async function main() {
  const booksDir = './books';

  if (!fs.existsSync(booksDir)) {
    await fs.ensureDir(booksDir);
    return;
  }

  console.log('\n================================');
  console.log(`🚀 启动 ${VERSION}`);
  console.log('================================');
  console.log(`更新日志: ${UPDATE_LOG.trim()}`);
  console.log('================================\n');

  await fs.ensureDir('./已翻小说');
  await fs.ensureDir('./已翻译（原）');

  if (ENABLE_STARTUP_BAD_BLOCK_SWEEP) {
    await globalBadBlockSweep(booksDir);
  }

  const files = fs
    .readdirSync(booksDir)
    .filter((f) => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.epub'))
    .map((f) => ({
      name: f,
      time: fs.statSync(path.join(booksDir, f)).birthtime.getTime(),
    }))
    .sort((a, b) => a.time - b.time)
    .map((f) => f.name);

  console.log(`📚 待处理文件: ${files.length} 本`);

  for (const f of files) {
    await processOneBook(path.join(booksDir, f));
  }

  if (AUTO_SHUTDOWN) exec('sudo poweroff');
}

main().catch((err) => {
  if (isAllFlashKeysDailyLimitReachedError(err)) {
    console.error('🛑 Fatal: ' + (err?.message || String(err)));
  } else {
    console.error('❌ Fatal:', err?.stack || err?.message || String(err));
  }
  process.exitCode = 1;
});