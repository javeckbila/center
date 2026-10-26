# Runs the center test suites with CT's own Rhino build (extracted from the CT jar).
# Usage (from the modules folder):  powershell -File center\tests\run.ps1
$ErrorActionPreference = "Stop"
$ctJar = "$env:APPDATA\.dawn\profiles\imported-minecraft\private-game-content\mods\ctjs-3.0.0-beta.jar"
$work = Join-Path $env:TEMP "center-tests"
$rhino = Join-Path $work "META-INF\jars\rhino-7c7c509668.jar"
if (-not (Test-Path $rhino)) {
    New-Item -ItemType Directory -Force $work | Out-Null
    Push-Location $work
    try { tar -xf $ctJar "META-INF/jars/rhino-7c7c509668.jar" } finally { Pop-Location }
}
$suites = @("center/tests/run.js", "center/tests/auto-miner.js", "center/tests/auto-farm.js")
$modules = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$failed = 0
Push-Location $modules
try {
    foreach ($suite in $suites) {
        Write-Host "== $suite"
        java -cp $rhino (Join-Path $PSScriptRoot "RhinoRun.java") . $suite
        if ($LASTEXITCODE -ne 0) { $failed++ }
    }
} finally { Pop-Location }
if ($failed -gt 0) { Write-Host "$failed suite(s) failed"; exit 1 }
Write-Host "All suites passed"
exit 0
