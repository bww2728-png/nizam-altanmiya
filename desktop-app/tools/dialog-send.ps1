param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Text,
  [int]$TimeoutSeconds = 20
)

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class WinApi {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);

    public static List<IntPtr> FindDialogs(uint pid) {
        var result = new List<IntPtr>();
        EnumWindows((h, l) => {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner != pid || !IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            if (sb.ToString() == "#32770") result.Add(h);
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

$handle = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline -and $handle -eq [IntPtr]::Zero) {
  $dialogs = [WinApi]::FindDialogs([uint32]$ProcessId)
  if ($dialogs.Count -gt 0) { $handle = $dialogs[$dialogs.Count - 1] }
  else { Start-Sleep -Milliseconds 400 }
}

if ($handle -eq [IntPtr]::Zero) {
  Write-Output "DIALOG_NOT_FOUND"
  exit 2
}

[void][WinApi]::ShowWindow($handle, 9)
[void][WinApi]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait($Text)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Write-Output "DIALOG_SUBMITTED"
