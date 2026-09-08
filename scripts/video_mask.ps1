# -*- coding: utf-8 -*-
# Video Lab — 遮罩叠加脚本（模式1=遮罩+水印 / 模式2=仅水印 / 模式3=仅遮罩）
# 由 Video Lab 遮罩叠加窗口提交任务，环境变量驱动；多原片文件夹×多遮罩全组合。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ------------------------------ 全局参数（环境变量注入） -------------------------------------
$MaskMode = 1         # MASK_MODE          1/2/3
$RawVideoDirs = ""    # MASK_RAW_DIRS      原片文件夹，分号分隔（多文件夹）
$Videos = ""          # MASK_VIDEOS        勾选原片完整路径，分号分隔；空=全部
$MaskDirs = ""        # MASK_MASK_DIRS     遮罩目录（主题文件夹），分号分隔（模式1/3）
$Masks = ""           # MASK_MASKS         勾选遮罩完整路径，分号分隔；空=全部
$WatermarkMov = ""    # MASK_WATERMARK     水印mov（模式1/2）
$OutputDir = ""       # MASK_OUTPUT_DIR    成片输出目录（成片直接落在此目录下）
$LogDir = ""          # MASK_LOG_DIR       遮罩叠加日志目录（项目下独立子文件夹）
$OnlyNames = ""       # MASK_ONLY_NAMES    续跑过滤，分号分隔成片名；空=全部
$SuffixMark = ""      # MASK_SUFFIX_MARK   成片名序号前的后缀（可空，参考批量模式 名称-后缀序号）
$SubmitTs = 0         # MASK_SUBMIT_TS     提交时刻（跨天命名）
$Script:HasError = $false

if ($env:MASK_MODE) { try { $MaskMode = [int]$env:MASK_MODE } catch {} }
if ($env:MASK_RAW_DIRS) { $RawVideoDirs = [string]$env:MASK_RAW_DIRS }
if ($env:MASK_VIDEOS) { $Videos = [string]$env:MASK_VIDEOS }
if ($env:MASK_MASK_DIRS) { $MaskDirs = [string]$env:MASK_MASK_DIRS }
if ($env:MASK_MASKS) { $Masks = [string]$env:MASK_MASKS }
if ($env:MASK_WATERMARK) { $WatermarkMov = [string]$env:MASK_WATERMARK }
if ($env:MASK_OUTPUT_DIR) { $OutputDir = [string]$env:MASK_OUTPUT_DIR }
if ($env:MASK_LOG_DIR) { $LogDir = [string]$env:MASK_LOG_DIR }
if ($env:MASK_ONLY_NAMES) { $OnlyNames = [string]$env:MASK_ONLY_NAMES }
if ($null -ne $env:MASK_SUFFIX_MARK) { $SuffixMark = [string]$env:MASK_SUFFIX_MARK }
if ($env:MASK_SUBMIT_TS) { try { $SubmitTs = [long]$env:MASK_SUBMIT_TS } catch {} }

# 成片子文件夹名：对未加后缀的成片名（无扩展名）剥掉末尾所有「-数字」段；
# 后缀不参与剥除（防止后缀里含数字被误剥），剥完后再由调用方把后缀附加到文件夹名
# （示例：260908-项目-主题-1-1.mp4 → 260908-项目-主题；加后缀后 → 260908-项目-主题-YX）
function Get-MaskDirName([string]$OutName) {
    $b = [System.IO.Path]::GetFileNameWithoutExtension($OutName)
    for (;;) {
        $before = $b
        $b = $b -replace '-[0-9]+$', ''
        if ($b -eq $before) { break }
    }
    return $b
}

# 任务提交时刻优先：排队跨天运行时，成片命名/输出目录按提交日期，不回退到实际运行日期
function Get-TaskDate {
    if ($SubmitTs -gt 0) {
        try { return [DateTimeOffset]::FromUnixTimeMilliseconds($SubmitTs).ToLocalTime().DateTime } catch {}
    }
    return Get-Date
}

# ------------------------------ 缓存目录（只读） -------------------------------------
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$scriptCacheDir = $env:VL_CACHE_DIR
if ([string]::IsNullOrEmpty($scriptCacheDir)) { $scriptCacheDir = $scriptDir }
$cacheFile = Join-Path $scriptCacheDir "video_cache.json"
$cache = @{}
if (Test-Path $cacheFile) {
    try { $cache = Get-Content $cacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable } catch { $cache = @{} }
}

# ------------------------------ 辅助函数 -------------------------------------
function Remove-Quotes {
    param([string]$str)
    $str = $str.Trim()
    if ($str.Length -ge 2) {
        if (($str.StartsWith('"') -and $str.EndsWith('"')) -or ($str.StartsWith("'") -and $str.EndsWith("'"))) {
            $str = $str.Substring(1, $str.Length - 2)
        }
    }
    return $str
}

function Invoke-ErrorBeep {
    [Console]::Beep(800, 200)
    Start-Sleep -Milliseconds 100
    [Console]::Beep(600, 200)
}

function Invoke-ErrorAction {
    param([string]$ErrorMessage, [string]$ErrorStep)
    $Script:HasError = $true
    Write-Host "`n================ 错误信息 ================" -ForegroundColor Red
    Write-Host "出错步骤: $ErrorStep" -ForegroundColor Yellow
    Write-Host "错误详情: $ErrorMessage" -ForegroundColor Red
    Write-Host "==========================================`n" -ForegroundColor Red
    Invoke-ErrorBeep
}

# 机器可读失败行：`❌ 失败成片：<成片名>|<原因>`，供 Video Lab 对账与断点续跑
function Write-MaskFail {
    param([string]$Name, [string]$Reason)
    $reason = ($Reason -replace '[|\r\n]+', ' ').Trim()
    Write-Host "❌ 失败成片：$Name|$reason" -ForegroundColor Red
}

function Invoke-FFmpegWithProgress {
    param([array]$Arguments)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "ffmpeg"
    # 参数按命令行语义拼接：含空格（如 AppData\Video Lab\Cache\...）的参数必须加引号，
    # 否则路径在空格处被截断（ffmpeg 误把目录当输出文件）
    $psi.Arguments = ($Arguments | ForEach-Object {
        if ([string]$_ -match '[\s"]') { '"' + $_ + '"' } else { $_ }
    }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    $process.Start() | Out-Null
    $errorOutput = ""
    $bufferWidth = 120
    try { $bufferWidth = [System.Console]::BufferWidth } catch { $bufferWidth = 120 }
    $maxLineLength = $bufferWidth - 1
    while (-not $process.StandardError.EndOfStream) {
        $line = $process.StandardError.ReadLine()
        $errorOutput += $line + "`n"
        if ($line -match "frame=|time=") {
            if ($line.Length -ge $bufferWidth) { $line = $line.Substring(0, $maxLineLength - 3) + "..." }
            [Console]::Out.WriteLine($line)
        }
        elseif ($line -match "error|Error|ERROR|failed|Failed") {
            Write-Host "`n$line" -ForegroundColor Red
        }
    }
    Write-Host ""
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    if ($exitCode -ne 0) {
        $errorLines = $errorOutput -split "`n" | Where-Object { $_ -match "error|Error|ERROR|failed|Failed" }
        foreach ($line in $errorLines) {
            if ($line -and $line -notmatch "frame=|time=") { Write-Host $line -ForegroundColor Red }
        }
    }
    return $exitCode
}

function Get-VideoDuration {
    param([string]$Path)
    $durRaw = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path 2>$null
    $dur = ($durRaw -as [double])
    if ($null -eq $dur -or $dur -le 0) { return 0.0 }
    return $dur
}

# ------------------------------ 校验 -------------------------------------
if ($MaskMode -ne 2 -and $MaskMode -ne 3) { $MaskMode = 1 }
if ([string]::IsNullOrWhiteSpace($RawVideoDirs) -or [string]::IsNullOrWhiteSpace($OutputDir)) {
    Invoke-ErrorAction -ErrorMessage "缺少原片文件夹或输出目录环境变量" -ErrorStep "参数校验"
    [Environment]::Exit(1)
}
if (($MaskMode -eq 1 -or $MaskMode -eq 3) -and [string]::IsNullOrWhiteSpace($MaskDirs)) {
    Invoke-ErrorAction -ErrorMessage "缺少遮罩目录（模式 $MaskMode 需要）" -ErrorStep "参数校验"
    [Environment]::Exit(1)
}
if (($MaskMode -eq 1 -or $MaskMode -eq 2) -and [string]::IsNullOrWhiteSpace($WatermarkMov)) {
    Invoke-ErrorAction -ErrorMessage "缺少水印文件（模式 $MaskMode 需要）" -ErrorStep "参数校验"
    [Environment]::Exit(1)
}
if ($MaskMode -ne 2) {
    $maskDirList = @($MaskDirs -split ';' | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
    $existsCount = 0
    foreach ($md in $maskDirList) { if (Test-Path -LiteralPath $md -PathType Container) { $existsCount++ } }
    if ($existsCount -eq 0) {
        Invoke-ErrorAction -ErrorMessage "遮罩目录均不存在：$MaskDirs" -ErrorStep "遮罩扫描"
        [Environment]::Exit(1)
    }
}
if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -Path $OutputDir -ItemType Directory -Force | Out-Null }
if ($MaskMode -ne 2 -and -not (Test-Path -LiteralPath $WatermarkMov)) {
    Invoke-ErrorAction -ErrorMessage "水印文件不存在：$WatermarkMov" -ErrorStep "参数校验"
    [Environment]::Exit(1)
}

# ------------------------------ 扫描原片（多文件夹，含子文件夹） -------------------------------------
$vidExt = @('*.mp4', '*.mov', '*.avi', '*.mkv', '*.m4v', '*.webm', '*.flv')
$rawDirs = @($RawVideoDirs -split ';' | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
$allVideos = @()
foreach ($rd in $rawDirs) {
    if (-not (Test-Path -LiteralPath $rd -PathType Container)) {
        Write-Host "⚠️ 原片文件夹不存在，已跳过：$rd" -ForegroundColor Yellow
        continue
    }
    foreach ($ext in $vidExt) {
        $found = @(Get-ChildItem -LiteralPath $rd -Filter $ext -File -Recurse -ErrorAction SilentlyContinue)
        foreach ($f in $found) { $allVideos += $f.FullName }
    }
}
$allVideos = @($allVideos | Sort-Object -Unique)
if ($Videos) {
    $pickSet = @($Videos -split ';' | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
    $allVideos = @($allVideos | Where-Object { $pickSet -contains $_ })
}
if ($allVideos.Count -eq 0) {
    Invoke-ErrorAction -ErrorMessage "未找到任何原片视频" -ErrorStep "原片扫描"
    [Environment]::Exit(1)
}

# ------------------------------ 扫描遮罩（多主题目录，含子文件夹） -------------------------------------
$allMasks = @()
if ($MaskMode -ne 2) {
    $maskDirList = @($MaskDirs -split ';' | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
    foreach ($md in $maskDirList) {
        if (-not (Test-Path -LiteralPath $md -PathType Container)) { continue }
        foreach ($ext in @('*.mov', '*.mp4')) {
            $found = @(Get-ChildItem -LiteralPath $md -Filter $ext -File -Recurse -ErrorAction SilentlyContinue)
            foreach ($f in $found) { $allMasks += $f.FullName }
        }
    }
    $allMasks = @($allMasks | Sort-Object -Unique)
    if ($Masks) {
        $pickSet = @($Masks -split ';' | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
        $allMasks = @($allMasks | Where-Object { $pickSet -contains $_ })
    }
    if ($allMasks.Count -eq 0) {
        Invoke-ErrorAction -ErrorMessage "未找到任何遮罩素材（$MaskDirs）" -ErrorStep "遮罩扫描"
        [Environment]::Exit(1)
    }
}

# ------------------------------ 构建任务列表（全组合） -------------------------------------
$dateStr = Get-TaskDate
$dateStrYy = $dateStr.ToString('yyMMdd')
$jobs = @()
if ($MaskMode -eq 2) {
    foreach ($vp in $allVideos) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($vp)
        $safeBase = $base -replace '[\\/:*?"<>|]', '_'
        # 模式2 命名：原视频名-水印（-后缀，若有）；子文件夹名 = 去「-水印」后的原视频名（+后缀）
        $outName = "$safeBase-水印" + $(if ($SuffixMark) { "-$SuffixMark" } else { "" }) + ".mp4"
        $dirName = $safeBase -replace '-水印$', ''
        if ([string]::IsNullOrWhiteSpace($dirName)) { $dirName = $safeBase }
        if ($SuffixMark) { $dirName += "-$SuffixMark" }
        $jobs += [PSCustomObject]@{ VidPath = $vp; MaskPath = ''; OutFile = (Join-Path (Join-Path $OutputDir $dirName) $outName); OutName = $outName; Theme = $dateStrYy }
    }
}
else {
    foreach ($vp in $allVideos) {
        foreach ($mp in $allMasks) {
            $maskName = [System.IO.Path]::GetFileNameWithoutExtension($mp)
            $parentDir = Split-Path -Path $mp -Parent
            $theme = Split-Path -Path $parentDir -Leaf
            if ([string]::IsNullOrWhiteSpace($theme)) { $theme = $maskName }
            $vidIdx = [Array]::IndexOf($allVideos, $vp) + 1
            # 模式1/3 命名：日期-项目名-遮罩名-后缀序号；放子文件夹。
            # 文件夹名 = 未加序号后缀的成片名先剥数字段，再附加后缀（后缀不参与剥除）
            $projName = $env:MASK_PROJECT_NAME
            if ([string]::IsNullOrWhiteSpace($projName)) { $projName = $theme }
            # 成片名去重：遮罩名往往已带项目名前缀（如 项目A\项目A-主题B\项目A-主题B-1.mov），
            # 此时不再重复拼接项目名，避免成片名出现两个「项目A」
            if ($maskName.StartsWith($projName)) { $dedupName = $maskName }
            else { $dedupName = "$projName-$maskName" }
            $baseName = "$dateStrYy-$dedupName"
            $dirName = Get-MaskDirName ("$baseName-$vidIdx.mp4")
            if ($SuffixMark) { $dirName += "-$SuffixMark" }
            $outName = "$baseName-$SuffixMark$vidIdx.mp4"
            $jobs += [PSCustomObject]@{ VidPath = $vp; MaskPath = $mp; OutFile = (Join-Path (Join-Path $OutputDir $dirName) $outName); OutName = $outName; Theme = $theme }
        }
    }
}
# 续跑过滤：仅保留指定成片名
if ($OnlyNames) {
    $onlyList = @($OnlyNames -split ';' | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
    $jobs = @($jobs | Where-Object {
        $n = $_.OutName
        $b = [System.IO.Path]::GetFileNameWithoutExtension($n)
        foreach ($onlyName in $onlyList) {
            $ob = [System.IO.Path]::GetFileNameWithoutExtension($onlyName)
            if ($n -eq $onlyName -or $b -eq $ob) { return $true }
        }
        return $false
    })
    if ($jobs.Count -eq 0) {
        Invoke-ErrorAction -ErrorMessage "未找到指定成片：$($onlyList -join '、')" -ErrorStep "续跑过滤"
        [Environment]::Exit(1)
    }
}

# ------------------------------ 模式1预处理：合并遮罩+水印（带alpha） -------------------------------------
# 预合成中间文件保存位置参考原始脚本：%TEMP%\MaskWatermarkTemp 独立子文件夹，
# 任务结束整目录清理，失败/强杀残留下次执行一并清除，不占应用缓存目录
$combinedMap = @{}
$maskCombineDir = $null
if ($MaskMode -eq 1) {
    $maskCombineDir = Join-Path $env:TEMP "MaskWatermarkTemp"
    if (-not (Test-Path -LiteralPath $maskCombineDir)) { New-Item -Path $maskCombineDir -ItemType Directory -Force | Out-Null }
    $maskHash = @{}
    foreach ($mp in $allMasks) { $maskHash[$mp] = $true }
    foreach ($j in $jobs) {
        if (-not $maskHash.ContainsKey($j.MaskPath)) { continue }
        if ($combinedMap.ContainsKey($j.MaskPath)) { continue }
        $maskName = [System.IO.Path]::GetFileNameWithoutExtension($j.MaskPath)
        $maskLastWrite = (Get-Item -LiteralPath $j.MaskPath).LastWriteTime.ToString("yyyyMMddHHmmss")
        $combinedName = "combined_${maskName}_${maskLastWrite}.mov"
        $combinedPath = Join-Path $maskCombineDir $combinedName
        if (Test-Path $combinedPath) { $combinedMap[$j.MaskPath] = $combinedPath; continue }
        Write-Host "`n🔧 预处理合并遮罩与水印：$maskName ..." -ForegroundColor Cyan
        $maskDur = Get-VideoDuration -Path $j.MaskPath
        if ($maskDur -le 0) { $maskDur = 5.0 }
        $filterStr = "[0:v]trim=duration=$maskDur,setpts=PTS-STARTPTS[mask];[1:v]trim=duration=$maskDur,setpts=PTS-STARTPTS,colorchannelmixer=aa=0.3[wm];[mask][wm]overlay=0:0[outv]"
        $ffmpegArgs = @("-y", "-loglevel", "error", "-stats",
            "-i", $j.MaskPath, "-i", $WatermarkMov,
            "-filter_complex", $filterStr,
            "-map", "[outv]", "-map", "0:a?",
            "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
            "-c:a", "aac", "-b:a", "192k",
            $combinedPath)
        $code = Invoke-FFmpegWithProgress -Arguments $ffmpegArgs
        if ($code -ne 0 -or -not (Test-Path $combinedPath)) {
            Invoke-ErrorAction -ErrorMessage "遮罩与水印预处理失败：$maskName" -ErrorStep "预处理"
            [Environment]::Exit(1)
        }
        Write-Host "✅ 预处理完成" -ForegroundColor Green
        $combinedMap[$j.MaskPath] = $combinedPath
    }
}

# ------------------------------ 主流程（互斥锁 + 批量合成） -------------------------------------
$mutexName = "Global\VideoBatchMutex"
$mutex = $null
try { $mutex = [System.Threading.Mutex]::OpenExisting($mutexName) } catch { }
if (-not $mutex) { $mutex = New-Object System.Threading.Mutex($false, $mutexName) }
$mutex.WaitOne() | Out-Null
Write-Host "🔒 已获取互斥锁，开始遮罩叠加任务" -ForegroundColor Green
try {
    $totalCount = $jobs.Count
    $themeLogs = @{}
    Write-Host "`n开始遮罩叠加，共 $totalCount 个成片" -ForegroundColor Cyan
    $processedCount = 0; $skippedCount = 0; $failedCount = 0
    for ($i = 0; $i -lt $totalCount; $i++) {
        $j = $jobs[$i]
        $idx = $i + 1
        # 每个成片块前输出分割线（与日志文件块间格式一致，任务窗口按成片分段显示）
        Write-Host ("=" * 46)
        Write-Host "`n生成第 $idx / $totalCount 个成片：$($j.OutName)" -ForegroundColor Cyan

        # 跳过检测：输出已存在且时长一致
        $skipThis = $false
        if (Test-Path -LiteralPath $j.OutFile) {
            $srcPath = if ($MaskMode -eq 2) { $j.VidPath } else { $j.MaskPath }
            if ($combinedMap.ContainsKey($j.MaskPath)) { $srcPath = $combinedMap[$j.MaskPath] }
            $expectedDur = Get-VideoDuration -Path $srcPath
            $existingDur = Get-VideoDuration -Path $j.OutFile
            if ($expectedDur -gt 0 -and $existingDur -gt 0 -and [math]::Abs($expectedDur - $existingDur) -le 1.0) {
                $skipThis = $true
            }
        }
        if ($skipThis) {
            Write-Host "   ⏭️ 跳过（已存在且时长一致）" -ForegroundColor Magenta
            $skippedCount++
            continue
        }
        if (Test-Path -LiteralPath $j.OutFile) { Write-Host "   🔄 覆盖现有文件" -ForegroundColor Yellow }

        # 确保成片子文件夹存在（文件夹名 = 成片名去序号后缀）
        $subDir = Split-Path -Path $j.OutFile -Parent
        if ($subDir -and -not (Test-Path -LiteralPath $subDir)) { New-Item -Path $subDir -ItemType Directory -Force | Out-Null }

        # 目标时长与滤镜
        if ($MaskMode -eq 2) {
            $vidDur = Get-VideoDuration -Path $j.VidPath
            if ($vidDur -le 0) { $vidDur = 5.0 }
            $targetDur = $vidDur
            $filterStr = "[0:v]trim=duration=$vidDur,setpts=PTS-STARTPTS[base];[1:v]trim=duration=$vidDur,setpts=PTS-STARTPTS,colorchannelmixer=aa=0.3[wm];[base][wm]overlay=0:0[outv]"
            $ffmpegParam = @("-y", "-loglevel", "error", "-stats",
                "-i", $j.VidPath, "-i", $WatermarkMov,
                "-filter_complex", $filterStr,
                "-map", "[outv]", "-map", "0:a",
                "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "25",
                "-c:a", "aac", "-b:a", "192k", "-shortest",
                $j.OutFile)
        }
        else {
            $srcForDur = if ($MaskMode -eq 1) { $combinedMap[$j.MaskPath] } else { $j.MaskPath }
            $vidDur = Get-VideoDuration -Path $j.VidPath
            if ($vidDur -le 0) { $vidDur = 5.0 }
            $maskDur = Get-VideoDuration -Path $srcForDur
            if ($maskDur -le 0) { $maskDur = 5.0 }
            $targetDur = [math]::Min($vidDur, $maskDur)
            if ($vidDur -lt $maskDur -and ($maskDur - $vidDur) -gt 1.0) {
                Write-Host "   ⚠️ 原片时长（$([math]::Round($vidDur,2)) s）比遮罩时长（$([math]::Round($maskDur,2)) s）短超过1秒，将按原片时长输出" -ForegroundColor Yellow
            }
            $ffmpegParam = @("-y", "-loglevel", "error", "-stats", "-t", "$targetDur",
                "-i", $j.VidPath, "-i", $srcForDur,
                "-filter_complex", "[1:v]setpts=PTS-STARTPTS[ov];[0:v][ov]overlay=0:0[outv]",
                "-map", "[outv]", "-map", "1:a?",
                "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "25",
                "-c:a", "aac", "-b:a", "192k",
                $j.OutFile)
        }
        Write-Output ("成片预计时长: " + [math]::Round($targetDur, 2) + " 秒")
        $code = Invoke-FFmpegWithProgress -Arguments $ffmpegParam
        if ($code -eq 0 -and (Test-Path -LiteralPath $j.OutFile)) {
            Write-Host "   ✅ 成片完成：$($j.OutFile)" -ForegroundColor Green
            $processedCount++
            # 写遮罩叠加日志（格式与拼接/复刻日志一致）：成片名 / 使用片段列表： / 原片 / 遮罩
            if ($LogDir) {
                $cfgName = if ($MaskMode -eq 2) { "水印叠加" } else { $j.Theme }
                $timeTag = (Get-TaskDate).ToString("MMdd-HH时mm分")
                $logFilePath = Join-Path $LogDir "$timeTag-$cfgName-遮罩日志.txt"
                if (-not $themeLogs.ContainsKey($logFilePath)) {
                    if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }
                    Set-Content -Path $logFilePath -Value @() -Encoding UTF8
                    $themeLogs[$logFilePath] = $true
                }
                $logLine = @($j.OutName, "使用片段列表：", $j.VidPath)
                if ($MaskMode -ne 2) { $logLine += $j.MaskPath }
                $logLine += ""
                $logLine += ("@out: " + $j.OutFile)
                $logLine += ""
                $logLine += ("=" * 46)
                $logLine | Out-File -Path $logFilePath -Encoding UTF8 -Append
            }
        }
        else {
            Write-MaskFail -Name $j.OutName -Reason "ffmpeg 退出码 $code"
            $failedCount++
            $Script:HasError = $true
        }
    }
}
finally {
    # 参考原始脚本（遮罩叠加.ps1）：模式1任务结束即清理独立预合成子文件夹，失败/强杀残留也一并清掉（静默清理）
    if ($MaskMode -eq 1 -and $maskCombineDir -and (Test-Path -LiteralPath $maskCombineDir)) {
        Remove-Item -LiteralPath $maskCombineDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    try { $mutex.ReleaseMutex() } catch { }
}

# ------------------------------ 收尾 -------------------------------------
if ($Script:HasError) {
    Write-Host "`n脚本执行完成（有错误）" -ForegroundColor Yellow
    [Environment]::Exit(1)
}
Write-Host "`n脚本完成" -ForegroundColor Green
[Environment]::Exit(0)
