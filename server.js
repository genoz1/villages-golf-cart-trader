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

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.SITE_URL || 'http://localhost:3000' }));
app.use(express.json());
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
  if(data.uses >= data.max_uses) return res.json({ valid: false, error: 'This promo code has reached its limit.' });
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

    // Validate promo code if provided
    let isFree = false;
    if(promoCode) {
      const { data: promo } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', promoCode.toUpperCase())
        .eq('active', true)
        .eq('listing_type', 'private')
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

// ── GET /sitemap.xml ────────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://villagesgolfcarttrader.com';

  const { data: listings } = await supabase
    .from('listings')
    .select('id, created_at')
    .eq('status', 'Active');

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
