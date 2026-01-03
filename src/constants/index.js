/**
 * 应用常量定义
 * @module constants
 */

// ==================== 缓存相关常量 ====================

/**
 * 文件缓存有效期（毫秒）
 * @type {number}
 */
export const FILE_CACHE_TTL = 5000;

/**
 * 文件保存延迟（毫秒）- 用于 debounce
 * @type {number}
 */
export const FILE_SAVE_DELAY = 1000;

/**
 * 额度缓存有效期（毫秒）- 5分钟
 * @type {number}
 */
export const QUOTA_CACHE_TTL = 5 * 60 * 1000;

/**
 * 额度清理间隔（毫秒）- 1小时
 * @type {number}
 */
export const QUOTA_CLEANUP_INTERVAL = 60 * 60 * 1000;

/**
 * 模型列表缓存默认有效期（毫秒）- 1小时
 * @type {number}
 */
export const MODEL_LIST_CACHE_TTL = 60 * 60 * 1000;

// ==================== 内存管理常量 ====================

// 注意：内存压力阈值现在由 memoryManager 根据用户配置的 memoryThreshold 动态计算
// 用户配置的 memoryThreshold（MB）即为高压力阈值，其他阈值按比例计算：
// - LOW: 30% 阈值
// - MEDIUM: 60% 阈值
// - HIGH: 100% 阈值（用户配置值）
// - TARGET: 50% 阈值

/**
 * GC 冷却时间（毫秒）
 * @type {number}
 */
export const GC_COOLDOWN = 10000;

/**
 * 默认内存检查间隔（毫秒）
 * @type {number}
 */
export const MEMORY_CHECK_INTERVAL = 30000;

// ==================== 服务器相关常量 ====================

/**
 * 默认心跳间隔（毫秒）
 * @type {number}
 */
export const DEFAULT_HEARTBEAT_INTERVAL = 15000;

/**
 * 默认服务器端口
 * @type {number}
 */
export const DEFAULT_SERVER_PORT = 8045;

/**
 * 默认服务器主机
 * @type {string}
 */
export const DEFAULT_SERVER_HOST = '0.0.0.0';

/**
 * 默认请求超时（毫秒）
 * @type {number}
 */
export const DEFAULT_TIMEOUT = 300000;

/**
 * 默认重试次数
 * @type {number}
 */
export const DEFAULT_RETRY_TIMES = 3;

/**
 * 默认最大请求体大小
 * @type {string}
 */
export const DEFAULT_MAX_REQUEST_SIZE = '50mb';

// ==================== Token 轮询相关常量 ====================

/**
 * 默认每个 Token 请求次数后切换
 * @type {number}
 */
export const DEFAULT_REQUEST_COUNT_PER_TOKEN = 50;

/**
 * Token 过期提前刷新时间（毫秒）- 5分钟
 * @type {number}
 */
export const TOKEN_REFRESH_BUFFER = 300000;

// ==================== 生成参数默认值 ====================

/**
 * 默认生成参数
 */
export const DEFAULT_GENERATION_PARAMS = {
  temperature: 1,
  top_p: 0.85,
  top_k: 50,
  max_tokens: 32000,
  thinking_budget: 1024
};

/**
 * reasoning_effort 到 thinkingBudget 的映射
 */
export const REASONING_EFFORT_MAP = {
  low: 1024,
  medium: 16000,
  high: 32000
};

// ==================== 图片相关常量 ====================

/**
 * 默认最大保留图片数量
 * @type {number}
 */
export const DEFAULT_MAX_IMAGES = 10;

/**
 * MIME 类型到文件扩展名映射
 */
export const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

// ==================== 停止序列 ====================

/**
 * 默认停止序列
 * @type {string[]}
 */
export const DEFAULT_STOP_SEQUENCES = [
  '<|user|>',
  '<|bot|>',
  '<|context_request|>',
  '<|endoftext|>',
  '<|end_of_turn|>'
];

// ==================== 管理员默认配置 ====================

// 注意：管理员凭据（用户名、密码、JWT密钥）现在由 config.js 自动生成随机值
// 如果用户未配置，启动时会在控制台显示生成的凭据
// 不再使用硬编码的默认值，提高安全性