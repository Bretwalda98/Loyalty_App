import { apiGet, apiPost, toast, fmtTime } from './api.js';

const el = (id)=>document.getElementById(id);

let currentToken = null;
let autoTimer = null;
let stream = null;
let scanning = false;

function setQr(url){
  const box = el('qr');
  box.innerHTML = '';
  new window.QRCode(box, { text:url, width: 300, height:300 });
}

async function createToken(){
  try{
    const data = await apiPost('/api/vendor/token', {});
    currentToken = data;
    setQr(data.claimUrl);
    el('receiptCode').textContent = data.receipt_code || '----';
    el('expiryText').textContent = 'Expiry: ' + fmtTime(data.expires_at);
    toast('New token ready');
  }catch(e){
    toast(e.data?.error === 'not_authenticated' ? 'Vendor not signed in' : 'Could not create token');
  }
}

async function loadSettings(){
  try{
    const data = await apiGet('/api/vendor/store');
    el('storeName').textContent = data.store.name;
    el('storeMeta').textContent = 'Store ID: ' + data.store.store_id;
    el('pointsPerEarn').value = data.program.points_per_earn;
    el('tokenExpiry').value = data.program.token_expiry_minutes;
    el('pointsExpireDays').value = data.program.points_expire_days ?? '';
    el('maxEarn10').value = data.program.max_earns_per_10min ?? 0;
    el('maxEarnDay').value = data.program.max_earns_per_day ?? 0;
    toast('Settings loaded');
  }catch(e){
    // ignore if not logged in
  }
}

el('vendorLogin').addEventListener('click', async ()=>{
  const store_id = el('storeId').value.trim();
  const pin = el('pin').value.trim();
  try{
    await apiPost('/api/vendor/login', { store_id, pin });
    toast('Vendor signed in');
    await loadSettings();
    await createToken();
  }catch(e){
    toast('Bad store/PIN (run /admin/setup first)');
  }
});

el('vendorLogout').addEventListener('click', async ()=>{
  await apiPost('/api/logout', {});
  toast('Logged out');
  currentToken = null;
  el('qr').innerHTML='';
  el('receiptCode').textContent='----';
  el('expiryText').textContent='Expiry: --';
});

el('nextSale').addEventListener('click', createToken);

el('autoRotate').addEventListener('change', ()=>{
  if(autoTimer) clearInterval(autoTimer);
  const secs = parseInt(el('autoRotate').value, 10);
  if(secs > 0){
    autoTimer = setInterval(()=>createToken(), secs*1000);
    toast('Auto-rotate on');
  }else{
    toast('Auto-rotate off');
  }
});

el('printReceipt').addEventListener('click', ()=>{
  if(!currentToken?.claimUrl) return toast('No token to print');
  const url = `/receipt?u=${encodeURIComponent(currentToken.claimUrl)}&c=${encodeURIComponent(currentToken.receipt_code||'')}`;
  window.open(url, '_blank');
});

el('voidToken').addEventListener('click', async ()=>{
  if(!currentToken?.token_id) return toast('No token');
  try{
    await apiPost('/api/vendor/token/void', { token_id: currentToken.token_id });
    toast('Token voided');
    await createToken();
  }catch(e){
    toast('Could not void token');
  }
});

el('loadSettings').addEventListener('click', loadSettings);

el('saveSettings').addEventListener('click', async ()=>{
  try{
    await apiPost('/api/vendor/program', {
      points_per_earn: el('pointsPerEarn').value,
      token_expiry_minutes: el('tokenExpiry').value,
      points_expire_days: el('pointsExpireDays').value,
      max_earns_per_10min: el('maxEarn10').value,
      max_earns_per_day: el('maxEarnDay').value,
    });
    toast('Saved');
  }catch(e){
    toast('Save failed (are you signed in?)');
  }
});

el('addReward').addEventListener('click', async ()=>{
  try{
    await apiPost('/api/vendor/reward', {
      name: el('rewardName').value,
      points_cost: el('rewardCost').value
    });
    toast('Reward added');
    el('rewardName').value='';
  }catch(e){
    toast('Add reward failed');
  }
});

function extractRedeemToken(text){
  if(!text) return null;
  const s = String(text).trim();
  // accept raw token: rt_xxx...
  if(s.startsWith('rt_')) return s;
  // accept URL containing ?rt=...
  try{
    const u = new URL(s);
    const rt = u.searchParams.get('rt');
    if(rt) return rt;
  }catch(e){}
  // accept if pasted just the suffix
  if(s.length > 10 && !s.includes(' ')) return 'rt_' + s.replace(/^rt_/,'');
  return null;
}

async function approveRedeemFromText(text){
  const rt = extractRedeemToken(text);
  if(!rt) return toast('No redeem token found');
  try{
    const out = await apiPost('/api/vendor/redeem/complete', { redeem_token: rt });
    toast(`Approved: ${out.reward_name}`);
  }catch(e){
    const msg = e.data?.error || 'approve_failed';
    if(msg === 'redeem_token_expired') toast('Redemption QR expired');
    else if(msg === 'not_pending') toast('Already used');
    else if(msg === 'wrong_merchant') toast('Wrong shop');
    else if(msg === 'insufficient_points') toast('Customer has insufficient points');
    else toast('Approval failed');
  }
}

el('approveRedeem').addEventListener('click', ()=>{
  approveRedeemFromText(el('redeemInput').value);
});

// --- Camera scanning (BarcodeDetector) ---
const scanModal = el('scanModal');
const video = el('video');

async function stopScan(){
  scanning = false;
  if(stream){
    stream.getTracks().forEach(t=>t.stop());
    stream = null;
  }
  scanModal.classList.remove('show');
}

async function startScan(){
  if(!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia){
    toast('Camera not available');
    return;
  }
  scanModal.classList.add('show');

  try{
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio:false });
    video.srcObject = stream;
  }catch(e){
    toast('Camera permission denied');
    return stopScan();
  }

  if(!('BarcodeDetector' in window)){
    toast('Scanner not supported on this browser. Paste token instead.');
    return;
  }

  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  scanning = true;

  const tick = async ()=>{
    if(!scanning) return;
    try{
      const barcodes = await detector.detect(video);
      if(barcodes && barcodes.length){
        const raw = barcodes[0].rawValue || '';
        await stopScan();
        await approveRedeemFromText(raw);
        return;
      }
    }catch(e){}
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

el('scanRedeem').addEventListener('click', startScan);
el('closeScan').addEventListener('click', stopScan);
scanModal.addEventListener('click', (e)=>{ if(e.target === scanModal) stopScan(); });

// Attempt load (if session exists)
loadSettings().then(()=>createToken()).catch(()=>{});

// Spacebar to generate next sale
window.addEventListener('keydown', (e)=>{
  if(e.code === 'Space'){
    e.preventDefault();
    createToken();
  }
});
