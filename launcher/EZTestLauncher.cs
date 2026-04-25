using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

// Assembly metadata — embedded into the PE header so Windows and AV engines
// can verify this is a known, versioned application rather than an anonymous binary.
[assembly: AssemblyTitle("EZTest")]
[assembly: AssemblyDescription("AI-powered Playwright test generation companion")]
[assembly: AssemblyCompany("EZTest Project")]
[assembly: AssemblyProduct("EZTest")]
[assembly: AssemblyCopyright("Copyright \u00a9 2026 EZTest Project")]
[assembly: AssemblyVersion("0.1.3.0")]
[assembly: AssemblyFileVersion("0.1.3.0")]

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

    // Files and directories owned by the portable bundle that the updater replaces.
    // Kept as typed separate lists so rollback logic never needs to guess whether
    // a backed-up item was a file or a directory.
    private static readonly string[] ManagedFileNames = {
        "EZTest.exe", "node.exe", "package.json", "package-lock.json",
        "README.md", "CHANGELOG.md", ".env.example",
    };

    private static readonly string[] ManagedDirectoryNames = { "dist", "node_modules" };

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

        // Remove .rollback items left by the previous successful update.
        // The old EZTest.exe process couldn't delete its own in-use binary, so the
        // new process (this launch) cleans up on its first run.
        CleanupRollbackFiles(rootDirectory);

        ShowPendingUpdateFailureIfPresent(rootDirectory);

        if (TryApplyPendingUpdate(rootDirectory, launcherPath))
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

    // CleanupRollbackFiles deletes any .rollback items left over from the previous
    // successful update. The process that applied that update could not delete its own
    // in-use EZTest.exe, so cleanup is deferred to this (new) launch.
    private static void CleanupRollbackFiles(string rootDirectory)
    {
        foreach (string fileName in ManagedFileNames)
        {
            string rollbackPath = Path.Combine(rootDirectory, fileName + ".rollback");
            try { File.Delete(rollbackPath); } catch { }
        }

        foreach (string dirName in ManagedDirectoryNames)
        {
            string rollbackPath = Path.Combine(rootDirectory, dirName + ".rollback");
            try
            {
                if (Directory.Exists(rollbackPath))
                {
                    Directory.Delete(rollbackPath, recursive: true);
                }
            }
            catch { }
        }
    }

    // TryApplyPendingUpdate applies a staged portable update using only native .NET
    // file operations — no PowerShell scripts, no temp files, no child processes.
    //
    // On Windows, File.Move on a running EXE succeeds because NTFS tracks the
    // directory entry (name) separately from the open file handle. Renaming the
    // current EZTest.exe to EZTest.exe.rollback is safe; the running process keeps
    // its original file handle while the new binary is placed at the same path.
    private static bool TryApplyPendingUpdate(string rootDirectory, string launcherPath)
    {
        string pendingUpdateDir = Path.Combine(
            rootDirectory,
            UpdatesDirectoryName,
            PendingUpdateDirectoryName);

        if (!IsEzTestBundleDirectory(pendingUpdateDir))
        {
            return false;
        }

        string errorMarkerPath = Path.Combine(
            rootDirectory,
            UpdatesDirectoryName,
            FailedUpdateMarkerFileName);

        // Separate typed rollback records so restore logic never needs to infer type.
        var backedUpFiles = new List<string>();
        var backedUpDirectories = new List<string>();

        try
        {
            try { File.Delete(errorMarkerPath); } catch { }

            // Back up existing managed files: rename to <name>.rollback.
            foreach (string fileName in ManagedFileNames)
            {
                string existingPath = Path.Combine(rootDirectory, fileName);
                if (!File.Exists(existingPath))
                {
                    continue;
                }

                string rollbackPath = existingPath + ".rollback";
                if (File.Exists(rollbackPath))
                {
                    File.Delete(rollbackPath);
                }

                File.Move(existingPath, rollbackPath);
                backedUpFiles.Add(existingPath);
            }

            // Back up existing managed directories: rename to <name>.rollback.
            // Directory.Move within the same volume is an atomic NTFS rename.
            foreach (string dirName in ManagedDirectoryNames)
            {
                string existingPath = Path.Combine(rootDirectory, dirName);
                if (!Directory.Exists(existingPath))
                {
                    continue;
                }

                string rollbackPath = existingPath + ".rollback";
                if (Directory.Exists(rollbackPath))
                {
                    Directory.Delete(rollbackPath, recursive: true);
                }

                Directory.Move(existingPath, rollbackPath);
                backedUpDirectories.Add(existingPath);
            }

            // Install new managed files from the staged bundle.
            foreach (string fileName in ManagedFileNames)
            {
                string sourcePath = Path.Combine(pendingUpdateDir, fileName);
                if (!File.Exists(sourcePath))
                {
                    continue;
                }

                File.Copy(sourcePath, Path.Combine(rootDirectory, fileName));
            }

            // Install new managed directories from the staged bundle.
            // Moving from updates/pending-portable-update/ to the root is always
            // same-volume, so Directory.Move is an atomic NTFS rename.
            foreach (string dirName in ManagedDirectoryNames)
            {
                string sourcePath = Path.Combine(pendingUpdateDir, dirName);
                if (!Directory.Exists(sourcePath))
                {
                    continue;
                }

                Directory.Move(sourcePath, Path.Combine(rootDirectory, dirName));
            }

            // Remove the (now mostly empty) pending update directory.
            try { Directory.Delete(pendingUpdateDir, recursive: true); } catch { }

            // Launch the newly installed EZTest.exe and exit this (old) process.
            // The new process will call CleanupRollbackFiles() on startup to remove
            // the .rollback backups we left behind.
            Process.Start(launcherPath);
            return true;
        }
        catch (Exception updateError)
        {
            // Best-effort rollback: restore every item that was successfully backed up.
            foreach (string originalPath in backedUpFiles)
            {
                string rollbackPath = originalPath + ".rollback";
                try
                {
                    if (File.Exists(rollbackPath))
                    {
                        if (File.Exists(originalPath))
                        {
                            File.Delete(originalPath);
                        }
                        File.Move(rollbackPath, originalPath);
                    }
                }
                catch { }
            }

            foreach (string originalPath in backedUpDirectories)
            {
                string rollbackPath = originalPath + ".rollback";
                try
                {
                    if (Directory.Exists(rollbackPath))
                    {
                        if (Directory.Exists(originalPath))
                        {
                            Directory.Delete(originalPath, recursive: true);
                        }
                        Directory.Move(rollbackPath, originalPath);
                    }
                }
                catch { }
            }

            // Write the failure reason so the next launch can display it.
            try
            {
                Directory.CreateDirectory(Path.Combine(rootDirectory, UpdatesDirectoryName));
                File.WriteAllText(errorMarkerPath, updateError.Message);
            }
            catch { }

            // Remove the broken pending update so we don't retry it next launch.
            try { Directory.Delete(pendingUpdateDir, recursive: true); } catch { }

            return false;
        }
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
