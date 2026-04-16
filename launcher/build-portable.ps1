# Builds the portable Windows release bundle for EZTest and zips it for GitHub releases.

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseRoot = Join-Path $repoRoot "release"
$portableBundleRoot = Join-Path $releaseRoot "EZTest-windows-portable"
$portableZipPath = Join-Path $releaseRoot "EZTest-windows-portable.zip"
$bundledNodePath = (Get-Command node -ErrorAction Stop).Source

$requiredPaths = @(
    (Join-Path $repoRoot "EZTest.exe"),
    (Join-Path $repoRoot "dist"),
    (Join-Path $repoRoot "node_modules"),
    (Join-Path $repoRoot "package.json")
)

foreach ($requiredPath in $requiredPaths) {
    if (-not (Test-Path $requiredPath)) {
        Write-Error "Missing required build artifact: $requiredPath"
        exit 1
    }
}

if (Test-Path $portableBundleRoot) {
    Remove-Item $portableBundleRoot -Recurse -Force
}

if (Test-Path $portableZipPath) {
    Remove-Item $portableZipPath -Force
}

New-Item -ItemType Directory -Path $portableBundleRoot -Force | Out-Null

$copyMap = @(
    @{ Source = (Join-Path $repoRoot "EZTest.exe"); Destination = "EZTest.exe" },
    @{ Source = $bundledNodePath; Destination = "node.exe" },
    @{ Source = (Join-Path $repoRoot "dist"); Destination = "dist" },
    @{ Source = (Join-Path $repoRoot "node_modules"); Destination = "node_modules" },
    @{ Source = (Join-Path $repoRoot "package.json"); Destination = "package.json" },
    @{ Source = (Join-Path $repoRoot "package-lock.json"); Destination = "package-lock.json" },
    @{ Source = (Join-Path $repoRoot "README.md"); Destination = "README.md" },
    @{ Source = (Join-Path $repoRoot "CHANGELOG.md"); Destination = "CHANGELOG.md" }
)

foreach ($copyItem in $copyMap) {
    $destinationPath = Join-Path $portableBundleRoot $copyItem.Destination
    if (Test-Path $copyItem.Source -PathType Container) {
        Copy-Item $copyItem.Source $destinationPath -Recurse -Force
    } else {
        Copy-Item $copyItem.Source $destinationPath -Force
    }
}

$envExamplePath = Join-Path $repoRoot ".env.example"
if (Test-Path $envExamplePath) {
    Copy-Item $envExamplePath (Join-Path $portableBundleRoot ".env.example") -Force
}

Push-Location $portableBundleRoot
try {
    tar.exe -a -cf $portableZipPath *
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Portable zip creation failed (exit code $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

$bundleSizeMb = [math]::Round(((Get-Item $portableZipPath).Length / 1MB), 2)
Write-Host "SUCCESS: Portable bundle created at $portableZipPath ($bundleSizeMb MB)" -ForegroundColor Green
