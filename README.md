# Loyalty QR MVP (v0.2)

Mobile-friendly **web app** (vendor + customer) for QR-based loyalty.
Runs on phones/tablets in a browser.

## What's new in v0.2
- ✅ **Redemption validation**: customer shows a redemption QR → vendor scans/approves → points are deducted then.
- ✅ **True point expiry**: points are stored as expiring "lots" and expire correctly (no double-subtract).
- ✅ **Google login**: proper Sign in with Google (ID token verification on the server).

## Vendor workflow
- Vendor logs in with Store ID + PIN
- Vendor taps **NEXT SALE** to generate a unique **earn QR** (or turns on auto-rotate)
- Customer scans → signs in → claims point
- When customer redeems:
  - Customer taps Redeem → shows a **redemption QR**
  - Vendor scans/approves → reward is validated + points are deducted

## Customer workflow
- Wallet lists all shops + current points
- Shop page shows rewards and points
- Scanning an earn QR opens the Claim page automatically
- Redeeming shows a redemption QR for staff approval

## Setup
1) Install Node.js (LTS)
2) Copy `.env.example` to `.env` and set secrets:
   - `JWT_SECRET`
   - `ADMIN_SETUP_KEY`
   - `GOOGLE_CLIENT_ID` (recommended)
3) Install + start:
   ```bash
   npm install
   npm start
   ```
4) One-time demo seed:
   - http://localhost:3000/admin/setup?key=setup-me-please

### Demo credentials
- Store ID: `morgany-main`
- PIN: `1234`

## Phone testing
On same Wi‑Fi, open your PC LAN IP:
- Vendor: `http://YOUR_LAN_IP:3000/vendor`
- Customer: `http://YOUR_LAN_IP:3000/`

## Note: “QR on the receipt”
Without POS integration, a website cannot inject a QR into an existing till receipt.
This MVP includes a **printable receipt page** as the simplest workaround.
A real integration would call `/api/vendor/token` and print the returned URL/QR.

