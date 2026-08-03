const { ipcRenderer } = require('electron');

const app = {
  views: {},
  currentView: null,
  config: {},

  // Register view module
  registerView(name, viewModule) {
    this.views[name] = viewModule;
  },

  // Navigate to a view
  async navigate(name, params = {}) {
    const root = document.getElementById('app-root');
    const view = this.views[name];
    
    if (!view) {
      console.error(`View ${name} not found`);
      return;
    }

    // Fade out current
    if (this.currentView) {
      root.style.opacity = '0';
      await new Promise(r => setTimeout(r, 200));
    }

    // Render new
    root.innerHTML = view.html();
    
    // Init logic
    if (view.init) {
      await view.init(params);
    }

    // Fade in
    root.style.opacity = '1';
    root.style.transition = 'opacity 0.2s ease-in-out';
    this.currentView = name;
  },

  // Elegant Toast
  toast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    const isError = type === 'error';
    
    el.className = `px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 transform transition-all duration-300 translate-y-full opacity-0 ${
      isError ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-slate-800 text-white'
    }`;
    
    el.innerHTML = `
      <div class="flex-1 text-sm font-medium">${msg}</div>
      <button class="text-current opacity-70 hover:opacity-100">&times;</button>
    `;
    
    container.appendChild(el);
    
    // Animate in
    setTimeout(() => {
      el.classList.remove('translate-y-full', 'opacity-0');
    }, 10);

    const close = () => {
      el.classList.add('translate-y-full', 'opacity-0');
      setTimeout(() => el.remove(), 300);
    };

    el.querySelector('button').onclick = close;
    setTimeout(close, 5000);
  },

  // Main init
  async init() {
    this.config = await ipcRenderer.invoke('get-config');
    
    // Check auth
    if (this.config.token) {
      this.navigate('dashboard');
    } else {
      this.navigate('login');
    }
  }
};

window.app = app;

// Init when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
