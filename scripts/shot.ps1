Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$p = Get-Process BianQian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'no-window'; exit }
[W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object RECT
[W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$wd = $r.R - $r.L
$ht = $r.B - $r.T
$b = New-Object System.Drawing.Bitmap($wd, $ht)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size)
$b.Save("$env:TEMP\bianqian-shot4.png")
Write-Output "captured $wd x $ht"
