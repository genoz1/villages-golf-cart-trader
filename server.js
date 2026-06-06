/**
 * Villages Golf Cart Trader — Backend Server
 * Handles Stripe Checkout sessions for listing payments
 *
 * Setup:
 *   npm install express stripe cors dotenv multer
 *   cp .env.example .env  → fill in your Stripe keys
 *   node server.js
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const Stripe   = require('stripe');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.SITE_URL || 'http://localhost:3000' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));          // serve the frontend

// Photo uploads: stored in /uploads, max 20 files × 10MB each
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = Date.now() + '-' + Math.random().toString(36).slice(2) + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ── In-memory listing store (replace with a real DB in production) ──────────
const listings = new Map();   // listingId → listingData
let nextId = 1000;

// ── STRIPE PRICE IDs ────────────────────────────────────────────────────────
// Create these once in your Stripe dashboard (one-time prices):
//   Private Seller  $9.99   → STRIPE_PRICE_PRIVATE
//   Featured        $19.99  → STRIPE_PRICE_FEATURED
//   Dealer/mo       $49.00  → STRIPE_PRICE_DEALER  (recurring)
const PRICES = {
  private:  process.env.STRIPE_PRICE_PRIVATE,   // $9.99 one-time
  featured: process.env.STRIPE_PRICE_FEATURED,  // $19.99 one-time
  dealer:   process.env.STRIPE_PRICE_DEALER,    // $49/mo recurring
};

// ── POST /api/upload-photos ─────────────────────────────────────────────────
// Upload photos before creating a listing. Returns array of local URLs.
app.post('/api/upload-photos', upload.array('photos', 20), (req, res) => {
  const urls = req.files.map(f => `/uploads/${f.filename}`);
  res.json({ urls });
});

// ── POST /api/create-checkout ───────────────────────────────────────────────
// Body: { listingType, listing: { title, make, model, ... }, photoUrls: [] }
// Returns: { url } — redirect the browser here to complete payment
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { listingType = 'private', listing, photoUrls = [] } = req.body;

    if (!listing || !listing.title) {
      return res.status(400).json({ error: 'Listing data required' });
    }

    const priceId = PRICES[listingType];
    if (!priceId) {
      return res.status(400).json({ error: `Unknown listing type: ${listingType}` });
    }

    // Save the pending listing so we can activate it after payment
    const tempId = String(nextId++);
    listings.set(tempId, {
      ...listing,
      id:         tempId,
      type:       listingType === 'featured' ? 'Featured' : 'Local',
      status:     'Pending',      // activated by webhook
      photoUrls,
      daysLeft:   30,
      createdAt:  new Date().toISOString(),
    });

    const siteUrl    = process.env.SITE_URL || 'http://localhost:3000';
    const isRecurring = listingType === 'dealer';

    const session = await stripe.checkout.sessions.create({
      mode: isRecurring ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { tempId, listingType },
      customer_email: listing.email || undefined,
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&listing=${tempId}`,
      cancel_url:  `${siteUrl}/sell.html?cancelled=1`,
      // Collect billing address for tax purposes (optional — remove if not needed)
      // billing_address_collection: 'auto',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe-webhook ─────────────────────────────────────────────────
// Stripe calls this when payment succeeds. Activate the listing.
// In production: set STRIPE_WEBHOOK_SECRET in .env and verify the signature.
app.post('/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = secret
        ? stripe.webhooks.constructEvent(req.body, sig, secret)
        : JSON.parse(req.body);            // dev fallback — no sig check
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { tempId, listingType } = session.metadata || {};

      if (tempId && listings.has(tempId)) {
        const listing = listings.get(tempId);
        listing.status      = 'Active';
        listing.paidAt      = new Date().toISOString();
        listing.stripeSession = session.id;
        console.log(`✅ Listing ${tempId} activated (${listingType})`);
        // In production: persist to your database here
      }
    }

    res.json({ received: true });
  }
);

// ── GET /api/listing/:id ────────────────────────────────────────────────────
// Returns listing data so success.html can show a confirmation summary.
app.get('/api/listing/:id', (req, res) => {
  const listing = listings.get(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Not found' });
  // Omit sensitive seller contact info from public response in production
  const { email, phone, ...safe } = listing;
  res.json(safe);
});

// ── GET /api/listings ───────────────────────────────────────────────────────
// Returns all Active listings (to replace the hard-coded LISTINGS array).
app.get('/api/listings', (req, res) => {
  const active = [...listings.values()].filter(l => l.status === 'Active');
  res.json(active);
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🛺  Villages Golf Cart Trader server running`);
  console.log(`   http://localhost:${PORT}\n`);
});
