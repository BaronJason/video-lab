# Video Lab

批量成片项目管理器（Electron 桌面应用）。

## 功能

- 扫描工作目录下的项目与 TXT 配置文件，按日期分支管理版本
- 配置编辑：路径列表（可拖拽排序）、取消轮询、排除字段、水印 PNG
- 预检测：统计合规视频数量与分组，异常路径整行高亮提示
- 调用 PowerShell 脚本批量生成成片（临时弹出终端显示实时进度）
- 任务列表窗口：实时互斥锁状态、进度条与日志；排队任务可暂停 / 继续 / 停止；失败时保留完整输出并红字提示原因
- 日志浏览、完全复刻 / 去重复刻两种复刻模式
- 项目列表 A-Z 拼音索引条、名称 / 时间排序切换、皮肤切换、日志全局搜索
- 侧栏 / 预览区宽度均可拖拽调整

## 目录结构

```
Video Lab/
└─ resources/
   └─ app/                 # 应用源码
      ├─ main.js           # Electron 主进程
      ├─ preload.js        # 渲染进程桥接
      ├─ backend.js        # 后端业务逻辑
      ├─ frontend/         # 渲染进程页面与样式（含皮肤 skins/）
      └─ package.json
```

运行时由 `app.asar` 加载应用源码；修改源码后需用 `@electron/asar` 重新打包才生效。

## 运行环境

应用依赖以下外部环境（便携 zip 不含这些，请按需安装；应用底部状态栏会检测并在缺失时红字提醒）：

### PowerShell 7（pwsh）

```
winget install --id Microsoft.PowerShell
```

或前往官方发布页下载：<https://github.com/PowerShell/PowerShell/releases>

### FFmpeg（ffmpeg / ffprobe，需 Gyan 官方 full build）

- 下载页：<https://www.gyan.dev/ffmpeg/builds/>
- 直接下载：<https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z>

解压后把 `bin` 目录加入系统 PATH。也可用 winget 快速安装：

```
winget install --id Gyan.FFmpeg
```

## 首次运行

便携版不预置 config.json。首次运行时，应用会逐个弹出对话框引导选择（可取消），结果写入同目录 config.json：

1. 项目数据根目录：存放各项目文件夹及 TXT 配置（必选）
2. 脚本目录：放置批量拼接、视频复刻脚本（可稍后补）
3. 水印默认目录：水印 PNG 所在目录（可稍后补）

## 构建与运行

```
npm install
npm start        # 开发运行
npm run dist     # 打包
```
