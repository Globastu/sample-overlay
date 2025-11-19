Overlay Widget (Vanilla JS + Shadow DOM)

Quick start
- npm run dev
- Open http://localhost:3000
- Click the floating Gifts button to open the overlay.

Pages
- public/index.html – Mock landing page using the widget
- public/overlay-demo.html – Minimal harness including the widget

Widget embed
<script src="/overlay-widget.js"
        data-merchant-id="demo-merchant-1"
        data-api-key="YOUR_API_KEY"
        data-api-base="https://your-bff.example.com"></script>

Notes
- data-api-key: Optional locally; add if your BFF enforces x-overlay-key (see WIDGET_OVERLAY_KEY).
- data-api-base: If omitted, requests go to the same origin as the page.

Local dev server (no deps)
- Serves static files from ./public on http://localhost:3000
- Endpoints: GET /api/bff/demo/catalog, POST /api/bff/demo/purchase
- By default, returns an empty catalog and 501 for purchase (no demo data). Set UPSTREAM_BFF_BASE to proxy to a real BFF.

Environment variables
- PORT: Default 3000
- WIDGET_OVERLAY_KEY: If set, dev server requires header x-overlay-key to match. The widget will send this if data-api-key is set.
- UPSTREAM_BFF_BASE: If set, the dev server will proxy /api/bff/demo/* to this base URL (e.g., https://your-bff.example.com). Otherwise, catalog returns [] and purchase returns {error: "NO_UPSTREAM"}.

Deploying to Vercel (static hosting)
1) Create a new GitHub repository and push this project.
2) In Vercel, import the repo. Framework preset: "Other" (static).
3) Build command: none. Output directory: public
4) Add the script tag to your hosted page with correct data attributes:
   - data-merchant-id
   - data-api-base (point to your BFF origin)
   - data-api-key (if your BFF requires x-overlay-key)

BFF expectations
- GET  /api/bff/demo/catalog?merchantId=... -> { merchantId, offers: [{ id, merchantId, name, description, currency, amountMinor, maxPerOrder, imageUrl, tags, active }] }
- POST /api/bff/demo/purchase with { merchantId, buyer:{name,email}, recipient:{email}, items:[{offerId,qty}] }
  -> { orderId, merchantId, currency, subtotalMinor, feeMinor, totalMinor, buyer, giftCards:[{ code, offerId, valueMinor, currency, recipientEmail }] }

Troubleshooting
- If you see NO_UPSTREAM locally, set UPSTREAM_BFF_BASE to your BFF URL or include data-api-base in the script tag to hit the BFF directly.
- CORS: Ensure your BFF allows the origin of your page. The widget sends x-overlay-key only when data-api-key is set.

