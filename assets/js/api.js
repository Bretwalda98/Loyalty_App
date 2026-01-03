export async function apiGet(url){
  const r = await fetch(url, { credentials:'include' });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw Object.assign(new Error(j.error || 'request_failed'), { data:j, status:r.status });
  return j;
}
export async function apiPost(url, body){
  const r = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    credentials:'include',
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(()=> ({}));
  if(!r.ok) throw Object.assign(new Error(j.error || 'request_failed'), { data:j, status:r.status });
  return j;
}
export function qs(name){
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}
export function toast(msg){
  const el = document.querySelector('#toast');
  if(!el) return alert(msg);
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(()=>el.classList.remove('show'), 2600);
}
export function fmtTime(secs){
  const d = new Date(secs*1000);
  return d.toLocaleString();
}
export function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[c]));
}
