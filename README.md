# Villages Golf Cart Trader

Paid local golf cart marketplace for The Villages, FL and surrounding communities.

## Stack

- **Frontend**: Vanilla HTML/CSS/JS (no build step)
- **Backend**: Node.js + Express
- **Payments**: Stripe Checkout
- **Photos**: Multer (local disk — swap for S3/Cloudflare R2 in production)

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to find it |
|---|---|
| `STRIPE_SECRET_KEY` | [Stripe Dashboard → API Keys](https://dashboard.stripe.com/apikeys) |
| `STRIPE_PUBLISHABLE_KEY` | Same page (starts with `pk_`) |
| `STRIPE_WEBHOOK_SECRET` | See Webhooks section below |
| `STRIPE_PRICE_PRIVATE` | Create a $9.99 one-time price (see below) |
| `STRIPE_PRICE_FEATURED` | Create a $19.99 one-time price |
| `STRIPE_PRICE_DEALER` | Create a $49/mo recurring price |

### 3. Create Stripe Products & Prices

In your [Stripe Dashboard → Products](https://dashboard.stripe.com/products):

1. **Private Seller Listing** → $9.99 → One time → copy the Price ID → `STRIPE_PRICE_PRIVATE`
2. **Featured Listing** → $19.99 → One time → copy → `STRIPE_PRICE_FEATURED`
3. **Dealer Monthly** → $49.00 → Recurring monthly → copy → `STRIPE_PRICE_DEALER`

### 4. Set up Stripe webhook (local dev)

Install the [Stripe CLI](https://stripe.com/docs/stripe-cli) then run:

```bash
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

Copy the webhook signing secret it prints (starts with `whsec_`) into `STRIPE_WEBHOOK_SECRET`.

### 5. Start the server

```bash
npm start
# or for auto-reload during dev:
npm run dev
```

Open **http://localhost:3000** — the site is served from the project folder.

---

## How the payment flow works

```
Buyer fills sell form
       ↓
POST /api/upload-photos  (photos uploaded first)
       ↓
POST /api/create-checkout  (listing saved as "Pending", Stripe session created)
       ↓
Browser redirects → Stripe Checkout page
       ↓
  [User pays]
       ↓
Stripe → POST /api/stripe-webhook  (listing status → "Active")
       ↓
Browser redirects → /success.html?listing=<id>
```

---

## Production checklist

- [ ] Replace in-memory `listings` Map with a real database (PostgreSQL, SQLite, MongoDB)
- [ ] Replace local `multer` uploads with S3 / Cloudflare R2
- [ ] Add email sending (Postmark / Resend) for listing confirmation + renewal reminders
- [ ] Add authentication (magic link or OAuth) so sellers can manage their own listings
- [ ] Set `SITE_URL` to your production domain in `.env`
- [ ] Configure your Stripe webhook endpoint in the Stripe Dashboard for production
- [ ] Enable HTTPS
- [ ] Set `NODE_ENV=production` and use a process manager (PM2 / Railway / Render)

---

## Pages

| File | Description |
|---|---|
| `index.html` | Homepage with featured + latest listings |
| `listings.html` | Browse / filter all listings |
| `sell.html` | Create a listing + Stripe Checkout flow |
| `success.html` | Post-payment confirmation page |
| `account.html` | Seller dashboard (manage listings) |
| `listing-detail.html` | Individual listing view |
| `pricing.html` | Pricing plans |
| `dealers.html` | Dealer directory |
| `contact.html` | Contact form |
| `listing-renewal-rules.html` | Renewal policy |
| `server.js` | Express backend + Stripe integration |
