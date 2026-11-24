<#
.SYNOPSIS
    Build native/windows/DSHFloatPanel.exe with the in-box .NET Framework compiler.

.DESCRIPTION
    The Windows shell is a single C# file plus the WebView2 SDK assemblies. There
    is no project file and no SDK requirement: Windows ships the C# 5 compiler
    and the WPF assemblies, so anyone (including a CI runner on a stock Windows
    image) can reproduce the committed binary with this script.

    The WebView2 SDK is committed next to this script; if it is missing, the
    script downloads the NuGet package once and extracts only the assemblies the
    shell needs.

.PARAMETER Version
    WebView2 SDK version to fetch when the assemblies are missing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File native/windows/build.ps1
#>
[CmdletBinding()]
param(
    [string]$Version = '1.0.3351.48',
    [switch]$Console
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    # ── 1. the C# compiler that ships with .NET Framework ──
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $csc)) {
        $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    }
    if (-not (Test-Path $csc)) {
        throw '找不到 .NET Framework 的 csc.exe（需要 .NET Framework 4.x，Windows 10/11 自带）。'
    }

    # ── 2. WebView2 SDK assemblies (committed; fetched only when absent) ──
    $core = Join-Path $here 'Microsoft.Web.WebView2.Core.dll'
    $wpf = Join-Path $here 'Microsoft.Web.WebView2.Wpf.dll'
    if (-not (Test-Path $core) -or -not (Test-Path $wpf)) {
        Write-Host "下载 WebView2 SDK $Version ..."
        $stamp = [Guid]::NewGuid().ToString('N')
        $work = Join-Path $env:TEMP "dsh-float-panel-wv2-$stamp"
        New-Item -ItemType Directory -Path $work | Out-Null
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"
            $nupkg = Join-Path $work 'wv2.nupkg'
            Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing
            $zip = Join-Path $work 'wv2.zip'
            Copy-Item $nupkg $zip
            Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'x') -Force
            $root = Join-Path $work 'x'
            Copy-Item (Join-Path $root 'lib\net462\Microsoft.Web.WebView2.Core.dll') $here -Force
            Copy-Item (Join-Path $root 'lib\net462\Microsoft.Web.WebView2.Wpf.dll') $here -Force
            Copy-Item (Join-Path $root 'LICENSE.txt') (Join-Path $here 'WEBVIEW2-LICENSE.txt') -Force
            New-Item -ItemType Directory -Path (Join-Path $here 'x64') -Force | Out-Null
            New-Item -ItemType Directory -Path (Join-Path $here 'arm64') -Force | Out-Null
            Copy-Item (Join-Path $root 'runtimes\win-x64\native\WebView2Loader.dll') (Join-Path $here 'x64') -Force
            Copy-Item (Join-Path $root 'runtimes\win-arm64\native\WebView2Loader.dll') (Join-Path $here 'arm64') -Force
        }
        finally {
            Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
        }
    }

    # ── 3. framework assemblies, located through the GAC ──
    # csc.rsp already references the base framework assemblies; only the WPF
    # ones (which live in the GAC, not beside csc.exe) are added here.
    $names = @(
        'WindowsBase', 'PresentationCore', 'PresentationFramework', 'System.Xaml'
    )
    $references = New-Object System.Collections.Generic.List[string]
    foreach ($name in $names) {
        $loaded = [System.Reflection.Assembly]::LoadWithPartialName($name)
        if ($null -eq $loaded) { throw "找不到程序集 $name。" }
        $references.Add($loaded.Location)
    }
    $references.Add($core)
    $references.Add($wpf)

    # ── 4. compile ──
    $target = '/target:winexe'
    $output = 'DSHFloatPanel.exe'
    $debug = '/debug-'
    if ($Console) {
        # A console subsystem build prints startup failures to the terminal; the
        # shipped shell is a winexe so no console window ever flashes.
        $target = '/target:exe'
        $output = 'DSHFloatPanel-debug.exe'
        $debug = '/debug+'
    }

    $arguments = @(
        '/nologo',
        $target,
        '/platform:anycpu',
        '/optimize+',
        $debug,
        ('/win32manifest:' + (Join-Path $here 'app.manifest')),
        ('/out:' + (Join-Path $here $output))
    )
    foreach ($reference in $references) { $arguments += ('/reference:' + $reference) }
    $arguments += (Join-Path $here 'Panel.cs')

    & $csc $arguments
    if ($LASTEXITCODE -ne 0) { throw "csc 编译失败（退出码 $LASTEXITCODE）。" }

    $exe = Join-Path $here $output
    Write-Host ("已生成 {0}（{1:N0} 字节）" -f $exe, (Get-Item $exe).Length)
}
finally {
    Pop-Location
}
