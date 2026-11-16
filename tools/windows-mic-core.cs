// Windows-only diagnostic. Direct OS recording/playback, no browser, resampling, AI or network.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

namespace FarmerNativeMic
{
    public interface IMciBridge { uint Send(string command); string Describe(uint code); }
    public interface IPrivateFileRemover { void Delete(string path); }
    public sealed class PrivateFileRemover : IPrivateFileRemover { public void Delete(string path) { File.Delete(path); } }
    public sealed class WindowsMciBridge : IMciBridge
    {
        [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "mciSendStringW")]
        static extern uint SendNative(string command, StringBuilder response, uint size, IntPtr callback);
        [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "mciGetErrorStringW")]
        static extern bool DescribeNative(uint code, StringBuilder text, uint length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetShortPathName(string longPath, StringBuilder shortPath, uint length);
        public WindowsMciBridge()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) throw new PlatformNotSupportedException("WINDOWS_REQUIRED");
        }
        public uint Send(string command)
        {
            // The legacy waveaudio driver can reject Unicode even through MCI's W
            // entry point (304 on Windows 11). Use the same directory's Windows
            // short alias, without copying audio or changing its storage location.
            int first = command.IndexOf('"'), last = command.LastIndexOf('"');
            if (first >= 0 && last > first)
            {
                string path = command.Substring(first + 1, last - first - 1);
                bool unicode = false;
                foreach (char c in path) if (c > 127) unicode = true;
                if (unicode)
                {
                    string parent = Path.GetDirectoryName(path);
                    StringBuilder alias = new StringBuilder(32768);
                    uint length = GetShortPathName(parent, alias, (uint)alias.Capacity);
                    string nativePath = Path.Combine(alias.ToString(), Path.GetFileName(path));
                    bool ascii = true;
                    foreach (char c in nativePath) if (c > 127) ascii = false;
                    if (length == 0 || length >= alias.Capacity || !ascii)
                        throw new MicException("path-encoding", "MCI_UNICODE_PATH_UNSUPPORTED", 0, "Windows did not provide an ASCII alias for the private audio directory");
                    command = command.Substring(0, first) + NativeSession.QuoteMciPath(nativePath) + command.Substring(last + 1);
                }
            }
            return SendNative(command, null, 0, IntPtr.Zero);
        }
        public string Describe(uint code)
        {
            StringBuilder text = new StringBuilder(256);
            return DescribeNative(code, text, 256) ? text.ToString() : "Windows audio error";
        }
    }
    public sealed class MicException : Exception
    {
        public readonly string Stage, Code;
        public readonly uint NativeCode;
        public readonly int ManagedHResult;
        public MicException(string stage, string code, uint nativeCode, string message, int managedHResult = 0) : base(message)
        { Stage = stage; Code = code; NativeCode = nativeCode; ManagedHResult = managedHResult; }
    }
    public sealed class WaveMetrics
    {
        public uint Rate, DataBytes;
        public ushort Channels, Bits;
        public long Frames, NonzeroFrames, ClippedFrames, LongestZeroRun;
        public double Peak, Rms, Dc;
        public double Seconds { get { return (double)Frames / Rate; } }
        public static WaveMetrics Inspect(Stream input)
        {
            if (!input.CanSeek || input.Length < 44 || input.Length > 32 * 1024 * 1024) throw new InvalidDataException("WAV_SIZE_INVALID");
            BinaryReader reader = new BinaryReader(input, Encoding.ASCII, true);
            input.Position = 0;
            if (Encoding.ASCII.GetString(reader.ReadBytes(4)) != "RIFF") throw new InvalidDataException("WAV_RIFF_INVALID");
            long end = (long)reader.ReadUInt32() + 8;
            if (end > input.Length || end < 44 || Encoding.ASCII.GetString(reader.ReadBytes(4)) != "WAVE") throw new InvalidDataException("WAV_LENGTH_INVALID");
            WaveMetrics result = new WaveMetrics();
            bool formatSeen = false; ushort format = 0, align = 0; uint byteRate = 0;
            long dataStart = -1;
            while (input.Position + 8 <= end)
            {
                string id = Encoding.ASCII.GetString(reader.ReadBytes(4)); uint length = reader.ReadUInt32();
                long body = input.Position, next = body + length + (length % 2);
                if (next > end) throw new InvalidDataException("WAV_CHUNK_TRUNCATED");
                if (id == "fmt ")
                {
                    if (length < 16) throw new InvalidDataException("WAV_FORMAT_INVALID");
                    format = reader.ReadUInt16(); result.Channels = reader.ReadUInt16(); result.Rate = reader.ReadUInt32();
                    byteRate = reader.ReadUInt32(); align = reader.ReadUInt16(); result.Bits = reader.ReadUInt16(); formatSeen = true;
                }
                if (id == "data") { dataStart = body; result.DataBytes = length; }
                input.Position = next;
            }
            if (!formatSeen || format != 1 || result.Channels != 1 || result.Bits != 16 || result.Rate == 0 || result.Rate > 192000 || align != 2 || byteRate != result.Rate * 2)
                throw new InvalidDataException("WAV_PCM_FORMAT_UNSUPPORTED");
            if (dataStart < 0 || result.DataBytes == 0 || result.DataBytes % 2 != 0) throw new InvalidDataException("WAV_DATA_INVALID");
            result.Frames = result.DataBytes / 2; input.Position = dataStart;
            double energy = 0, sum = 0; long zeroRun = 0;
            for (long i = 0; i < result.Frames; i++)
            {
                short sample = reader.ReadInt16(); double value = sample / 32768.0;
                result.Peak = Math.Max(result.Peak, Math.Abs(value)); energy += value * value; sum += value;
                if (sample != 0) { result.NonzeroFrames++; zeroRun = 0; }
                else { zeroRun++; result.LongestZeroRun = Math.Max(result.LongestZeroRun, zeroRun); }
                if (Math.Abs((int)sample) >= 32735) result.ClippedFrames++;
            }
            result.Rms = Math.Sqrt(energy / result.Frames); result.Dc = sum / result.Frames;
            return result;
        }
    }
    public sealed class NativeSession : IDisposable
    {
        readonly IMciBridge bridge;
        readonly IPrivateFileRemover remover;
        readonly string directory, wavePath;
        readonly Stopwatch clock = new Stopwatch();
        bool opened, playing;
        public bool Recording { get; private set; }
        public bool CallActive { get; private set; }
        public double ElapsedSeconds { get { return clock.Elapsed.TotalSeconds; } }
        public bool PreviewReady { get { return Metrics != null && File.Exists(wavePath); } }
        public WaveMetrics Metrics { get; private set; }
        public int RequestedRate { get; private set; }
        public double WallMilliseconds { get; private set; }
        public string LastStage = "idle", LastCode = "READY";
        public uint LastNativeCode;
        public int LastManagedHResult;
        public NativeSession(IMciBridge bridge, string tempDirectory) : this(bridge, tempDirectory, new PrivateFileRemover()) { }
        public NativeSession(IMciBridge bridge, string tempDirectory, IPrivateFileRemover remover)
        {
            this.bridge = bridge; this.remover = remover; directory = Path.GetFullPath(tempDirectory); wavePath = Path.Combine(directory, "private-capture.wav");
            QuoteMciPath(wavePath);
            Directory.CreateDirectory(directory);
        }
        public static string QuoteMciPath(string path)
        {
            foreach (char c in path) if (c == '"' || char.IsControl(c)) throw new MicException("path-validation", "MCI_PATH_UNSUPPORTED", 0, "Unsupported characters in the private audio path");
            return "\"" + path + "\"";
        }
        void Remember(MicException error)
        { LastStage = error.Stage; LastCode = error.Code; LastNativeCode = error.NativeCode; LastManagedHResult = error.ManagedHResult; }
        void Command(string stage, string command)
        {
            LastStage = stage; uint code = bridge.Send(command); LastNativeCode = code; LastManagedHResult = 0;
            if (code != 0) { LastCode = "WINDOWS_AUDIO_ERROR"; throw new MicException(stage, LastCode, code, bridge.Describe(code)); }
        }
        void CloseRecord()
        {
            if (!opened) return;
            uint code = bridge.Send("close farmer_record wait");
            if (code != 0) throw new MicException("close-record", "WINDOWS_CLOSE_FAILED", code, bridge.Describe(code));
            opened = false;
        }
        void StopPlayback()
        {
            if (!playing) return;
            uint code = bridge.Send("stop farmer_play wait");
            uint close = bridge.Send("close farmer_play wait");
            if (close == 0) playing = false; // retain failed-close state so cancellation can retry
            if (code != 0 || close != 0) throw new MicException("playback-stop", "WINDOWS_PLAYBACK_STOP_FAILED", code != 0 ? code : close, "Windows could not stop playback");
        }
        public void Start(bool consent)
        {
            if (!consent || CallActive) throw new MicException("consent", "MIC_NOT_AUTHORIZED", 0, "Microphone consent is required and a call must not be active");
            if (Recording) return;
            try
            {
                Cancel(); // fail closed on stale/locked private WAV; do not classify this as a microphone failure
                Metrics = null; RequestedRate = 0; WallMilliseconds = 0; LastNativeCode = 0; LastManagedHResult = 0; LastCode = "OPENING";
                foreach (int rate in new int[] { 48000, 44100, 16000 })
                {
                    Command("open-record", "open new type waveaudio alias farmer_record wait"); opened = true;
                    uint code = bridge.Send("set farmer_record format tag pcm channels 1 bitspersample 16 samplespersec " + rate + " bytespersec " + (rate * 2) + " alignment 2 wait");
                    LastNativeCode = code;
                    if (code == 0) { RequestedRate = rate; break; }
                    CloseRecord(); RequestedRate = 0;
                }
                if (RequestedRate == 0) throw new MicException("configure-format", "NO_SUPPORTED_PCM_FORMAT", LastNativeCode, "Windows rejected the requested PCM formats");
                Command("record", "record farmer_record"); Recording = true; clock.Restart(); LastCode = "RECORDING";
            }
            catch (MicException error) { Remember(error); try { CloseRecord(); } catch { } throw; }
        }
        public void Stop()
        {
            if (!Recording) return;
            try
            {
                Command("stop-record", "stop farmer_record wait"); Recording = false; clock.Stop(); WallMilliseconds = clock.Elapsed.TotalMilliseconds;
                Command("save-private-wav", "save farmer_record " + QuoteMciPath(wavePath) + " wait");
                CloseRecord(); LastStage = "inspect-native-wav";
                using (FileStream input = File.OpenRead(wavePath)) Metrics = WaveMetrics.Inspect(input);
                // Do not rewrite, resample, normalize, synthesize or substitute any audio.
                LastCode = Metrics.NonzeroFrames == 0 ? "NATIVE_DIGITAL_SILENCE" : "NATIVE_WAV_READY_NOT_SPEECH_VERIFIED";
            }
            catch (Exception error) { Metrics = null; if (error is InvalidDataException) LastCode = error.Message; try { CloseRecord(); } catch { } Recording = false; throw; }
        }
        public void Play(bool consent)
        {
            if (!consent || CallActive || Recording || !PreviewReady) throw new MicException("playback-consent", "PLAYBACK_NOT_AUTHORIZED", 0, "A local recording and consent are required");
            StopPlayback();
            try
            {
                Command("open-playback", "open " + QuoteMciPath(wavePath) + " type waveaudio alias farmer_play wait"); playing = true;
                Command("playback", "play farmer_play"); LastCode = "PLAYING_NOT_HUMAN_VERIFIED";
            }
            catch { try { StopPlayback(); } catch { } throw; }
        }
        public void Cancel()
        {
            Recording = false; clock.Stop();
            MicException error = null;
            try { StopPlayback(); } catch (MicException e) { error = e; }
            try { CloseRecord(); } catch (MicException e) { if (error == null) error = e; }
            Metrics = null;
            // A failed native stop/close leaves ownership uncertain. Preserve the
            // private WAV and first failure until an explicit close retry succeeds.
            if (error != null) { Remember(error); throw error; }
            try { if (File.Exists(wavePath)) remover.Delete(wavePath); }
            catch (Exception e) { error = new MicException("cleanup-wav", "PRIVATE_WAV_DELETE_FAILED", 0, "Private audio cleanup failed; recording was not started", e.HResult); }
            if (error != null) { Remember(error); throw error; }
            LastStage = "cancel"; LastCode = "CANCELLED"; LastNativeCode = 0; LastManagedHResult = 0;
        }
        public void SetCall(bool active) { CallActive = active; if (active) Cancel(); }
        static string N(double value) { return value.ToString("R", CultureInfo.InvariantCulture); }
        static string Q(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\""; }
        public string ReportJson()
        {
            StringBuilder text = new StringBuilder("{\n");
            text.Append("\"method\":\"Windows winmm MCI waveaudio\",\n\"input_selection\":\"Windows default recording device; identity unverified\",\n");
            text.Append("\"stage_B\":\"FAILED/UNRESOLVED\",\n\"root_cause\":\"UNKNOWN\",\n\"speech_verified\":false,\n\"network_used\":false,\n");
            text.Append("\"stage\":" + Q(LastStage) + ",\n\"code\":" + Q(LastCode) + ",\n\"native_error_code\":" + LastNativeCode + ",\n");
            text.Append("\"managed_hresult\":" + LastManagedHResult + ",\n\"private_wav_present\":" + (File.Exists(wavePath) ? "true" : "false") + ",\n\"native_capture_open\":" + (opened ? "true" : "false") + ",\n\"native_playback_open\":" + (playing ? "true" : "false") + ",\n");
            text.Append("\"requested_rate\":" + RequestedRate + ",\n\"record_wall_ms\":" + N(WallMilliseconds) + ",\n\"wave\":");
            if (Metrics == null) text.Append("null");
            else text.Append("{\"sample_rate\":" + Metrics.Rate + ",\"channels\":" + Metrics.Channels + ",\"bits\":" + Metrics.Bits + ",\"frames\":" + Metrics.Frames + ",\"seconds\":" + N(Metrics.Seconds) + ",\"nonzero_frames\":" + Metrics.NonzeroFrames + ",\"peak\":" + N(Metrics.Peak) + ",\"rms\":" + N(Metrics.Rms) + ",\"dc\":" + N(Metrics.Dc) + ",\"clipped_frames\":" + Metrics.ClippedFrames + ",\"longest_zero_run_seconds\":" + N((double)Metrics.LongestZeroRun / Metrics.Rate) + "}");
            text.Append("\n}"); return text.ToString();
        }
        public void Dispose()
        {
            Cancel();
            try { if (Directory.Exists(directory)) Directory.Delete(directory, false); }
            catch (Exception e) { MicException error = new MicException("cleanup-directory", "PRIVATE_DIRECTORY_DELETE_FAILED", 0, "Private temporary directory cleanup failed", e.HResult); Remember(error); throw error; }
        }
    }
}
