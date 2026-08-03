app.registerView('login', {
  html() {
    return `
      <div class="flex items-center justify-center h-full bg-gradient-to-br from-indigo-50 to-slate-100">
        <div class="glass p-10 rounded-2xl shadow-xl w-full max-w-md">
          <div class="text-center mb-8">
            <h1 class="text-4xl font-bold text-indigo-600 tracking-tight">Print<span class="text-slate-800">Pulse</span></h1>
            <p class="text-sm text-slate-500 mt-2">Agent v3 Enterprise</p>
          </div>
          
          <form id="frm-login" class="space-y-5">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input type="email" id="email" class="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all" required>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input type="password" id="password" class="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all" required>
            </div>
            <button type="submit" id="btn-login" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg transition-colors shadow-md mt-4">
              Login to Agent
            </button>
          </form>
        </div>
      </div>
    `;
  },

  async init() {
    const { ipcRenderer } = require('electron');

    document.getElementById('frm-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value.trim();
      const btn = document.getElementById('btn-login');
      
      btn.disabled = true;
      btn.textContent = 'Authenticating...';

      try {
        await ipcRenderer.invoke('login', { email, password });
        app.config = await ipcRenderer.invoke('get-config');
        app.toast('Berhasil login!');
        app.navigate('dashboard');
      } catch (err) {
        let msg = err.message || 'Login gagal';
        // Extract real error from electron IPC error wrap
        msg = msg.replace(/^Error invoking remote method '.*?':\s*Error:\s*/, '');
        app.toast(msg, 'error');
        btn.disabled = false;
        btn.textContent = 'Login to Agent';
      }
    });
  }
});
