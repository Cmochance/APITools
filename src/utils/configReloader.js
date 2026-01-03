import config, { getConfigJson, buildConfig } from '../config/config.js';

/**
 * 重新加载配置到 config 对象
 */
export function reloadConfig() {
  const newConfig = buildConfig(getConfigJson());
  Object.assign(config, newConfig);
}
