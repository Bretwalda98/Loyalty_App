import { apiGet, qs, toast, fmtTime } from './api.js';

const rt = qs('rt');
const el = (id)=>document.getElementById(id);

function setQr(url){
  const box = document.getElementById('qr');
  box.innerHTML='';
  new window.QRCode(box, { text:url, width: 280, height: 280 });
}

async function check(){
  if(!rt) return;
  try{
    const data = await apiGet('/api/customer/redeem/status/' + encodeURIComponent(rt));
    if(data.redeem_expires_at) el('exp').textContent = 'Expiry: ' + fmtTime(data.redeem_expires_at);
    if(data.status === 'COMPLETED'){
      el('rSub').textContent = 'Approved ✅ You can close this page.';
      toast('Approved');
      return true;
    }
    if(data.status !== 'PENDING'){
      el('rSub').textContent = `Status: ${data.status}`;
      return false;
    }
    el('rSub').textContent = 'Waiting for staff approval…';
    return false;
  }catch(e){
    toast('Please sign in');
    window.location.href = '/wallet';
  }
}

(async ()=>{
  if(!rt){
    el('rTitle').textContent = 'Invalid redemption';
    el('rSub').textContent = 'Missing token.';
    return;
  }
  el('rt').textContent = rt.replace('rt_','');
  const url = `${window.location.origin}/redeem?rt=${encodeURIComponent(rt)}`;
  setQr(url);

  el('checkBtn').addEventListener('click', check);

  // auto-poll
  await check();
  const timer = setInterval(async ()=>{
    const done = await check();
    if(done) clearInterval(timer);
  }, 2500);
})();
