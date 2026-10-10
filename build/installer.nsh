; ═══════════════════════════════════════════════════════════════════════════
;  Video Lab 安装程序自定义脚本（A6 · 弃用便携包与旧仓库过渡方案 §九）
;
;  背景
;    便携版用户升级时会被引导改用安装版（应用内「安装更新并重启」）。正常路径下，
;    应用已在退出前完成「静默搬迁（数据落到 %APPDATA%\Video Lab）+ 写线索」，安装程序无需干预。
;
;    但存在绕过场景：用户**未曾运行过 2.5.1**，直接把便携目录留在原处、手动安装了本安装包。
;    此时应用没机会搬迁，新版启动就会看不到旧设置（用户视角＝"设置丢了"）。
;
;  对策（刻意「不代搬」）
;    安装前检查线索文件 %LOCALAPPDATA%\Video Lab\portable-origin.json：
;      · 存在  → 说明用户用过便携版 → 写一份「接管标记」pending-takeover.json
;                （仅作信号，不在此解析路径、不复制数据）
;      · 不存在 → 什么都不做
;    标记交由应用**首次启动时自行处理**：应用侧 _adoptDirAsDataRoot() 已有完整逻辑
;    （复制三库含 sqlite -wal/-shm、改 config_storage、touch mtime、源侧改名 .migrated 防回滚），
;    且会自行核对「appdata 侧尚无数据 + 线索里的目录仍有效」才动手 —— 幂等。
;    刻意不在安装程序里复制数据：两套实现必然漂移，出错时用户数据风险不可控。
; ═══════════════════════════════════════════════════════════════════════════

!macro customInstall
  ; 线索存在即写接管标记。不做 JSON 解析、不判断 migrated：
  ; 应用侧会核对 appdata 是否已有数据（有则直接跳过并清理标记），因此"多写"无害。
  IfFileExists "$LOCALAPPDATA\Video Lab\portable-origin.json" 0 vl_no_takeover
    CreateDirectory "$LOCALAPPDATA\Video Lab"
    FileOpen $0 "$LOCALAPPDATA\Video Lab\pending-takeover.json" w
    FileWrite $0 '{"from":"installer"}$\r$\n'
    FileClose $0
  vl_no_takeover:
!macroend
