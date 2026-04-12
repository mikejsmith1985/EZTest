using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;

public class EZTestLauncher
{
    private const int SERVER_PORT = 7433;
    private const int STARTUP_DELAY_MS = 2500;

    [STAThread]
    public static void Main()
    {
        string exeLocation = System.Reflection.Assembly.GetExecutingAssembly().Location;
        string exeDir = Path.GetDirectoryName(exeLocation);
        string rootDir = FindEzTestRoot(exeDir);

        if (rootDir == null)
        {
            MessageBox.Show(
                "Could not locate the EZTest project folder.\n\nMake sure EZTest.exe is inside the EZTest project directory.",
                "EZTest", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        string distEntry = Path.Combine(rootDir, "dist", "cli", "index.js");

        if (!File.Exists(distEntry))
        {
            DialogResult userChoice = MessageBox.Show(
                "EZTest needs to build for the first time.\nThis takes about 15 seconds and only happens once.\n\nContinue?",
                "EZTest — First-Time Setup", MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (userChoice != DialogResult.OK) return;

            var buildProcess = new Process();
            buildProcess.StartInfo.FileName = "cmd.exe";
            buildProcess.StartInfo.Arguments = "/c npm install && npm run build";
            buildProcess.StartInfo.WorkingDirectory = rootDir;
            buildProcess.StartInfo.UseShellExecute = false;
            buildProcess.StartInfo.CreateNoWindow = true;
            buildProcess.Start();
            buildProcess.WaitForExit();

            if (buildProcess.ExitCode != 0)
            {
                MessageBox.Show(
                    "Build failed. Open a terminal in the EZTest folder and run:\n  npm install\n  npm run build",
                    "EZTest — Build Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
        }

        var nodeProcess = new Process();
        nodeProcess.StartInfo.FileName = "node";
        nodeProcess.StartInfo.Arguments = "\"" + distEntry + "\" ui";
        nodeProcess.StartInfo.WorkingDirectory = rootDir;
        nodeProcess.StartInfo.UseShellExecute = false;
        nodeProcess.StartInfo.CreateNoWindow = true;
        nodeProcess.Start();

        Thread.Sleep(STARTUP_DELAY_MS);

        var browserProcess = new Process();
        browserProcess.StartInfo.FileName = "http://localhost:" + SERVER_PORT;
        browserProcess.StartInfo.UseShellExecute = true;
        browserProcess.Start();
    }

    private static string FindEzTestRoot(string startDir)
    {
        string currentDir = startDir;
        while (!string.IsNullOrEmpty(currentDir))
        {
            string packageJsonPath = Path.Combine(currentDir, "package.json");
            if (File.Exists(packageJsonPath))
            {
                string packageContent = File.ReadAllText(packageJsonPath);
                bool isEzTestPackage = packageContent.Contains("\"name\": \"eztest\"")
                                    || packageContent.Contains("\"name\":\"eztest\"");
                if (isEzTestPackage) return currentDir;
            }
            string parentDir = Path.GetDirectoryName(currentDir);
            if (parentDir == currentDir) break;
            currentDir = parentDir;
        }
        return null;
    }
}
