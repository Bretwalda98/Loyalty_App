import { apiGet, apiPost, toast, escapeHtml } from './api.js';

const el = (id)=>document.getElementById(id);

async function loadConfigAndGoogle(){
  try{
    const cfg = await apiGet('/api/config');
    if(cfg.googleClientId){
      const box = document.getElementById('googleBox');
      box.style.display = 'block';

      window.google?.accounts?.id?.initialize?.({
        client_id: cfg.googleClientId,
        callback: async (resp)=>{
          try{
            await apiPost('/api/customer/google', { credential: resp.credential });
            toast('Signed in with Google');
            loadWallet();
          }catch(e){
            toast('Google sign-in failed');
          }
        }
      });
      window.google?.accounts?.id?.renderButton?.(document.getElementById('gBtn'), {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        width: 260
      });
    }
  }catch(e){
    // ignore
  }
}

async function loadWallet(){
  try{
    el('status').textContent = 'Loading…';
    const data = await apiGet('/api/customer/wallet');
    const list = el('accounts');
    list.innerHTML = '';
    data.accounts.forEach(a=>{
      const div = document.createElement('div');
      div.className='item';
      div.innerHTML = `
        <div>
          <strong>${escapeHtml(a.merchant_name)}</strong>
          <div class="meta">${escapeHtml(a.store_name)}</div>
        </div>
        <div class="row" style="gap:10px">
          <div class="pill">${a.balance}</div>
          <a class="btn" href="/shop?merchant=${encodeURIComponent(a.merchant_id)}">Open</a>
        </div>
      `;
      list.appendChild(div);
    });
    el('status').textContent = 'Loaded';
  }catch(err){
    el('status').textContent = 'Not signed in';
  }
}

el('loginBtn').addEventListener('click', async ()=>{
  const email = el('email').value.trim();
  try{
    await apiPost('/api/customer/login', { email });
    toast('Signed in');
    loadWallet();
  }catch(e){
    toast('Sign-in failed');
  }
});
el('refreshBtn').addEventListener('click', loadWallet);
el('logoutBtn').addEventListener('click', async ()=>{
  await apiPost('/api/logout', {});
  toast('Logged out');
  loadWallet();
});

loadConfigAndGoogle();
loadWallet();
