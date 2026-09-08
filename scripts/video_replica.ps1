$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ------------------------------ 全局参数 -------------------------------------
$MaxTotalDurationSec = 179
$SpeedThreshold = 1.2
$DedupRatio = 0.4        # 去重阈值：模式2尾部替换需达到的不一致时长占比
$Script:HasError = $false

# 环境变量覆盖（由 Video Lab 设置页写入 config.json 后注入）：
if ($env:REPLICA_MAX_DURATION) { try { $MaxTotalDurationSec = [double]$env:REPLICA_MAX_DURATION } catch {} }
if ($env:REPLICA_SPEED_LIMIT) { try { $SpeedThreshold = [double]$env:REPLICA_SPEED_LIMIT } catch {} }
if ($env:REPLICA_DEDUP_RATIO) { try { $DedupRatio = [double]$env:REPLICA_DEDUP_RATIO } catch {} }

# 任务提交时刻优先（REPLICA_SUBMIT_TS 由应用在任务提交时注入）：排队跨天运行时，
# 复刻命名/日志/输出目录一律按提交日期，不回退到实际运行日期
function Get-TaskDate {
    if ($env:REPLICA_SUBMIT_TS) {
        try {
            $ts = [long]$env:REPLICA_SUBMIT_TS
            if ($ts -gt 0) { return [DateTimeOffset]::FromUnixTimeMilliseconds($ts).ToLocalTime().DateTime }
        } catch {}
    }
    return Get-Date
}

# ------------------------------ 视频信息缓存（只读，不写回） ------------------------------
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
# 缓存目录：默认脚本目录；应用通过 VL_CACHE_DIR 注入，统一放到项目的 Cache 子文件夹（与应用预检测共用同一 video_cache.json）
$scriptCacheDir = $env:VL_CACHE_DIR
if ([string]::IsNullOrEmpty($scriptCacheDir)) { $scriptCacheDir = $scriptDir }
$cacheFile = Join-Path $scriptCacheDir "video_cache.json"
$cache = @{}
if (Test-Path $cacheFile) {
    try {
        $cache = Get-Content $cacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    }
    catch {
        $cache = @{}
    }
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

# 机器可读失败行：`❌ 失败成片：<成片名>|<原因>`，供 Video Lab 任务对账（完成+失败=总数）与断点续跑；
# 同时保留人类可读的 Invoke-ErrorAction 输出
function Write-ReplicaFail {
    param([string]$Name, [string]$Reason)
    $reason = ($Reason -replace '[|\r\n]+', ' ').Trim()
    Write-Host "❌ 失败成片：$Name|$reason" -ForegroundColor Red
}

function Invoke-FFmpegWithProgress {
    param([array]$Arguments)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "ffmpeg"
    $psi.Arguments = $Arguments -join ' '
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

function Get-CachedVideoInfo {
    param([string]$VideoPath)
    # 防御：路径已不存在（缺失片段未能修复/成片被移动）时返回无效对象，避免 Get-Item 抛全局异常
    if (-not (Test-Path -LiteralPath $VideoPath)) {
        return [PSCustomObject]@{ Valid = $false; Duration = 0; Width = 0; Height = 0; LastWriteTimeTicks = 0 }
    }
    $fileInfo = Get-Item -LiteralPath $VideoPath
    $cached = $cache[$VideoPath]
    if ($cached -and $cached.LastWriteTime -eq $fileInfo.LastWriteTimeUtc.Ticks) {
        return [PSCustomObject]@{
            Valid              = $cached.Valid
            Duration           = $cached.Duration
            Width              = $cached.Width
            Height             = $cached.Height
            LastWriteTimeTicks = $cached.LastWriteTime
        }
    }
    else {
        $probeArgs = @("-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            $VideoPath)
        $output = & ffprobe $probeArgs 2>&1
        $width = 0; $height = 0; $duration = 0; $valid = $false
        if ($LASTEXITCODE -eq 0) {
            $lines = $output | Where-Object { $_ -match '\S' }
            if ($lines.Count -ge 3) {
                $width = [int]$lines[0].Trim()
                $height = [int]$lines[1].Trim()
                $duration = [double]$lines[2].Trim()
                $valid = ($width -eq 1080 -and $height -eq 1920 -and $duration -gt 0)
            }
        }
        $cache[$VideoPath] = @{
            LastWriteTime = $fileInfo.LastWriteTimeUtc.Ticks
            Duration      = $duration
            Valid         = $valid
            Width         = $width
            Height        = $height
        }
        return [PSCustomObject]@{
            Valid              = $valid
            Duration           = $duration
            Width              = $width
            Height             = $height
            LastWriteTimeTicks = $fileInfo.LastWriteTimeUtc.Ticks
        }
    }
}

# ------------------------------ 日志复刻解析 ------------------------------
function ConvertTo-ReplicaJobs {
    param([string[]]$AllLines)
    $jobs = @()
    $current = $null
    for ($i = 0; $i -lt $AllLines.Count; $i++) {
        $line = $AllLines[$i].Trim()
        if ($line -match '使用片段列表：') {
            if ($current) { $jobs += $current }
            $nameLine = if ($i -gt 0) { $AllLines[$i - 1].Trim() } else { '' }
            $name = $nameLine
            if ($name -match '第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$') {
                $name = $matches[1].Trim().Trim('=').Trim()
            }
            if ($name -match '^[A-Za-z]:\\' -or $name -match '^\\\\') {
                $name = Split-Path -Path $name -Leaf
            }
            $current = [PSCustomObject]@{ Name = $name; Videos = @(); Watermark = ''; MissingReplacedIndices = @(); MissingEquivalentIndices = @() }
            continue
        }
        if ($current) {
            $path = Remove-Quotes -str $line
            if ($path -match '^[A-Za-z]:\\' -or $path -match '^\\\\') {
                if ($path -match '\.png$') { $current.Watermark = $path }
                elseif ($path -match '\.(mp4|mov|avi|mkv|m4v)$') { $current.Videos += $path }
            }
        }
    }
    if ($current) { $jobs += $current }
    return $jobs
}

# ------------------------------ 候选与等效替换 ------------------------------
function Get-SameDirVideoCandidates {
    param([string]$VideoPath)
    $dir = Split-Path -Path $VideoPath -Parent
    if (-not (Test-Path $dir -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $dir -File -Force | Where-Object {
        $_.Extension -in '.mp4','.mov','.avi','.mkv','.m4v' -and
        $_.FullName -ne $VideoPath -and
        $_.FullName -notlike '*\旧水印*'
    })
}

function Get-NumberSuffix {
    param([string]$Path)
    $base = [System.IO.Path]::GetFileNameWithoutExtension($Path)
    if ($base -match '(\d+)$') { return $matches[1] }
    return ''
}

function Select-ReplacementVideo {
    param([string]$OriginalPath, [array]$Exclude = @(), [switch]$PreferShort)
    $cands = @(Get-SameDirVideoCandidates -VideoPath $OriginalPath | Where-Object { $_.FullName -notin $Exclude })
    if ($cands.Count -eq 0) { return @($null, $false) }
    $origSuffix = Get-NumberSuffix -Path $OriginalPath
    $sameSuffix = @()
    if ($origSuffix) {
        $sameSuffix = @($cands | Where-Object { (Get-NumberSuffix -Path $_.FullName) -eq $origSuffix })
    }
    $sameSuffixFull = @($sameSuffix | ForEach-Object { $_.FullName })
    $others = @($cands | Where-Object { $_.FullName -notin $sameSuffixFull })
    # 时长感知：PreferShort 时在同后缀/其他候选中优先取时长最短的（压低总时长，减少超阈值重试）
    if ($PreferShort) {
        if ($sameSuffix.Count -gt 0) {
            $sorted = @($sameSuffix | Sort-Object { (Get-CachedVideoInfo -VideoPath $_.FullName).Valid -eq $false }, { (Get-CachedVideoInfo -VideoPath $_.FullName).Duration })
            return @($sorted[0].FullName, $true)
        }
        if ($others.Count -gt 0) {
            $sorted = @($others | Sort-Object { (Get-CachedVideoInfo -VideoPath $_.FullName).Valid -eq $false }, { (Get-CachedVideoInfo -VideoPath $_.FullName).Duration })
            return @($sorted[0].FullName, $false)
        }
        return @($null, $false)
    }
    if ($sameSuffix.Count -gt 0) { return @(($sameSuffix | Get-Random).FullName, $true) }
    if ($others.Count -gt 0) { return @(($others | Get-Random).FullName, $false) }
    return @($null, $false)
}

function Get-VideoFromDirectory {
    param([string]$Directory, [string]$OriginalPath = '')
    if (-not (Test-Path $Directory -PathType Container)) { return @($null, $false) }
    $vids = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Force | Where-Object {
        $_.Extension -in '.mp4','.mov','.avi','.mkv','.m4v' -and
        $_.FullName -notlike '*\旧水印*'
    })
    if ($vids.Count -eq 0) { return @($null, $false) }
    $origSuffix = if ($OriginalPath) { Get-NumberSuffix -Path $OriginalPath } else { '' }
    $sameSuffix = @()
    if ($origSuffix) {
        $sameSuffix = @($vids | Where-Object { (Get-NumberSuffix -Path $_.FullName) -eq $origSuffix })
    }
    $sameSuffixFull = @($sameSuffix | ForEach-Object { $_.FullName })
    $others = @($vids | Where-Object { $_.FullName -notin $sameSuffixFull })
    if ($sameSuffix.Count -gt 0) { return @(($sameSuffix | Get-Random).FullName, $true) }
    if ($others.Count -gt 0) { return @(($others | Get-Random).FullName, $false) }
    return @($null, $false)
}

# ------------------------------ 缺失片段修复（基于实时缓存） ------------------------------
# video_cache.json（预检测缓存）由软件实时更新（预检测时自动写入），比手动维护的 .tsv 索引更可信，
# 作为缺失片段修复的唯一数据源；key 即历史探测过且有效的视频路径，无需全盘扫描
$cacheByFileName = @{}
function Initialize-CacheFileIndex {
    $script:cacheByFileName = @{}
    foreach ($p in $cache.Keys) {
        if (-not $p) { continue }
        $fn = Split-Path -Path $p -Leaf
        if (-not $fn) { continue }
        $key = $fn.ToLower()
        if (-not $script:cacheByFileName.ContainsKey($key)) { $script:cacheByFileName[$key] = @() }
        $script:cacheByFileName[$key] += $p
    }
}
Initialize-CacheFileIndex

# 从实时缓存解析缺失片段的替代路径（仅返回磁盘上真实存在的候选）：
# 1) 命中同名文件：优先与原缺失路径同目录的候选，其次任一同名存在候选
# 2) 无同名但同目录存在相同数字后缀的视频：视为同内容微调（与原索引同语义）
function Resolve-FromVideoCache {
    param([string]$OldPath)
    $p = Remove-Quotes -str $OldPath
    $p = $p -replace '\\\\', '\'
    if (-not $p) { return $null }
    $leaf = Split-Path -Path $p -Leaf
    $fnKey = $leaf.ToLower()
    $origDir = (Split-Path -Path $p -Parent)
    if ($cacheByFileName.ContainsKey($fnKey)) {
        $cands = @($cacheByFileName[$fnKey] | Where-Object { Test-Path -LiteralPath $_ })
        $cands = @($cands | Sort-Object -Unique)
        if ($cands.Count -gt 0) {
            # 优先原目录候选（最可能是同一批次的真实文件），否则取任一存在候选
            $sameDir = @($cands | Where-Object { (Split-Path -Path $_ -Parent) -ieq $origDir })
            if ($sameDir.Count -ge 1) { return $sameDir[0] }
            return $cands[0]
        }
    }
    # 无同名：同目录下相同数字后缀匹配（原索引补位逻辑）
    $suffix = Get-NumberSuffix -Path $p
    if ($suffix -and (Test-Path $origDir -PathType Container)) {
        $sameSeq = @(Get-ChildItem -LiteralPath $origDir -File -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.Extension -in '.mp4','.mov','.avi','.mkv','.m4v' -and
            $_.FullName -ine $p -and
            (Get-NumberSuffix -Path $_.FullName) -eq $suffix
        } | Sort-Object FullName -Unique)
        if ($sameSeq.Count -ge 1) { return $sameSeq[0].FullName }
    }
    return $null
}

# ------------------------------ 模式2 尾部替换 ------------------------------
function Select-VariancePaths {
    param(
        [string[]]$OriginalPaths,
        [int[]]$AlreadyChangedIndices = @(),
        [int[]]$AlreadyEquivalentIndices = @(),
        # 时长预算（秒）：已试组合的「被替换路径」集合 + 是否倾向选短片段（降低总时长）
        [double]$BudgetSec = 0,
        [hashtable]$TriedSubs = $null,
        [switch]$PreferShort
    )
    $origDurations = @()
    $totalOrig = 0
    foreach ($p in $OriginalPaths) {
        $d = (Get-CachedVideoInfo -VideoPath $p).Duration
        $origDurations += $d
        $totalOrig += $d
    }
    if ($totalOrig -le 0 -or $OriginalPaths.Count -eq 0) { return $OriginalPaths }

    $alreadyChangedDur = 0
    foreach ($idx in $AlreadyChangedIndices) {
        if ($idx -ge 0 -and $idx -lt $origDurations.Count) { $alreadyChangedDur += $origDurations[$idx] }
    }
    if ($alreadyChangedDur / $totalOrig -ge $DedupRatio) {
        Write-Host "🔀 模式2：缺失替换片段已占 $([math]::Round($alreadyChangedDur / $totalOrig * 100, 1))%，无需再替换尾部" -ForegroundColor Magenta
        return $OriginalPaths
    }

    $newPaths = @($OriginalPaths)
    $trulyChangedIndices = @($AlreadyChangedIndices)
    $trulyChangedDur = $alreadyChangedDur
    $actuallyReplaced = 0
    $equivalentReplaced = 0
    $replaceDetails = @()
    $equivalentDetails = @()

    for ($i = $OriginalPaths.Count - 1; $i -ge 0; $i--) {
        if ($trulyChangedDur / $totalOrig -ge $DedupRatio) { break }
        if ($i -in $AlreadyChangedIndices -or $i -in $AlreadyEquivalentIndices) { continue }
        # 失败记忆：跳过已试过的替换路径（key = 原路径|替换路径），保证每轮是有效新组合
        $excludeSubs = @()
        if ($TriedSubs) {
            $origKey = [string]$OriginalPaths[$i]
            $excludeSubs = @($TriedSubs.Keys | Where-Object { $_ -like "$origKey|*" } | ForEach-Object { $_.Substring($origKey.Length + 1) })
        }
        $sel = Select-ReplacementVideo -OriginalPath $OriginalPaths[$i] -Exclude $excludeSubs -PreferShort:$PreferShort
        $newPath = $sel[0]
        $isEquivalent = $sel[1]
        if (-not $newPath) { continue }
        $newPaths[$i] = $newPath
        if ($isEquivalent) {
            $equivalentReplaced++
            $equivalentDetails += "    第 $($i + 1) 段: $(Split-Path $OriginalPaths[$i] -Leaf) -> $(Split-Path $newPath -Leaf)（等效，不进入30%）"
        }
        else {
            $actuallyReplaced++
            $trulyChangedIndices += $i
            $trulyChangedDur += $origDurations[$i]
            $replaceDetails += "    第 $($i + 1) 段: $(Split-Path $OriginalPaths[$i] -Leaf) -> $(Split-Path $newPath -Leaf)"
        }
    }
    if ($actuallyReplaced -eq 0 -and $equivalentReplaced -eq 0 -and $alreadyChangedDur / $totalOrig -lt $DedupRatio) {
        Write-Host "⚠️ 模式2：没有可替换的尾部片段，本次仅保留已随机替换的片段" -ForegroundColor Yellow
        return $newPaths
    }
    Write-Host "🔀 模式2：尾部新增替换 $actuallyReplaced 段（等效替换 $equivalentReplaced 段；合计不一致时长占比 $([math]::Round($trulyChangedDur / $totalOrig * 100, 1))%）" -ForegroundColor Magenta
    foreach ($d in $equivalentDetails) { Write-Host $d -ForegroundColor DarkGray }
    foreach ($d in $replaceDetails) { Write-Host $d -ForegroundColor DarkGray }
    # 时长预算：超预算时由调用方重试（本函数只负责按 PreferShort 尽量选短的替换并返回组合）
    return $newPaths
}

# ------------------------------ 复刻主流程 ------------------------------
function Invoke-ReplicaFromLog {
    param([string[]]$AllLines, [string]$OutputRootDir)
    $mutexName = "Global\VideoBatchMutex"
    $mutex = $null
    try { $mutex = [System.Threading.Mutex]::OpenExisting($mutexName) } catch { }
    if (-not $mutex) { $mutex = New-Object System.Threading.Mutex($false, $mutexName) }
    $mutex.WaitOne() | Out-Null
    Write-Host "🔒 已获取互斥锁，开始复刻任务" -ForegroundColor Green
    try {
    $jobs = @(ConvertTo-ReplicaJobs -AllLines $AllLines)
    if ($jobs.Count -eq 0) {
        Invoke-ErrorAction -ErrorMessage "未从日志中解析出任何成片" -ErrorStep "日志复刻-解析"
        return
    }

    # 仅复刻指定成片（由 Video Lab 右侧「复刻」按钮/批量选择/断点续跑传入）：
    # REPLICA_ONLY_NAME 单个成片名；REPLICA_ONLY_NAMES 分号分隔多个成片名，精确匹配该成片名
    $onlyListRaw = if (-not [string]::IsNullOrEmpty($env:REPLICA_ONLY_NAMES)) { [string]$env:REPLICA_ONLY_NAMES }
                  elseif (-not [string]::IsNullOrEmpty($env:REPLICA_ONLY_NAME)) { [string]$env:REPLICA_ONLY_NAME }
                  else { '' }
    if (-not [string]::IsNullOrEmpty($onlyListRaw)) {
        $onlyNames = @($onlyListRaw -split ';' | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
        $jobs = @($jobs | Where-Object {
            $n = $_.Name
            $b = [System.IO.Path]::GetFileNameWithoutExtension($n)
            foreach ($onlyName in $onlyNames) {
                if ($n -eq $onlyName -or $n -eq ($onlyName + '.mp4') -or $b -eq [System.IO.Path]::GetFileNameWithoutExtension($onlyName)) { return $true }
            }
            return $false
        })
        if ($jobs.Count -eq 0) {
            Invoke-ErrorAction -ErrorMessage "未找到指定成片：$($onlyNames -join '、')" -ErrorStep "日志复刻-单成片"
            return
        }
    }

    $dupNames = $jobs | Group-Object Name | Where-Object { $_.Count -gt 1 }
    if ($dupNames.Count -gt 0) {
        Write-Host "❌ 检测到重复成片名：" -ForegroundColor Red
        foreach ($g in $dupNames) { Write-Host "   $($g.Name) 出现 $($g.Count) 次" -ForegroundColor Red }
        Invoke-ErrorAction -ErrorMessage "存在重复成片名，已停止" -ErrorStep "日志复刻-重复检测"
        return
    }

    # ===== 预检：所有成片的所有片段是否都存在 =====
    $missingAll = @()
    foreach ($job in $jobs) {
        for ($i = 0; $i -lt $job.Videos.Count; $i++) {
            if (-not (Test-Path $job.Videos[$i])) {
                $missingAll += [PSCustomObject]@{ Job = $job; Index = $i; Path = $job.Videos[$i] }
            }
        }
    }
    if ($missingAll.Count -gt 0) {
        Write-Host "`n⚠️  检测到 $($missingAll.Count) 个片段不存在，需要修复：" -ForegroundColor Yellow
        foreach ($m in $missingAll) { Write-Host "   [$($m.Job.Name)] $(Split-Path $m.Path -Leaf)" -ForegroundColor Red }
        # 不可修复成片名单（PSCustomObject 无法加属性，用独立集合跟踪）
        $unfixableJobs = @{}
        $unfixableReasons = @{}

        foreach ($m in $missingAll) {
            $job = $m.Job
            $idx = $m.Index
            $orig = $m.Path
            $newPath = $null
            $isEquivalent = $false

            # 首选：从实时缓存（video_cache.json）按文件名解析（软件自动更新，唯一数据源）
            $newPath = Resolve-FromVideoCache -OldPath $orig
            if ($newPath) {
                $isEquivalent = $true
                Write-Host "   🔎 缓存命中：$(Split-Path $orig -Leaf) -> $(Split-Path $newPath -Leaf)（等效，不进入30%）" -ForegroundColor Cyan
            }

            # 其次：同目录优先相同数字后缀，否则随机
            if (-not $newPath) {
                $sel = Select-ReplacementVideo -OriginalPath $orig
                $newPath = $sel[0]
                $isEquivalent = $sel[1]
            }

            # 再试：全局备用目录
            if (-not $newPath) {
                $newDir = $env:REPLICA_FALLBACK_DIR
                if ($newDir -and (Test-Path $newDir -PathType Container)) {
                    $sel = Get-VideoFromDirectory -Directory $newDir -OriginalPath $orig
                    $newPath = $sel[0]
                    $isEquivalent = $sel[1]
                }
            }

            if (-not $newPath -or -not (Test-Path $newPath)) {
                # 全部尝试均失败：该缺失片段无法修复 → 将该成片加入不可修复名单（不进入主循环）
                if (-not $newPath) {
                    Write-Host "   ❌ 无法自动修复：$orig" -ForegroundColor Red
                    Write-Host "      索引/同目录/备用目录均无可替换视频，请将对应视频放回原路径，或设置 REPLICA_FALLBACK_DIR 备用目录后重跑" -ForegroundColor Red
                }
                else {
                    Write-Host "   ❌ 替换候选已失效：$orig -> $newPath" -ForegroundColor Red
                    $newPath = $null
                }
                $unfixableJobs[$job.Name] = $job
                $unfixableReasons[$job.Name] = "片段缺失且无法自动修复：$(Split-Path $orig -Leaf)"
                continue
            }

            $job.Videos[$idx] = $newPath
            if ($isEquivalent) {
                $job.MissingEquivalentIndices = @($job.MissingEquivalentIndices) + $idx
            }
            else {
                $job.MissingReplacedIndices = @($job.MissingReplacedIndices) + $idx
            }
            if ($newPath -ne $orig) {
                Write-Host "   ✅ [$($job.Name)] $(Split-Path $orig -Leaf) -> $(Split-Path $newPath -Leaf)" -ForegroundColor Green
            }
        }
        # 剔除不可修复的成片并逐一输出失败记录（可续跑），其余成片继续正常复刻
        if ($unfixableJobs.Count -gt 0) {
            $jobs = @($jobs | Where-Object { -not $unfixableJobs.ContainsKey($_.Name) })
            foreach ($badName in $unfixableJobs.Keys) {
                Write-Host "   ⏭️  跳过无法复刻的成片：$badName（$($unfixableReasons[$badName])）" -ForegroundColor Yellow
                Write-ReplicaFail -Name $badName -Reason $unfixableReasons[$badName]
            }
            if ($jobs.Count -eq 0) {
                Invoke-ErrorAction -ErrorMessage "所有成片均因片段缺失无法复刻" -ErrorStep "日志复刻-缺失片段处理"
                return
            }
        }
    }

    # 模式选择
    $mode = 0
    if ($env:REPLICA_MODE -eq '1') { $mode = 1 }
    elseif ($env:REPLICA_MODE -eq '2') { $mode = 2 }
    else {
        Invoke-ErrorAction -ErrorMessage "未通过环境变量 REPLICA_MODE 指定复刻模式（脚本由 Video Lab 驱动）" -ErrorStep "复刻模式"
        [Environment]::Exit(1)
    }
    # 输出目录
    $outRoot = $OutputRootDir
    if ($env:REPLICA_OUTPUT_DIR) { $outRoot = $env:REPLICA_OUTPUT_DIR }
    $modeName = if ($mode -eq 1) { '原片复刻' } else { '去重复刻' }
    $outRoot = Join-Path $outRoot $modeName
    if (-not (Test-Path $outRoot)) { New-Item -ItemType Directory -Path $outRoot -Force | Out-Null }

    # 复刻日志（不更新缓存）：同日同模式复用同一日志文件，后续批次直接续写
    $timeTag = Get-Date -Format "MMdd"
    $logFileName = "$timeTag-${modeName}日志.txt"
    $logFilePath = Join-Path $outRoot $logFileName
    if (-not (Test-Path $logFilePath)) {
        Set-Content -Path $logFilePath -Value @() -Encoding UTF8
    }
    else {
        # 续写：在已有内容末尾追加分隔线，区分新批次
        Add-Content -Path $logFilePath -Value ("=" * 46) -Encoding UTF8
    }

    Write-Host "`n开始日志复刻，共 $($jobs.Count) 个成片" -ForegroundColor Cyan
    $jobIndex = 0
    foreach ($job in $jobs) {
        $jobIndex++
        Write-Host "`n------------------------------------------------" -ForegroundColor Cyan
        Write-Host "复刻第 $jobIndex / $($jobs.Count) 个成片：$($job.Name)" -ForegroundColor Cyan

        $videos = @($job.Videos)
        if ($videos.Count -eq 0) {
            Invoke-ErrorAction -ErrorMessage "成片 $($job.Name) 没有视频片段" -ErrorStep "日志复刻-片段检查"
            Write-ReplicaFail -Name $job.Name -Reason "没有视频片段"
            continue
        }
        # 最终校验：任一片段（含修复得到的）此刻不可读 → 该成片不生成，跳过并记录失败（可续跑）
        $stillMissing = @($videos | Where-Object { -not (Test-Path -LiteralPath $_) })
        if ($stillMissing.Count -gt 0) {
            Write-Host "   ❌ [$($job.Name)] 仍有 $($stillMissing.Count) 个片段无法读取，不生成该成片：$(Split-Path $stillMissing[0] -Leaf)" -ForegroundColor Red
            Write-ReplicaFail -Name $job.Name -Reason ("片段缺失且无法自动修复：" + (Split-Path $stillMissing[0] -Leaf))
            continue
        }
        if (-not $job.Watermark -or -not (Test-Path $job.Watermark)) {
            Invoke-ErrorAction -ErrorMessage "成片 $($job.Name) 水印无效：$($job.Watermark)" -ErrorStep "日志复刻-水印检查"
            Write-ReplicaFail -Name $job.Name -Reason "水印无效"
            continue
        }

        $totalDuration = 0
        if ($mode -eq 2) {
            # 模式2：替换尾部片段规避判重；若替换后总时长超阈值，自动重试其他替换组合（最多45次有效尝试）
            $baseVideos = @($job.Videos)
            $attempt = 0
            $triedSubs = @{}   # 失败记忆：已试过的「原路径|替换路径」，每轮显式跳过，避免重复随机
            do {
                $videos = @(Select-VariancePaths -OriginalPaths $baseVideos -AlreadyChangedIndices @($job.MissingReplacedIndices) -AlreadyEquivalentIndices @($job.MissingEquivalentIndices) -TriedSubs $triedSubs -PreferShort:($attempt -gt 3))
                $totalDuration = 0
                foreach ($p in $videos) { $totalDuration += (Get-CachedVideoInfo -VideoPath $p).Duration }
                # 记录本轮替换组合进失败记忆（下次不再重复同一替换）
                for ($i = 0; $i -lt $baseVideos.Count; $i++) {
                    if ($baseVideos[$i] -ne $videos[$i]) { $triedSubs[[string]$baseVideos[$i] + '|' + $videos[$i]] = $true }
                }
                if ($totalDuration -le $MaxTotalDurationSec * $SpeedThreshold) { break }
                $attempt++
                Write-Host "⚠️  替换后总时长 $([math]::Round($totalDuration, 1)) 秒超阈值，重试替换（$attempt/45）" -ForegroundColor Yellow
            } while ($attempt -lt 45)
            if ($totalDuration -gt $MaxTotalDurationSec * $SpeedThreshold) {
                # 彻底无解的兜底：优先再次尝试预检测是否仍超（若有更近组合已保留），无则直接判定失败
                # 45 次有效尝试后仍未达标 → 记为失败（可续跑），不再盲目消耗资源
                Invoke-ErrorAction -ErrorMessage "总时长 $([math]::Round($totalDuration,1)) 秒超过允许阈值（重试45次后仍不达标），请重选片段或调整日志" -ErrorStep "日志复刻-时长检查"
                Write-ReplicaFail -Name $job.Name -Reason ("总时长超阈值：" + [math]::Round($totalDuration,1) + " 秒")
                continue
            }
        }
        else {
            $totalDuration = 0
            foreach ($p in $videos) { $totalDuration += (Get-CachedVideoInfo -VideoPath $p).Duration }
        }

        $needSpeed = $false
        $speedRatio = 1.0
        if ($totalDuration -gt $MaxTotalDurationSec -and $totalDuration -le $MaxTotalDurationSec * $SpeedThreshold) {
            $needSpeed = $true
            $speedRatio = $totalDuration / $MaxTotalDurationSec
            if ($speedRatio -gt 2.0) { $speedRatio = 2.0 }
            Write-Host "⚠️  总时长 $totalDuration 秒超设定，将加速 $([math]::Round($speedRatio, 3))x" -ForegroundColor Yellow
        }
        elseif ($totalDuration -gt $MaxTotalDurationSec * $SpeedThreshold) {
            Invoke-ErrorAction -ErrorMessage "总时长 $totalDuration 秒超过允许阈值，请重选片段或调整日志" -ErrorStep "日志复刻-时长检查"
            Write-ReplicaFail -Name $job.Name -Reason ("总时长超阈值：" + [math]::Round($totalDuration,1) + " 秒")
            continue
        }

        $outName = $job.Name
        if ($mode -eq 2) {
            $outName = (Get-TaskDate).ToString('yyMMdd') + '改-' + $outName
        }
        $finalOut = Join-Path $outRoot $outName
        if ([System.IO.Path]::GetExtension($finalOut) -eq '') { $finalOut += '.mp4' }

        $inputArgs = @()
        foreach ($p in $videos) {
            $inputArgs += "-i"
            $inputArgs += "`"$p`""
        }
        $inputArgs += "-i"
        $inputArgs += "`"$($job.Watermark)`""

        $n = $videos.Count
        if ($n -eq 0) {
            Invoke-ErrorAction -ErrorMessage "无有效视频片段" -ErrorStep "日志复刻-片段数检查"
            Write-ReplicaFail -Name $job.Name -Reason "无有效视频片段"
            continue
        }
        $concatInputs = ""
        for ($i = 0; $i -lt $n; $i++) { $concatInputs += "[${i}:v][${i}:a]" }
        $filterComplex = "${concatInputs}concat=n=${n}:v=1:a=1[outv][outa];[outv]overlay=0:0[wateredv]"
        if ($needSpeed) {
            $filterComplex += ";[wateredv]setpts=PTS/(${speedRatio})[v];[outa]atempo=${speedRatio}[a]"
            $mapV = "[v]"
            $mapA = "[a]"
        }
        else {
            $mapV = "[wateredv]"
            $mapA = "[outa]"
        }

        $encArgs = @(
            "-filter_complex", $filterComplex,
            "-map", $mapV, "-map", $mapA,
            "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "27",
            "-profile:v", "high", "-level", "4.1",
            "-c:a", "aac", "-b:a", "192k",
            "-y", "`"$finalOut`""
        )
        $targetDur = if ($totalDuration -gt $MaxTotalDurationSec) { $MaxTotalDurationSec } else { $totalDuration }
        Write-Output ("成片预计时长: " + [math]::Round($targetDur, 2) + " 秒")
        $code = Invoke-FFmpegWithProgress ($inputArgs + $encArgs)
        if ($code -ne 0) {
            Invoke-ErrorAction -ErrorMessage "编码失败：$($job.Name)" -ErrorStep "日志复刻-编码"
            Write-ReplicaFail -Name $job.Name -Reason "ffmpeg 编码失败"
            continue
        }
        Write-Host "✅ 成片完成：$finalOut" -ForegroundColor Green

        # 写复刻日志
        $logContent = @(
            (Split-Path -Path $finalOut -Leaf),
            "使用片段列表：",
            $videos,
            "",
            $job.Watermark
        )
        if ($jobIndex -lt $jobs.Count) {
            $logContent += ("=" * 46)
        }
        $logContent | Out-File -Path $logFilePath -Encoding UTF8 -Append
    }
    }
    finally {
        if ($mutex) {
            try { $mutex.ReleaseMutex() } catch {}
            try { $mutex.Dispose() } catch {}
            Write-Host "🔓 互斥锁已释放" -ForegroundColor DarkGray
        }
    }
}

# ------------------------------ 主脚本入口 ------------------------------
try {
    if (-not $env:REPLICA_TXT) {
        Write-Host "`n========================================" -ForegroundColor Cyan
        Write-Host "   请将日志TXT拖入本窗口后按回车" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Cyan
    }

    $txtFilePath = $null
    if ($env:REPLICA_TXT) {
        $candidate = $env:REPLICA_TXT.Trim('"').Trim("'")
        if (Test-Path $candidate -PathType Leaf) {
            $txtFilePath = $candidate
            Write-Host "✅ 已通过 REPLICA_TXT 指定TXT文件: $((Get-Item $candidate).Name)" -ForegroundColor Green
        }
    }
    if (-not $txtFilePath) {
        Invoke-ErrorAction -ErrorMessage "未通过环境变量 REPLICA_TXT 提供日志 TXT 文件（脚本由 Video Lab 驱动，不再支持手动输入）" -ErrorStep "日志TXT输入"
        [Environment]::Exit(1)
    }

    $txtDir = Split-Path -Path $txtFilePath -Parent
    $txtFile = Get-Item $txtFilePath

    $pathParts = $txtDir -split '\\'
    $foundDateDir = $false
    $dateDirIndex = -1
    for ($i = 0; $i -lt $pathParts.Count; $i++) {
        if ($pathParts[$i] -match '^\d+月$' -or $pathParts[$i] -match '^\d{4}$') {
            $dateDirIndex = $i
            $foundDateDir = $true
            break
        }
    }
    if ($foundDateDir -and $dateDirIndex -gt 0) {
        $baseDir = [string]::Join('\', $pathParts[0..($dateDirIndex - 1)])
    }
    elseif ($foundDateDir -and $dateDirIndex -eq 0) {
        $baseDir = $pathParts[0]
    }
    else {
        $baseDir = $txtDir
    }
    $currentDate = Get-TaskDate
    $currentMonth = $currentDate.ToString('M月')
    $currentDay = $currentDate.ToString('MMdd')
    $outputRootDir = Join-Path (Join-Path $baseDir $currentMonth) $currentDay
    Write-Host "`n✅ 输出目录：$outputRootDir" -ForegroundColor Green

    $allLines = Get-Content -Path $txtFile.FullName -Encoding UTF8 | Where-Object { $_ -match '\S' } | ForEach-Object { $_.Trim() }
    if (-not ($allLines -match '使用片段列表：')) {
        throw "不是日志格式TXT，请使用视频复刻日志文件"
    }

    # 缺失片段修复数据源为实时缓存（video_cache.json），无需手动索引；直接进入复刻主流程
    Invoke-ReplicaFromLog -AllLines $allLines -OutputRootDir $outputRootDir
}
catch {
    if ($env:REPLICA_NO_WAIT -eq '1') {
        Write-Host "`n================ 全局异常 ================" -ForegroundColor Red
        Write-Host $_.Exception.ToString() -ForegroundColor Red
        Write-Host "---- 脚本调用栈 ----" -ForegroundColor Yellow
        Write-Host $_.ScriptStackTrace -ForegroundColor Yellow
        Write-Host "==========================================`n" -ForegroundColor Red
        [Environment]::Exit(1)
    }
    Invoke-ErrorAction -ErrorMessage $_.Exception.Message -ErrorStep "全局异常"
}

# ---- 统一收尾：报错保留窗口供查看；成功直接退出（执行顺序与等待由 Video Lab 软件接管） ----
if ($Script:HasError) {
    Write-Host "`n脚本执行完成（有错误）" -ForegroundColor Yellow
    Write-Host "窗口将保留 600 秒供查看，看完请直接关闭窗口" -ForegroundColor DarkGray
    if ($env:REPLICA_NO_WAIT -ne '1') { Start-Sleep -Seconds 600 }
    [Environment]::Exit(1)
}

Write-Host "`n脚本完成" -ForegroundColor Green
[Environment]::Exit(0)
