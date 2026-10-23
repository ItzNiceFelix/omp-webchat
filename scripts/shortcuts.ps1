# Create (or refresh) the two desktop shortcuts for this checkout.
#
# They are regenerated from the repo path, so moving the clone only needs `webchat.sh install`
# rather than editing shortcut properties by hand.
#
#   powershell -ExecutionPolicy Bypass -File scripts/shortcuts.ps1 -Root <repo>
param(
	[Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = "Stop"

$shim = Join-Path $Root "scripts\webchat.cmd"
if (-not (Test-Path $shim)) {
	throw "missing launcher: $shim"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shell = New-Object -ComObject WScript.Shell
$bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"

# Start: minimized, because the launcher prints one line and exits once the port answers.
# Stop: normal window so the "stopped" line stays readable for a moment.
$shortcuts = @(
	@{ Name = "omp webchat"; Args = "start"; Desc = "Start the omp-webchat bridge on http://127.0.0.1:7788 and open it"; Icon = $(if (Test-Path $bun) { "$bun,0" } else { "$env:SystemRoot\System32\imageres.dll,98" }); Style = 7 },
	@{ Name = "omp webchat (stop)"; Args = "stop"; Desc = "Stop the omp-webchat bridge and its omp child"; Icon = "$env:SystemRoot\System32\imageres.dll,98"; Style = 1 }
)

foreach ($spec in $shortcuts) {
	$path = Join-Path $desktop "$($spec.Name).lnk"
	$link = $shell.CreateShortcut($path)
	$link.TargetPath = $shim
	$link.Arguments = $spec.Args
	$link.WorkingDirectory = $Root
	$link.IconLocation = $spec.Icon
	$link.WindowStyle = $spec.Style
	$link.Description = $spec.Desc
	$link.Save()
	Write-Output "$path -> $shim $($spec.Args)"
}
