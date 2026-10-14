# =====================================================================
#  路径选择器「宿主」进程（V4.6.2 新增）
#
#  为什么要有它：选缓存目录 / 选加速器 exe 都要弹一个 WinForms 对话框，而过去的做法是
#  **每点一次就新起一个 powershell.exe**。实测（本机热态，中位数）：
#      进程启动            619 ms
#      + 加载 WinForms      903 ms   ← 固定开销到此为止
#      + 真的弹出对话框    1149 ms   ← 窗口本身只占约 250 ms
#  也就是说这 1.1 秒里九成是"重新起进程 + 重新加载程序集"，用户感受到的就是"点了半天才出来"。
#  本脚本让这个进程**常驻**：启动一次、加载一次 WinForms，之后来一个请求弹一个窗
#  （同一进程里第二次弹窗几乎不增加固定开销）。
#
#  协议（stdin 逐行读，stdout 逐行回；UTF-8）：
#      PING                          -> PONG                        （连通性自检，不弹窗）
#      FOLDER|<初始目录>|<说明文字>    -> OK|<路径> / CANCEL / ERR|<原因>
#      FILE|<初始目录>|<标题>|<过滤器> -> OK|<路径> / CANCEL / ERR|<原因>
#      EXIT                          -> 退出
#  父进程（server.js）关闭管道时（ReadLine 返回 $null）本进程自行退出 —— 这样服务重启、
#  程序被强杀之后不会留下孤儿进程。空闲回收由父进程负责（见 server.js 的 pickerReap）。
#
#  ⚠️ 本文件必须存为「UTF-8 带 BOM」：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI
#     解析，中文全变乱码并可能直接语法报错（本项目已踩过多次）。
# =====================================================================

$ErrorActionPreference = 'Continue'

# 管道不是真实控制台，PowerShell 会用控制台编码去解/写重定向流；
# 不显式设成 UTF-8 的话，带中文的路径（例如 D:\GBF缓存）传过来就会变成乱码。
try {
    [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

# WinForms 只加载这一次 —— 这正是本宿主存在的意义
Add-Type -AssemblyName System.Windows.Forms

# 弹对话框时给它一个**置顶的隐藏宿主窗体**当 owner（V4.8.2 修）。
#
# 【为什么必须这么做 —— 实测诊断】本进程是**后台进程**：父进程是服务，自己又带隐藏控制台、
# 没有任务栏按钮。Windows 的前台锁定规则（foreground lock）不允许它把对话框带到前台，
# 结果对话框**其实已经创建、visible=True、也没卡死**（用 EnumWindows 查得到：
# `cls=#32770 visible=True title=[浏览文件夹]`），但**被别的窗口挡在后面**，用户完全看不到 ——
# 服务端只能干等到 300 秒超时，日志里留下「请求超时（300s）：FOLDER|…」与
# 「宿主正忙（上一个对话框还开着）」。给一个 TopMost 的 owner 后，对话框作为它的**拥有窗口
# 也会置顶**，就能正常出现在最前面。owner 本身挪到屏幕外、不进任务栏，用户看不到它。
function New-DialogOwner {
    $o = New-Object System.Windows.Forms.Form
    $o.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $o.ShowInTaskbar = $false
    $o.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $o.Left = -32000
    $o.Top = -32000
    $o.Width = 1
    $o.Height = 1
    $o.TopMost = $true
    $o.Show()
    return $o
}

function Write-Line([string]$s) {
    [Console]::Out.WriteLine($s)
    [Console]::Out.Flush()
}

Write-Line 'READY'

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }        # 父进程没了 -> 退出，不留孤儿
    $line = $line.Trim()
    if (-not $line) { continue }

    $parts = $line -split '\|'
    $cmd = $parts[0].ToUpperInvariant()

    if ($cmd -eq 'EXIT') { break }
    if ($cmd -eq 'PING') { Write-Line 'PONG'; continue }

    $initial = if ($parts.Count -gt 1) { $parts[1] } else { '' }
    $text    = if ($parts.Count -gt 2) { $parts[2] } else { '' }
    # 过滤器（FILE 用）本身含 `|`（'可执行文件 (*.exe)|*.exe|...'），所以第 4 段之后要拼回去
    $filter  = if ($parts.Count -gt 3) { ($parts[3..($parts.Count - 1)] -join '|') } else { '' }

    try {
        if ($cmd -eq 'FOLDER') {
            $d = New-Object System.Windows.Forms.FolderBrowserDialog
            $d.Description = $text
            $d.ShowNewFolderButton = $true
            # 初始目录必须存在才能设：设一个不存在的路径会抛异常，对话框就弹不出来了
            if ($initial -and (Test-Path -LiteralPath $initial)) { $d.SelectedPath = $initial }
            $owner = New-DialogOwner
            try { $res = $d.ShowDialog($owner) }      # 带置顶 owner —— 否则会被挡在后面，用户看不见
            finally { try { $owner.Close(); $owner.Dispose() } catch { } }
            if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
                Write-Line ('OK|' + $d.SelectedPath)
            } else {
                Write-Line 'CANCEL'
            }
        }
        elseif ($cmd -eq 'FILE') {
            $f = New-Object System.Windows.Forms.OpenFileDialog
            $f.Title = $text
            if ($filter) { $f.Filter = $filter }
            if ($initial -and (Test-Path -LiteralPath $initial)) { $f.InitialDirectory = $initial }
            $owner = New-DialogOwner
            try { $res = $f.ShowDialog($owner) }      # 同上
            finally { try { $owner.Close(); $owner.Dispose() } catch { } }
            if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
                Write-Line ('OK|' + $f.FileName)
            } else {
                Write-Line 'CANCEL'
            }
        }
        else {
            Write-Line ('ERR|未知命令：' + $cmd)
        }
    } catch {
        # 任何异常都要回一条 ERR，否则父进程会一直等下去（表现为界面卡住）
        Write-Line ('ERR|' + $_.Exception.Message)
    }
}

exit 0
