# ------------------------------ 全局参数 -------------------------------------
$MaxTotalDurationSec = 179
$MaxRetry = 45
$SpeedThreshold = 1.2
$Script:HasError = $false
$TxtNamePrefix = ""
$ProducerName = "默认"
$SuffixMark = ""

# 环境变量覆盖（由 Video Lab 设置页写入 config.json 后注入）：
if ($env:BATCH_MAX_DURATION) { try { $MaxTotalDurationSec = [double]$env:BATCH_MAX_DURATION } catch {} }
if ($env:BATCH_MAX_RETRY) { try { $MaxRetry = [double]$env:BATCH_MAX_RETRY } catch {} }
if ($env:BATCH_SPEED_LIMIT) { try { $SpeedThreshold = [double]$env:BATCH_SPEED_LIMIT } catch {} }
if ($env:BATCH_TXT_PREFIX) { $TxtNamePrefix = $env:BATCH_TXT_PREFIX }
if ($env:BATCH_PRODUCER) { $ProducerName = $env:BATCH_PRODUCER }
if ($null -ne $env:BATCH_SUFFIX_MARK) { $SuffixMark = [string]$env:BATCH_SUFFIX_MARK }

# 任务提交时刻优先（BATCH_SUBMIT_TS 由应用在任务提交时注入）：排队跨天运行时，
# 成片命名/日志/输出目录一律按提交日期，不回退到实际运行日期
function Get-TaskDate {
    if ($env:BATCH_SUBMIT_TS) {
        try {
            $ts = [long]$env:BATCH_SUBMIT_TS
            if ($ts -gt 0) { return [DateTimeOffset]::FromUnixTimeMilliseconds($ts).ToLocalTime().DateTime }
        } catch {}
    }
    return Get-Date
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ------------------------------ 缓存文件路径 -------------------------------------
$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
# 缓存目录：默认脚本目录；应用通过 VL_CACHE_DIR 注入，统一放到项目的 Cache 子文件夹（与应用预检测共用同一 video_cache.json）
$scriptCacheDir = $env:VL_CACHE_DIR
if ([string]::IsNullOrEmpty($scriptCacheDir)) { $scriptCacheDir = $scriptDir }
$cacheFile = Join-Path $scriptCacheDir "video_cache.json"
$cache = @{}
$IsCacheUpdated = $false
if (Test-Path $cacheFile) {
    try {
        $cache = Get-Content $cacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    }
    catch {
        Write-Host "⚠️  缓存文件损坏，将重建" -ForegroundColor Yellow
        $cache = @{}
    }
}

$usageCacheFile = Join-Path $scriptCacheDir "usage_cache.json"
$UsageCacheMap = @{}
if (Test-Path $usageCacheFile) {
    try {
        $UsageCacheMap = Get-Content $usageCacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    }
    catch {
        $UsageCacheMap = @{}
    }
}

# 内存重置：所有历史计数 ≥1 的文件在内存中降为 1
foreach ($key in $UsageCacheMap.Keys) {
    if ($UsageCacheMap[$key].UsageCount -ge 1) {
        $UsageCacheMap[$key].UsageCount = 1
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
        $Script:IsCacheUpdated = $true
        return [PSCustomObject]@{
            Valid              = $valid
            Duration           = $duration
            Width              = $width
            Height             = $height
            LastWriteTimeTicks = $fileInfo.LastWriteTimeUtc.Ticks
        }
    }
}

function Resolve-BrokenTarget {
    param([string]$TargetPath)
    if (-not $TargetPath) { return $null }
    if (Test-Path $TargetPath) { return $TargetPath }
    $leaf = Split-Path -Path $TargetPath -Leaf
    $dir = Split-Path -Path $TargetPath -Parent
    while ($dir) {
        if (Test-Path $dir -PathType Container) {
            $cand = Join-Path $dir $leaf
            if (Test-Path $cand) { return $cand }
        }
        $parent = Split-Path -Path $dir -Parent
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

function Get-ShortcutTarget {
    param([string]$LnkPath)
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($LnkPath)
        $targetPath = $shortcut.TargetPath.Trim()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($shortcut) | Out-Null
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($shell) | Out-Null
        if (Test-Path $targetPath) { return $targetPath }
        # 智能修复失效快捷方式
        $resolved = Resolve-BrokenTarget -TargetPath $targetPath
        if ($resolved) {
            Write-Host "🔧 快捷方式已智能修复：$LnkPath -> $resolved" -ForegroundColor Green
            return $resolved
        }
        Write-Host "⚠️  快捷方式失效：$LnkPath 目标无法解析（$targetPath）" -ForegroundColor Yellow
        return $null
    }
    catch {
        Write-Host "⚠️  解析快捷方式 $LnkPath 失败：$($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

function Get-VideoFile {
    param([string]$RootPath)
    $videoFiles = @()
    try {
        $items = Get-ChildItem -Path $RootPath -Force
        foreach ($item in $items) {
            if ($item.Extension -eq ".lnk") { continue }
            if ($item.PSIsContainer) {
                $videoFiles += Get-VideoFile -RootPath $item.FullName
                continue
            }
            if ($item.Extension -in '.mp4', '.mov', '.avi', '.mkv', '.m4v') {
                $videoFiles += $item
            }
        }
    }
    catch {
        Write-Host "⚠️  遍历文件夹 $RootPath 失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
    return $videoFiles
}

function Test-ExcludePath {
    param([string]$VideoFullPath, [array]$ExcludePaths)
    if (-not $ExcludePaths -or $ExcludePaths.Count -eq 0) { return $false }
    foreach ($exPath in $ExcludePaths) {
        $cleanExPath = $exPath.Trim().TrimEnd('\')
        if ([string]::IsNullOrEmpty($cleanExPath)) { continue }
        if ($VideoFullPath.IndexOf($cleanExPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Get-SortKey {
    param([string]$str)
    return [regex]::Replace($str, '\d+', { param($m) $m.Value.PadLeft(8, '0') })
}

# ==================== 分组重命名函数（静默） ====================
function Invoke-GroupRename {
    param([string]$FolderPath, [int]$X)
    if ($X -le 0) { return }
    $mp4Files = Get-ChildItem -File -Filter "*.mp4" -Path $FolderPath
    if ($mp4Files.Count -eq 0) { return }

    $sorted = $mp4Files | Sort-Object {
        [int]([regex]::Match($_.BaseName, '\d+$').Value)
    }

    $total = $sorted.Count
    $groupSize = [math]::Floor($total / $X)
    $remainder = $total % $X

    $startIdx = 0
    for ($i = 0; $i -lt $X; $i++) {
        $size = $groupSize
        if ($i -lt $remainder) { $size++ }
        if ($size -le 0 -or $startIdx -ge $total) { continue }
        $groupFiles = $sorted[$startIdx..($startIdx + $size - 1)]
        $startIdx += $size
        $letter = [char](65 + $i)
        foreach ($file in $groupFiles) {
            $newName = $file.BaseName + $letter + $file.Extension
            $newFullPath = Join-Path -Path $FolderPath -ChildPath $newName
            if (Test-Path $newFullPath) { continue }
            try {
                Rename-Item -Path $file.FullName -NewName $newName -ErrorAction Stop
            }
            catch {
                # 静默
            }
        }
    }
}

# ==================== 选择函数 ====================
function Select-Video {
    param(
        [string]$Folder,
        $Track,
        $FolderData,
        [array]$ExcludedPaths = @(),
        [array]$ExcludedSubGroups = @(),
        [switch]$PreferShort
    )
    
    $plan = [PSCustomObject]@{
        Folder            = $Folder
        NewRound          = $Track.Round
        NewRoundUsed      = $Track.RoundUsed.Clone()
        NewSubRound       = $FolderData.SubRound
        NewSubUsedInRound = $FolderData.SubUsedInRound.Clone()
        SelectedGroup     = $null
        IncrementSubUsage = $null
    }
    
    function Select-VideoCandidate {
        param(
            [array]$FileList,
            [hashtable]$UsedCount,
            [array]$RoundUsed,
            [array]$Exclude,
            [switch]$PreferShort
        )
        $candidates = @($FileList | Where-Object { $_.FullName -notin $RoundUsed -and $_.FullName -notin $Exclude })
        if ($candidates.Count -eq 0) { return $null }
        $minCount = $candidates | ForEach-Object { $UsedCount[$_.FullName] } | Measure-Object -Minimum | Select-Object -ExpandProperty Minimum
        $minFiles = @($candidates | Where-Object { $UsedCount[$_.FullName] -eq $minCount })
        # 时长感知（重试轮）：同频次候选中优先取最短，压低总时长，减少超限重试
        if ($PreferShort) {
            return @($minFiles | Sort-Object { (Get-CachedVideoInfo -VideoPath $_.FullName).Duration })[0]
        }
        return $minFiles | Get-Random
    }
    
    if ($FolderData.SubGroupList.Count -le 1) {
        $allFiles = $FolderData.AllVideos
        $selectedVideo = Select-VideoCandidate -FileList $allFiles -UsedCount $Track.UsedCount -RoundUsed $Track.RoundUsed -Exclude $ExcludedPaths -PreferShort:$PreferShort
        if ($selectedVideo) {
            $plan.SelectedGroup = $null
            $plan.IncrementSubUsage = $null
            return [PSCustomObject]@{ Video = $selectedVideo; UpdatePlan = $plan }
        }
        else {
            $plan.NewRound = $Track.Round + 1
            $plan.NewRoundUsed = @()
            $selectedVideo = Select-VideoCandidate -FileList $allFiles -UsedCount $Track.UsedCount -RoundUsed @() -Exclude $ExcludedPaths -PreferShort:$PreferShort
            if ($selectedVideo) {
                $plan.SelectedGroup = $null
                $plan.IncrementSubUsage = $null
                return [PSCustomObject]@{ Video = $selectedVideo; UpdatePlan = $plan }
            }
            else {
                return $null
            }
        }
    }
    
    $globalUsed = $FolderData.SubUsedInRound
    $zeroGroups = @()
    foreach ($group in $FolderData.SubGroupList) {
        if ($group -in $globalUsed) { continue }
        $filesInGroup = $FolderData.SubGroups[$group]
        $hasZeroLeft = $false
        foreach ($file in $filesInGroup) {
            if ($file.FullName -notin $Track.RoundUsed -and $Track.UsedCount[$file.FullName] -eq 0) {
                $hasZeroLeft = $true
                break
            }
        }
        if ($hasZeroLeft) { $zeroGroups += $group }
    }
    
    if ($zeroGroups.Count -gt 0) {
        $candidateGroups = $zeroGroups
    }
    else {
        $candidateGroups = $FolderData.SubGroupList | Where-Object { $_ -notin $globalUsed }
    }
    
    if (-not $candidateGroups) {
        $plan.NewSubRound = $FolderData.SubRound + 1
        $plan.NewSubUsedInRound = @()
        $candidateGroups = $FolderData.SubGroupList
        $globalUsed = @()
    }
    else {
        $plan.NewSubRound = $FolderData.SubRound
        $plan.NewSubUsedInRound = $globalUsed.Clone()
    }
    
    $candidateGroups = $candidateGroups | Where-Object { $_ -notin $ExcludedSubGroups }
    if (-not $candidateGroups) {
        $candidateGroups = $FolderData.SubGroupList | Where-Object { $_ -notin $globalUsed }
        if (-not $candidateGroups) {
            $plan.NewSubRound = $FolderData.SubRound + 1
            $plan.NewSubUsedInRound = @()
            $candidateGroups = $FolderData.SubGroupList
        }
    }
    
    $selectedVideo = $null
    while ($candidateGroups.Count -gt 0) {
        $minCountGroup = $candidateGroups | ForEach-Object { $FolderData.SubUsageCount[$_] } | Measure-Object -Minimum | Select-Object -ExpandProperty Minimum
        $bestGroups = $candidateGroups | Where-Object { $FolderData.SubUsageCount[$_] -eq $minCountGroup }
        $selectedGroup = $bestGroups | Get-Random
        
        $allFiles = $FolderData.SubGroups[$selectedGroup]
        $selectedVideo = Select-VideoCandidate -FileList $allFiles -UsedCount $Track.UsedCount -RoundUsed $Track.RoundUsed -Exclude $ExcludedPaths -PreferShort:$PreferShort
        
        if ($selectedVideo) {
            $plan.SelectedGroup = $selectedGroup
            $plan.IncrementSubUsage = $selectedGroup
            $plan.NewSubUsedInRound += $selectedGroup
            return [PSCustomObject]@{ Video = $selectedVideo; UpdatePlan = $plan }
        }
        else {
            $candidateGroups = $candidateGroups | Where-Object { $_ -ne $selectedGroup }
        }
    }
    
    if ($Track.RoundUsed.Count -eq $FolderData.AllVideos.Count) {
        $plan.NewRound = $Track.Round + 1
        $plan.NewRoundUsed = @()
        $plan.NewSubRound = $FolderData.SubRound + 1
        $plan.NewSubUsedInRound = @()
        $allFiles = $FolderData.AllVideos
        $selectedVideo = Select-VideoCandidate -FileList $allFiles -UsedCount $Track.UsedCount -RoundUsed @() -Exclude $ExcludedPaths -PreferShort:$PreferShort
        if ($selectedVideo) {
            $plan.SelectedGroup = $null
            $plan.IncrementSubUsage = $null
            return [PSCustomObject]@{ Video = $selectedVideo; UpdatePlan = $plan }
        }
    }
    
    return $null
}

# ------------------------------ 缓存写入函数 ------------------------------
function Export-UsageCache {
    param([hashtable]$Increments, [string]$UsageCacheFile)
    $globalCache = @{}
    if (Test-Path $UsageCacheFile) {
        $globalCache = Get-Content $UsageCacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    }
    foreach ($path in $Increments.Keys) {
        $inc = $Increments[$path]
        $currentTicks = (Get-Item -LiteralPath $path).LastWriteTimeUtc.Ticks
        if ($globalCache.ContainsKey($path)) {
            $entry = $globalCache[$path]
            $entry.UsageCount += $inc
            $entry.LastWriteTime = $currentTicks
        }
        else {
            $globalCache[$path] = @{
                UsageCount    = $inc
                LastWriteTime = $currentTicks
            }
        }
    }
    $globalCache | ConvertTo-Json -Compress | Set-Content $UsageCacheFile -Encoding UTF8
}

# ------------------------------ 生成报告函数 ------------------------------
function Export-UsageReport {
    param([string]$UsageCacheFile, [string]$ReportFile)
    if (-not (Test-Path $UsageCacheFile)) { return }
    $data = Get-Content $UsageCacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    if ($data.Count -eq 0) { return }

    $sortedEntries = $data.Keys | Sort-Object { Get-SortKey $_ } | ForEach-Object {
        [PSCustomObject]@{
            Path  = $_
            Count = $data[$_].UsageCount
            Leaf  = Split-Path (Split-Path $_ -Parent) -Leaf
        }
    }

    $lines = @()
    $currentLeaf = $null
    $firstEntry = $true

    foreach ($entry in $sortedEntries) {
        if ($entry.Leaf -ne $currentLeaf) {
            if (-not $firstEntry) {
                $lines += "-" * 60
            }
            $currentLeaf = $entry.Leaf
            $firstEntry = $false
        }
        $lines += "$($entry.Path) : $($entry.Count)"
    }

    $lines | Out-File -FilePath $ReportFile -Encoding UTF8
}

# ------------------------------ 索引辅助（批量路径自动修复） ------------------------------
function Find-IndexInTree {
    param([string]$StartPath)
    if (-not $StartPath) { return '' }
    $dir = if (Test-Path $StartPath -PathType Container) { $StartPath } else { Split-Path -Path $StartPath -Parent }
    while ($dir) {
        $cands = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object {
            $_.Extension -ieq '.tsv' -or ($_.Extension -ieq '.txt' -and $_.Name -match '索引|index')
        })
        if ($cands.Count -gt 0) {
            return ($cands | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
        }
        $parent = Split-Path -Path $dir -Parent
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    return ''
}

function Find-IndexFile {
    param([string]$HintPath = '', [string[]]$HintPaths = @())
    # 方案：统计每个路径线索“最近命中”的索引目录，选择命中次数最多的库
    $voteDirs = @{}
    foreach ($hp in @($HintPath) + @($HintPaths)) {
        if (-not $hp) { continue }
        $found = Find-IndexInTree -StartPath $hp
        if ($found) {
            $dir = Split-Path -Path $found -Parent
            if (-not $voteDirs.ContainsKey($dir)) { $voteDirs[$dir] = 0 }
            $voteDirs[$dir]++
        }
    }
    if ($voteDirs.Count -gt 0) {
        $maxCount = ($voteDirs.Values | Measure-Object -Maximum).Maximum
        $topDirs = @($voteDirs.Keys | Where-Object { $voteDirs[$_] -eq $maxCount })
        if ($topDirs.Count -eq 1) {
            $topIdx = Get-ChildItem -LiteralPath $topDirs[0] -File -ErrorAction SilentlyContinue | Where-Object {
                $_.Extension -ieq '.tsv' -or ($_.Extension -ieq '.txt' -and $_.Name -match '索引|index')
            } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($topIdx) { return $topIdx.FullName }
        }
    }

    # 平票或无法统计：回退到就近优先
    $searchRoots = @()
    if ($HintPath) { $searchRoots += $HintPath }
    foreach ($hp in $HintPaths) { if ($hp) { $searchRoots += $hp } }
    $searchRoots += $PSScriptRoot
    $searchRoots = $searchRoots | Where-Object { $_ } | Select-Object -Unique
    foreach ($root in $searchRoots) {
        $found = Find-IndexInTree -StartPath $root
        if ($found) { return $found }
    }
    return ''
}

$script:batchIndexLoaded = $false
$script:batchByDirLeaf = @{}
$script:batchByDirSuffix = @{}

function Get-FolderSuffix {
    param([string]$FolderPath)
    $name = Split-Path -Path $FolderPath -Leaf
    $idx = $name.LastIndexOf('-')
    if ($idx -ge 0 -and $idx -lt $name.Length - 1) {
        return $name.Substring($idx + 1)
    }
    return $name
}

function Load-BatchIndex {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    $script:batchByDirLeaf = @{}
    $script:batchByDirSuffix = @{}
    $lines = Get-Content -LiteralPath $Path -Encoding UTF8 | Select-Object -Skip 1
    foreach ($line in $lines) {
        if (-not $line) { continue }
        $c = $line -split "`t", 8
        if ($c.Count -lt 3) { continue }
        $dir = $c[2]
        $leaf = Split-Path -Path $dir -Leaf
        $key = $leaf.ToLower()
        if (-not $script:batchByDirLeaf.ContainsKey($key)) { $script:batchByDirLeaf[$key] = @() }
        $script:batchByDirLeaf[$key] += $dir

        $suffix = Get-FolderSuffix -FolderPath $dir
        $sKey = $suffix.ToLower()
        if (-not $script:batchByDirSuffix.ContainsKey($sKey)) { $script:batchByDirSuffix[$sKey] = @() }
        $script:batchByDirSuffix[$sKey] += $dir
    }
    $script:batchIndexLoaded = $true
}

function Resolve-FolderFromIndex {
    param([string]$MissingPath)
    $leaf = Split-Path -Path $MissingPath -Leaf
    if (-not $leaf) { return $null }
    $key = $leaf.ToLower()
    if (-not $script:batchByDirLeaf.ContainsKey($key)) { return $null }
    $dirs = @($script:batchByDirLeaf[$key] | Select-Object -Unique)
    foreach ($d in $dirs) {
        if (Test-Path $d) { return $d }
    }
    return $null
}

function Resolve-FolderBySuffix {
    param([string]$MissingPath)
    $suffix = Get-FolderSuffix -FolderPath $MissingPath
    if (-not $suffix) { return @() }
    $sKey = $suffix.ToLower()
    if (-not $script:batchByDirSuffix.ContainsKey($sKey)) { return @() }
    $dirs = @($script:batchByDirSuffix[$sKey] | Select-Object -Unique | Where-Object { Test-Path $_ })
    return @($dirs)
}

# ------------------------------ 主脚本 ---------------------------------------
try {
    if (-not $env:REPLICA_TXT) {
        Write-Host "`n========================================" -ForegroundColor Cyan
        Write-Host "   请将TXT配置文件拖入本窗口后按回车" -ForegroundColor Yellow
        Write-Host "========================================" -ForegroundColor Cyan
    }
    
    $txtFilePath = $null
    if ($env:REPLICA_TXT) {
        $candidate = $env:REPLICA_TXT.Trim('"').Trim("'")
        if (Test-Path $candidate -PathType Leaf) {
            $fileInfo = Get-Item $candidate
            if ($fileInfo.Extension -eq ".txt") {
                $txtFilePath = $candidate
                Write-Host "✅ 已通过 REPLICA_TXT 指定TXT文件: $($fileInfo.Name)" -ForegroundColor Green
            }
        }
    }
    if (-not $txtFilePath) {
        Invoke-ErrorAction -ErrorMessage "未通过环境变量 REPLICA_TXT 提供 TXT 文件（脚本由 Video Lab 驱动，不再支持手动输入）" -ErrorStep "TXT输入"
        [Environment]::Exit(1)
    }
    
    $txtDir = Split-Path -Path $txtFilePath -Parent
    $txtFile = Get-Item $txtFilePath
    $txtName = $txtFile.BaseName
    # 提取前缀与剩余部分
    $txtNamePrefixPart = ""
    $txtNameSuffix = $txtName
    if (-not [string]::IsNullOrEmpty($TxtNamePrefix) -and $txtName.StartsWith($TxtNamePrefix)) {
        $txtNamePrefixPart = $TxtNamePrefix
        $txtNameSuffix = $txtName.Substring($TxtNamePrefix.Length)
    }
  
    $pathParts = $txtDir -split '\\'
    $foundDateDir = $false
    $dateDirIndex = -1
    for ($i = 0; $i -lt $pathParts.Count; $i++) {
        $part = $pathParts[$i]
        if ($part -match '^\d+月$' -or $part -match '^\d{4}$') {
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
    if ($env:REPLICA_OUTPUT_DIR) { $outputRootDir = $env:REPLICA_OUTPUT_DIR }
    Write-Host "`n✅ 输出目录：$outputRootDir" -ForegroundColor Green
    
    $allLines = Get-Content -Path $txtFile.FullName -Encoding UTF8 | Where-Object { $_ -match '\S' } | ForEach-Object { $_.Trim() }
    if ($allLines.Count -lt 2) { throw "TXT至少需要1个文件夹+1个水印" }

    $watermark = $allLines[-1]
    $watermark = Remove-Quotes -str $watermark
    
    $excludePaths = @()
    $folderLines = @()
    $noSubRoundFolders = @{}
    foreach ($line in $allLines[0..($allLines.Count - 2)]) {
        $line = $line.Trim()
        if ($line.Contains('=')) {
            $folderPath = $line -replace '=', ''
            $folderPath = $folderPath.Trim()
            if ($folderPath) {
                $folderLines += $folderPath
                $noSubRoundFolders[$folderPath] = $true
            }
        }
        elseif ($line.StartsWith('-')) {
            $excludePath = $line.Substring(1).Trim()
            $excludePath = Remove-Quotes -str $excludePath
            if ($excludePath) { $excludePaths += $excludePath }
        }
        else {
            $folderPath = Remove-Quotes -str $line
            $folderLines += $folderPath
        }
    }
    
    # 利用索引自动修复不存在的目录路径
    $txtReplacements = @{}
    $missingPaths = @($folderLines | Where-Object { -not (Test-Path $_) })
    if ($missingPaths.Count -gt 0) {
        if (-not $script:batchIndexLoaded) {
            $idxFile = Find-IndexFile -HintPath $txtFilePath -HintPaths $folderLines
            if ($idxFile) {
                Load-BatchIndex -Path $idxFile
                Write-Host "📇 已加载索引：$idxFile" -ForegroundColor Cyan
            }
        }
        foreach ($mp in $missingPaths) {
            $newDir = $null
            # 1. 优先相同文件夹名
            $newDir = Resolve-FolderFromIndex -MissingPath $mp
            if ($newDir -and $newDir -ne $mp) {
                Write-Host "🔎 索引自动修正（相同文件夹名）：$mp -> $newDir" -ForegroundColor Green
            }
            else {
                # 2. 相同后缀（以 - 分割），列出供用户选择
                $suffixCands = @(Resolve-FolderBySuffix -MissingPath $mp)
                if ($suffixCands.Count -gt 0) {
                    $selected = $null
                    if ($suffixCands.Count -eq 1) {
                        $selected = $suffixCands[0]
                        Write-Host "🔎 索引自动修正（相同后缀）：$mp -> $selected" -ForegroundColor Green
                    }
                    else {
                        Write-Host "`n🔎 路径 $mp 未找到同名文件夹，但找到以下相同后缀候选：" -ForegroundColor Cyan
                        for ($s = 0; $s -lt $suffixCands.Count; $s++) {
                            Write-Host "  $($s + 1). $($suffixCands[$s])" -ForegroundColor Yellow
                        }
                        $selected = $suffixCands[0]
                        Write-Host "（由 Video Lab 驱动，自动选择第 1 项）" -ForegroundColor DarkGray
                    }
                    if ($selected -and $selected -ne $mp) {
                        Write-Host "🔎 索引自动修正：$mp -> $selected" -ForegroundColor Green
                        $newDir = $selected
                    }
                }
            }
            if ($newDir) {
                $txtReplacements[$mp] = $newDir
                for ($i = 0; $i -lt $folderLines.Count; $i++) {
                    if ($folderLines[$i] -ieq $mp) {
                        $folderLines[$i] = $newDir
                        if ($noSubRoundFolders.ContainsKey($mp)) {
                            $noSubRoundFolders[$newDir] = $true
                            $noSubRoundFolders.Remove($mp)
                        }
                    }
                }
            }
        }
        # 同步写回 TXT 文件
        if ($txtReplacements.Count -gt 0) {
            $txtLines = Get-Content -LiteralPath $txtFile.FullName -Encoding UTF8
            for ($i = 0; $i -lt $txtLines.Count; $i++) {
                $trim = $txtLines[$i].Trim()
                $key = $trim
                if ($key.StartsWith('=')) { $key = $key.Substring(1).Trim() }
                if ($txtReplacements.ContainsKey($key)) {
                    if ($trim.StartsWith('=')) { $txtLines[$i] = '=' + $txtReplacements[$key] }
                    else { $txtLines[$i] = $txtReplacements[$key] }
                }
            }
            Set-Content -LiteralPath $txtFile.FullName -Value $txtLines -Encoding UTF8
            Write-Host "✅ TXT文件已同步更新：$($txtFile.FullName)" -ForegroundColor Green
        }
    }

    # 检测路径是否存在（不再强制为容器）
    $invalidPaths = $folderLines | Where-Object { -not (Test-Path $_) }
    if ($invalidPaths.Count -gt 0) {
        Write-Host "`n❌ 以下路径无法通过索引自动修复：" -ForegroundColor Red
        $invalidPaths | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
        Write-Host "请手动修改TXT后重新拖入。" -ForegroundColor Yellow
        Remove-Item Env:REPLICA_TXT -ErrorAction SilentlyContinue
        & $PSCommandPath @args
        [Environment]::Exit(0)
    }

    if (-not $watermark.EndsWith('.png', [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $watermark)) {
        Write-Host "`n❌ 水印必须是有效PNG文件：$watermark" -ForegroundColor Red
        Write-Host "请修改TXT后重新拖入。" -ForegroundColor Yellow
        Remove-Item Env:REPLICA_TXT -ErrorAction SilentlyContinue
        & $PSCommandPath @args
        [Environment]::Exit(0)
    }
    if ($folderLines.Count -eq 0) {
        Write-Host "`n❌ 无有效视频文件夹" -ForegroundColor Red
        Write-Host "请修改TXT后重新拖入。" -ForegroundColor Yellow
        Remove-Item Env:REPLICA_TXT -ErrorAction SilentlyContinue
        & $PSCommandPath @args
        [Environment]::Exit(0)
    }
    
    $sourceRequests = $folderLines
    $uniqueFolders = $sourceRequests | Select-Object -Unique
    
    $pathCounts = @{}
    foreach ($p in $sourceRequests) {
        if (-not $pathCounts.ContainsKey($p)) { $pathCounts[$p] = 0 }
        $pathCounts[$p]++
    }
    $repeatPaths = $pathCounts.Keys | Where-Object { $pathCounts[$_] -gt 1 }
    if ($repeatPaths.Count -gt 0) {
        Write-Host "🔁 检测到重复路径，将在拼接时输出这些路径的详细选取信息" -ForegroundColor Cyan
        foreach ($rp in $repeatPaths) {
            Write-Host "   📂 $rp (出现 $($pathCounts[$rp]) 次)" -ForegroundColor Yellow
        }
    }
    
    Write-Host "`n预检测视频文件" -ForegroundColor Cyan
    $folderVideos = @{}
    $usageTracker = @{}
    $fileTimeMap = @{}
    $newFiles = @()
    
    foreach ($f in $uniqueFolders) {
        $pathItem = Get-Item -LiteralPath $f -ErrorAction Stop
        $subDirPaths = @()
        $lnkFiles = @()
        $rootVideoItems = @()

        if ($pathItem.PSIsContainer) {
            # 文件夹：扫描子文件夹和快捷方式
            $rootItems = Get-ChildItem -LiteralPath $f -Force
            foreach ($item in $rootItems) {
                if ($item.PSIsContainer) {
                    $subDirPaths += $item.FullName
                }
                elseif ($item.Extension -eq ".lnk") {
                    $lnkFiles += $item
                }
                elseif ($item.Extension -in '.mp4', '.mov', '.avi', '.mkv', '.m4v') {
                    $rootVideoItems += $item
                }
            }
        }
        else {
            # 直接传入的视频文件
            if ($pathItem.Extension -in '.mp4', '.mov', '.avi', '.mkv', '.m4v') {
                if (-not (Test-ExcludePath -VideoFullPath $pathItem.FullName -ExcludePaths $excludePaths)) {
                    $rootVideoItems += $pathItem
                }
                else {
                    Write-Host "⚠️  文件被排除规则命中：$($pathItem.FullName)" -ForegroundColor Yellow
                }
            }
            else {
                Write-Host "⚠️  指定的文件不是视频格式：$f" -ForegroundColor Yellow
                continue
            }
        }
        
        $subGroups = @{}
        if ($rootVideoItems) {
            $validRootVideos = @()
            foreach ($vid in $rootVideoItems) {
                if (Test-ExcludePath -VideoFullPath $vid.FullName -ExcludePaths $excludePaths) { continue }
                $info = Get-CachedVideoInfo -VideoPath $vid.FullName
                if ($info.Valid) {
                    $validRootVideos += [PSCustomObject]@{ FullName = $vid.FullName; Name = $vid.Name; Duration = $info.Duration }
                    $fileTimeMap[$vid.FullName] = $info.LastWriteTimeTicks
                    if (-not $UsageCacheMap.ContainsKey($vid.FullName)) {
                        $newFiles += $vid.FullName
                    }
                }
            }
            if ($validRootVideos) { $subGroups["(根目录)"] = $validRootVideos }
        }
        
        foreach ($subDir in $subDirPaths) {
            $subVideos = Get-VideoFile -RootPath $subDir
            if ($subVideos) {
                $validSubVideos = @()
                foreach ($vid in $subVideos) {
                    if (Test-ExcludePath -VideoFullPath $vid.FullName -ExcludePaths $excludePaths) { continue }
                    $info = Get-CachedVideoInfo -VideoPath $vid.FullName
                    if ($info.Valid) {
                        $validSubVideos += [PSCustomObject]@{ FullName = $vid.FullName; Name = $vid.Name; Duration = $info.Duration }
                        $fileTimeMap[$vid.FullName] = $info.LastWriteTimeTicks
                        if (-not $UsageCacheMap.ContainsKey($vid.FullName)) {
                            $newFiles += $vid.FullName
                        }
                    }
                }
                if ($validSubVideos) { $subGroups[$subDir] = $validSubVideos }
            }
        }
        
        foreach ($lnk in $lnkFiles) {
            $target = Get-ShortcutTarget -LnkPath $lnk.FullName
            if (-not $target) { continue }
            if (Test-Path $target -PathType Container) {
                $targetVideos = Get-VideoFile -RootPath $target
                if ($targetVideos) {
                    $validTargetVideos = @()
                    foreach ($vid in $targetVideos) {
                        if (Test-ExcludePath -VideoFullPath $vid.FullName -ExcludePaths $excludePaths) { continue }
                        $info = Get-CachedVideoInfo -VideoPath $vid.FullName
                        if ($info.Valid) {
                            $validTargetVideos += [PSCustomObject]@{ FullName = $vid.FullName; Name = $vid.Name; Duration = $info.Duration }
                            $fileTimeMap[$vid.FullName] = $info.LastWriteTimeTicks
                            if (-not $UsageCacheMap.ContainsKey($vid.FullName)) {
                                $newFiles += $vid.FullName
                            }
                        }
                    }
                    if ($validTargetVideos) { $subGroups["[快捷方式] $($lnk.Name)"] = $validTargetVideos }
                }
            }
            else {
                if (Test-Path $target) {
                    $fileItem = Get-Item $target
                    if ($fileItem.Extension -in '.mp4', '.mov', '.avi', '.mkv', '.m4v') {
                        if (-not (Test-ExcludePath -VideoFullPath $fileItem.FullName -ExcludePaths $excludePaths)) {
                            $info = Get-CachedVideoInfo -VideoPath $fileItem.FullName
                            if ($info.Valid) {
                                if (-not $subGroups.ContainsKey("(根目录)")) { $subGroups["(根目录)"] = @() }
                                $subGroups["(根目录)"] += [PSCustomObject]@{ FullName = $fileItem.FullName; Name = $fileItem.Name; Duration = $info.Duration }
                                $fileTimeMap[$fileItem.FullName] = $info.LastWriteTimeTicks
                                if (-not $UsageCacheMap.ContainsKey($fileItem.FullName)) {
                                    $newFiles += $fileItem.FullName
                                }
                            }
                        }
                    }
                }
            }
        }
        
        $allVideos = @()
        $subGroupList = @()
        foreach ($key in $subGroups.Keys) {
            $allVideos += $subGroups[$key]
            $subGroupList += $key
        }
        $allVideos = $allVideos | Sort-Object FullName -Unique
        
        if ($allVideos.Count -eq 0) {
            Write-Host "`n❌ 路径 $f 过滤后无任何合规视频（分辨率/时长不符合）" -ForegroundColor Red
            Write-Host "请修改TXT后重新拖入。" -ForegroundColor Yellow
            Remove-Item Env:REPLICA_TXT -ErrorAction SilentlyContinue
            & $PSCommandPath @args
            [Environment]::Exit(0)
        }
        
        if ($noSubRoundFolders.ContainsKey($f)) {
            $subGroups = @{ "全部" = $allVideos }
            $subGroupList = @( "全部" )
        }
        
        if ($subGroupList.Count -le 1) {
            Write-Host "$f ：$($allVideos.Count) 个视频" -ForegroundColor Green
        }
        else {
            Write-Host "$f ：$($allVideos.Count) 个视频，分为 $($subGroupList.Count) 个子组" -ForegroundColor Yellow
        }
        
        $folderVideos[$f] = [PSCustomObject]@{
            AllVideos      = $allVideos
            SubGroups      = $subGroups
            SubGroupList   = $subGroupList
            SubRound       = 1
            SubUsedInRound = @()
            SubUsageCount  = @{}
        }
        foreach ($g in $subGroupList) { $folderVideos[$f].SubUsageCount[$g] = 0 }
        
        $usageTracker[$f] = [PSCustomObject]@{
            Folder    = $f
            UsedCount = @{}
            RoundUsed = @()
            Round     = 1
        }
        foreach ($file in $allVideos) {
            $usageEntry = $UsageCacheMap[$file.FullName]
            $usageCount = if ($usageEntry) { $usageEntry.UsageCount } else { 0 }
            $usageTracker[$f].UsedCount[$file.FullName] = $usageCount
        }
    }
    
    # 设置生成数量
    $firstFolder = $sourceRequests[0]
    $defaultNum = $folderVideos[$firstFolder].AllVideos.Count
    Write-Host "`n设置生成数量" -ForegroundColor Cyan
    $totalOutput = 0
    if ($env:BATCH_COUNT -and $env:BATCH_COUNT -match '^\d+$' -and [int]$env:BATCH_COUNT -gt 0) {
        $totalOutput = [int]$env:BATCH_COUNT
        Write-Host "已通过 BATCH_COUNT 指定生成数量: $totalOutput" -ForegroundColor Green
    }
    else {
        Invoke-ErrorAction -ErrorMessage "未通过环境变量 BATCH_COUNT 指定生成数量（脚本由 Video Lab 驱动）" -ErrorStep "生成数量"
        [Environment]::Exit(1)
    }

    # 设置分组数（仅当生成数量 > 1 时）
    if ($totalOutput -gt 1) {
        Write-Host "`n设置分组数" -ForegroundColor Cyan
        $groupCount = 0
        if ($env:BATCH_GROUP -and $env:BATCH_GROUP -match '^\d+$') {
            $groupCount = [int]$env:BATCH_GROUP
            Write-Host "已通过 BATCH_GROUP 指定分组数: $groupCount" -ForegroundColor Green
        }
        else {
            Invoke-ErrorAction -ErrorMessage "未通过环境变量 BATCH_GROUP 指定分组数（脚本由 Video Lab 驱动）" -ErrorStep "分组数"
            [Environment]::Exit(1)
        }
    }
    else {
        $groupCount = 0
    }
    
    Write-Host "`n等待获取互斥锁，准备拼接..." -ForegroundColor Cyan
    $mutexName = "Global\VideoBatchMutex"
    $mutex = $null
    try {
        $mutex = [System.Threading.Mutex]::OpenExisting($mutexName)
    }
    catch { }
    if (-not $mutex) {
        $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    }
    $mutex.WaitOne() | Out-Null
    Write-Host "🔒 已获取互斥锁，开始执行拼接任务" -ForegroundColor Green
    
    try {
        # ---- 合并 video_cache ----
        if ($IsCacheUpdated) {
            $globalVideoCache = @{}
            if (Test-Path $cacheFile) {
                $globalVideoCache = Get-Content $cacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable
            }
            foreach ($key in $cache.Keys) {
                $globalVideoCache[$key] = $cache[$key]
            }
            $globalVideoCache | ConvertTo-Json -Compress | Set-Content $cacheFile -Encoding UTF8
        }
        
        # ---- 合并 usage_cache ----
        $globalUsageCache = @{}
        if (Test-Path $usageCacheFile) {
            $globalUsageCache = Get-Content $usageCacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        }
        foreach ($newFilePath in $newFiles) {
            if (-not $globalUsageCache.ContainsKey($newFilePath)) {
                $globalUsageCache[$newFilePath] = @{
                    UsageCount    = 0
                    LastWriteTime = (Get-Item -LiteralPath $newFilePath).LastWriteTimeUtc.Ticks
                }
            }
        }
        $globalUsageCache | ConvertTo-Json -Compress | Set-Content $usageCacheFile -Encoding UTF8
    
        # 更新内存中的 UsedCount
        $globalUsageCache = Get-Content $usageCacheFile -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        foreach ($f in $uniqueFolders) {
            $track = $usageTracker[$f]
            $trackKeys = @($track.UsedCount.Keys)
            foreach ($file in $trackKeys) {
                if ($globalUsageCache.ContainsKey($file)) {
                    $track.UsedCount[$file] = $globalUsageCache[$file].UsageCount
                }
            }
        }
        
        # ========== 创建输出目录 ==========
        Write-Host "`n创建输出目录" -ForegroundColor Cyan
        $monthDir = Split-Path -Path $outputRootDir -Parent
        if (-not (Test-Path $monthDir)) {
            New-Item -ItemType Directory -Path $monthDir -Force | Out-Null
        }
        if (-not (Test-Path $outputRootDir)) {
            New-Item -ItemType Directory -Path $outputRootDir -Force | Out-Null
        }

        $timeTag = (Get-TaskDate).ToString("MMdd-HH时mm分")
        $outDirName = "$timeTag-$txtName-成片"
        $outDir = Join-Path $outputRootDir $outDirName
        if (-not (Test-Path $outDir)) {
            New-Item -ItemType Directory -Path $outDir | Out-Null
            Write-Host "✅ 创建输出目录：$outDir" -ForegroundColor Green
        }
        $txtDestPath = Join-Path $outDir $txtFile.Name
        # 配置移入成片文件夹作为正本（移动而非复制，避免外部残留 * 重复配置）
        Move-Item -Path $txtFile.FullName -Destination $txtDestPath -Force
        
        $logFileName = "$timeTag-$txtName-拼接日志.txt"
        $logFilePath = Join-Path $outDir $logFileName
        Set-Content -Path $logFilePath -Value @() -Encoding UTF8
        
        Write-Host "`n开始批量生成（共 $totalOutput 个）" -ForegroundColor Cyan
        $datePrefix = (Get-TaskDate).ToString("yyMMdd")
        $parentFolder = Split-Path $baseDir -Leaf
        
        for ($outIndex = 1; $outIndex -le $totalOutput; $outIndex++) {
            Write-Host "`n------------------------------------------------" -ForegroundColor Cyan
            Write-Host "生成第 $outIndex / $totalOutput 个成片" -ForegroundColor Cyan
            
            $maxAllowedEstimate = $MaxTotalDurationSec * $SpeedThreshold
            $selectedParts = $null
            $updatePlans = @()
            $foundCombination = $false
            $failReason = $null   # 渐进替换提前中断时的具体原因（供失败提示输出）
            
            $firstPickVideo = $null   # 首段（第一个源）选取固定：重试时只调整后续片段，不影响开头的排列使用
            $retryExcluded = @{}  # 跨轮失败记忆：已试过且超时限的「源|视频路径」，下轮显式避开，避免重复随机
            # ── 渐进替换（方案A）：超限后不再整组重摇，只替换「时长最长的非首段源」为更短片段，其余源沿用上轮选择 ──
            $retryTargetSrc = -1    # 上轮超限指定的待替换源索引（-1=整组重建，仅首轮）
            # 用哈希表按 srcIdx 存（定长数组按下标写入越界会抛 IndexOutOfRangeException）
            $staleParts = @{}       # [srcIdx] 上轮每源 Video 对象（沿用基础）
            $stalePlans = @{}       # [srcIdx] 上轮每源 UpdatePlan
            $exhaustedSrcs = @{}    # 已无可换候选的源索引（快速失败/改试次长源）
            for ($retryCount = 0; $retryCount -lt $MaxRetry; $retryCount++) {
                $tempParts = @()
                $tempUpdatePlans = @()
                $totalDuration = 0
                $allValid = $true
                $failSrcIdx = -1

                $sourceExcludedSubGroups = @{}
                $sourceExcludedPaths = @{}
                $repeatPickCount = @{}
                $srcIdx = 0

                foreach ($srcPath in $sourceRequests) {
                    $track = $usageTracker[$srcPath]
                    $folderData = $folderVideos[$srcPath]

                    # 首段固定：只有第一个源在第一次尝试时选定，后续所有重试轮复用同一视频（srcIdx==0 是首段）
                    if ($retryCount -gt 0 -and $srcIdx -eq 0 -and $firstPickVideo) {
                        $tempParts += $firstPickVideo.Video
                        $totalDuration += $firstPickVideo.Video.Duration
                        $tempUpdatePlans += $firstPickVideo.UpdatePlan
                        $srcIdx++
                        continue
                    }

                    # 渐进沿用：非目标源且上轮已有该源选择 → 直接复用上轮结果（重复轮次只动目标源；
                    # 已耗尽源同样沿用上轮片段，仅不再作为替换目标，否则每轮都会在它身上重新失败）
                    if ($retryCount -gt 0 -and $retryTargetSrc -ne $srcIdx -and $staleParts[$srcIdx]) {
                        $tempParts += $staleParts[$srcIdx]
                        $totalDuration += $staleParts[$srcIdx].Duration
                        $tempUpdatePlans += $stalePlans[$srcIdx]
                        $srcIdx++
                        continue
                    }

                    $excludedSubs = @()
                    if ($sourceExcludedSubGroups.ContainsKey($srcPath)) {
                        $excludedSubs = $sourceExcludedSubGroups[$srcPath]
                    }
                    $excludedFiles = @()
                    if ($sourceExcludedPaths.ContainsKey($srcPath)) {
                        $excludedFiles = $sourceExcludedPaths[$srcPath]
                    }
                    # 跨轮失败记忆：合并入本轮排除（含首段固定时不用重复排除，只针对被重试的源）
                    if ($srcIdx -gt 0) {
                        $retryKey = $srcPath
                        if (-not $excludedFiles) { $excludedFiles = @() }
                        $excludedFiles = @($excludedFiles + @($retryExcluded.Keys | Where-Object { $_.StartsWith($retryKey + '|') } | ForEach-Object { $_.Substring($retryKey.Length + 1) }))
                    }

                    $isRepeat = $repeatPaths -contains $srcPath
                    if ($isRepeat) {
                        if (-not $repeatPickCount.ContainsKey($srcPath)) { $repeatPickCount[$srcPath] = 0 }
                        $pickSeq = $repeatPickCount[$srcPath] + 1
                    }
                    # 时长感知：重试轮/替换轮对非首段强制最短优先（原为第4轮起，提前收紧加速收敛）
                    $preferShort = $srcIdx -gt 0 -and $retryCount -gt 0
                    $result = Select-Video -Folder $srcPath -Track $track -FolderData $folderData -ExcludedPaths $excludedFiles -ExcludedSubGroups $excludedSubs -PreferShort:$preferShort
                    if (-not $result) {
                        $allValid = $false
                        $failSrcIdx = $srcIdx
                        break
                    }
                    if ($srcIdx -eq 0 -and -not $firstPickVideo) { $firstPickVideo = $result }  # 记录首段（含其 UpdatePlan，供重试轮复用）
                    $tempParts += $result.Video
                    $totalDuration += $result.Video.Duration
                    $tempUpdatePlans += $result.UpdatePlan

                    if ($isRepeat) {
                        $subGroupName = if ($result.UpdatePlan.SelectedGroup) { $result.UpdatePlan.SelectedGroup } else { "(根目录)" }
                        Write-Host "🔁 [重复源] 第 $pickSeq 次选取: $subGroupName\$($result.Video.Name)" -ForegroundColor Magenta
                        $repeatPickCount[$srcPath] = $pickSeq
                    }

                    if ($result.UpdatePlan.SelectedGroup) {
                        if (-not $sourceExcludedSubGroups.ContainsKey($srcPath)) { $sourceExcludedSubGroups[$srcPath] = @() }
                        $sourceExcludedSubGroups[$srcPath] += $result.UpdatePlan.SelectedGroup
                    }
                    if (-not $sourceExcludedPaths.ContainsKey($srcPath)) { $sourceExcludedPaths[$srcPath] = @() }
                    $sourceExcludedPaths[$srcPath] += $result.Video.FullName

                    $staleParts[$srcIdx] = $result.Video
                    $stalePlans[$srcIdx] = $result.UpdatePlan
                    $srcIdx++
                }

                if (-not $allValid) {
                    if ($retryCount -gt 0) {
                        # 目标源无可用候选：标记耗尽，改试「未耗尽中时长最长」的源继续渐进（静默，不逐轮刷日志）
                        # 该源从未选到片段（无沿用基础）说明确实无素材，替换其它源也补不齐，直接失败
                        if (-not $staleParts[$failSrcIdx]) { $failReason = "源「$(Split-Path $sourceRequests[$failSrcIdx] -Leaf)」无可用片段（无合规视频或候选已被排除）"; break }
                        $exhaustedSrcs[$failSrcIdx] = $true
                        $retryTargetSrc = -1
                        $maxDur = -1
                        for ($pi = 1; $pi -lt $sourceRequests.Count; $pi++) {
                            if ($exhaustedSrcs.ContainsKey($pi)) { continue }
                            # 本轮在此处中断时 tempParts 不完整，回退用上轮沿用基础评估时长，避免误判为「全部耗尽」
                            $dur = 0
                            if ($tempParts[$pi]) { $dur = $tempParts[$pi].Duration }
                            elseif ($staleParts[$pi]) { $dur = $staleParts[$pi].Duration }
                            if ($dur -gt $maxDur) { $maxDur = $dur; $retryTargetSrc = $pi }
                        }
                        if ($retryTargetSrc -lt 0) { $failReason = "所有源的可替换片段均已用尽（首段固定不参与替换）"; break }  # 所有源均已无可替换片段，交由下方统一失败处理
                        continue
                    }
                    continue  # 首轮失败：静默进入渐进替换
                }

                if ($totalDuration -le $maxAllowedEstimate) {
                    if ($totalDuration -le $MaxTotalDurationSec) {
                        # 时长校验通过：不再单独输出（具体时长另有输出，校验失败时也有独立失败行，避免重复）
                    }
                    else {
                        Write-Host "⚠️  预估时长 $totalDuration 秒 超过设定值但未超过阈值 $(($SpeedThreshold - 1) * 100)%，后续将加速处理" -ForegroundColor Yellow
                    }
                    # 重试过程静默，达标后仅汇总一次（避免每次重试都刷一行日志）
                    if ($retryCount -gt 0) {
                        Write-Host "⚠️  该成片经 $retryCount 轮渐进替换后达标（总时长 $totalDuration 秒）" -ForegroundColor Yellow
                    }
                    $selectedParts = $tempParts
                    $updatePlans = $tempUpdatePlans
                    $foundCombination = $true
                    break
                }
                else {
                    # 时长超限：记录失败记忆 + 存沿用基础 + 定下一轮目标源（非首段中最长，未耗尽）；逐轮过程静默
                    for ($pi = 1; $pi -lt $sourceRequests.Count; $pi++) {
                        if ($pi -lt $tempParts.Count) { $retryExcluded[[string]$sourceRequests[$pi] + '|' + $tempParts[$pi].FullName] = $true }
                        $staleParts[$pi] = $tempParts[$pi]
                        $stalePlans[$pi] = $tempUpdatePlans[$pi]
                    }
                    $retryTargetSrc = -1
                    $maxDur = -1
                    for ($pi = 1; $pi -lt $sourceRequests.Count; $pi++) {
                        if ($exhaustedSrcs.ContainsKey($pi)) { continue }
                        if ($tempParts[$pi] -and $tempParts[$pi].Duration -gt $maxDur) { $maxDur = $tempParts[$pi].Duration; $retryTargetSrc = $pi }
                    }
                    if ($retryTargetSrc -lt 0) { $failReason = "非首段源的可替换片段均已用尽，仍超出时长上限 $MaxTotalDurationSec 秒"; break }  # 所有候选均已尝试仍超时长，交由下方统一失败处理
                }
            }
            
            if (-not $foundCombination) {
                # 失败原因按实际中断点给出（提前中断时并非真的跑满 MaxRetry 轮，原提示易误导排查）；
                # 循环正常耗尽时 $retryCount 已自增到 MaxRetry，故取二者较小值作为实际轮数
                $rounds = [Math]::Min($retryCount + 1, [int]$MaxRetry)
                $failMsg = if ($failReason) { $failReason } else { "重试 $rounds 轮仍无法找到满足时长的组合（时长上限 $MaxTotalDurationSec 秒）" }
                Invoke-ErrorAction -ErrorMessage $failMsg -ErrorStep "第 $outIndex 个成片"
                continue
            }
            
            $currentParts = $selectedParts | ForEach-Object { $_.FullName }
            
            # 构造输出文件路径
            $nameItems = @($datePrefix, $ProducerName)
            # 前缀部分：TXT 名以设置前缀开头即带上（现有规则）；
            # 另增片段检测——本次成片任一片段完整路径（含文件夹）含有设置前缀串时，也按同一规则带上前缀
            $prefixPart = $txtNamePrefixPart
            if ([string]::IsNullOrEmpty($prefixPart) -and -not [string]::IsNullOrEmpty($TxtNamePrefix)) {
                foreach ($part in $selectedParts) {
                    if ($part.FullName.IndexOf($TxtNamePrefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $prefixPart = $TxtNamePrefix; break }
                }
            }
            if (-not [string]::IsNullOrEmpty($prefixPart)) { $nameItems += $prefixPart.TrimEnd("-") }
            $nameItems += $parentFolder
            $nameItems += $txtNameSuffix.TrimStart("-")
            $finalOutName = (($nameItems -join "-") -replace "-{2,}","-") + "-$SuffixMark$outIndex.mp4"
            $finalOut = Join-Path $outDir $finalOutName
            
            $allExist = $true
            foreach ($path in $currentParts) {
                if (-not (Test-Path $path)) {
                    Write-Host "⚠️  文件不存在：$path" -ForegroundColor Red
                    $allExist = $false
                }
            }
            if (-not $allExist) {
                Invoke-ErrorAction -ErrorMessage "部分输入文件不存在" -ErrorStep "第 $outIndex 个成片-文件检查"
                continue
            }
            
            $needSpeed = $false
            $speedRatio = 1.0
            if ($totalDuration -gt $MaxTotalDurationSec -and $totalDuration -le $MaxTotalDurationSec * $SpeedThreshold) {
                $needSpeed = $true
                $speedRatio = $totalDuration / $MaxTotalDurationSec
                if ($speedRatio -gt 2.0) { $speedRatio = 2.0 }
            }
            
            $inputArgs = @()
            foreach ($path in $currentParts) {
                $inputArgs += "-i"
                $inputArgs += "`"$path`""
            }
            $inputArgs += "-i"
            $inputArgs += "`"$watermark`""
            
            $n = $currentParts.Count
            if ($n -eq 0) {
                Invoke-ErrorAction -ErrorMessage "无有效视频片段" -ErrorStep "第 $outIndex 个成片-片段数检查"
                continue
            }
            
            $concatInputs = ""
            for ($i = 0; $i -lt $n; $i++) {
                $concatInputs += "[${i}:v][${i}:a]"
            }
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
            
            $allArgs = $inputArgs + $encArgs
            $targetDur = if ($totalDuration -gt $MaxTotalDurationSec) { $MaxTotalDurationSec } else { $totalDuration }
            Write-Output ("成片预计时长: " + [math]::Round($targetDur, 2) + " 秒")
            $code = Invoke-FFmpegWithProgress $allArgs
            
            if ($code -ne 0) {
                Invoke-ErrorAction -ErrorMessage "一次性编码失败" -ErrorStep "第 $outIndex 个成片"
                continue
            }
            
            # ========== 编码成功，应用状态更新 ==========
            $planGroups = @{}
                foreach ($plan in $updatePlans) {
                    $f = $plan.Folder
                    if (-not $planGroups.ContainsKey($f)) { $planGroups[$f] = @() }
                    $planGroups[$f] += $plan
                }
                foreach ($f in $planGroups.Keys) {
                    $plans = $planGroups[$f]
                    $track = $usageTracker[$f]
                    $folderData = $folderVideos[$f]
                    
                    $maxRound = $track.Round
                    $maxSubRound = $folderData.SubRound
                    $mergedRoundUsed = $track.RoundUsed.Clone()
                    $mergedSubUsed = $folderData.SubUsedInRound.Clone()
                    $subUsageIncrements = @{}
                    
                    foreach ($plan in $plans) {
                        if ($plan.NewRound -gt $maxRound) { $maxRound = $plan.NewRound }
                        if ($plan.NewSubRound -gt $maxSubRound) { $maxSubRound = $plan.NewSubRound }
                        foreach ($path in $plan.NewRoundUsed) {
                            if ($path -notin $mergedRoundUsed) { $mergedRoundUsed += $path }
                        }
                        foreach ($group in $plan.NewSubUsedInRound) {
                            if ($group -notin $mergedSubUsed) { $mergedSubUsed += $group }
                        }
                        if ($plan.IncrementSubUsage) {
                            $subUsageIncrements[$plan.IncrementSubUsage] = ($subUsageIncrements[$plan.IncrementSubUsage] + 1)
                        }
                    }
                    
                    $track.Round = $maxRound
                    $track.RoundUsed = $mergedRoundUsed
                    $folderData.SubRound = $maxSubRound
                    $folderData.SubUsedInRound = $mergedSubUsed
                    foreach ($group in $subUsageIncrements.Keys) {
                        $folderData.SubUsageCount[$group] += $subUsageIncrements[$group]
                    }
                }

                for ($i = 0; $i -lt $selectedParts.Count; $i++) {
                    $video = $selectedParts[$i]
                    $plan = $updatePlans[$i]
                    $f = $plan.Folder
                    $track = $usageTracker[$f]
                    $track.UsedCount[$video.FullName]++
                    if ($video.FullName -notin $track.RoundUsed) {
                        $track.RoundUsed += $video.FullName
                    }
                }

                $increments = @{}
                foreach ($video in $selectedParts) {
                    $path = $video.FullName
                    $increments[$path] = ($increments[$path] + 1)
                }
                Export-UsageCache -Increments $increments -UsageCacheFile $usageCacheFile
            
            $finalDuration = Get-CachedVideoInfo -VideoPath $finalOut | Select-Object -ExpandProperty Duration
            if ($needSpeed) {
                Write-Host "✅ 成片完成，时长：$finalDuration 秒 (加速倍率 $([math]::Round($speedRatio, 3))x)" -ForegroundColor Green
            }
            else {
                Write-Host "✅ 成片完成，时长：$finalDuration 秒" -ForegroundColor Green
            }
            
            # 写日志
            # 分组重命名随单个成片即时完成：生成即按分组定名（不再等全部完成后整目录分组）
            if ($groupCount -gt 0 -and $totalOutput -gt 1) {
                $groupSize = [math]::Floor($totalOutput / $groupCount)
                $remainder = $totalOutput % $groupCount
                $startIdx = 1
                $groupSuffix = ''
                for ($g = 0; $g -lt $groupCount; $g++) {
                    $size = $groupSize
                    if ($g -lt $remainder) { $size++ }
                    if ($outIndex -ge $startIdx -and $outIndex -lt ($startIdx + $size)) {
                        $groupSuffix = [string][char](65 + $g)
                        break
                    }
                    $startIdx += $size
                }
                if ($groupSuffix -ne '' -and (Test-Path $finalOut)) {
                    $finalBase = [System.IO.Path]::GetFileNameWithoutExtension($finalOut)
                    $finalExt  = [System.IO.Path]::GetExtension($finalOut)
                    $renamedPath = Join-Path $outDir ($finalBase + $groupSuffix + $finalExt)
                    if (-not (Test-Path $renamedPath)) {
                        Rename-Item -Path $finalOut -NewName ($finalBase + $groupSuffix + $finalExt) -ErrorAction SilentlyContinue
                        $finalOut = $renamedPath
                    }
                }
            }
            $logOutName = [System.IO.Path]::GetFileName($finalOut)
                $logContent = @(
                    $logOutName,
                    "使用片段列表：",
                    $currentParts,
                    "",
                    $watermark
                )
                if ($outIndex -lt $totalOutput) {
                    $logContent += ("=" * 46)
                }
                $logContent | Out-File -Path $logFilePath -Encoding UTF8 -Append
        }
        
        # 生成报告（缓存使用情况）
        $reportFile = Join-Path $scriptCacheDir "usage_report.txt"
        Export-UsageReport -UsageCacheFile $usageCacheFile -ReportFile $reportFile
        
        Write-Host "`n================================================" -ForegroundColor Green
        
    }
    finally {
        if ($mutex) {
            $mutex.ReleaseMutex()
            $mutex.Dispose()
            Write-Host "🔓 互斥锁已释放" -ForegroundColor DarkGray
        }
    }
    
}
catch {
    if ($env:REPLICA_NO_WAIT -eq '1') {
        Write-Host "`n================ 全局异常 ================" -ForegroundColor Red
        Write-Host $_.Exception.ToString() -ForegroundColor Red
        if ($_.Exception.InnerException) { Write-Host $_.Exception.InnerException.ToString() -ForegroundColor Red }
        Write-Host "==========================================`n" -ForegroundColor Red
        if ($mutex) {
            try { $mutex.ReleaseMutex() } catch {}
            try { $mutex.Dispose() } catch {}
        }
        [Environment]::Exit(1)
    }
    Invoke-ErrorAction -ErrorMessage $_.Exception.Message -ErrorStep "全局异常"
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        try { $mutex.Dispose() } catch {}
    }
}

if ($Script:HasError) {
    Write-Host "`n脚本执行完成（有错误）" -ForegroundColor Yellow
    [Environment]::Exit(1)
}
else {
    Write-Host "`n任务全部完成" -ForegroundColor Green
}
[Environment]::Exit(0)
