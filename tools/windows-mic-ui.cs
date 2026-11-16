using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;

namespace FarmerNativeMic
{
    public sealed class MainWindow : Form
    {
        NativeSession session;
        readonly CheckBox consent = new CheckBox();
        readonly Button start = new Button(), stop = new Button(), play = new Button();
        readonly Label status = new Label();
        readonly TextBox details = new TextBox();
        readonly Timer timer = new Timer();
        MainWindow()
        {
            Text = "FARMER-AI — Windows ቀጥተኛ የማይክ ምርመራ";
            Width = 840; Height = 640; MinimumSize = new Size(650, 560);
            Font = new Font("Ebrima", 12); StartPosition = FormStartPosition.CenterScreen;
            FlowLayoutPanel layout = new FlowLayoutPanel(); layout.Dock = DockStyle.Fill; layout.FlowDirection = FlowDirection.TopDown; layout.WrapContents = false; layout.AutoScroll = true; layout.Padding = new Padding(18); Controls.Add(layout);
            Label explanation = new Label(); explanation.Text = "Windows በቀጥታ ይቀዳል፣ ያጫውታል። Browser / AI / የፕሮጀክቱ የድምፅ ቅየራ አይገቡበትም።\nWindows የመረጠውን ነባር ማይክ ይጠቀማል። ሙከራው ከፍተኛው 10 ሰከንድ ነው።"; explanation.AutoSize = true; layout.Controls.Add(explanation);
            consent.Text = "AI ቁልፍ — ማይክን ለዚህ ሙከራ እንዲጠቀም ፈቅጃለሁ"; consent.AutoSize = true; consent.Margin = new Padding(3, 18, 3, 16); layout.Controls.Add(consent);
            FlowLayoutPanel buttons = new FlowLayoutPanel(); buttons.Width = 760; buttons.Height = 90; layout.Controls.Add(buttons);
            foreach (Button button in new Button[] { start, stop, play }) { button.Width = 240; button.Height = 74; buttons.Controls.Add(button); }
            start.Text = "1. መቅዳት ጀምር"; stop.Text = "2. መቅዳት አቁም"; play.Text = "3. ድምፄን አድምጥ";
            status.Width = 750; status.Height = 70; status.Text = "G1 HOLD — የማይክ ችግሩ ገና አልተፈታም። መጀመሪያ ፈቃድ ይስጡ።"; layout.Controls.Add(status);
            FlowLayoutPanel options = new FlowLayoutPanel(); options.Width = 760; options.Height = 52; layout.Controls.Add(options);
            Button cancel = new Button(), report = new Button(), call = new Button();
            cancel.Text = "ቅጂውን ሰርዝ"; report.Text = "መለኪያ ብቻ አስቀምጥ"; call.Text = "ጥሪ ገባ/አበቃ (ማስመሰያ)";
            foreach (Button button in new Button[] { cancel, report, call }) { button.Width = 240; button.Height = 40; options.Controls.Add(button); }
            Label privacy = new Label(); privacy.Text = "ድምፅ አይላክም። ጊዜያዊ የግል WAV በWindows Temp ይቀመጣል፤ ሲሰረዝ/ሲዘጋ ይጠፋል።\nየJSON መለኪያው audio፣ device name/ID፣ transcript አልያዘም። ማይክ ፈቃድ፦ Windows Settings → Privacy → Microphone።"; privacy.AutoSize = true; layout.Controls.Add(privacy);
            details.Multiline = true; details.ReadOnly = true; details.ScrollBars = ScrollBars.Both; details.WordWrap = false; details.Width = 750; details.Height = 145; layout.Controls.Add(details);
            string directory = Path.Combine(Path.GetTempPath(), "FarmerAiMic-" + Guid.NewGuid().ToString("N"));
            session = new NativeSession(new WindowsMciBridge(), directory);
            start.Click += delegate { Guard(delegate { session.Start(consent.Checked); timer.Start(); status.Text = "Windows እየቀዳ ነው። ይናገሩ፤ ከዚያ ያቁሙ።"; }); };
            stop.Click += delegate { StopCapture(); };
            play.Click += delegate { Guard(delegate { session.Play(consent.Checked); status.Text = "Windows የቀዳውን ድምፅ እያጫወተ ነው። የራስዎን ቃላት ይሰማሉ?"; }); };
            cancel.Click += delegate { Guard(delegate { timer.Stop(); session.Cancel(); status.Text = "ቅጂው ተሰርዟል።"; }); };
            consent.CheckedChanged += delegate { if (!consent.Checked) Guard(delegate { timer.Stop(); session.Cancel(); status.Text = "ፈቃድ ተሰርዟል፤ ማይኩና ማጫወቻው ቆመዋል።"; }); RefreshState(); };
            call.Click += delegate { Guard(delegate { timer.Stop(); session.SetCall(!session.CallActive); status.Text = session.CallActive ? "የጥሪ ማስመሰያ፦ ማይኩና ማጫወቻው ቆመዋል።" : "የጥሪ ማስመሰያው አብቅቷል።"; }); };
            report.Click += delegate { Guard(delegate { SaveMetadata(); }); };
            timer.Interval = 250; timer.Tick += delegate { if (session.Recording && session.ElapsedSeconds >= 10) StopCapture(); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) {
                timer.Stop();
                try { session.Dispose(); }
                catch (Exception) {
                    if (MessageBox.Show("የግል ቅጂውን ማጽዳት አልተቻለም። የስህተት መለኪያ ብቻ ማስቀመጥ ይፈልጋሉ? ድምፅ አይካተትም።", "CLEANUP_FAILED", MessageBoxButtons.YesNo) == DialogResult.Yes) {
                        try { SaveMetadata(); } catch { MessageBox.Show("REPORT_WRITE_FAILED — የስህተት ሪፖርቱ አልተቀመጠም።"); }
                    }
                }
            };
            RefreshState();
        }
        void StopCapture()
        {
            Guard(delegate { timer.Stop(); session.Stop(); status.Text = session.Metrics != null && session.Metrics.NonzeroFrames == 0 ? "Windows የቀዳው ሙሉ ጸጥታ ነው። የማይክ ግቤትና mute ይፈትሹ።" : "ቅጂው ተዘጋጅቷል። «ድምፄን አድምጥ» ይጫኑ። ይህ ንግግር ተቀድቷል ማለት አይደለም።"; });
        }
        void Guard(Action action)
        {
            try { action(); }
            catch (MicException e) {
                status.Text = e.Stage.StartsWith("cleanup") ? "የቀድሞውን የግል ቅጂ ማጽዳት አልተቻለም። አዲስ መቅዳት አልተጀመረም። ክፍት ማጫወቻ ካለ ያቁሙና «ቅጂውን ሰርዝ» እንደገና ይጫኑ።" : "የWindows ድምፅ ሙከራ አልተሳካም። የታችኛውን stage/code ይመልከቱ።";
                session.LastStage = e.Stage; session.LastCode = e.Code; session.LastNativeCode = e.NativeCode; session.LastManagedHResult = e.ManagedHResult;
            }
            catch (Exception e) { status.Text = "ሙከራው አልተጠናቀቀም። የታችኛውን መለያ ይመልከቱ።"; session.LastCode = e is InvalidDataException ? e.Message : "MANAGED_AUDIO_ERROR"; }
            RefreshState();
        }
        void SaveMetadata()
        {
            using (SaveFileDialog dialog = new SaveFileDialog()) {
                dialog.Filter = "JSON metadata only|*.json"; dialog.FileName = "windows-native-mic-no-audio.json";
                if (dialog.ShowDialog(this) == DialogResult.OK) File.WriteAllText(dialog.FileName, session.ReportJson(), new System.Text.UTF8Encoding(false));
            }
        }
        void RefreshState()
        {
            if (session == null) return;
            start.Enabled = consent.Checked && !session.Recording && !session.CallActive;
            stop.Enabled = session.Recording; play.Enabled = consent.Checked && session.PreviewReady && !session.Recording && !session.CallActive;
            details.Text = session.ReportJson();
        }
        [STAThread]
        public static void Run() { Application.EnableVisualStyles(); Application.Run(new MainWindow()); }
    }
}
