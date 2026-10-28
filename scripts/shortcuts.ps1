# Create (or refresh) the two desktop shortcuts for this checkout.
#
# They are regenerated from the repo path, so moving the clone only needs `webchat.sh install`
# rather than editing shortcut properties by hand.
#
#   powershell -ExecutionPolicy Bypass -File scripts/shortcuts.ps1 -Root <repo>
#
# The target is `wscript.exe` + `scripts/webchat.vbs`, not `webchat.cmd`: a shortcut pointing at
# a .cmd always shows a console (a shortcut can only minimise it), and two lit cmd icons in the
# taskbar for a server that is already detached is noise. wscript has no window to show.
param(
	[Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = "Stop"

$launcher = Join-Path $Root "scripts\webchat.vbs"
if (-not (Test-Path $launcher)) {
	throw "missing launcher: $launcher"
}

$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$desktop = [Environment]::GetFolderPath("Desktop")
$shell = New-Object -ComObject WScript.Shell
$bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"

$shortcuts = @(
	@{ Name = "omp webchat"; Args = "start"; Desc = "Start the omp-webchat bridge on http://127.0.0.1:7788 and open it"; Icon = $(if (Test-Path $bun) { "$bun,0" } else { "$env:SystemRoot\System32\imageres.dll,98" }) },
	@{ Name = "omp webchat (stop)"; Args = "stop"; Desc = "Stop the omp-webchat bridge and its omp child"; Icon = "$env:SystemRoot\System32\imageres.dll,98" }
)

foreach ($spec in $shortcuts) {
	$path = Join-Path $desktop "$($spec.Name).lnk"
	$link = $shell.CreateShortcut($path)
	$link.TargetPath = $wscript
	$link.Arguments = "`"$launcher`" $($spec.Args)"
	$link.WorkingDirectory = $Root
	$link.IconLocation = $spec.Icon
	$link.Description = $spec.Desc
	$link.Save()
	Write-Output "$path -> $wscript $launcher $($spec.Args)"
}
