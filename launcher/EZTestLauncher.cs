using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

// EZTest Windows launcher — starts the portable bundle from any extracted folder
// and applies previously downloaded updates before opening the browser UI.
public class EZTestLauncher
{
    private const int ServerPort = 7433;
    private const int ServerStartupTimeoutMs = 15000;
    private const int ServerPollIntervalMs = 250;
    private const string UpdatesDirectoryName = "updates";
    private const string PendingUpdateDirectoryName = "pending-portable-update";
    private const string FailedUpdateMarkerFileName = "last-update-error.txt";

    [STAThread]
    public static void Main()
    {
        string launcherPath = GetLauncherPath();
        string launcherDirectory = Path.GetDirectoryName(launcherPath);
        string rootDirectory = FindEzTestRoot(launcherDirectory);

        if (rootDirectory == null)
        {
            ShowMissingBundleMessage();
            return;
        }

        ShowPendingUpdateFailureIfPresent(rootDirectory);

        if (TryApplyPendingUpdateAndExit(rootDirectory, launcherPath))
        {
            return;
        }

        string distEntryPath = Path.Combine(rootDirectory, "dist", "cli", "index.js");
        if (!File.Exists(distEntryPath) && !TryBuildMissingDist(rootDirectory))
        {
            return;
        }

        if (!Directory.Exists(Path.Combine(rootDirectory, "node_modules")))
        {
            ShowIncompleteBundleMessage("node_modules");
            return;
        }

        string nodeExecutablePath = ResolveNodeExecutablePath(rootDirectory);
        if (nodeExecutablePath == null)
        {
            MessageBox.Show(
                "Could not find a Node.js runtime.\n\n" +
                "The portable release must include node.exe, or Node.js must be installed and available on PATH.",
                "EZTest", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        if (IsServerReady())
        {
            OpenBrowser();
            return;
        }

        Process serverProcess = StartServerProcess(rootDirectory, nodeExecutablePath, distEntryPath);
        if (serverProcess == null)
        {
            return;
        }

        if (!WaitForServerReady(serverProcess))
        {
            ShowServerStartupError(serverProcess);
            return;
        }

        OpenBrowser();
    }

    private static string GetLauncherPath()
    {
        return Process.GetCurrentProcess().MainModule.FileName;
    }

    private static void ShowMissingBundleMessage()
    {
        MessageBox.Show(
            "Could not find a valid EZTest bundle next to this launcher.\n\n" +
            "Use the Windows portable release zip, extract the full folder anywhere you want, and run EZTest.exe from that extracted folder.",
            "EZTest", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static void ShowIncompleteBundleMessage(string missingItemDescription)
    {
        MessageBox.Show(
            "This EZTest bundle is incomplete.\n\nMissing required runtime item: " + missingItemDescription + "\n\n" +
            "Re-download the latest Windows portable release and extract the full zip before launching EZTest.exe.",
            "EZTest", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static bool TryBuildMissingDist(string rootDirectory)
    {
        bool hasSourceCheckout = File.Exists(Path.Combine(rootDirectory, "src", "cli", "index.ts"));
        if (!hasSourceCheckout)
        {
            ShowIncompleteBundleMessage(@"dist\cli\index.js");
            return false;
        }

        DialogResult userChoice = MessageBox.Show(
            "EZTest needs to build for the first time.\n" +
            "This only applies to a source checkout and can take a short moment.\n\nContinue?",
            "EZTest — First-Time Setup", MessageBoxButtons.OKCancel, MessageBoxIcon.Information);

        if (userChoice != DialogResult.OK)
        {
            return false;
        }

        var buildProcess = new Process();
        buildProcess.StartInfo.FileName = "cmd.exe";
        buildProcess.StartInfo.Arguments = "/c npm install && npm run build";
        buildProcess.StartInfo.WorkingDirectory = rootDirectory;
        buildProcess.StartInfo.UseShellExecute = false;
        buildProcess.StartInfo.CreateNoWindow = true;
        buildProcess.Start();
        buildProcess.WaitForExit();

        if (buildProcess.ExitCode == 0)
        {
            return true;
        }

        MessageBox.Show(
            "Build failed. Open a terminal in the EZTest folder and run:\n  npm install\n  npm run build",
            "EZTest — Build Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return false;
    }

    private static string ResolveNodeExecutablePath(string rootDirectory)
    {
        string bundledNodePath = Path.Combine(rootDirectory, "node.exe");
        if (File.Exists(bundledNodePath))
        {
            return bundledNodePath;
        }

        return CanStartProcess("node", "--version") ? "node" : null;
    }

    private static bool CanStartProcess(string fileName, string arguments)
    {
        try
        {
            var probeProcess = new Process();
            probeProcess.StartInfo.FileName = fileName;
            probeProcess.StartInfo.Arguments = arguments;
            probeProcess.StartInfo.UseShellExecute = false;
            probeProcess.StartInfo.CreateNoWindow = true;
            probeProcess.StartInfo.RedirectStandardError = true;
            probeProcess.StartInfo.RedirectStandardOutput = true;
            probeProcess.Start();
            probeProcess.WaitForExit(3000);
            return !probeProcess.HasExited || probeProcess.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static Process StartServerProcess(
        string rootDirectory,
        string nodeExecutablePath,
        string distEntryPath)
    {
        try
        {
            var serverProcess = new Process();
            serverProcess.StartInfo.FileName = nodeExecutablePath;
            serverProcess.StartInfo.Arguments = "\"" + distEntryPath + "\" ui";
            serverProcess.StartInfo.WorkingDirectory = rootDirectory;
            serverProcess.StartInfo.UseShellExecute = false;
            serverProcess.StartInfo.CreateNoWindow = true;
            serverProcess.Start();
            return serverProcess;
        }
        catch (Exception startupError)
        {
            MessageBox.Show(
                "EZTest could not start its local server.\n\n" + startupError.Message,
                "EZTest", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return null;
        }
    }

    private static bool WaitForServerReady(Process serverProcess)
    {
        int waitedMilliseconds = 0;

        while (waitedMilliseconds < ServerStartupTimeoutMs)
        {
            if (IsServerReady())
            {
                return true;
            }

            if (serverProcess.HasExited)
            {
                return false;
            }

            Thread.Sleep(ServerPollIntervalMs);
            waitedMilliseconds += ServerPollIntervalMs;
        }

        return IsServerReady();
    }

    private static bool IsServerReady()
    {
        try
        {
            var serverRequest = (HttpWebRequest)WebRequest.Create(
                "http://localhost:" + ServerPort + "/api/status");
            serverRequest.Method = "GET";
            serverRequest.Timeout = 1000;
            serverRequest.ReadWriteTimeout = 1000;

            using (var serverResponse = (HttpWebResponse)serverRequest.GetResponse())
            {
                return serverResponse.StatusCode == HttpStatusCode.OK;
            }
        }
        catch
        {
            return false;
        }
    }

    private static void ShowServerStartupError(Process serverProcess)
    {
        string message =
            "EZTest started but the local browser UI did not become ready in time.\n\n" +
            "If you downloaded the portable release, re-extract the full zip and try again.";

        if (serverProcess.HasExited)
        {
            message += "\n\nThe EZTest server process exited early with code " + serverProcess.ExitCode + ".";
        }

        MessageBox.Show(message, "EZTest", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private static void OpenBrowser()
    {
        var browserProcess = new Process();
        browserProcess.StartInfo.FileName = "http://localhost:" + ServerPort;
        browserProcess.StartInfo.UseShellExecute = true;
        browserProcess.Start();
    }

    private static void ShowPendingUpdateFailureIfPresent(string rootDirectory)
    {
        string failedUpdateMarkerPath = Path.Combine(
            rootDirectory,
            UpdatesDirectoryName,
            FailedUpdateMarkerFileName);

        if (!File.Exists(failedUpdateMarkerPath))
        {
            return;
        }

        string failureMessage = File.ReadAllText(failedUpdateMarkerPath).Trim();
        File.Delete(failedUpdateMarkerPath);

        if (string.IsNullOrEmpty(failureMessage))
        {
            failureMessage = "The previous EZTest update could not be applied.";
        }

        MessageBox.Show(
            "EZTest restored the previous version because the downloaded update could not be applied.\n\n" +
            failureMessage,
            "EZTest — Update Warning", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private static bool TryApplyPendingUpdateAndExit(string rootDirectory, string launcherPath)
    {
        string pendingUpdateDirectory = Path.Combine(
            rootDirectory,
            UpdatesDirectoryName,
            PendingUpdateDirectoryName);

        if (!IsEzTestBundleDirectory(pendingUpdateDirectory))
        {
            return false;
        }

        string tempScriptPath = Path.Combine(
            Path.GetTempPath(),
            "eztest-apply-update-" + Guid.NewGuid().ToString("N") + ".ps1");

        File.WriteAllText(
            tempScriptPath,
            BuildPendingUpdateScriptContent(rootDirectory, pendingUpdateDirectory, launcherPath));

        var updateScriptProcess = new Process();
        updateScriptProcess.StartInfo.FileName = "powershell.exe";
        updateScriptProcess.StartInfo.Arguments =
            "-NoProfile -ExecutionPolicy Bypass -File \"" + tempScriptPath + "\"";
        updateScriptProcess.StartInfo.WorkingDirectory = rootDirectory;
        updateScriptProcess.StartInfo.UseShellExecute = false;
        updateScriptProcess.StartInfo.CreateNoWindow = true;
        updateScriptProcess.Start();

        return true;
    }

    private static string BuildPendingUpdateScriptContent(
        string rootDirectory,
        string pendingUpdateDirectory,
        string launcherPath)
    {
        string failedUpdateMarkerPath = Path.Combine(
            rootDirectory,
            UpdatesDirectoryName,
            FailedUpdateMarkerFileName);

        return
            "$managedItems = @('dist', 'node_modules', 'EZTest.exe', 'node.exe', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', '.env.example')\r\n" +
            "$rollbackItems = @()\r\n" +
            "Start-Sleep -Seconds 2\r\n" +
            "try {\r\n" +
            "  Remove-Item -LiteralPath '" + EscapePowerShellString(failedUpdateMarkerPath) + "' -Force -ErrorAction SilentlyContinue\r\n" +
            "  foreach ($managedItem in $managedItems) {\r\n" +
            "    $sourcePath = Join-Path '" + EscapePowerShellString(rootDirectory) + "' $managedItem\r\n" +
            "    $rollbackPath = Join-Path '" + EscapePowerShellString(rootDirectory) + "' ($managedItem + '.rollback')\r\n" +
            "    if (Test-Path -LiteralPath $rollbackPath) { Remove-Item -LiteralPath $rollbackPath -Recurse -Force }\r\n" +
            "    if (Test-Path -LiteralPath $sourcePath) {\r\n" +
            "      Move-Item -LiteralPath $sourcePath -Destination $rollbackPath -Force\r\n" +
            "      $rollbackItems += @{ SourcePath = $sourcePath; RollbackPath = $rollbackPath }\r\n" +
            "    }\r\n" +
            "  }\r\n" +
            "  robocopy '" + EscapePowerShellString(pendingUpdateDirectory) + "' '" + EscapePowerShellString(rootDirectory) + "' /E /NFL /NDL /NJH /NJS /NP > $null\r\n" +
            "  if ($LASTEXITCODE -ge 8) { throw ('robocopy failed with exit code ' + $LASTEXITCODE) }\r\n" +
            "  foreach ($rollbackItem in $rollbackItems) {\r\n" +
            "    if (Test-Path -LiteralPath $rollbackItem.RollbackPath) {\r\n" +
            "      Remove-Item -LiteralPath $rollbackItem.RollbackPath -Recurse -Force\r\n" +
            "    }\r\n" +
            "  }\r\n" +
            "  Remove-Item -LiteralPath '" + EscapePowerShellString(pendingUpdateDirectory) + "' -Recurse -Force -ErrorAction SilentlyContinue\r\n" +
            "}\r\n" +
            "catch {\r\n" +
            "  foreach ($rollbackItem in $rollbackItems) {\r\n" +
            "    if (Test-Path -LiteralPath $rollbackItem.SourcePath) {\r\n" +
            "      Remove-Item -LiteralPath $rollbackItem.SourcePath -Recurse -Force -ErrorAction SilentlyContinue\r\n" +
            "    }\r\n" +
            "    if (Test-Path -LiteralPath $rollbackItem.RollbackPath) {\r\n" +
            "      Move-Item -LiteralPath $rollbackItem.RollbackPath -Destination $rollbackItem.SourcePath -Force\r\n" +
            "    }\r\n" +
            "  }\r\n" +
            "  Set-Content -LiteralPath '" + EscapePowerShellString(failedUpdateMarkerPath) + "' -Value $_.Exception.Message -Encoding UTF8\r\n" +
            "  Remove-Item -LiteralPath '" + EscapePowerShellString(pendingUpdateDirectory) + "' -Recurse -Force -ErrorAction SilentlyContinue\r\n" +
            "}\r\n" +
            "Start-Process -FilePath '" + EscapePowerShellString(launcherPath) + "'\r\n";
    }

    private static string EscapePowerShellString(string rawValue)
    {
        return rawValue.Replace("'", "''");
    }

    private static string FindEzTestRoot(string startDirectory)
    {
        string currentDirectory = startDirectory;

        while (!string.IsNullOrEmpty(currentDirectory))
        {
            if (IsEzTestBundleDirectory(currentDirectory))
            {
                return currentDirectory;
            }

            string parentDirectory = Path.GetDirectoryName(currentDirectory);
            if (string.IsNullOrEmpty(parentDirectory) || parentDirectory == currentDirectory)
            {
                break;
            }

            currentDirectory = parentDirectory;
        }

        return null;
    }

    private static bool IsEzTestBundleDirectory(string candidateDirectory)
    {
        if (string.IsNullOrEmpty(candidateDirectory))
        {
            return false;
        }

        string packageJsonPath = Path.Combine(candidateDirectory, "package.json");
        string cliEntryPath = Path.Combine(candidateDirectory, "dist", "cli", "index.js");

        if (!File.Exists(packageJsonPath) || !File.Exists(cliEntryPath))
        {
            return false;
        }

        string packageContent = File.ReadAllText(packageJsonPath);
        return packageContent.Contains("\"name\": \"eztest\"")
            || packageContent.Contains("\"name\":\"eztest\"");
    }
}
