# 碧蓝幻想本地缓存程序 — 托盘启动器
#
# 由「启动程序.vbs」以隐藏窗口方式调用，因此不会出现黑色命令行框。
# 职责：
#   1. 后台隐藏启动 Node 缓存服务
#   2. 在系统托盘放一个图标，提供菜单入口
#   3. 关掉控制台窗口不影响服务，托盘图标继续保留
#   4. 托盘菜单「退出」才真正停止服务
#
# 本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会按 ANSI 解析，
# 脚本里的中文会变乱码并可能导致语法错误。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 用于「找到已存在的控制台窗口并切到前面」，避免重复开窗
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinApi {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr h);

    public static IntPtr FindByTitle(string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            if (sb.ToString() == title) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$Dir      = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeJs   = Join-Path $Dir 'server.js'
$IconOn   = Join-Path $Dir 'icon.ico'
$IconOff  = Join-Path $Dir 'icon-off.ico'
$LogFile  = Join-Path $Dir 'logs\server.log'
$TrayLog  = Join-Path $Dir 'logs\tray.log'
$Port     = 8799
$BaseUrl  = "http://127.0.0.1:$Port/"
$WinTitle = '碧蓝幻想本地缓存程序'
# 悬浮监控窗（V4.14.0）：无边框、不占任务栏的圆角条，六格显示关键计数。
# 尺寸与方向**不写死在这里** —— 基准尺寸、上下限、比例锁定都在下面「悬浮监控窗」那一段里
# （$script:FcBase / Get-FcBox），要改形状只改那一处。
$FloatTitle = '碧蓝幻想缓存监控'

function Trace([string]$m) {
    try {
        $d = Split-Path $TrayLog
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
        Add-Content -Path $TrayLog -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
    } catch { }
}

Trace "=== 托盘启动器开始运行 ==="

try {
    # ------------------------------------------------------------ 单实例

    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, 'Local\GBF_Local_Cache_Tray', [ref]$createdNew)
    if (-not $createdNew) {
        # 已有实例：把它的控制台窗口切到前面，而不是报错
        $h = [WinApi]::FindByTitle($WinTitle)
        if ($h -ne [IntPtr]::Zero) { [void][WinApi]::ShowWindow($h, 9); [void][WinApi]::SetForegroundWindow($h) }
        exit 0
    }

    # ------------------------------------------------------------ 环境探测

    function Find-Node {
        $cand = @()
        $c = Get-Command node -ErrorAction SilentlyContinue
        if ($c) { $cand += $c.Source }
        $cand += 'H:\DevTools\nodejs\node-v24.21.0-win-x64\node.exe'
        foreach ($p in $cand) { if ($p -and (Test-Path $p)) { return $p } }
        return $null
    }

    function Find-Edge {
        $cand = @(
            "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
            "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
            "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
        )
        foreach ($p in $cand) { if ($p -and (Test-Path $p)) { return $p } }
        return $null
    }

    $NodeExe = Find-Node
    $EdgeExe = Find-Edge
    Trace "Node = $NodeExe | Edge = $EdgeExe"

    # V4.18.2：重启中转用的两条小料（Restart-Server 用）——
    #   · $ServerStartCmd：交给独立中转进程执行的启动命令（字符串，独立于本进程存活）；
    #   · $RestartPidFile：中转进程把新服务的 pid 写进去，重启后本进程据此捡回句柄。
    $ServerStartCmd = "Start-Process -FilePath '$NodeExe' -ArgumentList 'server.js' -WorkingDirectory '$Dir' -WindowStyle Hidden -PassThru"
    $RestartPidFile = Join-Path (Split-Path $TrayLog) 'restart.pid'

    if (-not $NodeExe) {
        [System.Windows.Forms.MessageBox]::Show(
            "没有找到 Node.js，无法启动缓存服务。", '碧蓝幻想本地缓存程序', 'OK', 'Error') | Out-Null
        exit 1
    }

    # ------------------------------------------------------------ 服务控制

    $script:Proc = $null

    function Test-Server {
        try {
            $r = Invoke-WebRequest -Uri ($BaseUrl + 'api/stats') -TimeoutSec 4 -UseBasicParsing
            return ($r.StatusCode -eq 200)
        } catch { return $false }
    }

    function Start-Server {
        if (Test-Server) { return $true }
        try {
            # 关键：告诉服务「不要自己弹控制台窗口」。
            # 弹窗口由本托盘程序统一负责，否则一次启动会出现两个窗口，
            # 而「重启服务」会让旧窗口留着、再叠一个新窗口。
            $env:GBFCACHE_OPEN_UI = '0'
            $script:Proc = Start-Process -FilePath $NodeExe -ArgumentList 'server.js' `
                -WorkingDirectory $Dir -WindowStyle Hidden -PassThru
            Trace "已启动 node，pid=$($script:Proc.Id)（已禁用其自动弹窗）"
        } catch {
            Trace "启动 node 异常: $($_.Exception.Message)"
            return $false
        }
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 250
            if (Test-Server) { Trace "服务已就绪"; return $true }
        }
        Trace "服务启动超时"
        return $false
    }

    function Stop-Server {
        # 先请求优雅退出：服务在自己的退出钩子里会把系统「自动配置脚本」还原回去
        # （不还原的话，退出后浏览器仍走本程序的 PAC，加速器会一直失效）。
        # 只有超时没退出才强杀 —— 强杀会跳过还原。
        try { Invoke-WebRequest -Uri ($BaseUrl + 'api/shutdown') -TimeoutSec 3 -UseBasicParsing | Out-Null } catch {}
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Milliseconds 250
            if ($script:Proc -and $script:Proc.HasExited) { break }
            if (-not $script:Proc -and -not (Test-Server)) { break }
        }
        if ($script:Proc -and -not $script:Proc.HasExited) {
            Trace "服务未在超时内退出，强制结束（系统代理可能未还原）"
            try { Stop-Process -Id $script:Proc.Id -Force } catch {}
        }
        $script:Proc = $null
        Trace "服务已停止"
    }

    function Get-AutoLaunchGame {
        try {
            $cfg = Get-Content (Join-Path $Dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $cfg.autoLaunchGame) { return [bool]$cfg.autoLaunchGame }
        } catch {}
        return $true   # 没写这个字段时默认开启
    }

    function Get-OpenDashboardOnStart {
        # 设置面板「启动后打开控制台」（V4.15.2）：config.json openDashboardOnStart，缺省开
        try {
            $cfg = Get-Content (Join-Path $Dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $cfg.openDashboardOnStart) { return [bool]$cfg.openDashboardOnStart }
        } catch {}
        return $true
    }

    function Get-AutoLaunchAccel {
        try {
            $cfg = Get-Content (Join-Path $Dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $cfg.autoLaunchAccel) { return [bool]$cfg.autoLaunchAccel }
        } catch {}
        return $true   # 没写这个字段时默认开启
    }

    function Get-AcceleratorPath {
        try {
            $cfg = Get-Content (Join-Path $Dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($cfg.acceleratorPath) { return [string]$cfg.acceleratorPath }
        } catch {}
        return ''   # 未配置就是未配置 —— 不内置任何软件路径（在控制台⚙里选择）
    }
    # ------------------------------------------------------------ 界面动作

    function Open-Dashboard {
        # 已经开着一个控制台窗口就切到前面，不重复开新窗口
        $h = [WinApi]::FindByTitle($WinTitle)
        if ($h -ne [IntPtr]::Zero) {
            if ([WinApi]::IsIconic($h)) { [void][WinApi]::ShowWindow($h, 9) }   # SW_RESTORE
            [void][WinApi]::SetForegroundWindow($h)
            Trace "控制台窗口已存在，切到前台"
            return
        }
        if (-not (Test-Server)) { Start-Server | Out-Null }
        if ($EdgeExe) {
            Start-Process -FilePath $EdgeExe -ArgumentList @("--app=$BaseUrl")
            Trace "已打开新的控制台窗口"
        } else {
            Start-Process $BaseUrl
        }
    }

    function Open-SelfTest {
        if (-not (Test-Server)) { Start-Server | Out-Null }
        Start-Process ($BaseUrl + 'test')
    }

    function Open-CacheDir {
        $p = Join-Path (Split-Path -Parent $Dir) 'cache\gbf'
        if (Test-Path $p) { Start-Process explorer.exe $p }
        else { Start-Process explorer.exe (Split-Path -Parent $Dir) }
    }

    function Open-LogFile {
        if (Test-Path $LogFile) { Start-Process notepad.exe $LogFile }
        else {
            [System.Windows.Forms.MessageBox]::Show('还没有日志文件。',
                '碧蓝幻想本地缓存程序', 'OK', 'Information') | Out-Null
        }
    }

    function Restart-Server {
        # 只重启后台服务，不开新窗口。
        Trace "重启服务（不开新窗口）"
        # 整段包在 try 里（V4.18.3）：WinForms 点击回调里一旦有未捕获异常，处理流程会**静默中止**
        # —— V4.18.2 就因一条构造语句抛错而"点了报错/没反应"，日志里一个字都没有。
        # 现在任何异常都留痕，且构造失败=什么都不做（服务保持原样），不会误停服务。
        try {
            # 先托付、后停服 —— 与托盘自身的存活解耦（V4.18.2 实测：旧顺序"先停后起"一旦
            # 扑空就表现为"重启=退出"）。两条纪律（V4.18.2/V4.18.3 各凭一次实测换来）：
            #   ① 中转命令**必须拼接构造，禁用 -f 格式化**——命令体里有 { } 花括号，
            #      -f 会把它们当占位符直接抛 FormatException；
            #   ② 探测"端口是否还有人听"用裸 TCP（Net.Sockets.TcpClient）——Invoke-WebRequest
            #      会走系统代理（PAC 就指向本服务），服务一停连 PAC 都取不到，每次探测卡几秒。
            # GBFCACHE_NO_TRAY：发行版 launcher 认它 → 新服务不再叠一个新托盘。
            $env:GBFCACHE_NO_TRAY = '1'
            $inner = "for(`$i=0; `$i -lt 240; `$i++) { Start-Sleep -Milliseconds 250; `$c = New-Object Net.Sockets.TcpClient; `$open = `$false; try { `$open = `$c.ConnectAsync('127.0.0.1', " + $Port + ").Wait(800) } catch { }; `$c.Close(); if (-not `$open) { break } }; Start-Sleep -Milliseconds 600; `$p = " + $ServerStartCmd + "; Set-Content -Path '" + $RestartPidFile + "' -Value `$p.Id -Encoding ASCII"
            $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
            Start-Process powershell.exe -ArgumentList ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + $enc) -WindowStyle Hidden | Out-Null
            Trace "已托付重启中转进程（等端口释放后拉起新服务）"
            Stop-Server
            for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; if (Test-Server) { break } }
            if (-not (Test-Server)) {
                Trace "中转进程 30 秒内没把服务拉起来，就地兜底一次"
                Start-Server | Out-Null
            }
            # 把新服务的进程句柄捡回来（中转进程写下的 pid）—— 之后的"退出 / 再次重启"强杀路径要用
            try {
                $pidLine = Get-Content -Path $RestartPidFile -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($pidLine) { $script:Proc = Get-Process -Id ([int]$pidLine) -ErrorAction SilentlyContinue }
            } catch { }
            if (Test-Server) { Trace "服务已重启" } else { Trace "重启后探测仍失败（见中转进程）" }
        } catch {
            Trace ("重启服务异常（服务保持原样）：" + $_.Exception.Message)
        }
    }

    # ==== 悬浮监控窗（V4.14.0）· 本段必须与另一份 tray.ps1（plugin\ 与 exe-dist\ 各一份）====
    # ==== 逐字一致 —— 自测会把两段切出来比对，不一致就红。                          ====
    # ==== BEGIN =====================================================================
    #
    # 关掉控制台窗口后，在屏幕右上角浮一个**圆角条**，七格显示
    # 命中 / 回源 / 新写入 / 拦截 / 错误 / 命中率 / 回源速率。（第 7 格 V4.14.12 加）
    #
    # 【为什么做在托盘进程里】托盘本身就是常驻的 PowerShell + WinForms 程序（有消息循环），
    # 加一个 Form 就行：无新进程、无浏览器、无新产物。更关键的是 ——
    # **显隐就是同一个进程里的 Show()/Hide()**，不需要按窗口标题找窗口、也不需要发 WM_CLOSE。
    # V4.13.0 那版是"跨进程管可见性"：用户点窗口关闭，托盘下一次对齐又把它开回来，
    # 表现为"永远关不掉"。改成现在这样，那类问题在结构上不可能再发生。
    #
    # 【"该不该显示"由服务端说】本段只把窗口显隐对齐到 /api/float-state 的 show；
    # 判定（控制台在不在、宽限期、用户开关、手动钦定）只在 server.js 里有一份。
    # 用户主动收起时调 /api/float-toggle，让服务端把 manual 钉成 false —— 就不会再被弹回来。
    #
    # 【形状归本段自己管（V4.14.0 起）】
    #   · 方向：'h' 横排（六个并排的列）/ 'v' 竖排（六行）—— 条上右端（竖排时是底端）
    #     那个双箭头按钮切换；右键菜单里也有一份。
    #   · 大小：**只能拖右下角那个角标**（V4.14.3 起），**比例锁定**（只改倍率、不改形状，
    #     数字永远不会被拉变形）。为什么砍掉其它三个角/四条边：那三处拉大小时**窗口原点也要动**
    #     （锚点在对角），移动 + 改尺寸 + 换 Region 挤在同一帧里，真机上就是一片闪 ——
    #     右下角原点不动，实测不闪。角标以外的地方一律是"拖动整条"。
    #     比例锁定的唯一出口是 Get-FcBox —— 拖拽 / 切方向 / 重置 / 读配置都绕不过它，
    #     所以不存在"哪条路径忘了按比例"这回事。
    #   · 上下限：$script:FcMinScale / $script:FcMaxScale，另外还受"屏幕装得下"约束：
    #     拖不出屏幕、也拖不到看不见；拖花了用托盘（或右键）菜单的「重置悬浮窗大小与方向」回默认。
    #   · 方向与倍率存在程序目录的 float-win.json，重开程序还是这个样子（位置不存，
    #     每次开局都从右上角默认位开始，永远找得到）。
    #
    # 【样式照控制台】色值取自控制台 dashboard.html 的同一套（--panel/--line/--ok/…）；
    # 每格左边那条 3px 色块就是控制台指标卡 .metric:before 的做法。改样式时对一眼那边。

    $FcColor = @{
        Panel = '#161b22'; Line = '#262d38'; Fg = '#e6edf3'; Dim = '#8b949e'
        Ok = '#3fb950'; Warn = '#d29922'; Err = '#f85149'; Info = '#58a6ff'; Store = '#a371f7'
    }
    $script:FcRadius = 10          # 圆角半径（控制台卡片是 10px）；实际值还会跟着倍率走
    $script:FcCells = @(
        @{ Key = 'hit';     Label = '缓存命中';   Bar = 'Ok'    }
        @{ Key = 'miss';    Label = '回源下载';   Bar = 'Info'  }
        @{ Key = 'stored';  Label = '新写入缓存'; Bar = 'Store' }
        @{ Key = 'dynamic'; Label = '异常拦截';   Bar = 'Warn'  }
        @{ Key = 'error';   Label = '错误';       Bar = 'Err'   }
        @{ Key = 'hitRate'; Label = '命中率';     Bar = 'Ok'    }
        @{ Key = 'rate';    Label = '回源速率';   Bar = 'Info'  }
    )
    $script:FcData  = @{ hit = '-'; miss = '-'; stored = '-'; dynamic = '-'; error = '-'; hitRate = '-'; rate = '-' }
    $script:FcDataSig = ''           # 上一帧显示内容的签名（只在签名变了才重绘，见 Sync-FloatStrip）
    $script:FcStrip = $null
    $script:FcDrag  = $null          # 拖动整条时的起点（$null = 没在拖）
    $script:FcResize = $null         # 拖大小时的会话状态（$null = 没在拖）
    $script:FcHoverBtn = $false      # 鼠标是不是停在换方向按钮上（只影响画出来的高亮）
    $script:FcCursorKey = ''         # 上一次设过的光标种类（避免每帧都重设 Cursor）
    $script:FcShuttingDown = $false  # 置 true 时放行窗口关闭（只给托盘退出用，见 FormClosing）
    $script:PacBypass = $false       # 临时直连状态（V4.14.9，由 /api/float-state 的 bypass 刷新菜单文字）
    $script:PrewarmSig = ''          # 上一轮预热的 key（V4.14.11，气泡只在 key 变化时弹）
    $script:PrewarmActive = $false   # 预热进行中（用于"从真翻假"弹完成气泡）

    # ---- 形状参数（尺寸/比例的纯函数；自测会把这一段整段切出来在 PowerShell 里单独跑）----
    # ---- BEGIN ----
    $script:FcBase = @{
        h = @{ W = 700; H = 54 }    # 横：细长条（七个指标并排，每格 100px）
        v = @{ W = 100; H = 385 }   # 竖：细高条（七个指标竖着叠，每行 55px；V4.14.12 从 330 加高容纳第 7 格）
        # 竖排宽度 V4.14.2 收窄过：原来 200 时文字只占左边一半、右侧空一大片（用户反馈"过宽"），
        # 减半到 100 —— 标签最长"新写入缓存"（8.5pt×5 字 ≈ 57px）+ 左缩进 9px 仍在格宽内，
        # 数字（Consolas Bold 14pt）最长 7 位 ≈ 72px 也放得下；最小倍率 0.75 时同样验算过。
    }
    $script:FcMinScale = 0.75       # 最小倍率：再小数字就看不清了（这就是"拖不到看不见"）
    $script:FcMaxScale = 2.2        # 最大倍率：再大就成一块板，挡游戏
    $script:FcFitRatio = 0.95       # 另外还受"屏幕装得下"约束：不超过工作区的这个比例
    $script:FcBtnSize  = 24         # 换方向按钮占的边长（横排贴右端 / 竖排贴底端）
    $script:FcGrip     = 16         # 右下角"角标"的边长：**唯一**能拉大小的地方（V4.14.3 起）

    function Get-FcBase([string]$Orient) {
        # 认不出来的方向一律按横排 —— 配置文件被改坏了也不能让窗口消失
        if ($Orient -eq 'v') { return $script:FcBase.v }
        return $script:FcBase.h
    }

    function Get-FcScaleRange([string]$Orient, [int]$AvailW = 0, [int]$AvailH = 0) {
        # 上限 = min(配置上限, 屏幕装得下)；下限永远不超过上限
        #（屏幕特别小时宁可突破 0.75 的下限，也要保证显示得出来，而不是画到屏幕外）
        $b = Get-FcBase $Orient
        if ($AvailW -le 0 -or $AvailH -le 0) {
            try {
                $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
                $AvailW = $wa.Width; $AvailH = $wa.Height
            } catch { $AvailW = 1920; $AvailH = 1080 }
        }
        $fit = [Math]::Min(($AvailW * $script:FcFitRatio) / $b.W, ($AvailH * $script:FcFitRatio) / $b.H)
        $max = [Math]::Min([double]$script:FcMaxScale, [double]$fit)
        $min = [Math]::Min([double]$script:FcMinScale, [double]$max)
        return @{ Min = $min; Max = $max }
    }

    function Get-FcScaleFor([string]$Orient, [double]$RawW, [double]$RawH) {
        # 拖出来的尺寸 → 倍率。取"更外扩"的那一维：本条的横竖比都很极端
        #（横 11:1、竖 1:1.65），若按对角线投影算，拖短边那侧几乎不动 —— 而用户就是会去拖那条边。
        $b = Get-FcBase $Orient
        # 拖过头了（把手拖到锚点另一侧，尺寸会算成负数）：回到**最小**，而不是弹回基准大小 ——
        # 否则「往小里拖到底」会忽然变回 1.0 倍，用起来像卡了一下（下限由 Get-FcBox 兜）。
        if ($RawW -le 0 -or $RawH -le 0) { return 0.0 }
        return [Math]::Max($RawW / $b.W, $RawH / $b.H)
    }

    function Get-FcBox([string]$Orient, [double]$Scale, [int]$AvailW = 0, [int]$AvailH = 0) {
        # **比例锁定的唯一出口**：拖拽 / 切方向 / 重置 / 读配置全都从这里拿尺寸，
        # 所以形状永远等于基准形状 —— 不存在"哪一条路径忘了按比例"的可能。
        $lim = Get-FcScaleRange $Orient $AvailW $AvailH
        $s = [Math]::Max($lim.Min, [Math]::Min($lim.Max, [double]$Scale))
        $b = Get-FcBase $Orient
        return @{
            W     = [int][Math]::Round($b.W * $s)
            H     = [int][Math]::Round($b.H * $s)
            Scale = [double]$s
        }
    }
    # ---- 形状参数 END ---------------------------------------------------------

    # ---- 方向与倍率的持久化（float-win.json；读不到/读坏了都退回默认，绝不让窗口消失）----
    $script:FcOrient = 'h'           # 'h' = 横（默认）  'v' = 竖
    $script:FcScale  = 1.0           # 倍率（1.0 = 基准尺寸）；像素一律由 Get-FcBox 算
    $script:FcStateFile = Join-Path $Dir 'float-win.json'

    function Get-FcOrientName { if ($script:FcOrient -eq 'v') { return '竖向' } return '横向' }
    function Get-FcOrientMenuText { if ($script:FcOrient -eq 'v') { return '悬浮窗改为横向' } return '悬浮窗改为竖向' }

    function Read-FcLayout {
        try {
            $j = Get-Content $script:FcStateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $script:FcOrient = $(if ([string]$j.orient -eq 'v') { 'v' } else { 'h' })
            if ($null -ne $j.scale) { $script:FcScale = [double]$j.scale }
        } catch {
            $script:FcOrient = 'h'
            $script:FcScale = 1.0
        }
    }

    function Save-FcLayout {
        # 只存"形状"（方向 + 倍率），不存位置：位置每次开局都从右上角默认位来，永远找得到。
        # 倍率用不变文化格式化 —— 免得在"逗号当小数点"的区域设置下写出读不回来的 "1,2"。
        try {
            $s = ([Math]::Round([double]$script:FcScale, 3)).ToString([System.Globalization.CultureInfo]::InvariantCulture)
            $t = '{"orient":"' + $script:FcOrient + '","scale":' + $s + '}'
            [System.IO.File]::WriteAllText($script:FcStateFile, $t, (New-Object System.Text.UTF8Encoding($false)))
        } catch { Trace ("悬浮窗形状没存上: " + $_.Exception.Message) }
    }

    # GDI+ 对象建一次就复用：每次重绘都新建 Brush/Pen/Font 会一直堆到 GC，长跑不划算
    $script:FcBrush = @{}
    foreach ($k in $FcColor.Keys) {
        $script:FcBrush[$k] = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($FcColor[$k]))
    }
    $script:FcPenLine   = New-Object System.Drawing.Pen($script:FcBrush.Line.Color, 1)
    $script:FcPenIcon   = New-Object System.Drawing.Pen($script:FcBrush.Dim.Color, [single]1.3)
    $script:FcPenIconHi = New-Object System.Drawing.Pen($script:FcBrush.Fg.Color, [single]1.3)
    $script:FcFontK = $null
    $script:FcFontV = $null
    $script:FcFontScale = -1

    function Sync-FcFonts([double]$Scale) {
        # 字号跟着倍率走（这才是"按比例缩放"该有的样子）；同倍率只建一次 ——
        # 拖拽时每帧都 new 一个 Font，会一直堆到 GC 才回收。
        $s = [Math]::Round([double]$Scale, 2)
        if ($s -eq $script:FcFontScale) { return }
        $nk = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](8.5 * $s))
        $nv = New-Object System.Drawing.Font('Consolas', [single](14 * $s), [System.Drawing.FontStyle]::Bold)
        if ($script:FcFontK) { $script:FcFontK.Dispose() }
        if ($script:FcFontV) { $script:FcFontV.Dispose() }
        $script:FcFontK = $nk
        $script:FcFontV = $nv
        $script:FcFontScale = $s
    }

    function Get-FcRadius([int]$w, [int]$h, [double]$Scale) {
        # 圆角也跟着倍率走，但不能超过短边的一半（超了 AddArc 就画不出圆角，会变成尖角）
        return [int][Math]::Max(4, [Math]::Min($script:FcRadius * $Scale, [Math]::Min($w, $h) / 2.0))
    }

    function Get-RoundedPath([int]$w, [int]$h, [int]$r) {
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = $r * 2
        $p.AddArc(0, 0, $d, $d, 180, 90)
        $p.AddArc(($w - $d - 1), 0, $d, $d, 270, 90)
        $p.AddArc(($w - $d - 1), ($h - $d - 1), $d, $d, 0, 90)
        $p.AddArc(0, ($h - $d - 1), $d, $d, 90, 90)
        $p.CloseFigure()
        return $p
    }

    # ---- 几何：内容区 / 按钮区 / 角标判定（画的时候和点的时候都只认这几个函数，不会各算一套）----
    function Get-FcButtonRect([int]$w, [int]$h) {
        # 换方向按钮：横排贴右端、竖排贴底端 —— 两处都离数字最远，不挡读数
        $s = [int][Math]::Round($script:FcBtnSize * $script:FcScale)
        if ($script:FcOrient -eq 'v') { return @{ X = 1; Y = ($h - 1 - $s); W = ($w - 2); H = $s } }
        return @{ X = ($w - 1 - $s); Y = 1; W = $s; H = ($h - 2) }
    }

    function Get-FcBodyRect([int]$w, [int]$h) {
        # 七个格子能用的那块 = 整条减去按钮区
        $b = Get-FcButtonRect $w $h
        if ($script:FcOrient -eq 'v') { return @{ X = 1; Y = 1; W = ($w - 2); H = ($b.Y - 1) } }
        return @{ X = 1; Y = 1; W = ($b.X - 1); H = ($h - 2) }
    }

    function Get-FcGripRect([int]$w, [int]$h) {
        # 右下角的"角标"（V4.14.3）：**唯一**能拉大小的地方。画（角标那三道斜线）与点
        # （Get-FcZone）都只认这一个矩形 —— 与"画和点共用同一份几何"是同一条规矩。
        $g = [int][Math]::Max(10, [Math]::Round($script:FcGrip * $script:FcScale))
        return @{ X = ($w - 1 - $g); Y = ($h - 1 - $g); W = $g; H = $g }
    }

    function Test-FcInButton([int]$x, [int]$y, [int]$w, [int]$h) {
        # 角标**优先**：它与按钮在右下角是重叠的（竖排的按钮就是底部那一整条），
        # 重叠处判为"拉大小" —— 否则角标点不着，等于拉大小没法用。
        if (Get-FcZone $x $y $w $h) { return $false }
        $b = Get-FcButtonRect $w $h
        return ($x -ge $b.X -and $x -lt ($b.X + $b.W) -and $y -ge $b.Y -and $y -lt ($b.Y + $b.H))
    }

    function Get-FcZone([int]$x, [int]$y, [int]$w, [int]$h) {
        # 拉大小：**只有右下角的角标**（V4.14.3）；其余任何位置都返回 $null = 拖动整条。
        # 返回值是"拖的是哪个角"，它的对角就是钉住不动的锚点 —— 现在恒为 'BR'，锚点恒为左上角。
        $g = Get-FcGripRect $w $h
        if ($x -ge $g.X -and $x -lt ($g.X + $g.W) -and $y -ge $g.Y -and $y -lt ($g.Y + $g.H)) { return 'BR' }
        return $null
    }

    function Get-FcCursor([string]$Zone, [bool]$OnBtn) {
        if ($Zone -eq 'BR') { return [System.Windows.Forms.Cursors]::SizeNWSE }   # 角标（与判定的优先级一致）
        if ($OnBtn) { return [System.Windows.Forms.Cursors]::Hand }
        return [System.Windows.Forms.Cursors]::SizeAll                             # 其余地方 = 拖动整条
    }

    function Get-FcOnScreen([int]$l, [int]$t, [int]$w, [int]$h) {
        # 别让条跑到屏幕外拿不回来：至少留 60px 宽、24px 高露在外面。
        # 用**虚拟屏**（所有显示器）而不是主屏 —— 否则用户把条拖到第二块屏上，一松手就会被拽回主屏。
        try { $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen } catch { return @{ L = $l; T = $t } }
        $l = [Math]::Max(($vs.Left - $w + 60), [Math]::Min([int]$l, ($vs.Right - 60)))
        $t = [Math]::Max([int]$vs.Top, [Math]::Min([int]$t, ($vs.Bottom - 24)))
        return @{ L = [int]$l; T = [int]$t }
    }

    # ---- 改尺寸/方向的三个动作（都只走 Apply-FcBox）----
    function Apply-FcBox($f, [int]$l, [int]$t, $box) {
        # 唯一改窗口尺寸的地方：一次 SetBounds（分步设 Left / Size 会闪）+ 换圆角 Region +
        # 换字号 + 重画。Region 换完要把旧的 Dispose —— 拖拽时这里是每帧都过的。
        $p = Get-FcOnScreen $l $t $box.W $box.H
        $gp = Get-RoundedPath $box.W $box.H (Get-FcRadius $box.W $box.H $box.Scale)
        $old = $f.Region
        $f.SetBounds($p.L, $p.T, $box.W, $box.H)
        $f.Region = New-Object System.Drawing.Region($gp)
        $gp.Dispose()
        if ($old) { $old.Dispose() }
        Sync-FcFonts $box.Scale
        $f.Invalidate()
    }

    function Set-FcLayout($f, [switch]$Place) {
        if (-not $f) { return }
        $box = Get-FcBox $script:FcOrient $script:FcScale
        $script:FcScale = $box.Scale
        $l = $f.Left; $t = $f.Top
        if ($Place) {
            # 默认位：主屏工作区右上角（WorkingArea 已扣掉任务栏，不会压到任务栏上）
            try {
                $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
                $l = $wa.Right - $box.W - 18
                $t = $wa.Top + 18
            } catch { }
        }
        Apply-FcBox $f $l $t $box
        if ($script:MiOrient) { $script:MiOrient.Text = Get-FcOrientMenuText }
    }

    function Switch-FcOrient($f) {
        if (-not $f) { return }
        if ($script:FcOrient -eq 'v') { $script:FcOrient = 'h' } else { $script:FcOrient = 'v' }
        $script:FcHoverBtn = $false      # 按钮换位置了，高亮得跟着重置
        Set-FcLayout $f
        Save-FcLayout
        Trace ("悬浮窗切为" + (Get-FcOrientName) + "：" + $f.ClientSize.Width + '×' + $f.ClientSize.Height)
    }

    function Reset-FcLayout($f) {
        if (-not $f) { return }
        # 「重置悬浮窗大小与方向」：方向回横向、倍率回 1.0、位置回右上角默认位 ——
        # 拖花了、拖飞了，一条菜单就回到认得出的样子。
        $script:FcOrient = 'h'
        $script:FcScale = 1.0
        Set-FcLayout $f -Place
        Save-FcLayout
        Trace ("悬浮窗已重置：横向 " + $f.ClientSize.Width + '×' + $f.ClientSize.Height + "，回到右上角默认位")
    }

    function Set-FcSizeFromDrag($f, [int]$x, [int]$y) {
        # 拖大小：拖的是哪个角，它的**对角**就钉住不动；尺寸一律由 Get-FcBox 夹一次
        #（比例锁定 + 上下限 + 不出屏，全在那一个函数里，这里不重复算）。
        $rs = $script:FcResize
        if (-not $rs -or -not $f) { return }
        # ⚠️ -like 的通配符**两头锚定**：'BR' -like '*B' 是 false（它结尾是 R 不是 B）。
        # 要的是"含不含 R/B"，所以必须写 '*R*' / '*B*' —— 写成 '*B' 会让竖轴永远按"上边"算：
        # 往下拖反而变矮、往上拖才变大（2026-09-23 真机核对时实测踩到，自测 F 段专盯这条）。
        $onR = ($rs.Zone -like '*R*')
        $onB = ($rs.Zone -like '*B*')
        $sx = $(if ($onR) { 1 } else { -1 })
        $sy = $(if ($onB) { 1 } else { -1 })
        $rawW = $rs.W + ($sx * ($x - $rs.StartX))
        $rawH = $rs.H + ($sy * ($y - $rs.StartY))
        $box = Get-FcBox $script:FcOrient (Get-FcScaleFor $script:FcOrient $rawW $rawH)
        if ([Math]::Abs($box.Scale - $script:FcScale) -lt 0.0001) { return }   # 已经到顶/到底，别白重画
        # 锚点屏幕坐标 = 按下那一刻的窗口位置 + 锚点角在客户区里的偏移
        $ax = $rs.X + $(if ($onR) { 0 } else { $rs.W })
        $ay = $rs.Y + $(if ($onB) { 0 } else { $rs.H })
        $nl = [int]$(if ($onR) { $ax } else { $ax - $box.W })
        $nt = [int]$(if ($onB) { $ay } else { $ay - $box.H })
        $script:FcScale = $box.Scale
        Apply-FcBox $f $nl $nt $box
    }

    # ---- 画 ----
    function Invoke-FcIcon($g, $rect, [bool]$ToVert, [bool]$Hi) {
        # 换方向按钮上的双箭头图标，自绘：Consolas / 雅黑里不一定有 ⇄ ⇅ 这两个字形，
        # 缺字形会画成一个方框 —— 不如用两根线 + 两个三角，长什么样完全由这里说了算。
        # 图标画的是**点下去会变成的方向**：现在是横的 → 画竖向双箭头。
        $pen = $(if ($Hi) { $script:FcPenIconHi } else { $script:FcPenIcon })
        $br  = $(if ($Hi) { $script:FcBrush.Fg } else { $script:FcBrush.Dim })
        $s  = [double][Math]::Max(9, ([Math]::Min([int]$rect.W, [int]$rect.H) - 10))
        $x0 = [int]([int]$rect.X + (([int]$rect.W - $s) / 2.0))
        $y0 = [int]([int]$rect.Y + (([int]$rect.H - $s) / 2.0))
        if ($ToVert) {
            $lx = [int]($x0 + $s * 0.32); $rx = [int]($x0 + $s * 0.68)
            $g.DrawLine($pen, $lx, [int]($y0 + $s * 0.94), $lx, [int]($y0 + $s * 0.22))
            $g.DrawLine($pen, $rx, [int]($y0 + $s * 0.06), $rx, [int]($y0 + $s * 0.78))
            $g.FillPolygon($br, [System.Drawing.PointF[]]@(
                (New-Object System.Drawing.PointF([int]($lx - $s * 0.19), [int]($y0 + $s * 0.36))),
                (New-Object System.Drawing.PointF([int]($lx + $s * 0.19), [int]($y0 + $s * 0.36))),
                (New-Object System.Drawing.PointF($lx, [int]($y0 + $s * 0.02)))))
            $g.FillPolygon($br, [System.Drawing.PointF[]]@(
                (New-Object System.Drawing.PointF([int]($rx - $s * 0.19), [int]($y0 + $s * 0.64))),
                (New-Object System.Drawing.PointF([int]($rx + $s * 0.19), [int]($y0 + $s * 0.64))),
                (New-Object System.Drawing.PointF($rx, [int]($y0 + $s * 0.98)))))
        } else {
            $ty = [int]($y0 + $s * 0.32); $by = [int]($y0 + $s * 0.68)
            $g.DrawLine($pen, [int]($x0 + $s * 0.94), $ty, [int]($x0 + $s * 0.22), $ty)
            $g.DrawLine($pen, [int]($x0 + $s * 0.06), $by, [int]($x0 + $s * 0.78), $by)
            $g.FillPolygon($br, [System.Drawing.PointF[]]@(
                (New-Object System.Drawing.PointF([int]($x0 + $s * 0.36), [int]($ty - $s * 0.19))),
                (New-Object System.Drawing.PointF([int]($x0 + $s * 0.36), [int]($ty + $s * 0.19))),
                (New-Object System.Drawing.PointF([int]($x0 + $s * 0.02), $ty))))
            $g.FillPolygon($br, [System.Drawing.PointF[]]@(
                (New-Object System.Drawing.PointF([int]($x0 + $s * 0.64), [int]($by - $s * 0.19))),
                (New-Object System.Drawing.PointF([int]($x0 + $s * 0.64), [int]($by + $s * 0.19))),
                (New-Object System.Drawing.PointF([int]($x0 + $s * 0.98), $by))))
        }
    }

    # 全部自绘：七格 + 每格左侧 3px 色块 + 标签 + 数值 + 换方向按钮。
    # 横竖只差"格子怎么排"（七列 / 七行），格内的画法完全一样 —— 所以切方向不会出现第二种样式。
    function Invoke-FcPaint($sender, $e) {
        $g = $e.Graphics
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
        $w = $sender.ClientSize.Width
        $h = $sender.ClientSize.Height
        Sync-FcFonts $script:FcScale
        # 底色自己铺满 + 描边，共用同一条路径，用完就 Dispose（原来每帧新建一条 GraphicsPath
        # 谁都不释放，长跑一直堆到 GC）。这一 Fill 是双缓冲的必要配套：开了 AllPaintingInWmPaint
        # 之后系统不再替我们擦背景，不铺的话空的地方是透明/残影。
        $rp = Get-RoundedPath $w $h (Get-FcRadius $w $h $script:FcScale)
        $g.FillPath($script:FcBrush.Panel, $rp)
        $g.DrawPath($script:FcPenLine, $rp)
        $rp.Dispose()
        $vert = ($script:FcOrient -eq 'v')
        $body = Get-FcBodyRect $w $h
        $btn  = Get-FcButtonRect $w $h
        $n = $script:FcCells.Count
        $cw = [int]($body.W / $n)
        $chh = [int]($body.H / $n)
        $tx = [int][Math]::Round(9 * $script:FcScale)          # 文字左缩进（色块宽 3px + 4px 空隙）
            $barW = [int][Math]::Max(3, [Math]::Round(3 * $script:FcScale))   # 色块宽度（控制台是 3px，这里跟着倍率走）
        $pad = [int][Math]::Max(3, [Math]::Round(7 * $script:FcScale))    # 色块上下留白
        $ins = [int][Math]::Max(2, [Math]::Round(9 * $script:FcScale))    # 分隔线两端留白
        $hr = $script:FcData.hitRate
        for ($i = 0; $i -lt $n; $i++) {
            $c = $script:FcCells[$i]
            if ($vert) { $x = $body.X; $y = $body.Y + ($i * $chh); $cwd = $body.W; $chg = $chh }
            else { $x = $body.X + ($i * $cw); $y = $body.Y; $cwd = $cw; $chg = $body.H }
            if ($i -gt 0) {
                # 格与格之间的分隔线（照原来横排的样子；竖排就是横过来）
                if ($vert) { $g.DrawLine($script:FcPenLine, ($x + $ins), ($y - 1), ($x + $cwd - $ins), ($y - 1)) }
                else { $g.DrawLine($script:FcPenLine, ($x - 4), ($y + $ins), ($x - 4), ($y + $chg - $ins)) }
            }
            # 超出本格的内容一律裁掉：条可以被拖小，数字却不该糊到隔壁格子上去
            $g.SetClip((New-Object System.Drawing.RectangleF($x, $y, $cwd, $chg)))
            # 左侧 3px 色块：命中率低于 90% 转告警色（监控窗的意义就是"掉下来要一眼看见"）
            $bar = $c.Bar
            if ($c.Key -eq 'hitRate' -and $hr -ne '-' -and [double]$hr -lt 90) { $bar = 'Warn' }
            $g.FillRectangle($script:FcBrush[$bar], ($x + 1), ($y + $pad), $barW, ($chg - 2 * $pad))
            $g.DrawString($c.Label, $script:FcFontK, $script:FcBrush.Dim, ($x + $tx), ($y + [int][Math]::Round($chg * 0.095)))
            $v = $script:FcData[$c.Key]
            $txt = [string]$v
            if ($c.Key -eq 'hitRate' -and $v -ne '-') { $txt = $txt + '%' }
            $vk = 'Fg'
            if ($c.Key -eq 'dynamic' -and $v -ne '-' -and [int]$v -gt 0) { $vk = 'Warn' }
            if ($c.Key -eq 'error'   -and $v -ne '-' -and [int]$v -gt 0) { $vk = 'Err' }
            $g.DrawString($txt, $script:FcFontV, $script:FcBrush[$vk], ($x + $tx), ($y + [int][Math]::Round($chg * 0.38)))
            $g.ResetClip()
        }
        # 换方向按钮：鼠标停上去给个底（色值还是控制台那套），图标画"点下去会变成的方向"
        if ($script:FcHoverBtn) {
            $rp = Get-RoundedPath $btn.W $btn.H ([int][Math]::Max(3, [Math]::Round(5 * $script:FcScale)))
            $g.TranslateTransform($btn.X, $btn.Y)
            $g.FillPath($script:FcBrush.Line, $rp)
            $g.ResetTransform()
            $rp.Dispose()
        }
        if ($vert) { $g.DrawLine($script:FcPenLine, ($btn.X + $ins), ($btn.Y - 1), ($btn.X + $btn.W - $ins), ($btn.Y - 1)) }
        else { $g.DrawLine($script:FcPenLine, ($btn.X - 1), ($btn.Y + $ins), ($btn.X - 1), ($btn.Y + $btn.H - $ins)) }
        Invoke-FcIcon $g $btn ($script:FcOrient -eq 'h') $script:FcHoverBtn
        # 右下角的角标：三道斜线 —— "能从这里拉大小"的通用记号。位置与 Get-FcZone 共用
        # Get-FcGripRect：**画在哪儿就只能在哪儿点**（画和点共用同一份几何的老规矩）。
        $gp = Get-FcGripRect $w $h
        $pd = [int][Math]::Max(2, [Math]::Round(3 * $script:FcScale))
        for ($k = 1; $k -le 3; $k++) {
            $off = [int][Math]::Round($gp.W * $k / 5.0)
            $g.DrawLine($script:FcPenIcon, ($gp.X + $off), ($gp.Y + $gp.H - $pd), ($gp.X + $gp.W - $pd), ($gp.Y + $off))
        }
    }

    function New-FloatStrip {
        $f = New-Object System.Windows.Forms.Form
        $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $f.StartPosition   = [System.Windows.Forms.FormStartPosition]::Manual
        $f.ShowInTaskbar   = $false          # 悬浮元素不该占任务栏
        $f.TopMost         = $true           # 浮在游戏上面
        $f.Text            = $FloatTitle
        $f.BackColor       = [System.Drawing.ColorTranslator]::FromHtml($FcColor.Panel)
        $f.Opacity         = 0.95            # 略微透一点，压在游戏上不刺眼
        # 双缓冲（V4.14.1）：不开的话每次重绘都是「先把整条擦成空面板、再往上画」两步，
        # 中间那十几毫秒屏幕上就是**一条什么都没有的空条**（真机取证：600ms 一次，肉眼即
        # "不停的闪烁"）。开了之后所有绘制进离屏缓冲、一次贴上去，看不到半成品。
        # ⚠️ AllPaintingInWmPaint 会一并关掉"系统替我们擦背景"那一步 —— 所以 Invoke-FcPaint
        #    里必须自己把面板底色铺满（见那里的 FillPath），否则画出来的还是透明/残影。
        # ⚠️ SetStyle 是 protected 的，PowerShell 里只能反射调；调不通就别管，宁可不双缓冲
        #    也不能让建窗失败（那会连条都没了）。
        try {
            $cs = [System.Windows.Forms.ControlStyles](
                [int][System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer -bor
                [int][System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint -bor
                [int][System.Windows.Forms.ControlStyles]::UserPaint)
            $miStyle = [System.Windows.Forms.Control].GetMethod('SetStyle', [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
            # [void] 不能省：Invoke 声明返回 object，**返回的 null 也会被 PowerShell 当成一路输出**，
            # 混进 New-FloatStrip 的返回值里就成了"返回一个数组"，窗口对象当场废掉（实测踩到）。
            [void]$miStyle.Invoke($f, [object[]]@($cs, $true))
        } catch { Trace ("悬浮窗没开成双缓冲: " + $_.Exception.Message) }
        # 尺寸/方向取上次存的（float-win.json），没存过就是横向基准大小；位置 = 主屏右上角
        Read-FcLayout
        Sync-FcFonts $script:FcScale
        Set-FcLayout $f -Place
        $f.add_Paint({ param($s, $e) Invoke-FcPaint $s $e })
        # 无边框窗口没有系统边框，所以拖动和"拉大小"都得自己实现
        $f.add_MouseDown({
            param($s, $e)
            if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
            $w = $s.ClientSize.Width; $h = $s.ClientSize.Height
            if (Test-FcInButton $e.X $e.Y $w $h) {
                # 点的是换方向按钮：这一下既不算拖动、也不算拉大小
                $script:FcDrag = $null; $script:FcResize = $null
                Switch-FcOrient $s
                return
            }
            $z = Get-FcZone $e.X $e.Y $w $h
            if ($z) {
                # 角标 = 拉大小（唯一入口）。锚点恒为左上角（X/Y 记的是当时的窗口位置）——
                # 所以拉大小期间窗口原点不动，这正是"右下角拉不闪、其它角闪"的根因所在。
                $script:FcResize = @{ Zone = $z; StartX = $e.X; StartY = $e.Y; W = $w; H = $h; X = $s.Left; Y = $s.Top }
                $script:FcDrag = $null
            } else {
                $script:FcDrag = $e.Location
                $script:FcResize = $null
            }
        })
        $f.add_MouseMove({
            param($s, $e)
            if ($script:FcResize) {
                if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Set-FcSizeFromDrag $s $e.X $e.Y }
                return
            }
            if ($script:FcDrag) {
                if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
                    $s.Left = $s.Left + ($e.X - $script:FcDrag.X)
                    $s.Top  = $s.Top + ($e.Y - $script:FcDrag.Y)
                }
                return
            }
            # 没在拖：只更新"鼠标在不在按钮上"和光标形状（都只影响观感）
            $w = $s.ClientSize.Width; $h = $s.ClientSize.Height
            $onBtn = Test-FcInButton $e.X $e.Y $w $h
            if ($onBtn -ne $script:FcHoverBtn) { $script:FcHoverBtn = $onBtn; $s.Invalidate() }
            $z = Get-FcZone $e.X $e.Y $w $h
            $key = $(if ($onBtn) { 'btn' } elseif ($z) { $z } else { 'move' })
            if ($key -ne $script:FcCursorKey) {
                $script:FcCursorKey = $key
                $s.Cursor = Get-FcCursor $z $onBtn
            }
        })
        $f.add_MouseUp({
            param($s, $e)
            $wasResize = $script:FcResize
            $wasDrag = $script:FcDrag
            $script:FcResize = $null
            $script:FcDrag = $null
            if ($wasResize) {
                Save-FcLayout
                Trace ("悬浮窗尺寸改为 " + $s.ClientSize.Width + '×' + $s.ClientSize.Height)
            } elseif ($wasDrag) {
                # 拖完把位置拉回可视范围（虚拟屏：多显示器下不会把条从第二块屏拽回主屏）
                $p = Get-FcOnScreen $s.Left $s.Top $s.ClientSize.Width $s.ClientSize.Height
                if ($p.L -ne $s.Left -or $p.T -ne $s.Top) { $s.Left = $p.L; $s.Top = $p.T }
            }
        })
        $f.add_DoubleClick({
            param($s, $e)
            # 双击按钮或角标不算"双击悬浮条"（那两处多半是手抖），不该把条收起来
            $w = $s.ClientSize.Width; $h = $s.ClientSize.Height
            if (Test-FcInButton $e.X $e.Y $w $h) { return }
            if (Get-FcZone $e.X $e.Y $w $h) { return }
            Hide-FloatStrip
        })
        # 外部关闭（Alt+F4、别的工具发 WM_CLOSE）也按"用户收起"处理：**取消真正关闭**、
        # 改为隐藏并通知服务端。不拦的话窗口会被销毁，$script:FcStrip 就成了已释放对象，
        # 下一次 Show() 抛异常 —— 那正是 V4.13.0"关不掉"的另一种形态。
        $f.add_FormClosing({
            param($s, $e)
            if ($script:FcShuttingDown) { return }   # 托盘自己在退出，放行
            $e.Cancel = $true
            Hide-FloatStrip
        })
        $cm = New-Object System.Windows.Forms.ContextMenuStrip
        $miHide = $cm.Items.Add('隐藏悬浮窗')
        $miHide.add_Click({ Hide-FloatStrip })
        $miO = $cm.Items.Add('切换横竖方向')
        $miO.add_Click({ Switch-FcOrient $script:FcStrip })
        $miR = $cm.Items.Add('重置悬浮窗大小与方向')
        $miR.add_Click({ Reset-FcLayout $script:FcStrip })
        $miOpen2 = $cm.Items.Add('打开控制台')
        $miOpen2.add_Click({ Open-Dashboard })
        # 临时直连开关（V4.14.9）：一键暂停/恢复缓存接管，不改任何持久化配置。
        # 状态文字由 Sync-FloatStrip 跟着 /api/float-state 的 bypass 刷新。
        $miBypass = $cm.Items.Add('暂停缓存（临时直连）')
        $miBypass.add_Click({
            $on = $(if ($script:PacBypass) { '0' } else { '1' })
            try { Invoke-RestMethod -Uri ($BaseUrl + 'api/pac-bypass?on=' + $on) -Method Post -TimeoutSec 4 | Out-Null } catch { }
            Sync-FloatStrip
        })
        $script:MiBypass = $miBypass
        $f.ContextMenuStrip = $cm
        return $f
    }

    function Get-FcStripOrBuild {
        # 窗口是常驻的（真要显示时才建会有可见延迟），这里只是"没建就补一个"的保险
        if (-not $script:FcStrip) {
            try { $script:FcStrip = New-FloatStrip } catch { Trace ("建悬浮窗失败: " + $_.Exception.Message) }
        }
        return $script:FcStrip
    }

    function Hide-FloatStrip {
        # 用户主动收起：也请服务端把 manual 钉成 false。
        # **这一步是"关得掉"的关键** —— 不告诉服务端，下一次对齐又会把它显示出来
        #（V4.13.0 那版就是这么变成"永远关不掉"的）。
        try { Invoke-RestMethod -Uri ($BaseUrl + 'api/float-toggle') -Method Post -TimeoutSec 4 | Out-Null } catch { }
        if ($script:FcStrip) { $script:FcStrip.Hide() }
        Trace "用户收起悬浮窗"
    }

    function Get-FloatState {
        # 读不到（服务没起、端口没通）返回 $null，调用方按"什么都不做"处理。
        # **绝不能在读不到时猜"该显示"** —— 那会在服务重启的瞬间弹一个连不上服务的空窗。
        try { return Invoke-RestMethod -Uri ($BaseUrl + 'api/float-state') -TimeoutSec 4 } catch { return $null }
    }

    function Format-FcRate([double]$bps) {
        # 回源速率的紧凑显示（V4.14.12）：B/s 直接取整；KB / MB 各一档 —— 格子窄，能短则短。
        # 小数点用不变文化格式化，免得"逗号小数点"的区域设置画出 "1,5M"。
        if ($bps -ge 1048576) { return ([Math]::Round($bps / 1048576, 1)).ToString([System.Globalization.CultureInfo]::InvariantCulture) + 'M' }
        if ($bps -ge 1024) { return [Math]::Round($bps / 1024).ToString() + 'K' }
        return [Math]::Round($bps).ToString()
    }

    # 把窗口显隐与数字对齐到服务端说的样子。无状态：每次都看实际可见性，不记标记。
    function Sync-FloatStrip {
        $st = Get-FloatState
        if ($null -eq $st) { return }
        $f = Get-FcStripOrBuild
        if ($st.metrics) {
            $m = $st.metrics
            $script:FcData.hit     = [int]$m.hit
            $script:FcData.miss    = [int]$m.miss
            $script:FcData.stored  = [int]$m.stored
            $script:FcData.dynamic = [int]$m.dynamic
            $script:FcData.error   = [int]$m.error
            if ($null -eq $m.hitRate) { $script:FcData.hitRate = '-' } else { $script:FcData.hitRate = $m.hitRate }
            # 回源速率（V4.14.12）：服务端给的每秒字节（10 秒滚动窗），压成紧凑文案
            if ($null -eq $m.originRate) { $script:FcData.rate = '-' } else { $script:FcData.rate = Format-FcRate ([double]$m.originRate) }
            # 只在**看得见的那几个数真的变了**时才重画（V4.14.1）：待机时一次都不重绘 ——
            # 既省 CPU，也就没有"擦白—重画"那一瞬可闪。别拿 $script:FcData 这个 hashtable
            # 本身去比（引用相等，永远比不出变化），拼一串签名比。
            $sig = [string]$script:FcData.hit + '|' + $script:FcData.miss + '|' + $script:FcData.stored + '|' +
                $script:FcData.dynamic + '|' + $script:FcData.error + '|' + $script:FcData.hitRate + '|' + $script:FcData.rate
            if ($sig -ne $script:FcDataSig) {
                $script:FcDataSig = $sig
                if ($f -and $f.Visible) { $f.Invalidate() }
            }
        }
        if ($st.show) {
            if ($f -and -not $f.Visible) {
                $f.Show()
                Trace "悬浮窗已显示"
            }
            if ($f -and -not $f.TopMost) { $f.TopMost = $true }
        } elseif ($f -and $f.Visible) {
            $f.Hide()
        }
        if ($script:MiFloat) {
            $script:MiFloat.Text = $(if ($st.show) { '隐藏悬浮窗' } else { '显示悬浮窗' })
        }
        if ($script:MiOrient) { $script:MiOrient.Text = Get-FcOrientMenuText }
        # 临时直连（V4.14.9）：菜单文字跟着服务端状态走（0.6 秒一轮，很快对齐）
        $script:PacBypass = [bool]$st.bypass
        if ($script:MiBypass) {
            $script:MiBypass.Text = $(if ($st.bypass) { '恢复缓存接管' } else { '暂停缓存（临时直连）' })
        }
        # 更新日预热通知（V4.14.11）：/api/float-state 带了 prewarm 实况。
        # running 变真且 key 是新的 → 气泡"开始"；从真翻假 → 气泡"完成"。key 没变绝不重复弹。
        if ($st.prewarm -and $st.prewarm.key) {
            $pk = [string]$st.prewarm.key
            if ($st.prewarm.running) {
                if ($script:PrewarmSig -ne $pk) {
                    $script:PrewarmSig = $pk
                    $script:PrewarmActive = $true
                    $script:Tray.ShowBalloonTip(5000, '检测到游戏资源更新',
                        '正在后台预热新版本资源（复用旧文件、预下载变更），完成后进游戏可直接命中。', 'Info')
                    Trace ("预热开始: " + $pk)
                }
            } elseif ($script:PrewarmActive) {
                $script:PrewarmActive = $false
                $script:Tray.ShowBalloonTip(4000, '预热完成',
                    ("复用 {0} / 预下载 {1}（详情见控制台）" -f $st.prewarm.reused, $st.prewarm.refreshed), 'Info')
                Trace ("预热结束: " + $pk)
            }
        }
        # 更新日战报（P1-A，V4.18.0）：/api/float-state 的 report 换成新 key 时弹一次气泡。
        # 与预热气泡同一个开关（服务端在关掉「游戏更新提醒气泡」时直接不下发 report）。
        if ($st.report -and $st.report.key) {
            $rk = [string]$st.report.key
            if ($script:ReportSig -ne $rk) {
                $script:ReportSig = $rk
                $script:Tray.ShowBalloonTip(5000, '更新日战报', [string]$st.report.summary, 'Info')
                Trace ("战报: " + $rk)
            }
        }
    }
    # ==== 悬浮监控窗（V4.14.0）· END =================================================


    # ------------------------------------------------------------ 托盘图标

    $script:Tray = New-Object System.Windows.Forms.NotifyIcon
    try { $script:Tray.Icon = New-Object System.Drawing.Icon($IconOn) }
    catch { $script:Tray.Icon = [System.Drawing.SystemIcons]::Application }
    $script:Tray.Text = '碧蓝幻想本地缓存程序'
    $script:Tray.Visible = $true

    $script:IconOnObj  = $script:Tray.Icon
    $script:IconOffObj = $null
    if (Test-Path $IconOff) {
        try { $script:IconOffObj = New-Object System.Drawing.Icon($IconOff) } catch {}
    }
    if (-not $script:IconOffObj) { $script:IconOffObj = $script:IconOnObj }

    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $miOpen = $menu.Items.Add('打开控制台')
    $miOpen.add_Click({ Open-Dashboard })

    $miTest = $menu.Items.Add('打开自检页')
    $miTest.add_Click({ Open-SelfTest })

    # 悬浮监控窗（V4.14.0）：手动叫出/收起。文字由 Sync-FloatStrip 跟着实际状态刷新。
    $miFloat = $menu.Items.Add('显示悬浮窗')
    $miFloat.add_Click({
        # 交给服务端翻状态（"该不该显示"它说了算），再立刻对齐一次，不必等下一个定时器
        try { Invoke-RestMethod -Uri ($BaseUrl + 'api/float-toggle') -Method Post -TimeoutSec 4 | Out-Null } catch { }
        Sync-FloatStrip
    })
    $script:MiFloat = $miFloat

    # 悬浮窗的形状（V4.14.0）：横竖切换 + 一键重置。改完立即落盘（float-win.json），
    # 下次启动还是这个样子。文字由 Sync-FloatStrip 跟着实际方向刷新。
    $miOrient = $menu.Items.Add('悬浮窗改为竖向')
    $miOrient.add_Click({ Switch-FcOrient (Get-FcStripOrBuild) })
    $script:MiOrient = $miOrient

    $miResetFloat = $menu.Items.Add('重置悬浮窗大小与方向')
    $miResetFloat.add_Click({ Reset-FcLayout (Get-FcStripOrBuild) })
    $script:MiResetFloat = $miResetFloat

    $menu.Items.Add('-') | Out-Null

    $miCache = $menu.Items.Add('打开缓存目录')
    $miCache.add_Click({ Open-CacheDir })

    $miLog = $menu.Items.Add('查看服务日志')
    $miLog.add_Click({ Open-LogFile })

    $miRestart = $menu.Items.Add('重启服务')
    $miRestart.add_Click({ Restart-Server })

    $menu.Items.Add('-') | Out-Null

    # 方案 A：把系统代理槽位留给加速器，缓存只作用于这个专用浏览器实例
    #   默认项：用你自己的 Edge profile（登录状态都在，不需要重新登录；会先问你是否关闭 Edge）
    #   第二项：独立 profile（不用关 Edge，但首次要登录一次）
    # v4（PAC 分流模式）：系统「自动配置脚本」由本程序接管，任何浏览器都自动走缓存。
    # 这是玩游戏的首选入口 —— 用默认浏览器直接开，不需要关闭 Edge，也不需要专用窗口。
    $miGame = $menu.Items.Add('打开游戏（默认浏览器）')
    $miGame.add_Click({
        Trace "用默认浏览器打开游戏"
        Start-Process 'https://game.granbluefantasy.jp/'
    })
    $menu.Items.Add('-') | Out-Null

    $miExit = $menu.Items.Add('退出')
    $miExit.add_Click({
        Trace "用户选择退出"
        # 托盘退出 = 服务也要停，悬浮窗留着没意义。窗口就在本进程里，进程一退自然没了；
        # 这里显式收一下，免得退出过程里它还停在屏幕上。
        $script:FcShuttingDown = $true
        if ($script:FcStrip) { $script:FcStrip.Hide() }
        $script:Tray.Visible = $false
        Stop-Server
        [System.Windows.Forms.Application]::Exit()
    })

    $script:Tray.ContextMenuStrip = $menu

    $script:Tray.add_MouseDoubleClick({
        if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Dashboard }
    })

    # ------------------------------------------------------------ 状态巡检

    # 连续两次探测失败才判定服务已停，避免扫描缓存或游戏高负载时误报
    $script:FailStreak = 0
    $script:WarnedDown = $false

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 10000
    $timer.add_Tick({
        if (Test-Server) {
            $script:FailStreak = 0
            if ($script:WarnedDown) { Trace "服务已恢复" }
            $script:WarnedDown = $false
            $script:Tray.Icon = $script:IconOnObj
            # 悬停提示带上程序版本号（从服务的 stats 读，读不到退回无版本文案）
            try {
                $st = Invoke-RestMethod -Uri ($BaseUrl + 'api/stats') -TimeoutSec 4
                $v = [string]$st.appVersion
                if ($v) { $script:Tray.Text = ("碧蓝幻想本地缓存程序 " + $v + " — 运行中") }
                else { $script:Tray.Text = '碧蓝幻想本地缓存程序 — 运行中' }
            } catch {
                try {
            $st = Invoke-RestMethod -Uri ($BaseUrl + 'api/stats') -TimeoutSec 4
            $v = [string]$st.appVersion
            if ($v) { $script:Tray.Text = ("碧蓝幻想本地缓存程序 " + $v + " — 运行中") }
            else { $script:Tray.Text = '碧蓝幻想本地缓存程序 — 运行中' }
        } catch {
            $script:Tray.Text = '碧蓝幻想本地缓存程序 — 运行中'
        }
            }
        } else {
            $script:FailStreak++
            if ($script:FailStreak -ge 2) {
                $script:Tray.Icon = $script:IconOffObj
                $script:Tray.Text = '碧蓝幻想本地缓存程序 — 服务未运行'
                if (-not $script:WarnedDown) {
                    $script:WarnedDown = $true
                    Trace "连续 $($script:FailStreak) 次探测失败，判定服务已停"
                    $script:Tray.ShowBalloonTip(4000, '缓存服务已停止',
                        '右键托盘图标可以选择「重启服务」。', 'Warning')
                }
            }
        }
    })
    $timer.Start()

    # ------------------------------------------------------------ 悬浮窗对齐（0.6 秒）

    # 比状态巡检(10 秒)快得多 —— 关掉控制台后悬浮窗要**立刻**出来：判定那边已经把
    # 宽限期压到 1.5 秒，这里再等 2 秒就白等一半。只读一个小接口（几个数字），
    # 每次约几十毫秒且不查证书存储，负担可以忽略。
    # 启动时不立刻对齐 —— 先让服务把状态跑起来（"控制台开过没有"），避免开机就弹。
    $floatTimer = New-Object System.Windows.Forms.Timer
    $floatTimer.Interval = 600
    $floatTimer.add_Tick({ Sync-FloatStrip })
    $floatTimer.Start()

    # ------------------------------------------------------------ 启动

    if (Start-Server) {
        $script:Tray.Text = '碧蓝幻想本地缓存程序 — 运行中'
        $script:Tray.ShowBalloonTip(3000, '碧蓝幻想本地缓存程序',
            '已在后台启动。双击托盘图标可打开控制台。', 'Info')
        # 启动后自动打开控制台（V4.15.2 设置面板开关；config.json openDashboardOnStart，默认开）
        if (Get-OpenDashboardOnStart) { Open-Dashboard }

        # 启动程序后自动「启动游戏」：用系统默认浏览器 + PAC 分流（资源走缓存、接口直连，缓存加速并用）。
        # 不想要这个行为时，把 config.json 的 "autoLaunchGame" 改成 false。
        # 注意：托盘菜单的「重启服务」不会触发它 —— 那是排障动作，不该再弹游戏窗口。
        if (Get-AutoLaunchGame) {
            Start-Sleep -Seconds 2
            try {
                Invoke-WebRequest -Uri ($BaseUrl + 'api/launch-game') -Method Post -TimeoutSec 8 -UseBasicParsing | Out-Null
                Trace "已自动启动游戏（目标见控制台切换）"
            } catch {
                Trace ("自动启动游戏失败: " + $_.Exception.Message)
            }
        }

        # 启动程序后自动启动加速器（config.json 的 "autoLaunchAccel": false 可关闭，
        # exe 路径见 "acceleratorPath"，与控制台⚙里配的是同一个字段）。
        # 用 PowerShell Start-Process（ShellExecute 语义）拉起：工作目录=exe 所在目录，需要管理员会弹 UAC。
        # 若同名进程已在运行（按 exe 文件名推断）则跳过，避免重复启动/反复弹 UAC。
        if (Get-AutoLaunchAccel) {
            $ax = Get-AcceleratorPath
            if ($ax -and (Test-Path $ax)) {
                $axName = [System.IO.Path]::GetFileNameWithoutExtension($ax)
                if (Get-Process -Name $axName -ErrorAction SilentlyContinue) {
                    Trace ("加速器已在运行（" + $axName + "），跳过自启")
                } else {
                    try {
                        $axDir = [System.IO.Path]::GetDirectoryName($ax)
                        $ps = "Start-Process -FilePath '" + ($ax -replace "'", "''") + "' -WorkingDirectory '" + ($axDir -replace "'", "''") + "'"
                        $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($ps))
                        Start-Process powershell.exe -ArgumentList ("-NoProfile -EncodedCommand " + $enc)
                        Trace "已自动启动加速器（通用 exe 唤醒）"
                    } catch {
                        Trace ("自动启动加速器失败: " + $_.Exception.Message)
                    }
                }
            } else {
                Trace "未设置加速器程序（在控制台⚙里选择 exe），跳过自启"
            }
        }
    } else {
        $script:Tray.Icon = $script:IconOffObj
        $script:Tray.Text = '碧蓝幻想本地缓存程序 — 启动失败'
        $script:Tray.ShowBalloonTip(6000, '启动失败',
            '缓存服务没能启动，右键托盘图标可查看日志。', 'Error')
    }

    # 悬浮条先把窗口建好（藏着不显示）：首次要显示时就没有可见延迟
    Get-FcStripOrBuild | Out-Null

    Trace "进入消息循环"
    [System.Windows.Forms.Application]::Run()
    Trace "=== 托盘启动器退出 ==="

} catch {
    Trace "未捕获异常: $($_.Exception.Message)"
    Trace "堆栈: $($_.ScriptStackTrace)"
    [System.Windows.Forms.MessageBox]::Show(
        "启动器出错：" + [char]10 + $_.Exception.Message + [char]10 + [char]10 + "详情见 logs\tray.log",
        '碧蓝幻想本地缓存程序', 'OK', 'Error') | Out-Null
    exit 1
}
