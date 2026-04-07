/* ============================================================
   AURA & EARTH — dashboard.js  (ES Modules · Firebase SDK v10+)
   Features:
     • Auth Guard
     • Products CRUD + Image Upload (ImgBB) + Sale Price + Stock
     • Coupons CRUD (Firestore `coupons` collection)
     • Orders — Real-time fetch + Status update + UTR Verification
     • Invoice Generator (print-only)
     • VIP Customer CRM (top 10 by spend)
     • Smart Inventory — Stock Deduction + Low Stock Alerts
     • Flash Sale — Per-product & Category batch discount
     • Sprint 1 — Global Search (Ctrl+K) + CSV Export
     • Sprint 2 — WhatsApp Button + Quick Status Dropdown
     • Sprint 3 — Settings Page (Firestore `settings/global`)
   Coding Rules:
     • Vanilla JS ES Modules only
     • NO inline onclick — strict Event Delegation throughout
     • All IDs/classes synced with dashboard.html
   ============================================================ */

import { db, auth } from './firebase.js';
import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    collection,
    getDocs,
    getDoc,
    setDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    deleteField,
    doc,
    query,
    orderBy,
    where,
    writeBatch,
    increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ImgBB Configuration (Temporary - will improve later)
const IMGBB_API_KEY = '0232e47eb6276e163d40ff79b7926c26';
const IMGBB_URL = `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`;

if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    console.warn('%c[SECURITY] ImgBB API key is exposed in client code.', 'color: orange; font-weight: bold');
}
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

/* ══════════════════════════════════════════════════════════
   1. AUTH GUARD
══════════════════════════════════════════════════════════ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.replace('admin.html');
        return;
    }

    // Check if this is actually your admin UID
    if (user.uid !== "U02X7M3ow7P3LHghcwRjD8XhuO12") {
        await auth.signOut();
        window.location.replace('admin.html');
        return;
    }

    const emailEl = document.getElementById('userEmail');
    const avatarEl = document.getElementById('userAvatar');
    if (emailEl) emailEl.textContent = user.email;
    if (avatarEl) avatarEl.textContent = user.email.charAt(0).toUpperCase();

    loadProducts();
    loadCoupons();
    loadOrders();
    loadMessages();
    loadCategories();
});


/* ══════════════════════════════════════════════════════════
   2. APP STATE
══════════════════════════════════════════════════════════ */
let allProducts = [];
let allCoupons = [];
let allOrders = [];
let editingProductDocId = null;
let editingCouponDocId = null;
let pendingDeleteProductDocId = null;
let pendingDeleteCouponDocId = null;

const imageFiles = [null, null, null, null];
const imageURLs = [null, null, null, null];


/* ══════════════════════════════════════════════════════════
   3. DOM REFS
══════════════════════════════════════════════════════════ */
const productForm = document.getElementById('productForm');
const editIdField = document.getElementById('editId');
const formHeading = document.getElementById('formHeading');
const formSubheading = document.getElementById('formSubheading');
const submitBtnText = document.getElementById('submitBtnText');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const deleteModal = document.getElementById('deleteModal');
const deleteModalName = document.getElementById('deleteModalName');
const deleteCouponModal = document.getElementById('deleteCouponModal');
const deleteCouponCode = document.getElementById('deleteCouponModalCode');
const uploadProgress = document.getElementById('uploadProgress');
const uploadProgressFill = document.getElementById('uploadProgressFill');


/* ══════════════════════════════════════════════════════════
   4. TOAST NOTIFICATION
══════════════════════════════════════════════════════════ */
function toast(message, type = 'success') {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;

    const icons = {
        success: 'fa-circle-check',
        error: 'fa-circle-xmark',
        info: 'fa-circle-info',
        warning: 'fa-triangle-exclamation'
    };

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icons[type] || icons.success}"></i><span>${message}</span>`;
    wrap.appendChild(el);

    requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
    });

    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(8px)';
        el.style.transition = 'all 0.3s ease';
        setTimeout(() => el.remove(), 320);
    }, 3400);
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}


/* ══════════════════════════════════════════════════════════
   5. LOGOUT
══════════════════════════════════════════════════════════ */
document.getElementById('logoutBtn').addEventListener('click', async () => {
    await signOut(auth);
    window.location.replace('admin.html');
});


/* ══════════════════════════════════════════════════════════
   6. NAVIGATION & UI LOGIC
══════════════════════════════════════════════════════════ */
const tabMap = {
    overview: 'viewOverview',
    products: 'viewProducts',
    coupons: 'viewCoupons',
    orders: 'viewOrders',
    sales: 'viewSales',
    messages: 'viewMessages',
    settings: 'viewSettings',
    stack: 'viewStack',
    categories: 'viewCategories',
};
const titleMap = {
    overview: ['Dashboard', 'Overview'],
    products: ['Products', 'Inventory'],
    coupons: ['Coupons', 'Promotions'],
    orders: ['Orders', 'Fulfilment'],
    sales: ['Flash Sales', 'Discounts'],
    messages: ['Messages', 'Inbox'],
    settings: ['Settings', 'Configuration'],
    stack: ['Stack Builder', 'Homepage'],
    categories: ['Nav Categories', 'Navigation'],
};

function navigateTo(tab, subTab = null) {
    if (!tabMap[tab]) return;

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-tab="${tab}"]`)?.classList.add('active');

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(tabMap[tab])?.classList.add('active');

    const [title, badge] = titleMap[tab];
    setText('viewTitle', title);
    setText('topbarBadge', badge);

    if (tab === 'products' && subTab) {
        showProductSubTab(subTab);
        if (subTab === 'add' && editingProductDocId) {
            setText('viewTitle', 'Edit Product');
            setText('topbarBadge', 'Editing');
        }
    }

    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarBackdrop').classList.remove('show');
}

function showProductSubTab(tab) {
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sub-panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`.sub-tab[data-subtab="${tab}"]`)?.classList.add('active');
    document.getElementById(tab === 'list' ? 'subPanelList' : 'subPanelAdd')?.classList.add('active');
}

// Wire sidebar tabs — guard ensures only buttons with a known tab key trigger navigation.
// The <a class="nav-item" href="index.html"> has no data-tab so tabMap[undefined] is
// falsy and navigateTo() returns early — but we stop it here for absolute safety.
document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    // Only wire elements that are actual <button> elements (not the <a> store link)
    if (btn.tagName !== 'BUTTON') return;
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (!tab || !tabMap[tab]) return; // belt-and-suspenders guard
        navigateTo(tab);
        // If the user clicks Products and data is already loaded, ensure the
        // table is rendered — catches the case where auth resolved but the user
        // was on a different tab and the table was never shown.
        if (tab === 'products' && allProducts.length > 0) {
            renderProductTable(allProducts);
            renderRecentTable(allProducts.slice(0, 5));
        }
        // Settings tab: (re-)load settings from Firestore when navigated to
        if (tab === 'settings') {
            requestAnimationFrame(loadAdminSettings);
        }
        // Stack Builder tab: re-render panel with latest allProducts,
        // and load the current stackDiscount value from Firestore.
        if (tab === 'stack') {
            renderStackBuilderPanel();
            requestAnimationFrame(loadAdminSettings);
        }
        // Messages tab: always fetch fresh from Firestore on navigation
        if (tab === 'messages') {
            loadMessages();
        }
    });
});

// Wire product sub-tabs
document.querySelectorAll('.sub-tab[data-subtab]').forEach(btn => {
    btn.addEventListener('click', () => showProductSubTab(btn.dataset.subtab));
});

// Wire header buttons
document.getElementById('topbarAddBtn').addEventListener('click', () => navigateTo('products', 'add'));
document.getElementById('recentViewAllBtn').addEventListener('click', () => navigateTo('products', 'list'));
document.getElementById('productListAddBtn').addEventListener('click', () => navigateTo('products', 'add'));

// Mobile hamburger
const hamburger = document.getElementById('hamburgerBtn');
const sidebarEl = document.getElementById('sidebar');
const backdrop = document.getElementById('sidebarBackdrop');

hamburger.addEventListener('click', () => {
    sidebarEl.classList.toggle('open');
    backdrop.classList.toggle('show');
});
backdrop.addEventListener('click', () => {
    sidebarEl.classList.remove('open');
    backdrop.classList.remove('show');
});


/* ══════════════════════════════════════════════════════════
   7. LOAD PRODUCTS FROM FIRESTORE
══════════════════════════════════════════════════════════ */
async function loadProducts() {
    showTableSkeletons('productTableBody', 7);
    showTableSkeletons('recentTableBody', 5);
    try {
        const snap = await getDocs(query(collection(db, 'products'), orderBy('name')));
        allProducts = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
        renderAll();
        // Wire table delegation AFTER real rows exist in the DOM.
        // Called on every load so freshly rendered rows are always covered.
        // setupProductTableDelegation is idempotent-safe: it replaces the
        // tbody's innerHTML on render, so old listeners are garbage-collected.
        setupProductTableDelegation('productTableBody');
        setupProductTableDelegation('recentTableBody');
    } catch (err) {
        console.error('[Dashboard] loadProducts:', err);
        toast('Failed to load products. Check console.', 'error');
    }
}

function showTableSkeletons(tbodyId, colCount) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const row = `
        <tr>
            <td><div class="shimmer" style="width:44px;height:44px;border-radius:8px;"></div></td>
            <td>
                <div class="shimmer" style="height:13px;width:130px;margin-bottom:5px;"></div>
                <div class="shimmer" style="height:10px;width:80px;"></div>
            </td>
            ${Array(colCount - 3).fill(`<td><div class="shimmer" style="height:13px;width:60px;"></div></td>`).join('')}
            <td>
                <div style="display:flex;gap:8px;">
                    <div class="shimmer" style="height:28px;width:55px;border-radius:6px;"></div>
                    <div class="shimmer" style="height:28px;width:60px;border-radius:6px;"></div>
                </div>
            </td>
        </tr>
    `;
    tbody.innerHTML = Array(5).fill(row).join('');
}


/* ══════════════════════════════════════════════════════════
   8. RENDER — ALL VIEWS
══════════════════════════════════════════════════════════ */
function renderAll() {
    updateStatCards();
    renderProductTable(allProducts);
    renderRecentTable(allProducts.slice(0, 5));
    renderSaleProductsTable(allProducts.filter(p => p.salePrice != null));
    checkLowStock();
}

function updateStatCards() {
    const productTotal = allProducts.length;
    const cats = new Set(allProducts.map(p => p.category).filter(Boolean)).size;
    setText('sidebarProductCount', productTotal);
    setText('sidebarCatCount', cats);
    setText('productCount', `${productTotal} item${productTotal !== 1 ? 's' : ''}`);

    const orderCount = allOrders.length;
    const totalRevenue = allOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const actionNeeded = allOrders.filter(o => o.status === 'Payment Verification Pending').length;
    const aov = orderCount > 0 ? totalRevenue / orderCount : 0;
    const fmt = n => '₹' + Math.round(n).toLocaleString('en-IN');

    setText('statRevenue', fmt(totalRevenue));
    setText('statOrderCount', orderCount);
    setText('statActionNeeded', actionNeeded);
    setText('statAov', fmt(aov));
}

function buildProductRow(p, colCount) {
    const imgSrc = (p.images && p.images[0]) ? p.images[0] : (p.image || '');
    const price = p.price ? `₹${Number(p.price).toLocaleString('en-IN')}` : '—';
    const salePriceDisplay = p.salePrice != null
        ? `<span class="table-sale-price">₹${Number(p.salePrice).toLocaleString('en-IN')}</span>`
        : `<span style="color:var(--text-muted);font-size:0.8rem;">—</span>`;

    const img = imgSrc
        ? `<img src="${imgSrc}" alt="${p.name}" class="table-img" loading="lazy">`
        : `<div class="table-img-placeholder"><i class="fa-solid fa-gem"></i></div>`;

    const stoneCell = colCount > 5 ? `<td><span style="font-size:0.78rem;color:var(--text-muted);">${p.stone || '—'}</span></td>` : '';
    const salePriceCell = colCount > 6 ? `<td>${salePriceDisplay}</td>` : '';

    return `
        <tr>
            <td>${img}</td>
            <td>
                <div class="table-product-name">${p.name}</div>
                <div class="table-product-stone">${p.description ? p.description.substring(0, 55) + '…' : ''}</div>
            </td>
            <td><span class="category-tag">${p.category || '—'}</span></td>
            ${stoneCell}
            <td class="table-price">${price}</td>
            ${salePriceCell}
            <td>
                <div class="table-actions">
                    <button class="tbl-btn edit"   data-id="${p.docId}"><i class="fa-solid fa-pen"></i> Edit</button>
                    <button class="tbl-btn delete" data-id="${p.docId}"><i class="fa-solid fa-trash"></i> Delete</button>
                </div>
            </td>
        </tr>`;
}

function renderProductTable(products) {
    const tbody = document.getElementById('productTableBody');
    if (!tbody) return;
    if (products.length === 0) {
        tbody.innerHTML = `<tr class="table-status-row"><td colspan="7">No products found. <button class="btn-ghost btn-ghost-add" style="margin-left:10px;padding:5px 12px;font-size:0.78rem;">Add one →</button></td></tr>`;
        return;
    }
    tbody.innerHTML = products.map(p => buildProductRow(p, 7)).join('');
}

function renderRecentTable(products) {
    const tbody = document.getElementById('recentTableBody');
    if (!tbody) return;
    if (products.length === 0) {
        tbody.innerHTML = `<tr class="table-status-row"><td colspan="5">No products yet.</td></tr>`;
        return;
    }
    tbody.innerHTML = products.map(p => buildProductRow(p, 5)).join('');
}


/* ══════════════════════════════════════════════════════════
   TABLE EVENT DELEGATION
══════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════
   STACK BUILDER TOGGLE — Firestore isStackable field
══════════════════════════════════════════════════════════ */
async function toggleStackableStatus(productDocId, currentStatus) {
    try {
        await updateDoc(doc(db, 'products', productDocId), {
            isStackable: !currentStatus
        });
        // Reflect change in local state so UI stays consistent
        // without a full re-fetch
        const p = allProducts.find(x => x.docId === productDocId);
        if (p) p.isStackable = !currentStatus;
        toast(`Stack Builder ${!currentStatus ? 'enabled' : 'disabled'} for product.`, 'success');
    } catch (err) {
        console.error('[Dashboard] toggleStackableStatus:', err);
        toast('Failed to update stack status. Try again.', 'error');
        // Revert the checkbox visually on failure
        const cb = document.querySelector(`.tbl-stack-toggle[data-id="${productDocId}"]`);
        if (cb) cb.checked = currentStatus;
    }
}

function setupProductTableDelegation(tbodyId) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.addEventListener('click', e => {
        const editBtn = e.target.closest('.tbl-btn.edit');
        const delBtn = e.target.closest('.tbl-btn.delete');
        const addGhost = e.target.closest('.btn-ghost-add');

        if (editBtn) startProductEdit(editBtn.dataset.id);
        else if (delBtn) openDeleteProductModal(delBtn.dataset.id);
        else if (addGhost) navigateTo('products', 'add');
    });

    // Toggle uses 'change' event — separate listener on the same tbody
    tbody.addEventListener('change', e => {
        const toggle = e.target.closest('.tbl-stack-toggle');
        if (!toggle) return;

        const docId = toggle.dataset.id;
        const wasEnabled = toggle.dataset.stackable === 'true';

        // Optimistic UI: update label immediately
        const label = toggle.closest('.stack-toggle-wrap')?.querySelector('.stack-toggle-label');
        if (label) {
            label.textContent = wasEnabled ? 'OFF' : 'ON';
            label.classList.toggle('is-on', !wasEnabled);
        }

        // Disable toggle during write to prevent double-clicks
        const toggleEl = toggle.closest('.stack-toggle');
        if (toggleEl) toggleEl.classList.add('is-saving');

        toggleStackableStatus(docId, wasEnabled).finally(() => {
            // Re-enable after write resolves (success or failure)
            if (toggleEl) toggleEl.classList.remove('is-saving');
            // Update data attribute for next toggle
            toggle.dataset.stackable = String(!wasEnabled);
        });
    });
}
/* ══════════════════════════════════════════════════════════
   STACK BUILDER PANEL
   Dedicated view showing all products as image+name cards,
   each with a single isStackable toggle. Clean, focused UX.
══════════════════════════════════════════════════════════ */
async function renderStackBuilderPanel() {
    const grid = document.getElementById('sbGrid');
    const countEl = document.getElementById('sbActiveCount');
    if (!grid) return;

    // Show skeletons while loading
    grid.innerHTML = Array(6).fill('<div class="sb-skeleton"></div>').join('');

    // Use the already-loaded allProducts array — no extra Firestore fetch needed
    if (allProducts.length === 0) {
        grid.innerHTML = `<p class="sb-empty">No products found. Add some products first.</p>`;
        return;
    }

    // Count and display currently active stackable products
    const activeCount = allProducts.filter(p => p.isStackable === true).length;
    if (countEl) countEl.textContent = activeCount;

    grid.innerHTML = allProducts.map(p => {
        const imgSrc = (p.images && p.images[0]) ? p.images[0] : (p.image || '');
        const isOn = p.isStackable === true;
        const img = imgSrc
            ? `<img src="${imgSrc}" alt="${p.name}" class="sb-card-img" loading="lazy">`
            : `<div class="sb-card-img sb-card-img--placeholder"><i class="fa-solid fa-gem"></i></div>`;

        return `
            <div class="sb-card ${isOn ? 'sb-card--on' : ''}" data-doc-id="${p.docId}">
                ${img}
                <div class="sb-card-body">
                    <p class="sb-card-name">${p.name}</p>
                    <p class="sb-card-cat">${p.category || '—'}</p>
                </div>
                <div class="sb-card-toggle-wrap">
                    <label class="stack-toggle" title="${isOn ? 'Remove from Stack Builder' : 'Add to Stack Builder'}">
                        <input type="checkbox"
                               class="sb-toggle-input"
                               data-id="${p.docId}"
                               data-stackable="${isOn}"
                               ${isOn ? 'checked' : ''}>
                        <span class="stack-toggle-track"></span>
                    </label>
                    <span class="stack-toggle-label ${isOn ? 'is-on' : ''}">${isOn ? 'Live' : 'Off'}</span>
                </div>
            </div>`;
    }).join('');
}

// Event delegation for the stack builder grid
document.getElementById('sbGrid')?.addEventListener('change', e => {
    const toggle = e.target.closest('.sb-toggle-input');
    if (!toggle) return;

    const docId = toggle.dataset.id;
    const wasEnabled = toggle.dataset.stackable === 'true';
    const card = toggle.closest('.sb-card');
    const label = toggle.closest('.sb-card-toggle-wrap')?.querySelector('.stack-toggle-label');
    const toggleEl = toggle.closest('.stack-toggle');
    const countEl = document.getElementById('sbActiveCount');

    // Optimistic UI
    card?.classList.toggle('sb-card--on', !wasEnabled);
    if (label) { label.textContent = wasEnabled ? 'Off' : 'Live'; label.classList.toggle('is-on', !wasEnabled); }
    if (toggleEl) toggleEl.classList.add('is-saving');

    // Update active count badge optimistically
    if (countEl) {
        const current = parseInt(countEl.textContent, 10) || 0;
        countEl.textContent = wasEnabled ? current - 1 : current + 1;
    }

    toggleStackableStatus(docId, wasEnabled).finally(() => {
        if (toggleEl) toggleEl.classList.remove('is-saving');
        toggle.dataset.stackable = String(!wasEnabled);
    });
});

// Stack Builder panel rendering is now handled in the unified nav-item
// click handler above — no separate listener needed here.


/* ══════════════════════════════════════════════════════════
   9. PRODUCT SEARCH (topbar)
   ─────────────────────────────────────────────────────────
   Autofill guard: the input starts readonly and only becomes
   interactive on explicit user focus, so the password manager
   never fires an `input` event on load.
   A JS-level ready flag provides a second layer of defence —
   any synthetic `input` event that fires before the user has
   genuinely focused the field is silently discarded.
══════════════════════════════════════════════════════════ */
(function wireTopbarSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;

    // ── Autofill guard ────────────────────────────────────
    // Tracks whether a real user interaction has happened.
    // Stays false until the user explicitly focuses the field.
    let _userActivated = false;

    // Belt-and-suspenders: forcibly blank and re-readonly on load
    // so even aggressive autofill that fires before DOMContentLoaded
    // leaves the field empty.
    input.value = '';
    input.setAttribute('readonly', '');

    input.addEventListener('focus', () => {
        input.removeAttribute('readonly');
        _userActivated = true;
    }, { once: false });

    // Also activate on any genuine pointer/key interaction so
    // programmatic focus() from other code doesn't unlock search.
    input.addEventListener('pointerdown', () => { _userActivated = true; });
    input.addEventListener('keydown', () => { _userActivated = true; });

    let _debounce = null;

    input.addEventListener('input', function () {
        // Discard any event that fired before the user touched the field
        // (covers browser autofill, password manager injection, and
        // any synthetic event dispatched during page hydration).
        if (!_userActivated) {
            input.value = '';
            return;
        }

        clearTimeout(_debounce);
        _debounce = setTimeout(() => {
            const q = input.value.trim().toLowerCase();

            // Navigate to Products › List FIRST so the tbody is live
            // and visible before renderProductTable writes into it.
            if (!document.getElementById('viewProducts')?.classList.contains('active')) {
                navigateTo('products', 'list');
            } else {
                showProductSubTab('list');
            }

            if (!q) {
                renderProductTable(allProducts);
                return;
            }

            const filtered = allProducts.filter(p =>
                (p.name || '').toLowerCase().includes(q) ||
                (p.stone || '').toLowerCase().includes(q) ||
                (p.category || '').toLowerCase().includes(q) ||
                (p.description || '').toLowerCase().includes(q)
            );

            renderProductTable(filtered);
        }, 150);
    });

    // Escape clears search and restores the full product list
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            input.value = '';
            renderProductTable(allProducts);
            input.blur();
        }
    });
})();


/* ══════════════════════════════════════════════════════════
   10. IMAGE UPLOAD ZONES
══════════════════════════════════════════════════════════ */
function buildUploadZones() {
    const grid = document.getElementById('uploadGrid');
    if (!grid) return;
    const labels = ['Main Image', 'Image 2', 'Image 3', 'Image 4'];
    grid.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const zone = document.createElement('div');
        zone.className = 'upload-zone';
        zone.dataset.slot = i;
        zone.innerHTML = `
            <input type="file" accept="image/*" data-slot="${i}">
            <img class="preview-img" alt="preview">
            <i class="fa-solid fa-image"></i>
            <span class="uz-label">${labels[i]}</span>
            <button type="button" class="remove-btn" data-slot="${i}"><i class="fa-solid fa-xmark"></i></button>
            <span class="slot-label">${i === 0 ? 'Main' : '#' + (i + 1)}</span>
        `;
        grid.appendChild(zone);

        zone.querySelector('input[type="file"]').addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            imageFiles[i] = file;
            zone.querySelector('.preview-img').src = URL.createObjectURL(file);
            zone.classList.add('has-image');
        });
        zone.querySelector('.remove-btn').addEventListener('click', e => {
            e.stopPropagation();
            imageFiles[i] = null;
            imageURLs[i] = null;
            zone.querySelector('.preview-img').src = '';
            zone.querySelector('input[type="file"]').value = '';
            zone.classList.remove('has-image');
        });
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (!file || !file.type.startsWith('image/')) return;
            imageFiles[i] = file;
            zone.querySelector('.preview-img').src = URL.createObjectURL(file);
            zone.classList.add('has-image');
        });
    }
}

function populateZones(urls) {
    document.querySelectorAll('.upload-zone').forEach((zone, i) => {
        const url = urls && urls[i] ? urls[i] : null;
        imageURLs[i] = url;
        if (url) {
            zone.querySelector('.preview-img').src = url;
            zone.classList.add('has-image');
        }
    });
}

buildUploadZones();


/* ══════════════════════════════════════════════════════════
   11. IMGBB UPLOAD
══════════════════════════════════════════════════════════ */
async function uploadToImgBB(file) {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch(IMGBB_URL, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`ImgBB HTTP error: ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(`ImgBB API error: ${json.error?.message || 'Unknown'}`);
    return json.data.url;
}

async function uploadImages() {
    const urls = [...imageURLs];
    const toUpload = imageFiles
        .map((file, index) => ({ file, index }))
        .filter(x => x.file !== null);

    if (toUpload.length === 0) return urls;

    uploadProgress.hidden = false;
    uploadProgressFill.style.width = '0%';
    let completed = 0;

    await Promise.all(toUpload.map(async ({ file, index }) => {
        urls[index] = await uploadToImgBB(file);
        completed++;
        uploadProgressFill.style.width = `${Math.round((completed / toUpload.length) * 100)}%`;
    }));

    uploadProgress.hidden = true;
    uploadProgressFill.style.width = '0%';
    return urls;
}


/* ══════════════════════════════════════════════════════════
   12. ADD / EDIT PRODUCT FORM
══════════════════════════════════════════════════════════ */
productForm.addEventListener('submit', async e => {
    e.preventDefault();

    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    submitBtnText.textContent = editingProductDocId ? 'Saving…' : 'Adding…';

    const name = document.getElementById('fName').value.trim();
    const price = parseInt(document.getElementById('fPrice').value, 10);
    const category = document.getElementById('fCategory').value;
    const stone = document.getElementById('fStone').value.trim().toLowerCase();
    const description = document.getElementById('fDescription').value.trim();
    const salePriceIn = document.getElementById('fSalePrice').value;
    const discountPct = document.getElementById('fSaleDiscount').value;
    const stockIn = document.getElementById('fStock').value;

    if (!name || isNaN(price) || price < 1 || !category || !stone || !description) {
        toast('Please fill in all required fields.', 'warning');
        btn.disabled = false;
        submitBtnText.textContent = editingProductDocId ? 'Update Product' : 'Save Product';
        return;
    }

    let salePrice = null;
    if (discountPct && Number(discountPct) > 0) {
        salePrice = Math.round(price * (1 - Number(discountPct) / 100));
    } else if (salePriceIn && Number(salePriceIn) > 0) {
        salePrice = parseInt(salePriceIn, 10);
    }

    try {
        let targetDocId = editingProductDocId;

        if (!editingProductDocId) {
            const numericId = Date.now();
            const newRef = await addDoc(collection(db, 'products'), {
                id: numericId,
                name, price, category, stone, description,
                image: '', images: [], createdAt: numericId
            });
            targetDocId = newRef.id;
        }

        const allURLs = await uploadImages();
        const cleanURLs = allURLs.filter(Boolean);

        const payload = {
            name, price, category, stone, description,
            image: cleanURLs[0] || '',
            images: cleanURLs,
            stock: stockIn !== '' ? Math.max(0, parseInt(stockIn, 10) || 0) : 0
        };

        if (salePrice !== null) {
            payload.salePrice = salePrice;
        } else {
            payload.salePrice = deleteField();
        }

        await updateDoc(doc(db, 'products', targetDocId), payload);
        toast(
            editingProductDocId
                ? `"${name}" updated successfully ✦`
                : `"${name}" added to inventory ✦`,
            'success'
        );
        resetProductForm();
        await loadProducts();
        navigateTo('products', 'list');

    } catch (err) {
        console.error('[Dashboard] save error:', err);
        toast(
            err.message?.includes('ImgBB')
                ? `Image upload failed — ${err.message}`
                : 'Something went wrong. See console.',
            'error'
        );
    } finally {
        btn.disabled = false;
        submitBtnText.textContent = editingProductDocId ? 'Update Product' : 'Save Product';
    }
});

function resetProductForm() {
    productForm.reset();
    editingProductDocId = null;
    editIdField.value = '';
    formHeading.textContent = 'Add New Product';
    formSubheading.textContent = 'Fill in the details below. All fields are required.';
    submitBtnText.textContent = 'Save Product';
    cancelEditBtn.hidden = true;
    for (let i = 0; i < 4; i++) { imageFiles[i] = null; imageURLs[i] = null; }
    buildUploadZones();
}

cancelEditBtn.addEventListener('click', () => {
    resetProductForm();
    navigateTo('products', 'list');
});


/* ══════════════════════════════════════════════════════════
   13. PRODUCT EDIT / DELETE
══════════════════════════════════════════════════════════ */
function startProductEdit(docId) {
    const p = allProducts.find(x => x.docId === docId);
    if (!p) return;

    editingProductDocId = docId;
    editIdField.value = docId;

    document.getElementById('fName').value = p.name || '';
    document.getElementById('fPrice').value = p.price || '';
    document.getElementById('fCategory').value = p.category || '';
    document.getElementById('fStone').value = p.stone || '';
    document.getElementById('fDescription').value = p.description || '';
    document.getElementById('fSalePrice').value = p.salePrice != null ? p.salePrice : '';
    document.getElementById('fSaleDiscount').value = '';
    document.getElementById('fStock').value = typeof p.stock === 'number' ? p.stock : '';

    buildUploadZones();
    const existingImages = (p.images?.length) ? p.images : (p.image ? [p.image] : []);
    populateZones(existingImages);

    formHeading.textContent = 'Edit Product';
    formSubheading.textContent = `Currently editing: ${p.name}`;
    submitBtnText.textContent = 'Update Product';
    cancelEditBtn.hidden = false;

    navigateTo('products', 'add');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openDeleteProductModal(docId) {
    const p = allProducts.find(x => x.docId === docId);
    if (!p) return;
    pendingDeleteProductDocId = docId;
    deleteModalName.textContent = p.name;
    deleteModal.classList.add('is-open');
}

document.getElementById('cancelDeleteBtn').addEventListener('click', () => {
    deleteModal.classList.remove('is-open');
    pendingDeleteProductDocId = null;
});

document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
    if (!pendingDeleteProductDocId) return;
    const p = allProducts.find(x => x.docId === pendingDeleteProductDocId);
    const btn = document.getElementById('confirmDeleteBtn');
    deleteModal.classList.remove('is-open');
    btn.disabled = true;
    try {
        await deleteDoc(doc(db, 'products', pendingDeleteProductDocId));
        toast(`"${p?.name || 'Product'}" deleted.`, 'info');
        await loadProducts();
    } catch (err) {
        console.error('[Dashboard] delete error:', err);
        toast('Delete failed. Please try again.', 'error');
    } finally {
        btn.disabled = false;
        pendingDeleteProductDocId = null;
    }
});

deleteModal.addEventListener('click', e => {
    if (e.target === deleteModal) {
        deleteModal.classList.remove('is-open');
        pendingDeleteProductDocId = null;
    }
});


/* ══════════════════════════════════════════════════════════
   14. COUPONS — CRUD
══════════════════════════════════════════════════════════ */
async function loadCoupons() {
    const tbody = document.getElementById('couponTableBody');
    if (tbody) tbody.innerHTML = `<tr class="table-status-row"><td colspan="4"><div class="shimmer" style="height:13px;width:200px;margin:0 auto;"></div></td></tr>`;

    try {
        const snap = await getDocs(query(collection(db, 'coupons'), orderBy('code')));
        allCoupons = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
        renderCouponTable(allCoupons);
        setText('couponCount', allCoupons.length);
    } catch (err) {
        console.error('[Dashboard] loadCoupons:', err);
        toast('Failed to load coupons.', 'error');
    }
}

function renderCouponTable(coupons) {
    const tbody = document.getElementById('couponTableBody');
    if (!tbody) return;

    if (coupons.length === 0) {
        tbody.innerHTML = `<tr class="table-status-row"><td colspan="4">No coupons yet. Create one!</td></tr>`;
        return;
    }

    tbody.innerHTML = coupons.map(c => `
        <tr>
            <td>
                <span style="font-family:'DM Mono','Courier New',monospace;font-weight:700;font-size:0.85rem;
                    background:var(--sage-dim);color:var(--sage-dark);padding:3px 10px;border-radius:5px;
                    border:1px solid var(--sage-border);letter-spacing:1px;">
                    ${c.code}
                </span>
            </td>
            <td>
                <span class="status-badge Pending" style="background:var(--amber-dim);color:var(--amber);border-color:rgba(196,149,74,0.25);">
                    ${c.discount}% OFF
                </span>
            </td>
            <td style="color:var(--text-muted);font-size:0.8rem;">${c.description || '—'}</td>
            <td>
                <div class="table-actions">
                    <button class="tbl-btn edit coupon-edit-btn"   data-id="${c.docId}"><i class="fa-solid fa-pen"></i> Edit</button>
                    <button class="tbl-btn delete coupon-delete-btn" data-id="${c.docId}"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        </tr>`
    ).join('');
}

const couponTableBody = document.getElementById('couponTableBody');
if (couponTableBody) {
    couponTableBody.addEventListener('click', e => {
        const editBtn = e.target.closest('.coupon-edit-btn');
        const delBtn = e.target.closest('.coupon-delete-btn');
        if (editBtn) startCouponEdit(editBtn.dataset.id);
        else if (delBtn) openDeleteCouponModal(delBtn.dataset.id);
    });
}

const couponForm = document.getElementById('couponForm');
couponForm.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('couponSubmitBtn');
    const btnText = document.getElementById('couponSubmitBtnText');
    btn.disabled = true;
    btnText.textContent = editingCouponDocId ? 'Saving…' : 'Creating…';

    const code = document.getElementById('cCode').value.trim().toUpperCase();
    const discount = parseInt(document.getElementById('cDiscount').value, 10);
    const description = document.getElementById('cDescription').value.trim();

    if (!code || isNaN(discount) || discount < 1 || discount > 100) {
        toast('Please enter a valid code and discount (1–100).', 'warning');
        btn.disabled = false;
        btnText.textContent = editingCouponDocId ? 'Update Coupon' : 'Create Coupon';
        return;
    }

    try {
        const payload = { code, discount, description, updatedAt: Date.now() };
        if (editingCouponDocId) {
            await updateDoc(doc(db, 'coupons', editingCouponDocId), payload);
            toast(`Coupon "${code}" updated ✦`, 'success');
        } else {
            payload.createdAt = Date.now();
            await addDoc(collection(db, 'coupons'), payload);
            toast(`Coupon "${code}" created ✦`, 'success');
        }
        resetCouponForm();
        await loadCoupons();
    } catch (err) {
        console.error('[Dashboard] coupon save error:', err);
        toast('Failed to save coupon.', 'error');
    } finally {
        btn.disabled = false;
        btnText.textContent = editingCouponDocId ? 'Update Coupon' : 'Create Coupon';
    }
});

function startCouponEdit(docId) {
    const c = allCoupons.find(x => x.docId === docId);
    if (!c) return;
    editingCouponDocId = docId;
    document.getElementById('couponEditId').value = docId;
    document.getElementById('cCode').value = c.code || '';
    document.getElementById('cDiscount').value = c.discount || '';
    document.getElementById('cDescription').value = c.description || '';
    document.getElementById('couponFormHeading').textContent = 'Edit Coupon';
    document.getElementById('couponFormSubheading').textContent = `Editing: ${c.code}`;
    document.getElementById('couponSubmitBtnText').textContent = 'Update Coupon';
    document.getElementById('cancelCouponEditBtn').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetCouponForm() {
    couponForm.reset();
    editingCouponDocId = null;
    document.getElementById('couponEditId').value = '';
    document.getElementById('couponFormHeading').textContent = 'Create Coupon';
    document.getElementById('couponFormSubheading').textContent = 'Add a new promotional code.';
    document.getElementById('couponSubmitBtnText').textContent = 'Create Coupon';
    document.getElementById('cancelCouponEditBtn').hidden = true;
}

document.getElementById('cancelCouponEditBtn').addEventListener('click', resetCouponForm);

function openDeleteCouponModal(docId) {
    const c = allCoupons.find(x => x.docId === docId);
    if (!c) return;
    pendingDeleteCouponDocId = docId;
    deleteCouponCode.textContent = c.code;
    deleteCouponModal.classList.add('is-open');
}

document.getElementById('cancelDeleteCouponBtn').addEventListener('click', () => {
    deleteCouponModal.classList.remove('is-open');
    pendingDeleteCouponDocId = null;
});

document.getElementById('confirmDeleteCouponBtn').addEventListener('click', async () => {
    if (!pendingDeleteCouponDocId) return;
    const c = allCoupons.find(x => x.docId === pendingDeleteCouponDocId);
    const btn = document.getElementById('confirmDeleteCouponBtn');
    deleteCouponModal.classList.remove('is-open');
    btn.disabled = true;
    try {
        await deleteDoc(doc(db, 'coupons', pendingDeleteCouponDocId));
        toast(`Coupon "${c?.code || ''}" deleted.`, 'info');
        await loadCoupons();
    } catch (err) {
        console.error('[Dashboard] coupon delete error:', err);
        toast('Delete failed.', 'error');
    } finally {
        btn.disabled = false;
        pendingDeleteCouponDocId = null;
    }
});

deleteCouponModal.addEventListener('click', e => {
    if (e.target === deleteCouponModal) {
        deleteCouponModal.classList.remove('is-open');
        pendingDeleteCouponDocId = null;
    }
});


/* ══════════════════════════════════════════════════════════
   15. ORDERS — FETCH, RENDER, STATUS UPDATE & UTR VERIFY
══════════════════════════════════════════════════════════ */
async function loadOrders() {
    const tbody = document.getElementById('ordersTableBody');
    if (tbody) tbody.innerHTML = `<tr class="table-status-row"><td colspan="8">Loading orders…</td></tr>`;

    try {
        const snap = await getDocs(query(collection(db, 'orders'), orderBy('createdAt', 'desc')));
        allOrders = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
        renderOrdersTable(allOrders);
        updateOrdersBadge(allOrders);
        updateStatCards();
    } catch (err) {
        console.error('[Dashboard] loadOrders:', err);
        toast('Failed to load orders. Check Firestore rules.', 'error');
    }
}

function updateOrdersBadge(orders) {
    const pending = orders.filter(o => o.status === 'Payment Verification Pending').length;
    const badge = document.getElementById('pendingOrdersBadge');
    if (badge) {
        badge.textContent = pending;
        badge.style.display = pending > 0 ? 'flex' : 'none';
    }
}

function formatOrderDate(ts) {
    if (!ts) return '—';
    const date = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderOrdersTable(orders) {
    const tbody = document.getElementById('ordersTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (orders.length === 0) {
        const tr = document.createElement('tr');
        tr.className = 'table-status-row';
        const td = document.createElement('td');
        td.colSpan = 8;
        td.textContent = 'No orders found.';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }

    orders.forEach(o => {
        const status = o.status || 'Pending';
        const totalText = o.total != null
            ? `₹${Number(o.total).toLocaleString('en-IN')}`
            : '—';
        const name = o.customerName || o.customer?.name || '—';
        const email = o.customerEmail || o.customer?.email || '';
        const phone = o.customerPhone || o.customer?.phone || '';
        const itemsText = o.items?.length
            ? `${o.items.length} item${o.items.length !== 1 ? 's' : ''}`
            : '—';
        const orderId = o.orderId || o.docId.substring(0, 8).toUpperCase();
        const dateText = formatOrderDate(o.createdAt);

        const tr = document.createElement('tr');

        // Order ID
        const idTd = document.createElement('td');
        idTd.style.fontFamily = "'DM Mono','Courier New',monospace";
        idTd.style.fontSize = '0.78rem';
        idTd.style.color = 'var(--text-soft)';
        idTd.textContent = `#${orderId}`;
        tr.appendChild(idTd);

        // Customer
        const customerTd = document.createElement('td');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'table-product-name';
        nameDiv.textContent = name;
        const emailDiv = document.createElement('div');
        emailDiv.className = 'table-product-stone';
        emailDiv.textContent = email;
        customerTd.appendChild(nameDiv);
        customerTd.appendChild(emailDiv);
        tr.appendChild(customerTd);

        // Items
        const itemsTd = document.createElement('td');
        itemsTd.style.color = 'var(--text-muted)';
        itemsTd.style.fontSize = '0.8rem';
        itemsTd.textContent = itemsText;
        tr.appendChild(itemsTd);

        // Total
        const totalTd = document.createElement('td');
        totalTd.className = 'table-price';
        totalTd.textContent = totalText;
        tr.appendChild(totalTd);

        // Date
        const dateTd = document.createElement('td');
        dateTd.style.fontSize = '0.8rem';
        dateTd.style.color = 'var(--text-muted)';
        dateTd.textContent = dateText;
        tr.appendChild(dateTd);

        // UTR
        const utrTd = document.createElement('td');
        if (o.utrNumber) {
            const utrSpan = document.createElement('span');
            utrSpan.style.cssText = "font-family:'DM Mono','Courier New',monospace;font-size:0.75rem;";
            utrSpan.textContent = o.utrNumber;
            utrTd.appendChild(utrSpan);
        } else {
            utrTd.textContent = '—';
            utrTd.style.color = 'var(--text-muted)';
        }
        tr.appendChild(utrTd);

        // Status cell
        const statusTd = document.createElement('td');
        statusTd.style.cssText = 'display:flex;align-items:center;gap:8px;';

        const select = document.createElement('select');
        select.className = 'order-status-select';
        select.dataset.orderId = o.docId;
        select.dataset.currentStatus = status;

        ['Payment Verification Pending', 'Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'].forEach(val => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            if (val === status) opt.selected = true;
            select.appendChild(opt);
        });
        statusTd.appendChild(select);

        if (status === 'Payment Verification Pending') {
            const verifyBtn = document.createElement('button');
            verifyBtn.className = 'tbl-btn verify-payment-btn';
            verifyBtn.dataset.orderId = o.docId;
            verifyBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Verify';
            statusTd.appendChild(verifyBtn);
        }

        const printBtn = document.createElement('button');
        printBtn.className = 'tbl-btn print-invoice-btn';
        printBtn.dataset.orderId = o.docId;
        printBtn.title = 'Print invoice / packing slip';
        printBtn.innerHTML = '<i class="fa-solid fa-print"></i>';
        statusTd.appendChild(printBtn);

        tr.appendChild(statusTd);

        // Actions — WhatsApp
        const actionsTd = document.createElement('td');
        const waBtn = document.createElement('button');
        waBtn.className = 'tbl-btn whatsapp-btn';
        waBtn.dataset.orderId = o.docId;
        waBtn.title = phone ? `WhatsApp ${name}` : 'No phone number on this order';
        waBtn.disabled = !phone;
        waBtn.innerHTML = '<i class="fa-brands fa-whatsapp"></i>';
        actionsTd.appendChild(waBtn);

        tr.appendChild(actionsTd);
        tbody.appendChild(tr);
    });
}

// ── verifyPayment ────────────────────────────────────────────────
async function verifyPayment(orderDocId) {
    const btn = document.querySelector(`.verify-payment-btn[data-order-id="${orderDocId}"]`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }

    try {
        await updateDoc(doc(db, 'orders', orderDocId), {
            status: 'Pending',
            paymentVerified: true
        });

        const order = allOrders.find(o => o.docId === orderDocId);
        if (order?.items?.length) {
            const batch = writeBatch(db);
            let batchHasOps = false;

            order.items.forEach(item => {
                const product = allProducts.find(p => String(p.id) === String(item.id));
                if (!product?.docId) {
                    console.warn(`[Dashboard] verifyPayment: product "${item.id}" not found — skipping stock decrement.`);
                    return;
                }
                const qty = Math.max(1, Number(item.qty) || 1);
                batch.update(doc(db, 'products', product.docId), { stock: increment(-qty) });
                batchHasOps = true;
            });

            if (batchHasOps) {
                await batch.commit();
                order.items.forEach(item => {
                    const product = allProducts.find(p => String(p.id) === String(item.id));
                    if (!product) return;
                    const qty = Math.max(1, Number(item.qty) || 1);
                    product.stock = (typeof product.stock === 'number' ? product.stock : 0) - qty;
                });
            }
        }

        if (order) {
            order.status = 'Pending';
            order.paymentVerified = true;
        }

        toast('Payment verified — stock updated.', 'success');
        updateOrdersBadge(allOrders);
        updateStatCards();
        checkLowStock();
        renderOrdersTable(allOrders);

    } catch (err) {
        console.error('[Dashboard] verifyPayment error:', err);
        toast('Verification failed. Check console.', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> Verify'; }
    }
}

// ── printInvoice ─────────────────────────────────────────────────
function printInvoice(order) {
    const fmt = n => '₹' + Number(n || 0).toLocaleString('en-IN');
    const orderId = order.orderId || (order.docId || '').substring(0, 8).toUpperCase();

    document.getElementById('inv-order-id').textContent = '#' + orderId;
    document.getElementById('inv-date').textContent = formatOrderDate(order.createdAt);
    document.getElementById('inv-status').textContent = order.status || 'Pending';
    document.getElementById('inv-cust-name').textContent = order.customerName || '—';
    document.getElementById('inv-cust-email').textContent = order.customerEmail || '—';
    document.getElementById('inv-cust-phone').textContent = order.customerPhone || '—';
    document.getElementById('inv-cust-addr').textContent = order.customerAddress || '—';
    document.getElementById('inv-utr').textContent = order.utrNumber || 'N/A';
    document.getElementById('inv-payment').textContent = order.paymentMethod || 'UPI';

    const itemsTbody = document.getElementById('inv-items-body');
    const items = Array.isArray(order.items) ? order.items : [];

    if (items.length === 0) {
        itemsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#888;padding:16px;">No item details available.</td></tr>`;
    } else {
        itemsTbody.innerHTML = items.map((item, i) => {
            const ep = (item.salePrice != null && typeof item.salePrice === 'number' && item.salePrice < item.price)
                ? item.salePrice
                : (item.effectivePrice || item.price || 0);
            const lineTotal = ep * (item.qty || 1);
            return `
            <tr>
                <td>${i + 1}</td>
                <td>
                    <strong>${esc(item.name) || '—'}</strong>
${item.size ? `<br><span>Size: ${esc(item.size)}</span>` : ''}
${item.charm ? `<br><span>Charm: ${esc(item.charm)}</span>` : ''}

                </td>
                <td style="text-align:center;">${item.qty || 1}</td>
                <td style="text-align:right;">${fmt(ep)}</td>
                <td style="text-align:right;">${fmt(lineTotal)}</td>
            </tr>`;
        }).join('');
    }

    document.getElementById('inv-subtotal').textContent = fmt(order.subtotal);
    document.getElementById('inv-discount').textContent = order.discount ? `-${fmt(order.discount)}` : '—';
    document.getElementById('inv-shipping').textContent = order.shipping === 0 ? 'FREE' : fmt(order.shipping);
    document.getElementById('inv-total').textContent = fmt(order.total);
    document.getElementById('inv-coupon').textContent = order.coupon || '—';
    document.getElementById('inv-notes').textContent = order.notes || '—';

    window.print();
}


/* ══════════════════════════════════════════════════════════
   VIP CUSTOMER CRM
══════════════════════════════════════════════════════════ */
function getTopCustomers(orders, limit = 10) {
    const map = new Map();

    orders.forEach(o => {
        const email = (o.customerEmail || '').toLowerCase().trim();
        if (!email) return;
        const spent = Number(o.total) || 0;

        if (map.has(email)) {
            const existing = map.get(email);
            existing.totalSpent += spent;
            existing.orderCount += 1;
            if (existing.name === '—' && o.customerName) existing.name = o.customerName;
            if (existing.phone === '—' && o.customerPhone) existing.phone = o.customerPhone;
        } else {
            map.set(email, {
                email,
                name: o.customerName || '—',
                phone: o.customerPhone || '—',
                totalSpent: spent,
                orderCount: 1
            });
        }
    });

    return [...map.values()]
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, limit);
}

function openVipModal() {
    const modal = document.getElementById('vipModal');
    const tbody = document.getElementById('vipTableBody');
    if (!modal || !tbody) return;

    const top = getTopCustomers(allOrders);
    const fmt = n => '₹' + Math.round(n).toLocaleString('en-IN');
    const medals = ['🥇', '🥈', '🥉'];

    if (top.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted);">No order data yet.</td></tr>`;
    } else {
        tbody.innerHTML = top.map((c, i) => `
            <tr class="${i < 3 ? 'vip-row--medal' : ''}">
                <td class="vip-rank">
                    ${i < 3
                ? `<span class="vip-medal">${medals[i]}</span>`
                : `<span class="vip-rank-num">${i + 1}</span>`}
                </td>
                <td>
                    <div class="vip-cust-name">${c.name}</div>
                    <div class="vip-cust-email">${c.email}</div>
                </td>
                <td class="vip-phone">${c.phone}</td>
                <td class="vip-orders">${c.orderCount}</td>
                <td class="vip-spent">${fmt(c.totalSpent)}</td>
            </tr>`).join('');
    }

    modal.classList.add('is-open');
    document.body.style.overflow = 'hidden';
}

function closeVipModal() {
    const modal = document.getElementById('vipModal');
    if (!modal) return;
    modal.classList.remove('is-open');
    document.body.style.overflow = '';
}

document.getElementById('openVipBtn')?.addEventListener('click', openVipModal);
document.getElementById('closeVipBtn')?.addEventListener('click', closeVipModal);
document.getElementById('vipModal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('vipModal')) closeVipModal();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('vipModal')?.classList.contains('is-open')) {
        closeVipModal();
    }
});


/* ══════════════════════════════════════════════════════════
   ORDERS — Event Delegation
══════════════════════════════════════════════════════════ */
const ordersView = document.getElementById('viewOrders');
if (ordersView) {

    ordersView.addEventListener('change', async e => {
        const sel = e.target.closest('.order-status-select');
        if (!sel) return;

        const orderId = sel.dataset.orderId;
        const newStatus = sel.value;
        const oldStatus = sel.dataset.currentStatus;
        if (newStatus === oldStatus) return;

        try {
            await updateDoc(doc(db, 'orders', orderId), { status: newStatus });
            sel.dataset.currentStatus = newStatus;
            toast(`Order status updated to "${newStatus}"`, 'success');
            const order = allOrders.find(o => o.docId === orderId);
            if (order) order.status = newStatus;
            updateOrdersBadge(allOrders);
            updateStatCards();
        } catch (err) {
            console.error('[Dashboard] order status update error:', err);
            sel.value = oldStatus;
            toast('Failed to update order status.', 'error');
        }
    });

    ordersView.addEventListener('click', e => {
        const chip = e.target.closest('.filter-chip');
        if (chip) {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            const filter = chip.dataset.statusFilter;
            const filtered = filter === 'all'
                ? allOrders
                : allOrders.filter(o => (o.status || 'Pending') === filter);
            renderOrdersTable(filtered);
            return;
        }

        const verifyBtn = e.target.closest('.verify-payment-btn');
        if (verifyBtn) { verifyPayment(verifyBtn.dataset.orderId); return; }

        const printBtn = e.target.closest('.print-invoice-btn');
        if (printBtn) {
            const order = allOrders.find(o => o.docId === printBtn.dataset.orderId);
            if (order) printInvoice(order);
            return;
        }

        const waBtn = e.target.closest('.whatsapp-btn');
        if (waBtn && !waBtn.disabled) {
            const order = allOrders.find(o => o.docId === waBtn.dataset.orderId);
            if (!order) return;

            const phone = (order.customerPhone || '').replace(/\D/g, '');
            if (!phone) { toast('No phone number on this order.', 'warning'); return; }

            const itemsSummary = Array.isArray(order.items) && order.items.length
                ? order.items.map(i => `${i.name || 'item'}${i.qty > 1 ? ` x${i.qty}` : ''}`).join(', ')
                : 'your recent purchase';

            const message = `Hi ${order.customerName || 'there'}, your Aura & Earth order for ${itemsSummary} is currently *${order.status || 'being processed'}*! Thank you for shopping with us. ✦`;
            window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
        }
    });
}


/* ══════════════════════════════════════════════════════════
   16. FLASH SALE — PER-PRODUCT & CATEGORY BATCH UPDATE
══════════════════════════════════════════════════════════ */
function renderSaleProductsTable(products) {
    const tbody = document.getElementById('saleProductsTableBody');
    if (!tbody) return;
    setText('onSaleCount', products.length);

    if (products.length === 0) {
        tbody.innerHTML = `<tr class="table-status-row"><td colspan="6">No products are currently on sale.</td></tr>`;
        return;
    }

    tbody.innerHTML = products.map(p => {
        const discountPct = p.price && p.salePrice
            ? Math.round((1 - p.salePrice / p.price) * 100)
            : '—';
        return `
        <tr>
            <td><div class="table-product-name">${p.name}</div></td>
            <td><span class="category-tag">${p.category || '—'}</span></td>
            <td class="table-price">₹${Number(p.price).toLocaleString('en-IN')}</td>
            <td class="table-sale-price">₹${Number(p.salePrice).toLocaleString('en-IN')}</td>
            <td><span class="sale-discount-badge">${discountPct}% OFF</span></td>
            <td>
                <button class="tbl-btn remove-sale sale-remove-btn" data-id="${p.docId}">
                    <i class="fa-solid fa-xmark"></i> Remove
                </button>
            </td>
        </tr>`;
    }).join('');
}

const saleProductsTbody = document.getElementById('saleProductsTableBody');
if (saleProductsTbody) {
    saleProductsTbody.addEventListener('click', async e => {
        const btn = e.target.closest('.sale-remove-btn');
        if (!btn) return;
        btn.disabled = true;
        try {
            await updateDoc(doc(db, 'products', btn.dataset.id), {
                salePrice: deleteField(),
                discount: deleteField()
            });
            toast('Sale price removed from product.', 'success');
            await loadProducts();
        } catch (err) {
            console.error('[Dashboard] remove sale error:', err);
            toast('Failed to remove sale price.', 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

document.getElementById('refreshSaleListBtn').addEventListener('click', async () => {
    await loadProducts();
    toast('Sale list refreshed.', 'info');
});

const categorySaleForm = document.getElementById('categorySaleForm');
categorySaleForm.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('applyCategorySaleBtn');
    const btnText = document.getElementById('categorySaleBtnText');

    const category = (document.getElementById('saleCategory').value || '').trim().toLowerCase();
    const discount = parseInt(document.getElementById('saleDiscountPct').value, 10);

    if (!category || isNaN(discount) || discount < 1 || discount > 99) {
        toast('Please select a category and enter a valid discount (1–99%).', 'warning');
        return;
    }

    btn.disabled = true;
    btnText.textContent = 'Applying…';

    try {
        const inCategory = allProducts.filter(p =>
            (p.category || '').trim().toLowerCase() === category && p.docId
        );

        if (inCategory.length === 0) {
            toast(`No products found in "${category}". Check the category spelling in Firestore.`, 'info');
            return;
        }

        const BATCH_LIMIT = 490;
        let opCount = 0;
        let batch = writeBatch(db);

        for (const product of inCategory) {
            if (!product.docId || typeof product.price !== 'number') continue;
            const newSalePrice = Math.round(product.price * (1 - discount / 100));
            batch.update(doc(db, 'products', product.docId), { salePrice: newSalePrice, discount });
            opCount++;
            if (opCount % BATCH_LIMIT === 0) { await batch.commit(); batch = writeBatch(db); }
        }

        if (opCount % BATCH_LIMIT !== 0) await batch.commit();

        toast(`✦ ${discount}% sale applied to ${opCount} product${opCount !== 1 ? 's' : ''} in "${category}"`, 'success');
        categorySaleForm.reset();
        await loadProducts();

    } catch (err) {
        console.error('[Dashboard] category sale error:', err);
        toast('Category sale failed. See console for details.', 'error');
    } finally {
        btn.disabled = false;
        btnText.textContent = 'Apply to Category';
    }
});

const removeCategorySaleForm = document.getElementById('removeCategorySaleForm');
removeCategorySaleForm.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('removeCategorySaleBtn');

    const category = (document.getElementById('clearSaleCategory').value || '').trim().toLowerCase();
    if (!category) { toast('Please select a category.', 'warning'); return; }

    btn.disabled = true;

    try {
        const inCategory = allProducts.filter(p =>
            (p.category || '').trim().toLowerCase() === category &&
            p.salePrice != null && p.docId
        );

        if (inCategory.length === 0) {
            toast(`No active sales found in "${category}".`, 'info');
            return;
        }

        const BATCH_LIMIT = 490;
        let opCount = 0;
        let batch = writeBatch(db);

        for (const product of inCategory) {
            batch.update(doc(db, 'products', product.docId), {
                salePrice: deleteField(),
                discount: deleteField()
            });
            opCount++;
            if (opCount % BATCH_LIMIT === 0) { await batch.commit(); batch = writeBatch(db); }
        }

        if (opCount % BATCH_LIMIT !== 0) await batch.commit();

        toast(`Sale removed from ${opCount} product${opCount !== 1 ? 's' : ''} in "${category}".`, 'success');
        removeCategorySaleForm.reset();
        await loadProducts();

    } catch (err) {
        console.error('[Dashboard] remove category sale error:', err);
        toast('Failed to remove sale prices. See console.', 'error');
    } finally {
        btn.disabled = false;
    }
});


/* ══════════════════════════════════════════════════════════
   VIP MODAL — Injected styles
══════════════════════════════════════════════════════════ */
(function injectVipStyles() {
    const css = `
    .page-intro-row {
        display: flex; align-items: flex-end;
        justify-content: space-between; margin-bottom: 28px; gap: 16px;
    }
    .page-intro-row .page-intro { margin-bottom: 0; }

    .btn-vip {
        display: inline-flex; align-items: center; gap: 8px; padding: 9px 20px;
        background: linear-gradient(135deg, #a8893a 0%, #c4a84a 100%);
        color: #fff; border-radius: 10px; font-size: 0.82rem; font-weight: 600;
        font-family: inherit; border: none; cursor: pointer; transition: all 0.18s ease;
        box-shadow: 0 2px 10px rgba(168,137,58,0.25); white-space: nowrap; flex-shrink: 0;
    }
    .btn-vip:hover { filter: brightness(1.08); transform: translateY(-2px); box-shadow: 0 6px 18px rgba(168,137,58,0.35); }
    .btn-vip i { font-size: 0.78rem; }

    .modal-card--vip { max-width: 700px; width: 95%; padding: 0; overflow: hidden; text-align: left; }

    .vip-modal-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 24px 28px;
        border-bottom: 1px solid var(--border-med, rgba(90,80,60,0.14));
        background: var(--surface-2, #faf8f5);
    }
    .vip-modal-title-group { display: flex; align-items: center; gap: 14px; }
    .vip-crown-icon {
        width: 42px; height: 42px; border-radius: 11px;
        background: linear-gradient(135deg, rgba(168,137,58,0.15) 0%, rgba(196,168,74,0.2) 100%);
        border: 1px solid rgba(168,137,58,0.25); display: flex; align-items: center;
        justify-content: center; font-size: 1.1rem; color: #a8893a; flex-shrink: 0;
    }
    .vip-modal-title {
        font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.35rem;
        font-weight: 600; color: var(--text-main, #1e1c18); margin: 0 0 2px; line-height: 1.2;
    }
    .vip-modal-sub { font-size: 0.76rem; color: var(--text-muted, #9c9080); margin: 0; }
    .vip-modal-close {
        width: 32px; height: 32px; border-radius: 8px; background: var(--surface-3, #f0ece3);
        border: 1px solid var(--border-med, rgba(90,80,60,0.14)); color: var(--text-muted, #9c9080);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        font-size: 0.85rem; transition: all 0.18s ease; flex-shrink: 0;
    }
    .vip-modal-close:hover { background: var(--red-dim, rgba(176,48,48,0.09)); color: var(--red, #b03030); border-color: rgba(176,48,48,0.18); }

    .vip-table-wrap { overflow-x: auto; max-height: 420px; overflow-y: auto; }
    .vip-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
    .vip-table thead tr {
        background: var(--surface-2, #faf8f5); position: sticky; top: 0; z-index: 1;
        border-bottom: 1px solid var(--border-med, rgba(90,80,60,0.14));
    }
    .vip-table th {
        padding: 11px 18px; text-align: left; font-size: 0.62rem; font-weight: 700;
        letter-spacing: 1.4px; text-transform: uppercase; color: var(--text-muted, #9c9080); white-space: nowrap;
    }
    .vip-table td { padding: 13px 18px; border-bottom: 1px solid var(--border, rgba(90,80,60,0.08)); vertical-align: middle; }
    .vip-table tbody tr:last-child td { border-bottom: none; }
    .vip-table tbody tr { transition: background 0.15s ease; }
    .vip-table tbody tr:hover { background: var(--surface-2, #faf8f5); }
    .vip-row--medal { background: linear-gradient(90deg, rgba(168,137,58,0.04) 0%, transparent 60%); }
    .vip-row--medal:hover { background: linear-gradient(90deg, rgba(168,137,58,0.08) 0%, var(--surface-2, #faf8f5) 60%) !important; }

    .vip-rank { width: 52px; }
    .vip-medal { font-size: 1.2rem; }
    .vip-rank-num {
        display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; border-radius: 50%;
        background: var(--surface-3, #f0ece3); color: var(--text-muted, #9c9080);
        font-size: 0.72rem; font-weight: 700;
    }
    .vip-cust-name { font-weight: 500; color: var(--text-main, #1e1c18); font-size: 0.86rem; margin-bottom: 2px; }
    .vip-cust-email { font-size: 0.73rem; color: var(--text-muted, #9c9080); }
    .vip-phone { font-size: 0.8rem; color: var(--text-soft, #5a5248); white-space: nowrap; }
    .vip-orders { text-align: center; font-weight: 600; color: var(--text-soft, #5a5248); font-size: 0.84rem; }
    .vip-spent { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.05rem; font-weight: 600; color: var(--sage-dark, #4f7454); white-space: nowrap; }

    .tbl-btn.print-invoice-btn { background: var(--blue-dim, rgba(61,110,156,0.10)); color: var(--blue, #3d6e9c); border: 1px solid rgba(61,110,156,0.22); padding: 5px 10px; }
    .tbl-btn.print-invoice-btn:hover { background: var(--blue, #3d6e9c); color: #fff; border-color: var(--blue, #3d6e9c); }
    `;
    const tag = document.createElement('style');
    tag.id = 'vip-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
})();


/* ══════════════════════════════════════════════════════════
   LOW STOCK ALERTS
   ─────────────────────────────────────────────────────────
   Uses style.display directly — inline styles have the highest
   CSS specificity so no stylesheet rule can ever override them.
══════════════════════════════════════════════════════════ */
const LOW_STOCK_THRESHOLD = 5;
const LOW_STOCK_DISMISS_KEY = 'ls-dismissed';

function _showBanner(banner) { banner.style.display = 'flex'; }
function _hideBanner(banner) { banner.style.display = 'none'; }

function checkLowStock() {
    const banner = document.getElementById('lowStockBanner');
    const list = document.getElementById('lowStockList');
    if (!banner || !list) return;

    // Guard: Firestore hasn't returned yet
    if (!Array.isArray(allProducts) || allProducts.length === 0) return;

    if (localStorage.getItem(LOW_STOCK_DISMISS_KEY) === '1') {
        _hideBanner(banner);
        return;
    }

    const trackedProducts = allProducts.filter(p => typeof p.stock === 'number');
    const lowItems = trackedProducts
        .filter(p => p.stock <= LOW_STOCK_THRESHOLD)
        .sort((a, b) => a.stock - b.stock);

    if (lowItems.length === 0) {
        if (trackedProducts.length > 0) localStorage.removeItem(LOW_STOCK_DISMISS_KEY);
        _hideBanner(banner);
        return;
    }

    list.innerHTML = lowItems.map(p => {
        const urgency = p.stock === 0 ? 'ls-chip--out' : p.stock <= 2 ? 'ls-chip--critical' : 'ls-chip--low';
        const label = p.stock === 0 ? 'Out of stock' : `${p.stock} left`;
        return `
            <div class="ls-chip ${urgency}">
                <span class="ls-chip-name">${p.name}</span>
                <span class="ls-chip-qty">${label}</span>
            </div>`;
    }).join('');

    _showBanner(banner);
}

document.addEventListener('click', e => {
    if (!e.target.closest('#lowStockDismiss')) return;
    localStorage.setItem(LOW_STOCK_DISMISS_KEY, '1');
    const banner = document.getElementById('lowStockBanner');
    if (banner) _hideBanner(banner);
});

(function injectLowStockStyles() {
    const css = `
    #lowStockBanner {
        align-items: flex-start; gap: 16px;
        background: linear-gradient(135deg, rgba(184,110,110,0.10) 0%, rgba(196,125,125,0.06) 100%);
        border: 1px solid rgba(184,110,110,0.28); border-left: 4px solid #b86e6e;
        border-radius: 12px; padding: 14px 18px; margin-bottom: 24px; animation: lsBannerIn 0.3s ease;
    }
    @keyframes lsBannerIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .ls-icon {
        width: 36px; height: 36px; border-radius: 9px;
        background: rgba(184,110,110,0.14); border: 1px solid rgba(184,110,110,0.22);
        display: flex; align-items: center; justify-content: center;
        font-size: 0.95rem; color: #b86e6e; flex-shrink: 0; margin-top: 1px;
    }
    .ls-body { flex: 1; min-width: 0; }
    .ls-title { font-size: 0.78rem; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #933e3e; margin: 0 0 8px; }
    #lowStockList { display: flex; flex-wrap: wrap; gap: 7px; }
    .ls-chip { display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px; border-radius: 20px; font-size: 0.76rem; font-weight: 500; white-space: nowrap; }
    .ls-chip--low      { background: rgba(184,110,110,0.10); color: #933e3e; border: 1px solid rgba(184,110,110,0.25); }
    .ls-chip--critical { background: rgba(176,48,48,0.12);  color: #8a1f1f; border: 1px solid rgba(176,48,48,0.30); font-weight: 700; }
    .ls-chip--out      { background: #b03030; color: #fff; border: 1px solid #8a2020; font-weight: 700; }
    .ls-chip-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .ls-chip-qty  { opacity: 0.75; font-size: 0.7rem; }
    .ls-chip--out .ls-chip-qty { opacity: 0.9; }
    .ls-dismiss {
        background: none; border: none; cursor: pointer; color: #b86e6e; font-size: 0.85rem;
        padding: 4px; border-radius: 6px; opacity: 0.6; transition: opacity 0.15s ease;
        flex-shrink: 0; align-self: flex-start;
    }
    .ls-dismiss:hover { opacity: 1; }
    `;
    const tag = document.createElement('style');
    tag.id = 'low-stock-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
})();


/* ══════════════════════════════════════════════════════════
   SPRINT 1 — EXPORT ORDERS TO CSV
══════════════════════════════════════════════════════════ */
function exportOrdersToCSV() {
    if (!allOrders.length) { toast('No orders to export.', 'info'); return; }

    const cell = v => {
        const s = (v == null ? '' : String(v)).replace(/"/g, '""');
        return /[,"\n]/.test(s) ? `"${s}"` : s;
    };

    const headers = [
        'Order ID', 'Date', 'Customer Name', 'Email', 'Phone', 'Address',
        'Items', 'Subtotal', 'Discount', 'Shipping', 'Total',
        'Status', 'Payment Method', 'UTR / Ref', 'Coupon', 'Notes'
    ];

    const rows = allOrders.map(o => {
        const date = (() => {
            if (!o.createdAt) return '';
            const d = o.createdAt.seconds ? new Date(o.createdAt.seconds * 1000) : new Date(o.createdAt);
            return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        })();
        const itemsSummary = Array.isArray(o.items)
            ? o.items.map(i => `${i.name || '?'} x${i.qty || 1}`).join(' | ')
            : '';
        return [
            cell(o.orderId || o.docId), cell(date),
            cell(o.customerName), cell(o.customerEmail), cell(o.customerPhone), cell(o.customerAddress),
            cell(itemsSummary), cell(o.subtotal), cell(o.discount || 0),
            cell(o.shipping === 0 ? 0 : (o.shipping || '')), cell(o.total),
            cell(o.status), cell(o.paymentMethod || 'UPI'), cell(o.utrNumber), cell(o.coupon), cell(o.notes),
        ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `AuraEarth_Orders_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast(`Exported ${allOrders.length} orders to CSV ✦`, 'success');
}

document.getElementById('exportCsvBtn')?.addEventListener('click', exportOrdersToCSV);


/* ══════════════════════════════════════════════════════════
   SPRINT 1 — GLOBAL SEARCH  (Ctrl+K / Cmd+K)
══════════════════════════════════════════════════════════ */
(function initGlobalSearch() {
    const overlay = document.getElementById('searchModal');
    const input = document.getElementById('searchModalInput');
    const results = document.getElementById('searchModalResults');
    if (!overlay || !input || !results) return;

    let activeIndex = -1;

    function openSearch() {
        overlay.classList.add('is-open');
        document.body.style.overflow = 'hidden';
        input.value = '';
        renderEmpty();
        activeIndex = -1;
        requestAnimationFrame(() => input.focus());
    }

    function closeSearch() {
        overlay.classList.remove('is-open');
        document.body.style.overflow = '';
        input.value = '';
        activeIndex = -1;
    }

    function renderEmpty() {
        results.innerHTML = '<p class="search-modal-empty">Start typing to search orders and products.</p>';
    }

    function highlight(text, query) {
        if (!query) return text;
        const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return String(text).replace(new RegExp(`(${esc})`, 'gi'), '<mark class="search-highlight">$1</mark>');
    }

    function runSearch(raw) {
        const q = raw.trim().toLowerCase();
        if (!q) { renderEmpty(); return; }

        const matchedOrders = allOrders.filter(o => {
            const id = (o.orderId || o.docId || '').toLowerCase();
            return id.includes(q) ||
                (o.customerName || '').toLowerCase().includes(q) ||
                (o.customerEmail || '').toLowerCase().includes(q) ||
                (o.customerPhone || '').toLowerCase().includes(q);
        }).slice(0, 6);

        const matchedProducts = allProducts.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.category || '').toLowerCase().includes(q) ||
            (p.stone || '').toLowerCase().includes(q)
        ).slice(0, 6);

        if (!matchedOrders.length && !matchedProducts.length) {
            results.innerHTML = `<p class="search-modal-no-results">No results for "<strong>${q}</strong>"</p>`;
            activeIndex = -1;
            return;
        }

        let html = '';

        if (matchedOrders.length) {
            html += `<div class="search-result-group-label">Orders</div>`;
            html += matchedOrders.map(o => {
                const id = o.orderId || (o.docId || '').substring(0, 8).toUpperCase();
                const name = o.customerName || o.customerEmail || '—';
                const status = o.status || 'Pending';
                return `
                <div class="search-result-item" data-action="order" data-id="${o.docId}" tabindex="-1">
                    <div class="sri-icon sri-icon--order"><i class="fa-solid fa-box"></i></div>
                    <div class="sri-body">
                        <div class="sri-title">${highlight('#' + id, q)}</div>
                        <div class="sri-sub">${highlight(name, q)}</div>
                    </div>
                    <span class="sri-badge sri-badge--order">${status}</span>
                </div>`;
            }).join('');
        }

        if (matchedProducts.length) {
            html += `<div class="search-result-group-label">Products</div>`;
            html += matchedProducts.map(p => `
                <div class="search-result-item" data-action="product" data-id="${p.docId}" tabindex="-1">
                    <div class="sri-icon sri-icon--product"><i class="fa-solid fa-gem"></i></div>
                    <div class="sri-body">
                        <div class="sri-title">${highlight(p.name, q)}</div>
                        <div class="sri-sub">${highlight(p.category || '', q)}</div>
                    </div>
                    <span class="sri-badge sri-badge--product">₹${Number(p.price || 0).toLocaleString('en-IN')}</span>
                </div>`).join('');
        }

        results.innerHTML = html;
        activeIndex = -1;
    }

    function activateResult(item) {
        if (!item) return;
        const { action, id } = item.dataset;
        closeSearch();
        if (action === 'order') {
            navigateTo('orders');
            setTimeout(() => {
                const row = document.querySelector(`[data-order-id="${id}"], tr[data-id="${id}"]`);
                if (row) {
                    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    row.style.transition = 'background 0s';
                    row.style.background = 'rgba(110,148,114,0.15)';
                    setTimeout(() => { row.style.background = ''; }, 1200);
                }
            }, 120);
        }
        if (action === 'product') {
            navigateTo('products', 'list');
            setTimeout(() => startProductEdit(id), 120);
        }
    }

    function getItems() { return [...results.querySelectorAll('.search-result-item')]; }

    function setActive(index) {
        const items = getItems();
        items.forEach(i => i.classList.remove('is-active'));
        if (index >= 0 && index < items.length) {
            items[index].classList.add('is-active');
            items[index].scrollIntoView({ block: 'nearest' });
        }
        activeIndex = index;
    }

    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            overlay.classList.contains('is-open') ? closeSearch() : openSearch();
            return;
        }
        if (e.key === 'Escape' && overlay.classList.contains('is-open')) { closeSearch(); return; }
        if (!overlay.classList.contains('is-open')) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIndex + 1, getItems().length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIndex - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); const items = getItems(); activateResult(items[activeIndex] ?? items[0]); }
    });

    input.addEventListener('input', () => runSearch(input.value));
    results.addEventListener('click', e => { const item = e.target.closest('.search-result-item'); if (item) activateResult(item); });
    overlay.addEventListener('click', e => { if (e.target === overlay) closeSearch(); });
})();


/* ══════════════════════════════════════════════════════════
   SPRINT 3 — ADMIN SETTINGS (Firestore: settings/global)
══════════════════════════════════════════════════════════ */
const SETTINGS_DOC_REF = doc(db, 'settings', 'global');

// Single source of truth — maps Firestore keys ↔ DOM input IDs
// Adding stackDiscount here is the ONLY dashboard.js change needed —
// loadAdminSettings() and saveAdminSettings() iterate this array
// automatically, so the new field is load/saved with zero extra code.
const SETTINGS_FIELDS = [
    { key: 'storeName', id: 'cfg-store-name', type: 'text' },
    { key: 'supportEmail', id: 'cfg-support-email', type: 'text' },
    { key: 'supportPhone', id: 'cfg-support-phone', type: 'text' },
    { key: 'gatewayKey', id: 'cfg-gateway-key', type: 'text' },
    { key: 'gatewaySecret', id: 'cfg-gateway-secret', type: 'text' },
    { key: 'maintenanceMode', id: 'cfg-maintenance-mode', type: 'checkbox' },
    { key: 'sitewidesSale', id: 'cfg-sitewide-sale', type: 'checkbox' },
    { key: 'freeShipping', id: 'cfg-free-shipping', type: 'number' },
    { key: 'deliveryFee', id: 'cfg-delivery-fee', type: 'number' },
    { key: 'stackDiscount', id: 'cfg-stack-discount', type: 'number' },
];

async function loadAdminSettings() {
    try {
        const snap = await getDoc(SETTINGS_DOC_REF);

        // Document doesn't exist yet — leave inputs at their HTML defaults
        if (!snap.exists()) return;

        const saved = snap.data();

        SETTINGS_FIELDS.forEach(({ key, id, type }) => {
            const el = document.getElementById(id);
            if (!el || !(key in saved)) return;
            if (type === 'checkbox') {
                el.checked = Boolean(saved[key]);
            } else {
                el.value = saved[key] ?? '';
            }
        });

    } catch (err) {
        console.error('[Dashboard] loadAdminSettings error:', err);
        toast('Failed to load settings. Check console.', 'error');
    }
}

async function saveAdminSettings() {
    const saveBtn = document.getElementById('saveSettingsBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    }

    toast('Saving settings…', 'info');

    const data = {};
    SETTINGS_FIELDS.forEach(({ key, id, type }) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (type === 'checkbox') {
            data[key] = el.checked;
        } else if (type === 'number') {
            const n = parseFloat(el.value);
            data[key] = isNaN(n) ? '' : n;
        } else {
            data[key] = el.value.trim();
        }
    });

    try {
        // setDoc with merge:true creates the doc if absent; only overwrites keys in `data`
        await setDoc(SETTINGS_DOC_REF, data, { merge: true });
        toast('Settings saved successfully! ✦', 'success');
    } catch (err) {
        console.error('[Dashboard] saveAdminSettings error:', err);
        toast('Failed to save settings. Check console.', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Settings';
        }
    }
}

// Wire Save button (Settings tab — saves all settings fields)
document.getElementById('saveSettingsBtn')?.addEventListener('click', saveAdminSettings);

/* ══════════════════════════════════════════════════════════
   STACK BUILDER TAB — Save Bundle Discount
   A dedicated save action for the Stack tab so admins don't
   have to navigate to Settings to change the bundle discount.
   Reads only the cfg-stack-discount input and merges it into
   the same settings/global Firestore document.
══════════════════════════════════════════════════════════ */
async function saveStackDiscount() {
    const btn = document.getElementById('saveStackDiscountBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
    }

    const input = document.getElementById('cfg-stack-discount');
    const raw = input ? parseFloat(input.value) : NaN;
    const value = isNaN(raw) ? 0 : Math.min(99, Math.max(0, raw));

    try {
        await setDoc(SETTINGS_DOC_REF, { stackDiscount: value }, { merge: true });
        toast(`Stack Bundle Discount set to ${value}% ✦`, 'success');
    } catch (err) {
        console.error('[Dashboard] saveStackDiscount error:', err);
        toast('Failed to save discount. Check console.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span>Save Discount</span><i class="fa-solid fa-floppy-disk"></i>';
        }
    }
}

// Wire Stack tab's dedicated save button
document.getElementById('saveStackDiscountBtn')?.addEventListener('click', saveStackDiscount);

// Wire reveal-password eye buttons
document.querySelectorAll('.btn-reveal').forEach(btn => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.target);
        if (!input) return;
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        btn.innerHTML = isHidden
            ? '<i class="fa-solid fa-eye-slash"></i>'
            : '<i class="fa-solid fa-eye"></i>';
    });
});

// Settings are now loaded via the unified nav-item click handler above.
// Auto-load immediately only if the settings view is the active view on first paint.
if (document.getElementById('viewSettings')?.classList.contains('active')) {
    loadAdminSettings();
}
/* ══════════════════════════════════════════════════════════
   MESSAGES — Contact Form Submissions (Firestore: messages)
══════════════════════════════════════════════════════════ */
let allMessages = [];

function formatMessageDate(ts) {
    if (!ts) return '—';
    const d = typeof ts === 'number' ? new Date(ts) : (ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts));
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
        ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function updateUnreadBadge(messages) {
    const unread = messages.filter(m => !m.read).length;
    const badge = document.getElementById('unreadMessagesBadge');
    if (badge) {
        badge.textContent = unread;
        badge.style.display = unread > 0 ? 'flex' : 'none';
    }
}

async function loadMessages() {
    const tbody = document.getElementById('messagesTableBody');
    if (tbody) tbody.innerHTML = `<tr class="table-status-row"><td colspan="7">Loading…</td></tr>`;

    try {
        const snap = await getDocs(query(collection(db, 'messages'), orderBy('createdAt', 'desc')));
        allMessages = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
        renderMessagesTable(allMessages);
        updateUnreadBadge(allMessages);
        const countEl = document.getElementById('messagesCount');
        if (countEl) countEl.textContent = allMessages.length;
    } catch (err) {
        console.error('[Dashboard] loadMessages:', err);
        if (tbody) tbody.innerHTML = `<tr class="table-status-row"><td colspan="7">Failed to load messages. Check Firestore rules.</td></tr>`;
        toast('Failed to load messages. Check console.', 'error');
    }
}

function renderMessagesTable(messages) {
    const tbody = document.getElementById('messagesTableBody');
    const countEl = document.getElementById('messagesCount');
    if (!tbody) return;
    if (countEl) countEl.textContent = messages.length;

    if (messages.length === 0) {
        tbody.innerHTML = `<tr class="table-status-row"><td colspan="7">No messages yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = messages.map(m => {
        const isUnread = !m.read;
        const rowClass = isUnread ? 'msg-row msg-row--unread' : 'msg-row';
        // Truncate long messages to keep the table readable
        const preview = (m.message || '').length > 80
            ? (m.message || '').slice(0, 80) + '…'
            : (m.message || '—');
        const fullMsg = (m.message || '').replace(/"/g, '&quot;');
        const dateStr = formatMessageDate(m.createdAt);

        return `
        <tr class="${rowClass}" data-doc-id="${m.docId}">
            <td>
                ${isUnread
                ? '<span class="msg-status-dot msg-status-dot--unread" title="Unread"></span>'
                : '<span class="msg-status-dot msg-status-dot--read"   title="Read"></span>'}
            </td>
            <td class="msg-name">${m.name || '—'}</td>
            <td>
                <a href="https://wa.me/${(m.phone || '').replace(/\D/g, '')}"
                   target="_blank" rel="noopener" class="msg-phone-link"
                   title="Open in WhatsApp">
                    ${m.phone || '—'}
                    <i class="fa-brands fa-whatsapp" style="color:#25d366;margin-left:4px;"></i>
                </a>
            </td>
            <td><span class="msg-subject-chip">${m.subject || '—'}</span></td>
            <td class="msg-preview" title="${fullMsg}">${preview}</td>
            <td class="msg-date">${dateStr}</td>
            <td>
                <div class="table-actions">
                    ${isUnread
                ? `<button class="btn-icon btn-icon--read"   title="Mark as read"   data-action="mark-read"   data-doc-id="${m.docId}"><i class="fa-solid fa-envelope-open"></i></button>`
                : `<button class="btn-icon btn-icon--unread" title="Mark as unread" data-action="mark-unread" data-doc-id="${m.docId}"><i class="fa-solid fa-envelope"></i></button>`}
                    <button class="btn-icon btn-icon--danger" title="Delete message" data-action="delete-msg" data-doc-id="${m.docId}" data-name="${m.name || 'this message'}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ── Event delegation on the messages table body ────────────
document.getElementById('messagesTableBody')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const docId = btn.dataset.docId;
    if (!docId) return;

    if (action === 'mark-read' || action === 'mark-unread') {
        const isRead = action === 'mark-read';
        try {
            await updateDoc(doc(db, 'messages', docId), { read: isRead });
            // Patch local cache
            const msg = allMessages.find(m => m.docId === docId);
            if (msg) msg.read = isRead;
            renderMessagesTable(allMessages);
            updateUnreadBadge(allMessages);
            toast(isRead ? 'Marked as read ✦' : 'Marked as unread', 'info');
        } catch (err) {
            console.error('[Dashboard] toggleRead:', err);
            toast('Failed to update message.', 'error');
        }
        return;
    }

    if (action === 'delete-msg') {
        const name = btn.dataset.name || 'this message';
        if (!confirm(`Delete message from "${name}"? This cannot be undone.`)) return;
        try {
            await deleteDoc(doc(db, 'messages', docId));
            allMessages = allMessages.filter(m => m.docId !== docId);
            renderMessagesTable(allMessages);
            updateUnreadBadge(allMessages);
            const countEl = document.getElementById('messagesCount');
            if (countEl) countEl.textContent = allMessages.length;
            toast('Message deleted.', 'success');
        } catch (err) {
            console.error('[Dashboard] deleteMessage:', err);
            toast('Failed to delete message.', 'error');
        }
    }
});

// Refresh button
document.getElementById('refreshMessagesBtn')?.addEventListener('click', () => loadMessages());

/* ============================================================
   AURA & EARTH — Phase 1 JS Additions
   Append ALL of this to the bottom of your existing dashboard.js

   Features added:
     1. Analytics & Sales Graphs  (Chart.js — line + donut)
     2. Reviews & Ratings Moderation  (Firestore `reviews` collection)

   Assumes:
     • db is imported from ./firebase.js  ✓ (already in your file)
     • getDocs, query, where, orderBy, updateDoc, deleteDoc, doc,
       collection are already imported from firebase-firestore.js  ✓
     • Chart.js is loaded via CDN in dashboard.html  ✓
     • tabMap, titleMap, navigateTo() already exist  ✓
   ============================================================ */


/* ══════════════════════════════════════════════════════════
   STEP A — Extend tabMap & titleMap for the two new tabs
   Add these lines right after your existing tabMap /
   titleMap declarations (around line 152–170 of your file),
   OR simply run them here — JS will overwrite the object
   properties since this appends after the originals.
══════════════════════════════════════════════════════════ */
tabMap['analytics'] = 'viewAnalytics';
tabMap['reviews'] = 'viewReviews';
titleMap['analytics'] = ['Analytics', 'Sales Insights'];
titleMap['reviews'] = ['Reviews', 'Moderation'];


/* ══════════════════════════════════════════════════════════
   SECTION 1 — ANALYTICS & SALES GRAPHS
══════════════════════════════════════════════════════════ */

// ── Module-level state ──────────────────────────────────
let salesChartInstance = null;   // Chart.js line instance
let categoryChartInstance = null;   // Chart.js donut instance
let currentAnalyticsPeriod = 7;     // days; toggled by user

// ── Entry point called by nav-item click ────────────────
async function loadAnalytics(days = 7) {
    currentAnalyticsPeriod = days;

    // Update KPI loading state
    ['kpiPeriodRevenue', 'kpiPeriodOrders', 'kpiPeriodAov', 'kpiPeakDay']
        .forEach(id => setText(id, '…'));

    try {
        const orders = await fetchOrdersForPeriod(days);
        renderSalesChart(orders, days);
        renderKpiStrip(orders);
        renderTopSelling(orders);
        renderCategoryChart(orders);
    } catch (err) {
        console.error('[Analytics] loadAnalytics error:', err);
        toast('Failed to load analytics. Check Firestore rules.', 'error');
    }
}

// ── Fetch orders within the last `days` days ────────────
async function fetchOrdersForPeriod(days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);

    // Query: orders where createdAt >= cutoff, ordered ascending for chart
    const q = query(
        collection(db, 'orders'),
        where('createdAt', '>=', cutoff),
        orderBy('createdAt', 'asc')
    );

    const snap = await getDocs(q);
    return snap.docs.map(d => ({ docId: d.id, ...d.data() }));
}

// ── Build daily buckets and render the line chart ───────
function renderSalesChart(orders, days) {
    // Build a map: "YYYY-MM-DD" → total revenue
    const dailyMap = buildDailyMap(days);
    orders.forEach(order => {
        const dateKey = getDateKey(order.createdAt);
        if (dateKey && dateKey in dailyMap) {
            dailyMap[dateKey] += getOrderTotal(order);
        }
    });

    const labels = Object.keys(dailyMap).map(k => formatChartDate(k, days));
    const values = Object.values(dailyMap);

    const ctx = document.getElementById('salesChart');
    if (!ctx) return;

    // Destroy previous instance to avoid duplicate renders
    if (salesChartInstance) { salesChartInstance.destroy(); }

    const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 260);
    gradient.addColorStop(0, 'rgba(138, 170, 128, 0.35)');
    gradient.addColorStop(1, 'rgba(138, 170, 128, 0.00)');

    salesChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Revenue (₹)',
                data: values,
                fill: true,
                backgroundColor: gradient,
                borderColor: '#8aaa80',
                borderWidth: 2.5,
                pointRadius: 4,
                pointBackgroundColor: '#8aaa80',
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => `₹${ctx.parsed.y.toLocaleString('en-IN')}`
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: { font: { size: 11 }, color: '#999' }
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: {
                        font: { size: 11 },
                        color: '#999',
                        callback: v => `₹${(v / 1000).toFixed(0)}k`
                    },
                    beginAtZero: true
                }
            }
        }
    });

    // Update subtitle
    const sub = document.getElementById('analyticsChartSub');
    if (sub) sub.textContent = `Last ${days} days`;
}

// ── KPI strip ───────────────────────────────────────────
function renderKpiStrip(orders) {
    const confirmedOrders = orders.filter(o =>
        o.status && !['cancelled', 'failed'].includes(o.status.toLowerCase())
    );
    const totalRev = confirmedOrders.reduce((s, o) => s + getOrderTotal(o), 0);
    const count = confirmedOrders.length;
    const aov = count > 0 ? totalRev / count : 0;

    // Peak day
    const dayTotals = {};
    confirmedOrders.forEach(o => {
        const k = getDateKey(o.createdAt);
        if (k) dayTotals[k] = (dayTotals[k] || 0) + getOrderTotal(o);
    });
    const peakDayVal = Object.values(dayTotals).length > 0
        ? Math.max(...Object.values(dayTotals))
        : 0;

    setText('kpiPeriodRevenue', `₹${totalRev.toLocaleString('en-IN')}`);
    setText('kpiPeriodOrders', count.toString());
    setText('kpiPeriodAov', `₹${Math.round(aov).toLocaleString('en-IN')}`);
    setText('kpiPeakDay', `₹${peakDayVal.toLocaleString('en-IN')}`);
}

// ── Top Selling Items ────────────────────────────────────
function renderTopSelling(orders) {
    const container = document.getElementById('topSellingList');
    if (!container) return;

    // Tally qty sold per product name
    const itemMap = {};
    orders.forEach(order => {
        const items = order.items || order.cart || [];
        items.forEach(item => {
            const name = item.name || item.productName || 'Unknown';
            if (!itemMap[name]) itemMap[name] = { qty: 0, revenue: 0 };
            const qty = Number(item.qty || item.quantity || 1);
            const price = Number(item.price || item.unitPrice || 0);
            itemMap[name].qty += qty;
            itemMap[name].revenue += qty * price;
        });
    });

    const sorted = Object.entries(itemMap)
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, 8);

    const countEl = document.getElementById('topItemsCount');
    if (countEl) countEl.textContent = `${sorted.length} item${sorted.length !== 1 ? 's' : ''}`;

    if (sorted.length === 0) {
        container.innerHTML = `<div class="analytics-empty"><i class="fa-solid fa-box-open"></i><p>No order items in this period.</p></div>`;
        return;
    }

    const maxQty = sorted[0][1].qty;
    const rankClasses = ['gold-rank', 'silver-rank', 'bronze-rank'];

    container.innerHTML = sorted.map(([name, data], i) => {
        const pct = maxQty > 0 ? Math.round((data.qty / maxQty) * 100) : 0;
        const rankCls = rankClasses[i] || '';
        return `
        <div class="top-item">
            <div class="top-item-rank ${rankCls}">${i + 1}</div>
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span class="top-item-name">${escHtml(name)}</span>
                    <span class="top-item-meta">${data.qty} sold · ₹${data.revenue.toLocaleString('en-IN')}</span>
                </div>
                <div class="top-item-bar-wrap">
                    <div class="top-item-bar" style="width:${pct}%"></div>
                </div>
            </div>
        </div>`;
    }).join('');
}

// ── Revenue by Category Donut ────────────────────────────
function renderCategoryChart(orders) {
    const ctx = document.getElementById('categoryChart');
    if (!ctx) return;

    // Tally revenue by item category
    const catMap = {};
    orders.forEach(order => {
        const items = order.items || order.cart || [];
        items.forEach(item => {
            const cat = item.category || 'Other';
            const qty = Number(item.qty || item.quantity || 1);
            const price = Number(item.price || item.unitPrice || 0);
            catMap[cat] = (catMap[cat] || 0) + qty * price;
        });
    });

    const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(([k]) => k);
    const values = sorted.map(([, v]) => v);

    const palette = ['#8aaa80', '#c8a84b', '#a07860', '#7a9ab0', '#b07898', '#6aaa90', '#c89050', '#908878'];

    if (categoryChartInstance) { categoryChartInstance.destroy(); }

    if (values.length === 0) {
        ctx.style.display = 'none';
        return;
    }
    ctx.style.display = '';

    categoryChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: palette.slice(0, labels.length),
                borderWidth: 2,
                borderColor: '#fff',
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
                legend: {
                    position: 'right',
                    labels: { font: { size: 11 }, boxWidth: 12, padding: 12 }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ₹${ctx.parsed.toLocaleString('en-IN')}`
                    }
                }
            }
        }
    });
}

// ── Helper: build empty daily bucket map ─────────────────
function buildDailyMap(days) {
    const map = {};
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        map[d.toISOString().slice(0, 10)] = 0;
    }
    return map;
}

// ── Helper: extract a "YYYY-MM-DD" string from any timestamp ──
function getDateKey(ts) {
    if (!ts) return null;
    let d;
    if (ts.seconds) d = new Date(ts.seconds * 1000);  // Firestore Timestamp
    else if (ts.toDate) d = ts.toDate();
    else if (typeof ts === 'number') d = new Date(ts);
    else d = new Date(ts);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// ── Helper: get order total (handles multiple field names) ──
function getOrderTotal(order) {
    return Number(
        order.totalAmount ??
        order.total ??
        order.orderTotal ??
        order.grandTotal ??
        0
    );
}

// ── Helper: format chart x-axis label ────────────────────
function formatChartDate(iso, days) {
    const d = new Date(iso + 'T00:00:00');
    if (days <= 7) return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' });
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

// ── Helper: escape HTML ──────────────────────────────────
function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Period toggle buttons ────────────────────────────────
document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const days = parseInt(btn.dataset.period, 10);
        loadAnalytics(days);
    });
});


/* ══════════════════════════════════════════════════════════
   SECTION 2 — REVIEWS & RATINGS MODERATION
══════════════════════════════════════════════════════════ */

// ── Module-level state ──────────────────────────────────
let pendingReviews = [];
let approvedReviews = [];
let pendingDeleteReviewDocId = null;

// ── Entry point ─────────────────────────────────────────
async function loadReviews() {
    await Promise.all([
        fetchPendingReviews(),
        fetchApprovedReviews()
    ]);
}

// ── Fetch pending reviews ────────────────────────────────
async function fetchPendingReviews() {
    const tbody = document.getElementById('pendingReviewsBody');
    if (tbody) tbody.innerHTML = `<tr class="table-status-row"><td colspan="6">Loading…</td></tr>`;

    try {
        const q = query(collection(db, 'reviews'), where('status', '==', 'pending'));
        const snap = await getDocs(q);
        pendingReviews = snap.docs.map(d => ({ docId: d.id, ...d.data() }));

        // Sort newest first
        pendingReviews.sort((a, b) => {
            const ta = a.createdAt?.seconds || 0;
            const tb = b.createdAt?.seconds || 0;
            return tb - ta;
        });

        renderReviewsTable('pending', pendingReviews);
        updateReviewBadges();
    } catch (err) {
        console.error('[Reviews] fetchPendingReviews:', err);
        if (tbody) tbody.innerHTML = `<tr class="table-status-row"><td colspan="6">Failed to load. Check Firestore rules & index.</td></tr>`;
        toast('Failed to load pending reviews.', 'error');
    }
}

// ── Fetch approved reviews ───────────────────────────────
async function fetchApprovedReviews() {
    const tbody = document.getElementById('approvedReviewsBody');
    if (tbody) tbody.innerHTML = `<tr class="table-status-row"><td colspan="6">Loading…</td></tr>`;

    try {
        const q = query(collection(db, 'reviews'), where('status', '==', 'approved'), orderBy('createdAt', 'desc'));
        const snap = await getDocs(q);
        approvedReviews = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
        renderReviewsTable('approved', approvedReviews);
    } catch (err) {
        console.error('[Reviews] fetchApprovedReviews:', err);
        if (tbody) tbody.innerHTML = `<tr class="table-status-row"><td colspan="6">Failed to load approved reviews.</td></tr>`;
    }
}

// ── Render a reviews table (pending or approved) ─────────
function renderReviewsTable(type, reviews) {
    const tbodyId = type === 'pending' ? 'pendingReviewsBody' : 'approvedReviewsBody';
    const countId = type === 'pending' ? 'pendingReviewCount' : 'approvedReviewCount';
    const tbody = document.getElementById(tbodyId);
    const countEl = document.getElementById(countId);
    if (!tbody) return;
    if (countEl) countEl.textContent = reviews.length;

    if (reviews.length === 0) {
        tbody.innerHTML = `<tr class="table-status-row"><td colspan="6">
            ${type === 'pending' ? 'No reviews awaiting moderation. 🎉' : 'No approved reviews yet.'}
        </td></tr>`;
        return;
    }

    tbody.innerHTML = reviews.map(r => {
        const stars = buildStarHtml(r.rating || 0);
        const dateStr = formatReviewDate(r.createdAt);
        const preview = (r.text || r.body || r.comment || '').slice(0, 90);
        const fullText = (r.text || r.body || r.comment || '—').replace(/"/g, '&quot;');
        const product = escHtml(r.productName || r.product || '—');
        const reviewer = escHtml(r.name || r.reviewerName || r.userName || 'Anonymous');

        if (type === 'pending') {
            return `
            <tr data-doc-id="${r.docId}">
                <td>${stars}</td>
                <td>${reviewer}</td>
                <td>${product}</td>
                <td class="review-text-cell" title="${fullText}">${escHtml(preview)}${preview.length >= 90 ? '…' : ''}</td>
                <td style="white-space:nowrap;font-size:0.78rem;">${dateStr}</td>
                <td>
                    <div class="table-actions">
                        <button class="btn-icon btn-icon--success"
                            title="Approve review"
                            data-action="approve-review"
                            data-doc-id="${r.docId}">
                            <i class="fa-solid fa-check"></i>
                        </button>
                        <button class="btn-icon btn-icon--danger"
                            title="Delete review"
                            data-action="delete-review"
                            data-doc-id="${r.docId}"
                            data-reviewer="${reviewer}"
                            data-product="${product}">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
        }

        // Approved row — only has a "revoke" (set back to pending) + delete
        return `
        <tr data-doc-id="${r.docId}">
            <td>${stars}</td>
            <td>${reviewer}</td>
            <td>${product}</td>
            <td class="review-text-cell" title="${fullText}">${escHtml(preview)}${preview.length >= 90 ? '…' : ''}</td>
            <td style="white-space:nowrap;font-size:0.78rem;">${dateStr}</td>
            <td>
                <div class="table-actions">
                    <button class="btn-icon"
                        title="Revoke (set back to pending)"
                        data-action="revoke-review"
                        data-doc-id="${r.docId}">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>
                    <button class="btn-icon btn-icon--danger"
                        title="Delete review"
                        data-action="delete-review"
                        data-doc-id="${r.docId}"
                        data-reviewer="${reviewer}"
                        data-product="${product}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ── Approve a review ─────────────────────────────────────
async function approveReview(docId) {
    try {
        await updateDoc(doc(db, 'reviews', docId), { status: 'approved' });
        // Move from pending to approved in local state
        const idx = pendingReviews.findIndex(r => r.docId === docId);
        if (idx !== -1) {
            const [r] = pendingReviews.splice(idx, 1);
            r.status = 'approved';
            approvedReviews.unshift(r);
        }
        renderReviewsTable('pending', pendingReviews);
        renderReviewsTable('approved', approvedReviews);
        updateReviewBadges();
        toast('Review approved ✦', 'success');
    } catch (err) {
        console.error('[Reviews] approveReview:', err);
        toast('Failed to approve review.', 'error');
    }
}

// ── Revoke an approved review back to pending ────────────
async function revokeReview(docId) {
    try {
        await updateDoc(doc(db, 'reviews', docId), { status: 'pending' });
        const idx = approvedReviews.findIndex(r => r.docId === docId);
        if (idx !== -1) {
            const [r] = approvedReviews.splice(idx, 1);
            r.status = 'pending';
            pendingReviews.unshift(r);
        }
        renderReviewsTable('pending', pendingReviews);
        renderReviewsTable('approved', approvedReviews);
        updateReviewBadges();
        toast('Review moved back to pending.', 'info');
    } catch (err) {
        console.error('[Reviews] revokeReview:', err);
        toast('Failed to revoke review.', 'error');
    }
}

// ── Open delete confirmation modal ──────────────────────
function openDeleteReviewModal(docId, reviewer, product) {
    pendingDeleteReviewDocId = docId;
    const meta = document.getElementById('deleteReviewModalMeta');
    if (meta) meta.textContent = `By "${reviewer}" on "${product}"`;
    document.getElementById('deleteReviewModal')?.classList.add('open');
}

// ── Execute review deletion ──────────────────────────────
async function executeDeleteReview() {
    if (!pendingDeleteReviewDocId) return;
    const docId = pendingDeleteReviewDocId;
    pendingDeleteReviewDocId = null;
    document.getElementById('deleteReviewModal')?.classList.remove('open');

    try {
        await deleteDoc(doc(db, 'reviews', docId));
        // Remove from whichever local array holds it
        pendingReviews = pendingReviews.filter(r => r.docId !== docId);
        approvedReviews = approvedReviews.filter(r => r.docId !== docId);
        renderReviewsTable('pending', pendingReviews);
        renderReviewsTable('approved', approvedReviews);
        updateReviewBadges();
        toast('Review deleted.', 'success');
    } catch (err) {
        console.error('[Reviews] deleteReview:', err);
        toast('Failed to delete review.', 'error');
    }
}

// ── Badge helper ─────────────────────────────────────────
function updateReviewBadges() {
    const count = pendingReviews.length;

    const navBadge = document.getElementById('pendingReviewsBadge');
    if (navBadge) {
        navBadge.textContent = count;
        navBadge.style.display = count > 0 ? 'flex' : 'none';
    }
    const tabBadge = document.getElementById('pendingReviewsTabBadge');
    if (tabBadge) {
        tabBadge.textContent = count;
    }
}

// ── Build star HTML ─────────────────────────────────────
function buildStarHtml(rating) {
    const full = Math.floor(Number(rating) || 0);
    const empty = 5 - full;
    return `<span class="star-rating">${'★'.repeat(full)}<span class="empty">${'★'.repeat(empty)}</span></span>`;
}

// ── Date formatter for reviews ───────────────────────────
function formatReviewDate(ts) {
    if (!ts) return '—';
    const d = ts.seconds
        ? new Date(ts.seconds * 1000)
        : (ts.toDate ? ts.toDate() : new Date(ts));
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Reviews sub-tab switcher ─────────────────────────────
document.querySelectorAll('[data-reviewtab]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-reviewtab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.reviews-panel').forEach(p => p.classList.remove('active'));
        const panelMap = { pending: 'reviewsPanelPending', approved: 'reviewsPanelApproved' };
        document.getElementById(panelMap[btn.dataset.reviewtab])?.classList.add('active');
    });
});

// ── Event delegation: Pending reviews table ─────────────
document.getElementById('pendingReviewsBody')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, docId, reviewer = 'Unknown', product = 'Unknown' } = btn.dataset;
    if (!docId) return;

    if (action === 'approve-review') await approveReview(docId);
    if (action === 'delete-review') openDeleteReviewModal(docId, reviewer, product);
});

// ── Event delegation: Approved reviews table ────────────
document.getElementById('approvedReviewsBody')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, docId, reviewer = 'Unknown', product = 'Unknown' } = btn.dataset;
    if (!docId) return;

    if (action === 'revoke-review') await revokeReview(docId);
    if (action === 'delete-review') openDeleteReviewModal(docId, reviewer, product);
});

// ── Delete modal confirm / cancel ────────────────────────
document.getElementById('confirmDeleteReviewBtn')?.addEventListener('click', executeDeleteReview);
document.getElementById('cancelDeleteReviewBtn')?.addEventListener('click', () => {
    pendingDeleteReviewDocId = null;
    document.getElementById('deleteReviewModal')?.classList.remove('open');
});

// ── Refresh buttons ──────────────────────────────────────
document.getElementById('refreshReviewsBtn')?.addEventListener('click', fetchPendingReviews);
document.getElementById('refreshApprovedReviewsBtn')?.addEventListener('click', fetchApprovedReviews);


/* ══════════════════════════════════════════════════════════
   SECTION 3 — Wire new tabs into the existing nav listener
   ─────────────────────────────────────────────────────────
   Your existing nav-item click handler already calls
   navigateTo(tab) via the delegation block that reads
   btn.dataset.tab.  We only need to hook the data-load
   side-effects for the two new tabs.

   Paste this block after the section above. It piggybacks
   on the existing nav-item click delegation in your file.
   Because addEventListener stacks, the original handler
   still fires first for the other tabs; this listener
   intercepts only the two new ones.
══════════════════════════════════════════════════════════ */
document.querySelectorAll('.nav-item[data-tab]').forEach(navBtn => {
    navBtn.addEventListener('click', () => {
        const tab = navBtn.dataset.tab;
        if (tab === 'analytics') loadAnalytics(currentAnalyticsPeriod);
        if (tab === 'reviews') loadReviews();
    });
});

// ── Also load reviews on page load to populate the nav badge ──
// (called inside onAuthStateChanged after the existing load calls)
// Add  loadReviews();  to your onAuthStateChanged callback alongside
// the other load calls, OR call it once here after a brief delay:
setTimeout(() => {
    // Only fetch to set the badge — no need to render table yet
    (async () => {
        try {
            const q = query(collection(db, 'reviews'), where('status', '==', 'pending'));
            const snap = await getDocs(q);
            pendingReviews = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
            updateReviewBadges();
        } catch (_) { /* silent — user may not have reviews collection yet */ }
    })();
}, 1500); // wait 1.5 s to give auth guard time to finish

/* ============================================================
   AURA & EARTH — Phase 2: Inventory Hub JS Additions
   Append ALL of this to the BOTTOM of your dashboard.js.

   Features:
     1. Stock & Upsell Manager   — inline stock + linkedProductId edits
     2. Waitlist / Demand Tracker — grouped by productId with demand cards

   Prerequisites (already in your file):
     • db, collection, getDocs, getDoc, updateDoc, doc,
       query, orderBy, where — all imported ✓
     • allProducts state array  ✓
     • toast(), setText(), tabMap, titleMap, navigateTo() ✓
   ============================================================ */


/* ══════════════════════════════════════════════════════════
   A — Register the new tab in tabMap / titleMap
══════════════════════════════════════════════════════════ */
tabMap['inventory'] = 'viewInventory';
titleMap['inventory'] = ['Inventory Hub', 'Stock & Demand'];


/* ══════════════════════════════════════════════════════════
   B — MODULE STATE
══════════════════════════════════════════════════════════ */
// Tracks unsaved per-row changes: Map<docId, { stock?, linkedProductId? }>
const invDirtyMap = new Map();

// Full waitlist raw data: Array of Firestore docs
let allWaitlistEntries = [];

// Currently-filtered stock rows (for the low-stock filter toggle)
let invFilterLowStock = false;


/* ══════════════════════════════════════════════════════════
   C — STOCK & UPSELL MANAGER
══════════════════════════════════════════════════════════ */

/**
 * loadInventoryHub()
 * Entry point called on nav click. Renders the stock table
 * (reuses allProducts already in memory) and fetches waitlist.
 */
async function loadInventoryHub() {
    invDirtyMap.clear();
    invFilterLowStock = false;
    renderStockTable(allProducts);
    updateBulkBar();
    // Waitlist is fetched lazily when user switches to that sub-tab,
    // but we load the badge count immediately.
    await fetchWaitlistBadge();
}

/**
 * renderStockTable(products)
 * Builds the inline-editable stock & upsell table.
 */
function renderStockTable(products) {
    const tbody = document.getElementById('invStockTableBody');
    const countEl = document.getElementById('stockProductCount');
    if (!tbody) return;

    const display = invFilterLowStock
        ? products.filter(p => (Number(p.stock) || 0) <= 5)
        : products;

    if (countEl) countEl.textContent = `${display.length} product${display.length !== 1 ? 's' : ''}`;

    if (display.length === 0) {
        tbody.innerHTML = `<tr class="table-status-row"><td colspan="7">
            ${invFilterLowStock ? 'No low-stock products — great! 🎉' : 'No products found.'}
        </td></tr>`;
        updateLowStockStrip(products);
        return;
    }

    tbody.innerHTML = display.map(p => buildStockRow(p)).join('');
    updateLowStockStrip(products);
}

/**
 * buildStockRow(p)
 * Constructs one editable <tr> for a product.
 */
function buildStockRow(p) {
    const stock = Number(p.stock) ?? 0;
    const imgSrc = (p.images && p.images[0]) ? p.images[0] : (p.image || '');
    const img = imgSrc
        ? `<img src="${imgSrc}" alt="${escInv(p.name)}" class="table-img" loading="lazy">`
        : `<div class="table-img-placeholder"><i class="fa-solid fa-gem"></i></div>`;

    // Stock badge
    let badgeCls = 'ok', badgeTxt = 'In Stock';
    if (stock === 0) { badgeCls = 'zero'; badgeTxt = 'Out of Stock'; }
    else if (stock <= 5) { badgeCls = 'low'; badgeTxt = 'Low'; }

    // Pre-fill dirty values if the user has already changed them
    const dirty = invDirtyMap.get(p.docId) || {};
    const stockVal = dirty.stock !== undefined ? dirty.stock : stock;
    const stockInputClass = dirty.stock !== undefined ? 'inv-stock-input is-dirty' : 'inv-stock-input';
    const linkedVal = dirty.linkedProductId !== undefined ? dirty.linkedProductId : (p.linkedProductId || '');

    // Build the linked-product <select>
    const linkedOptions = allProducts
        .filter(op => op.docId !== p.docId)
        .map(op => `<option value="${op.docId}" ${op.docId === linkedVal ? 'selected' : ''}>${escInv(op.name)}</option>`)
        .join('');
    const selectDirtyCls = dirty.linkedProductId !== undefined ? 'inv-linked-select is-dirty' : 'inv-linked-select';

    return `
    <tr data-product-id="${p.docId}">
        <td>${img}</td>
        <td>
            <div class="table-product-name">${escInv(p.name)}</div>
            <div class="table-product-stone" style="font-size:0.72rem;">${escInv(p.category || '—')}</div>
        </td>
        <td><span class="category-tag">${escInv(p.category || '—')}</span></td>
        <td class="table-price">₹${Number(p.price || 0).toLocaleString('en-IN')}</td>

        <!-- Stock input -->
        <td>
            <div style="display:flex;align-items:center;gap:6px;">
                <input
                    type="number"
                    class="${stockInputClass}"
                    data-action="edit-stock"
                    data-product-id="${p.docId}"
                    value="${stockVal}"
                    min="0"
                    step="1"
                    aria-label="Stock quantity for ${escInv(p.name)}">
                <span class="inv-stock-badge ${badgeCls}">${badgeTxt}</span>
            </div>
        </td>

        <!-- Linked-product select -->
        <td>
            <select
                class="${selectDirtyCls}"
                data-action="edit-linked"
                data-product-id="${p.docId}"
                aria-label="Linked product for ${escInv(p.name)}">
                <option value="">— None —</option>
                ${linkedOptions}
            </select>
        </td>

        <!-- Per-row save -->
        <td>
            <button
                class="inv-save-row-btn"
                data-action="save-row"
                data-product-id="${p.docId}"
                ${invDirtyMap.has(p.docId) ? '' : 'disabled'}>
                <i class="fa-solid fa-floppy-disk"></i> Save
            </button>
        </td>
    </tr>`;
}

/**
 * updateLowStockStrip(products)
 * Shows / hides the amber low-stock warning strip.
 */
function updateLowStockStrip(products) {
    const strip = document.getElementById('invLowStockStrip');
    const msg = document.getElementById('invLowStockMsg');
    if (!strip) return;
    const lowCount = products.filter(p => (Number(p.stock) || 0) <= 5).length;
    if (lowCount > 0) {
        strip.hidden = false;
        if (msg) msg.textContent = `${lowCount} product${lowCount !== 1 ? 's' : ''} low or out of stock`;
    } else {
        strip.hidden = true;
    }
}

/**
 * saveStockRow(docId)
 * Writes only the dirty fields for one product to Firestore.
 */
async function saveStockRow(docId) {
    const dirty = invDirtyMap.get(docId);
    if (!dirty || Object.keys(dirty).length === 0) return;

    const saveBtn = document.querySelector(
        `.inv-save-row-btn[data-product-id="${docId}"]`
    );
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    // Build the Firestore update payload
    const payload = {};
    if (dirty.stock !== undefined) payload.stock = Number(dirty.stock);
    if (dirty.linkedProductId !== undefined) payload.linkedProductId = dirty.linkedProductId || null;

    try {
        await updateDoc(doc(db, 'products', docId), payload);

        // Patch the local allProducts cache
        const p = allProducts.find(x => x.docId === docId);
        if (p) {
            if (dirty.stock !== undefined) p.stock = Number(dirty.stock);
            if (dirty.linkedProductId !== undefined) p.linkedProductId = dirty.linkedProductId || null;
        }

        invDirtyMap.delete(docId);

        // Visual feedback
        if (saveBtn) {
            saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
            saveBtn.classList.add('saved');
            setTimeout(() => {
                if (saveBtn) {
                    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
                    saveBtn.classList.remove('saved');
                    saveBtn.disabled = true;
                }
            }, 2000);
        }

        // Clear dirty styling on inputs
        document.querySelector(`.inv-stock-input[data-product-id="${docId}"]`)
            ?.classList.remove('is-dirty');
        document.querySelector(`.inv-linked-select[data-product-id="${docId}"]`)
            ?.classList.remove('is-dirty');

        updateBulkBar();
        toast(`Saved — ${p?.name || docId} ✦`, 'success');
    } catch (err) {
        console.error('[Inventory] saveStockRow:', err);
        toast('Save failed. Check Firestore rules.', 'error');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save';
        }
    }
}

/**
 * saveAllDirtyRows()
 * Bulk-saves all rows with pending changes.
 */
async function saveAllDirtyRows() {
    const btn = document.getElementById('invBulkSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…'; }

    const ids = [...invDirtyMap.keys()];
    let successCount = 0;

    await Promise.allSettled(
        ids.map(async id => {
            try {
                await saveStockRow(id);
                successCount++;
            } catch (_) { /* individual errors are already toasted */ }
        })
    );

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save All Changes'; }
    if (successCount > 0) toast(`${successCount} product${successCount !== 1 ? 's' : ''} updated ✦`, 'success');
    updateBulkBar();
}

/**
 * updateBulkBar()
 * Shows / hides the floating bulk-save bar based on dirty count.
 */
function updateBulkBar() {
    const bar = document.getElementById('invBulkBar');
    const count = document.getElementById('invBulkCount');
    if (!bar) return;
    const n = invDirtyMap.size;
    bar.hidden = n === 0;
    if (count) count.textContent = `${n} unsaved change${n !== 1 ? 's' : ''}`;
}

// ── Event delegation: Stock table ────────────────────────
document.getElementById('invStockTableBody')?.addEventListener('input', e => {
    const el = e.target;
    const action = el.dataset.action;
    const productId = el.dataset.productId;
    if (!productId) return;

    const existing = invDirtyMap.get(productId) || {};

    if (action === 'edit-stock') {
        existing.stock = el.value;
        el.classList.add('is-dirty');
    } else if (action === 'edit-linked') {
        existing.linkedProductId = el.value;
        el.classList.add('is-dirty');
    } else {
        return;
    }

    invDirtyMap.set(productId, existing);

    // Enable the per-row save button
    const saveBtn = document.querySelector(`.inv-save-row-btn[data-product-id="${productId}"]`);
    if (saveBtn) saveBtn.disabled = false;

    updateBulkBar();
});

document.getElementById('invStockTableBody')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action="save-row"]');
    if (!btn) return;
    await saveStockRow(btn.dataset.productId);
});

// ── Search / filter ─────────────────────────────────────
document.getElementById('inventorySearchInput')?.addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    const filtered = term
        ? allProducts.filter(p =>
            (p.name || '').toLowerCase().includes(term) ||
            (p.category || '').toLowerCase().includes(term) ||
            (p.stone || '').toLowerCase().includes(term)
        )
        : allProducts;
    renderStockTable(filtered);
});

// ── Low-stock filter toggle ──────────────────────────────
document.getElementById('invShowLowStockBtn')?.addEventListener('click', () => {
    invFilterLowStock = true;
    renderStockTable(allProducts);
});
document.getElementById('invClearLowStockBtn')?.addEventListener('click', () => {
    invFilterLowStock = false;
    renderStockTable(allProducts);
});

// ── Refresh ──────────────────────────────────────────────
document.getElementById('refreshStockBtn')?.addEventListener('click', async () => {
    invDirtyMap.clear();
    updateBulkBar();
    // Re-fetch products to get the latest stock values from Firestore
    try {
        const snap = await getDocs(query(collection(db, 'products'), orderBy('name')));
        allProducts = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
        renderStockTable(allProducts);
        toast('Stock data refreshed ✦', 'info');
    } catch (err) {
        console.error('[Inventory] refresh:', err);
        toast('Refresh failed. Check console.', 'error');
    }
});

// ── Bulk save / discard ──────────────────────────────────
document.getElementById('invBulkSaveBtn')?.addEventListener('click', saveAllDirtyRows);
document.getElementById('invBulkDiscardBtn')?.addEventListener('click', () => {
    invDirtyMap.clear();
    updateBulkBar();
    renderStockTable(allProducts);
    toast('Changes discarded.', 'info');
});


/* ══════════════════════════════════════════════════════════
   D — WAITLIST / DEMAND TRACKER
══════════════════════════════════════════════════════════ */

/**
 * fetchWaitlistBadge()
 * Lightweight count fetch — runs on every inventory tab open
 * so the nav badge is always up-to-date.
 */
async function fetchWaitlistBadge() {
    try {
        const snap = await getDocs(collection(db, 'waitlist'));
        const unique = new Set(snap.docs.map(d => d.data().productId)).size;
        setWaitlistBadge(unique);
    } catch (_) { /* silent: collection may not exist yet */ }
}

function setWaitlistBadge(count) {
    const navBadge = document.getElementById('waitlistBadge');
    const tabBadge = document.getElementById('waitlistTabBadge');
    [navBadge, tabBadge].forEach(el => {
        if (!el) return;
        el.textContent = count;
        el.style.display = count > 0 ? 'inline-flex' : 'none';
    });
}

/**
 * loadWaitlist()
 * Full fetch + render of the demand tracker panel.
 */
async function loadWaitlist() {
    const grid = document.getElementById('waitlistGrid');
    if (grid) grid.innerHTML = `<div class="analytics-empty" style="grid-column:1/-1;">
        <i class="fa-solid fa-spinner fa-spin" style="font-size:1.6rem;"></i>
        <p>Fetching waitlist data…</p>
    </div>`;

    // Hide raw entries table while loading
    const rawWrap = document.getElementById('waitlistRawWrap');
    if (rawWrap) rawWrap.hidden = true;

    try {
        const snap = await getDocs(
            query(collection(db, 'waitlist'), orderBy('createdAt', 'desc'))
        );
        allWaitlistEntries = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
        renderWaitlistGrid(allWaitlistEntries);
        setWaitlistBadge(countUniqueProducts(allWaitlistEntries));
    } catch (err) {
        console.error('[Inventory] loadWaitlist:', err);
        if (grid) grid.innerHTML = `<div class="analytics-empty" style="grid-column:1/-1;">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <p>Failed to load waitlist. Check Firestore rules & indexes.</p>
        </div>`;
        toast('Failed to load waitlist data.', 'error');
    }
}

/**
 * renderWaitlistGrid(entries)
 * Groups entries by productId and renders demand cards.
 */
function renderWaitlistGrid(entries) {
    const grid = document.getElementById('waitlistGrid');
    if (!grid) return;

    // ── Group by productId ──────────────────────────────
    const grouped = {};   // { productId: { entries[], productName } }
    entries.forEach(e => {
        const pid = e.productId || 'unknown';
        if (!grouped[pid]) {
            grouped[pid] = {
                productId: pid,
                productName: e.productName || e.name || pid,
                entries: []
            };
        }
        grouped[pid].entries.push(e);
    });

    const sorted = Object.values(grouped)
        .sort((a, b) => b.entries.length - a.entries.length);

    // ── Update KPI strip ────────────────────────────────
    const totalEntries = entries.length;
    const totalProducts = sorted.length;
    const hottest = sorted[0]?.productName || '—';

    setText('wlTotalEntries', totalEntries.toString());
    setText('wlTotalProducts', totalProducts.toString());
    setText('wlTopProduct', hottest.length > 20 ? hottest.slice(0, 18) + '…' : hottest);

    if (sorted.length === 0) {
        grid.innerHTML = `<div class="analytics-empty" style="grid-column:1/-1;">
            <i class="fa-solid fa-hourglass"></i>
            <p>No waitlist entries yet. They'll appear here when customers join.</p>
        </div>`;
        return;
    }

    const maxCount = sorted[0].entries.length;

    grid.innerHTML = sorted.map((group, i) => {
        const count = group.entries.length;
        const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0;
        const hotCls = i === 0 ? 'hot' : '';
        const latestTs = group.entries[0]?.createdAt;
        const latestStr = latestTs
            ? (latestTs.seconds
                ? new Date(latestTs.seconds * 1000)
                : new Date(latestTs)
            ).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
            : '—';

        return `
        <div class="waitlist-card"
             data-action="view-wl-entries"
             data-product-id="${escInv(group.productId)}">
            <div class="waitlist-card-top">
                <div>
                    <div class="waitlist-card-name">${escInv(group.productName)}</div>
                    <div class="waitlist-card-id">${escInv(group.productId)}</div>
                </div>
                <div class="waitlist-count-badge ${hotCls}">${count}</div>
            </div>
            <div class="waitlist-demand-bar-wrap">
                <div class="waitlist-demand-bar" style="width:${pct}%"></div>
            </div>
            <div class="waitlist-card-footer">
                <span>Latest: ${latestStr}</span>
                <button class="wl-view-entries-btn"
                        data-action="view-wl-entries"
                        data-product-id="${escInv(group.productId)}">
                    View entries →
                </button>
            </div>
        </div>`;
    }).join('');
}

/**
 * showWaitlistRawEntries(productId)
 * Expands a table below the grid showing individual contact info.
 */
function showWaitlistRawEntries(productId) {
    const entries = allWaitlistEntries.filter(e => e.productId === productId);
    const rawWrap = document.getElementById('waitlistRawWrap');
    const title = document.getElementById('waitlistRawTitle');
    const tbody = document.getElementById('waitlistRawBody');
    if (!rawWrap || !tbody) return;

    const group = allWaitlistEntries.find(e => e.productId === productId);
    const name = group?.productName || group?.name || productId;

    if (title) title.textContent = `Entries for "${name}" (${entries.length})`;

    tbody.innerHTML = entries.map((e, i) => {
        const contact = e.email || e.phone || e.contact || '—';
        const ts = e.createdAt;
        const dateStr = ts
            ? (ts.seconds
                ? new Date(ts.seconds * 1000)
                : new Date(ts)
            ).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
            ' ' +
            (ts.seconds
                ? new Date(ts.seconds * 1000)
                : new Date(ts)
            ).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
            : '—';
        return `
        <tr>
            <td style="font-size:0.78rem;color:var(--text-muted);">${i + 1}</td>
            <td style="font-size:0.84rem;">${escInv(contact)}</td>
            <td style="font-size:0.78rem;white-space:nowrap;">${dateStr}</td>
        </tr>`;
    }).join('');

    rawWrap.hidden = false;
    rawWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Event delegation: Waitlist grid (card & button clicks) ──
document.getElementById('waitlistGrid')?.addEventListener('click', e => {
    const trigger = e.target.closest('[data-action="view-wl-entries"]');
    if (!trigger) return;
    showWaitlistRawEntries(trigger.dataset.productId);
});

// ── Close raw entries ────────────────────────────────────
document.getElementById('closeWaitlistRawBtn')?.addEventListener('click', () => {
    const rawWrap = document.getElementById('waitlistRawWrap');
    if (rawWrap) rawWrap.hidden = true;
});

// ── Refresh waitlist ─────────────────────────────────────
document.getElementById('refreshWaitlistBtn')?.addEventListener('click', loadWaitlist);


/* ══════════════════════════════════════════════════════════
   E — INVENTORY SUB-TAB SWITCHER
══════════════════════════════════════════════════════════ */
document.querySelectorAll('[data-invtab]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-invtab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.inv-panel').forEach(p => p.classList.remove('active'));
        const panelMap = {
            stock: 'invPanelStock',
            waitlist: 'invPanelWaitlist'
        };
        document.getElementById(panelMap[btn.dataset.invtab])?.classList.add('active');

        // Lazy-load waitlist data on first switch
        if (btn.dataset.invtab === 'waitlist' && allWaitlistEntries.length === 0) {
            loadWaitlist();
        }
    });
});


/* ══════════════════════════════════════════════════════════
   F — WIRE INVENTORY TAB INTO NAV
   Piggybacks on the existing nav-item click delegation,
   same pattern as Analytics and Reviews (Phase 1).
══════════════════════════════════════════════════════════ */
document.querySelectorAll('.nav-item[data-tab]').forEach(navBtn => {
    navBtn.addEventListener('click', () => {
        if (navBtn.dataset.tab === 'inventory') {
            loadInventoryHub();
        }
    });
});


/* ══════════════════════════════════════════════════════════
   G — HELPER UTILITIES (local to this module)
══════════════════════════════════════════════════════════ */
function escInv(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function countUniqueProducts(entries) {
    return new Set(entries.map(e => e.productId)).size;
}

/* ══════════════════════════════════════════════════════════
   NAVBAR CATEGORIES — CRUD + REORDER
   Firestore collection: `categories`
   Fields: name (string), link (string), order (number)
══════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────
let allCategories = [];        // sorted array of { docId, name, link, order }
let pendingDeleteCatDocId = null;

// ── DOM refs (resolved lazily after DOMContentLoaded) ─────
const catTableBody = () => document.getElementById('catTableBody');
const catCountBadge = () => document.getElementById('catCount');
const catModal = () => document.getElementById('catModal');
const catModalTitle = () => document.getElementById('catModalTitle');
const catNameInput = () => document.getElementById('catNameInput');
const catSlugInput = () => document.getElementById('catSlugInput');
const catEditDocId = () => document.getElementById('catEditDocId');
const deleteCatModal = () => document.getElementById('deleteCatModal');
const deleteCatModalName = () => document.getElementById('deleteCatModalName');

// ── 1. Load & render ──────────────────────────────────────
async function loadCategories() {
    try {
        const q = query(collection(db, 'categories'), orderBy('order', 'asc'));
        const snap = await getDocs(q);
        allCategories = snap.docs.map(d => ({ docId: d.id, ...d.data() }));
        renderCatTable();
    } catch (err) {
        console.error('loadCategories:', err);
        toast('Failed to load categories.', 'error');
    }
}

function renderCatTable() {
    const tbody = catTableBody();
    const badge = catCountBadge();
    if (!tbody) return;

    // Update sidebar count chip
    const sidebarCatCount = document.getElementById('sidebarCatCount');
    if (sidebarCatCount) sidebarCatCount.textContent = allCategories.length;
    if (badge) badge.textContent = allCategories.length;

    if (allCategories.length === 0) {
        tbody.innerHTML = `<tr class="table-status-row"><td colspan="5">No categories yet. Add one above.</td></tr>`;
        return;
    }

    tbody.innerHTML = allCategories.map((cat, idx) => `
        <tr data-cat-doc="${cat.docId}">
            <td><span class="topbar-badge">${cat.order}</span></td>
            <td><strong>${cat.name}</strong></td>
            <td><code style="font-size:0.8rem;opacity:0.75;">${cat.link}</code></td>
            <td>
                <button class="btn-ghost btn-icon cat-move-up"   data-idx="${idx}" title="Move Up"   ${idx === 0 ? 'disabled' : ''}>
                    <i class="fa-solid fa-chevron-up"></i>
                </button>
                <button class="btn-ghost btn-icon cat-move-down" data-idx="${idx}" title="Move Down" ${idx === allCategories.length - 1 ? 'disabled' : ''}>
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
            </td>
            <td>
                <button class="btn-ghost btn-icon cat-edit-btn" data-doc="${cat.docId}" title="Edit">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="btn-danger btn-icon cat-delete-btn" data-doc="${cat.docId}" data-name="${cat.name}" title="Delete">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

// ── 2. Open / close modal helpers ────────────────────────
function openCatModal(mode = 'add', cat = null) {
    catModalTitle().textContent = mode === 'edit' ? 'Edit Category' : 'Add Category';
    catNameInput().value = cat?.name ?? '';
    catSlugInput().value = cat?.link ?? '';
    catEditDocId().value = cat?.docId ?? '';

    // Reset icon picker
    const iconInput = document.getElementById('catIconInput');
    document.querySelectorAll('.icon-picker-btn').forEach(b => b.classList.remove('selected'));
    const existingIcon = cat?.icon ?? '';
    if (existingIcon) {
        const match = document.querySelector(`.icon-picker-btn[data-icon="${existingIcon}"]`);
        if (match) match.classList.add('selected');
    }
    if (iconInput) iconInput.value = existingIcon;

    catModal().classList.add('is-open');
    catNameInput().focus();
}

function closeCatModal() {
    catModal().classList.remove('is-open');        // ← FIXED: was 'active'
}

function openDeleteCatModal(docId, name) {
    pendingDeleteCatDocId = docId;
    deleteCatModalName().textContent = `"${name}"`;
    deleteCatModal().classList.add('is-open');     // ← FIXED: was 'active'
}

function closeDeleteCatModal() {
    pendingDeleteCatDocId = null;
    deleteCatModal().classList.remove('is-open'); // ← FIXED: was 'active'
}

// ── 3. Save (Add or Edit) ────────────────────────────────
async function saveCat() {
    const name = catNameInput().value.trim();
    const link = catSlugInput().value.trim();
    const docId = catEditDocId().value;

    if (!name || !link) {
        toast('Please fill in both Name and Link.', 'warning');
        return;
    }

    const saveCatBtn = document.getElementById('saveCatBtn');
    saveCatBtn.disabled = true;
    saveCatBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

    try {
        if (docId) {
            // Edit existing
            const iconVal = document.getElementById('catIconInput')?.value || '';
            await updateDoc(doc(db, 'categories', docId), { name, link, icon: iconVal });
            toast(`Category "${name}" updated.`, 'success');
        } else {
            // Add new — assign next order value
            const nextOrder = allCategories.length > 0
                ? Math.max(...allCategories.map(c => c.order)) + 1
                : 1;
            const iconVal = document.getElementById('catIconInput')?.value || '';
            await addDoc(collection(db, 'categories'), { name, link, order: nextOrder, icon: iconVal });
            toast(`Category "${name}" added.`, 'success');
        }
        closeCatModal();
        await loadCategories();
    } catch (err) {
        console.error('saveCat:', err);
        toast('Save failed. Check console.', 'error');
    } finally {
        saveCatBtn.disabled = false;
        saveCatBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Category';
    }
}

// ── 4. Delete ─────────────────────────────────────────────
async function deleteCat() {
    if (!pendingDeleteCatDocId) return;
    try {
        await deleteDoc(doc(db, 'categories', pendingDeleteCatDocId));
        toast('Category deleted.', 'success');
        closeDeleteCatModal();
        await loadCategories();
    } catch (err) {
        console.error('deleteCat:', err);
        toast('Delete failed.', 'error');
    }
}

// ── 5. Reorder (swap adjacent items) ─────────────────────
async function moveCat(idx, direction) {
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= allCategories.length) return;

    const a = allCategories[idx];
    const b = allCategories[swapIdx];

    // Swap order values in Firestore as a batch
    const batch = writeBatch(db);
    batch.update(doc(db, 'categories', a.docId), { order: b.order });
    batch.update(doc(db, 'categories', b.docId), { order: a.order });

    try {
        await batch.commit();
        await loadCategories();
    } catch (err) {
        console.error('moveCat:', err);
        toast('Reorder failed.', 'error');
    }
}

// ── 6. Event delegation for the Categories view ──────────
document.addEventListener('click', e => {

    // Icon Picker selection
    const iconBtn = e.target.closest('.icon-picker-btn');
    if (iconBtn && iconBtn.closest('#iconPickerGrid')) {
        document.querySelectorAll('.icon-picker-btn').forEach(b => b.classList.remove('selected'));
        iconBtn.classList.add('selected');
        document.getElementById('catIconInput').value = iconBtn.dataset.icon;
        return;
    }

    // Open Add modal
    if (e.target.closest('#openAddCatModalBtn')) {
        openCatModal('add');
        return;
    }

    // Close modals
    if (e.target.closest('#cancelCatModalBtn')) { closeCatModal(); return; }
    if (e.target.closest('#cancelDeleteCatBtn')) { closeDeleteCatModal(); return; }

    // Save
    if (e.target.closest('#saveCatBtn')) { saveCat(); return; }

    // Confirm delete
    if (e.target.closest('#confirmDeleteCatBtn')) { deleteCat(); return; }

    // Edit row
    const editBtn = e.target.closest('.cat-edit-btn');
    if (editBtn) {
        const cat = allCategories.find(c => c.docId === editBtn.dataset.doc);
        if (cat) openCatModal('edit', cat);
        return;
    }

    // Delete row
    const deleteBtn = e.target.closest('.cat-delete-btn');
    if (deleteBtn) {
        openDeleteCatModal(deleteBtn.dataset.doc, deleteBtn.dataset.name);
        return;
    }

    // Move up
    const upBtn = e.target.closest('.cat-move-up');
    if (upBtn) { moveCat(parseInt(upBtn.dataset.idx), 'up'); return; }

    // Move down
    const downBtn = e.target.closest('.cat-move-down');
    if (downBtn) { moveCat(parseInt(downBtn.dataset.idx), 'down'); return; }
});