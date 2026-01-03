import { apiGet, apiPost, qs, toast } from './api.js';

const el = (id)=>document.getElementById(id);
const token = qs('token');

async function loadGoogleIfConfigured(){
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
            el('claimSub').textContent = 'Signed in — claim your point.';
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
  }catch(e){}
}

async function ensureSignedIn(){
  try{
    await apiGet('/api/customer/wallet');
    return true;
  }catch(e){
    return false;
  }
}

async function claim(){
  if(!token) return toast('Missing token');
  try{
    const receipt_code = el('receiptCode').value.trim().toUpperCase();
    const r = await apiPost('/api/customer/claim', { token_id: token, receipt_code: receipt_code || null });
    toast(`+${r.points_added} point`);
    window.location.href = `/shop?merchant=${encodeURIComponent(r.merchant_id)}`;
  }catch(e){
    const msg = e.data?.error || 'claim_failed';
    if(msg === 'bad_receipt_code') toast('Wrong receipt code');
    else if(msg === 'token_expired') toast('Token expired');
    else if(msg === 'token_already_used') toast('Already used');
    else if(msg === 'rate_limited') toast('Too many claims — try again soon');
    else if(msg === 'not_authenticated') toast('Please sign in first');
    else toast('Could not claim');
  }
}

(async ()=>{
  await loadGoogleIfConfigured();

  if(!token){
    el('claimTitle').textContent = 'Invalid QR';
    el('claimSub').textContent = 'Missing token in URL.';
    el('claimBtn').disabled = true;
    return;
  }

  const signed = await ensureSignedIn();
  if(!signed){
    el('claimSub').textContent = 'Please sign in first, then claim.';

    const box = el('claimBox');
    const wrap = document.createElement('div');
    wrap.className='card';
    wrap.style.background='rgba(0,0,0,.15)';
    wrap.innerHTML = `
      <strong>Email sign-in (fallback)</strong>
      <div class="small">Use this if Google sign-in isn't configured.</div>
      <label>Email</label>
      <input class="input" id="email" placeholder="you@gmail.com" inputmode="email"/>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="signin">Continue</button>
      </div>
    `;
    box.prepend(wrap);
    wrap.querySelector('#signin').addEventListener('click', async ()=>{
      const email = wrap.querySelector('#email').value.trim();
      try{
        await apiPost('/api/customer/login', { email });
        toast('Signed in');
        el('claimSub').textContent = 'Signed in — claim your point.';
      }catch(e){
        toast('Sign-in failed');
      }
    });
  } else {
    el('claimSub').textContent = 'Signed in — you can claim this point.';
  }

  el('claimBtn').addEventListener('click', claim);
})();
