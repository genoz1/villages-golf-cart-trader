/**
 * Villages Golf Cart Trader — Backend Server
 * Now with Supabase database integration
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const Stripe   = require('stripe');
const multer   = require('multer');
const path     = require('path');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

// ── Email (Zoho SMTP) ───────────────────────────────────────────────────────
// Requires env vars: ZOHO_USER (info@villagesgolfcarttrader.com) and ZOHO_APP_PASSWORD
const mailer = nodemailer.createTransport({
  host: 'smtppro.zoho.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_APP_PASSWORD,
  },
});

async function sendMail(to, subject, html) {
  if (!process.env.ZOHO_USER || !process.env.ZOHO_APP_PASSWORD) {
    console.warn('Email skipped — ZOHO_USER / ZOHO_APP_PASSWORD not set');
    return false;
  }
  try {
    await mailer.sendMail({
      from: `"Villages Golf Cart Trader" <${process.env.ZOHO_USER}>`,
      to, subject, html,
    });
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    return false;
  }
}

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.SITE_URL || 'http://localhost:3000' }));
// IMPORTANT: Stripe webhook signature verification needs the RAW request body.
// express.json() would parse/re-serialize it and break the signature, so we
// skip JSON parsing for the webhook path and let its own express.raw() handle it.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe-webhook') return next();
  express.json()(req, res, next);
});
app.use(express.static(path.join(__dirname)));

// Photo uploads — use memory storage then upload to Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// ── Stripe Price IDs ────────────────────────────────────────────────────────
const PRICES = {
  private:  process.env.STRIPE_PRICE_PRIVATE,
  featured: process.env.STRIPE_PRICE_FEATURED,
  dealer:   process.env.STRIPE_PRICE_DEALER,
};

// ── POST /api/upload-photos ─────────────────────────────────────────────────
app.post('/api/upload-photos', upload.array('photos', 20), async (req, res) => {
  try {
    const urls = await Promise.all(req.files.map(async (file) => {
      const ext      = file.originalname.split('.').pop();
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const { error } = await supabase.storage
        .from('listing-photos')
        .upload(filename, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (error) throw new Error(error.message);

      const { data } = supabase.storage
        .from('listing-photos')
        .getPublicUrl(filename);

      return data.publicUrl;
    }));

    res.json({ urls });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/validate-promo ────────────────────────────────────────────────
app.post('/api/validate-promo', async (req, res) => {
  const { code, listingType } = req.body;
  if(!code) return res.status(400).json({ valid: false, error: 'No code provided' });

  const { data, error } = await supabase
    .from('promo_codes')
    .select('*')
    .eq('code', code.toUpperCase())
    .eq('active', true)
    .single();

  if(error || !data) return res.json({ valid: false, error: 'Invalid or expired promo code.' });

  if(data.uses >= data.max_uses) {
    const msg = data.listing_type === 'dealer'
      ? 'Sorry, this promo code has been claimed by all 5 dealers. You can still sign up for just $49/month — cancel anytime!'
      : 'Sorry, this promo code has been claimed by all 20 sellers. You can still list your cart for just $9.99 for 30 days!';
    return res.json({ valid: false, error: msg });
  }

  if(data.listing_type !== listingType) return res.json({ valid: false, error: `This code is only valid for ${data.listing_type} listings.` });

  res.json({ valid: true, listingType: data.listing_type });
});

// ── POST /api/create-checkout ───────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { listingType = 'private', listing, photoUrls = [], promoCode } = req.body;

    if (!listing || !listing.title) {
      return res.status(400).json({ error: 'Listing data required' });
    }

    // Standard private listings are now FREE and go live immediately.
    // Only 'featured' and 'dealer' listings are paid.
    let isFree = (listingType === 'private');

    // (Promo codes still supported for paid tiers, e.g. featured, if ever needed)
    if(!isFree && promoCode) {
      const { data: promo } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', promoCode.toUpperCase())
        .eq('active', true)
        .eq('listing_type', listingType)
        .single();

      if(promo && promo.uses < promo.max_uses) {
        isFree = true;
        await supabase
          .from('promo_codes')
          .update({ uses: promo.uses + 1, active: promo.uses + 1 < promo.max_uses })
          .eq('id', promo.id);
      }
    }

    const priceId = PRICES[listingType];
    if (!priceId && !isFree) {
      return res.status(400).json({ error: `Unknown listing type: ${listingType}` });
    }

    // Free-listing limit: a private seller may have at most 2 active free listings.
    // This keeps the free tier for genuine private sellers and nudges multi-cart
    // dealers toward the paid Dealer plan.
    const FREE_LISTING_LIMIT = 2;
    if (isFree && listingType === 'private' && listing.email) {
      const { count } = await supabase
        .from('listings')
        .select('id', { count: 'exact', head: true })
        .eq('seller_email', listing.email)
        .eq('listing_type', 'Local')
        .eq('is_sample', false)
        .in('status', ['Active', 'Expired']);

      if ((count || 0) >= FREE_LISTING_LIMIT) {
        return res.status(403).json({
          limitReached: true,
          error: `You've reached the limit of ${FREE_LISTING_LIMIT} free listings. Got more carts to sell? Our Dealer plan offers unlimited listings, a dealer badge, and a profile page for $49/month — cancel anytime.`,
        });
      }
    }

    const { data, error } = await supabase
      .from('listings')
      .insert([{
        title:            listing.title,
        make:             listing.make,
        model:            listing.model,
        year:             listing.year,
        price:            listing.price,
        power:            listing.power,
        seats:            listing.seats,
        street_legal:     listing.streetLegal || false,
        location:         listing.location,
        description:      listing.desc,
        seller_name:      listing.name,
        seller_email:     listing.email,
        seller_phone:     listing.phone,
        photo_urls:       photoUrls,
        status:           isFree ? 'Active' : 'Pending',
        listing_type:     listingType === 'featured' ? 'Featured' : 'Local',
        is_sample:        false,
        days_left:        30,
      }])
      .select()
      .single();

    if (error) throw new Error(error.message);

    // If free listing skip Stripe and return directly
    if(isFree) {
      return res.json({ free: true, listingId: data.id });
    }

    const siteUrl     = process.env.SITE_URL || 'https://villagesgolfcarttrader.com';
    const isRecurring = listingType === 'dealer';

    const session = await stripe.checkout.sessions.create({
      mode: isRecurring ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { listingId: data.id, listingType },
      customer_email: listing.email || undefined,
      success_url: `${siteUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&listing=${data.id}`,
      cancel_url:  `${siteUrl}/sell.html?cancelled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe-webhook ─────────────────────────────────────────────────
app.post('/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = secret
        ? stripe.webhooks.constructEvent(req.body, sig, secret)
        : JSON.parse(req.body);
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { listingId, dealerEmail, dealerName, businessName } = session.metadata || {};

      if (listingId) {
        const { error } = await supabase
          .from('listings')
          .update({
            status:            'Active',
            paid_at:           new Date().toISOString(),
            stripe_session_id: session.id,
          })
          .eq('id', listingId);

        if (error) console.error('Webhook update error:', error.message);
        else console.log(`✅ Listing ${listingId} activated`);

      } else if (dealerEmail) {
        const customerId     = session.customer;
        const subscriptionId = session.subscription;

        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
          email: dealerEmail,
          email_confirm: true,
          user_metadata: { full_name: dealerName, business_name: businessName }
        });

        if (authError && !authError.message.includes('already been registered')) {
          console.error('Auth user creation error:', authError.message);
        }

        const userId = authUser?.user?.id;

        if (userId) {
          await supabase.from('profiles').upsert([{
            id:                     userId,
            email:                  dealerEmail,
            full_name:              dealerName,
            role:                   'dealer',
            dealer_active:          true,
            stripe_customer_id:     customerId,
            dealer_subscription_id: subscriptionId,
          }]);
        }

        console.log(`✅ Dealer account created: ${dealerEmail}`);

        await supabase.auth.admin.generateLink({
          type: 'magiclink',
          email: dealerEmail,
        });
      }
    }

    if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
      const customerId = event.data.object.customer;
      const { data: profiles } = await supabase
        .from('profiles').select('id').eq('stripe_customer_id', customerId);

      if (profiles && profiles.length > 0) {
        const userId = profiles[0].id;
        await supabase.from('profiles').update({ dealer_active: false }).eq('id', userId);
        await supabase.from('listings').update({ status: 'Hidden' }).eq('user_id', userId);
        console.log(`⚠️ Dealer subscription cancelled: ${customerId}`);
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const customerId = event.data.object.customer;
      const { data: profiles } = await supabase
        .from('profiles').select('id').eq('stripe_customer_id', customerId);

      if (profiles && profiles.length > 0) {
        const userId = profiles[0].id;
        await supabase.from('profiles').update({ dealer_active: true }).eq('id', userId);
        await supabase.from('listings').update({ status: 'Active' }).eq('user_id', userId).eq('status', 'Hidden');
        console.log(`✅ Dealer subscription renewed: ${customerId}`);
      }
    }

    res.json({ received: true });
  }
);

// ── GET /api/listings ───────────────────────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .eq('status', 'Active')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/listing/:id ────────────────────────────────────────────────────
app.get('/api/listing/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) return res.status(404).json({ error: 'Not found' });
  const { seller_email, seller_phone, ...safe } = data;
  res.json(safe);
});

// ── POST /api/dealer-checkout ───────────────────────────────────────────────
app.post('/api/dealer-checkout', async (req, res) => {
  try {
    const { dealer, promoCode } = req.body;
    if (!dealer || !dealer.email) {
      return res.status(400).json({ error: 'Dealer info required' });
    }

    // Check dealer promo code
    let trialDays = 0;
    if(promoCode) {
      const { data: promo } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', promoCode.toUpperCase())
        .eq('active', true)
        .eq('listing_type', 'dealer')
        .single();

      if(promo && promo.uses < promo.max_uses) {
        trialDays = 30;
        await supabase
          .from('promo_codes')
          .update({ uses: promo.uses + 1, active: promo.uses + 1 < promo.max_uses })
          .eq('id', promo.id);
      }
    }

    const siteUrl = process.env.SITE_URL || 'https://villagesgolfcarttrader.com';

    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_DEALER, quantity: 1 }],
      customer_email: dealer.email,
      metadata: {
        dealerEmail:    dealer.email,
        dealerName:     dealer.name,
        businessName:   dealer.businessName,
        dealerPhone:    dealer.phone,
        dealerLocation: dealer.location,
        dealerDesc:     dealer.description || '',
      },
      success_url: `${siteUrl}/account.html?dealer=new`,
      cancel_url:  `${siteUrl}/dealer-signup.html?cancelled=1`,
    };

    if(trialDays > 0) {
      sessionParams.subscription_data = { trial_period_days: trialDays };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Dealer checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/seed-samples ──────────────────────────────────────────────────
app.post('/api/seed-samples', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const samples = [
    { title:"2022 Club Car Onward Lithium", make:"Club Car", model:"Onward", year:"2022", price:12995, power:"Lithium", seats:"4", street_legal:true, location:"The Villages", description:"Clean 4-passenger lithium cart with upgraded premium seats, full LED lighting package, fold-down windshield, side mirrors, rear seat flip kit, and chrome accents. Garage kept, lightly used in The Villages. Runs perfectly.", seller_name:"John M.", seller_email:"john@example.com", seller_phone:"(352) 555-0101", photo_urls:["https://images.unsplash.com/photo-1593436975846-c6d5a92e6c54?w=800&q=80&auto=format&fit=crop"], listing_type:"Featured", is_sample:true, status:"Active", days_left:27 },
    { title:"2020 EZGO RXV Electric", make:"EZGO", model:"RXV", year:"2020", price:8750, power:"Electric", seats:"4", street_legal:true, location:"Lady Lake", description:"Well-maintained EZGO RXV with new batteries (2023), street legal package, custom rear seat, and USB charging port. Non-smoking owner. Stored indoors.", seller_name:"Carol B.", seller_email:"carol@example.com", seller_phone:"(352) 555-0202", photo_urls:["https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?w=800&q=80&auto=format&fit=crop"], listing_type:"Local", is_sample:true, status:"Active", days_left:3 },
    { title:"2023 Yamaha Drive2 Gas", make:"Yamaha", model:"Drive2", year:"2023", price:10900, power:"Gas", seats:"2", street_legal:true, location:"Wildwood", description:"Nearly new 2023 Yamaha Drive2 with only 200 miles. All original, full warranty still active. Street legal, custom wheels, and upgraded sound system.", seller_name:"Mike T.", seller_email:"mike@example.com", seller_phone:"(352) 555-0303", photo_urls:["https://images.unsplash.com/photo-1551698618-1dfe5d97d256?w=800&q=80&auto=format&fit=crop"], listing_type:"Local", is_sample:true, status:"Active", days_left:18 },
    { title:"2019 Club Car Precedent", make:"Club Car", model:"Precedent", year:"2019", price:6995, power:"Electric", seats:"4", street_legal:false, location:"Oxford", description:"Dependable Club Car Precedent with new 48V batteries, upgraded headlights and taillights, and fold-down windshield. Great daily driver in The Villages.", seller_name:"Linda R.", seller_email:"linda@example.com", seller_phone:"(352) 555-0404", photo_urls:["https://images.unsplash.com/photo-1535131749006-b7f58c99034b?w=800&q=80&auto=format&fit=crop"], listing_type:"Local", is_sample:true, status:"Active", days_left:22 },
    { title:"2021 Evolution D5 Lifted", make:"Evolution", model:"D5", year:"2021", price:13500, power:"Lithium", seats:"6", street_legal:true, location:"The Villages", description:"Lifted 6-passenger Evolution D5 with 4-inch lift kit, all-terrain tires, premium audio, LED underglow, and custom camo wrap. Turns heads everywhere.", seller_name:"Dave K.", seller_email:"dave@example.com", seller_phone:"(352) 555-0505", photo_urls:["https://images.unsplash.com/photo-1593436975846-c6d5a92e6c54?w=800&q=80&auto=format&fit=crop&sat=20"], listing_type:"Featured", is_sample:true, status:"Active", days_left:14 },
    { title:"2018 EZGO TXT Electric", make:"EZGO", model:"TXT", year:"2018", price:5950, power:"Electric", seats:"2", street_legal:false, location:"Leesburg", description:"Basic but reliable 2018 EZGO TXT. New batteries in 2022, fresh tune-up, clean condition. Great starter cart or spare for guests.", seller_name:"Pat S.", seller_email:"pat@example.com", seller_phone:"(352) 555-0606", photo_urls:["https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?w=800&q=80&auto=format&fit=crop&sat=-20"], listing_type:"Local", is_sample:true, status:"Active", days_left:8 },
    { title:"2022 ICON i40L Lithium", make:"ICON", model:"i40L", year:"2022", price:11500, power:"Lithium", seats:"4", street_legal:true, location:"The Villages", description:"ICON i40L with lithium battery, full enclosure, custom seat covers, rear storage bag, and side mirrors. Perfect condition.", seller_name:"Nancy W.", seller_email:"nancy@example.com", seller_phone:"(352) 555-0707", photo_urls:["https://images.unsplash.com/photo-1551698618-1dfe5d97d256?w=800&q=80&auto=format&fit=crop&sat=20"], listing_type:"Local", is_sample:true, status:"Active", days_left:20 },
    { title:"2017 Club Car DS Gas", make:"Club Car", model:"DS", year:"2017", price:4500, power:"Gas", seats:"2", street_legal:false, location:"Lady Lake", description:"Older but very solid Club Car DS gas model. Runs great, no issues. Good candidate for a custom build. Priced to sell.", seller_name:"Tom H.", seller_email:"tom@example.com", seller_phone:"(352) 555-0808", photo_urls:["https://images.unsplash.com/photo-1535131749006-b7f58c99034b?w=800&q=80&auto=format&fit=crop&sat=-20"], listing_type:"Local", is_sample:true, status:"Active", days_left:30 },
  ];

  const { error } = await supabase.from('listings').insert(samples);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: samples.length });
});

// ── GET /api/dealers ────────────────────────────────────────────────────────
app.get('/api/dealers', async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, email, dealer_active, created_at')
    .eq('role', 'dealer')
    .eq('dealer_active', true)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const dealersWithCount = await Promise.all(data.map(async (dealer) => {
    const { count } = await supabase
      .from('listings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', dealer.id)
      .eq('status', 'Active');
    return { ...dealer, listing_count: count || 0 };
  }));

  res.json(dealersWithCount);
});

// ── RSS feeds for social auto-posting ───────────────────────────────────────
const xmlEscape = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Rewrite a Supabase Storage URL to request a resized version so social platforms
// (Facebook caps images at 4MB) never receive an oversized photo. Uses Supabase's
// image transformation endpoint: /storage/v1/object/public/  ->  /storage/v1/render/image/public/
function feedImage(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('/storage/v1/object/public/')) return url; // not a Supabase storage URL; leave as-is
  const rendered = url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/');
  const sep = rendered.includes('?') ? '&' : '?';
  return `${rendered}${sep}width=1200&quality=75`;
}

function rssItem(l, siteUrl, guid, pubDate) {
  const link  = `${siteUrl}/listing-detail.html?id=${l.id}`;
  const photo = feedImage((Array.isArray(l.photo_urls) && l.photo_urls[0]) || `${siteUrl}/assets/hero-logo.png`);
  const price = Number(l.price).toLocaleString('en-US');
  const bits  = [l.power, l.seats ? `${l.seats} seats` : null, l.street_legal ? 'street legal' : null]
    .filter(Boolean).join(' • ');
  const desc  = `🛺 ${l.title} — $${price} in ${l.location}. ${bits}. ` +
    `${(l.description || '').slice(0, 180)}${(l.description || '').length > 180 ? '…' : ''} ` +
    `See all photos & contact the seller: ${link}`;
  return `    <item>
      <title>${xmlEscape(`${l.title} — $${price} (${l.location})`)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="false">${xmlEscape(guid)}</guid>
      <pubDate>${pubDate.toUTCString()}</pubDate>
      <description>${xmlEscape(desc)}</description>
      <enclosure url="${xmlEscape(photo)}" type="image/jpeg" length="0"/>
    </item>`;
}

function rssWrap(title, description, siteUrl, itemsXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>${xmlEscape(siteUrl)}</link>
    <description>${xmlEscape(description)}</description>
${itemsXml}
  </channel>
</rss>`;
}

// New active listings (latest 10, real listings only) — for "new cart" auto-posts
app.get('/feed/listings.xml', async (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://villagesgolfcarttrader.com';
  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .eq('status', 'Active')
    .eq('is_sample', false)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return res.status(500).send('Feed error');

  const items = (data || [])
    .map(l => rssItem(l, siteUrl, `listing-${l.id}`, new Date(l.created_at)))
    .join('\n');

  res.header('Content-Type', 'application/xml');
  res.send(rssWrap(
    'Villages Golf Cart Trader — New Listings',
    'The latest golf carts listed for sale in The Villages, FL area.',
    siteUrl, items
  ));
});

// Rotating featured cart (round-robin through active listings) — for recurring posts
app.get('/feed/featured.xml', async (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://villagesgolfcarttrader.com';
  const hours   = Number(process.env.FEATURED_INTERVAL_HOURS) || 8; // one new featured cart every N hours
  const { data, error } = await supabase
    .from('listings')
    .select('*')
    .eq('status', 'Active')
    .eq('is_sample', false)
    .order('id', { ascending: true });

  if (error) return res.status(500).send('Feed error');

  let items = '';
  if (data && data.length > 0) {
    const bucketMs = hours * 60 * 60 * 1000;
    const bucket   = Math.floor(Date.now() / bucketMs);
    const pick     = data[bucket % data.length]; // cycles through every cart before repeating
    items = rssItem(pick, siteUrl, `featured-${pick.id}-${bucket}`, new Date(bucket * bucketMs));
  }

  res.header('Content-Type', 'application/xml');
  res.send(rssWrap(
    'Villages Golf Cart Trader — Featured Carts',
    'A rotating featured golf cart for sale in The Villages, FL area.',
    siteUrl, items
  ));
});

// ── Private stats page (requires ADMIN_KEY env var) ─────────────────────────
function etDayStart(daysAgo = 0) {
  const now = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offsetMs = now.getTime() - etNow.getTime();
  etNow.setHours(0, 0, 0, 0);
  etNow.setDate(etNow.getDate() - daysAgo);
  return new Date(etNow.getTime() + offsetMs);
}

app.get('/admin/stats', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.query.key !== adminKey) {
    return res.status(404).send('Not found');
  }

  const { data, error } = await supabase
    .from('listings')
    .select('id, title, price, location, listing_type, status, created_at, seller_name, seller_email, seller_phone')
    .eq('is_sample', false)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).send('Stats error');

  const all = data || [];
  const today = etDayStart(0), yesterday = etDayStart(1), week = etDayStart(6);
  const cAt = l => new Date(l.created_at);
  const stats = {
    today:     all.filter(l => cAt(l) >= today).length,
    yesterday: all.filter(l => cAt(l) >= yesterday && cAt(l) < today).length,
    week:      all.filter(l => cAt(l) >= week).length,
    active:    all.filter(l => l.status === 'Active').length,
    total:     all.length,
  };

  const recentRows = all.slice(0, 15).map(l => {
    const email = String(l.seller_email || '').replace(/</g, '&lt;');
    const phone = String(l.seller_phone || '').replace(/</g, '&lt;');
    return `
    <tr>
      <td>${new Date(l.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
      <td>${String(l.title || '').replace(/</g, '&lt;')}</td>
      <td>$${Number(l.price).toLocaleString()}</td>
      <td>${String(l.location || '').replace(/</g, '&lt;')}</td>
      <td>${l.status}</td>
      <td>${String(l.seller_name || '').replace(/</g, '&lt;')}</td>
      <td>${email ? `<a href="mailto:${email}">${email}</a>` : '—'}</td>
      <td>${phone || '—'}</td>
    </tr>`;
  }).join('');

  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Listing Stats</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;margin:24px;background:#f6f7f4;color:#1d2b1f}
  h1{font-size:22px} .cards{display:flex;flex-wrap:wrap;gap:12px;margin:18px 0}
  .card{background:#fff;border:1px solid #dde3da;border-radius:10px;padding:16px 22px;min-width:120px}
  .card .n{font-size:30px;font-weight:700} .card .l{color:#5d6b5e;font-size:13px;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dde3da;border-radius:10px;overflow:hidden}
  th,td{padding:9px 12px;text-align:left;font-size:14px;border-bottom:1px solid #eef1ec}
  th{background:#f0f3ee;color:#4a584b} caption{text-align:left;font-weight:600;margin:8px 0;font-size:16px}
</style></head><body>
  <h1>🛺 Villages Golf Cart Trader — Listing Stats</h1>
  <div class="cards">
    <div class="card"><div class="n">${stats.today}</div><div class="l">New today</div></div>
    <div class="card"><div class="n">${stats.yesterday}</div><div class="l">Yesterday</div></div>
    <div class="card"><div class="n">${stats.week}</div><div class="l">Last 7 days</div></div>
    <div class="card"><div class="n">${stats.active}</div><div class="l">Active now</div></div>
    <div class="card"><div class="n">${stats.total}</div><div class="l">All-time</div></div>
  </div>
  <table>
    <caption>15 most recent listings</caption>
    <tr><th>Posted (ET)</th><th>Title</th><th>Price</th><th>Location</th><th>Status</th><th>Seller</th><th>Email</th><th>Phone</th></tr>
    ${recentRows || '<tr><td colspan="8">No listings yet — go get those dealers! 🛺</td></tr>'}
  </table>
</body></html>`);
});

// ── Listing renewal: reminders + expiration ─────────────────────────────────
// Triggered daily by a scheduled job calling /api/run-renewals?key=ADMIN_KEY
const LISTING_DAYS = 30;

function renewEmailHtml(listing, daysLeft, renewUrl) {
  const headline = daysLeft > 0
    ? `Your listing expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
    : `Your listing has expired`;
  const body = daysLeft > 0
    ? `Your free listing for the <strong>${listing.title}</strong> will expire in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. If it's still for sale, renew it free below to keep it visible to local buyers.`
    : `Your free listing for the <strong>${listing.title}</strong> has reached 30 days and is no longer shown publicly. It's saved in your account — renew it free below to make it live again.`;
  return `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:0 auto;color:#1d2b1f">
    <div style="background:#1f3a24;padding:20px;text-align:center;border-radius:10px 10px 0 0">
      <span style="color:#fff;font-size:18px;font-weight:700">🛺 Villages Golf Cart Trader</span>
    </div>
    <div style="border:1px solid #dde3da;border-top:none;border-radius:0 0 10px 10px;padding:24px">
      <h2 style="margin:0 0 12px">${headline}</h2>
      <p style="line-height:1.6;color:#4a584b">${body}</p>
      <p style="text-align:center;margin:24px 0">
        <a href="${renewUrl}" style="background:#6aa84f;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:8px;display:inline-block">Renew Free →</a>
      </p>
      <p style="font-size:13px;color:#8a978b">Already sold it? You can ignore this email — the listing will simply expire on its own.</p>
    </div>
  </div>`;
}

app.get('/api/run-renewals', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(404).send('Not found');
  }

  // ── Expiration temporarily disabled ────────────────────────────────────────
  // Listings stay active indefinitely until inventory grows large enough that
  // stale listings become a real problem. Re-enable by restoring the loop below.
  // ──────────────────────────────────────────────────────────────────────────
  res.json({ ok: true, message: 'Expiration disabled — listings stay active until manually removed.', reminders7: 0, reminders3: 0, expired: 0 });
});

// One-click renewal — resets the 30-day clock and reactivates if expired
app.get('/api/renew-listing', async (req, res) => {
  const { id, token } = req.query;
  // Lightweight token check (the listing id doubles as the token in the emailed link)
  if (!id || token !== String(id)) {
    return res.status(400).send('Invalid renewal link.');
  }

  const { data: listing, error: findErr } = await supabase
    .from('listings').select('id, title').eq('id', id).single();

  if (findErr || !listing) return res.status(404).send('Listing not found.');

  const { error } = await supabase
    .from('listings')
    .update({ status: 'Active', created_at: new Date().toISOString(), days_left: LISTING_DAYS })
    .eq('id', id);

  if (error) return res.status(500).send('Could not renew listing.');

  const siteUrl = process.env.SITE_URL || 'https://villagesgolfcarttrader.com';
  res.send(`<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Listing Renewed</title>
    <style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f7f4;color:#1d2b1f;text-align:center;padding:60px 20px}
    .box{background:#fff;border:1px solid #dde3da;border-radius:14px;max-width:440px;margin:0 auto;padding:32px}
    a{background:#6aa84f;color:#fff;text-decoration:none;font-weight:700;padding:11px 24px;border-radius:8px;display:inline-block;margin-top:16px}</style>
    </head><body><div class="box">
    <div style="font-size:44px">✅</div>
    <h1 style="font-size:22px">Listing renewed!</h1>
    <p style="color:#4a584b;line-height:1.6">Your listing for <strong>${String(listing.title).replace(/</g,'&lt;')}</strong> is live again for another 30 days.</p>
    <a href="${siteUrl}/listing-detail.html?id=${listing.id}">View your listing →</a>
    </div></body></html>`);
});

// ── GET /sitemap.xml ────────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://villagesgolfcarttrader.com';

  const { data: listings } = await supabase
    .from('listings')
    .select('id, created_at')
    .eq('status', 'Active')
    .eq('is_sample', false);

  const staticPages = [
    { url: '/',               priority: '1.0', changefreq: 'daily'   },
    { url: '/listings.html',  priority: '0.9', changefreq: 'hourly'  },
    { url: '/sell.html',      priority: '0.8', changefreq: 'monthly' },
    { url: '/dealers.html',   priority: '0.7', changefreq: 'weekly'  },
  ];

  const listingPages = (listings || []).map(l => ({
    url:        `/listing-detail.html?id=${l.id}`,
    priority:   '0.8',
    changefreq: 'weekly',
    lastmod:    l.created_at ? l.created_at.split('T')[0] : '',
  }));

  const allPages = [...staticPages, ...listingPages];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allPages.map(p => `  <url>
    <loc>${siteUrl}${p.url}</loc>
    ${p.lastmod ? `<lastmod>${p.lastmod}</lastmod>` : ''}
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

// ── GET /robots.txt ─────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nSitemap: ${process.env.SITE_URL || 'https://villagesgolfcarttrader.com'}/sitemap.xml`);
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🛺  Villages Golf Cart Trader server running`);
  console.log(`   http://localhost:${PORT}\n`);
});
