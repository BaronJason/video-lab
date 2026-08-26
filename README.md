<div align="center">

# <img src="icon/app-icon.png" width="30" height="30" style="vertical-align:-6px"> Video Lab

**批量成片项目管理器 · Electron 桌面应用**

扫描项目与 TXT 配置，按日期分支管理版本，一键调用脚本批量生成成片。

<br>

[![版本](https://img.shields.io/badge/版本-1.4.3-0078D7?style=flat-square)](https://github.com/BaronJason/video-lab/releases)
![Platform](https://img.shields.io/badge/平台-Windows%2010%2F11-00A4EF?style=flat-square)
![PowerShell](https://img.shields.io/badge/运行时-PowerShell%207-5391FE?style=flat-square)
![FFmpeg](https://img.shields.io/badge/FFmpeg-必需-FF7F2A?style=flat-square)

</div>

---

## 功能亮点

| 类别 | 说明 |
| --- | --- |
| 预检测 | 合规视频统计与分组，异常路径整行高亮提示 |
| 批量成片 | 多任务并发安全（互斥锁排队），单成片实时进度与日志 |
| 任务列表 | 任务失败保留完整输出并在行内以红字提示失败原因；排队任务便于管理 |
| 复刻模式 | 完全复刻 / 去重复刻双模式，日志全局搜索 |
| 索引与排序 | A-Z 拼音索引条快速定位、皮肤切换（主题自适应） |

## 目录结构

```
Video Lab/
└─ resources/
   └─ app/                 # 应用源码
      ├─ frontend/         # 渲染进程页面与样式（含皮肤 skins/）
      ├─ main.js           # Electron 主进程
      ├─ preload.js        # 渲染进程桥接
      ├─ backend.js        # 后端业务逻辑
      └─ package.json
```

> 运行时由 `app.asar` 加载应用源码；修改源码后需用 `@electron/asar` 重新打包才生效。

## 运行环境

应用依赖以下外部环境（便携 zip 不含这些，请按需安装；应用底部状态栏会检测并在缺失时红字提醒）：

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

选择并保存工作路径后，软件会自动扫描现有配置、填入水印默认目录并开始检测，无需手动设置；批量拼接 / 视频复刻脚本已内置在应用的 `resources\Scripts` 目录。跳过时主界面会显示「选择路径」引导提示。配置与缓存的实际保存位置（程序目录 / 用户数据目录）可在设置页「配置和数据保存位置」中调整。

## 构建与运行

```bash
npm install
npm start        # 开发运行
npm run dist     # 打包
```

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)。