using System;using System.IO;using System.Net;using System.Diagnostics;
using System.Drawing;using System.Windows.Forms;class X{
static int Pt,Pd;static NotifyIcon T;static bool Q;
static void Main(string[]a){
Pt=int.Parse(a[0]);Pd=int.Parse(a[1]);
T=new NotifyIcon();T.Text="PrintPulse Agent";T.Visible=true;
byte[]ic=__ICO_BYTES__;
try{T.Icon=new Icon(new MemoryStream(ic));}catch{T.Icon=SystemIcons.Application;}
var m=new ContextMenuStrip();
var d=new ToolStripMenuItem("Open Dashboard");d.Click+=(s,e)=>{Process.Start("http://127.0.0.1:"+Pt);};m.Items.Add(d);
m.Items.Add(new ToolStripSeparator());
var a2=new ToolStripMenuItem("AutoStart");
string su=Environment.GetFolderPath(Environment.SpecialFolder.Startup)+"\\PrintPulseAgent.url";
a2.Checked=File.Exists(su);
a2.Click+=(s,e)=>{if(a2.Checked){try{File.Delete(su);}catch{}a2.Checked=false;}else{try{string exe=Process.GetProcessById(Pd).MainModule.FileName;File.WriteAllText(su,"[InternetShortcut]\nURL=file:///"+exe.Replace("\\","/")+"\nIconIndex=0");a2.Checked=true;}catch{}}};
m.Items.Add(a2);m.Items.Add(new ToolStripSeparator());
var q=new ToolStripMenuItem("Quit");q.Click+=(s,e)=>{Q=true;T.Visible=false;T.Dispose();try{var r=WebRequest.Create("http://127.0.0.1:"+Pt+"/api/quit");r.GetResponse();}catch{}try{Process.GetProcessById(Pd).Kill();}catch{}Application.Exit();};m.Items.Add(q);
T.ContextMenuStrip=m;
T.Click+=(s,e)=>{if(((MouseEventArgs)e).Button==MouseButtons.Left)Process.Start("http://127.0.0.1:"+Pt);};
var t2=new Timer();t2.Interval=5000;t2.Tick+=(s,e)=>{if(Q)return;try{var r=WebRequest.Create("http://127.0.0.1:"+Pt+"/api/ping");r.GetResponse();}catch{T.Visible=false;T.Dispose();Application.Exit();}};t2.Start();Application.Run();}}
