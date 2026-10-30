Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W2 {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$p = Get-Process BianQian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'no-window'; exit }
[W2]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, 200, 60, 1049, 700, 0x0040) | Out-Null
[W2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900
$r = New-Object RECT
[W2]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$wd = $r.R - $r.L; $ht = $r.B - $r.T
$b = New-Object System.Drawing.Bitmap($wd, $ht)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size)
$b.Save("$env:TEMP\bianqian-shot5.png")
Write-Output "captured $wd x $ht"
