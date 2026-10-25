# 打开（或切到）控制台窗口
#
# 逻辑：先找有没有已存在的控制台窗口
#   - 有  -> 还原并切到前台（不重复开窗）
#   - 没有 -> 用配置的浏览器（默认优先 Edge）应用模式新开一个
#
# 由 open-dashboard.bat 调用，托盘菜单也使用同样的思路。

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DashWin {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    public static IntPtr Find(string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            // 包含匹配：普通标签页窗口标题会带 " - 浏览器名" 后缀，应用模式窗口就是页面标题。
            if (sb.ToString().IndexOf(title, StringComparison.Ordinal) >= 0) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$Title   = '碧蓝幻想本地缓存程序'
$BaseUrl = 'http://127.0.0.1:8799/'
$Dir     = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1) 已有窗口就直接切到前台
$h = [DashWin]::Find($Title)
if ($h -ne [IntPtr]::Zero) {
    if ([DashWin]::IsIconic($h)) { [void][DashWin]::ShowWindow($h, 9) }   # SW_RESTORE
    [void][DashWin]::SetForegroundWindow($h)
    exit 0
}

# 2) 服务没跑就先拉起来
try {
    $null = Invoke-WebRequest -Uri ($BaseUrl + 'api/stats') -TimeoutSec 2 -UseBasicParsing
} catch {
    $node = 'H:\DevTools\nodejs\node-v24.21.0-win-x64\node.exe'
    $cmd  = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
    if (Test-Path $node) {
        $env:GBFCACHE_OPEN_UI = '0'    # 不要让它自己再弹一个窗口
        Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $Dir -WindowStyle Hidden | Out-Null
        Start-Sleep -Seconds 3
    }
}

# 3) 新开一个控制台窗口：优先用设置里指定的浏览器，未指定则用 Edge
$consoleBrowser = ''
try {
    $cfg = Get-Content (Join-Path $Dir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.consoleBrowserPath) { $consoleBrowser = [string]$cfg.consoleBrowserPath }
} catch {}

$browser = $null
if ($consoleBrowser -and (Test-Path -LiteralPath $consoleBrowser)) {
    $browser = $consoleBrowser
}
if (-not $browser) {
    $browser = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

if ($browser) {
    # Chromium 系用 --app= 开无地址栏窗口；Firefox 系没有这个参数，只传 URL。
    $name = [System.IO.Path]::GetFileName($browser).ToLowerInvariant()
    if ($name -match '^(firefox|waterfox|librewolf|palemoon)\.exe$') {
        Start-Process -FilePath $browser -ArgumentList @($BaseUrl)
    } else {
        Start-Process -FilePath $browser -ArgumentList @("--app=$BaseUrl")
    }
} else {
    Start-Process $BaseUrl
}
