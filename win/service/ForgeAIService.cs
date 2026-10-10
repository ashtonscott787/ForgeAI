// ForgeAIService — a small Windows service that runs ForgeAI headless in the background as the machine,
// before anyone logs in, with one copy per computer. It launches ForgeAI.exe in Node mode
// (ELECTRON_RUN_AS_NODE=1, running resources\app\headless.js --worker --service) and keeps it alive.
// Built for .NET Framework 4.x, which ships with Windows. Installed/removed with sc.exe by the ForgeAI installer.
//
//   ForgeAIService.exe            run as a service (what the SCM calls)
//   ForgeAIService.exe --console  run the child in the foreground, for testing
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

public class ForgeAIService : ServiceBase
{
    private Process child;
    private Thread guardian;
    private volatile bool stopping;
    private readonly string baseDir;
    private readonly string dataDir;

    public ForgeAIService()
    {
        ServiceName = "ForgeAI";
        CanShutdown = true;
        baseDir = AppDomain.CurrentDomain.BaseDirectory; // ...\ForgeAI
        string pd = Environment.GetEnvironmentVariable("ProgramData");
        if (string.IsNullOrEmpty(pd)) pd = @"C:\ProgramData";
        dataDir = Path.Combine(pd, "ForgeAI", "data");
    }

    public static void Main(string[] args)
    {
        var svc = new ForgeAIService();
        if (args.Length > 0 && (args[0] == "--console" || args[0] == "-c"))
        {
            Console.WriteLine("ForgeAI service (console mode). Ctrl+C to stop.");
            svc.StartChildLoop();
            Console.CancelKeyPress += (s, e) => { svc.stopping = true; svc.KillChild(); };
            Thread.Sleep(Timeout.Infinite);
        }
        else
        {
            ServiceBase.Run(svc);
        }
    }

    protected override void OnStart(string[] args) { stopping = false; StartChildLoop(); }
    protected override void OnShutdown() { OnStop(); }
    protected override void OnStop()
    {
        stopping = true;
        KillChild();
        if (guardian != null) guardian.Join(5000);
    }

    private void StartChildLoop()
    {
        guardian = new Thread(Guard) { IsBackground = true };
        guardian.Start();
    }

    // Keep ForgeAI running: start it, and if it exits while we are not stopping, start it again (backoff up to 30s).
    private void Guard()
    {
        int backoff = 2000;
        while (!stopping)
        {
            try
            {
                Spawn();
                child.WaitForExit();
            }
            catch (Exception e) { Log("start failed: " + e.Message); }
            if (stopping) break;
            Log("ForgeAI exited; restarting in " + (backoff / 1000) + "s");
            for (int i = 0; i < backoff && !stopping; i += 200) Thread.Sleep(200);
            backoff = Math.Min(30000, backoff + 4000);
        }
    }

    private void Spawn()
    {
        string exe = Path.Combine(baseDir, "ForgeAI.exe");
        string script = Path.Combine(baseDir, "resources", "app", "headless.js");
        if (!File.Exists(exe)) throw new FileNotFoundException("ForgeAI.exe not found next to the service", exe);
        if (!File.Exists(script)) throw new FileNotFoundException("headless.js not found", script);
        Directory.CreateDirectory(dataDir);

        var psi = new ProcessStartInfo
        {
            FileName = exe,
            // --worker: shareable; --service: managed mode (loopback-only local UI, setup disabled)
            Arguments = "\"" + script + "\" --worker --service",
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = baseDir
        };
        psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        psi.EnvironmentVariables["AICORE_DATA"] = dataDir;
        psi.EnvironmentVariables["FORGEAI_SERVICE"] = "1";
        child = Process.Start(psi);
        Log("ForgeAI started (pid " + child.Id + "), data " + dataDir);
    }

    private void KillChild()
    {
        try
        {
            if (child != null && !child.HasExited)
            {
                // Kill the whole tree so llama-server / engine children go too.
                var kill = new ProcessStartInfo("taskkill", "/PID " + child.Id + " /T /F")
                    { UseShellExecute = false, CreateNoWindow = true };
                Process.Start(kill).WaitForExit(8000);
            }
        }
        catch { }
    }

    private void Log(string msg)
    {
        try
        {
            Directory.CreateDirectory(dataDir);
            File.AppendAllText(Path.Combine(dataDir, "service.log"),
                DateTime.Now.ToString("s") + "  " + msg + Environment.NewLine);
        }
        catch { }
    }
}
