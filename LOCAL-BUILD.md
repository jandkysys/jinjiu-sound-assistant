# 小金条音效助手 — Windows 本地 Electron 打包说明

> **打包在本地 Windows 电脑执行，不在 Replit 中进行。**
> ZIP 内的 `package.json` 和 `pnpm-lock.yaml` 已经验证可用，直接按步骤操作即可。

---

## 前置准备（仅首次）

| 工具 | 安装地址 |
|------|----------|
| Node.js 20 LTS | https://nodejs.org |
| pnpm | 安装 Node 后运行：`npm install -g pnpm` |

---

## 目录结构说明

从 Replit 下载 ZIP，解压到任意目录（例如 `C:\Projects\xjt\`）：

```
C:\Projects\xjt\
├── sound-assistant\         ← 主工程目录
│   ├── package.json         ← 已包含所有真实版本号，无 catalog:，无 @replit/*
│   ├── pnpm-lock.yaml       ← 已验证的锁文件，直接使用
│   ├── vite.electron.config.ts
│   ├── tsconfig.electron.json
│   ├── electron-builder.yml
│   ├── electron\
│   │   ├── main.js           ← 主进程（含悬浮窗 + 托盘逻辑）
│   │   ├── preload.js        ← 主窗口预加载
│   │   ├── preload-float.js  ← 悬浮窗预加载（新）
│   │   └── float.html        ← 悬浮窗 UI（新）
│   └── src\
└── lib\
    └── api-client-react\    ← Vite alias 目标，自动引用，无需单独安装
        └── src\
```

---

## 打包步骤

### 第一步：进入工程目录

```cmd
cd C:\Projects\xjt\sound-assistant
```

### 第二步：安装依赖

```cmd
pnpm install
```

> 首次安装会下载 Electron 二进制（约 80–100 MB），请耐心等待。
> 网络慢可设置镜像加速（见下方常见问题）。

### 第三步：构建前端

```cmd
pnpm run build
```

Vite 将源码打包到 `dist\electron\` 目录。

### 第四步：打包 Windows 安装包

```cmd
pnpm run dist
```

打包完成后安装包位于：

```
sound-assistant\release\
└── 小金条音效助手 Setup 1.0.0.exe
```

双击安装，桌面和开始菜单自动创建快捷方式。

---

## 新功能：桌面悬浮快捷键开关

启动后会出现两个独立的窗口：

| 窗口 | 说明 |
|------|------|
| **主窗口** | 音效管理面板，正常使用 |
| **金色胶囊** | 130×46 px，始终显示在所有窗口上方 |

### 胶囊状态显示

| 状态 | 外观 |
|------|------|
| 已开启 | 金色渐变 · 🎵 已开启 · 绿色指示点 |
| 已关闭 | 灰色 · 🔇 已关闭 · 灰色指示点 |

### 操作方式

| 操作 | 效果 |
|------|------|
| **单击**胶囊 | 开启 / 关闭音效快捷键 |
| **右键**胶囊 | 显示主窗口 / 开关快捷键 / 隐藏胶囊 / 退出 |
| **拖动**胶囊边缘 | 移动到屏幕任意位置 |
| 主页面按钮切换 | 胶囊自动同步状态 |

### 状态同步机制

```
主页面开启快捷键 → 胶囊显示"已开启"
胶囊点击关闭    → 主页面显示"已关闭"
托盘菜单切换    → 主页面 + 胶囊同步更新
```

### 关闭行为

- 主窗口点 ❌ → **隐藏到托盘**（不退出，快捷键继续工作）
- 系统托盘右键 → **退出软件** → 真正退出并释放所有全局快捷键

### 直播场景使用流程

```
1. 打开软件 → 主窗口配置音效 / 绑定全局快捷键（F1、Ctrl+1 等）
2. 最小化主窗口 → 主窗口隐藏到托盘
3. 打开抖音直播伴侣 / OBS
4. 直播中：金色胶囊始终悬浮 → 确认快捷键"已开启"
5. 按绑定的全局快捷键（F1 等）→ 音效正常触发（主窗口最小化也可用）
```

---

## 可选：添加自定义图标

1. 准备一张 **1024×1024** 的 PNG（建议暖金色小金条 Logo）
2. 用 [icoconvert.com](https://icoconvert.com) 转为 `.ico`
3. 放到 `electron\resources\icon.ico`
4. 在 `electron-builder.yml` 中取消注释 `# icon: electron/resources/icon.ico`

---

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| `electron` 下载超时 | `npm config set electron_mirror https://npmmirror.com/mirrors/electron/` |
| `Cannot find module` | 检查 `lib\api-client-react\src\` 是否存在（需完整解压 ZIP） |
| 安装包无图标 | 按上方步骤准备 icon.ico，否则用默认图标也可运行 |
| 全局快捷键被占用 | 在音效助手设置中换一个组合键 |
| NSIS 报错找不到 NSIS | `pnpm install` 后 electron-builder 会自动下载，等待即可 |
| 胶囊被遮住 | 胶囊已设为 screen-saver 最高层级，通常不会被遮挡 |
| 字母键最小化后无效 | 正常现象：字母键需要窗口聚焦；最小化后只有全局快捷键（F1/Ctrl+N 等）有效 |
