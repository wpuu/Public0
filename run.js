'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// =========================================
// 基础 fetch：Node 18+ 原生有 fetch，没有则自动降级 node-fetch
// =========================================
const fetchFn =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : async (...args) => {
        const mod = await import('node-fetch');
        return mod.default(...args);
      };

// =========================================
// 版本 / 目录 / 配置
// =========================================
const VERSION = 'run.js polish-standalone-v2-fixed';

const INPUT_DIR = path.join(__dirname, '润色');
const ORIGINAL_ARCHIVE_DIR = path.join(__dirname, '润色（原）');
const OUTPUT_DIR = path.join(__dirname, '已润色');
const API_KEY_FILE = path.join(__dirname, 'api0.txt');

const API_USAGE_SEPARATOR = '============================';
const QUOTA_RESET_HOUR_BJT = 16;
const DEFAULT_MAX_PER_KEY_PER_CYCLE = 25;

const API_BASE_URL =
  process.env.GEMINI_BASE_URL ||
  'https://generativelanguage.googleapis.com/v1beta';

const PRIMARY_MODEL_NAME =
  process.env.GEMINI_PRIMARY_MODEL || 'gemini-3-flash-preview';

const FALLBACK_MODEL_NAME =
  process.env.GEMINI_FALLBACK_MODEL || 'gemini-3-flash-preview';

const MODELS_URL = `${API_BASE_URL.replace(/\/$/, '')}/models`;

const POLISH_ROOT_DIR_NAME = '_polish';
const POLISH_ROUND_PREFIX = 'round_';

const POLISH_SCAN_HARD_LIMIT = 10000;
const POLISH_SCAN_DELAY_MS = 1200;
const POLISH_MAX_OUTPUT_TOKENS = 8192;

const POLISH_EXPORT_DEFAULT_SOURCE = 'auto';
const POLISH_DEFAULT_APPLY_SOURCE = 'effective';

const POLISH_SOURCE_MODE_SET = new Set(['auto', 'scan', 'imported', 'effective']);
const RETRY_DELAYS = [5000, 15000, 30000, 60000];

const DYNAMIC_OUTPUT_FUSE_BASE = 30000;
const DYNAMIC_OUTPUT_FUSE_MAX = 36000;
const DYNAMIC_OUTPUT_FUSE_RATIO = 1.08;
const DYNAMIC_OUTPUT_FUSE_BONUS = 1200;

const POLISH_IMPORT_NEAR_POSITION_MAX_DISTANCE = 5000;
const POLISH_OVERRIDE_POSITION_TOLERANCE = 80;

const POLISH_DELETE_MARKERS = new Set([
  '',
  '删除',
  '已删除',
  '(已删除)',
  '[删除]',
  '[已删除]',
  '<删除>',
  '删掉',
  '删去',
  'delete',
]);

const POLISH_SYSTEM_INSTRUCTION = [
  '你是一位拥有二十年经验的资深中文文学翻译家，曾为国内一线出版社（如人民文学出版社、译林出版社、上海译文出版社）翻译过多部畅销外文小说。你的翻译作品以"信、达、雅"著称，深受中国读者喜爱。同时，你也是一位有二十年经验的中文小说责任编辑与文学润色编辑，擅长把“翻译后但略显生硬的中文小说正文”修整得更自然、更像中文原创叙事。',
  '',
  '## 你的翻译原则',
  '',
  '### 忠实与自然',
  '- 准确传达原文的语义、语气、情感和节奏，不遗漏、不增添原文没有的信息',
  '- 翻译必须读起来像一位中国作家直接用中文写的小说，而非翻译腔',
  '- 避免欧化长句，将英文的复杂从句拆分为符合中文阅读习惯的短句',
  '- 人物对话要符合角色身份、年龄、性格，口语化且鲜活',
  '',
  '### 词汇与表达',
  '- 优先使用当代中国读者熟悉的日常用语，避免生僻词和过度文雅的书面语',
  '- 严禁堆砌四字成语（如"跌宕起伏""引人入胜""毋庸置疑"），偶尔自然使用即可',
  '- 禁止使用以下AI高频词汇和句式：',
  '  · "值得注意的是""不可否认""毫无疑问""事实上""总而言之""综上所述"',
  '  · "令人叹为观止""恰如其分""应运而生""如火如荼""与此同时"',
  '  · "不仅……而且……""无论……都……"等过度工整的关联词组合',
  '  · "这不禁让人……""这无疑是……"等评论式插入语',
  '  · "此外"、"然而"、"值得注意的是"、"不可否认"等生硬的书面语',
  '  ·"以此以此"、"等等等等"、"非常非常"、"某种"等明显啰嗦重复的词语',
  '- 形容词和副词要克制，不过度渲染情绪',
  '- 比喻和修辞保留原文的意象，必要时转化为中国读者能理解的等效表达',
  '',
  '### 句式与结构',
  '- 句子长度参差错落，长短句自然交替，营造阅读节奏',
  '- 段落之间过渡自然，不使用"首先""其次""最后"等机械连接词',
  '- 保持原文的段落划分，不自行合并或拆分段落',
  '- 叙述视角、时态与原文保持一致',
  '- 多余的空格要去掉。润色时也要避免不要出现多余的空格。',
  '',
  '### 对话处理',
  '- 对话使用中文双引号""',
  '- 根据角色特点赋予不同的说话风格和用词习惯',
  '- 语气词（"嗯""啊""呢""吧""嘛"）适当使用，不过度',
  '',
  '### 专有名词',
  '- 人名：首次出现时注入术语表，翻译中文译名，强制统一译法',
  '- 地名：有通行译名的用通行译名，注入术语表，强制统一译法',
  '- 品牌、书名、歌曲名等：有官方中文名的用官方名',
  '',
  '### 格式要求',
  '- 仅输出译文，不输出任何解释、注释、译者按语或元评论',
  '- 不要在译文前后添加任何说明性文字',
  '- 保留原文的章节标题格式。',
  '',
  '你的任务不是改剧情，而是找出“明确可改”的表达问题，并返回修改清单 JSON。',
  '',
  '执行目标：',
  '1. 删除明显生硬直译',
  '2. 调整不自然语序',
  '3. 改掉重复累赘表达',
  '4. 修正明显别扭搭配',
  '5. 保留原段落结构、人物关系、剧情事实、时态和信息量',
  '6. 不得擅自增删设定',
  '7. old_text 必须与原文完全一致',
  '8. new_text 可以为空字符串，表示删除',
  '9. 尽量找全“明确可改”的地方，不要只挑前几处',
  '10. 如果没有可靠修改，返回 {"modifications":[]}',
  '',
  '返回格式：',
  '{',
  '  "modifications": [',
  '    {',
  '      "old_text": "原文中的一小段",',
  '      "new_text": "修改后的文本",',
  '      "reason": "精简理由，例如：删除生硬直译，使表达更自然"',
  '    }',
  '  ]',
  '}',
  '',
  '严格要求：',
  '- 只返回 JSON 对象',
  '- 不要输出 Markdown',
  '- 不要输出解释',
  '- 不要输出代码块',
  '- 不要输出任何额外说明',
  '- 请对输入文本做“必要且明确”的润色记录抽取',
  '- 尽量找全“明确可改”的问题，不要只挑最前面的几处',
  '- 不得改剧情、设定、事实与人物关系',
  '- 不确定时可以不改，但明显问题不要漏掉'
].join('\n');
// =========================================
// 基础目录准备
// =========================================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function emptyDir(dir) {
  ensureDir(dir);
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

[INPUT_DIR, ORIGINAL_ARCHIVE_DIR, OUTPUT_DIR].forEach(ensureDir);

// =========================================
// 基础工具函数
// =========================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function byteSizeKb(text) {
  return Buffer.byteLength(String(text || ''), 'utf-8') / 1024;
}

function sanitizeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

function sanitizeDebugLabel(label) {
  return String(label || 'raw')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

function maskApiKey(key) {
  if (!key) return '[EMPTY]';
  if (key.length <= 10) return key.slice(0, 4) + '***';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf-8').digest('hex');
}

function getDynamicOutputFuse(sourceLength) {
  const dynamic =
    Math.floor(Number(sourceLength || 0) * DYNAMIC_OUTPUT_FUSE_RATIO) +
    DYNAMIC_OUTPUT_FUSE_BONUS;
  return Math.max(
    DYNAMIC_OUTPUT_FUSE_BASE,
    Math.min(DYNAMIC_OUTPUT_FUSE_MAX, dynamic),
  );
}

// =========================================
// 北京时间工具
// =========================================
function getBeijingDateObj(date = new Date()) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

function formatDateOnly(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateTime(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  const hh = String(dateObj.getHours()).padStart(2, '0');
  const mm = String(dateObj.getMinutes()).padStart(2, '0');
  const ss = String(dateObj.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function getBeijingTimeStr() {
  return formatDateTime(getBeijingDateObj(new Date()));
}

function getQuotaCycleBjt(date = new Date()) {
  const bj = getBeijingDateObj(date);
  if (bj.getHours() < QUOTA_RESET_HOUR_BJT) {
    bj.setDate(bj.getDate() - 1);
  }
  return formatDateOnly(bj);
}

function getCompactTimeStamp() {
  const bj = getBeijingDateObj(new Date());
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d = String(bj.getDate()).padStart(2, '0');
  const hh = String(bj.getHours()).padStart(2, '0');
  const mm = String(bj.getMinutes()).padStart(2, '0');
  const ss = String(bj.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}${hh}${mm}${ss}`;
}

function getUniqueArchivePath(fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(ORIGINAL_ARCHIVE_DIR, fileName);
  if (!fs.existsSync(candidate)) return candidate;

  const stamp = getCompactTimeStamp();
  return path.join(ORIGINAL_ARCHIVE_DIR, `${parsed.name}_${stamp}${parsed.ext}`);
}

// =========================================
// api0.txt 读取 / 自动补格式 / 配额计数
// =========================================
function extractApiKeyFromLine(rawLine) {
  const line = String(rawLine || '').replace(/^\uFEFF/, '').trim();
  if (!line) return [];
  if (line === API_USAGE_SEPARATOR) return [];
  if (line.startsWith('#') || line.startsWith('//')) return [];
  if (/^(quota_cycle_bjt|last_success_time_bjt|max_per_key)\s*=/i.test(line)) return [];
  const matches = line.match(/AIza[0-9A-Za-z\-_]{20,}/g);
  return matches ? matches : [];
}

function loadApiStateFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      keys: [],
      usage: {},
      quotaCycleBjt: '',
      lastSuccessTimeBjt: '',
      maxPerKey: DEFAULT_MAX_PER_KEY_PER_CYCLE,
      needsRewrite: false,
    };
  }

  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const separatorIndex = raw.indexOf(API_USAGE_SEPARATOR);

  const keySection = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw;
  const stateSection =
    separatorIndex >= 0 ? raw.slice(separatorIndex + API_USAGE_SEPARATOR.length) : '';

  const keys = [];
  for (const line of keySection.split(/\r?\n/)) {
    keys.push(...extractApiKeyFromLine(line));
  }

  const uniqueKeys = [...new Set(keys)];
  let maxPerKey = DEFAULT_MAX_PER_KEY_PER_CYCLE;
  let quotaCycleBjt = '';
  let lastSuccessTimeBjt = '';

  const usage = {};
  for (const key of uniqueKeys) usage[key] = 0;

  for (const rawLine of stateSection.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    let m = line.match(/^quota_cycle_bjt\s*=\s*(.+)$/i);
    if (m) {
      quotaCycleBjt = m[1].trim();
      continue;
    }

    m = line.match(/^last_success_time_bjt\s*=\s*(.*)$/i);
    if (m) {
      lastSuccessTimeBjt = m[1].trim();
      continue;
    }

    m = line.match(/^max_per_key\s*=\s*(\d+)$/i);
    if (m) {
      maxPerKey = normalizePositiveInt(m[1], DEFAULT_MAX_PER_KEY_PER_CYCLE);
      continue;
    }

    m = line.match(/^(AIza[0-9A-Za-z\-_]{20,})\s*\|\s*(\d+)\s*\/\s*(\d+)\s*$/);
    if (m) {
      const key = m[1];
      const used = Number(m[2]) || 0;
      if (uniqueKeys.includes(key)) {
        usage[key] = Math.max(0, Math.min(maxPerKey, used));
      }
    }
  }

  const hasFullState =
    separatorIndex >= 0 &&
    /quota_cycle_bjt\s*=/.test(stateSection) &&
    /last_success_time_bjt\s*=/.test(stateSection) &&
    /max_per_key\s*=/.test(stateSection);

  return {
    keys: uniqueKeys,
    usage,
    quotaCycleBjt,
    lastSuccessTimeBjt,
    maxPerKey,
    needsRewrite: !hasFullState,
  };
}

function normalizeApiState(state) {
  const keys = [...new Set((state && state.keys) || [])];
  const maxPerKey = normalizePositiveInt(
    state && state.maxPerKey,
    DEFAULT_MAX_PER_KEY_PER_CYCLE,
  );
  const usage = {};

  for (const key of keys) {
    const count = Number((state && state.usage && state.usage[key]) || 0);
    usage[key] = Math.max(0, Math.min(maxPerKey, count));
  }

  return {
    keys,
    usage,
    quotaCycleBjt: (state && state.quotaCycleBjt) || '',
    lastSuccessTimeBjt: (state && state.lastSuccessTimeBjt) || '',
    maxPerKey,
    needsRewrite: Boolean(state && state.needsRewrite),
  };
}

function saveApiStateToFile(filePath, state) {
  const safeState = normalizeApiState(state);

  const lines = [
    ...safeState.keys,
    API_USAGE_SEPARATOR,
    `quota_cycle_bjt=${safeState.quotaCycleBjt || getQuotaCycleBjt()}`,
    `last_success_time_bjt=${safeState.lastSuccessTimeBjt || ''}`,
    `max_per_key=${safeState.maxPerKey}`,
    ...safeState.keys.map(
      (key) =>
        `${key} | ${Math.min(safeState.maxPerKey, safeState.usage[key] || 0)}/${safeState.maxPerKey}`,
    ),
    '',
  ];

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

let apiState = null;
let API_KEYS = [];
let currentKeyIndex = -1;
let nextKeyOverrideIndex = null;

function initApiStateIfNeeded() {
  if (apiState) return;

  apiState = normalizeApiState(loadApiStateFromFile(API_KEY_FILE));
  API_KEYS = [...apiState.keys];

  if (API_KEYS.length === 0) {
    throw new Error('未读取到任何有效 Gemini API Key。请检查 api0.txt。');
  }

  if (apiState.needsRewrite) {
    if (!apiState.quotaCycleBjt) {
      apiState.quotaCycleBjt = getQuotaCycleBjt();
    }
    saveApiStateToFile(API_KEY_FILE, apiState);
    console.log('🛠️ [api0.txt] 检测到仅有裸 Key 或状态区不完整，已自动补写标准格式。');
  }
}

function getMaxPerKeyPerCycle() {
  initApiStateIfNeeded();
  return normalizePositiveInt(apiState.maxPerKey, DEFAULT_MAX_PER_KEY_PER_CYCLE);
}

function getKeyUsageCountByIndex(index) {
  initApiStateIfNeeded();
  const key = API_KEYS[index];
  if (!key) return 0;
  return apiState.usage[key] || 0;
}

function maybeResetQuotaCycle() {
  initApiStateIfNeeded();
  const currentQuotaCycle = getQuotaCycleBjt(new Date());

  if (apiState.quotaCycleBjt !== currentQuotaCycle) {
    apiState.quotaCycleBjt = currentQuotaCycle;
    for (const key of API_KEYS) {
      apiState.usage[key] = 0;
    }
    saveApiStateToFile(API_KEY_FILE, apiState);
    console.log(
      `🕓 [Quota Reset] 北京时间 ${QUOTA_RESET_HOUR_BJT}:00 配额周期切换为 ${currentQuotaCycle}，全部 Key 计数已清零。`,
    );
  }
}

function getAvailableKeyIndicesSorted() {
  initApiStateIfNeeded();
  maybeResetQuotaCycle();

  const maxPerKey = getMaxPerKeyPerCycle();
  const indices = API_KEYS
    .map((_, idx) => idx)
    .filter((idx) => getKeyUsageCountByIndex(idx) < maxPerKey);

  indices.sort((a, b) => {
    const diff = getKeyUsageCountByIndex(a) - getKeyUsageCountByIndex(b);
    if (diff !== 0) return diff;
    return a - b;
  });

  return indices;
}

class AllKeysExhaustedError extends Error {
  constructor() {
    super(`所有 API Key 当前周期都已达到 ${getMaxPerKeyPerCycle()}/${getMaxPerKeyPerCycle()}，任务停止。`);
    this.name = 'AllKeysExhaustedError';
    this.code = 'ALL_KEYS_DAILY_LIMIT_REACHED';
  }
}

function getKey(modelName = PRIMARY_MODEL_NAME) {
  initApiStateIfNeeded();

  const available = getAvailableKeyIndicesSorted();
  const maxPerKey = getMaxPerKeyPerCycle();

  if (available.length === 0) {
    throw new AllKeysExhaustedError();
  }

  let selectedIndex = -1;

  if (
    Number.isInteger(nextKeyOverrideIndex) &&
    nextKeyOverrideIndex >= 0 &&
    available.includes(nextKeyOverrideIndex)
  ) {
    selectedIndex = nextKeyOverrideIndex;
    nextKeyOverrideIndex = null;
  } else {
    selectedIndex = available[0];
  }

  currentKeyIndex = selectedIndex;
  const currentUsage = getKeyUsageCountByIndex(selectedIndex);
  const nextIfSuccess = Math.min(maxPerKey, currentUsage + 1);

  console.log(
    `🔐 [Key 选择] Key ${selectedIndex + 1}/${API_KEYS.length} | 当前 ${currentUsage}/${maxPerKey} | 本次若成功 => ${nextIfSuccess}/${maxPerKey} | model=${modelName}`,
  );

  return {
    key: API_KEYS[selectedIndex],
    index: selectedIndex,
    usage: currentUsage,
  };
}

function rotateKeyProactively(reason = '主动切换') {
  initApiStateIfNeeded();

  const available = getAvailableKeyIndicesSorted();
  const maxPerKey = getMaxPerKeyPerCycle();

  if (available.length === 0) {
    throw new AllKeysExhaustedError();
  }

  const currentPos = available.indexOf(currentKeyIndex);
  const nextPos = currentPos >= 0 ? (currentPos + 1) % available.length : 0;

  nextKeyOverrideIndex = available[nextPos];
  currentKeyIndex = nextKeyOverrideIndex;

  console.log(
    `🔁 [Key 切换] ${reason} -> Key ${currentKeyIndex + 1}/${API_KEYS.length} | 当前 ${getKeyUsageCountByIndex(currentKeyIndex)}/${maxPerKey}`,
  );
}

function recordSuccessfulKeyCall(modelName, keyIndex) {
  initApiStateIfNeeded();
  maybeResetQuotaCycle();

  apiState.lastSuccessTimeBjt = formatDateTime(getBeijingDateObj(new Date()));

  const key = API_KEYS[keyIndex];
  apiState.usage[key] = Math.min(getMaxPerKeyPerCycle(), (apiState.usage[key] || 0) + 1);

  saveApiStateToFile(API_KEY_FILE, apiState);

  console.log(
    `✅ [Key 成功] Key ${keyIndex + 1}/${API_KEYS.length} | 已记为 ${getKeyUsageCountByIndex(keyIndex)}/${getMaxPerKeyPerCycle()} | 最后成功时间(BJT): ${apiState.lastSuccessTimeBjt}`,
  );

  currentKeyIndex = -1;
  nextKeyOverrideIndex = null;
}

// =========================================
// Gemini API 调用
// =========================================
function buildGenerateUrl(modelName) {
  return `${API_BASE_URL.replace(/\/$/, '')}/models/${encodeURIComponent(
    modelName,
  )}:generateContent`;
}

function extractResponseText(data) {
  const parts =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts;

  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function normalizeUsageMetadata(data) {
  const usage = (data && data.usageMetadata) || {};
  return {
    prompt_tokens: usage.promptTokenCount ?? '?',
    completion_tokens: usage.candidatesTokenCount ?? '?',
    total_tokens: usage.totalTokenCount ?? '?',
  };
}

function isTransientHttpStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

async function validateApiKey(apiKey) {
  const response = await fetchFn(MODELS_URL, {
    method: 'GET',
    headers: {
      'x-goog-api-key': apiKey,
    },
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`KEY_VALIDATE_${response.status}: ${rawText.slice(0, 500)}`);
  }

  const data = safeJsonParse(rawText, {});
  const modelList = Array.isArray(data && data.models)
    ? data.models
        .map((item) => String((item && item.name) || '').replace(/^models\//, ''))
        .filter(Boolean)
    : [];

  return {
    ok: true,
    status: response.status,
    rawText,
    modelList,
  };
}

async function preflightCheck() {
  initApiStateIfNeeded();

  console.log(`\n🔐 [预检] 共读取到 ${API_KEYS.length} 个 API Key`);
  console.log(`🌐 [预检] API_BASE_URL: ${API_BASE_URL}`);
  console.log(`📡 [预检] 主模型: ${PRIMARY_MODEL_NAME}`);
  console.log(`📡 [预检] 回退模型: ${FALLBACK_MODEL_NAME}`);

  let validatedCount = 0;
  const failures = [];

  for (let i = 0; i < API_KEYS.length; i++) {
    const apiKey = API_KEYS[i];
    const masked = maskApiKey(apiKey);

    try {
      process.stdout.write(`   [预检] 校验 Key ${i + 1}/${API_KEYS.length}: ${masked}\r`);
      await validateApiKey(apiKey);
      validatedCount++;
      console.log(`   ✅ Key 可用: ${masked}`);
    } catch (error) {
      failures.push({ masked, message: error.message });
      console.log(`   ❌ Key 失效: ${masked} | ${error.message}`);
    }
  }

  if (validatedCount === 0) {
    const detail = failures.map((item) => `${item.masked}: ${item.message}`).join('\n');
    throw new Error(`所有 API Key 预检失败。\n${detail}`);
  }
}

async function callGeminiGenerateContentJson({
  modelName,
  systemInstruction,
  userText,
  temperature = 0,
  maxOutputTokens = POLISH_MAX_OUTPUT_TOKENS,
  responseMimeType = 'application/json',
}) {
  let lastError = null;

  for (let round = 0; round < RETRY_DELAYS.length + 2; round++) {
    const available = getAvailableKeyIndicesSorted();
    if (!available.length) throw new AllKeysExhaustedError();

    for (let i = 0; i < available.length; i++) {
      const keyInfo = getKey(modelName);
      const key = keyInfo.key;

      const payload = {
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: userText }],
          },
        ],
        generationConfig: {
          temperature,
          maxOutputTokens,
          responseMimeType,
        },
      };

      try {
        const response = await fetchFn(buildGenerateUrl(modelName), {
          method: 'POST',
          headers: {
            'x-goog-api-key': key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        const responseText = await response.text();

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error(`404 Not Found: ${responseText.slice(0, 500)}`);
          }

          if (isTransientHttpStatus(response.status)) {
            rotateKeyProactively(`HTTP ${response.status}`);
            lastError = new Error(`HTTP ${response.status}: ${responseText.slice(0, 500)}`);
            continue;
          }

          if (response.status === 401 || response.status === 403) {
            rotateKeyProactively(`HTTP ${response.status}`);
            lastError = new Error(`HTTP ${response.status}: ${responseText.slice(0, 500)}`);
            continue;
          }

          throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 500)}`);
        }

        const data = safeJsonParse(responseText, null);
        if (!data) {
          rotateKeyProactively('返回体不是合法 JSON');
          lastError = new Error(`返回体不是合法 JSON：${responseText.slice(0, 300)}`);
          continue;
        }

        recordSuccessfulKeyCall(modelName, keyInfo.index);
        return data;
      } catch (error) {
        if (error && error.code === 'ALL_KEYS_DAILY_LIMIT_REACHED') throw error;
        if (/404 Not Found/i.test(String(error && error.message))) throw error;

        rotateKeyProactively('请求异常');
        lastError = error;
      }
    }

    if (round < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[round];
      console.log(`⏳ [Gemini 重试] 本轮 key 均失败，${delay / 1000} 秒后继续...`);
      await sleep(delay);
    }
  }

  throw lastError || new Error('Gemini 请求失败');
}

// =========================================
// 书籍上下文：scan 只认 INPUT_DIR
// =========================================
function getBookOutputDir(bookName) {
  return path.join(OUTPUT_DIR, sanitizeFileName(bookName));
}

function listInputBooks() {
  ensureDir(INPUT_DIR);
  return fs
    .readdirSync(INPUT_DIR)
    .filter((f) => f.toLowerCase().endsWith('.txt'))
    .map((f) => ({
      bookName: path.parse(f).name,
      sourceFilePath: path.join(INPUT_DIR, f),
      sourceFileName: f,
      bookOutputDir: getBookOutputDir(path.parse(f).name),
    }))
    .sort((a, b) => a.bookName.localeCompare(b.bookName, 'zh-CN'));
}

function listOutputBooks() {
  ensureDir(OUTPUT_DIR);
  return fs
    .readdirSync(OUTPUT_DIR)
    .map((name) => ({
      name,
      full: path.join(OUTPUT_DIR, name),
    }))
    .filter((item) => fs.statSync(item.full).isDirectory())
    .map((item) => {
      const expectedInput = path.join(INPUT_DIR, `${item.name}.txt`);
      return {
        bookName: item.name,
        sourceFilePath: fs.existsSync(expectedInput) ? expectedInput : '',
        sourceFileName: fs.existsSync(expectedInput) ? `${item.name}.txt` : '',
        bookOutputDir: item.full,
      };
    })
    .sort((a, b) => a.bookName.localeCompare(b.bookName, 'zh-CN'));
}

function mergeBookContexts(inputBooks, outputBooks) {
  const map = new Map();

  for (const item of inputBooks) {
    map.set(item.bookName, item);
  }

  for (const item of outputBooks) {
    if (!map.has(item.bookName)) {
      map.set(item.bookName, item);
    } else {
      const existing = map.get(item.bookName);
      existing.bookOutputDir = item.bookOutputDir;
      if (!existing.sourceFilePath && item.sourceFilePath) {
        existing.sourceFilePath = item.sourceFilePath;
        existing.sourceFileName = item.sourceFileName;
      }
      map.set(item.bookName, existing);
    }
  }

  return [...map.values()].sort((a, b) => a.bookName.localeCompare(b.bookName, 'zh-CN'));
}

function getAllKnownBooks() {
  return mergeBookContexts(listInputBooks(), listOutputBooks());
}

function resolveBookContextForScan(bookArg = '') {
  const books = listInputBooks();

  if (!books.length) {
    throw new Error(`润色 目录下没有找到任何 txt：${INPUT_DIR}`);
  }

  if (!bookArg) {
    if (books.length === 1) return books[0];
    throw new Error('润色 目录里有多本书，请用 --book 指定书名。');
  }

  const exact = books.find((item) => item.bookName === bookArg);
  if (exact) return exact;

  const fuzzy = books.filter((item) => item.bookName.includes(bookArg));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(`--book 命中多本输入书：${fuzzy.map((x) => x.bookName).join(' / ')}`);
  }

  throw new Error(`润色 目录中未找到书：${bookArg}`);
}

function resolveBookContextForRead(bookArg = '') {
  const books = getAllKnownBooks();

  if (!books.length) {
    throw new Error(`未找到任何书。请先把 txt 放到：${INPUT_DIR}`);
  }

  if (!bookArg) {
    if (books.length === 1) return books[0];
    throw new Error('存在多本书，请用 --book 指定书名。');
  }

  const exact = books.find((item) => item.bookName === bookArg);
  if (exact) return exact;

  const fuzzy = books.filter((item) => item.bookName.includes(bookArg));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(`--book 命中多个书名：${fuzzy.map((x) => x.bookName).join(' / ')}`);
  }

  throw new Error(`未找到书：${bookArg}`);
}

// =========================================
// round 文件体系
// =========================================
function polishPadRoundNo(roundNo) {
  return String(Number(roundNo) || 0).padStart(4, '0');
}

function polishRoundLabel(roundNo) {
  return `round${String(Number(roundNo) || 0).padStart(2, '0')}`;
}

function getPolishRootDir(bookDir) {
  return path.join(bookDir, POLISH_ROOT_DIR_NAME);
}

function getPolishPointerPath(bookDir) {
  return path.join(getPolishRootDir(bookDir), 'current_body_pointer.json');
}

function getPolishRoundDir(bookDir, roundNo) {
  return path.join(bookDir, POLISH_ROOT_DIR_NAME, `${POLISH_ROUND_PREFIX}${polishPadRoundNo(roundNo)}`);
}

function getPolishRoundMetaPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'round_meta.json');
}

function getPolishRoundBaseTextPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'base_text.txt');
}

function getPolishRoundScanModsPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'scan_mods.json');
}

function getPolishRoundImportedModsPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'imported_mods.json');
}

function getPolishRoundImportedUnresolvedPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'imported_unresolved.json');
}

function getPolishRoundEffectiveModsPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'effective_mods.json');
}

function getPolishRoundExportPath(bookDir, roundNo, sourceMode) {
  return path.join(getPolishRoundDir(bookDir, roundNo), `export_${sourceMode}.txt`);
}

function getPolishRoundProofPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), `proof_${polishRoundLabel(roundNo)}.txt`);
}

function getPolishRoundFinalPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), `final_${polishRoundLabel(roundNo)}.txt`);
}

function getPolishRoundImportDir(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), '_imports');
}

function getPolishRoundChunkDir(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), '_scan_chunks');
}

function getPolishRoundChunkManifestPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'scan_chunk_manifest.json');
}

function getPolishRoundProgressPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'scan_progress.json');
}

function getPolishRoundUsageLogPath(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), 'scan_usage.log');
}

function getPolishRoundDebugDir(bookDir, roundNo) {
  return path.join(getPolishRoundDir(bookDir, roundNo), '_scan_debug_raw');
}

function listPolishRounds(bookDir) {
  const root = getPolishRootDir(bookDir);
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root)
    .filter((name) => new RegExp(`^${POLISH_ROUND_PREFIX}\\d+$`).test(name))
    .map((name) => {
      const roundNo = Number(name.replace(POLISH_ROUND_PREFIX, '')) || 0;
      return {
        roundNo,
        dir: path.join(root, name),
        name,
        meta: readJsonFile(path.join(root, name, 'round_meta.json'), null),
      };
    })
    .sort((a, b) => a.roundNo - b.roundNo);
}

function getLatestPolishRoundInfo(bookDir) {
  const rounds = listPolishRounds(bookDir);
  return rounds.length ? rounds[rounds.length - 1] : null;
}

function writePolishCurrentPointer(bookDir, payload = {}) {
  const pointerPath = getPolishPointerPath(bookDir);
  ensureDir(path.dirname(pointerPath));
  writeJsonFile(pointerPath, payload);
}

// =========================================
// round 基底：scan 一定来自 润色/*.txt
// =========================================
function getScanSourceText(bookCtx) {
  if (!bookCtx || !bookCtx.sourceFilePath || !fs.existsSync(bookCtx.sourceFilePath)) {
    throw new Error(`润色 目录中不存在《${bookCtx ? bookCtx.bookName : ''}》对应的 txt。`);
  }

  const text = fs.readFileSync(bookCtx.sourceFilePath, 'utf-8');
  if (!text || text.trim() === '') {
    throw new Error(`《${bookCtx.bookName}》是空文件，无法润色。`);
  }

  return {
    filePath: bookCtx.sourceFilePath,
    fileName: path.basename(bookCtx.sourceFilePath),
    text,
  };
}

function createNewPolishRoundFromInput(bookCtx) {
  const bookDir = bookCtx.bookOutputDir;
  ensureDir(bookDir);
  ensureDir(getPolishRootDir(bookDir));

  const latest = getLatestPolishRoundInfo(bookDir);
  const nextRoundNo = latest ? latest.roundNo + 1 : 1;
  const roundDir = getPolishRoundDir(bookDir, nextRoundNo);
  ensureDir(roundDir);

  const source = getScanSourceText(bookCtx);
  const baseTextPath = getPolishRoundBaseTextPath(bookDir, nextRoundNo);
  fs.writeFileSync(baseTextPath, source.text, 'utf-8');

  const meta = {
    roundNo: nextRoundNo,
    roundId: `${POLISH_ROUND_PREFIX}${polishPadRoundNo(nextRoundNo)}`,
    createdAtBjt: getBeijingTimeStr(),
    status: 'open',
    baseFileName: source.fileName,
    baseSourceKind: 'input-source',
    baseTextLength: source.text.length,
    baseTextSha1: sha1(source.text),
    appliedAtBjt: '',
    appliedSource: '',
    finalTextLength: 0,
    finalTextSha1: '',
  };

  writeJsonFile(getPolishRoundMetaPath(bookDir, nextRoundNo), meta);
  return { roundNo: nextRoundNo, roundDir, meta, base: source };
}

function ensureRoundForScan(bookCtx, roundArg = 'auto') {
  const bookDir = bookCtx.bookOutputDir;
  const latest = getLatestPolishRoundInfo(bookDir);
  const source = getScanSourceText(bookCtx);
  const sourceHash = sha1(source.text);

  if (String(roundArg || '').toLowerCase() === 'next') {
    return createNewPolishRoundFromInput(bookCtx);
  }

  if (!latest) {
    return createNewPolishRoundFromInput(bookCtx);
  }

  if (!roundArg || roundArg === 'auto' || roundArg === 'latest') {
    const latestMeta = latest.meta || {};
    if (latestMeta.status === 'open' && latestMeta.baseTextSha1 === sourceHash) {
      return latest;
    }
    return createNewPolishRoundFromInput(bookCtx);
  }

  const numeric = Number(roundArg);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`非法 round 参数：${roundArg}`);
  }

  const hit = listPolishRounds(bookDir).find((item) => item.roundNo === numeric);
  if (hit) return hit;

  if (numeric === latest.roundNo + 1) {
    return createNewPolishRoundFromInput(bookCtx);
  }

  throw new Error(`指定 round 不存在：${roundArg}`);
}

function ensureRoundForRead(bookCtx, roundArg = 'latest') {
  const bookDir = bookCtx.bookOutputDir;
  const rounds = listPolishRounds(bookDir);

  if (!rounds.length) {
    if (bookCtx.sourceFilePath && fs.existsSync(bookCtx.sourceFilePath)) {
      return createNewPolishRoundFromInput(bookCtx);
    }
    throw new Error(`《${bookCtx.bookName}》还没有任何 round。请先把 TXT 放到“润色”目录并执行 scan。`);
  }

  if (!roundArg || roundArg === 'latest' || roundArg === 'auto') {
    return rounds[rounds.length - 1];
  }

  if (String(roundArg).toLowerCase() === 'next') {
    if (bookCtx.sourceFilePath && fs.existsSync(bookCtx.sourceFilePath)) {
      return createNewPolishRoundFromInput(bookCtx);
    }
    throw new Error(`《${bookCtx.bookName}》当前没有可用于新建 round 的输入 TXT。`);
  }

  const numeric = Number(roundArg);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`非法 round 参数：${roundArg}`);
  }

  const hit = rounds.find((item) => item.roundNo === numeric);
  if (!hit) throw new Error(`指定 round 不存在：${roundArg}`);
  return hit;
}

// =========================================
// 句子切分 / polish chunking
// =========================================
function isSentenceEndingChar(char) {
  return /[。！？!?；;…]/.test(char);
}

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

function collectSentenceUnitsWithOffsetsForPolish(text, baseOffset = 0) {
  const units = [];
  let start = 0;

  while (start < text.length) {
    const end = findSentenceBoundary(text, start);
    if (end <= start) break;

    units.push({
      text: text.slice(start, end),
      startOffset: start,
      endOffset: end,
      startIndex: baseOffset + start,
      endIndex: baseOffset + end,
    });

    start = end;
  }

  if (!units.length && text.length > 0) {
    units.push({
      text,
      startOffset: 0,
      endOffset: text.length,
      startIndex: baseOffset,
      endIndex: baseOffset + text.length,
    });
  }

  return units;
}

function splitTextIntoTwoSentenceAwareWithOffsetsForPolish(text) {
  const sentences = collectSentenceUnitsWithOffsetsForPolish(text, 0);
  if (sentences.length < 2 || text.length < 1200) return null;

  const totalLength = sentences.reduce((sum, item) => sum + item.text.length, 0);
  const target = totalLength / 2;

  let running = 0;
  let splitIndex = -1;

  for (let i = 0; i < sentences.length; i++) {
    running += sentences[i].text.length;
    if (running >= target) {
      splitIndex = i + 1;
      break;
    }
  }

  if (splitIndex <= 0 || splitIndex >= sentences.length) {
    splitIndex = Math.floor(sentences.length / 2);
  }

  const leftEnd = sentences[splitIndex - 1].endOffset;
  const rightStart = sentences[splitIndex].startOffset;

  const leftText = text.slice(0, leftEnd);
  const rightText = text.slice(rightStart);

  if (!leftText || !rightText) return null;

  return [
    { text: leftText, startOffset: 0, endOffset: leftEnd },
    { text: rightText, startOffset: rightStart, endOffset: text.length },
  ];
}

function findBestPolishChunkEnd(text, startIndex, hardLimit = POLISH_SCAN_HARD_LIMIT) {
  const maxEnd = Math.min(text.length, startIndex + hardLimit);
  if (maxEnd >= text.length) return text.length;

  const minAccept = Math.max(startIndex + Math.floor(hardLimit * 0.55), startIndex + 1);

  for (let i = maxEnd; i >= minAccept + 1; i--) {
    if (text.slice(i - 2, i) === '\n\n') return i;
  }

  for (let i = maxEnd; i >= minAccept; i--) {
    const ch = text[i - 1];
    if (/[。！？!?；;…]/.test(ch)) {
      let end = i;
      while (end < text.length && /["'”’）)\]〗》」』\s]/.test(text[end])) end += 1;
      return end;
    }
  }

  for (let i = maxEnd; i >= minAccept; i--) {
    if (text[i - 1] === '\n') return i;
  }

  return maxEnd;
}

function buildPolishChunkPlan(text, hardLimit = POLISH_SCAN_HARD_LIMIT) {
  const chunks = [];
  let cursor = 0;
  let index = 1;

  while (cursor < text.length) {
    const end = findBestPolishChunkEnd(text, cursor, hardLimit);
    const chunkText = text.slice(cursor, end);
    const actualEnd = chunkText ? end : Math.min(text.length, cursor + hardLimit);

    chunks.push({
      index,
      startIndex: cursor,
      endIndex: actualEnd,
      length: actualEnd - cursor,
      text: text.slice(cursor, actualEnd),
      fileName: `chunk_${String(index).padStart(4, '0')}.txt`,
    });

    cursor = actualEnd;
    index += 1;
  }

  return chunks;
}

function savePolishChunkPlan(bookDir, roundNo, baseText, chunkPlan) {
  const chunkDir = getPolishRoundChunkDir(bookDir, roundNo);
  const manifestPath = getPolishRoundChunkManifestPath(bookDir, roundNo);

  ensureDir(chunkDir);
  emptyDir(chunkDir);

  for (const chunk of chunkPlan) {
    fs.writeFileSync(path.join(chunkDir, chunk.fileName), chunk.text, 'utf-8');
  }

  writeJsonFile(manifestPath, {
    totalChars: baseText.length,
    hardLimit: POLISH_SCAN_HARD_LIMIT,
    chunkCount: chunkPlan.length,
    chunks: chunkPlan.map((chunk) => ({
      index: chunk.index,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      length: chunk.length,
      fileName: chunk.fileName,
    })),
  });

  return chunkPlan;
}

function loadPolishChunkPlan(bookDir, roundNo, totalChars) {
  const chunkDir = getPolishRoundChunkDir(bookDir, roundNo);
  const manifestPath = getPolishRoundChunkManifestPath(bookDir, roundNo);

  if (!fs.existsSync(chunkDir) || !fs.existsSync(manifestPath)) return null;

  const manifest = readJsonFile(manifestPath, null);
  if (!manifest || manifest.totalChars !== totalChars || !Array.isArray(manifest.chunks)) return null;

  const plan = [];
  for (const item of manifest.chunks) {
    const filePath = path.join(chunkDir, item.fileName);
    if (!fs.existsSync(filePath)) return null;

    plan.push({
      index: item.index,
      startIndex: item.startIndex,
      endIndex: item.endIndex,
      length: item.length,
      fileName: item.fileName,
      text: fs.readFileSync(filePath, 'utf-8'),
    });
  }

  return plan;
}

function buildOrLoadPolishChunkPlan(bookDir, roundNo, baseText) {
  const loaded = loadPolishChunkPlan(bookDir, roundNo, baseText.length);
  if (loaded) return loaded;

  const built = buildPolishChunkPlan(baseText, POLISH_SCAN_HARD_LIMIT);
  return savePolishChunkPlan(bookDir, roundNo, baseText, built);
}

function buildChunkTagByNo(no) {
  if (!Number.isInteger(Number(no)) || Number(no) <= 0) return '';
  return `chunk_${Number(no)}`;
}

function loadPolishChunkRanges(bookDir, roundNo) {
  const manifest = readJsonFile(getPolishRoundChunkManifestPath(bookDir, roundNo), null);
  if (!manifest || !Array.isArray(manifest.chunks)) return [];
  return manifest.chunks.map((item) => ({
    index: item.index,
    startIndex: item.startIndex,
    endIndex: item.endIndex,
    tag: buildChunkTagByNo(item.index),
  }));
}

// =========================================
// 模型返回解析 / 修改清洗 / 定位
// =========================================
function cleanModelText(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractLikelyJson(text) {
  const cleanText = cleanModelText(text);
  const firstBrace = cleanText.indexOf('{');
  const lastBrace = cleanText.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return cleanText.slice(firstBrace, lastBrace + 1);
  }

  return cleanText;
}

function parsePolishModelModifications(rawContent) {
  const result = {
    modifications: [],
    parsed: false,
    rawContent: rawContent || '',
  };

  const likelyJson = extractLikelyJson(rawContent);

  try {
    const parsed = JSON.parse(likelyJson);
    if (Array.isArray(parsed)) {
      result.modifications = parsed;
    } else if (parsed && Array.isArray(parsed.modifications)) {
      result.modifications = parsed.modifications;
    }
    result.parsed = true;
    return result;
  } catch {}

  const matches =
    likelyJson.match(/\{[\s\S]*?"old_text"[\s\S]*?"new_text"[\s\S]*?"reason"[\s\S]*?\}/g) || [];
  const rescued = [];

  for (const item of matches) {
    try {
      rescued.push(JSON.parse(item));
    } catch {}
  }

  result.modifications = rescued;
  result.parsed = rescued.length > 0;
  return result;
}

function sanitizePolishModifications(chunkText, aiMods) {
  const validMods = [];
  const seen = new Set();

  for (const mod of aiMods || []) {
    if (!mod) continue;

    const oldText = typeof mod.old_text === 'string' ? mod.old_text : '';
    const newText = typeof mod.new_text === 'string' ? mod.new_text : '';
    const reason = typeof mod.reason === 'string' ? mod.reason.trim() : '';

    if (!oldText) continue;
    if (!chunkText.includes(oldText)) continue;
    if (oldText === newText) continue;
    if (/无需修改|不需要修改/i.test(reason)) continue;

    const key = `${oldText}>>>${newText}>>>${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);

    validMods.push({
      old_text: oldText,
      new_text: newText,
      reason: reason || '',
    });
  }

  return validMods;
}

function resolvePolishModificationPositions(chunkText, chunkStartIndex, mods, chunkTag) {
  const occupiedRanges = [];
  const cursors = new Map();
  const positioned = [];

  for (const mod of mods) {
    let searchFrom = cursors.get(mod.old_text) || 0;
    let localIndex = chunkText.indexOf(mod.old_text, searchFrom);

    while (localIndex !== -1) {
      const candidateStart = localIndex;
      const candidateEnd = localIndex + mod.old_text.length;
      const overlaps = occupiedRanges.some(
        (range) => candidateStart < range.end && candidateEnd > range.start,
      );

      if (!overlaps) break;
      localIndex = chunkText.indexOf(mod.old_text, localIndex + 1);
    }

    if (localIndex === -1) localIndex = chunkText.indexOf(mod.old_text);
    if (localIndex === -1) continue;

    const localEnd = localIndex + mod.old_text.length;
    occupiedRanges.push({ start: localIndex, end: localEnd });
    cursors.set(mod.old_text, localEnd);

    positioned.push({
      old_text: mod.old_text,
      new_text: mod.new_text,
      reason: mod.reason,
      chunkTag,
      absoluteStart: chunkStartIndex + localIndex,
      absoluteEnd: chunkStartIndex + localEnd,
      sourceType: 'scan',
      importLocateKind: '',
      overrideKind: '',
    });
  }

  return positioned;
}

function evaluatePolishModelOutput(sourceText, rawContent, parsedResult) {
  const sourceLength = String(sourceText || '').length;
  const output = String(rawContent || '').trim();
  const outputLength = output.length;
  const outputFuse = getDynamicOutputFuse(sourceLength);

  if (!output) {
    throw new Error('Polish Self-Check: Empty Output');
  }

  if (/^(i('| a)m sorry|sorry|as an ai|here is|以下是|当然|好的)/i.test(output)) {
    throw new Error('Polish Self-Check: Refusal / Meta Response');
  }

  if (outputLength > outputFuse) {
    throw new Error(`Polish Self-Check: Output Fuse ${outputLength} > ${outputFuse}`);
  }

  if (!(parsedResult && parsedResult.parsed)) {
    throw new Error('Polish Self-Check: JSON Parse Failed');
  }

  return {
    outputLength,
    outputFuse,
    sizeKb: byteSizeKb(output),
  };
}

function getPolishModKey(mod) {
  return [
    mod.absoluteStart,
    mod.absoluteEnd,
    mod.old_text,
    mod.new_text,
    mod.reason,
    mod.sourceType || '',
    mod.overrideKind || '',
  ].join('::');
}

function mergeUniquePolishMods(existingMods, incomingMods) {
  const merged = Array.isArray(existingMods) ? [...existingMods] : [];
  const seen = new Set(merged.map(getPolishModKey));

  for (const mod of incomingMods || []) {
    const key = getPolishModKey(mod);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(mod);
  }

  return merged;
}

function createEmptyPolishExtractionResult() {
  return {
    positionedMods: [],
    usageEntries: [],
    debugPayloads: [],
  };
}

function mergePolishExtractionResults(results) {
  const merged = createEmptyPolishExtractionResult();

  for (const item of results || []) {
    if (!item) continue;
    merged.positionedMods = mergeUniquePolishMods(merged.positionedMods, item.positionedMods || []);
    merged.usageEntries.push(...(item.usageEntries || []));
    merged.debugPayloads.push(...(item.debugPayloads || []));
  }

  return merged;
}

function mergePolishErrorArtifacts(target, error) {
  if (!target || !error) return;
  if (Array.isArray(error.usageEntries)) target.usageEntries.push(...error.usageEntries);
  if (Array.isArray(error.debugPayloads)) target.debugPayloads.push(...error.debugPayloads);
}

// =========================================
// 单次模型调用 + 补救
// =========================================
async function polishScanOnce(pieceText, absoluteStart, chunkTag, modelName, temperature, label) {
  let rawContent = '';
  let parsed = { modifications: [], parsed: false, rawContent: '' };

  try {
    const result = await callGeminiGenerateContentJson({
      modelName,
      systemInstruction: POLISH_SYSTEM_INSTRUCTION,
      userText: `待润色文本：\n${pieceText}`,
      temperature,
      maxOutputTokens: POLISH_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
    });

    rawContent = extractResponseText(result);
    parsed = parsePolishModelModifications(rawContent);

    const selfCheck = evaluatePolishModelOutput(pieceText, rawContent, parsed);
    const validMods = sanitizePolishModifications(pieceText, parsed.modifications);
    const positionedMods = resolvePolishModificationPositions(
      pieceText,
      absoluteStart,
      validMods,
      chunkTag,
    );
    const usage = normalizeUsageMetadata(result);

    return {
      positionedMods,
      usageEntries: [
        {
          chunkTag,
          label,
          model: modelName,
          temperature,
          chars: pieceText.length,
          mods: positionedMods.length,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          output_chars: selfCheck.outputLength,
          output_kb: selfCheck.sizeKb.toFixed(2),
          output_fuse: selfCheck.outputFuse,
        },
      ],
      debugPayloads: [
        {
          label,
          chunkTag,
          model: modelName,
          temperature,
          rawContent,
          parsed: parsed.parsed,
          modCount: positionedMods.length,
        },
      ],
    };
  } catch (error) {
    error.usageEntries = [];
    error.debugPayloads = rawContent
      ? [
          {
            label,
            chunkTag,
            model: modelName,
            temperature,
            rawContent,
            parsed: parsed.parsed,
            modCount: 0,
            failed: true,
            reason: error && error.message ? error.message : String(error),
          },
        ]
      : [];
    throw error;
  }
}

async function polishScanAfterSecondFailure(text, absoluteStart, chunkTag) {
  const aggregate = createEmptyPolishExtractionResult();
  const split = splitTextIntoTwoSentenceAwareWithOffsetsForPolish(text);

  if (!split) {
    try {
      const result = await polishScanOnce(
        text,
        absoluteStart,
        chunkTag,
        FALLBACK_MODEL_NAME,
        0.1,
        `${chunkTag} | 二次补救直译`,
      );
      return mergePolishExtractionResults([aggregate, result]);
    } catch (error) {
      mergePolishErrorArtifacts(aggregate, error);
      throw Object.assign(error, aggregate);
    }
  }

  const pieceResults = [];
  for (let i = 0; i < split.length; i++) {
    const piece = split[i];
    const pieceTag = `${chunkTag}.${i + 1}`;

    try {
      const result = await polishScanOnce(
        piece.text,
        absoluteStart + piece.startOffset,
        pieceTag,
        FALLBACK_MODEL_NAME,
        0.1,
        `${pieceTag} | 二次补救子段`,
      );
      pieceResults.push(result);
    } catch (error) {
      mergePolishErrorArtifacts(aggregate, error);
      throw Object.assign(error, aggregate);
    }
  }

  return mergePolishExtractionResults([aggregate, ...pieceResults]);
}

async function polishScanAfterFirstFailure(text, absoluteStart, chunkTag) {
  const aggregate = createEmptyPolishExtractionResult();
  const split = splitTextIntoTwoSentenceAwareWithOffsetsForPolish(text);

  if (!split) {
    const result = await polishScanAfterSecondFailure(text, absoluteStart, `${chunkTag}.fallback`);
    return mergePolishExtractionResults([aggregate, result]);
  }

  const pieceResults = [];
  for (let i = 0; i < split.length; i++) {
    const piece = split[i];
    const pieceTag = `${chunkTag}.${i + 1}`;

    try {
      const result = await polishScanOnce(
        piece.text,
        absoluteStart + piece.startOffset,
        pieceTag,
        PRIMARY_MODEL_NAME,
        0,
        `${pieceTag} | 首次补救子段`,
      );
      pieceResults.push(result);
    } catch (error) {
      mergePolishErrorArtifacts(aggregate, error);
      const fallbackResult = await polishScanAfterSecondFailure(
        piece.text,
        absoluteStart + piece.startOffset,
        pieceTag,
      );
      pieceResults.push(fallbackResult);
    }
  }

  return mergePolishExtractionResults([aggregate, ...pieceResults]);
}

async function polishScanSmart(chunkText, absoluteStart, chunkTag) {
  const aggregate = createEmptyPolishExtractionResult();

  try {
    const result = await polishScanOnce(
      chunkText,
      absoluteStart,
      chunkTag,
      PRIMARY_MODEL_NAME,
      0,
      `${chunkTag} | 初始尝试`,
    );
    return mergePolishExtractionResults([aggregate, result]);
  } catch (error) {
    mergePolishErrorArtifacts(aggregate, error);

    try {
      const result = await polishScanAfterFirstFailure(chunkText, absoluteStart, chunkTag);
      return mergePolishExtractionResults([aggregate, result]);
    } catch (error2) {
      mergePolishErrorArtifacts(aggregate, error2);
      throw Object.assign(error2, aggregate);
    }
  }
}

async function runPolishScanForBook(bookCtx, roundArg = 'auto') {
  initApiStateIfNeeded();

  const source = getScanSourceText(bookCtx);
  const sourceText = source.text;
  if (!sourceText || sourceText.trim() === '') {
    console.log(`⚠️ [跳过] 《${bookCtx.bookName}》为空文件。`);
    return;
  }

  ensureDir(bookCtx.bookOutputDir);

  const roundInfo = ensureRoundForScan(bookCtx, roundArg);
  const roundNo = roundInfo.roundNo;
  const roundDir = getPolishRoundDir(bookCtx.bookOutputDir, roundNo);
  const metaPath = getPolishRoundMetaPath(bookCtx.bookOutputDir, roundNo);
  const meta = readJsonFile(metaPath, roundInfo.meta || {});
  const baseText = fs.readFileSync(getPolishRoundBaseTextPath(bookCtx.bookOutputDir, roundNo), 'utf-8');

  const progressPath = getPolishRoundProgressPath(bookCtx.bookOutputDir, roundNo);
  const usagePath = getPolishRoundUsageLogPath(bookCtx.bookOutputDir, roundNo);
  const scanModsPath = getPolishRoundScanModsPath(bookCtx.bookOutputDir, roundNo);
  const debugDir = getPolishRoundDebugDir(bookCtx.bookOutputDir, roundNo);

  ensureDir(roundDir);
  ensureDir(debugDir);

  const chunkPlan = buildOrLoadPolishChunkPlan(bookCtx.bookOutputDir, roundNo, baseText);

  let completedChunks = 0;
  const progress = readJsonFile(progressPath, null);

  if (progress && progress.baseTextSha1 === sha1(baseText)) {
    completedChunks = Number(progress.completedChunks) || 0;
  }

  if (!fs.existsSync(usagePath)) {
    fs.writeFileSync(
      usagePath,
      `round=${roundNo}\nmodel=${PRIMARY_MODEL_NAME}\nfallback=${FALLBACK_MODEL_NAME}\n\n`,
      'utf-8',
    );
  }

  console.log(`\n🧽 [Polish Scan] 《${bookCtx.bookName}》 ${polishRoundLabel(roundNo)}`);
  console.log(`   输入源: ${source.fileName}`);
  console.log(`   基底: ${meta && meta.baseFileName ? meta.baseFileName : path.basename(getPolishRoundBaseTextPath(bookCtx.bookOutputDir, roundNo))}`);
  console.log(`   分块: ${chunkPlan.length} 块`);

  for (let i = completedChunks; i < chunkPlan.length; i++) {
    const chunk = chunkPlan[i];
    console.log(`\n   ---[Polish Chunk ${chunk.index}/${chunkPlan.length}] chars=${chunk.length} ---`);

    let result;
    let networkAttempt = 0;

    while (true) {
      try {
        result = await polishScanSmart(chunk.text, chunk.startIndex, `chunk_${chunk.index}`);
        break;
      } catch (error) {
        if (error && error.code === 'ALL_KEYS_DAILY_LIMIT_REACHED') throw error;

        const message = String((error && error.message) || error);
        if (/404 Not Found/i.test(message)) throw error;

        if (networkAttempt < RETRY_DELAYS.length) {
          const waitSeconds = RETRY_DELAYS[networkAttempt] / 1000;
          console.log(`⚠️ [Polish Retry] ${message}，${waitSeconds} 秒后重试...`);
          await sleep(RETRY_DELAYS[networkAttempt]);
          networkAttempt += 1;
        } else {
          throw error;
        }
      }
    }

    for (const usageEntry of result.usageEntries) {
      const usageLine = [
        `chunk=${chunk.index}`,
        `label=${usageEntry.label}`,
        `model=${usageEntry.model}`,
        `temp=${usageEntry.temperature}`,
        `chars=${usageEntry.chars}`,
        `mods=${usageEntry.mods}`,
        `prompt_tokens=${usageEntry.prompt_tokens}`,
        `completion_tokens=${usageEntry.completion_tokens}`,
        `total_tokens=${usageEntry.total_tokens}`,
        `output_chars=${usageEntry.output_chars}`,
        `output_fuse=${usageEntry.output_fuse}`,
      ].join(' | ');
      fs.appendFileSync(usagePath, `${usageLine}\n`, 'utf-8');
    }

    for (const payload of result.debugPayloads) {
      if (!payload.parsed || (payload.rawContent && payload.modCount === 0)) {
        const debugPath = path.join(
          debugDir,
          `chunk_${String(chunk.index).padStart(4, '0')}_${sanitizeDebugLabel(payload.label)}.txt`,
        );
        fs.writeFileSync(debugPath, payload.rawContent || '[EMPTY RESPONSE]', 'utf-8');
      }
    }

    if (result.positionedMods.length > 0) {
      const existing = readJsonFile(scanModsPath, []);
      const merged = mergeUniquePolishMods(existing, result.positionedMods);
      writeJsonFile(scanModsPath, merged);
      console.log(`   ✅ 本块识别到 ${result.positionedMods.length} 条润色建议`);
    } else {
      console.log('   [提示] 本块没有可靠修改建议');
    }

    writeJsonFile(progressPath, {
      roundNo,
      completedChunks: i + 1,
      chunkCount: chunkPlan.length,
      baseTextSha1: sha1(baseText),
      lastUpdatedBjt: getBeijingTimeStr(),
    });

    await sleep(POLISH_SCAN_DELAY_MS);
  }

  console.log(`\n✅ [Polish Scan Done] ${bookCtx.bookName} ${polishRoundLabel(roundNo)}`);
}

// =========================================
// 导出
// =========================================
function normalizePolishSourceMode(mode = 'auto') {
  const normalized = String(mode || 'auto').trim().toLowerCase();
  return POLISH_SOURCE_MODE_SET.has(normalized) ? normalized : 'auto';
}

function extractPolishChunkNumber(chunkTag = '') {
  const m = String(chunkTag || '').match(/chunk_(\d+)/i);
  return m ? Number(m[1]) : '';
}

function formatPolishModsForExport(mods = []) {
  return (mods || [])
    .map((mod, idx) => {
      const reason = String(mod.reason || '润色').trim();
      const oldText = String(mod.old_text || '');
      const newText = mod.new_text === '' ? '(已删除)' : String(mod.new_text || '');
      const start = Number.isInteger(mod.absoluteStart) ? mod.absoluteStart : '';
      const end = Number.isInteger(mod.absoluteEnd) ? mod.absoluteEnd : '';
      const chunkNo = extractPolishChunkNumber(mod.chunkTag);

      return [
        `${idx + 1}.`,
        reason,
        `原文: ${oldText}`,
        `校正: ${newText}`,
        start !== '' && end !== '' ? `位置: ${start} - ${end}` : '',
        chunkNo ? `分段: ${chunkNo}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

function loadPolishModsBySource(bookDir, roundNo, sourceMode = 'auto') {
  const scanMods = readJsonFile(getPolishRoundScanModsPath(bookDir, roundNo), []);
  const importedMods = readJsonFile(getPolishRoundImportedModsPath(bookDir, roundNo), []);
  const effectiveMods = readJsonFile(getPolishRoundEffectiveModsPath(bookDir, roundNo), []);

  const mode = normalizePolishSourceMode(sourceMode);

  if (mode === 'scan') return { source: 'scan', mods: stabilizePolishMods(scanMods) };
  if (mode === 'imported') return { source: 'imported', mods: stabilizePolishMods(importedMods) };
  if (mode === 'effective') {
    if (effectiveMods.length) return { source: 'effective', mods: stabilizePolishMods(effectiveMods) };
    return { source: 'effective', mods: buildEffectivePolishMods(scanMods, importedMods) };
  }

  if (effectiveMods.length) return { source: 'effective', mods: stabilizePolishMods(effectiveMods) };
  if (importedMods.length) return { source: 'imported', mods: stabilizePolishMods(importedMods) };
  return { source: 'scan', mods: stabilizePolishMods(scanMods) };
}

async function runPolishExport(bookCtx, roundArg = 'latest', sourceMode = POLISH_EXPORT_DEFAULT_SOURCE) {
  const roundInfo = ensureRoundForRead(bookCtx, roundArg);
  const roundNo = roundInfo.roundNo;
  const resolved = loadPolishModsBySource(bookCtx.bookOutputDir, roundNo, sourceMode);

  if (!resolved.mods.length) {
    throw new Error(`该 round 没有可导出的 ${resolved.source} 数据。`);
  }

  const exportText = formatPolishModsForExport(
    [...resolved.mods].sort((a, b) => {
      if (a.absoluteStart !== b.absoluteStart) return a.absoluteStart - b.absoluteStart;
      return a.absoluteEnd - b.absoluteEnd;
    }),
  );

  const exportPath = getPolishRoundExportPath(bookCtx.bookOutputDir, roundNo, resolved.source);
  fs.writeFileSync(exportPath, exportText, 'utf-8');

  console.log(`✅ [Polish Export] 已导出 ${resolved.mods.length} 条 -> ${exportPath}`);
}

// =========================================
// 更强自由导入解析器
// =========================================
function normalizeFlexibleImportText(raw = '') {
  return String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(
      /([^\n])\s*(原文|旧文|旧句|原句|校正|校对|修改|改成|改为|改后|润色后|新文|新句|位置|分段|理由|原因|说明|备注)\s*[:：]/g,
      '$1\n$2: ',
    )
    .trim();
}

function splitFlexiblePolishBlocks(raw = '') {
  const normalized = normalizeFlexibleImportText(raw);
  const lines = normalized.split('\n');
  const blocks = [];
  let current = [];

  function pushCurrent() {
    const text = current.join('\n').trim();
    if (text) blocks.push(text);
    current = [];
  }

  for (const rawLine of lines) {
    const line = String(rawLine || '').trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      pushCurrent();
      continue;
    }

    if (/^[-=]{3,}$/.test(trimmed)) {
      pushCurrent();
      continue;
    }

    if (/^\d+\s*[.、]\s*$/.test(trimmed)) {
      pushCurrent();
      continue;
    }

    if (/^\d+\s*[.、]\s+\S/.test(trimmed)) {
      pushCurrent();
      current.push(trimmed.replace(/^\d+\s*[.、]\s*/, ''));
      continue;
    }

    current.push(line);
  }

  pushCurrent();
  return blocks;
}

function unwrapImportedFieldText(text = '') {
  let value = String(text || '').trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('“') && value.endsWith('”')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  if (POLISH_DELETE_MARKERS.has(value)) return '';
  return value;
}

function parsePositionText(raw = '') {
  const text = String(raw || '').trim();
  const m = text.match(/(\d+)\s*(?:-|—|–|~|～|到|to)\s*(\d+)/i);
  if (!m) return { absoluteStart: null, absoluteEnd: null };

  const start = Number(m[1]);
  const end = Number(m[2]);

  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    return { absoluteStart: null, absoluteEnd: null };
  }

  return {
    absoluteStart: start,
    absoluteEnd: end,
  };
}

function extractChunkNoFromText(text = '') {
  const s = String(text || '').trim();
  if (!s) return null;

  let m = s.match(/chunk[_\s-]?(\d+)/i);
  if (m) return Number(m[1]) || null;

  m = s.match(/分段\s*[:：]?\s*(\d+)/i);
  if (m) return Number(m[1]) || null;

  m = s.match(/^(\d{1,5})$/);
  if (m) return Number(m[1]) || null;

  return null;
}

function tryParseArrowPair(line = '') {
  const s = String(line || '').trim();

  let m = s.match(/^(.*?)\s*(?:->|=>|→|➡|⇢|⟶)\s*(.*?)$/);
  if (m) {
    return {
      old_text: unwrapImportedFieldText(m[1]),
      new_text: unwrapImportedFieldText(m[2]),
    };
  }

  m = s.match(/^(.*?)\s*(?:改成|改为|校正为|改后为)\s*(.*?)$/);
  if (m && m[1] && m[2]) {
    return {
      old_text: unwrapImportedFieldText(m[1]),
      new_text: unwrapImportedFieldText(m[2]),
    };
  }

  return null;
}

function parseFlexiblePolishImportBlock(blockText = '') {
  const lines = String(blockText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());

  const result = {
    reason: '',
    old_text: '',
    new_text: '',
    positionText: '',
    chunkText: '',
    rawBlock: blockText,
  };

  let currentField = '';

  function appendField(field, value) {
    if (value === undefined || value === null) return;
    if (!result[field]) result[field] = String(value);
    else result[field] += `\n${String(value)}`;
  }

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    let m = null;

    if ((m = line.match(/^(?:原文|旧文|旧句|原句|before|old(?:_text)?)\s*[:：]?\s*(.*)$/i))) {
      currentField = 'old_text';
      appendField('old_text', m[1]);
      continue;
    }

    if ((m = line.match(/^(?:校正|校对|修改|改成|改为|改后|润色后|新文|新句|after|new(?:_text)?)\s*[:：]?\s*(.*)$/i))) {
      currentField = 'new_text';
      appendField('new_text', m[1]);
      continue;
    }

    if ((m = line.match(/^(?:位置|坐标|范围|span|range|position)\s*[:：]?\s*(.*)$/i))) {
      currentField = 'positionText';
      appendField('positionText', m[1]);
      continue;
    }

    if ((m = line.match(/^(?:分段|来源块|块|chunk|chunktag|section)\s*[:：]?\s*(.*)$/i))) {
      currentField = 'chunkText';
      appendField('chunkText', m[1]);
      continue;
    }

    if ((m = line.match(/^(?:理由|原因|说明|问题|备注|reason)\s*[:：]?\s*(.*)$/i))) {
      currentField = 'reason';
      appendField('reason', m[1]);
      continue;
    }

    const pos = parsePositionText(line);
    if (Number.isInteger(pos.absoluteStart) && Number.isInteger(pos.absoluteEnd) && !result.positionText) {
      result.positionText = line;
      currentField = 'positionText';
      continue;
    }

    if (/^\d{1,5}$/.test(line) && !result.chunkText && (result.old_text || result.new_text || result.positionText)) {
      result.chunkText = line;
      currentField = 'chunkText';
      continue;
    }

    const arrowPair = tryParseArrowPair(line);
    if (arrowPair && !result.old_text && !result.new_text) {
      result.old_text = arrowPair.old_text;
      result.new_text = arrowPair.new_text;
      currentField = '';
      continue;
    }

    if (!currentField && !result.reason) {
      result.reason = line;
      continue;
    }

    if (!result.old_text) {
      result.old_text = line;
      currentField = 'old_text';
      continue;
    }

    if (!result.new_text) {
      result.new_text = line;
      currentField = 'new_text';
      continue;
    }

    if (currentField) {
      appendField(currentField, line);
    } else {
      appendField('reason', line);
    }
  }

  result.reason = unwrapImportedFieldText(result.reason || '');
  result.old_text = unwrapImportedFieldText(result.old_text || '');
  result.new_text = unwrapImportedFieldText(result.new_text || '');

  return result;
}

function parseFlexiblePolishImportText(raw = '') {
  const blocks = splitFlexiblePolishBlocks(raw);
  return blocks
    .map(parseFlexiblePolishImportBlock)
    .filter((item) => item.old_text || item.positionText || item.new_text || item.reason);
}

function findAllOccurrences(text, needle) {
  const result = [];
  if (!needle) return result;

  let startIndex = 0;
  while (startIndex < text.length) {
    const hit = text.indexOf(needle, startIndex);
    if (hit === -1) break;
    result.push(hit);
    startIndex = hit + 1;
  }

  return result;
}

// =========================================
// imported 定位与更稳覆盖策略
// =========================================
function resolveImportedPolishItemsAgainstBase(items = [], baseText = '', ctx = {}) {
  const resolved = [];
  const unresolved = [];
  const chunkRanges = loadPolishChunkRanges(ctx.bookDir, ctx.roundNo);

  for (const item of items) {
    const pos = parsePositionText(item.positionText || '');
    const chunkNo = extractChunkNoFromText(item.chunkText || '');
    const chunkRange = chunkRanges.find((x) => x.index === chunkNo) || null;
    let oldText = String(item.old_text || '');
    const newText = typeof item.new_text === 'string' ? item.new_text : '';
    const reason = String(item.reason || '导入润色').trim() || '导入润色';

    if (!oldText && Number.isInteger(pos.absoluteStart) && Number.isInteger(pos.absoluteEnd)) {
      oldText = baseText.slice(pos.absoluteStart, pos.absoluteEnd);
    }

    if (!oldText) {
      unresolved.push({
        ...item,
        unresolvedReason: '缺少 old_text，且无法从位置自动提取',
      });
      continue;
    }

    if (
      Number.isInteger(pos.absoluteStart) &&
      Number.isInteger(pos.absoluteEnd) &&
      baseText.slice(pos.absoluteStart, pos.absoluteEnd) === oldText
    ) {
      resolved.push({
        old_text: oldText,
        new_text: newText,
        reason,
        absoluteStart: pos.absoluteStart,
        absoluteEnd: pos.absoluteEnd,
        chunkTag: chunkRange ? chunkRange.tag : buildChunkTagByNo(chunkNo),
        sourceType: 'imported',
        importLocateKind: 'explicit-position-exact',
        overrideKind: '',
      });
      continue;
    }

    const hits = findAllOccurrences(baseText, oldText);

    if (hits.length === 1) {
      const start = hits[0];
      resolved.push({
        old_text: oldText,
        new_text: newText,
        reason,
        absoluteStart: start,
        absoluteEnd: start + oldText.length,
        chunkTag: chunkRange ? chunkRange.tag : buildChunkTagByNo(chunkNo),
        sourceType: 'imported',
        importLocateKind: 'global-unique',
        overrideKind: '',
      });
      continue;
    }

    if (hits.length > 1 && chunkRange) {
      const inChunk = hits.filter(
        (hit) => hit >= chunkRange.startIndex && hit + oldText.length <= chunkRange.endIndex,
      );
      if (inChunk.length === 1) {
        const start = inChunk[0];
        resolved.push({
          old_text: oldText,
          new_text: newText,
          reason,
          absoluteStart: start,
          absoluteEnd: start + oldText.length,
          chunkTag: chunkRange.tag,
          sourceType: 'imported',
          importLocateKind: 'chunk-unique',
          overrideKind: '',
        });
        continue;
      }
    }

    if (hits.length > 1 && Number.isInteger(pos.absoluteStart)) {
      const nearest = hits
        .map((hit) => ({ hit, dist: Math.abs(hit - pos.absoluteStart) }))
        .sort((a, b) => a.dist - b.dist)[0];

      if (nearest && nearest.dist <= POLISH_IMPORT_NEAR_POSITION_MAX_DISTANCE) {
        resolved.push({
          old_text: oldText,
          new_text: newText,
          reason,
          absoluteStart: nearest.hit,
          absoluteEnd: nearest.hit + oldText.length,
          chunkTag: chunkRange ? chunkRange.tag : buildChunkTagByNo(chunkNo),
          sourceType: 'imported',
          importLocateKind: 'position-nearest',
          overrideKind: '',
        });
        continue;
      }
    }

    unresolved.push({
      ...item,
      old_text: oldText,
      new_text: newText,
      reason,
      unresolvedReason:
        hits.length === 0
          ? '基底正文中找不到 old_text'
          : 'old_text 命中多处，且无法靠位置/分段可靠定位',
    });
  }

  return { resolved, unresolved };
}

function getImportedIdentityKey(mod) {
  const start = Number.isInteger(mod.absoluteStart) ? mod.absoluteStart : '';
  const oldText = String(mod.old_text || '');
  return `${oldText}::${start}`;
}

function mergeImportedModsPreferLatest(existing = [], incoming = []) {
  const all = [...(existing || []), ...(incoming || [])];
  const kept = [];
  const seen = new Set();

  for (let i = all.length - 1; i >= 0; i--) {
    const item = all[i];
    const key = getImportedIdentityKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }

  return kept.reverse();
}

function scoreImportedOverrideMatch(imp, scan) {
  if (!imp || !scan) return -Infinity;
  if (imp.old_text !== scan.old_text) return -Infinity;

  let score = 0;

  if (
    Number.isInteger(imp.absoluteStart) &&
    Number.isInteger(scan.absoluteStart) &&
    imp.absoluteStart === scan.absoluteStart &&
    imp.absoluteEnd === scan.absoluteEnd
  ) {
    score += 1000;
  }

  if (Number.isInteger(imp.absoluteStart) && Number.isInteger(scan.absoluteStart)) {
    const dist = Math.abs(imp.absoluteStart - scan.absoluteStart);
    if (dist <= POLISH_OVERRIDE_POSITION_TOLERANCE) {
      score += 700 - dist;
    } else if (dist <= 300) {
      score += 350 - dist;
    }
  }

  const impChunk = extractPolishChunkNumber(imp.chunkTag);
  const scanChunk = extractPolishChunkNumber(scan.chunkTag);
  if (impChunk && scanChunk && impChunk === scanChunk) {
    score += 120;
  }

  if (imp.new_text === scan.new_text) {
    score += 20;
  }

  return score;
}

function matchImportedToScan(imp, scanMods = [], usedScan = new Set()) {
  let best = null;

  for (let i = 0; i < scanMods.length; i++) {
    if (usedScan.has(i)) continue;
    const scan = scanMods[i];
    const score = scoreImportedOverrideMatch(imp, scan);
    if (score < 400) continue;

    if (!best || score > best.score) {
      best = { index: i, score };
    }
  }

  return best;
}

function getPolishModPriority(mod) {
  let p = 100;

  if (mod.sourceType === 'imported') p = 320;
  if (String(mod.overrideKind || '').includes('imported-override')) p = 420;
  if (String(mod.overrideKind || '').includes('imported-new')) p = 390;
  if (String(mod.sourceType || '').includes('effective(imported')) p = 400;
  if (String(mod.sourceType || '').includes('effective(scan)')) p = 200;
  if (mod.sourceType === 'scan') p = 180;

  switch (mod.importLocateKind) {
    case 'explicit-position-exact':
      p += 80;
      break;
    case 'global-unique':
      p += 60;
      break;
    case 'chunk-unique':
      p += 50;
      break;
    case 'position-nearest':
      p += 30;
      break;
    default:
      break;
  }

  if (Number.isInteger(mod.absoluteStart) && Number.isInteger(mod.absoluteEnd)) {
    p += Math.min(40, mod.absoluteEnd - mod.absoluteStart);
  }

  return p;
}

function stabilizePolishMods(mods = []) {
  const candidates = (mods || [])
    .filter(
      (mod) =>
        Number.isInteger(mod.absoluteStart) &&
        Number.isInteger(mod.absoluteEnd) &&
        typeof mod.old_text === 'string' &&
        typeof mod.new_text === 'string' &&
        mod.absoluteEnd >= mod.absoluteStart &&
        mod.old_text,
    )
    .map((mod, idx) => ({
      ...mod,
      __priority: getPolishModPriority(mod),
      __length: Math.max(0, mod.absoluteEnd - mod.absoluteStart),
      __index: idx,
    }))
    .sort((a, b) => {
      if (b.__priority !== a.__priority) return b.__priority - a.__priority;
      if (b.__length !== a.__length) return b.__length - a.__length;
      if (a.absoluteStart !== b.absoluteStart) return a.absoluteStart - b.absoluteStart;
      return a.__index - b.__index;
    });

  const accepted = [];

  function overlaps(existing, current) {
    return current.absoluteStart < existing.absoluteEnd && current.absoluteEnd > existing.absoluteStart;
  }

  for (const mod of candidates) {
    if (accepted.some((x) => overlaps(x, mod))) continue;
    accepted.push(mod);
  }

  return accepted
    .sort((a, b) => {
      if (a.absoluteStart !== b.absoluteStart) return a.absoluteStart - b.absoluteStart;
      if (a.absoluteEnd !== b.absoluteEnd) return a.absoluteEnd - b.absoluteEnd;
      return a.__index - b.__index;
    })
    .map(({ __priority, __length, __index, ...rest }) => rest);
}

function buildEffectivePolishMods(scanMods = [], importedMods = []) {
  const finalList = [];
  const usedScan = new Set();

  for (const imp of importedMods || []) {
    const match = matchImportedToScan(imp, scanMods, usedScan);

    if (match) {
      usedScan.add(match.index);
      finalList.push({
        ...imp,
        sourceType: 'effective(imported-override)',
        overrideKind: 'imported-override',
      });
    } else {
      finalList.push({
        ...imp,
        sourceType: 'effective(imported-new)',
        overrideKind: 'imported-new',
      });
    }
  }

  for (let i = 0; i < (scanMods || []).length; i++) {
    if (usedScan.has(i)) continue;
    finalList.push({
      ...scanMods[i],
      sourceType: 'effective(scan)',
      overrideKind: '',
    });
  }

  return stabilizePolishMods(finalList);
}

// =========================================
// 导入
// =========================================
async function runPolishImport(bookCtx, roundArg = 'latest', inputFilePath = '') {
  const roundInfo = ensureRoundForRead(bookCtx, roundArg);
  const roundNo = roundInfo.roundNo;

  if (!inputFilePath) {
    throw new Error('import 缺少 --input 文件路径');
  }
  if (!fs.existsSync(inputFilePath)) {
    throw new Error(`导入文件不存在：${inputFilePath}`);
  }

  const baseText = fs.readFileSync(getPolishRoundBaseTextPath(bookCtx.bookOutputDir, roundNo), 'utf-8');
  const raw = fs.readFileSync(inputFilePath, 'utf-8');

  const parsedItems = parseFlexiblePolishImportText(raw);
  const resolvedResult = resolveImportedPolishItemsAgainstBase(parsedItems, baseText, {
    bookDir: bookCtx.bookOutputDir,
    roundNo,
  });

  const importDir = getPolishRoundImportDir(bookCtx.bookOutputDir, roundNo);
  ensureDir(importDir);

  const importCopyPath = path.join(importDir, `import_${getCompactTimeStamp()}.txt`);
  fs.writeFileSync(importCopyPath, raw, 'utf-8');

  const existingImported = readJsonFile(getPolishRoundImportedModsPath(bookCtx.bookOutputDir, roundNo), []);
  const mergedImported = mergeImportedModsPreferLatest(existingImported, resolvedResult.resolved);
  writeJsonFile(getPolishRoundImportedModsPath(bookCtx.bookOutputDir, roundNo), mergedImported);

  const existingUnresolved = readJsonFile(getPolishRoundImportedUnresolvedPath(bookCtx.bookOutputDir, roundNo), []);
  writeJsonFile(
    getPolishRoundImportedUnresolvedPath(bookCtx.bookOutputDir, roundNo),
    [...existingUnresolved, ...resolvedResult.unresolved],
  );

  console.log(
    `✅ [Polish Import] 新增导入 ${resolvedResult.resolved.length} 条，未定位 ${resolvedResult.unresolved.length} 条 -> ${importCopyPath}`,
  );
}

// =========================================
// 应用润色
// =========================================
function applyModsToBaseText(baseText, mods = []) {
  let output = baseText;
  let replaceCount = 0;
  let skipCount = 0;

  const sorted = [...mods].sort((a, b) => {
    if (b.absoluteStart !== a.absoluteStart) return b.absoluteStart - a.absoluteStart;
    return (b.old_text || '').length - (a.old_text || '').length;
  });

  for (const mod of sorted) {
    if (!Number.isInteger(mod.absoluteStart) || !Number.isInteger(mod.absoluteEnd)) {
      skipCount += 1;
      continue;
    }

    const currentSlice = output.slice(mod.absoluteStart, mod.absoluteEnd);
    if (currentSlice !== mod.old_text) {
      skipCount += 1;
      continue;
    }

    output =
      output.slice(0, mod.absoluteStart) +
      mod.new_text +
      output.slice(mod.absoluteEnd);

    replaceCount += 1;
  }

  return { text: output, replaceCount, skipCount };
}

function buildPolishProofText(mods = [], sourceMode = 'effective', roundNo = 1) {
  const lines = [];
  lines.push('=======================================');
  lines.push(`润色记录 ${polishRoundLabel(roundNo)}`);
  lines.push(`来源: ${sourceMode}`);
  lines.push(`时间(BJT): ${getBeijingTimeStr()}`);
  lines.push('=======================================');
  lines.push('');

  mods.forEach((mod, idx) => {
    const newText = mod.new_text === '' ? '(已删除)' : mod.new_text;
    lines.push(`${idx + 1}. ${mod.reason || '润色'}`);
    lines.push(`原文: ${mod.old_text}`);
    lines.push(`校正: ${newText}`);
    if (Number.isInteger(mod.absoluteStart) && Number.isInteger(mod.absoluteEnd)) {
      lines.push(`位置: ${mod.absoluteStart} - ${mod.absoluteEnd}`);
    }
    if (mod.chunkTag) {
      const chunkNo = extractPolishChunkNumber(mod.chunkTag);
      lines.push(`分段: ${chunkNo || mod.chunkTag}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

async function runPolishApply(
  bookCtx,
  roundArg = 'latest',
  sourceMode = POLISH_DEFAULT_APPLY_SOURCE,
  archiveSource = true,
) {
  const roundInfo = ensureRoundForRead(bookCtx, roundArg);
  const roundNo = roundInfo.roundNo;
  const metaPath = getPolishRoundMetaPath(bookCtx.bookOutputDir, roundNo);
  const meta = readJsonFile(metaPath, {});

  const baseText = fs.readFileSync(getPolishRoundBaseTextPath(bookCtx.bookOutputDir, roundNo), 'utf-8');
  const scanMods = readJsonFile(getPolishRoundScanModsPath(bookCtx.bookOutputDir, roundNo), []);
  const importedMods = readJsonFile(getPolishRoundImportedModsPath(bookCtx.bookOutputDir, roundNo), []);
  const effectiveMods = buildEffectivePolishMods(scanMods, importedMods);

  writeJsonFile(getPolishRoundEffectiveModsPath(bookCtx.bookOutputDir, roundNo), effectiveMods);

  const resolved = loadPolishModsBySource(bookCtx.bookOutputDir, roundNo, sourceMode);
  if (!resolved.mods.length) {
    throw new Error(`没有可应用的润色数据：${resolved.source}`);
  }

  const stableMods = stabilizePolishMods(resolved.mods);
  const applied = applyModsToBaseText(baseText, stableMods);

  const bookName = sanitizeFileName(bookCtx.bookName);
  const roundShort = polishRoundLabel(roundNo);

  const roundFinalPath = getPolishRoundFinalPath(bookCtx.bookOutputDir, roundNo);
  const roundProofPath = getPolishRoundProofPath(bookCtx.bookOutputDir, roundNo);

  const rootCurrentAlias = path.join(bookCtx.bookOutputDir, `${bookName}_当前正文_润色后.txt`);
  const rootCurrentRoundPath = path.join(bookCtx.bookOutputDir, `${bookName}_当前正文_润色后_${roundShort}.txt`);
  const rootFullRoundPath = path.join(bookCtx.bookOutputDir, `${bookName}_全本_润色版_${roundShort}.txt`);
  const rootProofRoundPath = path.join(bookCtx.bookOutputDir, `${bookName}_润色记录_${roundShort}.txt`);
  const rootProofAlias = path.join(bookCtx.bookOutputDir, `${bookName}_当前润色记录.txt`);

  fs.writeFileSync(roundFinalPath, applied.text, 'utf-8');
  fs.writeFileSync(rootCurrentAlias, applied.text, 'utf-8');
  fs.writeFileSync(rootCurrentRoundPath, applied.text, 'utf-8');
  fs.writeFileSync(rootFullRoundPath, applied.text, 'utf-8');

  const proofText = buildPolishProofText(stableMods, resolved.source, roundNo);
  fs.writeFileSync(roundProofPath, proofText, 'utf-8');
  fs.writeFileSync(rootProofRoundPath, proofText, 'utf-8');
  fs.writeFileSync(rootProofAlias, proofText, 'utf-8');

  meta.status = 'applied';
  meta.appliedAtBjt = getBeijingTimeStr();
  meta.appliedSource = resolved.source;
  meta.finalTextLength = applied.text.length;
  meta.finalTextSha1 = sha1(applied.text);
  writeJsonFile(metaPath, meta);

  writePolishCurrentPointer(bookCtx.bookOutputDir, {
    roundNo,
    roundId: `${POLISH_ROUND_PREFIX}${polishPadRoundNo(roundNo)}`,
    currentBodyFile: path.basename(rootCurrentAlias),
    currentRoundFile: path.basename(rootCurrentRoundPath),
    currentFullRoundFile: path.basename(rootFullRoundPath),
    currentProofFile: path.basename(rootProofAlias),
    updatedAtBjt: getBeijingTimeStr(),
  });

  if (archiveSource && bookCtx.sourceFilePath && fs.existsSync(bookCtx.sourceFilePath)) {
    const archivePath = getUniqueArchivePath(path.basename(bookCtx.sourceFilePath));
    fs.renameSync(bookCtx.sourceFilePath, archivePath);
    console.log(`📦 原文件已归档至: ${archivePath}`);
  }

  console.log(
    `✅ [Polish Apply] ${bookCtx.bookName} ${roundShort} | 替换 ${applied.replaceCount} 处 | 跳过 ${applied.skipCount} 处`,
  );
  console.log(`   当前正文: ${rootCurrentAlias}`);
  console.log(`   覆盖版全本: ${rootFullRoundPath}`);
  console.log(`   润色记录: ${rootProofRoundPath}`);
}

// =========================================
// 状态
// =========================================
async function runPolishStatus(bookArg = '') {
  const books = getAllKnownBooks();

  if (!books.length) {
    console.log('没有找到任何书。');
    return;
  }

  const targets = bookArg ? [resolveBookContextForRead(bookArg)] : books;

  for (const bookCtx of targets) {
    const rounds = listPolishRounds(bookCtx.bookOutputDir);
    if (!rounds.length) {
      console.log(`\n📘 ${bookCtx.bookName} | 无 polish round`);
      continue;
    }

    const pointer = readJsonFile(getPolishPointerPath(bookCtx.bookOutputDir), null);
    console.log(`\n📘 ${bookCtx.bookName}`);
    console.log(`   输入存在: ${bookCtx.sourceFilePath && fs.existsSync(bookCtx.sourceFilePath) ? '是' : '否'}`);
    if (pointer && pointer.currentBodyFile) {
      console.log(`   当前正文: ${pointer.currentBodyFile}`);
    }

    for (const item of rounds) {
      const scanMods = readJsonFile(getPolishRoundScanModsPath(bookCtx.bookOutputDir, item.roundNo), []);
      const importedMods = readJsonFile(getPolishRoundImportedModsPath(bookCtx.bookOutputDir, item.roundNo), []);
      const effectiveMods = readJsonFile(getPolishRoundEffectiveModsPath(bookCtx.bookOutputDir, item.roundNo), []);
      console.log(
        `   - ${polishRoundLabel(item.roundNo)} | status=${(item.meta && item.meta.status) || 'open'} | scan=${scanMods.length} | imported=${importedMods.length} | effective=${effectiveMods.length}`,
      );
    }
  }
}

// =========================================
// CLI
// =========================================
function parseCliArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  let command = 'help';

  if (args[0] && !args[0].startsWith('--')) {
    command = String(args.shift()).trim();
  }

  const options = { _: [] };

  for (let i = 0; i < args.length; i++) {
    const item = args[i];

    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = args[i + 1];

      if (next && !next.startsWith('--')) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
    } else {
      options._.push(item);
    }
  }

  return { command, options };
}

function printCliHelp() {
  console.log(`
=========================================
      run.js v2 独立润色系统
=========================================

目录约定：
- 待润色 TXT：./润色
- 原文归档：./润色（原）
- 输出目录：./已润色
- API Key 文件：./api0.txt

注意：
- scan 只会处理 “润色” 目录里的 txt
- 不会再扫描 “已润色” 的历史目录
- 一轮新的 round，其 base_text 一定来自 当前的 润色/书名.txt

一、预检 Key
-----------------------------------------
node run.js test

二、阶段一：扫描润色建议
-----------------------------------------
node run.js scan
node run.js 1
node run.js scan --book "书名"
node run.js scan --book "书名" --round next
node run.js scan --book "书名" --round latest

说明：
- scan 不带 --book 时，只处理 ./润色 目录当前存在的 txt
- 如果 ./润色 为空，会直接提示为空

三、导出给 ChatGPT / 我看的润色清单
-----------------------------------------
node run.js export --book "书名"
node run.js export --book "书名" --source scan
node run.js export --book "书名" --source imported
node run.js export --book "书名" --source effective

四、导入你整理/我二次润的自由文本
-----------------------------------------
node run.js import --book "书名" --input "我的二次润色.txt"

支持格式：
1）标准格式
删除生硬直译，使表达更自然
原文: 开了狂野的第一枪
校正: 开了第一枪
位置: 20025 - 20033
分段: 3

2）箭头格式
删除生硬直译，使表达更自然
开了狂野的第一枪 -> 开了第一枪
20025-20033
3

3）自由格式
删除生硬直译，使表达更自然
原文 开了狂野的第一枪
改成 开了第一枪
位置 20025 - 20033

五、阶段二：应用润色
-----------------------------------------
node run.js apply --book "书名"
node run.js 2 --book "书名"
node run.js apply --book "书名" --source imported
node run.js apply --book "书名" --source effective
node run.js apply --book "书名" --archive no

默认：
- source=effective
- archive=yes（如果原文还在 ./润色，会自动归档到 ./润色（原））

六、查看状态
-----------------------------------------
node run.js status
node run.js status --book "书名"

七、帮助
-----------------------------------------
node run.js help
`);
}

async function main() {
  const { command, options } = parseCliArgs(process.argv.slice(2));

  if (command === 'help' || command === '-h' || command === '--help' || !command) {
    printCliHelp();
    return;
  }

  if (command === 'test') {
    await preflightCheck();
    return;
  }

  if (command === 'scan' || command === '1') {
    const targetBook = options.book || options._[0] || '';

    if (targetBook) {
      const bookCtx = resolveBookContextForScan(targetBook);
      await runPolishScanForBook(bookCtx, options.round || 'auto');
      return;
    }

    const inputBooks = listInputBooks();
    if (!inputBooks.length) {
      console.log(`没有找到需要处理的文件。请把 TXT 放到：${INPUT_DIR}`);
      return;
    }

    for (const bookCtx of inputBooks) {
      await runPolishScanForBook(bookCtx, options.round || 'auto');
    }
    return;
  }

  if (command === 'export') {
    const bookCtx = resolveBookContextForRead(options.book || options._[0] || '');
    await runPolishExport(
      bookCtx,
      options.round || 'latest',
      options.source || POLISH_EXPORT_DEFAULT_SOURCE,
    );
    return;
  }

  if (command === 'import') {
    const bookCtx = resolveBookContextForRead(options.book || options._[0] || '');
    const inputPath = options.input || options.file || options._[1] || '';
    await runPolishImport(bookCtx, options.round || 'latest', inputPath);
    return;
  }

  if (command === 'apply' || command === '2' || command === 'merge') {
    const bookCtx = resolveBookContextForRead(options.book || options._[0] || '');
    const archiveSource = String(options.archive || 'yes').toLowerCase() !== 'no';
    await runPolishApply(
      bookCtx,
      options.round || 'latest',
      options.source || POLISH_DEFAULT_APPLY_SOURCE,
      archiveSource,
    );
    return;
  }

  if (command === 'status') {
    await runPolishStatus(options.book || options._[0] || '');
    return;
  }

  throw new Error(`未知命令：${command}。可用 node run.js help 查看帮助。`);
}

main().catch((error) => {
  if (error && error.code === 'ALL_KEYS_DAILY_LIMIT_REACHED') {
    console.error(`\n🛑 [Stop] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.error(
    '\n❌ 运行失败：',
    error && (error.stack || error.message) ? (error.stack || error.message) : error,
  );
  process.exitCode = 1;
});