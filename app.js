// ── DATA STORE ─────────────────────────────────────────────────────────────
const LISTINGS = [
  { id:1, title:"2022 Club Car Onward Lithium", price:12995, make:"Club Car", model:"Onward", year:2022, power:"Lithium", seats:4, location:"The Villages", type:"Featured", status:"Active", photo:"https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?w=600&q=80", daysLeft:27, seller:"John M.", phone:"(352) 555-0101", desc:"Clean 4-passenger lithium cart with upgraded premium seats, full LED lighting package, fold-down windshield, side mirrors, rear seat flip kit, and chrome accents. Garage kept, lightly used in The Villages. Runs perfectly." },
  { id:2, title:"2020 EZGO RXV Electric", price:8750, make:"EZGO", model:"RXV", year:2020, power:"Electric", seats:4, location:"Lady Lake", type:"Local", status:"Active", photo:"https://images.unsplash.com/photo-1551698618-1dfe5d97d256?w=600&q=80", daysLeft:3, seller:"Carol B.", phone:"(352) 555-0202", desc:"Well-maintained EZGO RXV with new batteries (2023), street legal package, custom rear seat, and USB charging port. Non-smoking owner. Stored indoors." },
  { id:3, title:"2023 Yamaha Drive2 Gas", price:10900, make:"Yamaha", model:"Drive2", year:2023, power:"Gas", seats:2, location:"Wildwood", type:"Local", status:"Active", photo:"https://images.unsplash.com/photo-1535131749006-b7f58c99034b?w=600&q=80", daysLeft:18, seller:"Mike T.", phone:"(352) 555-0303", desc:"Nearly new 2023 Yamaha Drive2 with only 200 miles. All original, full warranty still active. Street legal, custom wheels, and upgraded sound system." },
  { id:4, title:"2019 Club Car Precedent", price:6995, make:"Club Car", model:"Precedent", year:2019, power:"Electric", seats:4, location:"Oxford", type:"Local", status:"Active", photo:"https://images.unsplash.com/photo-1593436975846-c6d5a92e6c54?w=600&q=80", daysLeft:22, seller:"Linda R.", phone:"(352) 555-0404", desc:"Dependable Club Car Precedent with new 48V batteries, upgraded headlights and taillights, and fold-down windshield. Great daily driver in The Villages." },
  { id:5, title:"2021 Evolution D5 Lifted", price:13500, make:"Evolution", model:"D5", year:2021, power:"Lithium", seats:6, location:"The Villages", type:"Featured", status:"Active", photo:"https://images.unsplash.com/photo-1587174486073-ae5e5cff23aa?w=600&q=80", daysLeft:14, seller:"Dave K.", phone:"(352) 555-0505", desc:"Lifted 6-passenger Evolution D5 with 4-inch lift kit, all-terrain tires, premium audio, LED underglow, and custom camo wrap. Turns heads everywhere." },
  { id:6, title:"2018 EZGO TXT Electric", price:5950, make:"EZGO", model:"TXT", year:2018, power:"Electric", seats:2, location:"Leesburg", type:"Local", status:"Active", photo:"https://images.unsplash.com/photo-1551698618-1dfe5d97d256?w=600&q=80", daysLeft:8, seller:"Pat S.", phone:"(352) 555-0606", desc:"Basic but reliable 2018 EZGO TXT. New batteries in 2022, fresh tune-up, clean condition. Great starter cart or spare for guests." },
  { id:7, title:"2022 ICON i40L Lithium", price:11500, make:"ICON", model:"i40L", year:2022, power:"Lithium", seats:4, location:"The Villages", type:"Local", status:"Active", photo:"https://images.unsplash.com/photo-1535131749006-b7f58c99034b?w=600&q=80", daysLeft:20, seller:"Nancy W.", phone:"(352) 555-0707", desc:"ICON i40L with lithium battery, full enclosure, custom seat covers, rear storage bag, and side mirrors. Perfect condition." },
  { id:8, title:"2017 Club Car DS Gas", price:4500, make:"Club Car", model:"DS", year:2017, power:"Gas", seats:2, location:"Lady Lake", type:"Local", status:"Active", photo:"https://images.unsplash.com/photo-1593436975846-c6d5a92e6c54?w=600&q=80", daysLeft:30, seller:"Tom H.", phone:"(352) 555-0808", desc:"Older but very solid Club Car DS gas model. Runs great, no issues. Good candidate for a custom build. Priced to sell." },
];

const DEALERS = [
  { id:1, name:"Villages Cart Pros", initials:"VP", location:"The Villages, FL", phone:"(352) 555-1001", inventory:12, tagline:"New, used, and custom builds." },
  { id:2, name:"Sunshine Golf Carts", initials:"SG", location:"Lady Lake, FL", phone:"(352) 555-1002", inventory:8, tagline:"Family owned since 2009." },
  { id:3, name:"Golf Cart Kingdom", initials:"GK", location:"Wildwood, FL", phone:"(352) 555-1003", inventory:15, tagline:"Largest selection in Central Florida." },
];

// ── UTILITIES ───────────────────────────────────────────────────────────────
function fmt(n){ return '$' + n.toLocaleString(); }

function showToast(msg) {
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 3200);
}

function openModal(id) {
  document.getElementById(id)?.classList.add('open');
}
function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

function getListingId() {
  const p = new URLSearchParams(location.search);
  return parseInt(p.get('id')) || 1;
}

// ── NAV ─────────────────────────────────────────────────────────────────────
function renderNav(activePage) {
  const pages = [
    ['index.html','Home'],
    ['listings.html','Browse Carts'],
    ['sell.html','Sell Your Cart'],
    ['dealers.html','Dealers'],
    ['pricing.html','Pricing'],
    ['contact.html','Contact'],
  ];
  const links = pages.map(([href,label]) =>
    `<a href="${href}" class="${activePage===href?'active':''}">${label}</a>`
  ).join('');
  const mobileLinks = pages.map(([href,label]) =>
    `<a href="${href}">${label}</a>`
  ).join('');

  return `
  <div class="topbar">The Villages paid golf cart marketplace — private sellers &amp; dealers</div>
  <header class="nav">
    <div class="nav-inner">
      <a class="brand-text" href="index.html">Villages Golf Cart Trader</a>
      <nav class="nav-links">${links}</nav>
      <a class="btn btn-gold btn-sm" href="sell.html">Post Your Cart</a>
      <button class="hamburger" id="hamburger" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
    </div>
    <nav class="mobile-nav" id="mobileNav">${mobileLinks}
      <a href="sell.html" class="btn btn-gold" style="margin-top:6px">Post Your Cart</a>
    </nav>
  </header>`;
}

function renderFooter() {
  return `
  <footer class="footer">
    <div class="footer-inner">
      <div>
        <div class="footer-brand">Villages Golf Cart Trader</div>
        <p class="footer-tagline">The paid golf cart marketplace for The Villages and surrounding communities. Private sellers and dealers welcome.</p>
      </div>
      <div>
        <h4>Marketplace</h4>
        <ul class="footer-links">
          <li><a href="listings.html">Browse Carts</a></li>
          <li><a href="sell.html">Sell Your Cart</a></li>
          <li><a href="dealers.html">Dealers</a></li>
          <li><a href="account.html">My Account</a></li>
        </ul>
      </div>
      <div>
        <h4>Info</h4>
        <ul class="footer-links">
          <li><a href="pricing.html">Pricing</a></li>
          <li><a href="listing-renewal-rules.html">Renewal Rules</a></li>
          <li><a href="contact.html">Contact</a></li>
        </ul>
      </div>
      <div>
        <h4>Communities</h4>
        <ul class="footer-links">
          <li><a href="listings.html">The Villages</a></li>
          <li><a href="listings.html">Lady Lake</a></li>
          <li><a href="listings.html">Wildwood</a></li>
          <li><a href="listings.html">Oxford</a></li>
          <li><a href="listings.html">Leesburg</a></li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© 2025 Villages Golf Cart Trader. All rights reserved.</span>
      <span>villagesgolfcarttrader.com</span>
    </div>
  </footer>
  <div class="toast" id="toast"></div>`;
}

function initNav() {
  const btn = document.getElementById('hamburger');
  const nav = document.getElementById('mobileNav');
  if(btn && nav) {
    btn.addEventListener('click', () => nav.classList.toggle('open'));
  }
  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => { if(e.target===o) o.classList.remove('open'); });
  });
}
