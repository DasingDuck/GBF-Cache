# ============================================================================
#  注册/注销「跟随浏览器启动」的原生消息宿主（程序 V4.23.0 / 扩展 v2.2.0）
#
#  用法（在 exe-dist 目录里运行；只写 HKCU，不需要管理员）：
#    注册：powershell -ExecutionPolicy Bypass -File register-native-host.ps1
#    注销：powershell -ExecutionPolicy Bypass -File register-native-host.ps1 -Uninstall
#
#  注册后：装有 edge-extension v2.2.0+ 的浏览器一启动就自动拉起本目录的
#  GBFCache.exe；浏览器退出时程序跟着退出。不想用了就 -Uninstall，或干脆
#  禁用扩展 —— 未注册/未启用时，程序行为与从前完全一致（手动双击 exe）。
#
#  写了什么（全部可逆）：
#    %LOCALAPPDATA%\GBFCache\com.dasingduck.gbfcache.json   —— 宿主清单
#    HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dasingduck.gbfcache
#    HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dasingduck.gbfcache
# ============================================================================

param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$HostName = 'com.dasingduck.gbfcache'

# 这串 key 必须与 edge-extension\manifest.json 的 "key" 完全一致（do-all 构建有
# 一致性断言盯着）——不一致时浏览器会静默拒绝让该扩展连接宿主，表现为「注册了
# 也没反应」，且现场毫无报错。
$ExtKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq1NC0gA9ZT6lahi6D0Yx3rryhPqYiDR064Lxq5PsHdBDOOqrzOcCTEMV6k5MOns1BQpG+oyZjtmg1iJJqEniku3F6tKIw4BaRgpwABx8zPg2zQXJ+SAVsUfO9eIrnpjfhZe2KvH0OeOFr/cJ7ZMFB5EZZJNQ22fzYvZzvVkt+uvOi41CRjJNouu7uY0F5edK+X0shfinW2jHXaW59Uqp3/bLhJ46D+ZAMFd39omXT1++SgBbJQKqxqkP967R3UgHYbD1K2wmtEWVNNpuZO0zlXmpqIkq+LEAj7DwdPN0UVLbYTEF9z+RQsAH8BpiBxqFLc0y/I0k1TRK8CGNjl8sHwIDAQAB'

# 扩展 ID = SHA-256(公钥 DER) 的前 32 个十六进制位逐位映射到 a-p（Chromium 规则）。
# 当场重算而不是写死，让「key 与 ID 是否匹配」在注册时自证；算错了 FromBase64String
# 会直接抛错，不会带病注册。
$der = [Convert]::FromBase64String($ExtKey)
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $hash = $sha.ComputeHash($der) } finally { $sha.Dispose() }
$hex = ([BitConverter]::ToString($hash) -replace '-', '').ToLower().Substring(0, 32)
$sb = New-Object System.Text.StringBuilder
foreach ($c in $hex.ToCharArray()) {
    [void]$sb.Append([char](97 + [Convert]::ToInt32($c.ToString(), 16)))
}
$ExtId = $sb.ToString()

$ExeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExePath = Join-Path $ExeDir 'GBFCache.exe'
$ManifestDir = Join-Path $env:LOCALAPPDATA 'GBFCache'
$ManifestPath = Join-Path $ManifestDir ($HostName + '.json')

$regPaths = @(
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
)

if ($Uninstall) {
    foreach ($k in $regPaths) {
        if (Test-Path $k) { Remove-Item $k -Force; Write-Host "已删除注册表键：$k" }
    }
    if (Test-Path $ManifestPath) { Remove-Item $ManifestPath -Force; Write-Host "已删除宿主清单：$ManifestPath" }
    Write-Host ''
    Write-Host "已注销 $HostName。浏览器下次启动起，扩展不再拉起本地程序（手动双击 exe 不受影响）。"
    exit 0
}

if (-not (Test-Path $ExePath)) {
    Write-Host "找不到 $ExePath"
    Write-Host '请在 exe-dist 目录里运行本脚本 —— 注册的宿主路径就是那里的 GBFCache.exe。'
    exit 1
}

New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null
$mf = [ordered]@{
    name            = $HostName
    description     = '碧蓝幻想本地缓存程序（跟随浏览器启动/退出）'
    path            = $ExePath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
}
[IO.File]::WriteAllText($ManifestPath, ($mf | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding($false)))

foreach ($k in $regPaths) {
    # New-Item -Value 直接写键的默认值 = 宿主清单 JSON 的绝对路径
    New-Item -Path $k -Value $ManifestPath -Force | Out-Null
}

Write-Host "已注册原生消息宿主：$HostName"
Write-Host "  宿主清单：$ManifestPath"
Write-Host "  程序：$ExePath"
Write-Host "  允许的扩展 ID：$ExtId"
Write-Host ''
Write-Host '下一步（一次性）：'
Write-Host '  1) 在 Edge/Chrome 扩展页里移除旧的「碧蓝幻想本地缓存程序」扩展，重新加载'
Write-Host '     exe-dist\edge-extension 目录（v2.2.0 起扩展 ID 已固定，旧实例的 ID 对不上）。'
Write-Host '  2) 重启浏览器。之后浏览器一开程序就跟上，浏览器一关程序就退。'
Write-Host '  3) 跟随模式下没有托盘与悬浮窗；控制台用侧边栏扩展（console-extension）看，'
Write-Host '     或任何时候手动双击 GBFCache.exe（跟随模式会让位，不冲突）。'
