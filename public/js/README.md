# 前端模块说明

原 `app.js` (1300+ 行) 已拆分为以下模块：

## 模块结构

```
js/
├── utils.js    - 工具函数（字体大小、敏感信息隐藏）
├── ui.js       - UI组件（Toast、Modal、Loading、Tab切换）
├── auth.js     - 认证相关（登录、登出、OAuth授权）
├── tokens.js   - Token管理（增删改查、启用禁用、内联编辑）
├── quota.js    - 额度管理（查看、刷新、缓存、内嵌显示）
├── config.js   - 配置管理（加载、保存、轮询策略）
└── main.js     - 主入口（初始化、事件绑定）
```

## 加载顺序

模块按依赖关系加载（在 `index.html` 中）：

1. **utils.js** - 基础工具函数
2. **ui.js** - UI组件（依赖 utils）
3. **auth.js** - 认证模块（依赖 ui）
4. **quota.js** - 额度模块（依赖 auth）
5. **tokens.js** - Token模块（依赖 auth、quota、ui）
6. **config.js** - 配置模块（依赖 auth、ui）
7. **main.js** - 主入口（依赖所有模块）

## 模块职责

### utils.js
- 字体大小设置和持久化
- 敏感信息显示/隐藏切换
- localStorage 管理

### ui.js
- Toast 提示框
- Confirm 确认框
- Loading 加载遮罩
- Tab 页面切换

### auth.js
- 用户登录/登出
- OAuth 授权流程
- authFetch 封装（自动处理401）
- Token 认证状态管理

### tokens.js
- Token 列表加载和渲染
- Token 增删改查操作
- 内联字段编辑（projectId、email）
- Token 详情弹窗

### quota.js
- 额度数据缓存（5分钟TTL）
- 内嵌额度摘要显示
- 额度详情展开/收起
- 额度弹窗（多账号切换）
- 强制刷新额度

### config.js
- 配置加载（.env + config.json）
- 配置保存（分离敏感/非敏感）
- 轮询策略管理
- 轮询状态显示

### main.js
- 页面初始化
- 登录表单事件绑定
- 配置表单事件绑定
- 自动登录检测

## 全局变量

跨模块共享的全局变量：

- `authToken` - 认证令牌（auth.js）
- `cachedTokens` - Token列表缓存（tokens.js）
- `currentQuotaToken` - 当前查看的额度Token（quota.js）
- `quotaCache` - 额度数据缓存对象（quota.js）
- `sensitiveInfoHidden` - 敏感信息隐藏状态（utils.js）

## 优势

1. **可维护性** - 每个模块职责单一，易于定位和修改
2. **可读性** - 文件大小合理（200-400行），代码结构清晰
3. **可扩展性** - 新增功能只需修改对应模块
4. **可测试性** - 模块独立，便于单元测试
5. **协作友好** - 多人开发时减少冲突

## 注意事项

1. 模块间通过全局变量和函数通信
2. 保持加载顺序，避免依赖问题
3. 修改时注意跨模块调用的函数