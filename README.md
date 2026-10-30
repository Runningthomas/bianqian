# 桌面便签 BianQian

贴纸式桌面便签。**桌面版 + 网页版共用同一套界面代码**，数据通过 GitHub Gist 跨设备同步。

## 两种形态，同一份界面

| | 桌面版 | 网页版 |
|---|---|---|
| 入口 | `桌面便签.exe`（便携版，免安装） | 浏览器打开网址，手机/平板也能用 |
| 特有能力 | 贴边隐藏、托盘常驻、Ctrl+Alt+B 速记、系统提醒、开机自启 | 可安装到桌面/主屏，断网可用 |
| 数据位置 | `%APPDATA%\BianQian\data.json` | 浏览器 localStorage |
| 同步方式 | Gist / WebDAV / 同步文件夹 | Gist |

界面代码全部在 `web/` 目录：
- `core.js` —— 数据模型 + 合并算法（LWW）+ 设置默认值，**Node 与浏览器共用同一份**
- `api.js` —— 平台适配层，按环境注入 `window.api`
- `app.js` —— 界面逻辑（渲染、拖拽、编辑）
- `style.css` —— 贴纸卡片风格

## 快速上手

1. 双击 `桌面便签.exe`（绿色便携版）
2. 点右下角 ＋ 或双击空白处贴一张新便签
3. 拖便签顶部的把手可以自由摆放位置

### 贴边隐藏
把窗口推到屏幕左/右/顶部边缘停一下，窗口自动滑出只留一条 6px 细边；鼠标移过去即滑回，移开后自动收回。

### 速记小窗
托盘菜单 →「速记小窗」，或全局快捷键 **Ctrl+Alt+B**。

## 跨电脑同步

推荐 **GitHub Gist**（桌面版和网页版都能用，数据自动互通）：

1. GitHub → Settings → Developer settings → Personal access tokens → 生成一个勾选 `gist` 权限的 Token
2. 软件里 ⚙ → 云同步 → 选「GitHub」→ 填 Token → 点「创建」自动建 Gist

**换电脑**：旧电脑点「复制同步设置码」，新电脑（网页或桌面版）点「粘贴设置码」。

其他方式：坚果云 WebDAV、同步文件夹（指向 OneDrive / 坚果云等目录）。这两种仅桌面版可用。

> 数据以「逐条便签」为单位合并：两边都改了同一条时保留最近修改的那份；删除也会同步（有墓碑防复活）。

## 网页版部署

`.github/workflows/deploy.yml` 会把 `web/` 目录自动发布到 GitHub Pages：

```bash
git push origin main   # 推上去后自动发布，网址不变
```

## 开发

```bash
npm install        # 安装依赖
npm start          # 运行桌面版
npm test           # 同步/合并算法测试
npm run selfcheck  # 桌面版端到端自检
npm run dist       # 打包便携 exe → dist/
```

## 数据安全

- 桌面版本地数据：`%APPDATA%\BianQian\data.json`
- 网页版本地数据：浏览器 localStorage
- 设置里可随时「导出备份 / 导入（合并）」JSON
