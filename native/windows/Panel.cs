/**
 * DSH Float Panel — Windows shell.
 *
 * The Windows counterpart of native/main.swift: a borderless, always-on-top,
 * non-activating window that hosts the panel page served by the dsh-float-panel
 * host plugin. The page owns the UI and the state feed; this shell only owns
 * the window (position, size, drag, focus behaviour) and the page→shell
 * messages, exactly like the AppKit shell does on macOS.
 *
 * Usage: DSHFloatPanel.exe <url> <state-dir>
 *
 * Built by build.ps1 with the in-box .NET Framework compiler, so installing the
 * plugin needs no SDK, no Visual Studio and no build step on the user's machine.
 */

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace DshFloatPanel
{
    internal static class Win32
    {
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const uint WM_NCLBUTTONDOWN = 0x00A1;
        public const int WM_EXITSIZEMOVE = 0x0232;
        public const int HTCAPTION = 2;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const int SW_RESTORE = 9;
        public const uint MONITOR_DEFAULTTOPRIMARY = 1;
        public const uint MONITOR_DEFAULTTONEAREST = 2;

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool SetDllDirectory(string path);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int cmd);

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")]
        public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int width, int height);

        [DllImport("user32.dll")]
        public static extern int SetWindowRgn(IntPtr hWnd, IntPtr region, bool redraw);

        public static int GetExStyle(IntPtr hWnd)
        {
            if (IntPtr.Size == 8) return (int)GetWindowLongPtr64(hWnd, GWL_EXSTYLE).ToInt64();
            return GetWindowLong32(hWnd, GWL_EXSTYLE);
        }

        public static void SetExStyle(IntPtr hWnd, int value)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(hWnd, GWL_EXSTYLE, new IntPtr(value));
            else SetWindowLong32(hWnd, GWL_EXSTYLE, value);
        }

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
        private static extern int GetWindowLong32(IntPtr hWnd, int index);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int index);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
        private static extern int SetWindowLong32(IntPtr hWnd, int index, int value);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);
    }

    internal sealed class PanelShell
    {
        // Small on purpose, matching native/main.swift: the panel is a glance,
        // not a second app window. The page measures itself and asks for a
        // height; these are the starting point and the hard limits.
        private const double BaseWidth = 320.0;
        private const double MinHeight = 42.0;
        private const double MaxHeight = 420.0;
        private const double DefaultHeight = 64.0;
        private const double CornerRadius = 14.0;
        private const int EdgeInset = 18;
        private const int MaxNavigationFailures = 40;

        private static readonly Regex TypePattern =
            new Regex("\"type\"\\s*:\\s*\"([A-Za-z]+)\"", RegexOptions.CultureInvariant);

        private static readonly Regex HeightPattern =
            new Regex("\"height\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)", RegexOptions.CultureInvariant);

        private readonly string _url;
        private readonly string _stateDir;
        private readonly Application _app;
        private readonly Window _window;
        private readonly WebView2 _web;

        private IntPtr _hwnd;
        private HwndSource _source;
        private double _heightDip = DefaultHeight;
        private int _navigationFailures;
        private bool _initialized;
        private bool _webviewReady;
        private bool _sizing;
        private int _exitCode;

        public PanelShell(string url, string stateDir, Application app)
        {
            _url = url;
            _stateDir = stateDir;
            _app = app;
            try
            {
                Directory.CreateDirectory(_stateDir);
            }
            catch (Exception)
            {
                // The window still works; only position memory is lost.
            }

            _web = new WebView2();
            _web.HorizontalAlignment = HorizontalAlignment.Stretch;
            _web.VerticalAlignment = VerticalAlignment.Stretch;
            _web.AllowExternalDrop = false;

            _window = new Window();
            _window.Title = "任务浮窗";
            _window.Width = BaseWidth;
            _window.Height = DefaultHeight;
            _window.WindowStyle = WindowStyle.None;
            _window.ResizeMode = ResizeMode.NoResize;
            _window.ShowInTaskbar = false;
            _window.ShowActivated = false;
            _window.Topmost = true;
            _window.AllowsTransparency = false;
            _window.WindowStartupLocation = WindowStartupLocation.Manual;
            _window.Background = new SolidColorBrush(System.Windows.Media.Color.FromRgb(0x17, 0x17, 0x1a));
            _window.Content = _web;
            _window.SourceInitialized += OnSourceInitialized;
            _window.Loaded += OnLoaded;
            _window.Closing += OnClosing;
            _window.DpiChanged += OnDpiChanged;
        }

        public int Run()
        {
            _app.MainWindow = _window;
            _window.Show();
            int code = _app.Run();
            return _exitCode != 0 ? _exitCode : code;
        }

        // ───────────────────────── window plumbing ─────────────────────────

        private void OnSourceInitialized(object sender, EventArgs e)
        {
            _hwnd = new WindowInteropHelper(_window).Handle;
            if (_hwnd == IntPtr.Zero) return;

            // The macOS shell uses .nonactivatingPanel; on Windows the pair
            // WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW is the equivalent: the panel
            // never steals focus from the app the user is typing in, and stays
            // out of the taskbar and Alt+Tab.
            int style = Win32.GetExStyle(_hwnd);
            Win32.SetExStyle(_hwnd, style | Win32.WS_EX_NOACTIVATE | Win32.WS_EX_TOOLWINDOW);

            _source = HwndSource.FromHwnd(_hwnd);
            if (_source != null) _source.AddHook(WndProc);
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == Win32.WM_EXITSIZEMOVE)
            {
                // The user finished dragging: keep the region and remember it.
                ApplyRegion();
                SavePosition();
            }
            return IntPtr.Zero;
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            if (_initialized) return;
            _initialized = true;

            Program.Log("loaded: hwnd=" + _hwnd.ToInt64().ToString(CultureInfo.InvariantCulture));
            ApplyInitialGeometry();
            await StartWebViewAsync();
        }

        private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            SavePosition();
            if (_source != null)
            {
                try
                {
                    _source.RemoveHook(WndProc);
                }
                catch (Exception)
                {
                    // already detached
                }
                _source = null;
            }
        }

        private void OnDpiChanged(object sender, DpiChangedEventArgs e)
        {
            _window.Dispatcher.BeginInvoke(new Action(delegate
            {
                ApplyRegion();
                ResizeTo(_heightDip);
            }));
        }

        private double Scale()
        {
            try
            {
                DpiScale dpi = VisualTreeHelper.GetDpi(_window);
                if (dpi.DpiScaleX > 0.0) return dpi.DpiScaleX;
            }
            catch (Exception)
            {
                // fall through to 1.0
            }
            return 1.0;
        }

        // ───────────────────────── geometry ─────────────────────────

        private void ApplyInitialGeometry()
        {
            if (_hwnd == IntPtr.Zero) return;

            double scale = Scale();
            int width = (int)Math.Round(BaseWidth * scale);
            double heightDip = Math.Min(Math.Max(_heightDip, MinHeight), MaxHeight);
            int height = (int)Math.Round(heightDip * scale);

            int left;
            int bottom;
            if (!TryLoadPosition(out left, out bottom))
            {
                Win32.RECT work = PrimaryWorkArea();
                left = work.Right - width - (int)Math.Round(EdgeInset * scale);
                bottom = work.Bottom - (int)Math.Round(EdgeInset * scale);
            }

            Win32.POINT anchor = new Win32.POINT();
            anchor.X = left;
            anchor.Y = bottom - 1;
            Win32.RECT target = WorkAreaOf(anchor, Win32.MONITOR_DEFAULTTONEAREST);

            if (left < target.Left) left = target.Left;
            if (left + width > target.Right) left = target.Right - width;
            if (bottom > target.Bottom) bottom = target.Bottom;
            if (bottom - height < target.Top) bottom = target.Top + height;

            _sizing = true;
            Win32.SetWindowPos(_hwnd, Win32.HWND_TOPMOST, left, bottom - height, width, height, Win32.SWP_NOACTIVATE);
            _sizing = false;
            ApplyRegion();
        }

        /// <summary>Fit the window to the height the page measured, keeping the bottom edge.</summary>
        private void ResizeTo(double heightDip)
        {
            if (_hwnd == IntPtr.Zero) return;
            if (heightDip < MinHeight) heightDip = MinHeight;
            if (heightDip > MaxHeight) heightDip = MaxHeight;

            Win32.RECT rect;
            if (!Win32.GetWindowRect(_hwnd, out rect)) return;

            double scale = Scale();
            int width = (int)Math.Round(BaseWidth * scale);
            int height = (int)Math.Round(heightDip * scale);
            int top = rect.Bottom - height;

            _sizing = true;
            Win32.SetWindowPos(_hwnd, Win32.HWND_TOPMOST, rect.Left, top, width, height, Win32.SWP_NOACTIVATE);
            _sizing = false;
            ApplyRegion();
            SavePosition();
        }

        /// <summary>
        /// WebView2 cannot be alpha-composited by a layered WPF window, so the
        /// rounded card is produced by clipping the window to a rounded region
        /// instead of by transparency. Trade-off versus macOS: no soft shadow.
        /// </summary>
        private void ApplyRegion()
        {
            if (_hwnd == IntPtr.Zero || _sizing) return;

            Win32.RECT rect;
            if (!Win32.GetWindowRect(_hwnd, out rect)) return;
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) return;

            int diameter = (int)Math.Round(CornerRadius * 2.0 * Scale());
            if (diameter < 4) diameter = 4;
            IntPtr region = Win32.CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
            if (region == IntPtr.Zero) return;
            Win32.SetWindowRgn(_hwnd, region, true);
        }

        private static Win32.RECT WorkAreaOf(Win32.POINT point, uint flags)
        {
            IntPtr monitor = Win32.MonitorFromPoint(point, flags);
            Win32.MONITORINFO info = new Win32.MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(Win32.MONITORINFO));
            if (monitor != IntPtr.Zero && Win32.GetMonitorInfo(monitor, ref info)) return info.rcWork;

            Win32.RECT fallback = new Win32.RECT();
            fallback.Left = 0;
            fallback.Top = 0;
            fallback.Right = (int)SystemParameters.PrimaryScreenWidth;
            fallback.Bottom = (int)SystemParameters.PrimaryScreenHeight;
            return fallback;
        }

        private static Win32.RECT PrimaryWorkArea()
        {
            Win32.POINT origin = new Win32.POINT();
            return WorkAreaOf(origin, Win32.MONITOR_DEFAULTTOPRIMARY);
        }

        // ───────────────────────── position memory ─────────────────────────

        private string WindowFile
        {
            get { return Path.Combine(_stateDir, "window.json"); }
        }

        private bool TryLoadPosition(out int left, out int bottom)
        {
            left = 0;
            bottom = 0;
            string[] candidates = new string[]
            {
                WindowFile,
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "window.json"),
            };
            foreach (string candidate in candidates)
            {
                try
                {
                    if (!File.Exists(candidate)) continue;
                    string text = File.ReadAllText(candidate);
                    Match leftMatch = Regex.Match(text, "\"left\"\\s*:\\s*(-?[0-9]+)");
                    Match bottomMatch = Regex.Match(text, "\"bottom\"\\s*:\\s*(-?[0-9]+)");
                    if (!leftMatch.Success || !bottomMatch.Success) continue;
                    left = int.Parse(leftMatch.Groups[1].Value, CultureInfo.InvariantCulture);
                    bottom = int.Parse(bottomMatch.Groups[1].Value, CultureInfo.InvariantCulture);
                    return true;
                }
                catch (Exception)
                {
                    // try the next location
                }
            }
            return false;
        }

        private void SavePosition()
        {
            if (_hwnd == IntPtr.Zero || _sizing) return;
            Win32.RECT rect;
            if (!Win32.GetWindowRect(_hwnd, out rect)) return;
            string text = string.Format(CultureInfo.InvariantCulture,
                "{{\"left\":{0},\"bottom\":{1}}}", rect.Left, rect.Bottom);
            string[] candidates = new string[]
            {
                WindowFile,
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "window.json"),
            };
            foreach (string candidate in candidates)
            {
                try
                {
                    File.WriteAllText(candidate, text);
                    return;
                }
                catch (Exception)
                {
                    // try the next location
                }
            }
        }

        // ───────────────────────── WebView2 ─────────────────────────

        private async System.Threading.Tasks.Task StartWebViewAsync()
        {
            string userDataFolder = ChooseUserDataFolder();
            Program.Log("webview: user data folder " + userDataFolder);

            CoreWebView2Environment environment;
            try
            {
                Program.Log("webview: creating environment at " + userDataFolder);
                environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, null);
                Program.Log("webview: environment ready");
            }
            catch (Exception error)
            {
                Fail("无法启动 WebView2 运行时。\n\n请安装 Microsoft Edge WebView2 Runtime：\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n\n" + error.Message);
                return;
            }

            Program.Log("webview: ensuring core");
            // C# 5 cannot await inside catch, so the failure is captured and
            // handled afterwards: ERROR_BUSY (0x800700AA) means another WebView2
            // instance still owns the profile folder, which happens right after
            // a shell was replaced.
            Exception failure = null;
            bool ready = false;
            try
            {
                await _web.EnsureCoreWebView2Async(environment);
                ready = true;
            }
            catch (Exception error)
            {
                failure = error;
            }
            if (!ready && failure != null && IsBusy(failure))
            {
                ready = await RetryEnsureCoreAsync(environment);
            }
            if (!ready)
            {
                Fail("无法初始化浮窗页面。\n\n" + (failure == null ? "" : failure.Message));
                return;
            }
            Program.Log("webview: core ready");

            CoreWebView2 core = _web.CoreWebView2;
            if (core == null)
            {
                Fail("无法初始化浮窗页面。");
                return;
            }

            CoreWebView2Settings settings = core.Settings;
            settings.AreDefaultContextMenusEnabled = false;
            settings.AreDevToolsEnabled = false;
            settings.IsStatusBarEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsGeneralAutofillEnabled = false;

            _web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 0x17, 0x17, 0x1a);
            _web.ZoomFactor = 1.0;

            core.WebMessageReceived += OnWebMessage;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.ProcessFailed += OnProcessFailed;

            _webviewReady = true;
            Navigate();
        }

        /// <summary>
        /// WebView2 needs a writable profile directory. The host passes a state
        /// directory that the sandbox may deny to this child process, so the
        /// first candidate that accepts a write wins.
        /// </summary>
        private string ChooseUserDataFolder()
        {
            string[] candidates = new string[]
            {
                Path.Combine(_stateDir, "webview"),
                Path.Combine(Path.GetTempPath(), "dsh-float-panel-webview"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "webview"),
            };
            foreach (string candidate in candidates)
            {
                if (CanWriteTo(candidate)) return candidate;
            }
            return candidates[0];
        }

        private static bool CanWriteTo(string directory)
        {
            try
            {
                Directory.CreateDirectory(directory);
                string probe = Path.Combine(directory, "write-probe.tmp");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return true;
            }
            catch (Exception error)
            {
                Program.Log("not writable: " + directory + " (" + error.Message + ")");
                return false;
            }
        }

        private static bool IsBusy(Exception error)
        {
            Exception current = error;
            while (current != null)
            {
                if (current.HResult == unchecked((int)0x800700AA)) return true;
                current = current.InnerException;
            }
            return false;
        }

        private async System.Threading.Tasks.Task<bool> RetryEnsureCoreAsync(CoreWebView2Environment environment)
        {
            for (int attempt = 0; attempt < 5; attempt += 1)
            {
                await System.Threading.Tasks.Task.Delay(1500);
                try
                {
                    await _web.EnsureCoreWebView2Async(environment);
                    return true;
                }
                catch (Exception error)
                {
                    Program.Log("webview: retry " + (attempt + 1).ToString(CultureInfo.InvariantCulture)
                        + " failed: " + error.Message);
                    if (!IsBusy(error)) return false;
                }
            }
            return false;
        }

        private void Fail(string message)        {
            _exitCode = 2;
            Program.Log("fail: " + message.Replace(Environment.NewLine, " "));
            try
            {
                MessageBox.Show(message, "任务浮窗", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            catch (Exception)
            {
                // No interactive desktop: the exit code still carries the reason.
            }
            try
            {
                _window.Close();
            }
            catch (Exception)
            {
                Environment.Exit(2);
            }
        }

        private void Navigate()
        {
            if (_web.CoreWebView2 == null) return;
            try
            {
                Program.Log("navigate");
                _web.CoreWebView2.Navigate(_url);
            }
            catch (Exception error)
            {
                Program.Log("navigate error: " + error.Message);
                RetryLater();
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                _navigationFailures = 0;
                return;
            }
            Program.Log("navigation failed: " + e.WebErrorStatus.ToString() + " http=" + e.HttpStatusCode.ToString(CultureInfo.InvariantCulture));
            RetryLater();
        }

        private void RetryLater()
        {
            _navigationFailures += 1;
            if (_navigationFailures > MaxNavigationFailures)
            {
                _window.Close();
                return;
            }
            DispatcherTimer timer = new DispatcherTimer();
            timer.Interval = TimeSpan.FromSeconds(1.5);
            timer.Tick += delegate
            {
                timer.Stop();
                Navigate();
            };
            timer.Start();
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            // The renderer died (usually a runtime update): reload the page.
            _window.Dispatcher.BeginInvoke(new Action(delegate
            {
                if (_webviewReady) Navigate();
            }));
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
        }

        // ───────────────────────── page → shell messages ─────────────────────────

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string json = null;
            try
            {
                json = e.WebMessageAsJson;
            }
            catch (Exception)
            {
                return;
            }
            if (string.IsNullOrEmpty(json)) return;

            string type = "";
            Match typeMatch = TypePattern.Match(json);
            if (typeMatch.Success) type = typeMatch.Groups[1].Value;

            if (string.Equals(type, "resize", StringComparison.Ordinal))
            {
                Match heightMatch = HeightPattern.Match(json);
                if (!heightMatch.Success) return;
                double value;
                if (!double.TryParse(heightMatch.Groups[1].Value, NumberStyles.Float,
                        CultureInfo.InvariantCulture, out value)) return;
                _heightDip = value;
                _window.Dispatcher.BeginInvoke(new Action(delegate { ResizeTo(_heightDip); }));
                return;
            }

            if (string.Equals(type, "drag", StringComparison.Ordinal))
            {
                _window.Dispatcher.BeginInvoke(new Action(BeginMove));
                return;
            }

            if (string.Equals(type, "activate", StringComparison.Ordinal))
            {
                _window.Dispatcher.BeginInvoke(new Action(ActivateDsh));
                return;
            }

            if (string.Equals(type, "retire", StringComparison.Ordinal))
            {
                _window.Dispatcher.BeginInvoke(new Action(delegate { _window.Close(); }));
            }
        }

        private void BeginMove()
        {
            if (_hwnd == IntPtr.Zero) return;
            Win32.ReleaseCapture();
            Win32.SendMessage(_hwnd, Win32.WM_NCLBUTTONDOWN, new IntPtr(Win32.HTCAPTION), IntPtr.Zero);
        }

        // ───────────────────────── open DSH ─────────────────────────

        private static void ActivateDsh()
        {
            if (TryFocusExisting()) return;
            try
            {
                ProcessStartInfo start = new ProcessStartInfo("dsh://open");
                start.UseShellExecute = true;
                Process.Start(start);
                return;
            }
            catch (Exception)
            {
                // The protocol may not be registered in a development launch.
            }
            TryFocusExisting();
        }

        private static bool TryFocusExisting()
        {
            try
            {
                Process[] processes = Process.GetProcessesByName("DeepSeek Harness");
                foreach (Process process in processes)
                {
                    IntPtr handle = IntPtr.Zero;
                    try
                    {
                        handle = process.MainWindowHandle;
                    }
                    catch (Exception)
                    {
                        handle = IntPtr.Zero;
                    }
                    if (handle == IntPtr.Zero) continue;
                    Win32.ShowWindow(handle, Win32.SW_RESTORE);
                    Win32.SetForegroundWindow(handle);
                    if (Win32.GetForegroundWindow() == handle) return true;
                }
            }
            catch (Exception)
            {
                // Permission to enumerate processes is not guaranteed.
            }
            return false;
        }
    }

    internal static class Program
    {
        private static string _logPath = "";

        [STAThread]
        private static int Main(string[] args)
        {
            if (args == null || args.Length < 2)
            {
                MessageBox.Show("用法：DSHFloatPanel.exe <url> <state-dir>", "任务浮窗",
                    MessageBoxButton.OK, MessageBoxImage.Information);
                return 1;
            }

            try
            {
                _logPath = Path.Combine(args[1], "error.log");
                // One run per file: the log never grows and never keeps a stale
                // failure from an earlier launch.
                File.WriteAllText(_logPath, "");
            }
            catch (Exception)
            {
                _logPath = "";
            }
            AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;
            Log("start pid=" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));

            try
            {
                SelectLoader();
                // The WPF Application must exist before the first Window.
                Application app = new Application();
                app.ShutdownMode = ShutdownMode.OnMainWindowClose;
                PanelShell shell = new PanelShell(args[0], args[1], app);
                return shell.Run();
            }
            catch (Exception error)
            {
                Log("fatal: " + error.ToString());
                MessageBox.Show("任务浮窗无法启动：\n\n" + error.Message, "任务浮窗",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
                return 3;
            }
        }

        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            Log("unhandled: " + (e.ExceptionObject == null ? "(null)" : e.ExceptionObject.ToString()));
        }

        /// <summary>
        /// Append one line to the shell's own log. The state directory is where a
        /// normal install keeps it; a sandbox that denies that directory gets the
        /// log beside the executable instead.
        /// </summary>
        internal static void Log(string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                + " " + message + Environment.NewLine;
            if (_logPath.Length != 0)
            {
                try
                {
                    File.AppendAllText(_logPath, line);
                    return;
                }
                catch (Exception)
                {
                    // fall through to the executable's directory
                }
            }
            try
            {
                File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "panel-error.log"), line);
            }
            catch (Exception)
            {
                // Logging must never break the shell.
            }
        }

        /// <summary>Point the P/Invoke loader at the architecture-specific WebView2Loader.dll.</summary>
        private static void SelectLoader()
        {
            string architecture = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "";
            string alsoArchitecture = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432") ?? "";
            bool arm64 = architecture.Equals("ARM64", StringComparison.OrdinalIgnoreCase)
                || alsoArchitecture.Equals("ARM64", StringComparison.OrdinalIgnoreCase);
            string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string folder = Path.Combine(baseDirectory, arm64 ? "arm64" : "x64");
            if (!Directory.Exists(folder)) folder = baseDirectory;
            try
            {
                Win32.SetDllDirectory(folder);
            }
            catch (Exception)
            {
                // The default search path still finds a loader placed beside the exe.
            }
        }
    }
}
