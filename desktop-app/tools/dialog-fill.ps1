param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$TimeoutSeconds = 30
)

<#
  Drives a native file dialog without relying on the keyboard focus:
    1. locate the dialog window (#32770) owned by the target process,
    2. write the full path into the file name edit control (WM_SETTEXT),
    3. activate the default button (control id 1) with BM_CLICK.
  Falls back to foreground + SendKeys when the control ids are not the classic ones.
#>

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class DialogApi {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    public static List<IntPtr> Children(IntPtr parent) {
        var result = new List<IntPtr>();
        EnumChildWindows(parent, (h, l) => { result.Add(h); return true; }, IntPtr.Zero);
        return result;
    }

    public static IntPtr FindDialog(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner != pid || !IsWindowVisible(h)) return true;
            var name = new StringBuilder(128);
            GetClassName(h, name, name.Capacity);
            if (name.ToString() == "#32770") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string ClassOf(IntPtr h) {
        var name = new StringBuilder(128);
        GetClassName(h, name, name.Capacity);
        return name.ToString();
    }

    public static string TextOf(IntPtr h) {
        var text = new StringBuilder(512);
        GetWindowText(h, text, text.Capacity);
        return text.ToString();
    }
}
"@

$dialog = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline -and $dialog -eq [IntPtr]::Zero) {
  $dialog = [DialogApi]::FindDialog([uint32]$ProcessId)
  if ($dialog -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 300 }
}

if ($dialog -eq [IntPtr]::Zero) {
  Write-Output "DIALOG_NOT_FOUND"
  exit 2
}

# 1. give the dialog a moment to finish building its controls
Start-Sleep -Milliseconds 700

$children = [DialogApi]::Children($dialog)
$edit = $children | Where-Object { [DialogApi]::ClassOf($_) -eq 'Edit' -and [DialogApi]::IsWindowVisible($_) } | Select-Object -Last 1

if (-not $edit) {
  Write-Output "EDIT_NOT_FOUND"
  exit 3
}

[void][DialogApi]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $Path)
Start-Sleep -Milliseconds 500

# 2. click the default button (control id 1 = IDOK) or the Open/OK caption
$button = $children | Where-Object {
  $class = [DialogApi]::ClassOf($_)
  if ($class -ne 'Button' -or -not [DialogApi]::IsWindowVisible($_)) { return $false }
  $id = [DialogApi]::GetDlgCtrlID($_)
  if ($id -eq 1) { return $true }
  $caption = [DialogApi]::TextOf($_)
  return ($caption -match '^(Open|OK)$')
} | Select-Object -First 1

if ($button) {
  [void][DialogApi]::SendMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)   # BM_CLICK
} else {
  [void][DialogApi]::ShowWindow($dialog, 9)
  [void][DialogApi]::SetForegroundWindow($dialog)
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
}

Start-Sleep -Milliseconds 600
if ([DialogApi]::IsWindow($dialog)) {
  Write-Output "DIALOG_STILL_OPEN"
  exit 4
}

Write-Output "DIALOG_SUBMITTED"
