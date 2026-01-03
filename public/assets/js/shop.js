import { apiGet, apiPost, qs, toast, escapeHtml } from './api.js';

const el = (id)=>document.getElementById(id);
const merchant = qs('merchant');

async function loadShop(){
  if(!merchant) return toast('Missing merchant');
  try{
    const data = await apiGet('/api/customer/shop/' + encodeURIComponent(merchant));
    el('shopName').textContent = data.merchant.name;

    const exp = data.program.points_expire_days ? `${data.program.points_expire_days} days` : 'Never';
    el('shopPolicy').textContent = `Points per scan: ${data.program.points_per_earn} • Point expiry: ${exp}`;
    el('balance').textContent = data.balance;

    const list = el('rewards');
    list.innerHTML = '';
    if(!data.rewards.length){
      el('rewardStatus').textContent = 'No rewards set';
      return;
    }
    el('rewardStatus').textContent = 'Loaded';

    data.rewards.forEach(r=>{
      const div = document.createElement('div');
      div.className='item';
      div.innerHTML = `
        <div>
          <strong>${escapeHtml(r.name)}</strong>
          <div class="meta">${r.points_cost} points</div>
        </div>
        <button class="btn ${data.balance >= r.points_cost ? 'primary' : ''}" ${data.balance >= r.points_cost ? '' : 'disabled'}>
          Redeem
        </button>
      `;
      div.querySelector('button').addEventListener('click', async ()=>{
        try{
          const out = await apiPost('/api/customer/redeem/start', { merchant_id: merchant, reward_id: r.reward_id });
          // show redemption QR page
          window.location.href = `/redeem?rt=${encodeURIComponent(out.redeem_token)}`;
        }catch(e){
          toast(e.data?.error === 'insufficient_points' ? 'Not enough points' : 'Redeem failed');
        }
      });
      list.appendChild(div);
    });
  }catch(e){
    toast('Please sign in');
    window.location.href = '/wallet';
  }
}

el('refreshShop').addEventListener('click', loadShop);
loadShop();
