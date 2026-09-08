<div align="center">

# <img src="icon/app-icon.png" width="30" height="30" style="vertical-align:-6px"> Video Lab

**批量成片项目管理器 · Electron 桌面应用**

扫描项目与 TXT 配置，按日期分支管理版本，一键调用脚本批量生成成片。

<br>

[![版本](https://img.shields.io/badge/版本-1.7.0-0078D7?style=flat-square)](https://github.com/BaronJason/video-lab/releases)
![Platform](https://img.shields.io/badge/平台-Windows%2010%2F11-00A4EF?style=flat-square)
![PowerShell](https://img.shields.io/badge/运行时-PowerShell%207-5391FE?style=flat-square)
![FFmpeg](https://img.shields.io/badge/FFmpeg-必需-FF7F2A?style=flat-square)

</div>

---

## 功能亮点

| 类别 | 说明 |
| --- | --- |
| 遮罩叠加 | 多原片 × 多遮罩自由组合（遮罩+水印 / 仅水印 / 仅遮罩），GPU 硬件编码，失败任务断点续跑 |
| 复刻与续跑 | 完全复刻 / 去重复刻双模式，失败成片可「继续制作」从断点恢复 |
| 日期分支管理 | TXT 配置按日期分支归档，历史版本随时比对与跳转 |
| 水印体系 | 归属校验、跨项目保存、主流水印一键递归替换 |
| 深度定制界面 | 多皮肤主题（含 Maid Atelier 女仆皮肤）、自制标题栏、托盘菜单自绘 |
| 后台化体验 | 预检测与成片索引后台运行不阻塞、开机自启静默到托盘、冷启动提速 |

## 目录结构

```
Video Lab/
├─ build/               # 打包钩子（afterPack.js）
├─ frontend/            # 渲染进程页面、样式与脚本
│  ├─ index.html        # 主窗口页面
│  ├─ settings.*        # 设置页（html/js/css）
│  ├─ task.*            # 任务列表（html/js）
│  ├─ guide.* / preview.html / trayMenu.html
│  ├─ app.js / icons.js / styles.css / titlebar.js
│  ├─ skins/            # 皮肤（Black_Orange / white_blue / Maid_Atelier + assets）
│  └─ assets/           # 前端静态资源（内置字体等）
├─ icon/                # 应用图标
├─ scripts/             # 成片处理脚本（构建时内置到 resources\Scripts）
├─ main.js              # Electron 主进程
├─ preload.js           # 渲染进程桥接
├─ backend.js           # 后端业务逻辑
├─ run.js               # 启动入口（run.js 启动）
├─ package.json / package-lock.json
└─ CHANGELOG.md / LICENSE / NOTICE
```

> 运行时由 `app.asar` 加载应用源码；修改源码后需用 `@electron/asar` 重新打包才生效。

## 运行环境

应用依赖以下外部环境（便携版与安装版均不内置，请按需安装；应用会在缺失时于状态栏提醒）：

- **NVIDIA 显卡（必需）**

  视频编码使用 NVIDIA NVENC 硬件编码器，必须配备 NVIDIA 独立显卡才能生成成片；
  暂不支持 CPU 回退编码，也不支持 AMD / Intel 等其他显卡的硬件编码。

- **PowerShell 7（pwsh）**

  ```bash
  winget install --id Microsoft.PowerShell
  ```

  或前往官方发布页下载：<https://github.com/PowerShell/PowerShell/releases>

- **FFmpeg / FFprobe（Gyan 官方 full build）**

  - 下载页：<https://www.gyan.dev/ffmpeg/builds/>
  - 直接下载：<https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z>

  解压后把 `bin` 目录加入系统 PATH。也可用 winget 快速安装：

  ```bash
  winget install --id Gyan.FFmpeg
  ```

## 首次运行

便携版不预置 `config.json`。首次运行（或未设置工作路径）时，应用会打开「首次设置」引导窗口：

1. **项目数据根目录**：存放各项目文件夹与 TXT 配置（必选，也可直接跳过）

选择并保存工作路径后，软件会自动扫描现有配置、填入水印默认目录并开始检测，无需手动设置；跳过时主界面会显示「选择路径」引导提示。配置与缓存的实际保存位置（程序目录 / 用户数据目录）可在设置页「配置和数据保存位置」中调整。

## 构建与运行

```bash
npm install
npm start        # 开发运行
npm run dist     # 打包
```

> 成片处理脚本（`video_batch.ps1` / `video_mask.ps1` / `video_replica.ps1`）随仓库托管于 `scripts/` 目录，构建时自动拷入产物的 `resources\Scripts`；运行时若缺失会在状态栏提示环境问题。

## 皮肤素材来源与许可

内置皮肤「深海女仆（Maid Atelier）」移植自开源皮肤项目 `maid-atelier`（dsh-deep-whale 仓库）：

- 皮肤项目地址：<https://github.com/Small-tailqwq/dsh-deep-whale/tree/main/maid-atelier>
- 皮肤源码与素材授权协议：知识共享 署名-非商业性使用-相同方式共享 4.0 国际（**[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**）

按 CC BY-NC-SA 4.0 的署名要求，本皮肤保留完整创作链，原始作者与主页如下：

| 创作层 | 作者 | 说明 | 来源 |
| --- | --- | --- | --- |
| 一创 | 上善（上善无形） | 鲸鱼娘（whale-girl）角色形象原作 | [Pixiv](https://www.pixiv.net/users/62155430) · [Bilibili](https://b23.tv/8h5L4xz) |
| 二创 | ZipZipPipe | 女仆鲸鱼娘二次设计（含 DeepSeek 元素，GPT Image 2 生成） | [Pixiv](https://www.pixiv.net/users/18604994) · [Bilibili](https://b23.tv/Pnw6nG8) |
| 三创（皮肤实现） | Small-tailqwq | DeepSeek 元素再设计与皮肤工程实现 | [GitHub](https://github.com/Small-tailqwq/dsh-deep-whale) |

皮肤工程脚手架来自 [zhu1090093659/dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)（作者：Solitude）。

依据授权条款：本皮肤素材仅限**非商业性**使用；对包含本皮肤的部分进行再分发或修改时，须以**相同方式共享（ShareAlike）**并保留上述署名与完整创作链。

本仓库整体以 **[CC BY-NC-SA 4.0](./LICENSE)** 授权，完整许可文本见 `LICENSE`，创作链与第三方素材声明见 `NOTICE`。

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)。