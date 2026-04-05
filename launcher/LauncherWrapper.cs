using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class LauncherWrapper
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        try
        {
            string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string scriptPath = Path.Combine(baseDirectory, "launcher", "Launcher.ps1");

            if (!File.Exists(scriptPath))
            {
                MessageBox.Show(
                    "Launcher.ps1 was not found.\nExpected path:\n" + scriptPath,
                    "Project Launcher",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            var argumentsBuilder = new StringBuilder();
            argumentsBuilder.Append("-NoProfile -ExecutionPolicy Bypass -File ");
            argumentsBuilder.Append('"').Append(scriptPath).Append('"');

            foreach (string argument in args)
            {
                argumentsBuilder.Append(' ').Append('"').Append(argument.Replace("\"", "\\\"")).Append('"');
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = argumentsBuilder.ToString(),
                WorkingDirectory = baseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                ex.Message,
                "Project Launcher",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }
}
