# Builds EZTest.exe using the .NET Framework C# compiler (csc.exe) built into Windows.
# No .NET SDK installation is required — this relies on the framework compiler at v4.0.30319.
# Run via: npm run build:launcher

$cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$sourceFile = "$PSScriptRoot\EZTestLauncher.cs"
$outputExe = "$PSScriptRoot\..\EZTest.exe"

if (-not (Test-Path $cscPath)) {
    Write-Error ".NET Framework C# compiler not found at: $cscPath"
    exit 1
}

Write-Host "Compiling EZTest.exe..."

& $cscPath `
    /out:"$outputExe" `
    /target:winexe `
    /reference:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Windows.Forms.dll" `
    /reference:"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Drawing.dll" `
    "$sourceFile"

if ($LASTEXITCODE -eq 0) {
    $exeItem = Get-Item $outputExe
    Write-Host "SUCCESS: EZTest.exe built ($([math]::Round($exeItem.Length / 1024, 1)) KB)" -ForegroundColor Green
} else {
    Write-Error "Compilation failed (exit code $LASTEXITCODE)"
    exit $LASTEXITCODE
}
