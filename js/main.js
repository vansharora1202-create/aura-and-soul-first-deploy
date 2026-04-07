/* ============================================================
   AURA & EARTH — MAIN.JS
   ─────────────────────────────────────────────────────────
   Architecture:
   • Single DOMContentLoaded entry point (Section 13).
   • All product data flows exclusively through productMap
     (Section 2), populated once from Firestore via
     initProductData(). No hardcoded data, no fallbacks.
   • Cart state lives in localStorage key `cartItems` only.
     BroadcastChannel keeps all open tabs in sync.
   • Stack bundles are stored as a single cart entry with
     isStackBundle:true and an array of product IDs.
   • All window assignments (addToCart, addToWishlist,
     updateShopView, buildProductCardHTML) exist solely
     because those functions are called from inline onclick
     attributes in dynamically generated HTML strings.
   ============================================================ */


/* ============================================================
   SECTION 1: GLOBAL STATE
   ─────────────────────────────────────────────────────────
   STATE.wishlist mirrors the localStorage 'wishlist' array so
   isInWishlist() can run synchronously without re-parsing JSON
   on every card render. Cart state has no mirror here — it
   always reads directly from localStorage via getCartItems().
   ============================================================ */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}
const WHATSAPP_NUMBER = '919350614431';
const STATE = {
    wishlist: []
};

(function hydrateState() {
    try { STATE.wishlist = JSON.parse(localStorage.getItem('wishlist')) || []; } catch { STATE.wishlist = []; }
})();
/* ============================================================
   SECTION 1B: GLOBAL SETTINGS — fetch settings/global from
   Firestore once per page load. Drives maintenance mode,
   store name, shipping thresholds, and stack bundle discount.
   ============================================================ */
let _globalSettings = null; // cached so other IIFEs can read it synchronously

// Stack bundle discount % — read from Firestore settings/global.
// Exposed at module scope so the Cart IIFE can read it directly
// without a second Firestore round-trip.
const KIT_DISCOUNT = 15;
let STACK_BUNDLE_DISCOUNT = KIT_DISCOUNT; // ISKO ADD KAR

function getDiscount() {
    return (typeof STACK_BUNDLE_DISCOUNT === 'number' && STACK_BUNDLE_DISCOUNT > 0)
        ? STACK_BUNDLE_DISCOUNT
        : KIT_DISCOUNT;
}

async function loadGlobalSettings() {
    try {
        const [{ db }, { doc, getDoc }] = await Promise.all([
            import('./firebase.js'),
            import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
        ]);

        const snap = await getDoc(doc(db, 'settings', 'global'));
        if (!snap.exists()) return;

        _globalSettings = snap.data();

        // ── Stack Bundle Discount ─────────────────────────────
        // Read once here so the Cart IIFE can use the already-
        // resolved value synchronously when rendering.
        if (typeof _globalSettings.stackDiscount === 'number' && _globalSettings.stackDiscount >= 0) {
            STACK_BUNDLE_DISCOUNT = _globalSettings.stackDiscount;
        }

        // ── 1. Maintenance Mode ───────────────────────────────
        if (_globalSettings.maintenanceMode === true) {
            document.body.innerHTML = `
                <div id="maintenanceBanner" style="
                    position:fixed;inset:0;
                    background:linear-gradient(135deg,#f5f0eb 0%,#e8e0d5 100%);
                    display:flex;flex-direction:column;align-items:center;
                    justify-content:center;z-index:99999;text-align:center;
                    padding:32px;font-family:'Playfair Display',Georgia,serif;">
                    <div style="font-size:3rem;margin-bottom:16px;">✦</div>
                    <h1 style="font-size:2rem;font-weight:700;color:#3a3228;margin-bottom:12px;">
                        We're Upgrading
                    </h1>
                    <p style="font-size:1.05rem;color:#7a6f65;max-width:420px;line-height:1.7;margin-bottom:8px;">
                        Aura & Earth is undergoing scheduled maintenance to bring you
                        an even better experience. We'll be back shortly. 🌿
                    </p>
                    <p style="font-size:0.85rem;color:#a09488;margin-top:12px;">
                        Questions? <a href="mailto:hello@auraandearth.com"
                            style="color:#6e9472;text-decoration:none;">hello@auraandearth.com</a>
                    </p>
                </div>`;
            return; // stop all further initialisation
        }

        // ── 2. Store Name ─────────────────────────────────────
        if (_globalSettings.storeName) {
            document.querySelectorAll('.nav-logo, .footer-brand h3').forEach(el => {
                el.textContent = _globalSettings.storeName;
            });
            document.title = document.title.replace('Aura & Earth', _globalSettings.storeName);
        }

    } catch (err) {
        console.error('[Aura & Earth] loadGlobalSettings failed:', err.message);
        // Non-fatal: page continues to load with defaults
    }
}


/* ============================================================
   SECTION 2: PRODUCT MAP — O(1) lookups by ID
   Memoised promise — Firestore fetched only once per page load.
   ============================================================ */
let productMap = new Map();
let _productDataPromise = null;

async function initProductData() {
    if (_productDataPromise) return _productDataPromise;

    _productDataPromise = (async () => {
        try {
            const [{ db }, { collection, getDocs, query, orderBy }] = await Promise.all([
                import('./firebase.js'),
                import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
            ]);

            const snapshot = await getDocs(query(collection(db, 'products'), orderBy('createdAt', 'desc')));
            console.log('[Firebase] Snapshot received — empty?', snapshot.empty, '| doc count:', snapshot.size, '| first doc id:', snapshot.docs[0]?.id ?? 'none');

            const firestoreProducts = snapshot.docs.map(d => {
                const data = d.data();
                const id = typeof data.id === 'number' ? data.id
                    : (typeof data.id === 'string' ? parseInt(data.id, 10) : NaN)
                    || parseInt(d.id, 10)
                    || d.id;
                return { ...data, _docId: d.id, id };
            });

            productMap = new Map(firestoreProducts.map(p => [p.id, p]));
            // Expose on window so the Drawer IIFE can detect when products are
            // loaded via its setInterval polling pattern (window.productMap.size > 0).
            window.productMap = productMap;
        } catch (err) {
            console.error('[Aura & Earth] Failed to load products from Firestore:', err.message);
        }
    })();

    return _productDataPromise;
}


/* ============================================================
   SECTION 3: GLOBAL CART STORAGE HELPERS
   ============================================================ */

// BroadcastChannel — notifies ALL open tabs of cart changes.
// Falls back silently in environments that don't support it.
const _cartChannel = (() => {
    try { return new BroadcastChannel('aura_cart'); }
    catch { return null; }
})();

function getCartItems() {
    try { return JSON.parse(localStorage.getItem('cartItems')) || []; }
    catch { return []; }
}

function saveCartItems(items) {
    localStorage.setItem('cartItems', JSON.stringify(items));
    updateCounters();
    _cartChannel?.postMessage({ type: 'CART_UPDATED' });
    document.dispatchEvent(new CustomEvent('aura:cartUpdated'));
}

function isInCart(id) {
    return getCartItems().some(i => i.id === id);
}

/* ============================================================
   SECTION 4: GLOBAL WISHLIST STORAGE HELPERS
   ============================================================ */
function getWishlistIds() {
    try { return JSON.parse(localStorage.getItem('wishlist')) || []; }
    catch { return []; }
}

function saveWishlistIds(ids) {
    STATE.wishlist = [...new Set(ids)];
    localStorage.setItem('wishlist', JSON.stringify(STATE.wishlist));
    updateCounters();
    // Notify other open tabs (e.g. user has wishlist + shop open)
    _cartChannel?.postMessage({ type: 'WISHLIST_UPDATED' });
}

function isInWishlist(id) {
    return STATE.wishlist.includes(id);
}


/* ============================================================
   SECTION 5: NAVBAR COUNTER BADGES + CROSS-TAB SYNC
   ============================================================ */
function updateCounters() {
    const cartItems = getCartItems();
    const wishIds = getWishlistIds();
    const totalCartQty = cartItems.reduce((sum, i) => sum + (i.qty || 1), 0);
    const totalWish = new Set(wishIds).size;

    // querySelectorAll covers both desktop and mobile nav badges
    document.querySelectorAll('a[href="cart-checkout.html"] .count').forEach(b => {
        b.textContent = totalCartQty;
        b.style.display = totalCartQty > 0 ? 'flex' : 'none';
    });
    document.querySelectorAll('a[href="wishlist.html"] .count').forEach(b => {
        b.textContent = totalWish;
        b.style.display = totalWish > 0 ? 'flex' : 'none';
    });
}

function syncActiveNavLinks() {
    const page = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
    const navLinks = document.querySelectorAll('.nav-link, .mobile-menu a');

    navLinks.forEach(link => {
        const href = (link.getAttribute('href') || '').split('?')[0].toLowerCase();
        const isActive = href === page;
        link.classList.toggle('active', isActive);
        if (isActive) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    });
}

// ── BroadcastChannel: another tab changed the cart ───────────
// When the homepage's Stack Builder (in a different tab) adds
// items, this fires on the cart page and re-renders the list.
if (_cartChannel) {
    _cartChannel.addEventListener('message', (e) => {
        // Always refresh badge counts on any change
        updateCounters();

        switch (e.data?.type) {
            case 'CART_UPDATED':
                // Live re-render cart item list if on the cart page
                if (document.querySelector('.cart-main')) {
                    resolveAndRenderCart();
                }
                // Refresh shop/homepage card states (In Bag / Add to Bag labels)
                if (document.getElementById('productsGrid')) {
                    updateShopView(1);
                }
                break;

            case 'WISHLIST_UPDATED':
                // Live re-render the wishlist page if it's open in this tab
                if (document.getElementById('wishlistGrid')) {
                    window._wishlistPageRerender?.();
                }
                break;
        }
    });
}
// ── Storage event: legacy cross-tab fallback ─────────────────
// The `storage` event only fires in OTHER tabs (not the writing tab).
// BroadcastChannel handles the same-tab case above.
// This is purely a fallback for browsers that don't support BroadcastChannel.
if (!_cartChannel) {
    window.addEventListener('storage', e => {
        if (e.key !== 'cartItems' && e.key !== 'wishlist') return;
        updateCounters();
        if (e.key === 'cartItems' && document.querySelector('.cart-main')) {
            resolveAndRenderCart();
        }
        if (e.key === 'wishlist' && document.getElementById('wishlistGrid')) {
            window._wishlistPageRerender?.();
        }
    });
}

// ── resolveAndRenderCart() ───────────────────────────────────
// Thin wrapper callable from outside the Cart IIFE's closure.
// The Cart IIFE's internal resolveCartItems + renderCartItems
// are not accessible here, so we expose a window-level hook
// that the IIFE will register once it initialises.
// The cart IIFE sets window._cartPageRerender when it boots.
function resolveAndRenderCart() {
    if (typeof window._cartPageRerender === 'function') {
        window._cartPageRerender();
    }
}


/* ============================================================
   SECTION 6: GLOBAL TOAST NOTIFICATION
   ============================================================ */
function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText =
            'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:10px;pointer-events:none;';
        document.body.appendChild(container);
    }

    const colorMap = { success: '#27ae60', error: '#e74c3c', info: '#7a5c85' };
    const iconMap = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info' };

    const toast = document.createElement('div');
    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconMap[type] || iconMap.success}`;
    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(icon);
    toast.appendChild(msgSpan);
    toast.style.cssText = `
        background:${colorMap[type] || colorMap.success};
        color:#fff;padding:12px 20px;border-radius:10px;
        box-shadow:0 8px 24px rgba(0,0,0,0.18);font-size:0.9rem;
        display:flex;align-items:center;gap:10px;
        opacity:0;transform:translateY(16px);transition:all 0.35s ease;
        pointer-events:auto;max-width:320px;
    `;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
    setTimeout(() => {
        toast.style.opacity = '0'; toast.style.transform = 'translateY(16px)';
        setTimeout(() => toast.remove(), 350);
    }, 2800);
}


/* ============================================================
   SECTION 7: GLOBAL addToCart() & addToWishlist()
   ─────────────────────────────────────────────────────────
   Assigned to window because they are called from inline
   onclick attributes inside dynamically generated card HTML.
   ============================================================ */
function addToCart(id, event) {
    if (event) event.stopPropagation();
    const product = productMap.get(id);
    if (!product) return;
    if (isInCart(id)) { showToast('Already in your Bag! ✨', 'info'); return; }
    if (typeof product.stock === 'number' && product.stock === 0) {
        showToast(`${product.name} is currently sold out.`, 'info');
        return;
    }
    const items = getCartItems();
    items.push({ id, qty: 1, size: 'Medium (17cm)', charm: 'None' });
    saveCartItems(items);
    showToast(`${product.name} added to Bag! 🛍️`);
}
window.addToCart = addToCart;

function addToWishlist(id, event) {
    if (event) event.stopPropagation();
    const product = productMap.get(id);
    if (!product) return;
    const ids = getWishlistIds();
    const idx = ids.indexOf(id);
    if (idx === -1) {
        ids.push(id); saveWishlistIds(ids);
        showToast(`${product.name} saved to Wishlist 💜`);
    } else {
        ids.splice(idx, 1); saveWishlistIds(ids);
        showToast('Removed from Wishlist');
    }
    document.querySelectorAll(`.btn-wishlist[data-id="${id}"]`).forEach(btn => {
        btn.classList.toggle('active', isInWishlist(id));
    });
}
window.addToWishlist = addToWishlist;


/* ============================================================
   SECTION 8: HERO SLIDER — INFINITE SEAMLESS LOOP
   ============================================================ */
const heroData = [
    {
        title: 'Elevate Your <br><span class="italic-text">Vibration</span>',
        desc: 'Discover ethically sourced crystals curated for the modern soul.',
        badge: 'Aura & Earth Exclusive'
    },
    {
        title: 'Find Your <br><span class="italic-text">Inner Peace</span>',
        desc: 'Amethyst collection to calm your mind and soothe your spirit.',
        badge: 'New Collection'
    },
    {
        title: 'Manifest Your <br><span class="italic-text">Success</span>',
        desc: 'Citrine crystals for wealth, abundance, and positive energy.',
        badge: 'Best Sellers'
    }
];

function initHeroSlider() {
    const viewport = document.querySelector('.hero-visual-side');
    const track = document.getElementById('heroSlider');
    const titleEl = document.getElementById('slide-title');
    const descEl = document.getElementById('slide-desc');
    const badgeEl = document.getElementById('slide-badge');

    if (!track || !viewport || !titleEl) return;

    const origSlides = Array.from(track.querySelectorAll('.slide'));
    const total = origSlides.length;
    if (total < 2) return;

    const cloneLast = origSlides[total - 1].cloneNode(true);
    const cloneFirst = origSlides[0].cloneNode(true);
    cloneLast.setAttribute('aria-hidden', 'true');
    cloneFirst.setAttribute('aria-hidden', 'true');
    track.insertBefore(cloneLast, origSlides[0]);
    track.appendChild(cloneFirst);
    [cloneLast, cloneFirst].forEach(clone => {
        clone.querySelectorAll('img[loading="lazy"]').forEach(img => {
            img.setAttribute('loading', 'eager');
        });
    });

    let currentIndex = 1;
    let isTransitioning = false;
    let intervalId;

    function slideWidth() { return viewport.offsetWidth; }

    function goTo(index, animated = true) {
        track.style.transition = animated
            ? 'transform 0.9s cubic-bezier(0.7, 0, 0.3, 1)'
            : 'none';
        track.style.transform = `translateX(-${index * slideWidth()}px)`;
        currentIndex = index;
    }

    function syncWidths() {
        const w = slideWidth();
        track.querySelectorAll('.slide').forEach(s => {
            s.style.width = w + 'px';
            s.style.flexShrink = '0';
        });
    }

    function updateText(trackIndex) {
        const dataIndex = ((trackIndex - 1) % total + total) % total;
        const { title, desc, badge } = heroData[dataIndex];
        [titleEl, descEl, badgeEl].forEach(el => el && el.classList.add('hide'));
        setTimeout(() => {
            if (titleEl) titleEl.innerHTML = title;
            if (descEl) descEl.textContent = desc;
            if (badgeEl) badgeEl.textContent = badge;
            [titleEl, descEl, badgeEl].forEach(el => el && el.classList.remove('hide'));
        }, 420);
    }

    track.addEventListener('transitionend', () => {
        if (currentIndex === total + 1) { goTo(1, false); }
        if (currentIndex === 0) { goTo(total, false); }
        isTransitioning = false;
    });

    function advance() {
        if (isTransitioning) return;
        isTransitioning = true;
        const next = currentIndex + 1;
        goTo(next);
        updateText(next > total ? 1 : next);
    }

    function startAuto() { intervalId = setInterval(advance, 4000); }
    function stopAuto() { clearInterval(intervalId); }

    syncWidths();
    goTo(1, false);

    window.addEventListener('resize', () => { stopAuto(); syncWidths(); goTo(currentIndex, false); startAuto(); });
    viewport.addEventListener('mouseenter', stopAuto);
    viewport.addEventListener('mouseleave', startAuto);
    viewport.addEventListener('touchstart', stopAuto, { passive: true });
    viewport.addEventListener('touchend', startAuto, { passive: true });

    startAuto();
}


/* ============================================================
   SECTION 9: GLOBAL FEATURES — Theme, Search, Mobile Menu
   ============================================================ */
function initGlobalFeatures() {

    /* ── THEME TOGGLE ──────────────────────────────────────── */
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
        if (localStorage.getItem('theme') === 'dark') {
            document.body.classList.add('dark-theme');
            themeBtn.innerHTML = '<i class="fa-solid fa-sun"></i>';
        }
        themeBtn.addEventListener('click', () => {
            document.body.classList.toggle('dark-theme');
            const isDark = document.body.classList.contains('dark-theme');
            themeBtn.style.transition = 'transform 0.4s ease';
            themeBtn.style.transform = 'rotate(360deg)';
            setTimeout(() => {
                themeBtn.innerHTML = isDark ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
                themeBtn.style.transform = 'rotate(0deg)';
            }, 200);
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
        });
    }

    /* ── LIVE SEARCH ───────────────────────────────────────── */
    const searchInput = document.getElementById('mainSearch');
    const searchDropdown = document.getElementById('search-results-dropdown');
    const searchBox = document.querySelector('.search-box-container');

    if (searchInput && searchDropdown && searchBox) {
        let debounceTimer;
        searchInput.addEventListener('input', e => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const q = e.target.value.trim().toLowerCase();
                if (q.length < 2) { searchDropdown.style.display = 'none'; return; }

                const results = [...productMap.values()].filter(p =>
                    (p.name || '').toLowerCase().includes(q) ||
                    (p.category || '').toLowerCase().includes(q) ||
                    (p.stone || '').toLowerCase().includes(q)
                );

                searchDropdown.innerHTML = results.length > 0
                    ? results.slice(0, 6).map(p => `
                        <div class="search-item" role="option"
                             onclick="location.href='product-detail.html?id=${p.id}'">
                            <img src="${esc(p.image || '')}" alt="${esc(p.name)}" loading="lazy">
                            <div class="search-info">
                                <h4>${esc(p.name)}</h4>
<span>₹${(p.price || 0).toLocaleString()}</span>
                            </div>
                        </div>`).join('') + `
                        <div class="search-view-all"
                             onclick="location.href='shop.html?search=${encodeURIComponent(q)}'">
                            View all ${results.length} result${results.length !== 1 ? 's' : ''} →
                        </div>`
                    : `<div class="search-no-results">No results for "<strong>${q}</strong>"</div>`;

                searchDropdown.style.display = 'block';
            }, 180);
        });

        document.addEventListener('click', e => {
            if (!searchBox.contains(e.target)) searchDropdown.style.display = 'none';
        });
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') { searchDropdown.style.display = 'none'; searchInput.blur(); }
        });
    }

    /* ── MOBILE MENU ───────────────────────────────────────── */
    const hamburger = document.querySelector('.hamburger');
    const mobileMenu = document.querySelector('.mobile-menu');

    if (hamburger && mobileMenu) {
        hamburger.addEventListener('click', () => {
            const isOpen = mobileMenu.classList.toggle('active');
            const icon = hamburger.querySelector('i');
            icon.classList.toggle('fa-bars', !isOpen);
            icon.classList.toggle('fa-xmark', isOpen);
        });

        document.addEventListener('click', e => {
            if (!mobileMenu.contains(e.target) && !hamburger.contains(e.target)) {
                mobileMenu.classList.remove('active');
                const icon = hamburger.querySelector('i');
                if (icon) { icon.classList.add('fa-bars'); icon.classList.remove('fa-xmark'); }
            }
        });
    }

    /* ── MOBILE CATEGORY ACCORDION ────────────────────────── */
    const mobileDropBtn = document.querySelector('.mobile-dropbtn');
    const mobileDropContent = document.querySelector('.mobile-dropdown-content');

    if (mobileDropBtn && mobileDropContent) {
        mobileDropBtn.addEventListener('click', e => {
            e.stopPropagation();
            const isOpen = mobileDropContent.classList.toggle('open');
            const icon = mobileDropBtn.querySelector('i');
            if (icon) icon.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
        });
    }
    /* ── GLASSMORPHISM STICKY HEADER ──────────────────────── */
    const navbar = document.getElementById('mainNav');
    if (navbar) {
        // Run once on load in case page is already scrolled (e.g. browser back)
        navbar.classList.toggle('scrolled', window.scrollY > 50);

        window.addEventListener('scroll', () => {
            navbar.classList.toggle('scrolled', window.scrollY > 50);
        }, { passive: true });
    }
}


/* ============================================================
   SECTION 10: HOME PAGE — Featured Products Grid
   ─────────────────────────────────────────────────────────
   Reads from productMap (already populated by initProductData).
   Shows skeletons immediately, replaces with real cards once
   the map is ready. Uses buildProductCardHTML for full parity
   with the shop page — sale prices, sold-out badges, hover tray.
   ============================================================ */
function initHomePage() {
    const grid = document.getElementById('featuredGrid');
    if (!grid) return;

    // ── Show skeletons immediately while Firestore resolves ──
    // Four cards on mobile, eight on desktop — CSS grid handles
    // the exact count, we inject 8 so there's never a gap.
    grid.innerHTML = Array(8).fill('<div class="featured-skeleton"></div>').join('');

    // ── productMap is already populated by await initProductData()
    // in DOMContentLoaded before this function is called, so we
    // can read it synchronously here.
    const featured = [...productMap.values()]
        .sort((a, b) => (b.createdAt || b.id || 0) - (a.createdAt || a.id || 0))
        .slice(0, 8);

    if (featured.length === 0) {
        grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:#999;">
                <i class="fa-solid fa-gem"
                   style="font-size:3rem;margin-bottom:16px;display:block;opacity:0.3;"></i>
                <p>Our collection is coming soon…</p>
            </div>`;
        return;
    }

    // buildProductCardHTML generates the full unified card —
    // sale price block, sold-out badge, wishlist heart, hover tray.
    grid.innerHTML = featured.map(p => buildProductCardHTML(p)).join('');
}


/* ============================================================
   SECTION 11: SHOP PAGE — Filter, Sort, Paginate, View Toggle
   ─────────────────────────────────────────────────────────
   updateShopView and buildProductCardHTML are assigned to
   window so the Drawer IIFE can monkey-patch updateShopView
   to layer its filter logic on top.
   ============================================================ */
let currentView = 'grid';

function buildPriceHTML(p) {
    const onSale = p.salePrice != null &&
        typeof p.salePrice === 'number' &&
        p.salePrice < (p.price || 0);

    if (!onSale) {
        return `<p class="price">₹${(p.price || 0).toLocaleString('en-IN')}</p>`;
    }

    const savedPct = (typeof p.discount === 'number' && p.discount > 0)
        ? p.discount
        : Math.round((1 - p.salePrice / p.price) * 100);

    return `
        <div class="price-wrap">
            <span class="price-original">₹${(p.price).toLocaleString('en-IN')}</span>
            <span class="price-sale">₹${(p.salePrice).toLocaleString('en-IN')}</span>
            <span class="price-save-badge">${savedPct}% OFF</span>
        </div>`;
}

function buildProductCardHTML(p) {
    const soldOut = typeof p.stock === 'number' && p.stock === 0;
    const pdpUrl = `product-detail.html?id=${p.id}`;
    const stone = p.stone || p.crystal || p.material || '';

    return `
        <div class="product-card" data-product-id="${p.id}" onclick="location.href='${pdpUrl}'">
 
            <!-- ── Image box ─────────────────────────────────── -->
            <div class="product-image-box" data-product-id="${p.id}">
 
                <!-- Category badge — top left -->
                <span class="badge-tag">${p.category || 'Crystal'}</span>
 
                <!-- Sale badge -->
                ${(p.salePrice != null && p.salePrice < p.price)
            ? '<span class="sale-badge">SALE</span>'
            : ''}
 
                <!-- Sold out overlay -->
                ${soldOut ? '<span class="sold-out-badge">Sold Out</span>' : ''}
 
                <!-- Wishlist heart — top right -->
                <button class="btn-wishlist${isInWishlist(p.id) ? ' active' : ''}"
                        data-id="${p.id}"
                        aria-label="Save ${p.name} to wishlist"
                        onclick="addToWishlist(${p.id}, event)">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06
                                 a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78
                                 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                </button>
 
                <img src="${p.image || ''}" alt="${p.name}" loading="lazy">
 
            </div><!-- /.product-image-box -->
 
            <!-- ── Info ──────────────────────────────────────── -->
            <div class="product-info">
                <h3>${p.name}</h3>
                ${stone ? `<p class="shop-card-stone">${stone}</p>` : '<p class="shop-card-stone"></p>'}
                ${buildPriceHTML(p)}
            </div>
 
            <!-- ── Hover action tray ──────────────────────────
                 Placed OUTSIDE .product-image-box to avoid being
                 clipped by its overflow:hidden. Slides up on hover
                 via CSS in shop-additions.css.
            ───────────────────────────────────────────────────── -->
            <div class="shop-card-actions">
 
                <!-- View Details — navigates to PDP -->
                <a class="shop-card-view-btn"
                   href="${pdpUrl}"
                   aria-label="View details for ${p.name}"
                   onclick="event.stopPropagation()">
                    <i class="fa-solid fa-eye"></i> View Details
                </a>
 
                <!-- Add to Bag -->
                <button class="shop-card-bag-btn${soldOut ? ' btn-sold-out' : ''}"
                        aria-label="${soldOut ? 'Sold out' : 'Add ' + p.name + ' to bag'}"
                        onclick="${soldOut
            ? 'event.stopPropagation()'
            : 'addToCart(' + p.id + ', event)'}"
                        ${soldOut ? 'disabled' : ''}>
                    <i class="fa-solid ${soldOut
            ? 'fa-ban'
            : isInCart(p.id) ? 'fa-check' : 'fa-bag-shopping'}"></i>
                    ${soldOut ? 'Sold Out' : isInCart(p.id) ? 'In Bag' : 'Add to Bag'}
                </button>
 
            </div><!-- /.shop-card-actions -->
 
        </div><!-- /.product-card -->
    `;
}
window.buildProductCardHTML = buildProductCardHTML;
/**
 * buildPaginationHTML — shared by updateShopView and the Drawer IIFE patch.
 * Returns an HTML string of prev/page-number/next buttons.
 * @param {number} page        Current page (1-based)
 * @param {number} totalPages  Total number of pages
 * @returns {string}
 */
function buildPaginationHTML(page, totalPages) {
    if (totalPages <= 1) return '';

    const isMobile = window.innerWidth < 768;
    const visibleRange = isMobile ? 3 : 5;
    const half = Math.floor(visibleRange / 2);
    const rangeStart = Math.max(2, page - half);
    const rangeEnd = Math.min(totalPages - 1, page + half);

    let html = `<button class="page-btn prev-btn" ${page === 1 ? 'disabled' : ''}
                        onclick="updateShopView(${page - 1})">
                    <i class="fa-solid fa-chevron-left"></i>
                </button>`;

    html += `<button class="page-btn ${page === 1 ? 'active' : ''}"
                     onclick="updateShopView(1)">1</button>`;

    if (rangeStart > 2) html += `<span class="page-dots">…</span>`;

    for (let i = rangeStart; i <= rangeEnd; i++) {
        html += `<button class="page-btn ${i === page ? 'active' : ''}"
                         onclick="updateShopView(${i})">${i}</button>`;
    }

    if (rangeEnd < totalPages - 1) html += `<span class="page-dots">…</span>`;

    if (totalPages > 1) {
        html += `<button class="page-btn ${page === totalPages ? 'active' : ''}"
                         onclick="updateShopView(${totalPages})">${totalPages}</button>`;
    }

    html += `<button class="page-btn next-btn" ${page === totalPages ? 'disabled' : ''}
                     onclick="updateShopView(${page + 1})">
                 <i class="fa-solid fa-chevron-right"></i>
             </button>`;

    return html;
}
function updateShopView(page = 1) {
    const grid = document.getElementById('productsGrid');
    if (!grid) return;

    const noResults = document.getElementById('noResults');
    const pagination = document.getElementById('pagination');
    const showingStart = document.getElementById('showingStart');
    const showingEnd = document.getElementById('showingEnd');
    const totalProductsEl = document.getElementById('totalProducts');
    const badge = document.getElementById('activeFilterBadge');
    const badgeText = document.getElementById('activeFilterText');

    // ── Active category filter ────────────────────────────────
    let currentFilter = 'all';
    const activeFilterBtn = document.querySelector('.filter-btn.active');
    if (activeFilterBtn) currentFilter = activeFilterBtn.dataset.filter || 'all';

    if (badge && badgeText) {
        if (currentFilter !== 'all') {
            badgeText.textContent =
                currentFilter.charAt(0).toUpperCase() + currentFilter.slice(1);
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }

    // ── Active sort ───────────────────────────────────────────
    let currentSort = 'default';
    const sortEl = document.getElementById('dropdownSelected');
    if (sortEl) {
        const text = sortEl.textContent.trim();
        if (text.includes('Low to High')) currentSort = 'price-low';
        if (text.includes('High to Low')) currentSort = 'price-high';
        if (text.includes('A to Z')) currentSort = 'name-a';
        if (text.includes('Z to A')) currentSort = 'name-z';
    }

    // ── URL search param ──────────────────────────────────────
    const urlSearch = new URLSearchParams(window.location.search).get('search') || '';

    // ── Filter ────────────────────────────────────────────────
    let filtered = [...productMap.values()].filter(p => {
        const matchCategory = currentFilter === 'all' || p.category === currentFilter;
        const matchSearch = !urlSearch ||
            (p.name || '').toLowerCase().includes(urlSearch.toLowerCase());
        return matchCategory && matchSearch;
    });

    // ── Sort ──────────────────────────────────────────────────
    const sortFns = {
        'price-low': (a, b) => a.price - b.price,
        'price-high': (a, b) => b.price - a.price,
        'name-a': (a, b) => (a.name || '').localeCompare(b.name || ''),
        'name-z': (a, b) => (b.name || '').localeCompare(a.name || ''),
    };
    if (sortFns[currentSort]) filtered.sort(sortFns[currentSort]);

    // ── Paginate ──────────────────────────────────────────────
    const ITEMS_PER_PAGE = 12;
    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    const start = (page - 1) * ITEMS_PER_PAGE;
    const paginated = filtered.slice(start, start + ITEMS_PER_PAGE);

    // ── Empty state ───────────────────────────────────────────
    if (paginated.length === 0) {
        grid.innerHTML = '';
        if (noResults) noResults.style.display = 'block';
        if (pagination) pagination.innerHTML = '';
        if (showingStart) showingStart.textContent = '0';
        if (showingEnd) showingEnd.textContent = '0';
        if (totalProductsEl) totalProductsEl.textContent = '0';
        return;
    }

    // ── Render ────────────────────────────────────────────────
    if (noResults) noResults.style.display = 'none';
    if (showingStart) showingStart.textContent = start + 1;
    if (showingEnd) showingEnd.textContent = Math.min(start + ITEMS_PER_PAGE, totalItems);
    if (totalProductsEl) totalProductsEl.textContent = totalItems;

    grid.innerHTML = paginated.map(p => buildProductCardHTML(p)).join('');

    // ── Pagination — use shared buildPaginationHTML helper ────
    if (pagination) pagination.innerHTML = buildPaginationHTML(page, totalPages);
}
window.updateShopView = updateShopView;


/* ============================================================
   MOON PHASE — Real lunar phase calculation + crystal advice
   ─────────────────────────────────────────────────────────
   Algorithm: Synodic month = 29.53058867 days.
   Using the known New Moon anchor date of Jan 6 2000 00:18 UTC
   (J2000.0 epoch), we calculate how many days have elapsed
   since that anchor, mod the synodic period to get the
   current lunar age (0 = New Moon, ~14.77 = Full Moon).
   The 8 canonical phases are mapped to equal 3.69-day windows.

   No external API. No network request. Pure math.
   Accurate to within ~1 phase step for any date.
   ============================================================ */
function initMoonPhase() {
    const section = document.querySelector('.moon-phase-section');
    if (!section) return;

    /* ── Phase data: name, CSS modifier, icon symbol, advice ── */
    const PHASES = [
        {
            name: 'New Moon',
            mod: 'new',
            symbol: '🌑',
            advice: 'A portal of new beginnings. Set your intentions and place your crystals in a safe space — they are resting and receptive to your deepest wishes tonight.'
        },
        {
            name: 'Waxing Crescent',
            mod: 'waxing-crescent',
            symbol: '🌒',
            advice: 'The moon is growing, and so is your energy. Carry Citrine or Green Aventurine — their manifesting power amplifies beautifully under this rising light.'
        },
        {
            name: 'First Quarter',
            mod: 'first-quarter',
            symbol: '🌓',
            advice: 'A moment of decision and momentum. Cleanse your crystals with running water or sound — a singing bowl will clear any stagnant energy accumulated this week.'
        },
        {
            name: 'Waxing Gibbous',
            mod: 'waxing-gibbous',
            symbol: '🌔',
            advice: 'Refinement is key. Meditate with your Amethyst or Lapis Lazuli to sharpen your focus as the full moon approaches and its power builds toward its peak.'
        },
        {
            name: 'Full Moon',
            mod: 'full',
            symbol: '🌕',
            advice: 'The energy is at its absolute peak. Place all your crystals outside or on a windowsill overnight — the moonlight will fully cleanse and recharge every stone.'
        },
        {
            name: 'Waning Gibbous',
            mod: 'waning-gibbous',
            symbol: '🌖',
            advice: 'A time of gratitude and release. Sage your crystals and your space with intention, letting go of what no longer serves your highest energy and purpose.'
        },
        {
            name: 'Last Quarter',
            mod: 'last-quarter',
            symbol: '🌗',
            advice: 'Surrender and let go. Bury Black Tourmaline or Obsidian in the earth for 24 hours to ground and neutralise any heavy or absorbed negative energy.'
        },
        {
            name: 'Waning Crescent',
            mod: 'waning-crescent',
            symbol: '🌘',
            advice: 'Rest and restore. This is the most powerful time for deep crystal meditation. Hold Selenite or Clear Quartz in both palms and simply breathe in stillness.'
        }
    ];

    /* ── Lunar age calculation ────────────────────────────── */
    function getLunarAge(date) {
        // Known New Moon: 6 Jan 2000, 18:14 UTC → Unix ms
        const KNOWN_NEW_MOON_MS = 947182440000;
        const SYNODIC_MS = 29.53058867 * 24 * 60 * 60 * 1000;
        const elapsed = date.getTime() - KNOWN_NEW_MOON_MS;
        // Always positive modulo
        const age = ((elapsed % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS;
        return age / (1000 * 60 * 60 * 24); // days (0–29.53)
    }

    /* ── Map age → phase index (8 equal windows) ────────────── */
    function getPhaseIndex(ageDays) {
        const window = 29.53058867 / 8; // 3.691 days per phase
        return Math.floor(ageDays / window) % 8;
    }

    /* ── Calculate and inject ───────────────────────────────── */
    const today = new Date();
    const age = getLunarAge(today);
    const phaseIdx = getPhaseIndex(age);
    const phase = PHASES[phaseIdx];

    // Age as percentage through the full cycle (used to morph the visual)
    const pct = age / 29.53058867; // 0 → 1

    // Inject text content
    const nameEl = section.querySelector('#moonPhaseName');
    const adviceEl = section.querySelector('#moonPhaseAdvice');
    const symbolEl = section.querySelector('#moonPhaseSymbol');
    const ageEl = section.querySelector('#moonPhaseAge');

    if (nameEl) nameEl.textContent = phase.name;
    if (adviceEl) adviceEl.textContent = phase.advice;
    if (symbolEl) symbolEl.textContent = phase.symbol;
    if (ageEl) ageEl.textContent = `Day ${Math.round(age)} of 29`;

    // Apply phase modifier class to the visual for CSS-driven shape
    const visual = section.querySelector('.moon-visual');
    if (visual) {
        // Remove any previous phase class
        visual.className = visual.className
            .split(' ')
            .filter(c => !c.startsWith('moon--'))
            .join(' ');
        visual.classList.add(`moon--${phase.mod}`);

        // Set CSS custom property so the shadow intensity tracks the cycle:
        // 0 = new (no glow), 0.5 = full (max glow), 1 = back to new
        const glowIntensity = Math.sin(pct * Math.PI); // 0→1→0 over the cycle
        visual.style.setProperty('--moon-glow', glowIntensity.toFixed(3));
    }

    // Fade the section in once data is ready
    section.classList.add('moon-ready');
}
function initBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    window.addEventListener('scroll', () => btn.classList.toggle('visible', window.scrollY > 300), { passive: true });
    btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}


/* ============================================================
   SECTION 13: SINGLE DOMContentLoaded ENTRY POINT
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {

    await loadGlobalSettings(); // Must be first — may replace body with maintenance page
    if (!document.querySelector('.navbar')) return; // maintenance mode replaced the page

    updateCounters();
    syncActiveNavLinks();
    initGlobalFeatures();
    initBackToTop();
    initHeroSlider();

    // Fetch all products from Firestore into productMap.
    // Everything below that reads products depends on this.
    await initProductData();

    // Both homepage sections read from productMap synchronously now —
    initHomePage();
    initMoonPhase();
    initAuraKitBuilder();

    // Shop page only — wire filters, sort, pagination
    if (document.getElementById('productsGrid')) {
        // Wait one microtask so the Drawer IIFE's DOMContentLoaded
        // listener has already run patchUpdateShopView().
        await Promise.resolve();
        updateShopView(1);

        const grid = document.getElementById('productsGrid');
        if (grid) grid.setAttribute('aria-busy', 'false');

        const selected = document.getElementById('dropdownSelected');
        const list = document.getElementById('dropdownList');
        const container = document.querySelector('.custom-dropdown');

        if (selected && list && container) {
            selected.addEventListener('click', e => { e.stopPropagation(); container.classList.toggle('open'); });
            list.querySelectorAll('li').forEach(item => {
                item.addEventListener('click', e => {
                    e.stopPropagation();
                    selected.innerHTML = item.textContent + ' <i class="fa-solid fa-chevron-down"></i>';
                    container.classList.remove('open');
                    updateShopView(1);
                });
            });
            document.addEventListener('click', e => { if (!container.contains(e.target)) container.classList.remove('open'); });
        }

        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                updateShopView(1);
            });
        });

        document.querySelector('.clear-filter-btn')?.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('.filter-btn[data-filter="all"]')?.classList.add('active');
            updateShopView(1);
        });

        document.getElementById('noResultsResetBtn')?.addEventListener('click', () => {
            if (typeof window.DRAWER_FILTERS === 'object') {
                window.DRAWER_FILTERS.intents = [];
                window.DRAWER_FILTERS.stones = [];
                window.DRAWER_FILTERS.priceMin = 0;
                window.DRAWER_FILTERS.priceMax = 5000;
                document.querySelectorAll('.drawer-chip.selected').forEach(c => {
                    c.classList.remove('selected');
                    c.setAttribute('aria-pressed', 'false');
                });
                const minEl = document.getElementById('drawerPriceMin');
                const maxEl = document.getElementById('drawerPriceMax');
                if (minEl) { minEl.value = 0; minEl.dispatchEvent(new Event('input')); }
                if (maxEl) { maxEl.value = 5000; }
            }
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('.filter-btn[data-filter="all"]')?.classList.add('active');
            updateShopView(1);
        });

        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentView = btn.dataset.view;
                document.getElementById('productsGrid')?.classList.toggle('list-view', currentView === 'list');
                updateShopView(1);
            });
        });

        const urlFilter = new URLSearchParams(window.location.search).get('filter');
        if (urlFilter) {
            const filterBtn = document.querySelector(`.filter-btn[data-filter="${urlFilter}"]`);
            if (filterBtn) {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                filterBtn.classList.add('active');
                updateShopView(1);
            }
        }
    }

});


/* ============================================================
   PDP IIFE — Product Detail Page
   ============================================================ */
(function () {
    'use strict';

    let product = null;

    function populatePage() {
        if (!product) return;

        const galleryImages = (Array.isArray(product.images) && product.images.length > 0)
            ? product.images
            : [product.image].filter(Boolean);

        const mainImg = document.getElementById('pdpMainImage');
        if (mainImg) { mainImg.src = product.image || ''; mainImg.alt = product.name; }

        setTextContent('pdpTitle', product.name);
        setTextContent('pdpBreadcrumbName', product.name);
        setTextContent('pdpTag', capitalize(product.category));
        setTextContent('pdpGalleryBadge', capitalize(product.category));
        setTextContent('pdpDescription', product.description || 'Ethically sourced and charged with positive intentions. Each piece is unique, carrying its own natural energy signature.');

        const breadcrumbCatLink = document.getElementById('pdpBreadcrumbCategory');
        if (breadcrumbCatLink && product.category) {
            breadcrumbCatLink.href = `shop.html?filter=${product.category}`;
            breadcrumbCatLink.textContent = capitalize(product.category);
        }

        const onSale = product.salePrice != null &&
            typeof product.salePrice === 'number' &&
            product.salePrice < (product.price || 0);

        const priceRow = document.querySelector('.pdp-price-row');
        if (priceRow) {
            if (onSale) {
                const savedPct = (typeof product.discount === 'number' && product.discount > 0)
                    ? product.discount
                    : Math.round((1 - product.salePrice / product.price) * 100);
                priceRow.innerHTML = `
                    <span class="sale-badge pdp-sale-badge">SALE</span>
                    <span class="pdp-price-orig" id="pdpPriceOrig">₹${product.price.toLocaleString('en-IN')}</span>
                    <span class="pdp-price-current pdp-price-sale" id="pdpPrice">₹${product.salePrice.toLocaleString('en-IN')}</span>
                    <span class="price-save-badge">-${savedPct}% OFF</span>
                    <span class="pdp-price-tag">incl. of all taxes</span>`;
            } else {
                const mrp = Math.round((product.price || 0) * 1.25);
                priceRow.innerHTML = `
                    <span class="pdp-price-orig" id="pdpPriceOrig">₹${mrp.toLocaleString('en-IN')}</span>
                    <span class="pdp-price-current" id="pdpPrice">₹${(product.price || 0).toLocaleString('en-IN')}</span>
                    <span class="pdp-price-tag">incl. of all taxes</span>`;
            }
        }

        const effectivePrice = onSale ? product.salePrice : (product.price || 0);
        document.title = `${product.name} | Aura & Earth`;
        setTextContent('pdpStickyName', product.name);
        setTextContent('pdpStickyPrice', `₹${effectivePrice.toLocaleString('en-IN')}`);

        const thumbsContainer = document.getElementById('pdpThumbs');
        if (thumbsContainer) {
            thumbsContainer.innerHTML = '';
            galleryImages.forEach((src, i) => {
                const div = document.createElement('div');
                div.className = `pdp-gallery-thumb${i === 0 ? ' active' : ''}`;
                div.setAttribute('data-index', i);
                div.setAttribute('aria-label', `View image ${i + 1}`);
                div.setAttribute('role', 'button');
                div.setAttribute('tabindex', '0');
                div.innerHTML = `<img src="${src}" alt="${product.name} view ${i + 1}" loading="lazy">`;
                thumbsContainer.appendChild(div);
            });
            initGallery(galleryImages);
        }

        renderRelatedProducts();

        const heartIcon = document.getElementById('pdpHeartIcon');
        const wishBtn = document.getElementById('pdpWishlistBtn');
        if (isInWishlist(product.id)) {
            heartIcon?.classList.replace('fa-regular', 'fa-solid');
            wishBtn?.classList.add('active');
        }
    }

    function setTextContent(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
    function capitalize(str) { return str ? str.charAt(0).toUpperCase() + str.slice(1) : ''; }

    function initGallery(images) {
        const mainImg = document.getElementById('pdpMainImage');
        const thumbs = document.querySelectorAll('.pdp-gallery-thumb');
        if (!mainImg || !thumbs.length) return;
        mainImg.style.transition = 'opacity 0.25s ease, transform 0.25s ease';

        function setActiveImage(index) {
            mainImg.style.opacity = '0'; mainImg.style.transform = 'scale(0.97)';
            setTimeout(() => { mainImg.src = images[index]; mainImg.style.opacity = '1'; mainImg.style.transform = 'scale(1)'; }, 180);
            thumbs.forEach(t => t.classList.remove('active'));
            thumbs[index].classList.add('active');
        }
        thumbs.forEach(thumb => {
            thumb.addEventListener('click', () => setActiveImage(parseInt(thumb.getAttribute('data-index'))));
            thumb.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveImage(parseInt(thumb.getAttribute('data-index'))); } });
        });
    }

    function initLightbox() {
        const mainImg = document.getElementById('pdpMainImage');
        const zoomBtn = document.getElementById('pdpZoomBtn');
        const lightbox = document.getElementById('pdpLightbox');
        const lightboxImg = document.getElementById('pdpLightboxImg');
        const closeBtn = document.getElementById('pdpLightboxClose');
        if (!lightbox) return;

        const openLightbox = () => { lightboxImg.src = mainImg.src; lightbox.classList.add('open'); lightbox.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; };
        const closeLightbox = () => { lightbox.classList.remove('open'); lightbox.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; };

        zoomBtn?.addEventListener('click', openLightbox);
        mainImg?.addEventListener('click', openLightbox);
        closeBtn?.addEventListener('click', closeLightbox);
        lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && lightbox.classList.contains('open')) closeLightbox(); });
    }

    function initStoneSwatches() {
        const charmBtns = document.querySelectorAll('.pdp-charm-btn');
        const label = document.getElementById('pdpSelectedStone');
        if (!charmBtns.length) return;
        charmBtns.forEach(btn => {
            btn.addEventListener('click', () => { charmBtns.forEach(b => b.classList.remove('active')); btn.classList.add('active'); if (label) label.textContent = btn.getAttribute('data-stone'); });
        });
    }

    function initSizeButtons() {
        const sizeBtns = document.querySelectorAll('.pdp-size-btn');
        const sizeLabel = document.getElementById('pdpSelectedSize');
        if (!sizeBtns.length) return;
        sizeBtns.forEach(btn => {
            btn.addEventListener('click', () => { sizeBtns.forEach(b => b.classList.remove('active')); btn.classList.add('active'); if (sizeLabel) sizeLabel.textContent = btn.getAttribute('data-size'); });
        });
    }

    function initQuantityControl() {
        const minusBtn = document.getElementById('pdpQtyMinus');
        const plusBtn = document.getElementById('pdpQtyPlus');
        const qtyDisplay = document.getElementById('pdpQtyValue');
        let qty = 1; const MAX_QTY = 10;
        if (!minusBtn || !plusBtn || !qtyDisplay) return;
        minusBtn.disabled = true;
        minusBtn.addEventListener('click', () => { if (qty > 1) { qty--; qtyDisplay.textContent = qty; minusBtn.disabled = qty === 1; } });
        plusBtn.addEventListener('click', () => { if (qty < MAX_QTY) { qty++; qtyDisplay.textContent = qty; minusBtn.disabled = false; } else showToast('Maximum quantity reached', 'info'); });
    }

    function initCTAButtons() {
        const addToCartBtn = document.getElementById('pdpAddToCartBtn');
        const wishlistBtn = document.getElementById('pdpWishlistBtn');
        const buyNowBtn = document.getElementById('pdpBuyNowBtn');
        const heartIcon = document.getElementById('pdpHeartIcon');

        const getSelectedSize = () => { const a = document.querySelector('.pdp-size-btn.active'); return a ? a.getAttribute('data-size') : 'Medium (17cm)'; };
        const getSelectedCharm = () => { const a = document.querySelector('#pdpStoneSwatches .pdp-swatch-btn.active, #pdpStoneSwatches .pdp-charm-btn.active'); return a ? a.getAttribute('data-stone') : 'None'; };
        const getSelectedQty = () => { const el = document.getElementById('pdpQtyValue'); return el ? parseInt(el.textContent) || 1 : 1; };

        addToCartBtn?.addEventListener('click', () => {
            if (!product) return;
            if (isInCart(product.id)) { showToast('Already in your Bag! ✨', 'info'); return; }
            // Use window.addToCart so Mini Cart drawer opens automatically
            window.addToCart(product.id);
            const orig = addToCartBtn.innerHTML;
            addToCartBtn.innerHTML = '<i class="fa-solid fa-check"></i> Added!'; addToCartBtn.disabled = true;
            setTimeout(() => { addToCartBtn.innerHTML = orig; addToCartBtn.disabled = false; }, 2000);
        });

        wishlistBtn?.addEventListener('click', () => {
            if (!product) return;
            const ids = getWishlistIds(); const idx = ids.indexOf(product.id);
            if (idx === -1) { ids.push(product.id); saveWishlistIds(ids); wishlistBtn.classList.add('active'); heartIcon?.classList.replace('fa-regular', 'fa-solid'); if (heartIcon) heartIcon.style.color = '#e74c3c'; showToast('Saved to Wishlist 💜'); }
            else { ids.splice(idx, 1); saveWishlistIds(ids); wishlistBtn.classList.remove('active'); heartIcon?.classList.replace('fa-solid', 'fa-regular'); if (heartIcon) heartIcon.style.color = ''; showToast('Removed from Wishlist'); }
        });

        buyNowBtn?.addEventListener('click', () => {
            if (!product) return;
            const items = getCartItems();
            if (!isInCart(product.id)) { items.push({ id: product.id, qty: getSelectedQty(), size: getSelectedSize(), charm: getSelectedCharm() }); saveCartItems(items); }
            location.href = 'cart-checkout.html';
        });
    }

    function initTabs() {
        const tabs = document.querySelectorAll('.pdp-tab-btn');
        const panels = document.querySelectorAll('.pdp-tab-panel');
        if (!tabs.length) return;
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
                panels.forEach(p => p.classList.remove('active'));
                tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
                const panel = document.getElementById(tab.dataset.tab);
                if (panel) panel.classList.add('active');
            });
        });
    }

    function initSizeGuideModal() {
        const modal = document.getElementById('sizeGuideModal');
        const openBtn = document.getElementById('pdpSizeGuideBtn');
        const closeBtn = document.getElementById('sizeGuideClose');
        if (!modal) return;
        const openModal = () => { modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); document.body.style.overflow = 'hidden'; };
        const closeModal = () => { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); document.body.style.overflow = ''; };
        openBtn?.addEventListener('click', openModal);
        closeBtn?.addEventListener('click', closeModal);
        modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(); });
    }

    function initReviewActions() {
        document.querySelectorAll('.pdp-helpful-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.classList.contains('active')) return;
                btn.classList.add('active');
                const match = btn.textContent.match(/\((\d+)\)/);
                if (match) btn.innerHTML = `<i class="fa-solid fa-thumbs-up"></i> Yes (${parseInt(match[1]) + 1})`;
            });
        });
        document.getElementById('pdpLoadMoreReviews')?.addEventListener('click', function () { showToast('All reviews loaded!', 'info'); this.disabled = true; this.innerHTML = 'No more reviews <i class="fa-solid fa-check"></i>'; });
        document.getElementById('pdpWriteReviewBtn')?.addEventListener('click', () => showToast('Review form coming soon! ✍️', 'info'));
    }

    function renderRelatedProducts() {
        const grid = document.getElementById('pdpRelatedGrid');
        if (!grid) return;
        const related = [...productMap.values()].filter(p => p.id !== product.id).slice(0, 4);
        if (!related.length) { grid.closest('.pdp-related-section')?.style.setProperty('display', 'none'); return; }
        grid.innerHTML = related.map(p => `
            <div class="pdp-related-card">
                <div class="pdp-related-img-wrap"><img src="${p.image}" alt="${p.name}" loading="lazy"></div>
                <div class="pdp-related-card-info">
                    <div class="pdp-related-card-name">${p.name}</div>
                    <div class="pdp-related-card-price">₹${p.price.toLocaleString()}</div>
                </div>
                <a href="product-detail.html?id=${p.id}" class="pdp-related-card-btn">View Details</a>
            </div>`).join('');
    }
    function initAccordions() {
        document.querySelectorAll('.pdp-accordion-trigger').forEach(trigger => {
            trigger.addEventListener('click', () => {
                const isOpen = trigger.getAttribute('aria-expanded') === 'true';
                const body = trigger.nextElementSibling;
                const chevron = trigger.querySelector('.pdp-accordion-chevron');
                const accordion = trigger.closest('.pdp-accordion');

                // Close all others first (one-open-at-a-time behaviour)
                document.querySelectorAll('.pdp-accordion-trigger').forEach(t => {
                    if (t === trigger) return;
                    t.setAttribute('aria-expanded', 'false');
                    t.nextElementSibling?.setAttribute('hidden', '');
                    t.querySelector('.pdp-accordion-chevron')
                        ?.classList.remove('pdp-accordion-chevron--open');
                    t.closest('.pdp-accordion')
                        ?.classList.remove('pdp-accordion--open');
                });

                // Toggle this one
                if (isOpen) {
                    trigger.setAttribute('aria-expanded', 'false');
                    body.setAttribute('hidden', '');
                    chevron?.classList.remove('pdp-accordion-chevron--open');
                    accordion?.classList.remove('pdp-accordion--open');
                } else {
                    trigger.setAttribute('aria-expanded', 'true');
                    body.removeAttribute('hidden');
                    chevron?.classList.add('pdp-accordion-chevron--open');
                    accordion?.classList.add('pdp-accordion--open');
                }
            });
        });
    }

    function initShareButtons() {
        document.querySelectorAll('.pdp-share-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const icon = btn.querySelector('i');
                const url = encodeURIComponent(window.location.href);
                const title = encodeURIComponent(product?.name || 'Healing Bracelet');
                if (icon.classList.contains('fa-instagram')) showToast('Copy the link and share on Instagram! 📸', 'info');
                else if (icon.classList.contains('fa-whatsapp')) window.open(`https://wa.me/?text=${title}%20${url}`, '_blank');
                else if (icon.classList.contains('fa-link')) navigator.clipboard.writeText(window.location.href).then(() => showToast('Link copied! 🔗')).catch(() => showToast('Could not copy link', 'info'));
            });
        });
    }

    document.addEventListener('DOMContentLoaded', async () => {
        if (!document.querySelector('.pdp-hero-section')) return;

        const mainImg = document.getElementById('pdpMainImage');
        const detailsInner = document.querySelector('.pdp-details-inner');

        // ── Phase 1: Skeleton loaders ─────────────────────────────────
        // Hide image until it loads
        if (mainImg) mainImg.style.opacity = '0';

        // Wire onload BEFORE setting src so cached images don't miss it
        if (mainImg) {
            mainImg.addEventListener('load', () => {
                mainImg.style.transition = 'opacity 0.4s ease';
                mainImg.style.opacity = '1';
            }, { once: true });
        }

        // Details panel: swap to shimmer skeleton while Firestore fetches
        let detailsSnapshot = '';
        if (detailsInner) {
            detailsSnapshot = detailsInner.innerHTML; // preserve original markup
            detailsInner.innerHTML = `
                <div class="pdp-skel-rod pdp-skel-rod--tag"></div>
                <div class="pdp-skel-rod pdp-skel-rod--title"></div>
                <div class="pdp-skel-rod pdp-skel-rod--line" style="width:55%;margin-bottom:24px;"></div>
                <div class="pdp-skel-rod pdp-skel-rod--price"></div>
                <div class="pdp-skel-rod pdp-skel-rod--line"></div>
                <div class="pdp-skel-rod pdp-skel-rod--line"></div>
                <div class="pdp-skel-rod pdp-skel-rod--line-short"></div>
                <div class="pdp-skel-rod pdp-skel-rod--btn" style="margin-top:32px;"></div>
                <div class="pdp-skel-rod pdp-skel-rod--btn" style="height:44px;opacity:0.6;"></div>`;
        }

        // ── Phase 2: Fetch all products from Firestore ────────────────
        await initProductData();

        // ── Phase 3: Resolve the correct product from the URL ─────────
        // Try ?id= as integer first (standard numeric IDs),
        // then as the raw string (auto-generated Firestore doc IDs),
        // then only fall back to the first product when ?id= is absent.
        const rawId = new URLSearchParams(window.location.search).get('id');
        const intId = rawId !== null ? parseInt(rawId, 10) : NaN;
        const hasParam = rawId !== null;

        product = hasParam
            ? (productMap.get(intId) || productMap.get(rawId) || null)
            : ([...productMap.values()][0] || null);

        // ── Phase 4: Restore panel HTML so all IDs exist in the DOM ───
        if (detailsInner) {
            detailsInner.innerHTML = detailsSnapshot;
        }

        // ── Error state ───────────────────────────────────────────────
        if (!product) {
            // Re-query after restoration — captures fresh DOM refs
            const titleEl = document.getElementById('pdpTitle');
            const descEl = document.getElementById('pdpDescription');
            if (titleEl) titleEl.textContent = hasParam
                ? `Product not found`
                : 'No products available';
            if (descEl) descEl.textContent =
                'This product could not be loaded. Please return to the shop.';
            if (mainImg) mainImg.style.opacity = '1'; // clear loading state
            return;
        }

        // ── Phase 5: Populate and reveal ─────────────────────────────
        populatePage();

        // Handle already-cached images (the 'load' event won't re-fire)
        if (mainImg && mainImg.complete && mainImg.naturalWidth > 0) {
            mainImg.style.transition = 'opacity 0.4s ease';
            mainImg.style.opacity = '1';
        }

        // ── Phase 6: Wire all interactions ───────────────────────────
        initLightbox();
        initStoneSwatches();
        initSizeButtons();
        initQuantityControl();
        initCTAButtons();
        initTabs();
        initSizeGuideModal();
        initReviewActions();
        initAccordions();
        initShareButtons();

        // Mobile sticky bar delegates to the main CTA button
        // Sticky bar — cart btn delegates to main CTA
        // Sticky bar — "Add to Bag" delegates to main CTA
        document.getElementById('pdpMobileStickyCartBtn')
            ?.addEventListener('click', () => {
                document.getElementById('pdpAddToCartBtn')?.click();
            });

        // Sticky bar — "Buy Now" adds to cart then navigates to checkout
        document.getElementById('pdpStickyBuyNow')
            ?.addEventListener('click', () => {
                document.getElementById('pdpAddToCartBtn')?.click();
                setTimeout(() => { window.location.href = 'cart-checkout.html'; }, 320);
            });

        // Show bar on ALL screen sizes when the CTA group scrolls out of view
        const ctaGroup = document.querySelector('.pdp-cta-group');
        const stickyBar = document.getElementById('pdpMobileStickyBar');
        if (ctaGroup && stickyBar) {
            new IntersectionObserver(entries => {
                const isHidden = !entries[0].isIntersecting;
                stickyBar.classList.toggle('visible', isHidden);
                stickyBar.setAttribute('aria-hidden', String(!isHidden));
            }, { threshold: 0 }).observe(ctaGroup);
        }
    });

})(); // PDP IIFE



/* ============================================================
   CART-CHECKOUT IIFE — UPI Checkout
   ─────────────────────────────────────────────────────────
   Handles: cart rendering, coupon, UPI QR, UTR validation,
   order placement (Firestore + localStorage), success modal.
   Bundle-aware: resolveCartItems detects isStackBundle:true
   entries and calculates discounted bundle prices from the
   module-level STACK_BUNDLE_DISCOUNT variable.
   ============================================================ */
(function () {
    'use strict';

    /* ── Constants ──────────────────────────────────────────── */
    let SHIPPING_THRESHOLD = 2999;
    let SHIPPING_COST = 79;

    async function loadCartSettings() {
        try {
            // Re-use already-cached _globalSettings from loadGlobalSettings()
            // to avoid a second Firestore read to the same document.
            const s = _globalSettings;
            if (!s) return;
            if (typeof s.freeShipping === 'number' && s.freeShipping > 0) SHIPPING_THRESHOLD = s.freeShipping;
            if (typeof s.deliveryFee === 'number' && s.deliveryFee >= 0) SHIPPING_COST = s.deliveryFee;
            if (typeof s.stackDiscount === 'number' && s.stackDiscount >= 0) {
                STACK_BUNDLE_DISCOUNT = s.stackDiscount;
            }
        } catch (err) {
            console.error('[Aura & Earth] loadCartSettings failed — using defaults:', err.message);
        }
    }
    const SIZE_OPTIONS = ['XS (14cm)', 'Small (15.5cm)', 'Medium (17cm)', 'Large (18.5cm)', 'XL (20cm)'];
    const CHARM_OPTIONS = ['None', 'Hamsa Hand (Alloy)', 'Buddha Face (Alloy)'];

    /*
       ── UPI merchant config ──────────────────────────────────
       Replace MERCHANT_UPI_ID with your real UPI VPA before
       going live (e.g. 'yourname@paytm', 'business@okaxis').
       MERCHANT_NAME is the payee name shown in UPI apps.
    */
    const MERCHANT_UPI_ID = 'deepakbilandi11@okicici';
    const MERCHANT_NAME = 'AuraAndEarth';

    /* ── Module-level state ─────────────────────────────────── */
    let cartItems = [];
    let appliedCoupon = null;

    /* ── Cached DOM references (set in DOMContentLoaded) ────── */
    let _currentTotal = 0;   // tracks the live order total for QR updates

    /* ============================================================
       SECTION A: CART ITEM HELPERS
       Bundle-aware rewrite — all functions handle both regular
       items AND isStackBundle:true bundle entries.
       ============================================================ */

    /* ── resolveCartItems ────────────────────────────────────────
       Reads localStorage `cartItems` and enriches each entry.
       Regular items: look up product in productMap as before.
       Bundle items:  look up each sub-item id, compute the
                      combined base price and discounted price,
                      attach sub-item metadata for rendering.    */
    function resolveCartItems() {
        let stored = [];
        try { stored = JSON.parse(localStorage.getItem('cartItems')) || []; } catch { stored = []; }

        cartItems = stored.map(entry => {

            // ── BUNDLE ENTRY ──────────────────────────────────
            if (entry.isStackBundle === true) {
                const subItems = (entry.items || []).map(subId => {
                    const p = productMap.get(subId)
                        || productMap.get(parseInt(subId, 10))
                        || productMap.get(String(subId));
                    return p || null;
                }).filter(Boolean);

                if (subItems.length === 0) {
                    console.warn(`[Aura & Earth] Bundle id=${entry.id} — no sub-items resolved, skipping.`);
                    return null;
                }

                // Sum effective (sale-aware) prices of every sub-item
                const subTotal = subItems.reduce((sum, p) => {
                    const ep = (p.salePrice != null && typeof p.salePrice === 'number' && p.salePrice < p.price)
                        ? p.salePrice : (p.price || 0);
                    return sum + ep;
                }, 0);

                const discountPct = STACK_BUNDLE_DISCOUNT;
                const discountAmt = Math.round(subTotal * discountPct / 100);
                const bundlePrice = subTotal - discountAmt;

                return {
                    id: entry.id,
                    isStackBundle: true,
                    items: entry.items,    // raw IDs — kept for persistCart()
                    subItems,                      // enriched product objects for rendering
                    subTotal,
                    discountPct,
                    discountAmt,
                    bundlePrice,                   // the single price charged for the whole bundle
                    qty: 1,                      // bundles are always qty 1
                    size: entry.size || 'Medium (17cm)',
                    charm: entry.charm || 'None',
                    // Expose `price` so recalculateTotals can treat bundles uniformly
                    price: bundlePrice,
                    salePrice: null,               // discount is already baked in
                    name: 'Custom Crystal Stack',
                    image: subItems[0]?.image || ''
                };
            }

            // ── REGULAR ITEM ──────────────────────────────────
            const product = productMap.get(entry.id)
                || productMap.get(parseInt(entry.id, 10))
                || productMap.get(String(entry.id));

            if (!product) {
                console.warn(`[Aura & Earth] Cart item id=${entry.id} not found in productMap — skipped.`);
                return null;
            }
            return {
                ...product,
                qty: Math.max(1, entry.qty || 1),
                size: entry.size || 'Medium (17cm)',
                charm: entry.charm || 'None'
            };
        }).filter(Boolean);
    }

    /* ── persistCart ─────────────────────────────────────────────
       Slims cartItems back to storage-safe shape.
       Bundle items preserve isStackBundle + items array.        */
    function persistCart() {
        const slim = cartItems.map(item => {
            if (item.isStackBundle) {
                return {
                    id: item.id,
                    isStackBundle: true,
                    items: item.items,
                    qty: 1,
                    size: item.size,
                    charm: item.charm
                };
            }
            return { id: item.id, qty: item.qty, size: item.size, charm: item.charm };
        });
        saveCartItems(slim);
    }

    function buildSelectHTML(optionsArr, selectedValue, cls, ariaLabel) {
        const opts = optionsArr.map(o => `<option value="${o}"${o === selectedValue ? ' selected' : ''}>${o}</option>`).join('');
        return `<select class="${cls}" aria-label="${ariaLabel}">${opts}</select>`;
    }

    function createEmptyState() {
        const div = document.createElement('div');
        div.className = 'cart-empty-state';
        div.innerHTML = `<div class="cart-empty-icon"><i class="fa-solid fa-bag-shopping"></i></div><h3>Your bag is empty</h3><p>Discover our healing crystal collection and find your perfect piece.</p><a href="shop.html" class="cart-shop-now-btn">Explore Collection</a>`;
        return div;
    }

    /* ── createBundleRow ─────────────────────────────────────────
       Renders a stack bundle as a single premium cart row.
       Shows all sub-item names, crossed-out combined price,
       discounted bundle price, and the discount badge.         */
    function createBundleRow(item) {
        const row = document.createElement('div');
        row.className = 'cart-item-row cart-item-row--bundle';
        row.setAttribute('data-item-id', item.id);

        const subItemsHTML = item.subItems.map(p => `
            <div class="bundle-sub-item">
                <img src="${p.image || ''}" alt="${p.name}" loading="lazy" class="bundle-sub-img">
                <span class="bundle-sub-name">${p.name}</span>
            </div>`).join('');

        const discountBadge = item.discountPct > 0
            ? `<span class="cart-bundle-discount-badge">${item.discountPct}% Bundle Discount</span>`
            : '';

        const priceHTML = item.discountPct > 0
            ? `<div class="cart-bundle-price-wrap">
                   <span class="cart-price-orig">₹${item.subTotal.toLocaleString('en-IN')}</span>
                   <span class="cart-price-sale">₹${item.bundlePrice.toLocaleString('en-IN')}</span>
               </div>`
            : `<span class="cart-item-price">₹${item.bundlePrice.toLocaleString('en-IN')}</span>`;

        row.innerHTML = `
            <div class="cart-item-img-wrap cart-item-img-wrap--bundle">
                <div class="bundle-mosaic">
                    ${item.subItems.slice(0, 4).map(p =>
            `<img src="${p.image || ''}" alt="${p.name}" loading="lazy">`
        ).join('')}
                </div>
                ${discountBadge}
            </div>
            <div class="cart-item-body">
                <div class="cart-item-top-row">
                    <span class="cart-item-name">
                        <i class="fa-solid fa-layer-group" style="color:var(--accent);margin-right:6px;font-size:0.85em;"></i>
                        Custom Crystal Stack
                    </span>
                    ${priceHTML}
                </div>
                <div class="bundle-sub-items-list">${subItemsHTML}</div>
                <div class="cart-item-selectors">
                    <div class="cart-inline-select-wrap">
                        <label class="cart-inline-label">Size</label>
                        ${buildSelectHTML(SIZE_OPTIONS, item.size, 'cart-inline-select cart-size-select', 'Wrist size')}
                    </div>
                    <div class="cart-inline-select-wrap">
                        <label class="cart-inline-label">Charm</label>
                        ${buildSelectHTML(CHARM_OPTIONS, item.charm, 'cart-inline-select cart-charm-select', 'Charm type')}
                    </div>
                </div>
                <div class="cart-item-footer-row">
                    <span class="cart-bundle-piece-count">${item.subItems.length} bracelet${item.subItems.length !== 1 ? 's' : ''}</span>
                    <button class="cart-remove-btn" aria-label="Remove Custom Stack">
                        <i class="fa-solid fa-trash-can"></i> Remove
                    </button>
                </div>
            </div>`;

        // Size / charm changes persist back to the bundle entry
        row.querySelector('.cart-size-select').addEventListener('change', e => {
            const entry = cartItems.find(i => i.id === item.id);
            if (entry) { entry.size = e.target.value; persistCart(); }
        });
        row.querySelector('.cart-charm-select').addEventListener('change', e => {
            const entry = cartItems.find(i => i.id === item.id);
            if (entry) { entry.charm = e.target.value; persistCart(); }
        });
        row.querySelector('.cart-remove-btn').addEventListener('click', () => removeItem(item.id));

        return row;
    }

    /* ── createCartItemRow — regular (non-bundle) items ─────── */
    function createCartItemRow(item) {
        const onSale = item.salePrice != null &&
            typeof item.salePrice === 'number' &&
            item.salePrice < (item.price || 0);
        const effectivePrice = onSale ? item.salePrice : (item.price || 0);

        const unitPriceHTML = onSale
            ? `<span class="cart-item-unit-price">
                   <span class="cart-price-orig">₹${item.price.toLocaleString('en-IN')}</span>
                   <span class="cart-price-sale">₹${effectivePrice.toLocaleString('en-IN')}</span>
                   each
               </span>`
            : `<span class="cart-item-unit-price">₹${effectivePrice.toLocaleString('en-IN')} each</span>`;

        const saleBadgeHTML = onSale ? `<span class="sale-badge cart-sale-badge">SALE</span>` : '';

        const row = document.createElement('div');
        row.className = 'cart-item-row';
        row.setAttribute('data-item-id', item.id);
        row.innerHTML = `
            <div class="cart-item-img-wrap">
                <img src="${item.image}" alt="${item.name}" loading="lazy">
                ${saleBadgeHTML}
            </div>
            <div class="cart-item-body">
                <div class="cart-item-top-row">
                    <span class="cart-item-name">${item.name}</span>
                    <span class="cart-item-price">₹${(effectivePrice * item.qty).toLocaleString('en-IN')}</span>
                </div>
                <div class="cart-item-selectors">
                    <div class="cart-inline-select-wrap"><label class="cart-inline-label">Size</label>${buildSelectHTML(SIZE_OPTIONS, item.size, 'cart-inline-select cart-size-select', 'Wrist size')}</div>
                    <div class="cart-inline-select-wrap"><label class="cart-inline-label">Charm</label>${buildSelectHTML(CHARM_OPTIONS, item.charm, 'cart-inline-select cart-charm-select', 'Charm type')}</div>
                </div>
                <div class="cart-item-footer-row">
                    <div class="cart-qty-controls">
                        <button class="cart-qty-btn cart-qty-minus" aria-label="Decrease quantity"><i class="fa-solid fa-minus"></i></button>
                        <span class="cart-qty-display">${item.qty}</span>
                        <button class="cart-qty-btn cart-qty-plus" aria-label="Increase quantity"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    ${unitPriceHTML}
                    <button class="cart-remove-btn" aria-label="Remove ${item.name}"><i class="fa-solid fa-trash-can"></i> Remove</button>
                </div>
            </div>`;

        row.querySelector('.cart-qty-minus').addEventListener('click', () => changeQty(item.id, -1));
        row.querySelector('.cart-qty-plus').addEventListener('click', () => changeQty(item.id, 1));
        row.querySelector('.cart-remove-btn').addEventListener('click', () => removeItem(item.id));
        row.querySelector('.cart-size-select').addEventListener('change', e => { const entry = cartItems.find(i => i.id === item.id); if (entry) { entry.size = e.target.value; persistCart(); } });
        row.querySelector('.cart-charm-select').addEventListener('change', e => { const entry = cartItems.find(i => i.id === item.id); if (entry) { entry.charm = e.target.value; persistCart(); } });
        return row;
    }

    /* ── renderCartItems ─────────────────────────────────────────
       Routes each item to the correct renderer.               */
    function renderCartItems() {
        const list = document.getElementById('cartItemsList');
        const itemCountEl = document.getElementById('cartItemCount');
        const couponCard = document.getElementById('cartUtilityCard');
        const summaryCard = document.getElementById('cartSummaryCard');
        if (!list) return;

        // Total quantity: bundles count as 1 unit in the badge
        const totalQty = cartItems.reduce((s, i) => s + (i.isStackBundle ? 1 : i.qty), 0);
        if (itemCountEl) itemCountEl.textContent = `${totalQty} item${totalQty !== 1 ? 's' : ''}`;
        list.innerHTML = '';

        if (cartItems.length === 0) {
            if (couponCard) couponCard.style.display = 'none';
            if (summaryCard) summaryCard.style.display = 'none';
            list.appendChild(createEmptyState());
            return;
        }

        if (couponCard) couponCard.style.display = 'block';
        if (summaryCard) summaryCard.style.display = 'block';

        cartItems.forEach(item => {
            list.appendChild(
                item.isStackBundle ? createBundleRow(item) : createCartItemRow(item)
            );
        });

        recalculateTotals();
    }

    /* ── changeQty — bundles are not quantity-adjustable ─────── */
    function changeQty(id, delta) {
        const item = cartItems.find(i => i.id === id);
        if (!item || item.isStackBundle) return; // bundles are always qty 1
        const newQty = item.qty + delta;
        if (newQty < 1) { removeItem(id); return; }
        if (newQty > 10) { showToast('Maximum 10 units per item', 'info'); return; }
        item.qty = newQty;
        persistCart();
        const row = document.querySelector(`.cart-item-row[data-item-id="${id}"]`);
        if (row) {
            const ep = (item.salePrice != null && typeof item.salePrice === 'number' && item.salePrice < item.price)
                ? item.salePrice : item.price;
            row.querySelector('.cart-qty-display').textContent = newQty;
            row.querySelector('.cart-item-price').textContent = `₹${(ep * newQty).toLocaleString('en-IN')}`;
        }
        recalculateTotals();
    }

    function removeItem(id) {
        cartItems = cartItems.filter(i => i.id !== id);
        persistCart();
        if (cartItems.length === 0) appliedCoupon = null;
        renderCartItems();
        showToast('Item removed from bag');
    }

    /* ── recalculateTotals ───────────────────────────────────────
       Bundle items contribute bundlePrice (already discounted).
       Regular items contribute their standard effective price.  */
    function recalculateTotals() {
        const effectivePriceOf = i => {
            if (i.isStackBundle) return i.bundlePrice; // discount already applied
            return (i.salePrice != null && typeof i.salePrice === 'number' && i.salePrice < i.price)
                ? i.salePrice : (i.price || 0);
        };

        const subtotal = cartItems.reduce((sum, i) => {
            if (i.isStackBundle) return sum + (i.bundlePrice || 0);
            return sum + effectivePriceOf(i) * (i.qty || 1);
        }, 0);
        let discount = 0, freeShipping = false;
        if (appliedCoupon) {
            if (appliedCoupon.type === 'percent') discount = Math.round(subtotal * appliedCoupon.value / 100);
            if (appliedCoupon.type === 'freeship') freeShipping = true;
        }
        const afterDiscount = subtotal - discount;
        const shipping = (freeShipping || afterDiscount >= SHIPPING_THRESHOLD) ? 0 : SHIPPING_COST;
        const total = afterDiscount + shipping;

        setInnerText('summarySubtotal', `₹${subtotal.toLocaleString('en-IN')}`);
        setInnerText('summaryShipping', shipping === 0 ? 'FREE' : `₹${shipping.toLocaleString('en-IN')}`);
        setInnerText('summaryTotal', `₹${total.toLocaleString('en-IN')}`);
        setInnerText('cartStickyTotal', `₹${total.toLocaleString()}`);

        const shippingNote = document.getElementById('shippingNote');
        if (shippingNote) {
            shippingNote.textContent = shipping === 0
                ? (freeShipping ? '(Coupon applied)' : '(Free)')
                : `Free on ₹${SHIPPING_THRESHOLD.toLocaleString('en-IN')}+`;
        }

        const discountRow = document.getElementById('summaryDiscountRow');
        const discountEl = document.getElementById('summaryDiscount');
        const badgeEl = document.getElementById('appliedCouponBadge');
        if (discountRow) {
            const hasDiscount = discount > 0 || freeShipping;
            discountRow.classList.toggle('visible', hasDiscount);
            if (hasDiscount && discountEl)
                discountEl.textContent = freeShipping ? '— (Free Ship)' : `-₹${discount.toLocaleString('en-IN')}`;
            if (badgeEl && appliedCoupon) badgeEl.textContent = appliedCoupon.label;
        }

        _currentTotal = total;
        updateUpiQr(total);

        /* ── Free Shipping Progress Bar ────────────────────── */
        const progressWrap = document.getElementById('shippingProgressWrap');
        const progressFill = document.getElementById('shippingProgressFill');
        const progressAmount = document.getElementById('shippingProgressAmount');
        const progressLabel = document.getElementById('shippingProgressLabel');

        if (progressWrap && progressFill) {
            const isFree = freeShipping || afterDiscount >= SHIPPING_THRESHOLD;
            if (isFree || cartItems.length === 0) {
                progressWrap.style.display = 'none';
            } else {
                const pct = Math.min(100, Math.round((afterDiscount / SHIPPING_THRESHOLD) * 100));
                const needed = SHIPPING_THRESHOLD - afterDiscount;
                progressWrap.style.display = 'block';
                progressFill.style.width = pct + '%';
                progressFill.classList.toggle('full', pct >= 100);
                if (progressAmount) progressAmount.textContent = `₹${needed.toLocaleString('en-IN')}`;
                if (progressLabel) progressLabel.innerHTML = `
                    <i class="fa-solid fa-truck-fast" style="color:var(--accent,#6e9472);"></i>
                    Add <span class="progress-amount">₹${needed.toLocaleString('en-IN')}</span> for free shipping`;
            }
        }
    }

    function setInnerText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

    /* ============================================================
       SECTION B: COUPON
       ============================================================ */
    function initCoupon() {
        const input = document.getElementById('couponInput');
        const applyBtn = document.getElementById('couponApplyBtn');
        const feedback = document.getElementById('couponFeedback');
        const hintPills = document.querySelectorAll('.cart-hint-pill');
        if (!applyBtn) return;

        function showFeedback(type, html) {
            if (!feedback) return;
            feedback.innerHTML = html;
            feedback.className = `cart-coupon-feedback ${type}`;
        }

        async function applyCoupon(code) {
            const trimmed = code.trim().toUpperCase();
            if (!trimmed) {
                showFeedback('error', '<i class="fa-solid fa-xmark-circle"></i> Please enter a coupon code.');
                return;
            }
            if (appliedCoupon?.label === trimmed) {
                showFeedback('error', '<i class="fa-solid fa-xmark-circle"></i> This coupon is already applied.');
                return;
            }

            applyBtn.textContent = 'Checking…';
            applyBtn.disabled = true;

            try {
                const [{ db }, { collection, query, where, getDocs }] = await Promise.all([
                    import('./firebase.js'),
                    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
                ]);

                const snap = await getDocs(query(collection(db, 'coupons'), where('code', '==', trimmed)));

                if (!snap.empty) {
                    const data = snap.docs[0].data();
                    appliedCoupon = {
                        label: data.code,
                        type: 'percent',
                        value: Number(data.discount),
                        description: data.description || `${data.discount}% off your order`
                    };
                    showFeedback('success', `<i class="fa-solid fa-circle-check"></i> "${trimmed}" applied — ${appliedCoupon.description}!`);
                    applyBtn.textContent = 'Applied ✓';
                    if (input) input.disabled = true;
                    recalculateTotals();
                    showToast(`Coupon ${trimmed} applied! 🎉`);
                } else {
                    showFeedback('error', '<i class="fa-solid fa-xmark-circle"></i> Invalid or expired coupon code.');
                    applyBtn.textContent = 'Apply';
                    applyBtn.disabled = false;
                }
            } catch (err) {
                console.error('[Aura & Earth] Coupon validation error:', err);
                showFeedback('error', '<i class="fa-solid fa-xmark-circle"></i> Could not validate coupon. Please try again.');
                applyBtn.textContent = 'Apply';
                applyBtn.disabled = false;
            }
        }

        applyBtn.addEventListener('click', () => { if (input) applyCoupon(input.value); });
        input?.addEventListener('keydown', e => { if (e.key === 'Enter') applyCoupon(input.value); });
        hintPills.forEach(pill => {
            pill.addEventListener('click', () => { const code = pill.getAttribute('data-code'); if (input) input.value = code; applyCoupon(code); });
        });
    }
    /* ============================================================
   SECTION B3: PAYMENT METHOD TOGGLE  ← NEW (COD + UPI)
   ─────────────────────────────────────────────────────────
   Wires the two payment radio pills to:
     • Toggle the .selected CSS class on the pill labels
     • Show/hide #upiSection (UPI QR + UTR field)
     • Show/hide #codInfoPanel
     • Update #paymentNote text
     • Update the QR when switching to UPI
   ============================================================ */
    function initPaymentToggle() {
        const radioCOD = document.getElementById('paymentCOD');
        const radioUPI = document.getElementById('paymentUPI');
        const pillCOD = document.getElementById('pillCOD');
        const pillUPI = document.getElementById('pillUPI');
        const upiSection = document.getElementById('upiSection');
        const codPanel = document.getElementById('codInfoPanel');
        const noteEl = document.getElementById('paymentNote');

        // All four elements must exist — otherwise not on the cart page
        if (!radioCOD || !radioUPI) return;

        const COD_NOTE = '<i class="fa-solid fa-circle-info"></i> Pay cash to the delivery agent when your order arrives. No advance needed.';
        const UPI_NOTE = '<i class="fa-solid fa-circle-info"></i> Your order will be confirmed once we verify your UPI payment. Usually within 30 minutes.';

        function applySelection(method) {
            const isUPI = method === 'UPI';

            // Toggle pill .selected class
            pillCOD?.classList.toggle('selected', !isUPI);
            pillUPI?.classList.toggle('selected', isUPI);

            // Show/hide panels
            if (upiSection) upiSection.style.display = isUPI ? 'block' : 'none';
            if (codPanel) codPanel.style.display = isUPI ? 'none' : 'flex';

            // Update contextual note
            if (noteEl) noteEl.innerHTML = isUPI ? UPI_NOTE : COD_NOTE;

            // If switching to UPI, regenerate the QR with the current total
            if (isUPI) updateUpiQr(_currentTotal);
        }

        // Set initial state (COD is checked by default in HTML)
        applySelection(radioCOD.checked ? 'COD' : 'UPI');

        // Wire change events
        radioCOD.addEventListener('change', () => { if (radioCOD.checked) applySelection('COD'); });
        radioUPI.addEventListener('change', () => { if (radioUPI.checked) applySelection('UPI'); });
    }

    /* ============================================================
       SECTION B2: REAL PINCODE DELIVERY CHECK (API POWERED)
       ============================================================ */
    function initPincodeCheck() {
        const input = document.getElementById('pincodeInput');
        const btn = document.getElementById('pincodeCheckBtn');
        const feedback = document.getElementById('pincodeFeedback');
        if (!btn || !input || !feedback) return;

        // Tera Warehouse State (Yahan se sabse jaldi delivery hogi)
        const ORIGIN_STATE = "Haryana";

        async function checkPin(pin) {
            const trimmed = pin.trim();
            feedback.className = 'cart-pincode-feedback';

            // Basic Check: 6 digit number
            if (!/^\d{6}$/.test(trimmed)) {
                feedback.classList.add('error');
                feedback.innerHTML = '<i class="fa-solid fa-xmark-circle"></i> Please enter a valid 6-digit PIN code.';
                return;
            }

            // Loading state dikhao
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            feedback.innerHTML = '<span style="color:var(--text-muted);"><i class="fa-solid fa-truck-fast"></i> Verifying location...</span>';

            try {
                // Govt of India Postal API se real data fetch karo
                const res = await fetch(`https://api.postalpincode.in/pincode/${trimmed}`);
                const data = await res.json();

                // Agar pincode fake/galat hai
                if (data[0].Status === "Error" || !data[0].PostOffice) {
                    feedback.classList.add('error');
                    feedback.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> We could not find this PIN code. Check and try again.';
                    return;
                }

                // Asli Location nikaalo
                const location = data[0].PostOffice[0];
                const state = location.State;
                const district = location.District;

                // Smart Delivery Zones Logic (Days Calculate karo)
                let minDays, maxDays;

                if (state === ORIGIN_STATE || state === "Delhi" || state === "Punjab" || state === "Chandigarh" || state === "Uttar Pradesh") {
                    minDays = 1; maxDays = 3; // Local / Padosi States
                } else if (["Maharashtra", "Karnataka", "Tamil Nadu", "Gujarat", "West Bengal", "Telangana"].includes(state)) {
                    minDays = 4; maxDays = 6; // Metro States (Thoda door)
                } else if (["Jammu and Kashmir", "Assam", "Meghalaya", "Tripura", "Arunachal Pradesh", "Manipur", "Nagaland", "Mizoram", "Sikkim", "Andaman and Nicobar Islands", "Lakshadweep"].includes(state)) {
                    minDays = 7; maxDays = 10; // North East / Pahadi ilake
                } else {
                    minDays = 3; maxDays = 5; // Baaki poora India
                }

                // Success Message with Real City & State!
                feedback.classList.add('success');
                feedback.innerHTML = `
                    <i class="fa-solid fa-circle-check"></i>
                    <span>
                        Delivery to <strong>${district}, ${state}</strong> available.<br>
                        Expected in <strong>${minDays}–${maxDays} Business Days</strong>.
                    </span>
                `;

            } catch (error) {
                feedback.classList.add('error');
                feedback.innerHTML = '<i class="fa-solid fa-wifi"></i> Network error. Please try again.';
            } finally {
                // Button ko wapas normal kar do
                btn.disabled = false;
                btn.innerHTML = 'Check';
            }
        }

        btn.addEventListener('click', () => checkPin(input.value));
        input.addEventListener('keydown', e => { if (e.key === 'Enter') checkPin(input.value); });
    }

    /* ============================================================
       SECTION C: FORM VALIDATION
       ============================================================ */
    function validateForm() {
        const fields = [
            { id: 'customerName', errorId: 'errorName', test: v => v.trim().length >= 2, msg: 'Please enter your full name.' },
            { id: 'customerPhone', errorId: 'errorPhone', test: v => /^[+\d\s\-()]{7,15}$/.test(v.trim()), msg: 'Enter a valid phone number.' },
            { id: 'customerEmail', errorId: 'errorEmail', test: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), msg: 'Enter a valid email address.' },
            { id: 'customerAddress', errorId: 'errorAddress', test: v => v.trim().length >= 10, msg: 'Please enter your full shipping address.' }
        ];
        let valid = true;
        fields.forEach(({ id, errorId, test, msg }) => {
            const el = document.getElementById(id);
            const errorEl = document.getElementById(errorId);
            if (!el) return;
            const passes = test(el.value);
            el.classList.toggle('error', !passes);
            if (errorEl) errorEl.textContent = passes ? '' : msg;
            if (!passes) valid = false;
        });
        return valid;
    }

    function initFieldValidation() {
        const fieldMap = { customerName: 'errorName', customerPhone: 'errorPhone', customerEmail: 'errorEmail', customerAddress: 'errorAddress' };
        Object.entries(fieldMap).forEach(([fieldId, errorId]) => {
            document.getElementById(fieldId)?.addEventListener('input', function () {
                this.classList.remove('error');
                const errEl = document.getElementById(errorId);
                if (errEl) errEl.textContent = '';
            });
        });
    }

    /* ============================================================
       SECTION D: UPI QR CODE  ← NEW
       ============================================================ */

    /*
       updateUpiQr(total)
       ─────────────────
       Builds a UPI deep link and encodes it as a QR code via
       the free api.qrserver.com endpoint (no API key required,
       no CORS issues, returns a plain PNG).

       UPI deep-link format (NPCI spec):
         upi://pay?pa=VPA&pn=NAME&am=AMOUNT&cu=INR&tn=NOTE

         pa  = payee UPI VPA (merchant ID)
         pn  = payee name (shown in UPI apps)
         am  = amount in INR (no ₹ symbol, no commas)
         cu  = currency code
         tn  = transaction note (shown to customer)

       QR API endpoint:
         https://api.qrserver.com/v1/create-qr-code/
           ?size=180x180
           &data=<URL-encoded UPI deep link>
           &ecc=M           ← Medium error correction
           &margin=1        ← Tight margin for max QR density

       The image src is updated in-place on #upiQrImage so the
       browser re-fetches it. The loading spinner is shown during
       the fetch and hidden via the img.onload callback.

       Called:
         • Once on page load after first recalculateTotals()
         • Every time recalculateTotals() runs (qty/coupon change)
    */
    function updateUpiQr(total) {
        const qrImg = document.getElementById('upiQrImage');
        const qrLoading = document.getElementById('upiQrLoading');
        const amountEl = document.getElementById('upiAmountLabel');

        if (!qrImg) return;

        // Update the amount pill
        if (amountEl) amountEl.textContent = total.toLocaleString('en-IN');

        // Nothing to pay — hide QR section and bail
        if (total <= 0) {
            if (qrLoading) qrLoading.classList.remove('hidden');
            qrImg.classList.remove('loaded');
            qrImg.src = '';
            return;
        }

        // Show spinner while new QR loads
        qrImg.classList.remove('loaded');
        if (qrLoading) qrLoading.classList.remove('hidden');

        // Build the UPI deep link
        const upiLink = [
            'upi://pay',
            `?pa=${encodeURIComponent(MERCHANT_UPI_ID)}`,
            `&pn=${encodeURIComponent(MERCHANT_NAME)}`,
            `&am=${total.toFixed(2)}`,
            `&cu=INR`,
            `&tn=${encodeURIComponent('Aura & Earth Order')}`
        ].join('');

        // Build the QR API URL
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(upiLink)}&ecc=M&margin=1`;

        // Swap src — browser fetches the new QR image
        qrImg.src = qrUrl;

        qrImg.onload = () => {
            qrImg.classList.add('loaded');
            if (qrLoading) qrLoading.classList.add('hidden');
        };

        qrImg.onerror = () => {
            // Graceful fallback: hide spinner, show a placeholder message
            if (qrLoading) {
                qrLoading.innerHTML = '<span style="font-size:0.75rem;color:#999;padding:8px;text-align:center">QR unavailable.<br>Pay to UPI ID:<br><strong style="color:var(--accent)">' + MERCHANT_UPI_ID + '</strong></span>';
                qrLoading.classList.remove('hidden');
            }
        };
    }   // YE SAHI HAI

    /* ============================================================
       SECTION E: UTR VALIDATION  ← NEW
       ============================================================ */

    /*
       validateUtr()
       ─────────────
       UTR (Unique Transaction Reference) numbers are:
         • IMPS/UPI: 12 numeric digits
         • NEFT/RTGS: 16-22 alphanumeric characters
       We accept 8–22 alphanumeric characters to cover all formats
       while rejecting clearly blank or garbage input.

       Returns true if valid, false otherwise.
       Also sets/clears the #errorUtr element and .error class.
    */
    function validateUtr() {
        const input = document.getElementById('utrNumber');
        const errorEl = document.getElementById('errorUtr');
        if (!input) return true;   // field doesn't exist on this page — skip

        const val = input.value.trim();
        const valid = val.length >= 8 && val.length <= 22 && /^[A-Za-z0-9]+$/.test(val);

        input.classList.toggle('error', !valid);
        if (errorEl) {
            errorEl.textContent = valid
                ? ''
                : 'Please enter a valid UTR / Transaction ID (8–22 alphanumeric characters).';
        }
        return valid;
    }

    function initUtrFieldValidation() {
        document.getElementById('utrNumber')?.addEventListener('input', function () {
            this.classList.remove('error');
            const errEl = document.getElementById('errorUtr');
            if (errEl) errEl.textContent = '';
        });
    }

    /* ============================================================
       SECTION F: SUCCESS MODAL  ← NEW
       ============================================================ */

    /*
       showSuccessModal({ orderId, total, utrNumber })
       ────────────────────────────────────────────────
       Populates the three dynamic fields in #successDetailCard,
       then reveals the overlay with a two-frame opacity trick so
       the CSS transition fires even though display:none → flex
       prevents transitions on the first frame.

       The modal has no close button by design — the user must
       navigate to My Orders or back to the shop, which also
       prevents accidental dismissal before noting their order ID.
    */
    function showSuccessModal({ orderId, total, utrNumber, paymentMethod }) {
        const overlay = document.getElementById('orderSuccessOverlay');
        if (!overlay) return;

        const setEl = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };

        setEl('successOrderId', orderId);
        setEl('successAmount', `₹${total.toLocaleString('en-IN')}`);
        setEl('successPaymentMethod', paymentMethod === 'COD' ? 'Cash on Delivery' : 'UPI');

        // UTR row: show only for UPI orders
        // The UTR value element exists; we hide its parent .success-detail-row for COD
        const utrValueEl = document.getElementById('successUtr');
        if (utrValueEl) {
            const utrRow = utrValueEl.closest('.success-detail-row');
            if (utrRow) utrRow.style.display = paymentMethod === 'UPI' ? 'flex' : 'none';
            if (paymentMethod === 'UPI') utrValueEl.textContent = utrNumber;
        }

        // Update subtitle text for COD vs UPI
        const subtitle = overlay.querySelector('.success-subtitle');
        if (subtitle) {
            subtitle.innerHTML = paymentMethod === 'COD'
                ? 'Your sacred crystals are confirmed! ✦<br>Pay cash when your order is delivered.'
                : 'Your sacred crystals are on their way.<br>We\'ll verify your UPI payment shortly.';
        }

        overlay.setAttribute('aria-hidden', 'false');
        overlay.style.display = 'flex';
        void overlay.offsetWidth; // force reflow for CSS transition
        overlay.classList.add('visible');
        document.body.style.overflow = 'hidden';
    }

    /* ============================================================
       SECTION G: PLACE ORDER BUTTON  ← REWRITTEN
       ============================================================ */

    /*
       initPlaceOrderButton()
       ──────────────────────
       Flow:
         1. Guard: cart must not be empty.
         2. Validate shipping form (validateForm()).
         3. Validate UTR field (validateUtr()).
         4. Recalculate final totals (same logic as before).
         5. Build Firestore document — includes utrNumber field.
         6. Cache slim order in localStorage for My Orders page.
         7. Persist to Firestore (awaited, not fire-and-forget).
            If Firestore fails the user still sees the modal so
            they can screenshot their UTR — but we log the error.
         8. Clear the cart via persistCart().
         9. Show success modal.
    */
    /* ============================================================
   SECTION G: PLACE ORDER — COD + UPI Edition  ← REWRITTEN
   ============================================================ */
    /* ============================================================
        SECTION G0: MULTI-STEP CHECKOUT CONTROLLER
        ─────────────────────────────────────────────────────────
        Manages the Step 1 (Cart) ↔ Step 2 (Checkout) transition.
        No page reload. Existing placeOrderBtn + all form logic
        remain completely untouched.
        ============================================================ */
    function initStepController() {
        const step1 = document.getElementById('step1-cart');
        const step2 = document.getElementById('step2-checkout');
        const mainBtn = document.getElementById('mainCheckoutBtn');
        const backBtn = document.getElementById('backToCartBtn');
        const mobileBtn = document.getElementById('cartMobilePlaceOrderBtn');
        const progressStep1 = document.getElementById('progressStep1');
        const progressStep2 = document.getElementById('progressStep2');

        if (!step1 || !step2 || !mainBtn) return;

        /* ── Activate / deactivate progress bar steps ──────────── */
        function setProgressStep(stepNumber) {
            if (stepNumber === 1) {
                // Bag active, Checkout inactive
                progressStep1?.classList.add('active');
                progressStep2?.classList.remove('active');
                // Step 1 icon not clickable when we're already on step 1
                if (progressStep1) progressStep1.style.cursor = 'default';
            } else {
                // Both active; Bag becomes clickable to go back
                progressStep1?.classList.add('active');
                progressStep2?.classList.add('active');
                if (progressStep1) progressStep1.style.cursor = 'pointer';
            }
        }

        /* ── Go to Step 2 ──────────────────────────────────────── */
        function goToCheckout() {
            if (cartItems.length === 0) {
                showToast('Your bag is empty! Add some crystals first. 🛍️', 'info');
                return;
            }

            step1.style.display = 'none';
            step2.style.display = 'block';
            step2.classList.remove('step-fade-in');
            void step2.offsetWidth;
            step2.classList.add('step-fade-in');

            mainBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Place Order';
            mainBtn.classList.add('is-place-order');
            mainBtn.removeEventListener('click', goToCheckout);
            mainBtn.addEventListener('click', firePlaceOrder);

            if (mobileBtn) {
                mobileBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Place Order';
            }

            setProgressStep(2);

            step2.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        /* ── Go back to Step 1 ─────────────────────────────────── */
        function goToCart() {
            step2.style.display = 'none';
            step1.style.display = 'block';
            step1.classList.remove('step-fade-in');
            void step1.offsetWidth;
            step1.classList.add('step-fade-in');

            mainBtn.innerHTML = '<i class="fa-solid fa-arrow-right"></i> Proceed to Checkout';
            mainBtn.classList.remove('is-place-order');
            mainBtn.removeEventListener('click', firePlaceOrder);
            mainBtn.addEventListener('click', goToCheckout);

            if (mobileBtn) {
                mobileBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Confirm Order';
            }

            setProgressStep(1);

            step1.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        /* ── Proxy to the existing placeOrderBtn ───────────────── */
        function firePlaceOrder() {
            document.getElementById('placeOrderBtn')?.click();
        }

        // Set initial state
        setProgressStep(1);

        // Wire buttons
        mainBtn.addEventListener('click', goToCheckout);
        backBtn?.addEventListener('click', goToCart);

        // Step 1 progress icon: clicking it from step 2 goes back
        progressStep1?.addEventListener('click', () => {
            // Only act if we're currently on step 2
            if (step2.style.display !== 'none') {
                goToCart();
            }
        });

        // Mobile sticky bar always proxies to mainCheckoutBtn
        if (mobileBtn) {
            mobileBtn._stepDelegate = () => mainBtn.click();
        }
    }
    function initPlaceOrderButton() {
        const btn = document.getElementById('placeOrderBtn');
        if (!btn) return;

        btn.addEventListener('click', async () => {

            /* ── Guard: empty cart ─────────────────────────── */
            if (cartItems.length === 0) {
                showToast('Your bag is empty! Add some crystals first.', 'info');
                return;
            }

            /* ── Detect selected payment method ────────────── */
            const isUPI = document.getElementById('paymentUPI')?.checked ?? false;
            const paymentMethod = isUPI ? 'UPI' : 'COD';

            /* ── Validate shipping form ────────────────────── */
            if (!validateForm()) {
                document.querySelector('.checkout-input.error')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                showToast('Please fill in all required fields.', 'info');
                return;
            }

            /* ── Validate UTR — only required for UPI ──────── */
            if (isUPI && !validateUtr()) {
                document.getElementById('utrNumber')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                showToast('Please enter your UPI Transaction ID (UTR).', 'info');
                return;
            }

            /* ── Collect form values ───────────────────────── */
            const customerName = document.getElementById('customerName')?.value.trim() || '';
            const customerPhone = document.getElementById('customerPhone')?.value.trim() || '';
            const customerEmail = document.getElementById('customerEmail')?.value.trim() || '';
            const customerAddress = document.getElementById('customerAddress')?.value.trim() || '';
            const orderNotes = document.getElementById('orderNotes')?.value.trim() || '';
            const utrNumber = isUPI
                ? (document.getElementById('utrNumber')?.value.trim() || '')
                : '';

            /* ── Recalculate totals ────────────────────────── */
            const effectivePriceOf = i =>
                (i.salePrice != null && typeof i.salePrice === 'number' && i.salePrice < i.price)
                    ? i.salePrice : (i.price || 0);
            const subtotal = cartItems.reduce((sum, i) => {
                if (i.isStackBundle) return sum + (i.bundlePrice || 0);
                return sum + effectivePriceOf(i) * (i.qty || 1);
            }, 0);
            let discount = 0, freeShipping = false;
            if (appliedCoupon) {
                if (appliedCoupon.type === 'percent') discount = Math.round(subtotal * appliedCoupon.value / 100);
                if (appliedCoupon.type === 'freeship') freeShipping = true;
            }
            const afterDiscount = subtotal - discount;
            const shipping = (freeShipping || afterDiscount >= SHIPPING_THRESHOLD) ? 0 : SHIPPING_COST;
            const total = afterDiscount + shipping;
            const orderId = 'ORD-' + Date.now();

            /*
               Status logic:
               • UPI  → 'Payment Verification Pending' (admin must verify UTR)
               • COD  → 'Pending' (order is confirmed, awaiting delivery)
            */
            const orderStatus = isUPI ? 'Payment Verification Pending' : 'Pending';

            /* ── Build Firestore document ──────────────────── */
            const firestoreOrder = {
                orderId,
                createdAt: Date.now(),
                status: orderStatus,
                paymentMethod,                        // 'COD' or 'UPI'
                utrNumber,                            // '' for COD, filled for UPI
                merchantUpiId: isUPI ? MERCHANT_UPI_ID : '',
                customerName,
                customerPhone,
                customerEmail: customerEmail.toLowerCase().trim(),
                customerAddress,
                notes: orderNotes,
                items: cartItems.map(item => {
                    // Bundle entries are serialized with their display name, combined
                    // price, and sub-item list so the order card can render them correctly.
                    if (item.isStackBundle) {
                        return {
                            id: item.id,
                            isStackBundle: true,
                            name: 'Custom Crystal Stack',
                            image: item.subItems?.[0]?.image || '',
                            price: item.bundlePrice,
                            salePrice: null,
                            effectivePrice: item.bundlePrice,
                            qty: 1,
                            size: item.size,
                            charm: item.charm,
                            subItemNames: (item.subItems || []).map(p => p.name)
                        };
                    }
                    const ep = (item.salePrice != null && typeof item.salePrice === 'number' && item.salePrice < item.price)
                        ? item.salePrice : (item.price || 0);
                    return { id: item.id, name: item.name, image: item.image, price: item.price, salePrice: item.salePrice ?? null, effectivePrice: ep, qty: item.qty, size: item.size, charm: item.charm };
                }),
                subtotal,
                discount,
                shipping,
                total,
                coupon: appliedCoupon ? appliedCoupon.label : null
            };

            /* ── Cache slim copy in localStorage ──────────── */
            const localOrder = {
                id: orderId,
                customerEmail: customerEmail ? customerEmail.toLowerCase().trim() : null,
                date: Date.now(),
                status: orderStatus,
                paymentMethod,
                utrNumber,
                total,
                subtotal,
                discount,
                shipping,
                coupon: appliedCoupon ? appliedCoupon.label : null,
                itemCount: cartItems.reduce((sum, i) => sum + (i.qty || 1), 0),
                items: cartItems.map(item => {
                    if (item.isStackBundle) {
                        return {
                            id: item.id,
                            isStackBundle: true,
                            name: 'Custom Crystal Stack',
                            image: item.subItems?.[0]?.image || '',
                            price: item.bundlePrice,
                            salePrice: null,
                            qty: 1,
                            size: item.size,
                            charm: item.charm,
                            subItemNames: (item.subItems || []).map(p => p.name)
                        };
                    }
                    return { id: item.id, name: item.name, image: item.image, price: item.price, salePrice: item.salePrice ?? null, qty: item.qty, size: item.size, charm: item.charm };
                })
            };

            let localOrders = [];
            try { localOrders = JSON.parse(localStorage.getItem('orders')) || []; } catch { localOrders = []; }
            localOrders.unshift(localOrder);
            if (localOrders.length > 10) localOrders = localOrders.slice(0, 10);
            localStorage.setItem('orders', JSON.stringify(localOrders));
            if (customerEmail) localStorage.setItem('customerEmail', customerEmail.toLowerCase().trim());

            /* ── Loading state ─────────────────────────────── */
            const origHTML = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Placing Order…';
            btn.disabled = true;

            /* ── Write to Firestore ────────────────────────── */
            try {
                const [{ db }, { collection, addDoc }] = await Promise.all([
                    import('./firebase.js'),
                    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
                ]);
                await addDoc(collection(db, 'orders'), firestoreOrder);
            } catch (err) {
                console.error('[Aura & Earth] Firestore order write failed. Order data preserved in localStorage.', err);
                showToast('Order saved locally — please screenshot your Order ID.', 'info');
            }

            /* ── Clear cart ────────────────────────────────── */
            cartItems = [];
            persistCart();
            renderCartItems();

            /* ── Reveal success modal ──────────────────────── */
            showSuccessModal({ orderId, total, utrNumber, paymentMethod });

            btn.innerHTML = origHTML;
            btn.disabled = false;
        });
    }

    /* ============================================================
       SECTION H: DOMContentLoaded INIT
       ============================================================ */
    document.addEventListener('DOMContentLoaded', async () => {
        if (!document.querySelector('.cart-main')) return;

        await initProductData();
        await loadCartSettings();

        resolveCartItems();
        renderCartItems();

        // Register the re-render hook so the BroadcastChannel
        // listener in Section 5 can trigger a live refresh when
        // another tab (e.g. homepage Stack Builder) updates the cart.
        window._cartPageRerender = () => {
            resolveCartItems();
            renderCartItems();
        };
        initCoupon();
        initPaymentToggle();
        initPincodeCheck();
        initFieldValidation();
        initUtrFieldValidation();     // ← NEW
        initPlaceOrderButton();

        // Initialise the step controller BEFORE the sticky bar wiring
        initStepController();

        /* Mobile sticky bar — delegates to #mainCheckoutBtn (step-aware) */
        const mobilePlaceBtn = document.getElementById('cartMobilePlaceOrderBtn');
        if (mobilePlaceBtn) {
            mobilePlaceBtn.addEventListener('click', () => {
                // Always proxy through mainCheckoutBtn so step logic fires correctly
                document.getElementById('mainCheckoutBtn')?.click();
            });
        }

        /* Show mobile sticky bar when #mainCheckoutBtn scrolls out of view */
        const mainCheckoutBtn = document.getElementById('mainCheckoutBtn');
        const mobileBar = document.getElementById('cartMobileStickyBar');
        if (mainCheckoutBtn && mobileBar) {
            const observer = new IntersectionObserver(entries => {
                mobileBar.classList.toggle('visible', !entries[0].isIntersecting);
            }, { threshold: 0 });
            observer.observe(mainCheckoutBtn);
        }
    });

})(); // CART-CHECKOUT IIFE


/* ============================================================
   WISHLIST IIFE
   ============================================================ */
(function () {
    'use strict';

    function addProductToCart(product) {
        if (isInCart(product.id)) return false;
        const items = getCartItems();
        items.push({ id: product.id, size: 'Medium (17cm)', charm: 'None', qty: 1 });
        saveCartItems(items);
        return true;
    }

    function removeFromWishlistById(id) {
        saveWishlistIds(getWishlistIds().filter(i => i !== id));
    }

    function resolveWishlistProducts() {
        return [...new Set(getWishlistIds())].map(id => productMap.get(id)).filter(Boolean);
    }

    function createWishlistCard(product, index) {
        const inCart = isInCart(product.id);
        const soldOut = typeof product.stock === 'number' && product.stock === 0;
        const onSale = product.salePrice != null &&
            typeof product.salePrice === 'number' &&
            product.salePrice < (product.price || 0);
        const effectivePrice = onSale ? product.salePrice : (product.price || 0);

        const categoryLabel = product.category
            ? product.category.charAt(0).toUpperCase() + product.category.slice(1)
            : 'Crystal';

        // Price HTML — shows crossed-out original + sale price when on sale
        const priceHTML = onSale
            ? `<div class="wishlist-card-price-wrap">
                   <span class="wishlist-price-orig">₹${product.price.toLocaleString('en-IN')}</span>
                   <span class="wishlist-price-sale">₹${effectivePrice.toLocaleString('en-IN')}</span>
                   <span class="wishlist-sale-badge">SALE</span>
               </div>`
            : `<div class="wishlist-card-price">₹${effectivePrice.toLocaleString('en-IN')}</div>`;

        // Add to Bag button state
        const addBtnDisabled = inCart || soldOut;
        const addBtnLabel = soldOut ? 'Sold Out'
            : inCart ? '<i class="fa-solid fa-check"></i> In Bag ✓'
                : 'Add to Bag';

        const card = document.createElement('div');
        card.className = 'wishlist-card';
        card.setAttribute('data-product-id', product.id);
        card.style.setProperty('--card-delay', `${index * 80}ms`);

        card.innerHTML = `
            <div class="wishlist-card-img-wrap">
                <img class="wishlist-card-img"
                     src="${product.image || ''}"
                     alt="${product.name}"
                     loading="lazy">
                <span class="wishlist-card-badge">${categoryLabel}</span>
                ${onSale ? '<span class="wishlist-img-sale-dot">SALE</span>' : ''}
                ${soldOut ? '<span class="wishlist-img-soldout-dot">Sold Out</span>' : ''}
                <button class="wishlist-card-remove"
                        aria-label="Remove ${product.name} from wishlist"
                        data-remove-id="${product.id}">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <div class="wishlist-card-overlay">
                    <button class="wishlist-card-quick-add"
                            aria-label="Quick add ${product.name} to bag"
                            data-add-id="${product.id}"
                            ${addBtnDisabled ? 'disabled' : ''}>
                        <i class="fa-solid fa-bag-shopping"></i>
                        ${soldOut ? 'Sold Out' : inCart ? 'Already in Bag' : 'Quick Add'}
                    </button>
                </div>
            </div>
            <div class="wishlist-card-body">
                <div class="wishlist-card-name">${product.name}</div>
                ${priceHTML}
            </div>
            <div class="wishlist-card-actions">
                <a href="product-detail.html?id=${product.id}"
                   class="wishlist-card-view-btn">View Details</a>
                <button class="wishlist-card-add-btn"
                        data-add-id="${product.id}"
                        ${addBtnDisabled ? 'disabled' : ''}>
                    ${addBtnLabel}
                </button>
                <button class="wishlist-card-remove-btn"
                        aria-label="Remove ${product.name} from wishlist"
                        data-remove-id="${product.id}">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>`;
        return card;
    }

    function renderWishlist() {
        const grid = document.getElementById('wishlistGrid');
        const emptyState = document.getElementById('wishlistEmpty');
        const actionsBar = document.getElementById('wishlistActionsBar');
        const actionsLabel = document.getElementById('wishlistActionsLabel');
        const countEl = document.getElementById('wishlistCount');
        const countBubble = document.getElementById('wishlistCountBubble');
        if (!grid) return;

        const wishlistProducts = resolveWishlistProducts();
        const count = wishlistProducts.length;

        // Update all count displays
        if (countEl) countEl.textContent = count;
        if (countBubble) countBubble.querySelector('span')?.textContent !== undefined
            && (countBubble.querySelector('span').textContent = count);

        if (count === 0) {
            emptyState?.classList.add('visible');
            actionsBar?.classList.remove('visible');
            grid.innerHTML = '';
            return;
        }

        emptyState?.classList.remove('visible');
        actionsBar?.classList.add('visible');
        if (actionsLabel) actionsLabel.textContent = `${count} item${count !== 1 ? 's' : ''} saved`;

        // Rebuild cards — event delegation is wired once in initActionsBar,
        // not here, so re-renders never stack duplicate listeners.
        grid.innerHTML = '';
        wishlistProducts.forEach((product, i) => grid.appendChild(createWishlistCard(product, i)));
    }

    function handleRemove(productId) {
        removeFromWishlistById(productId);
        const card = document.querySelector(`.wishlist-card[data-product-id="${productId}"]`);
        if (card) { card.style.transition = 'opacity 0.3s ease, transform 0.3s ease'; card.style.opacity = '0'; card.style.transform = 'scale(0.92)'; setTimeout(renderWishlist, 320); }
        else renderWishlist();
        showToast('Removed from Wishlist 💔');
    }

    function handleAddToBag(productId) {
        const product = productMap.get(productId);
        if (!product) return;
        const added = addProductToCart(product);
        showToast(added ? `${product.name} added to Bag! 🛍️` : 'Already in your Bag!', added ? 'success' : 'info');
        document.querySelectorAll(`[data-add-id="${productId}"]`).forEach(btn => {
            btn.disabled = true;
            btn.classList.contains('wishlist-card-add-btn') ? btn.innerHTML = '<i class="fa-solid fa-check"></i> In Bag ✓' : btn.textContent = 'Already in Bag';
        });
    }

    function initActionsBar() {
        const grid = document.getElementById('wishlistGrid');

        // ── Single delegation listener on the grid — wired ONCE here,
        // never inside renderWishlist(), so re-renders never stack duplicates.
        if (grid) {
            grid.addEventListener('click', e => {
                const removeBtn = e.target.closest('[data-remove-id]');
                const addBtn = e.target.closest('[data-add-id]');
                if (removeBtn) {
                    // data-remove-id may be a number or Firestore string ID —
                    // resolve the same way productMap was built
                    const raw = removeBtn.getAttribute('data-remove-id');
                    const id = isNaN(parseInt(raw, 10)) ? raw : parseInt(raw, 10);
                    handleRemove(id);
                } else if (addBtn && !addBtn.disabled) {
                    const raw = addBtn.getAttribute('data-add-id');
                    const id = isNaN(parseInt(raw, 10)) ? raw : parseInt(raw, 10);
                    handleAddToBag(id);
                }
            });
        }

        document.getElementById('wishlistAddAllBtn')?.addEventListener('click', () => {
            const wishlistProducts = resolveWishlistProducts();
            let addedCount = 0;
            wishlistProducts.forEach(product => { if (addProductToCart(product)) addedCount++; });
            showToast(
                addedCount > 0
                    ? `${addedCount} item${addedCount > 1 ? 's' : ''} added to Bag! 🛍️`
                    : 'All items already in your Bag!',
                addedCount > 0 ? 'success' : 'info'
            );
            // Reflect in-cart state on all visible add buttons
            document.querySelectorAll('.wishlist-card-add-btn, .wishlist-card-quick-add').forEach(btn => {
                const raw = btn.getAttribute('data-add-id');
                const id = isNaN(parseInt(raw, 10)) ? raw : parseInt(raw, 10);
                if (isInCart(id)) {
                    btn.disabled = true;
                    btn.classList.contains('wishlist-card-add-btn')
                        ? btn.innerHTML = '<i class="fa-solid fa-check"></i> In Bag ✓'
                        : btn.textContent = 'Already in Bag';
                }
            });
        });

        document.getElementById('wishlistClearBtn')?.addEventListener('click', () => {
            const cards = document.querySelectorAll('.wishlist-card');
            cards.forEach((card, i) => {
                card.style.transition = `opacity 0.3s ease ${i * 50}ms, transform 0.3s ease ${i * 50}ms`;
                card.style.opacity = '0';
                card.style.transform = 'scale(0.92)';
            });
            setTimeout(() => {
                saveWishlistIds([]);
                renderWishlist();
                showToast('Wishlist cleared');
            }, cards.length * 50 + 320);
        });
    }

    document.addEventListener('DOMContentLoaded', async () => {
        if (!document.getElementById('wishlistGrid')) return;
        await initProductData();
        renderWishlist();
        initActionsBar();

        // Register the re-render hook — mirrors the cart page pattern.
        // Called by the BroadcastChannel listener (Section 5) when
        // another tab updates the wishlist so this tab stays in sync.
        window._wishlistPageRerender = () => {
            renderWishlist();
        };
    });

})(); // WISHLIST IIFE


/* ============================================================
   ORDERS IIFE
   ============================================================ */
(function () {
    'use strict';

    function getLocalOrders() {
        try {
            const raw = JSON.parse(localStorage.getItem('orders')) || [];
            return raw.map(o => ({
                id: o.id || o.orderId || null,
                customerEmail: (o.customerEmail || '').toLowerCase() || null,
                date: o.date || o.createdAt || Date.now(),
                status: o.status || 'Pending',
                total: o.total || 0,
                subtotal: o.subtotal || 0,
                discount: o.discount || 0,
                shipping: o.shipping || 0,
                coupon: o.coupon || null,
                itemCount: o.itemCount != null
                    ? o.itemCount
                    : (Array.isArray(o.items) ? o.items.reduce((sum, i) => sum + (i.qty || 1), 0) : 0)
            }));
        } catch { return []; }
    }

    function formatDate(dateVal) {
        if (!dateVal) return '—';
        const d = typeof dateVal === 'number' ? new Date(dateVal) : new Date(dateVal);
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function normaliseOrder(data, docId) {
        return {
            ...data,
            id: data.orderId || data.id || docId,
            date: data.createdAt || data.date || Date.now(),
            status: data.status || 'Pending',
            items: Array.isArray(data.items) ? data.items : [],
            total: data.total || 0,
            subtotal: data.subtotal || 0,
            discount: data.discount || 0,
            shipping: data.shipping || 0,
            coupon: data.coupon || null,
            _docId: docId
        };
    }

    // ── fetchOrdersFromFirestore ──────────────────────────────
    // Queries the `orders` Firestore collection for all documents
    // where customerEmail matches. Falls back to localStorage if
    // Firestore is unreachable. Returns orders newest-first.
    async function fetchOrdersFromFirestore(email) {
        try {
            const [{ db }, { collection, getDocs, query, where, orderBy }] = await Promise.all([
                import('./firebase.js'),
                import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
            ]);
            const snap = await getDocs(
                query(
                    collection(db, 'orders'),
                    where('customerEmail', '==', email),
                    orderBy('createdAt', 'desc')
                )
            );
            if (!snap.empty) {
                return snap.docs.map(d => normaliseOrder(d.data(), d.id));
            }
        } catch (err) {
            console.warn('[Aura & Earth] Firestore orders query failed, falling back to localStorage:', err.message);
        }
        // Firestore failed or returned nothing — use localStorage cache
        return getLocalOrders()
            .filter(o => (o.customerEmail || '').toLowerCase() === email)
            .sort((a, b) => (b.date || 0) - (a.date || 0));
    }

    function statusClass(status) { const map = { 'Pending': 'status-processing', 'Payment Verification Pending': 'status-processing', 'Processing': 'status-processing', 'Shipped': 'status-shipped', 'Delivered': 'status-delivered', 'Cancelled': 'status-cancelled' }; return map[status] || 'status-processing'; }
    function statusIcon(status) { const map = { 'Pending': 'fa-clock', 'Payment Verification Pending': 'fa-clock', 'Processing': 'fa-clock', 'Shipped': 'fa-truck', 'Delivered': 'fa-circle-check', 'Cancelled': 'fa-circle-xmark' }; return map[status] || 'fa-clock'; }
    function buildOrderCard(order, index) {
        const card = document.createElement('div');
        card.className = 'order-card';
        card.style.animationDelay = `${index * 80}ms`;

        const itemsHTML = order.items.map(item => {
            if (item.isStackBundle) {
                const subNames = Array.isArray(item.subItemNames) && item.subItemNames.length
                    ? item.subItemNames.join(', ')
                    : 'Custom Stack';
                return `
                    <div class="order-item-thumb">
                        <img class="order-item-img" src="${item.image || ''}" alt="Custom Crystal Stack" loading="lazy">
                        <div class="order-item-info">
                            <div class="order-item-name">
                                <i class="fa-solid fa-layer-group" style="color:var(--accent,#7a5c85);margin-right:5px;font-size:0.8em;"></i>
                                Custom Crystal Stack
                            </div>
                            <div class="order-item-meta">${subNames}</div>
                            <div class="order-item-meta">Size: ${item.size} &nbsp;·&nbsp; Charm: ${item.charm}</div>
                            <div class="order-item-price">₹${(item.price || 0).toLocaleString('en-IN')}</div>
                        </div>
                    </div>`;
            }
            return `
                <div class="order-item-thumb">
                    <img class="order-item-img" src="${item.image || ''}" alt="${item.name}" loading="lazy">
                    <div class="order-item-info">
                        <div class="order-item-name">${item.name}</div>
                        <div class="order-item-meta">Size: ${item.size} &nbsp;·&nbsp; Charm: ${item.charm} &nbsp;·&nbsp; Qty: ${item.qty}</div>
                        <div class="order-item-price">₹${((item.effectivePrice || item.price || 0) * item.qty).toLocaleString('en-IN')}</div>
                    </div>
                </div>`;
        }).join('');

        const couponChip = order.coupon ? `<span class="order-summary-chip">Coupon: <strong>${order.coupon}</strong></span>` : '';
        const discountChip = order.discount > 0 ? `<span class="order-summary-chip">Saved: <strong>₹${order.discount.toLocaleString()}</strong></span>` : '';
        const shippingChip = `<span class="order-summary-chip">Shipping: <strong>${order.shipping === 0 ? 'FREE' : '₹' + order.shipping}</strong></span>`;

        card.innerHTML = `
            <div class="order-card-header">
                <div class="order-card-id-group"><span class="order-card-id">${order.id}</span><span class="order-card-date">${formatDate(order.date)}</span></div>
                <div class="order-card-meta"><span class="order-status-pill ${statusClass(order.status)}"><i class="fa-solid ${statusIcon(order.status)}"></i> ${order.status}</span><span class="order-card-total">₹${order.total.toLocaleString()}</span></div>
            </div>
            <div class="order-card-body"><div class="order-items-row">${itemsHTML}</div></div>
            <div class="order-card-footer">
                <div class="order-summary-chips"><span class="order-summary-chip">Items: <strong>${order.items.reduce((s, i) => s + i.qty, 0)}</strong></span>${couponChip}${discountChip}${shippingChip}</div>
                <button class="order-reorder-btn" data-order-id="${order.id}"><i class="fa-solid fa-rotate-right"></i> Reorder</button>
            </div>`;

        card.querySelector('.order-reorder-btn').addEventListener('click', () => {
            const currentCart = getCartItems();
            let addedCount = 0;
            order.items.forEach(item => {
                if (!currentCart.some(c => c.id === item.id)) {
                    currentCart.push({ id: item.id, qty: item.qty, size: item.size, charm: item.charm });
                    addedCount++;
                }
            });
            saveCartItems(currentCart);
            showToast(addedCount > 0 ? `${addedCount} item${addedCount > 1 ? 's' : ''} added to Bag! 🛍️` : 'All items already in your Bag!', addedCount > 0 ? 'success' : 'info');
        });
        return card;
    }

    function showEmailPrompt(onSubmit) {
        const list = document.getElementById('ordersList');
        if (!list) return;
        list.innerHTML = `
            <div class="orders-email-prompt" id="ordersEmailPrompt">
                <div class="oep-icon"><i class="fa-solid fa-envelope-open-text"></i></div>
                <h3 class="oep-title">Find Your Orders</h3>
                <p class="oep-desc">Enter the email address you used at checkout to view your order history.</p>
                <div class="oep-form">
                    <input type="email" id="oepEmailInput" class="oep-input"
                           placeholder="your@email.com" autocomplete="email" spellcheck="false">
                    <button id="oepSubmitBtn" class="oep-btn">
                        <i class="fa-solid fa-magnifying-glass"></i> Look Up Orders
                    </button>
                </div>
                <p class="oep-hint" id="oepHint"></p>
            </div>`;

        const input = document.getElementById('oepEmailInput');
        const btn = document.getElementById('oepSubmitBtn');
        const hint = document.getElementById('oepHint');

        const handleSubmit = async () => {
            const val = input.value.trim().toLowerCase();
            if (!val || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
                hint.textContent = 'Please enter a valid email address.';
                hint.style.color = '#e74c3c';
                input.focus();
                return;
            }
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching…';
            hint.textContent = '';
            localStorage.setItem('customerEmail', val);
            await onSubmit(val);
        };

        btn.addEventListener('click', handleSubmit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
        input.focus();
    }

    async function renderOrders(emailOverride) {
        const list = document.getElementById('ordersList');
        const emptyState = document.getElementById('ordersEmpty');
        const countEl = document.getElementById('ordersCount');
        if (!list) return;

        const savedEmail = (emailOverride || localStorage.getItem('customerEmail') || '').trim().toLowerCase();

        if (!savedEmail) {
            emptyState?.classList.remove('visible');
            if (countEl) countEl.textContent = '0';
            showEmailPrompt(async (email) => { await renderOrders(email); });
            return;
        }

        // Show loading skeletons while Firestore fetches
        list.innerHTML = `
            <div class="order-skeleton"></div>
            <div class="order-skeleton"></div>
            <div class="order-skeleton"></div>`;

        // Query Firestore first, fall back to localStorage if offline
        const orders = await fetchOrdersFromFirestore(savedEmail);
        if (countEl) countEl.textContent = orders.length;

        if (orders.length === 0) {
            emptyState?.classList.add('visible');
            list.innerHTML = `
                <div class="orders-wrong-email" id="ordersWrongEmail">
                    <p class="owe-text">No orders found for <strong>${savedEmail}</strong>.</p>
                    <button class="owe-change-btn" id="oweTryAgainBtn">
                        <i class="fa-solid fa-rotate-left"></i> Try a different email
                    </button>
                </div>`;
            document.getElementById('oweTryAgainBtn')?.addEventListener('click', () => {
                localStorage.removeItem('customerEmail');
                emptyState?.classList.remove('visible');
                renderOrders();
            });
            return;
        }

        emptyState?.classList.remove('visible');
        list.innerHTML = '';
        orders.forEach((order, i) => list.appendChild(buildOrderCard(order, i)));

        const switchEl = document.createElement('div');
        switchEl.className = 'orders-switch-account';
        switchEl.innerHTML = `
            <span class="osa-email">
                <i class="fa-solid fa-circle-user"></i>
                Showing orders for <strong>${savedEmail}</strong>
            </span>
            <button class="osa-switch-btn" id="osaSwitchBtn">Switch email</button>`;
        list.appendChild(switchEl);
        document.getElementById('osaSwitchBtn')?.addEventListener('click', () => {
            localStorage.removeItem('customerEmail');
            renderOrders();
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!document.getElementById('ordersList')) return;
        renderOrders();
    });

})(); // ORDERS IIFE


/* ============================================================
   CONTACT IIFE
   ============================================================ */
(function () {
    'use strict';

    function validateContactForm(name, phone, subject, message) {
        const errors = {};
        if (!name || name.trim().length < 2) errors.name = 'Please enter your full name.';
        if (!phone || !/^[+\d\s\-()]{7,15}$/.test(phone.trim())) errors.phone = 'Enter a valid WhatsApp number.';
        if (!subject) errors.subject = 'Please select a subject.';
        if (!message || message.trim().length < 10) errors.message = 'Please enter a message (min 10 characters).';
        return errors;
    }

    function setFieldError(inputEl, errorId, message) {
        const errEl = document.getElementById(errorId);
        if (inputEl) inputEl.classList.toggle('error', !!message);
        if (errEl) errEl.textContent = message || '';
    }

    function clearErrors() {
        ['contactName', 'contactPhone', 'contactSubject', 'contactMessage'].forEach(id => document.getElementById(id)?.classList.remove('error'));
        ['errorContactName', 'errorContactPhone', 'errorContactSubject', 'errorContactMessage'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });
    }

    function buildContactMessage(name, phone, subject, message) {
        return ['🌿 *Aura & Earth — Contact Request* 🌿', '', `👤 *Name:* ${name}`, `📱 *WhatsApp:* ${phone}`, `📌 *Subject:* ${subject}`, '', '💬 *Message:*', message, '', '✨ Looking forward to hearing from you!'].join('%0A');
    }

    function initContactForm() {
        const form = document.getElementById('contactForm');
        if (!form) return;
        const fieldErrorMap = { contactName: 'errorContactName', contactPhone: 'errorContactPhone', contactSubject: 'errorContactSubject', contactMessage: 'errorContactMessage' };
        Object.keys(fieldErrorMap).forEach(id => {
            document.getElementById(id)?.addEventListener('input', function () { this.classList.remove('error'); const errEl = document.getElementById(fieldErrorMap[id]); if (errEl) errEl.textContent = ''; });
        });
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const name = document.getElementById('contactName')?.value.trim() || '';
            const phone = document.getElementById('contactPhone')?.value.trim() || '';
            const subject = document.getElementById('contactSubject')?.value || '';
            const message = document.getElementById('contactMessage')?.value.trim() || '';
            clearErrors();

            const errors = validateContactForm(name, phone, subject, message);
            if (Object.keys(errors).length > 0) {
                setFieldError(document.getElementById('contactName'), 'errorContactName', errors.name);
                setFieldError(document.getElementById('contactPhone'), 'errorContactPhone', errors.phone);
                setFieldError(document.getElementById('contactSubject'), 'errorContactSubject', errors.subject);
                setFieldError(document.getElementById('contactMessage'), 'errorContactMessage', errors.message);
                form.querySelector('.contact-input.error')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                showToast('Please fill in all required fields.', 'info');
                return;
            }

            const btn = document.getElementById('contactSubmitBtn');
            const origHTML = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…'; }

            // ── 1. Save to Firestore `messages` collection ────
            try {
                const [{ db }, { collection, addDoc }] = await Promise.all([
                    import('./firebase.js'),
                    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
                ]);
                await addDoc(collection(db, 'messages'), {
                    name,
                    phone,
                    subject,
                    message,
                    createdAt: Date.now(),
                    read: false
                });
            } catch (err) {
                // Non-fatal — WhatsApp still opens below
                console.warn('[Aura & Earth] Firestore message save failed:', err.message);
            }

            // ── 2. Open WhatsApp ──────────────────────────────
            window.open(
                `https://wa.me/${WHATSAPP_NUMBER}?text=${buildContactMessage(name, phone, subject, message)}`,
                '_blank'
            );

            form.reset();
            showToast("Message sent! We'll be in touch soon 💜", 'success');
            if (btn) {
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Message Sent!';
                setTimeout(() => { btn.innerHTML = origHTML; btn.disabled = false; }, 3500);
            }
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!document.getElementById('contactForm')) return;
        initContactForm();
    });

})(); // CONTACT IIFE


/* ============================================================
   LUXURY UX/UI POLISH — Scroll Reveal + Page Transitions
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) { entry.target.classList.add('visible'); observer.unobserve(entry.target); }
        });
    }, { threshold: 0.12 });

    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

    document.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('http') && !href.startsWith('mailto') && !href.startsWith('tel') && link.target !== '_blank') {
            link.addEventListener('click', function (e) {
                e.preventDefault();
                document.body.classList.add('page-leaving');
                setTimeout(() => { window.location.href = href; }, 260);
            });
        }
    });
});


/* ============================================================
   DRAWER IIFE — Advanced Filter Panel
   ─────────────────────────────────────────────────────────
   Reads window.productMap, window.updateShopView, and
   window.buildProductCardHTML (all assigned in sections
   above). Patches updateShopView to layer drawer filter
   logic on top of the base category/search filter.
   ============================================================ */
(function () {
    'use strict';

    window.DRAWER_FILTERS = {
        intents: [],
        stones: [],
        priceMin: 0,
        priceMax: 5000
    };

    let drawer, overlay, openBtn, closeBtn, applyBtn, clearBtn;
    let priceMinEl, priceMaxEl, priceMinLabel, priceMaxLabel;
    let summaryBox, summaryText, matchCountEl;

    function openDrawer() {
        drawer.classList.add('open');
        overlay.classList.add('open');
        drawer.setAttribute('aria-hidden', 'false');
        overlay.setAttribute('aria-hidden', 'false');
        openBtn.setAttribute('aria-expanded', 'true');
        setTimeout(() => closeBtn.focus(), 60);
        document.body.style.overflow = 'hidden';
        refreshMatchCount();
    }

    function closeDrawer() {
        drawer.classList.remove('open');
        overlay.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('aria-hidden', 'true');
        openBtn.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
        openBtn.focus();
    }

    function trapFocus(e) {
        if (!drawer.classList.contains('open')) return;
        const focusable = Array.from(
            drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ).filter(el => !el.disabled && el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.key === 'Tab') {
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
        if (e.key === 'Escape') closeDrawer();
    }

    function onChipClick(e) {
        const chip = e.currentTarget;
        const filterType = chip.dataset.drawerFilter;
        const value = chip.dataset.value;
        const isSelected = chip.classList.toggle('selected');
        chip.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        const arr = filterType === 'intent' ? window.DRAWER_FILTERS.intents : window.DRAWER_FILTERS.stones;
        if (isSelected) { if (!arr.includes(value)) arr.push(value); }
        else { const idx = arr.indexOf(value); if (idx !== -1) arr.splice(idx, 1); }
        refreshMatchCount();
        refreshSummary();
        syncTriggerBadge();
    }

    const PRICE_ABSOLUTE_MAX = 5000;

    function onPriceChange() {
        let min = parseInt(priceMinEl.value, 10);
        let max = parseInt(priceMaxEl.value, 10);
        if (min > max) { min = max; priceMinEl.value = min; }
        window.DRAWER_FILTERS.priceMin = min;
        window.DRAWER_FILTERS.priceMax = max;
        priceMinLabel.textContent = min.toLocaleString('en-IN');
        priceMaxLabel.textContent = max.toLocaleString('en-IN');
        const minPct = (min / PRICE_ABSOLUTE_MAX) * 100;
        const maxPct = (max / PRICE_ABSOLUTE_MAX) * 100;
        priceMinEl.style.setProperty('--min-pct', `${minPct}%`);
        priceMinEl.style.setProperty('--max-pct', `${maxPct}%`);
        refreshMatchCount();
    }

    function refreshMatchCount() {
        if (!window.productMap || typeof window.productMap.values !== 'function') {
            if (matchCountEl) matchCountEl.textContent = '—';
            return;
        }
        const matching = applyDrawerFilters([...window.productMap.values()]);
        if (matchCountEl) matchCountEl.textContent = matching.length;
    }

    function refreshSummary() {
        const parts = [];
        if (window.DRAWER_FILTERS.intents.length) parts.push(window.DRAWER_FILTERS.intents.map(v => v.charAt(0).toUpperCase() + v.slice(1)).join(', '));
        if (window.DRAWER_FILTERS.stones.length) parts.push(window.DRAWER_FILTERS.stones.map(v => v.charAt(0).toUpperCase() + v.slice(1)).join(', '));
        if (summaryText) summaryText.textContent = parts.join(' · ') || '';
        if (summaryBox) summaryBox.style.display = parts.length ? 'block' : 'none';
    }

    function syncTriggerBadge() {
        const hasActive =
            window.DRAWER_FILTERS.intents.length > 0 ||
            window.DRAWER_FILTERS.stones.length > 0 ||
            window.DRAWER_FILTERS.priceMin > 0 ||
            window.DRAWER_FILTERS.priceMax < PRICE_ABSOLUTE_MAX;
        if (openBtn) openBtn.classList.toggle('has-active-filters', hasActive);
    }

    function clearAllDrawerFilters() {
        window.DRAWER_FILTERS.intents = [];
        window.DRAWER_FILTERS.stones = [];
        window.DRAWER_FILTERS.priceMin = 0;
        window.DRAWER_FILTERS.priceMax = PRICE_ABSOLUTE_MAX;
        drawer.querySelectorAll('.drawer-chip.selected').forEach(c => { c.classList.remove('selected'); c.setAttribute('aria-pressed', 'false'); });
        if (priceMinEl) priceMinEl.value = 0;
        if (priceMaxEl) priceMaxEl.value = PRICE_ABSOLUTE_MAX;
        onPriceChange();
        refreshSummary();
        syncTriggerBadge();
        refreshMatchCount();
    }

    function applyAndClose() {
        closeDrawer();
        setTimeout(() => { if (typeof window.updateShopView === 'function') window.updateShopView(1); }, 80);
    }

    window.applyDrawerFilters = function (products) {
        const f = window.DRAWER_FILTERS;
        const hasIntents = f.intents.length > 0;
        const hasStones = f.stones.length > 0;
        return products.filter(p => {
            if (hasIntents && !f.intents.includes((p.category || '').toLowerCase())) return false;
            if (hasStones) {
                const pStone = (p.stone || p.crystal || p.material || '').toLowerCase();
                if (!f.stones.some(s => pStone.includes(s))) return false;
            }
            const effectivePrice = (typeof p.salePrice === 'number' && p.salePrice < p.price) ? p.salePrice : (p.price || 0);
            if (effectivePrice < f.priceMin || effectivePrice > f.priceMax) return false;
            return true;
        });
    };

    function patchUpdateShopView() {
        if (typeof window.updateShopView !== 'function') return;
        if (window.updateShopView._drawerPatched) return;

        const _original = window.updateShopView;

        window.updateShopView = function (page = 1) {
            _original(page);

            const grid = document.getElementById('productsGrid');
            if (!grid || !window.productMap) return;

            const f = window.DRAWER_FILTERS;
            const hasDrawerFilters =
                f.intents.length > 0 ||
                f.stones.length > 0 ||
                f.priceMin > 0 ||
                f.priceMax < PRICE_ABSOLUTE_MAX;

            if (!hasDrawerFilters) return;

            const activeFilterBtn = document.querySelector('.filter-btn.active');
            const currentFilter = activeFilterBtn?.dataset.filter || 'all';
            const urlSearch = new URLSearchParams(window.location.search).get('search') || '';

            let filtered = [...window.productMap.values()].filter(p => {
                const matchCat = currentFilter === 'all' || p.category === currentFilter;
                const matchSearch = !urlSearch || (p.name || '').toLowerCase().includes(urlSearch.toLowerCase());
                return matchCat && matchSearch;
            });

            filtered = window.applyDrawerFilters(filtered);

            const sortEl = document.getElementById('dropdownSelected');
            const sortText = sortEl ? sortEl.textContent.trim() : '';
            const sortFns = {
                'Low to High': (a, b) => a.price - b.price,
                'High to Low': (a, b) => b.price - a.price,
                'A to Z': (a, b) => (a.name || '').localeCompare(b.name || ''),
                'Z to A': (a, b) => (b.name || '').localeCompare(a.name || ''),
            };
            for (const [key, fn] of Object.entries(sortFns)) {
                if (sortText.includes(key)) { filtered.sort(fn); break; }
            }

            const ITEMS_PER_PAGE = 12;
            const totalItems = filtered.length;
            const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
            const start = (page - 1) * ITEMS_PER_PAGE;
            const paginated = filtered.slice(start, start + ITEMS_PER_PAGE);

            const noResults = document.getElementById('noResults');
            const pagination = document.getElementById('pagination');
            const showStart = document.getElementById('showingStart');
            const showEnd = document.getElementById('showingEnd');
            const totalEl = document.getElementById('totalProducts');

            if (paginated.length === 0) {
                grid.innerHTML = '';
                if (noResults) noResults.style.display = 'block';
                if (pagination) pagination.innerHTML = '';
                if (showStart) showStart.textContent = '0';
                if (showEnd) showEnd.textContent = '0';
                if (totalEl) totalEl.textContent = '0';
                return;
            }

            if (noResults) noResults.style.display = 'none';
            if (showStart) showStart.textContent = start + 1;
            if (showEnd) showEnd.textContent = Math.min(start + ITEMS_PER_PAGE, totalItems);
            if (totalEl) totalEl.textContent = totalItems;

            if (typeof window.buildProductCardHTML === 'function') {
                grid.innerHTML = paginated.map(p => window.buildProductCardHTML(p)).join('');
            }

            if (pagination) {
                pagination.innerHTML = buildPaginationHTML(page, totalPages);
            }
        };

        window.updateShopView._drawerPatched = true;
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!document.getElementById('productsGrid')) return;

        drawer = document.getElementById('filterDrawer');
        overlay = document.getElementById('drawerOverlay');
        openBtn = document.getElementById('openDrawerBtn');
        closeBtn = document.getElementById('drawerClose');
        applyBtn = document.getElementById('drawerApply');
        clearBtn = document.getElementById('drawerClear');
        priceMinEl = document.getElementById('drawerPriceMin');
        priceMaxEl = document.getElementById('drawerPriceMax');
        priceMinLabel = document.getElementById('drawerPriceMinLabel');
        priceMaxLabel = document.getElementById('drawerPriceMaxLabel');
        summaryBox = document.getElementById('drawerSelectionSummary');
        summaryText = document.getElementById('drawerSummaryText');
        matchCountEl = document.getElementById('drawerMatchCount');

        if (!drawer || !overlay || !openBtn) {
            console.warn('[Drawer] Required elements not found. Check HTML snippet is in place.');
            return;
        }

        openBtn.addEventListener('click', openDrawer);
        closeBtn.addEventListener('click', closeDrawer);
        overlay.addEventListener('click', closeDrawer);
        document.addEventListener('keydown', trapFocus);

        drawer.querySelectorAll('.drawer-chip').forEach(chip => {
            chip.addEventListener('click', onChipClick);
        });

        priceMinEl.addEventListener('input', onPriceChange);
        priceMaxEl.addEventListener('input', onPriceChange);
        onPriceChange();

        clearBtn.addEventListener('click', clearAllDrawerFilters);
        applyBtn.addEventListener('click', applyAndClose);

        patchUpdateShopView();

        const waitForProducts = setInterval(() => {
            if (window.productMap && window.productMap.size > 0) {
                clearInterval(waitForProducts);
                refreshMatchCount();
            }
        }, 200);
    });

})(); // DRAWER IIFE

/* ============================================================
   CRYSTAL QUIZ IIFE — "Find Your Crystal" Homepage Feature
   ─────────────────────────────────────────────────────────
   Reads live productMap to find real products matching
   the recommended category. Falls back to a shop link if
   no matching product exists.
   ============================================================ */
(function () {
    'use strict';

    // Maps [q1answer][q2answer] → category key matching productMap.category values
    // Extend this table freely as your collection grows.
    const QUIZ_MAP = {
        luck: {
            shield: { category: 'luck', reason: 'Citrine and Pyrite create a powerful wealth shield — attracting abundance while blocking energy drains.' },
            clarity: { category: 'luck', reason: 'A clear mind manifests faster. This crystal sharpens your wealth frequency and removes mental fog.' },
            healing: { category: 'luck', reason: 'True abundance starts from within. This stone heals your relationship with money and opens the flow.' },
            grounding: { category: 'energy', reason: 'Grounded energy is the foundation for attracting lasting wealth. This crystal anchors your manifestations.' }
        },
        love: {
            shield: { category: 'love', reason: 'Rose Quartz protects your heart while keeping it open — the perfect balance of strength and tenderness.' },
            clarity: { category: 'love', reason: 'Clarity in love starts with self-love. This crystal reveals your heart\'s true desires.' },
            healing: { category: 'love', reason: 'This crystal is a master heart healer — it gently dissolves old wounds and replaces them with compassion.' },
            grounding: { category: 'love', reason: 'Stable, grounded love is the most enduring. This crystal builds a secure foundation for your relationships.' }
        },
        peace: {
            shield: { category: 'protection', reason: 'True peace requires protection from external chaos. This crystal creates a calm energetic boundary.' },
            clarity: { category: 'peace', reason: 'Amethyst is the stone of tranquillity — it quiets the mind and dissolves anxiety at its root.' },
            healing: { category: 'peace', reason: 'This stone soothes emotional turbulence and guides you back to your natural state of inner calm.' },
            grounding: { category: 'peace', reason: 'Grounded stillness is the deepest form of peace. This crystal anchors you to the present moment.' }
        },
        energy: {
            shield: { category: 'protection', reason: 'Black Tourmaline filters out the energy vampires draining your vitality — your personal energetic shield.' },
            clarity: { category: 'energy', reason: 'Focus is refined energy. This crystal sharpens your attention and supercharges your productivity.' },
            healing: { category: 'energy', reason: 'This crystal restores your life-force energy — reigniting your passion after periods of depletion.' },
            grounding: { category: 'energy', reason: 'Grounded energy is sustainable energy. This stone keeps your power steady rather than burning out.' }
        }
    };

    let q1Answer = null;

    function getRecommendation() {
        const map = QUIZ_MAP[q1Answer];
        if (!map) return null;
        return map[window._quizQ2Answer] || Object.values(map)[0];
    }

    function findProductForCategory(category) {
        // Pick the first non-sold-out product in the category; sold-out last resort
        const candidates = [...productMap.values()].filter(p => p.category === category);
        return candidates.find(p => !(typeof p.stock === 'number' && p.stock === 0))
            || candidates[0]
            || null;
    }

    function renderResult() {
        const rec = getRecommendation();
        if (rec?.category) {
            localStorage.setItem('userAura', rec.category);
        }
        const resultCard = document.getElementById('quizResultCard');
        if (!resultCard) return;

        document.getElementById('quizStep2')?.setAttribute('hidden', '');
        document.getElementById('quizResult')?.removeAttribute('hidden');

        if (!rec) {
            resultCard.innerHTML = `<p class="quiz-result-fallback">Something went wrong — <a href="shop.html">browse our full collection</a> to find your match.</p>`;
            return;
        }

        // Try live productMap first, fall back to category shop link
        const product = findProductForCategory(rec.category);

        if (product) {
            const onSale = product.salePrice != null && typeof product.salePrice === 'number' && product.salePrice < product.price;
            const price = onSale ? product.salePrice : product.price;
            const priceHTML = onSale
                ? `<div class="quiz-result-price"><span style="text-decoration:line-through;color:#888;font-weight:400;font-size:0.9rem;margin-right:6px;">₹${product.price.toLocaleString('en-IN')}</span>₹${price.toLocaleString('en-IN')}</div>`
                : `<div class="quiz-result-price">₹${price.toLocaleString('en-IN')}</div>`;

            resultCard.innerHTML = `
                ${product.image
                    ? `<img class="quiz-result-img" src="${product.image}" alt="${product.name}" loading="lazy">`
                    : `<div class="quiz-result-img-placeholder">💎</div>`}
                <div class="quiz-result-body">
                    <p class="quiz-result-crystal-label">Your Crystal Match</p>
                    <div class="quiz-result-name">${product.name}</div>
                    <p class="quiz-result-reason">${rec.reason}</p>
                    ${priceHTML}
                    <div class="quiz-result-actions">
                        <a href="product-detail.html?id=${product.id}" class="quiz-result-shop-btn">
                            <i class="fa-solid fa-gem"></i> View Crystal
                        </a>
                        <button class="quiz-result-bag-btn" data-quiz-add="${product.id}">
                            <i class="fa-solid fa-bag-shopping"></i> Add to Bag
                        </button>
                    </div>
                </div>`;

            // Wire Add to Bag
            resultCard.querySelector('[data-quiz-add]')?.addEventListener('click', () => {
                addToCart(product.id);
            });
        } else {
            // No live product — show category link
            resultCard.innerHTML = `
                <div class="quiz-result-img-placeholder">💎</div>
                <div class="quiz-result-body">
                    <p class="quiz-result-crystal-label">Your Crystal Match</p>
                    <div class="quiz-result-name">${rec.category.charAt(0).toUpperCase() + rec.category.slice(1)} Crystal</div>
                    <p class="quiz-result-reason">${rec.reason}</p>
                    <div class="quiz-result-actions">
                        <a href="shop.html?filter=${rec.category}" class="quiz-result-shop-btn">
                            <i class="fa-solid fa-gem"></i> See Collection
                        </a>
                    </div>
                </div>`;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const quizSection = document.getElementById('crystalQuiz');
        if (!quizSection) return; // only run on pages with the quiz

        const entry = document.getElementById('quizEntry');
        const flow = document.getElementById('quizFlow');
        const step1 = document.getElementById('quizStep1');
        const step2 = document.getElementById('quizStep2');

        // Show quiz flow
        document.getElementById('quizStartBtn')?.addEventListener('click', () => {
            entry.setAttribute('hidden', '');
            flow.removeAttribute('hidden');
        });

        // Q1 option click
        step1?.addEventListener('click', e => {
            const btn = e.target.closest('.quiz-opt[data-step="1"]');
            if (!btn) return;
            q1Answer = btn.dataset.value;
            // Mark selected
            step1.querySelectorAll('.quiz-opt').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            // Brief delay then advance to Q2
            setTimeout(() => {
                step1.setAttribute('hidden', '');
                step2.removeAttribute('hidden');
            }, 300);
        });

        // Q2 option click
        step2?.addEventListener('click', e => {
            const btn = e.target.closest('.quiz-opt[data-step="2"]');
            if (!btn) return;
            window._quizQ2Answer = btn.dataset.value;
            step2.querySelectorAll('.quiz-opt').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            // Slight delay for visual feedback then show result
            setTimeout(() => {
                // Wait for productMap if it hasn't loaded yet
                if (productMap.size > 0) {
                    renderResult();
                } else {
                    initProductData().then(renderResult);
                }
            }, 350);
        });

        // Restart
        document.getElementById('quizRestartBtn')?.addEventListener('click', () => {
            q1Answer = null;
            window._quizQ2Answer = null;
            // Reset all steps
            document.getElementById('quizResult')?.setAttribute('hidden', '');
            step1?.querySelectorAll('.quiz-opt').forEach(b => b.classList.remove('selected'));
            step2?.querySelectorAll('.quiz-opt').forEach(b => b.classList.remove('selected'));
            step1?.removeAttribute('hidden');
            step2?.setAttribute('hidden', '');
            flow.removeAttribute('hidden');
            entry.setAttribute('hidden', '');
        });
    });

})(); // CRYSTAL QUIZ IIFE


/* ============================================================
   PERFECT PAIRINGS IIFE — Frequently Bought Together (PDP)
   ─────────────────────────────────────────────────────────
   Reads `linkedProductId` from the current product's Firestore
   document. If present, fetches the linked product and renders
   a two-card upsell with a combined 5% discount CTA.
   ============================================================ */
(function () {
    'use strict';

    const PAIRING_DISCOUNT_PCT = 5; // % off combined price when both added

    function buildPairingCard(product, isCurrent) {
        const onSale = product.salePrice != null && typeof product.salePrice === 'number' && product.salePrice < product.price;
        const price = onSale ? product.salePrice : (product.price || 0);
        return `
            <img class="pairing-card-img" src="${product.image || ''}" alt="${product.name}" loading="lazy">
            <div class="pairing-card-name">${product.name}</div>
            <div class="pairing-card-price">₹${price.toLocaleString('en-IN')}</div>`;
    }

    function effectivePrice(p) {
        return (p.salePrice != null && typeof p.salePrice === 'number' && p.salePrice < p.price)
            ? p.salePrice : (p.price || 0);
    }

    async function initPerfectPairings(currentProduct) {
        const section = document.getElementById('pairingsSection');
        if (!section) return;

        // `linkedProductId` must be set on the Firestore product document
        const linkedId = currentProduct.linkedProductId;
        if (!linkedId) return; // no pairing configured — section stays hidden

        // Resolve linked product: try integer then string key
        let linked = productMap.get(linkedId)
            || productMap.get(parseInt(linkedId, 10))
            || productMap.get(String(linkedId));

        // If not in productMap (e.g. id is a Firestore doc string), fetch directly
        if (!linked) {
            try {
                const [{ db }, { doc, getDoc }] = await Promise.all([
                    import('./firebase.js'),
                    import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
                ]);
                const snap = await getDoc(doc(db, 'products', String(linkedId)));
                if (snap.exists()) {
                    linked = { ...snap.data(), _docId: snap.id, id: snap.id };
                }
            } catch (err) {
                console.warn('[Aura & Earth] Perfect Pairings: could not fetch linked product:', err.message);
                return;
            }
        }

        if (!linked) return; // linked product doesn't exist — stay hidden

        // Populate cards
        const mainCard = document.getElementById('pairingMain');
        const linkedCard = document.getElementById('pairingLinked');
        if (mainCard) mainCard.innerHTML = buildPairingCard(currentProduct, true);
        if (linkedCard) linkedCard.innerHTML = buildPairingCard(linked, false);

        // Price summary
        const priceA = effectivePrice(currentProduct);
        const priceB = effectivePrice(linked);
        const combined = priceA + priceB;
        const discount = Math.round(combined * PAIRING_DISCOUNT_PCT / 100);
        const finalPrice = combined - discount;

        const summary = document.getElementById('pairingsPriceSummary');
        if (summary) {
            summary.innerHTML = `
                Combined:
                <span class="pairings-original-price">₹${combined.toLocaleString('en-IN')}</span>
                <span class="pairings-discount-price">₹${finalPrice.toLocaleString('en-IN')}</span>
                — you save <strong>₹${discount.toLocaleString('en-IN')}</strong>`;
        }

        const discountLabel = document.getElementById('pairingsDiscountLabel');
        if (discountLabel) discountLabel.textContent = `${PAIRING_DISCOUNT_PCT}% Off!`;

        // Reveal section with a smooth entrance
        section.removeAttribute('hidden');
        section.style.opacity = '0';
        section.style.transform = 'translateY(18px)';
        requestAnimationFrame(() => {
            section.style.transition = 'opacity 0.5s ease, transform 0.5s cubic-bezier(0.22,1,0.36,1)';
            section.style.opacity = '1';
            section.style.transform = 'translateY(0)';
        });

        // Add Both CTA
        document.getElementById('pairingsAddBothBtn')?.addEventListener('click', () => {
            const btn = document.getElementById('pairingsAddBothBtn');
            const mainSold = typeof currentProduct.stock === 'number' && currentProduct.stock === 0;
            const linkedSold = typeof linked.stock === 'number' && linked.stock === 0;

            if (mainSold || linkedSold) {
                const who = mainSold && linkedSold ? 'Both items are' : 'One of these items is';
                showToast(`${who} currently sold out.`, 'info');
                return;
            }

            let addedCount = 0;
            const items = getCartItems();

            if (!items.some(i => i.id === currentProduct.id)) {
                items.push({ id: currentProduct.id, qty: 1, size: 'Medium (17cm)', charm: 'None' });
                addedCount++;
            }
            if (!items.some(i => i.id === linked.id)) {
                items.push({ id: linked.id, qty: 1, size: 'Medium (17cm)', charm: 'None' });
                addedCount++;
            }

            if (addedCount === 0) {
                showToast('Both crystals are already in your Bag! ✨', 'info');
                return;
            }

            saveCartItems(items);
            showToast(`${addedCount === 2 ? 'Both crystals' : '1 crystal'} added — ${PAIRING_DISCOUNT_PCT}% bundle discount applied at checkout! 🛍️`);

            // Button feedback
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Added to Bag!';
                btn.disabled = true;
                setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2800);
            }
        });
    }

    // Hook into the PDP boot sequence: wait for the product to be resolved
    // then call initPerfectPairings. We poll via MutationObserver on the
    // pdpTitle element — once it has real content the product is resolved.
    document.addEventListener('DOMContentLoaded', () => {
        if (!document.getElementById('pairingsSection')) return;

        const titleEl = document.getElementById('pdpTitle');
        if (!titleEl) return;

        // The PDP IIFE runs initProductData() then sets pdpTitle.
        // We observe that change as the "product is ready" signal.
        const observer = new MutationObserver(() => {
            // productMap is populated and `product` is resolved inside the PDP IIFE.
            // We access it via productMap using the URL id — same logic as the PDP IIFE.
            const rawId = new URLSearchParams(window.location.search).get('id');
            if (!rawId) return;
            const intId = parseInt(rawId, 10);
            const product = productMap.get(intId) || productMap.get(rawId) || null;
            if (!product) return;
            observer.disconnect();
            initPerfectPairings(product);
        });

        observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    });

})(); // PERFECT PAIRINGS IIFE

/* ============================================================
   PHASE 4 — PREMIUM SHOP UPGRADES  |  main.js ADDITIONS
   ─────────────────────────────────────────────────────────
   APPEND THIS ENTIRE FILE to the bottom of js/main.js,
   just before the closing </script> tag or at the very end.

   Sections:
   A. Quiz Save-Aura Patch    — saves userAura to localStorage
   B. Energy Match Section    — renders top-of-shop aura picks
   C. Mini Cart Drawer        — slide-out cart with remove/totals
   D. FOMO Badges             — overlaid on product cards
   E. Quick View Modal        — full-featured hover quick view
   ============================================================ */


/* ============================================================
   A. QUIZ PATCH — Save userAura to localStorage
   ─────────────────────────────────────────────────────────
   ALSO REQUIRED: In the existing renderResult() function
   (around line 3931 in main.js), ADD the following line
   IMMEDIATELY after `const rec = getRecommendation();`:

       if (rec?.category) {
           localStorage.setItem('userAura', rec.category);
       }

   That's the ONLY edit to existing code.
   The IIFE below handles everything new on shop.html.
   ============================================================ */

/* ============================================================
   C. MINI CART DRAWER IIFE
   ─────────────────────────────────────────────────────────
   Creates a slide-out cart drawer. Overrides window.addToCart
   to open the drawer after adding. Handles remove, totals,
   and checkout CTA.
   ============================================================ */
(function initMiniCart() {
    'use strict';

    // Prevent duplicate injection
    if (document.getElementById('miniCartDrawer') || document.getElementById('miniCartOverlay')) {
        return;
    }

    // REPLACE with real HTML:
    const drawerHTML = `
  <div id="miniCartOverlay" class="mini-cart-overlay"></div>
  <div id="miniCartDrawer" class="mini-cart-drawer" aria-label="Shopping bag">
    <div class="mini-cart-header">
      <h3>Your Bag</h3>
      <button id="miniCartClose" aria-label="Close cart"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div id="miniCartItems" class="mini-cart-items"></div>
    <div class="mini-cart-footer">
      <a href="cart-checkout.html" class="mini-cart-checkout-btn">View Bag &amp; Checkout</a>
      <button id="miniCartContinue" class="mini-cart-continue-btn">Continue Shopping</button>
    </div>
  </div>`;
    document.body.insertAdjacentHTML('beforeend', drawerHTML);

    const overlay = document.getElementById('miniCartOverlay');
    const drawer = document.getElementById('miniCartDrawer');
    const closeBtn = document.getElementById('miniCartClose');
    const continueBtn = document.getElementById('miniCartContinue');

    function openMiniCart() {
        if (!overlay || !drawer) return;
        overlay.classList.add('is-open');
        drawer.classList.add('is-open');
        document.body.style.overflow = 'hidden';
        closeBtn?.focus();
    }

    function closeMiniCart() {
        if (!overlay || !drawer) return;
        overlay.classList.remove('is-open');
        drawer.classList.remove('is-open');
        document.body.style.overflow = '';
    }

    // Event Listeners
    overlay?.addEventListener('click', closeMiniCart);
    closeBtn?.addEventListener('click', closeMiniCart);
    continueBtn?.addEventListener('click', closeMiniCart);

    // Escape key
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && drawer?.classList.contains('is-open')) {
            closeMiniCart();
        }
    });

    // Global functions
    window.openMiniCart = openMiniCart;
    window.closeMiniCart = closeMiniCart;

    // Re-render on cart update
    document.addEventListener('aura:cartUpdated', () => {
        if (typeof window._cartPageRerender === 'function') window._cartPageRerender();
        // Or implement your own renderMiniCart() function here
    });

    console.log('%cMini Cart initialized successfully', 'color: #8aaa80; font-weight: 500');

})(); // END initMiniCart


/* ============================================================
   D. FOMO BADGES
   ─────────────────────────────────────────────────────────
   Injected during the shop product render loop.
   Call window.injectFomoBadges() after cards are rendered,
   OR integrate getFomoBadgeHTML() inside buildProductCardHTML.

   Integration method (recommended):
   In your existing buildProductCardHTML() function in main.js,
   find where you render the product image container and add:
       ${getFomoBadgeHTML(product)}
   inside the image wrapper element.

   The IIFE below also auto-scans after updateShopView renders.
   ============================================================ */

/**
 * Returns the FOMO badge HTML string for a product.
 * Call inside buildProductCardHTML() within the image wrapper.
 * @param {Object} product - product object from productMap
 * @returns {string} HTML string for badge(s)
 */
window.getFomoBadgeHTML = function (product) {
    let badges = '';

    if (typeof product.stock === 'number' && product.stock > 0) {
        if (product.stock <= 3) {
            badges += `<span class="fomo-badge fomo-badge--low-stock">Only ${product.stock} left</span>`;
        } else if (product.stock <= 5) {
            badges += `<span class="fomo-badge fomo-badge--low-stock">Only ${product.stock} left</span>`;
        }

        const salesCount = product.salesCount || product.sold || product.orderCount || 0;
        if (salesCount >= 50) {
            badges += `<span class="fomo-badge fomo-badge--bestseller" aria-label="Bestseller">✦ Bestseller</span>`;
        }

        return badges;
    };
};

window.injectFomoBadges = function () {
    const cards = document.querySelectorAll('#productsGrid .product-card[data-product-id]');
    cards.forEach(card => {
        const rawId = card.dataset.productId;
        const intId = parseInt(rawId, 10);
        // Try integer key first, then string key as fallback
        const product = productMap.get(intId) || productMap.get(rawId);
        if (!product) return;

        // Inject into .product-card (position:relative, no overflow:hidden)
        // so the badge is NOT clipped by .product-image-box's overflow:hidden
        card.querySelectorAll('.fomo-badge').forEach(b => b.remove());

        const badgesHTML = window.getFomoBadgeHTML(product);
        if (badgesHTML) {
            card.insertAdjacentHTML('beforeend', badgesHTML);
        }
    });
};

(function () {
    const grid = document.getElementById('productsGrid');
    if (!grid) return;

    const observer = new MutationObserver(() => {
        if (productMap.size > 0) {
            clearTimeout(observer._t);
            observer._t = setTimeout(window.injectFomoBadges, 80);
        }
    });

    observer.observe(grid, { childList: true, subtree: false });
})();

/**
 * Auto-inject FOMO badges into already-rendered product cards.
 * Called after updateShopView() renders the grid.
 * Finds cards that have a data-product-id and injects badges.
 */
/* ============================================================
   E. QUICK VIEW MODAL IIFE
   ─────────────────────────────────────────────────────────
   Injects a sleek modal. Adds "Quick View" hover buttons to
   all product cards in the grid. Handles open/close, ESC,
   and Add to Bag from within the modal.
   ============================================================ */
(function initQuickView() {
    'use strict';

    if (!document.getElementById('productsGrid')) return;

    // ── 1. Inject Modal HTML ───────────────────────────────
    const modalHTML = `
        <div id="qvOverlay" class="qv-overlay" role="dialog" aria-modal="true" aria-label="Quick view" aria-hidden="true">
            <div id="qvModal" class="qv-modal" role="document">
                <button id="qvClose" class="qv-close" aria-label="Close quick view">
                    <i class="fa-solid fa-xmark"></i>
                </button>

                <!-- Image column -->
                <div class="qv-image-col" id="qvImageCol">
                    <div class="qv-image-placeholder">💎</div>
                </div>

                <!-- Details column -->
                <div class="qv-details-col">
                    <p class="qv-eyebrow"><i class="fa-solid fa-gem"></i> <span id="qvCategory">Crystal</span></p>
                    <h2 class="qv-name" id="qvName">—</h2>

                    <div class="qv-price-row">
                        <span class="qv-price" id="qvPrice">₹0</span>
                        <span class="qv-price-original" id="qvPriceOriginal" style="display:none;"></span>
                        <span class="qv-sale-pill" id="qvSalePill" style="display:none;">Sale</span>
                    </div>

                    <div class="qv-divider"></div>

                    <p class="qv-desc" id="qvDesc">—</p>

                    <div class="qv-meta-grid" id="qvMeta"></div>

                    <div class="qv-actions">
                        <button class="qv-add-btn" id="qvAddBtn">
                            <i class="fa-solid fa-bag-shopping"></i> Add to Bag
                        </button>
                        <a id="qvViewBtn" href="#" class="qv-view-btn">
                            View Full Details →
                        </a>
                    </div>
                </div>
            </div>
        </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHTML);

    const overlay = document.getElementById('qvOverlay');
    const closeBtn = document.getElementById('qvClose');
    const addBtn = document.getElementById('qvAddBtn');
    const viewBtn = document.getElementById('qvViewBtn');

    let currentProductId = null;

    // ── 2. Open / Close ────────────────────────────────────
    function openModal() {
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        closeBtn?.focus();
    }

    function closeModal() {
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        currentProductId = null;
        // Reset add btn
        addBtn.disabled = false;
        addBtn.innerHTML = '<i class="fa-solid fa-bag-shopping"></i> Add to Bag';
        addBtn.classList.remove('added');
    }

    // Close on overlay click (but not modal click)
    overlay.addEventListener('click', e => {
        if (e.target === overlay) closeModal();
    });
    closeBtn?.addEventListener('click', closeModal);

    // Escape key
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeModal();
    });

    // ── 3. Populate Modal ──────────────────────────────────
    function populateModal(product) {
        currentProductId = product.id;

        const onSale = product.salePrice != null && typeof product.salePrice === 'number' && product.salePrice < product.price;
        const price = onSale ? product.salePrice : (product.price || 0);

        // Image
        const imgCol = document.getElementById('qvImageCol');
        imgCol.innerHTML = product.image
            ? `<img src="${product.image}" alt="${product.name}" loading="eager">`
            : `<div class="qv-image-placeholder">💎</div>`;

        // Category eyebrow
        const catMap = { protection: 'Protection', peace: 'Inner Peace', love: 'Love & Harmony', energy: 'Energy & Focus', luck: 'Luck & Abundance' };
        document.getElementById('qvCategory').textContent = catMap[product.category] || (product.category || 'Crystal');

        // Name
        document.getElementById('qvName').textContent = product.name || '—';

        // Price
        document.getElementById('qvPrice').textContent = `₹${price.toLocaleString('en-IN')}`;

        const origEl = document.getElementById('qvPriceOriginal');
        const saleEl = document.getElementById('qvSalePill');
        if (onSale) {
            origEl.textContent = `₹${product.price.toLocaleString('en-IN')}`;
            origEl.style.display = 'inline';
            const savePct = Math.round(((product.price - price) / product.price) * 100);
            saleEl.textContent = `${savePct}% Off`;
            saleEl.style.display = 'inline-flex';
        } else {
            origEl.style.display = 'none';
            saleEl.style.display = 'none';
        }

        // Description
        const desc = product.description || product.desc || product.shortDescription || 'A beautifully sourced healing crystal, ethically curated for your energy journey.';
        document.getElementById('qvDesc').textContent = desc;

        // Meta grid
        const metaItems = [];
        if (product.stone || product.crystal) metaItems.push({ label: 'Crystal', value: product.stone || product.crystal });
        if (product.chakra) metaItems.push({ label: 'Chakra', value: product.chakra });
        if (product.origin) metaItems.push({ label: 'Origin', value: product.origin });
        if (typeof product.stock === 'number') metaItems.push({ label: 'In Stock', value: product.stock > 0 ? `${product.stock} available` : 'Sold Out' });

        document.getElementById('qvMeta').innerHTML = metaItems.map(m => `
            <div class="qv-meta-item">
                <span class="qv-meta-label">${m.label}</span>
                <span class="qv-meta-value">${m.value}</span>
            </div>`).join('');

        // View full page link
        document.getElementById('qvViewBtn').href = `product-detail.html?id=${product.id}`;

        // Add to Bag state
        const soldOut = typeof product.stock === 'number' && product.stock === 0;
        if (soldOut) {
            addBtn.disabled = true;
            addBtn.innerHTML = '<i class="fa-solid fa-ban"></i> Sold Out';
        } else if (isInCart(product.id)) {
            addBtn.innerHTML = '<i class="fa-solid fa-check"></i> Already in Bag';
            addBtn.classList.add('added');
        } else {
            addBtn.disabled = false;
            addBtn.innerHTML = '<i class="fa-solid fa-bag-shopping"></i> Add to Bag';
            addBtn.classList.remove('added');
        }
    }

    // ── 4. Add to Bag from modal ───────────────────────────
    addBtn?.addEventListener('click', () => {
        if (!currentProductId || addBtn.disabled) return;
        window.addToCart(currentProductId);
        addBtn.innerHTML = '<i class="fa-solid fa-check"></i> Added to Bag!';
        addBtn.classList.add('added');
        // Close modal after a beat (mini cart will open via addToCart override)
        setTimeout(closeModal, 600);
    });

    // ── 5. Inject "Quick View" buttons into product cards ──
    function injectQuickViewButtons() {
        // ✅ FIX: select cards by data-product-id attribute
        const cards = document.querySelectorAll('#productsGrid .product-card[data-product-id]');
        cards.forEach(card => {
            if (card.querySelector('.quick-view-trigger')) return; // already injected

            const rawId = card.dataset.productId;
            if (!rawId) return;
            const id = isNaN(rawId) ? rawId : parseInt(rawId, 10);

            // ✅ FIX: real image wrapper class from buildProductCardHTML
            const imgWrap = card.querySelector('.product-image-box');
            if (!imgWrap) return;

            const btn = document.createElement('button');
            btn.className = 'quick-view-trigger';
            btn.setAttribute('aria-label', 'Quick view product');
            btn.innerHTML = '<i class="fa-regular fa-eye"></i> Quick View';
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                const product = productMap.get(id);
                if (!product) return;
                populateModal(product);
                openModal();
            });

            imgWrap.appendChild(btn);
        });
    }

    // ── 6. Watch grid for new cards ────────────────────────
    const grid = document.getElementById('productsGrid');
    if (grid) {
        const qvObserver = new MutationObserver(() => {
            if (productMap.size > 0) {
                clearTimeout(qvObserver._t);
                qvObserver._t = setTimeout(injectQuickViewButtons, 100);
            }
        });
        qvObserver.observe(grid, { childList: true });
    }

    // Initial injection after product load
    initProductData().then(() => {
        setTimeout(injectQuickViewButtons, 200);
    });

})(); // END Quick View IIFE

/* ============================================================
   PHASE 5 — GIFT MODE IIFE
   Runs on product-detail.html only.
============================================================ */
(function initGiftMode() {
    'use strict';
    const toggle = document.getElementById('pdpGiftToggle');
    const panel = document.getElementById('pdpGiftPanel');
    const pill = document.getElementById('pdpGiftPill');
    const textarea = document.getElementById('pdpGiftNote');
    const charLeft = document.getElementById('pdpGiftCharLeft');
    const velvetCb = document.getElementById('pdpVelvetPkg');

    if (!toggle || !panel) return;

    toggle.addEventListener('click', () => {
        const isOpen = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!isOpen));
        panel.setAttribute('aria-hidden', String(isOpen));
        pill.textContent = isOpen ? 'Add Gift Options' : 'Gift Added ✓';
        if (!isOpen) setTimeout(() => textarea?.focus(), 380);
    });

    // Character counter
    textarea?.addEventListener('input', () => {
        const remaining = 200 - textarea.value.length;
        if (charLeft) charLeft.textContent = remaining;
    });

    // Expose gift data so addToCart can read it if needed
    window.getGiftModeData = function () {
        if (toggle.getAttribute('aria-expanded') !== 'true') return null;
        return {
            note: textarea?.value.trim() || '',
            velvetPackaging: velvetCb?.checked || false,
            extraCost: velvetCb?.checked ? 150 : 0
        };
    };
})();

/* ============================================================
   DYNAMIC NAVBAR CATEGORIES
   Fetches `categories` collection, sorted by `order`, and
   injects links into .dropdown-content (desktop) and
   .mobile-dropdown-content (mobile menu).
============================================================ */
(async function initNavCategories() {
    'use strict';

    const desktopMenu = document.querySelector('.dropdown-content');
    const mobileMenu = document.querySelector('.mobile-dropdown-content');

    // Guard: only run on pages that have a categories dropdown
    if (!desktopMenu && !mobileMenu) return;

    try {
        const [{ db }, { collection, getDocs, query, orderBy }] = await Promise.all([
            import('./firebase.js'),
            import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
        ]);

        const q = query(collection(db, 'categories'), orderBy('order', 'asc'));
        const snap = await getDocs(q);

        if (snap.empty) return; // Fall back to static HTML if nothing in Firestore

        const categories = snap.docs.map(d => d.data());

        // Icon map — falls back to a generic tag icon for unlisted slugs
        const iconMap = {
            protection: 'fa-shield-halved',
            peace: 'fa-feather-pointed',
            love: 'fa-heart',
            energy: 'fa-bolt-lightning',
            luck: 'fa-clover',
            crystal: 'fa-gem',
            zodiac: 'fa-star',
        };

        function getIcon(link) {
            const slug = (link.split('filter=')[1] || '').toLowerCase();
            return iconMap[slug] || 'fa-tag';
        }

        // ── Desktop dropdown ──────────────────────────────────
        if (desktopMenu) {
            desktopMenu.innerHTML = categories.map(cat => `
                <a href="${cat.link}">
                    <i class="fa-solid ${getIcon(cat.link)}"></i> ${cat.name}
                </a>
            `).join('');
        }

        // ── Mobile dropdown ───────────────────────────────────
        if (mobileMenu) {
            mobileMenu.innerHTML = categories.map(cat => `
                <a href="${cat.link}">${cat.name}</a>
            `).join('');
        }

    } catch (err) {
        // Silently fail — static HTML fallback remains visible
        console.warn('initNavCategories: could not load from Firestore.', err);
    }
})(); // END Dynamic Navbar Categories


/* ============================================================
   THE AURA CIRCLE — VIP Loyalty Drawer Logic
   Add to main.js  OR  inline <script> in both HTML files
   ============================================================ */
(function () {
    'use strict';

    /* ── Config ── */
    const TIER_CONFIG = {
        current: { name: 'The Seeker', threshold: 0 },
        next: { name: 'The Alchemist', threshold: 500 },
    };

    /* ── State (in-session; replace with localStorage for persistence) ── */
    let totalPoints = 340;          // Starting demo points
    const completedActions = new Set();

    /* ── DOM References ── */
    const trigger = document.getElementById('auraTrigger');
    const drawer = document.getElementById('auraDrawer');
    const backdrop = document.getElementById('auraBackdrop');
    const closeBtn = document.getElementById('auraClose');
    const ptDisplay = document.getElementById('auraPoints');
    const fillEl = document.getElementById('auraProgressFill');
    const captionEl = document.getElementById('auraProgressCaption');
    const actionsList = document.getElementById('auraActionsList');

    if (!trigger || !drawer || !backdrop) return; // Guard: not on a page with the drawer

    /* ── Open / Close ── */
    function openDrawer() {
        drawer.classList.add('is-open');
        backdrop.classList.add('is-open');
        drawer.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        // Animate progress bar after drawer slides in
        requestAnimationFrame(() => {
            setTimeout(updateProgress, 200);
        });
    }

    function closeDrawer() {
        drawer.classList.remove('is-open');
        backdrop.classList.remove('is-open');
        drawer.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }

    trigger.addEventListener('click', openDrawer);
    closeBtn.addEventListener('click', closeDrawer);
    backdrop.addEventListener('click', closeDrawer);

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && drawer.classList.contains('is-open')) closeDrawer();
    });

    /* ── Progress Bar ── */
    function updateProgress() {
        const min = TIER_CONFIG.current.threshold;
        const max = TIER_CONFIG.next.threshold;
        const clamped = Math.min(Math.max(totalPoints, min), max);
        const pct = ((clamped - min) / (max - min)) * 100;

        if (fillEl) fillEl.style.width = pct.toFixed(1) + '%';
        if (ptDisplay) ptDisplay.textContent = totalPoints;
        if (captionEl) {
            const remaining = max - totalPoints;
            captionEl.textContent = remaining > 0
                ? remaining + ' pts to unlock ' + TIER_CONFIG.next.name
                : '✦ ' + TIER_CONFIG.next.name + ' unlocked!';
        }
    }

    /* ── Action Clicks (event delegation) ── */
    if (actionsList) {
        actionsList.addEventListener('click', function (e) {
            const btn = e.target.closest('.acd-action__btn');
            if (!btn) return;

            const actionEl = btn.closest('.acd-action[data-id]');
            if (!actionEl) return;

            const id = actionEl.dataset.id;
            const pts = parseInt(actionEl.dataset.pts, 10) || 0;

            // Prevent double-earn
            if (completedActions.has(id)) return;
            completedActions.add(id);

            // Add points
            totalPoints += pts;

            // Mark action done
            actionEl.classList.add('is-done');
            btn.textContent = '✓ Done';

            // Pop the points counter
            if (ptDisplay) {
                ptDisplay.classList.remove('aura-pts-pop');
                void ptDisplay.offsetWidth; // reflow to re-trigger
                ptDisplay.classList.add('aura-pts-pop');
                ptDisplay.addEventListener('animationend', () => {
                    ptDisplay.classList.remove('aura-pts-pop');
                }, { once: true });
            }

            // Update progress bar live
            updateProgress();
        });
    }

    // Initial render (no animation on load — only when drawer opens)
    if (ptDisplay) ptDisplay.textContent = totalPoints;

})();
/* ============================================================ */

/* ============================================================
   LIVE ENERGY PULSE — Social Proof Toast Engine
   Append to the bottom of main.js
   ============================================================ */
(function () {
    'use strict';

    /* ── Data pools ─────────────────────────────────────────── */
    const EP_CITIES = [
        'Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai',
        'Pune', 'Kolkata', 'Jaipur', 'Ahmedabad', 'Surat',
        'Lucknow', 'Chandigarh', 'Indore', 'Bhopal', 'Kochi',
        'Mysore', 'Nagpur', 'Vadodara', 'Udaipur', 'Rishikesh'
    ];

    const EP_PRODUCTS = [
        'Tiger\'s Eye Bracelet',
        'Amethyst Cluster',
        'Rose Quartz Palm Stone',
        'Black Tourmaline Shield',
        'Lapis Lazuli Pendant',
        'Clear Quartz Point',
        'Citrine Abundance Crystal',
        'Obsidian Worry Stone',
        'Moonstone Ring',
        'Labradorite Sphere'
    ];

    /* ── Config ─────────────────────────────────────────────── */
    const EP_CONFIG = {
        minInterval: 45 * 1000,   // 45 s
        maxInterval: 60 * 1000,   // 60 s
        visibleDuration: 4800,    // ms toast stays fully visible
        exitDuration: 400,        // must match CSS animation-duration for epSlideOut
        firstDelay: 12 * 1000,    // wait 12 s before the very first toast
    };

    /* ── Mount point ─────────────────────────────────────────── */
    const mount = document.getElementById('energyPulseMount');
    if (!mount) return; // Guard: only run on pages that include the HTML

    /* ── Helpers ─────────────────────────────────────────────── */
    function epRandom(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }

    function epRandomInterval() {
        return EP_CONFIG.minInterval +
            Math.floor(Math.random() * (EP_CONFIG.maxInterval - EP_CONFIG.minInterval + 1));
    }

    /* ── Toast builder ───────────────────────────────────────── */
    function epShowToast() {
        const city = epRandom(EP_CITIES);
        const product = epRandom(EP_PRODUCTS);

        const toast = document.createElement('div');
        toast.className = 'ep-toast ep-enter';
        toast.setAttribute('role', 'status');
        toast.innerHTML = `
      <span class="ep-toast__icon" aria-hidden="true">✦</span>
      <div class="ep-toast__body">
        <span class="ep-toast__eyebrow">Just now · ${city}</span>
        <p class="ep-toast__message">
          A Seeker just unlocked the <strong>${product}</strong>
        </p>
      </div>
    `;

        mount.appendChild(toast);

        /* Auto-dismiss after visibleDuration */
        setTimeout(function () {
            toast.classList.remove('ep-enter');
            toast.classList.add('ep-exit');

            /* Remove from DOM after exit animation completes */
            setTimeout(function () {
                if (toast.parentNode === mount) mount.removeChild(toast);
            }, EP_CONFIG.exitDuration + 50);
        }, EP_CONFIG.visibleDuration);
    }

    /* ── Scheduler ───────────────────────────────────────────── */
    function epScheduleNext() {
        setTimeout(function () {
            epShowToast();
            epScheduleNext(); // re-schedule with a fresh random interval
        }, epRandomInterval());
    }

    /* Fire the first toast after a short delay, then keep scheduling */
    setTimeout(function () {
        epShowToast();
        epScheduleNext();
    }, EP_CONFIG.firstDelay);

})();
/* ============================================================ */

/* ============================================================
   MYSTICAL PARALLAX PORTAL — mousemove depth effect
   Append to the very bottom of main.js
   ============================================================ */
(function () {
    'use strict';

    const hero = document.getElementById('portalHero');
    const scene = document.getElementById('portalScene');
    const crystal = document.getElementById('portalCrystalLayer');

    if (!hero || !scene || !crystal) return; // Guard: shop page only

    /* ── Tuning ──────────────────────────────────────────────── */
    const SCENE_DEPTH = 18;   // px — background shifts WITH mouse (same direction)
    const CRYSTAL_DEPTH = 28;   // px — crystal shifts AGAINST mouse (opposite direction)

    /* ── Lerp targets (updated on mousemove) ────────────────── */
    let targetPx = 0, targetPy = 0; // scene
    let targetCx = 0, targetCy = 0; // crystal

    /* ── Current lerped values ───────────────────────────────── */
    let px = 0, py = 0;
    let cx = 0, cy = 0;

    /* ── RAF loop — buttery smooth lerp ─────────────────────── */
    const LERP_FACTOR = 0.072; // lower = more lag/silk; higher = snappier
    let rafId = null;
    let isActive = false;

    function tick() {
        // Lerp toward targets
        px += (targetPx - px) * LERP_FACTOR;
        py += (targetPy - py) * LERP_FACTOR;
        cx += (targetCx - cx) * LERP_FACTOR;
        cy += (targetCy - cy) * LERP_FACTOR;

        // Write to CSS custom properties — CSS transition handles the rest
        scene.style.setProperty('--px', px.toFixed(3));
        scene.style.setProperty('--py', py.toFixed(3));
        crystal.style.setProperty('--cx', cx.toFixed(3));
        crystal.style.setProperty('--cy', cy.toFixed(3));

        rafId = requestAnimationFrame(tick);
    }

    /* ── mousemove: calculate normalised offset from hero centre ─ */
    hero.addEventListener('mousemove', function (e) {
        const rect = hero.getBoundingClientRect();
        // normX/Y: -1 (left/top) → 0 (centre) → +1 (right/bottom)
        const normX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
        const normY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;

        // Background drifts in the direction of the cursor
        targetPx = normX * SCENE_DEPTH;
        targetPy = normY * SCENE_DEPTH;

        // Crystal drifts opposite — creates the parallax depth illusion
        targetCx = -normX * CRYSTAL_DEPTH;
        targetCy = -normY * CRYSTAL_DEPTH;

        // Start the RAF loop on first move
        if (!isActive) {
            isActive = true;
            rafId = requestAnimationFrame(tick);
        }
    });

    /* ── mouseleave: drift back to origin ────────────────────── */
    hero.addEventListener('mouseleave', function () {
        targetPx = 0; targetPy = 0;
        targetCx = 0; targetCy = 0;
        // Let the lerp carry everything back; cancel RAF once settled
        const settle = setInterval(function () {
            const allZero =
                Math.abs(px) < 0.05 && Math.abs(py) < 0.05 &&
                Math.abs(cx) < 0.05 && Math.abs(cy) < 0.05;
            if (allZero) {
                cancelAnimationFrame(rafId);
                isActive = false;
                clearInterval(settle);
            }
        }, 100);
    });

    /* ── Touch: disable parallax, leave idle float intact ─────── */
    if (window.matchMedia('(hover: none)').matches) return;

})();
/* ============================================================ */

/* ============================================================
   SECTION: GRAND SYNC — Place Order & Reduce Stock
   ============================================================ */
async function processOrderAndSyncStock(customerDetails, currentCart, finalTotal) {
    try {
        // 1. Import Firebase tools dynamically (jaise tune fetch mein kiya h)
        const [{ db }, { collection, addDoc, doc, writeBatch, increment }] = await Promise.all([
            import('./firebase.js'),
            import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
        ]);

        // 2. Create the Order in 'orders' collection
        const orderRef = await addDoc(collection(db, 'orders'), {
            customer: customerDetails,
            items: currentCart,
            totalAmount: finalTotal,
            status: 'Processing', // Ya 'Payment Pending' agar UPI flow hai
            orderDate: new Date()
        });

        // 3. Batch Update (Ek sath sabka stock kam karna)
        const batch = writeBatch(db);

        currentCart.forEach(cartItem => {
            // Tera banaya hua productMap yahan kaam aayega!
            const productData = window.productMap.get(cartItem.id);

            if (productData && productData._docId) {
                // Exact Firestore document ka reference nikala
                const productRef = doc(db, 'products', productData._docId);

                // Firebase ka 'increment' function safely stock minus kar dega
                // chahe 2 log ek sath order kyu na kar rahe hon!
                batch.update(productRef, {
                    stock: increment(-cartItem.qty)
                });
            }
        });

        // 4. Execute the batch
        await batch.commit();

        console.log("🔥 Grand Sync Success! Order ID:", orderRef.id);

        // Cart clear kar do aur true return karo
        localStorage.removeItem('cartItems');
        updateCounters(); // Ye badge ko wapas 0 kar dega
        return true;

    } catch (error) {
        console.error("🚨 Grand Sync Failed:", error);
        return false;
    }
}

// /* ============================================================
//    AURA CIRCLE — VIP Loyalty Drawer
//    Self-contained IIFE. Safe to paste at the bottom of main.js.
//    Zero global variables. Zero conflicts with existing code.
//    ============================================================ */

// (function auraCircleDrawer() {
//     'use strict';

//     // ── 1. ELEMENT REFS ───────────────────────────────────────────
//     const trigger = document.getElementById('auraTrigger');
//     const drawer = document.getElementById('auraDrawer');
//     const backdrop = document.getElementById('auraBackdrop');
//     const closeBtn = document.getElementById('auraClose');

//     // Guard: exit silently if the drawer isn't on this page
//     if (!trigger || !drawer || !backdrop || !closeBtn) return;

//     const pointsEl = document.getElementById('auraPoints');
//     const progressFill = document.getElementById('auraProgressFill');
//     const progressCaptn = document.getElementById('auraProgressCaption');
//     const actionsList = document.getElementById('auraActionsList');
//     const tierNameEl = drawer.querySelector('.acd-tier__name');
//     const tierIconEl = drawer.querySelector('.acd-tier__icon');
//     const teaserEl = drawer.querySelector('.acd-unlock-teaser__text');


//     // ── 2. MOCK LOYALTY DATA ──────────────────────────────────────
//     //  ↓ Replace getUserLoyaltyData() with your real DB fetch later.
//     //  The rest of the module consumes whatever this returns.

//     function getUserLoyaltyData() {
//         return {
//             points: 500,          // current Aura Points
//             completedActions: ['ig-follow'],  // data-id values already done
//         };
//     }

//     // Tier ladder — add / edit tiers freely here
//     const TIERS = [
//         { name: 'The Seeker', icon: '🔮', min: 0, max: 499 },
//         { name: 'The Alchemist', icon: '✦', min: 500, max: 999 },
//         { name: 'The Oracle', icon: '🌙', min: 1000, max: 1999 },
//         { name: 'The Luminary', icon: '💎', min: 2000, max: Infinity },
//     ];

//     function resolveTier(pts) {
//         const current = TIERS.findLast(t => pts >= t.min) ?? TIERS[0];
//         const nextIdx = TIERS.indexOf(current) + 1;
//         const next = TIERS[nextIdx] ?? null;
//         return { current, next };
//     }


//     // ── 3. UI RENDER ─────────────────────────────────────────────

//     function renderLoyaltyUI(data) {
//         const { points, completedActions } = data;
//         const { current, next } = resolveTier(points);

//         // Points counter (animated roll-up)
//         animateCounter(pointsEl, 0, points, 900);

//         // Tier badge
//         if (tierNameEl) tierNameEl.textContent = current.name;
//         if (tierIconEl) tierIconEl.textContent = current.icon;

//         // Progress bar
//         if (next) {
//             const range = next.min - current.min;
//             const earned = points - current.min;
//             const pct = Math.min(100, Math.round((earned / range) * 100));
//             const remaining = next.min - points;

//             // Small delay so the CSS transition is visible after drawer opens
//             setTimeout(() => {
//                 if (progressFill) progressFill.style.width = pct + '%';
//             }, 220);

//             if (progressCaptn) {
//                 progressCaptn.textContent =
//                     remaining > 0
//                         ? `${remaining} pts to unlock ${next.name}`
//                         : `${next.name} unlocked! ✦`;
//             }

//             // Update teaser text
//             if (teaserEl) {
//                 teaserEl.innerHTML =
//                     remaining > 0
//                         ? `✦ Unlock <strong>${next.name}</strong> for free shipping, early access & a crystal mystery gift.`
//                         : `✦ You've reached <strong>${current.name}</strong>. Enjoy your rewards!`;
//             }

//             // Update progress labels (left label = current tier name)
//             const labels = drawer.querySelectorAll('.acd-progress__labels span');
//             if (labels[0]) labels[0].textContent = current.name;
//             if (labels[1]) labels[1].textContent = next ? `${next.name} ✦` : '✦ Max Tier';

//         } else {
//             // Max tier reached
//             if (progressFill) progressFill.style.width = '100%';
//             if (progressCaptn) progressCaptn.textContent = 'You have reached the highest tier ✦';
//         }

//         // Mark completed actions
//         if (actionsList) {
//             actionsList.querySelectorAll('.acd-action').forEach(li => {
//                 const actionId = li.dataset.id;
//                 const btn = li.querySelector('.acd-action__btn');
//                 if (!btn) return;

//                 if (completedActions.includes(actionId)) {
//                     li.classList.add('is-completed');
//                     btn.textContent = '✓ Done';
//                     btn.disabled = true;
//                     btn.setAttribute('aria-label', 'Action already completed');
//                 } else {
//                     li.classList.remove('is-completed');
//                     btn.disabled = false;
//                 }
//             });
//         }
//     }

//     // Smooth number roll-up
//     function animateCounter(el, from, to, duration) {
//         if (!el) return;
//         const start = performance.now();
//         function step(now) {
//             const elapsed = now - start;
//             const progress = Math.min(elapsed / duration, 1);
//             // Ease-out cubic
//             const eased = 1 - Math.pow(1 - progress, 3);
//             el.textContent = Math.round(from + (to - from) * eased);
//             if (progress < 1) requestAnimationFrame(step);
//         }
//         requestAnimationFrame(step);
//     }


//     // ── 4. OPEN / CLOSE ──────────────────────────────────────────

//     function openDrawer() {
//         drawer.classList.add('is-open');
//         backdrop.classList.add('is-open');
//         drawer.setAttribute('aria-hidden', 'false');
//         trigger.setAttribute('aria-expanded', 'true');
//         document.body.classList.add('aura-drawer-open'); // prevent scroll
//         closeBtn.focus(); // keyboard accessibility

//         // Load (mock) data each time drawer opens —
//         // swap getUserLoyaltyData() for an async fetch later
//         renderLoyaltyUI(getUserLoyaltyData());
//     }

//     function closeDrawer() {
//         drawer.classList.remove('is-open');
//         backdrop.classList.remove('is-open');
//         drawer.setAttribute('aria-hidden', 'true');
//         trigger.setAttribute('aria-expanded', 'false');
//         document.body.classList.remove('aura-drawer-open');
//         trigger.focus(); // return focus to trigger (accessibility)

//         // Reset progress bar width so animation re-plays on next open
//         if (progressFill) progressFill.style.width = '0%';
//     }


//     // ── 5. EVENT LISTENERS (delegated on document) ───────────────

//     // Single delegated listener handles: trigger, close btn, action btns, backdrop
//     document.addEventListener('click', function handleAuraClick(e) {

//         // Open trigger
//         if (e.target.closest('#auraTrigger')) {
//             openDrawer();
//             return;
//         }

//         // Close button
//         if (e.target.closest('#auraClose')) {
//             closeDrawer();
//             return;
//         }

//         // Backdrop click
//         if (e.target.closest('#auraBackdrop')) {
//             closeDrawer();
//             return;
//         }

//         // Earn-points action buttons (inside the drawer)
//         const actionBtn = e.target.closest('#auraActionsList .acd-action__btn');
//         if (actionBtn && !actionBtn.disabled) {
//             handleEarnAction(actionBtn);
//             return;
//         }
//     });

//     // Escape key to close
//     document.addEventListener('keydown', function (e) {
//         if (e.key === 'Escape' && drawer.classList.contains('is-open')) {
//             closeDrawer();
//         }
//     });


//     // ── 6. EARN ACTION HANDLER ────────────────────────────────────
//     //  Handles button clicks for earning points.
//     //  Swap the mock logic inside for your real API call later.

//     function handleEarnAction(btn) {
//         const li = btn.closest('.acd-action');
//         const pts = parseInt(li.dataset.pts, 10) || 0;
//         const actionId = li.dataset.id;

//         // ── MOCK: add points locally & re-render ──
//         // Replace this block with: await yourAPI.earnPoints(actionId, pts)
//         const current = parseInt(pointsEl.textContent, 10) || 0;
//         const updated = current + pts;

//         // Visual feedback on the button itself
//         btn.textContent = `+${pts} ✓`;
//         btn.disabled = true;

//         // Brief highlight pulse on the points counter
//         pointsEl.classList.add('aura-pts-pulse');
//         setTimeout(() => pointsEl.classList.remove('aura-pts-pulse'), 600);

//         // Re-render with updated points
//         renderLoyaltyUI({
//             points: updated,
//             completedActions: getCompletedActionIds().concat(actionId),
//         });
//     }

//     // Helper: reads which actions are already marked done in the DOM
//     function getCompletedActionIds() {
//         if (!actionsList) return [];
//         return Array.from(actionsList.querySelectorAll('.acd-action.is-completed'))
//             .map(li => li.dataset.id);
//     }

//     // ── 7. SCROLL-LOCK STYLE INJECTION ───────────────────────────
//     //  Injects a tiny rule so body doesn't scroll while drawer is open.
//     //  This avoids touching your CSS files.
//     (function injectScrollLock() {
//         const id = 'aura-scroll-lock-style';
//         if (document.getElementById(id)) return;
//         const style = document.createElement('style');
//         style.id = id;
//         style.textContent = `
//       body.aura-drawer-open { overflow: hidden; }

//       /* Optional: subtle pulse on the points number when it updates */
//       .acd-tier__pts-num.aura-pts-pulse {
//         animation: auraPtsFlash 0.55s ease;
//       }
//       @keyframes auraPtsFlash {
//         0%   { opacity: 1; transform: scale(1); }
//         40%  { opacity: 0.6; transform: scale(1.18); color: var(--accent, #7a5c85); }
//         100% { opacity: 1; transform: scale(1); }
//       }
//     `;
//         document.head.appendChild(style);
//     })();

// })(); // end auraCircleDrawer IIFE
/* ============================================================
   AURA KIT BUNDLE BUILDER
   ─────────────────────────────────────────────────────────────
   REPLACE INSTRUCTIONS:
   In main.js, find the block that starts with:
       /* ============================================================
          PHASE 7 — AURA KIT BUNDLE BUILDER IIFE
   ...and ends with:
       })(); // END initAuraKitBuilder IIFE
   Delete that entire block and paste this in its place.

   ALSO: Section 13 must call initAuraKitBuilder() after
   await initProductData(). That line should already be there
   from the previous fix. If not, add it like this:

       await initProductData();
       initHomePage();
       initMoonPhase();
       initAuraKitBuilder();   // ← ensure this line exists
   ============================================================ */

function initAuraKitBuilder() {

    /* ----------------------------------------------------------
       GUARD — only runs on pages that have the Kit section
    ---------------------------------------------------------- */
    const section = document.getElementById('auraKitBuilder');
    if (!section) {
        console.log('[Aura Kit] #auraKitBuilder not found — skipping init.');
        return;
    }

    console.log('[Aura Kit] ── initAuraKitBuilder() called ──');

    /* ----------------------------------------------------------
       CONSTANTS
    ---------------------------------------------------------- */
    const KIT_SIZE = 3;   // minimum crystals to unlock discount
    const KIT_DISCOUNT = 15;  // %

    /* ----------------------------------------------------------
       STATE
       kitSlots: array of product ids (or null for empty).
       Starts at 3 nulls. Grows when user clicks "+ Add More".
    ---------------------------------------------------------- */
    const kitSlots = [null, null, null];

    /* ----------------------------------------------------------
       DOM REFS
    ---------------------------------------------------------- */
    const slotsEl = document.getElementById('auraKitSlots');
    const pickerEl = document.getElementById('auraKitPicker');
    const pricingEl = document.getElementById('auraKitPricing');
    const addBtn = document.getElementById('auraKitAddBtn');
    const hintEl = document.getElementById('auraKitHint');
    const countEl = document.getElementById('auraKitCount');

    console.log('[Aura Kit] DOM refs:', {
        slotsEl: slotsEl ? '✓' : '✗ NULL — check id="auraKitSlots"',
        pickerEl: pickerEl ? '✓' : '✗ NULL — check id="auraKitPicker"',
        pricingEl: pricingEl ? '✓' : '✗ NULL — check id="auraKitPricing"',
        addBtn: addBtn ? '✓' : '✗ NULL — check id="auraKitAddBtn"',
        hintEl: hintEl ? '✓' : '✗ NULL — check id="auraKitHint"',
        countEl: countEl ? '✓' : '✗ NULL — check id="auraKitCount"',
    });

    if (!pickerEl || !slotsEl) {
        console.error('[Aura Kit] FATAL: pickerEl or slotsEl is null. Check IDs in index.html.');
        return;
    }

    /* ----------------------------------------------------------
       productMap is guaranteed populated — Section 13 called
       await initProductData() before calling this function.
    ---------------------------------------------------------- */
    const productCount = productMap ? productMap.size : 0;
    console.log(`[Aura Kit] productMap size at init: ${productCount}`);

    if (productCount === 0) {
        console.warn('[Aura Kit] productMap is empty — showing fallback message.');
        pickerEl.innerHTML =
            '<p style="color:rgba(196,168,216,0.5);padding:20px;font-size:0.85rem;">' +
            'No crystals available right now.</p>';
        return;
    }

    /* ----------------------------------------------------------
       HELPER — resolveProduct
       Tries numeric, string, and original-type key variants so
       Firestore id-type mismatches never silently return null.
    ---------------------------------------------------------- */
    function resolveProduct(id) {
        if (id === null || id === undefined) return null;
        return productMap.get(id)
            || productMap.get(parseInt(id, 10))
            || productMap.get(String(id))
            || null;
    }

    /* ----------------------------------------------------------
       RENDER PICKER
       Clears skeleton placeholders, injects one card per product.
    ---------------------------------------------------------- */
    function renderPicker() {
        const products = [...productMap.values()];
        console.log(`[Aura Kit] renderPicker(): rendering ${products.length} products`);

        const fragment = document.createDocumentFragment();

        products.forEach((p, index) => {
            const isSelected = kitSlots.some(slotId =>
                slotId === p.id ||
                slotId === parseInt(p.id, 10) ||
                slotId === String(p.id)
            );

            const price = (p.salePrice != null && typeof p.salePrice === 'number' && p.salePrice < p.price)
                ? p.salePrice
                : (p.price || 0);

            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'aura-kit-crystal-card' + (isSelected ? ' is-selected' : '');
            card.setAttribute('role', 'listitem');
            card.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
            card.setAttribute('aria-label',
                `${isSelected ? 'Remove' : 'Add'} ${p.name} ${isSelected ? 'from' : 'to'} Aura Kit`);
            card.dataset.productId = p.id;

            card.innerHTML =
                `<img src="${p.image || ''}" alt="${p.name}" loading="lazy">` +
                `<span class="aura-kit-crystal-name">${p.name}</span>` +
                `<span class="aura-kit-crystal-price">₹${price.toLocaleString('en-IN')}</span>`;

            fragment.appendChild(card);

            if (index === 0) {
                console.log('[Aura Kit] First card sample:', { name: p.name, price, isSelected });
            }
        });

        pickerEl.innerHTML = ''; // clear skeleton divs
        pickerEl.appendChild(fragment);
        console.log(`[Aura Kit] renderPicker(): ${products.length} cards injected ✓`);
    }

    /* ----------------------------------------------------------
       RENDER SLOTS
       Syncs slot tray DOM to kitSlots state array.
       Creates new slot elements for indices beyond 2 (expansion).
    ---------------------------------------------------------- */
    function renderSlots() {
        console.log('[Aura Kit] renderSlots() — state:', [...kitSlots]);

        kitSlots.forEach((productId, i) => {
            let slotEl = slotsEl.querySelector(`.aura-kit-slot[data-slot="${i}"]`);

            if (!slotEl) {
                console.log(`[Aura Kit] renderSlots(): creating DOM slot ${i}`);
                const divider = document.createElement('div');
                divider.className = 'aura-kit-slot-divider';
                divider.setAttribute('aria-hidden', 'true');
                divider.textContent = '+';
                slotsEl.appendChild(divider);

                slotEl = document.createElement('div');
                slotEl.className = 'aura-kit-slot';
                slotEl.dataset.slot = i;
                slotEl.setAttribute('aria-label', `Crystal slot ${i + 1}`);
                slotEl.innerHTML =
                    `<div class="aura-kit-slot-inner">` +
                    `<span class="aura-kit-slot-icon">✦</span>` +
                    `<span class="aura-kit-slot-label">Crystal ${i + 1}</span>` +
                    `</div>` +
                    `<button class="aura-kit-slot-remove" data-slot="${i}" ` +
                    `aria-label="Remove crystal ${i + 1}" hidden>` +
                    `<i class="fa-solid fa-xmark"></i>` +
                    `</button>`;
                slotsEl.appendChild(slotEl);
            }

            slotEl.querySelector('img')?.remove(); // clear stale image

            const removeBtn = slotEl.querySelector('.aura-kit-slot-remove');
            const iconEl = slotEl.querySelector('.aura-kit-slot-icon');
            const labelEl = slotEl.querySelector('.aura-kit-slot-label');

            if (productId !== null) {
                const p = resolveProduct(productId);
                if (!p) {
                    console.warn(`[Aura Kit] renderSlots(): id=${productId} not in productMap`);
                    return;
                }
                const img = document.createElement('img');
                img.src = p.image || '';
                img.alt = p.name;
                img.loading = 'lazy';
                slotEl.appendChild(img);
                slotEl.classList.add('is-filled');
                if (removeBtn) removeBtn.hidden = false;
                if (iconEl) iconEl.style.opacity = '0';
                if (labelEl) labelEl.style.opacity = '0';
            } else {
                slotEl.classList.remove('is-filled');
                if (removeBtn) removeBtn.hidden = true;
                if (iconEl) iconEl.style.opacity = '1';
                if (labelEl) labelEl.style.opacity = '1';
            }
        });

        console.log('[Aura Kit] renderSlots(): complete ✓');
    }

    /* ----------------------------------------------------------
       RENDER PRICING
       Updates pricing line, counter badge, and CTA button state.
    ---------------------------------------------------------- */
    function renderPricing() {
        const filled = kitSlots.filter(id => id !== null);
        const fillCount = filled.length;
        console.log(`[Aura Kit] renderPricing(): ${fillCount}/${kitSlots.length} filled`);

        if (countEl) countEl.textContent = fillCount;
        if (hintEl) hintEl.classList.toggle('is-ready', fillCount >= KIT_SIZE);

        if (fillCount < KIT_SIZE) {
            const remaining = KIT_SIZE - fillCount;
            pricingEl.innerHTML =
                `<span class="aura-kit-pricing-label">` +
                `Select ${remaining} more crystal${remaining !== 1 ? 's' : ''} ` +
                `to unlock ${KIT_DISCOUNT}% off</span>`;
            addBtn.disabled = true;
            addBtn.setAttribute('aria-disabled', 'true');
            addBtn.classList.remove('is-ready');
            return;
        }

        let subtotal = 0, totalNormal = 0;
        filled.forEach(id => {
            const p = resolveProduct(id);
            if (!p) return;
            const ep = (p.salePrice != null && typeof p.salePrice === 'number' && p.salePrice < p.price)
                ? p.salePrice : (p.price || 0);
            subtotal += ep;
            totalNormal += (p.price || ep);
        });

        const discountAmt = Math.round(subtotal * KIT_DISCOUNT / 100);
        const finalPrice = subtotal - discountAmt;
        const savings = totalNormal - finalPrice;

        console.log(`[Aura Kit] renderPricing(): subtotal=₹${subtotal} final=₹${finalPrice}`);

        pricingEl.innerHTML =
            `<span class="aura-kit-pricing-label">` +
            `<s style="opacity:0.5;">₹${totalNormal.toLocaleString('en-IN')}</s> ` +
            `→ <strong>₹${finalPrice.toLocaleString('en-IN')}</strong> ` +
            `<em style="color:#a37bb8;">(Save ₹${savings.toLocaleString('en-IN')} — ${KIT_DISCOUNT}% off)</em>` +
            `</span>`;

        addBtn.disabled = false;
        addBtn.setAttribute('aria-disabled', 'false');
        addBtn.classList.add('is-ready');
    }

    /* ----------------------------------------------------------
       TOGGLE CRYSTAL — picker card click handler
    ---------------------------------------------------------- */
    function toggleCrystal(rawId) {
        const numId = parseInt(rawId, 10);
        const searchId = productMap.has(numId) ? numId
            : productMap.has(rawId) ? rawId
                : productMap.has(String(rawId)) ? String(rawId)
                    : rawId;

        console.log(`[Aura Kit] toggleCrystal(): rawId=${rawId} → searchId=${searchId}`);

        const existingSlot = kitSlots.findIndex(id =>
            id === searchId ||
            id === parseInt(searchId, 10) ||
            id === String(searchId)
        );

        if (existingSlot !== -1) {
            console.log(`[Aura Kit] toggleCrystal(): deselecting slot ${existingSlot}`);
            kitSlots[existingSlot] = null;
        } else {
            const emptySlot = kitSlots.indexOf(null);
            if (emptySlot === -1) {
                showToast('All slots filled! Click "+ Add More Crystals" to add another. ✨', 'info');
                return;
            }
            kitSlots[emptySlot] = searchId;
            console.log(`[Aura Kit] toggleCrystal(): added to slot ${emptySlot}`);
            if (kitSlots.filter(s => s !== null).length === KIT_SIZE) {
                showToast('Perfect trio! Your Aura Kit is complete ✦', 'success');
            }
        }

        renderSlots();
        renderPicker();
        renderPricing();
    }

    /* ----------------------------------------------------------
       EXPAND KIT — "+ Add More Crystals"
    ---------------------------------------------------------- */
    function expandKit() {
        if (kitSlots.includes(null)) {
            showToast('You still have an empty slot — fill it first! ✦', 'info');
            return;
        }
        kitSlots.push(null);
        console.log(`[Aura Kit] expandKit(): slots grown to ${kitSlots.length}`);
        renderSlots();
        renderPicker();
        renderPricing();
        slotsEl
            .querySelector(`.aura-kit-slot[data-slot="${kitSlots.length - 1}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        showToast(`Slot ${kitSlots.length} added — keep building your stack! ✦`, 'success');
    }

    /* ----------------------------------------------------------
       ADD KIT TO BAG
    ---------------------------------------------------------- */
    function addKitToBag() {
        const filled = kitSlots.filter(id => id !== null);
        console.log(`[Aura Kit] addKitToBag(): ${filled.length} crystals`);

        if (filled.length < KIT_SIZE) {
            showToast(`Select at least ${KIT_SIZE} crystals to build your Aura Kit.`, 'info');
            return;
        }

        const bundle = {
            id: 'aura-kit-' + Date.now(),
            isStackBundle: true,
            items: filled,
            qty: 1,
            size: 'Medium (17cm)',
            charm: 'None'
        };

        const cart = getCartItems();
        cart.push(bundle);
        saveCartItems(cart);

        const pieceCount = filled.length;
        showToast(
            `Aura Kit (${pieceCount} crystal${pieceCount !== 1 ? 's' : ''}) added — ` +
            `${KIT_DISCOUNT}% bundle discount applied! 🛍️`
        );
        console.log('[Aura Kit] addKitToBag(): bundle saved to cart ✓', bundle);

        kitSlots.length = 0;
        kitSlots.push(null, null, null);

        slotsEl.querySelectorAll('.aura-kit-slot').forEach((el, i) => { if (i > 2) el.remove(); });
        slotsEl.querySelectorAll('.aura-kit-slot-divider').forEach((el, i) => { if (i > 1) el.remove(); });

        renderSlots();
        renderPicker();
        renderPricing();
    }

    /* ----------------------------------------------------------
       WIRE EVENTS
       One delegated listener on document covers picker cards
       and slot remove buttons. Direct listeners for CTAs.
    ---------------------------------------------------------- */
    document.addEventListener('click', function onAuraKitClick(e) {
        const card = e.target.closest('#auraKitPicker .aura-kit-crystal-card');
        if (card) { toggleCrystal(card.dataset.productId); return; }

        const removeBtn = e.target.closest('#auraKitSlots .aura-kit-slot-remove');
        if (removeBtn) {
            const slotIdx = parseInt(removeBtn.dataset.slot, 10);
            console.log(`[Aura Kit] slot ${slotIdx} remove clicked`);
            kitSlots[slotIdx] = null;
            renderSlots();
            renderPicker();
            renderPricing();
        }
    });

    addBtn.addEventListener('click', addKitToBag);

    const expandBtn = document.getElementById('auraKitExpandBtn');
    if (expandBtn) {
        expandBtn.addEventListener('click', expandKit);
    } else {
        console.warn('[Aura Kit] #auraKitExpandBtn not found — expand feature disabled.');
    }

    /* ----------------------------------------------------------
       FIRST RENDER
    ---------------------------------------------------------- */
    renderPicker();
    renderSlots();
    renderPricing();

    console.log('[Aura Kit] ── initAuraKitBuilder() complete ✓ ──');
}