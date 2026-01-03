import { qs } from './api.js';
const u = qs('u') || '';
const c = qs('c') || '';
document.getElementById('code').textContent = c || '----';
const box = document.getElementById('qr');
box.innerHTML = '';
new window.QRCode(box, { text: u, width: 240, height:240 });
