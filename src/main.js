import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { isTauri } from '@tauri-apps/api/core';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { writeFile as writeTauriFile } from '@tauri-apps/plugin-fs';
import { jsPDF } from 'jspdf';

// Only register the offline-cache service worker on the deployed web/PWA build —
// Tauri and Capacitor already load the app from a local bundle, not a real
// same-origin fetchable server, so a service worker there is unnecessary and,
// on some native webviews, unsupported.
if ('serviceWorker' in navigator && !isTauri() && !Capacitor.isNativePlatform()) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(function () {});
  });
}

var STORAGE_KEY = 'checklist-collection-state-v1';
var TEMPLATES_KEY = 'checklist-collection-templates-v1';
var THEME_KEY = 'checklist-collection-theme';

function uid() { return Math.random().toString(36).slice(2, 10); }

// Checklist tab accent colors: one mid-tone step per hue drawn from the Cypress
// Blue/Red/Green swatches (see the --tab-color-0.. custom properties in style.css),
// chosen so every slot has solid contrast against both themes' backgrounds without
// needing a per-theme override. Assigned per checklist id via a hash (stable
// regardless of tab order or how many other checklists are open).
var TAB_COLOR_SLOT_COUNT = 8;
function tabColorVarForId(id) {
  var hash = 0;
  for (var i = 0; i < id.length; i++) { hash = (hash * 31 + id.charCodeAt(i)) >>> 0; }
  return 'var(--tab-color-' + (hash % TAB_COLOR_SLOT_COUNT) + ')';
}

// Response fields a filled-in checklist item carries that a template item does not.
function defaultResponseFields(type) {
  if (type === 'checkbox') return { checked: false };
  if (type === 'text') return { text: '' };
  if (type === 'photo') return { photo: null };
  if (type === 'signoff') {
    var supportsTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    return { mode: supportsTouch ? 'draw' : 'type', signature: null, name: '', date: '' };
  }
  return {};
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function newChecklist(seed) {
  return {
    id: uid(),
    title: (seed && seed.title) || 'Untitled Checklist',
    inspector: '',
    date: '',
    items: (seed && seed.items) || [],
    // Locking freezes the item list (add/remove/reorder) so a filled-in checklist
    // can't be structurally changed by accident while still being used — checking
    // boxes, typing responses, photos, and signatures stay editable regardless.
    locked: !!(seed && seed.locked)
  };
}

function defaultState() {
  var first = newChecklist({
    title: 'Site Walkthrough Checklist',
    items: [
      { id: uid(), label: 'Safety', type: 'section' },
      { id: uid(), label: 'Fire extinguisher present and charged', type: 'checkbox', checked: false },
      { id: uid(), label: 'Note any visible damage', type: 'text', text: '' },
      { id: uid(), label: 'Documentation', type: 'section' },
      { id: uid(), label: 'Photo of panel nameplate', type: 'photo', photo: null }
    ]
  });
  return {
    collectionTitle: 'Site Inspection Collection',
    collectionDescription: '',
    checklists: [first],
    activeId: first.id
  };
}

async function loadState() {
  try {
    var raw = (await Preferences.get({ key: STORAGE_KEY })).value;
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.checklists) && parsed.checklists.length) return parsed;
    }
  } catch (e) { /* storage unavailable or corrupt — fall through */ }
  return defaultState();
}

function saveState() {
  Preferences.set({ key: STORAGE_KEY, value: JSON.stringify(state) })
    .then(function () { stampAutosave(); })
    .catch(function () { /* storage full or unavailable; edits stay in-memory only */ });
}

function stampAutosave() {
  var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  autosaveStampEl.textContent = 'Saved ' + time;
}

var state;

function getActive() {
  var found = state.checklists.find(function (c) { return c.id === state.activeId; });
  return found || state.checklists[0];
}

// A template holds only checklist structure (title/description/items with their
// labels and types) — never response values — so it can be reused to start fresh
// checklists without carrying over anyone's filled-in answers.
async function loadTemplates() {
  try {
    var raw = (await Preferences.get({ key: TEMPLATES_KEY })).value;
    if (raw) {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* storage unavailable or corrupt — fall through */ }
  return [];
}

function saveTemplates() {
  Preferences.set({ key: TEMPLATES_KEY, value: JSON.stringify(templates) })
    .catch(function () { /* storage full or unavailable; edits stay in-memory only */ });
}

var templates;

function templateItemFromItem(item) {
  return { id: uid(), label: item.label, type: item.type };
}

function createTemplateFromChecklist(checklist, title) {
  return {
    id: uid(),
    title: (title && title.trim()) || checklist.title || 'Untitled Template',
    description: '',
    items: checklist.items.map(templateItemFromItem),
    locked: !!checklist.locked
  };
}

// A locked template's checklists start locked too — locking a template only ever
// makes sense through this inheritance, since templates have no items UI of their
// own to protect (they're structure snapshots, edited only via rename/description).
function checklistFromTemplate(template) {
  return newChecklist({
    title: template.title,
    items: template.items.map(function (templateItem) {
      return Object.assign(
        { id: uid(), label: templateItem.label, type: templateItem.type },
        defaultResponseFields(templateItem.type)
      );
    }),
    locked: !!template.locked
  });
}

// File formats for sharing with someone else, e.g. by email or AirDrop: small JSON
// files they can import into their own copy of the app. Three shapes:
//  - a single template (structure only, no responses)
//  - a "pack" of several templates at once — the common case, e.g. handing someone
//    your whole set of inspection checklists in one file
//  - a full collection: everything currently open, responses (and photos/
//    signatures) included, so someone can pick up exactly where you left off
var TEMPLATE_FILE_TYPE = 'checklist-collection-template';
var TEMPLATE_PACK_FILE_TYPE = 'checklist-collection-template-pack';
var COLLECTION_FILE_TYPE = 'checklist-collection-full';
var FILE_FORMAT_VERSION = 1;

function slugifyFilename(name, fallback) {
  var slug = (name || '').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_');
  return slug || fallback;
}

function templateToPlainObject(template) {
  return {
    title: template.title,
    description: template.description || '',
    items: template.items.map(templateItemFromItem),
    locked: !!template.locked
  };
}

function templateToFileText(template) {
  return JSON.stringify({
    type: TEMPLATE_FILE_TYPE,
    version: FILE_FORMAT_VERSION,
    template: templateToPlainObject(template)
  }, null, 2);
}

function templatePackToFileText(templateList) {
  return JSON.stringify({
    type: TEMPLATE_PACK_FILE_TYPE,
    version: FILE_FORMAT_VERSION,
    templates: templateList.map(templateToPlainObject)
  }, null, 2);
}

function templateFilename(template) {
  return slugifyFilename(template.title, 'checklist_template') + '.checklist';
}

function templatePackFilename() {
  return slugifyFilename(state.collectionTitle, 'checklist_templates') + '_templates.checklist';
}

function templateFromRaw(raw) {
  return {
    id: uid(),
    title: (raw && raw.title && String(raw.title)) || 'Untitled Template',
    description: (raw && raw.description && String(raw.description)) || '',
    items: (raw && Array.isArray(raw.items) ? raw.items : [])
      .filter(function (item) { return item && typeof item.label === 'string' && typeof item.type === 'string'; })
      .map(function (item) { return { id: uid(), label: item.label, type: item.type }; }),
    locked: !!(raw && raw.locked)
  };
}

// Throws a descriptive Error if the text isn't a template (or template pack) file
// this app can read. Always returns an array — one entry for a single-template file.
function templatesFromFileText(text) {
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('That file is not valid JSON.');
  }
  if (parsed && parsed.type === TEMPLATE_FILE_TYPE && parsed.template) {
    return [templateFromRaw(parsed.template)];
  }
  if (parsed && parsed.type === TEMPLATE_PACK_FILE_TYPE && Array.isArray(parsed.templates)) {
    return parsed.templates.map(templateFromRaw);
  }
  throw new Error('That file is not a checklist template.');
}

function collectionToFileText() {
  return JSON.stringify({
    type: COLLECTION_FILE_TYPE,
    version: FILE_FORMAT_VERSION,
    collection: {
      collectionTitle: state.collectionTitle,
      collectionDescription: state.collectionDescription,
      checklists: state.checklists.map(function (c) {
        return { title: c.title, inspector: c.inspector, date: c.date, items: c.items, locked: !!c.locked };
      })
    }
  }, null, 2);
}

function collectionFilename() {
  return slugifyFilename(state.collectionTitle, 'checklist_collection') + '.checklist';
}

function checklistFromRaw(raw) {
  return {
    id: uid(),
    title: (raw && raw.title && String(raw.title)) || 'Untitled Checklist',
    inspector: (raw && raw.inspector && String(raw.inspector)) || '',
    date: (raw && raw.date && String(raw.date)) || '',
    items: (raw && Array.isArray(raw.items) ? raw.items : [])
      .filter(function (item) { return item && typeof item.label === 'string' && typeof item.type === 'string'; })
      .map(function (item) { return Object.assign({}, item, { id: uid() }); }),
    locked: !!(raw && raw.locked)
  };
}

// Throws a descriptive Error if the text isn't a full-collection file this app can read.
function collectionFromFileText(text) {
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || parsed.type !== COLLECTION_FILE_TYPE || !parsed.collection || !Array.isArray(parsed.collection.checklists)) {
    throw new Error('That file is not a checklist collection.');
  }
  var raw = parsed.collection;
  var checklists = raw.checklists.map(checklistFromRaw);
  if (checklists.length === 0) {
    throw new Error('That collection file has no checklists in it.');
  }
  return {
    collectionTitle: (raw.collectionTitle && String(raw.collectionTitle)) || 'Untitled Collection',
    collectionDescription: (raw.collectionDescription && String(raw.collectionDescription)) || '',
    checklists: checklists,
    activeId: checklists[0].id
  };
}

var itemListEl = document.getElementById('itemList');
var tabBarEl = document.getElementById('tabBar');
var collectionTitleInput = document.getElementById('collectionTitleInput');
var checklistTitleInput = document.getElementById('checklistTitleInput');
var inspectorInput = document.getElementById('inspectorInput');
var dateInput = document.getElementById('dateInput');
var newItemLabelEl = document.getElementById('newItemLabel');
var typeButtons = document.querySelectorAll('.type-btn');
var progressCountEl = document.getElementById('progressCount');
var progressFillEl = document.getElementById('progressFill');
var progressSrEl = document.getElementById('progressSr');
var remainingCountEl = document.getElementById('remainingCount');
var autosaveStampEl = document.getElementById('autosaveStamp');
var selectedType = 'checkbox';
var dragState = null;
var longPressTimer = null;
var tabDeleteArmedId = null;
var tabDeleteTimer = null;
var itemDeleteArmedId = null;
var itemDeleteTimer = null;
var deleteChecklistArmed = false;
var deleteChecklistTimer = null;
var openItemMenuId = null;
// Sign-off items show a compact "signed" card once they carry a valid signature,
// instead of the draw/type editing UI — this set tracks which signed items the
// user has explicitly reopened for editing (via the card's "Edit" link), so
// re-signing collapses back to the card rather than staying open indefinitely.
var signoffEditingIds = new Set();
var GRIP_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><circle cx="6" cy="4" r="1.6"/><circle cx="14" cy="4" r="1.6"/><circle cx="6" cy="10" r="1.6"/><circle cx="14" cy="10" r="1.6"/><circle cx="6" cy="16" r="1.6"/><circle cx="14" cy="16" r="1.6"/></svg>';
var LOCK_SVG = '<svg viewBox="0 0 20 20" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 9V6.5a4 4 0 0 1 8 0V9"/><rect x="4.5" y="9" width="11" height="8" rx="1.6" fill="currentColor" stroke="none"/></svg>';

// An item "answers" when it carries a real response; sections never count toward
// either side of the fraction. Used for the tab/header/action-bar completion counts.
function isItemAnswered(item) {
  if (item.type === 'checkbox') return !!item.checked;
  if (item.type === 'text') return !!(item.text && item.text.trim());
  if (item.type === 'photo') return !!item.photo;
  if (item.type === 'signoff') {
    return (item.mode !== 'type' && !!item.signature) || (item.mode === 'type' && !!(item.name && item.name.trim()));
  }
  return false;
}
function checklistProgress(checklist) {
  var answerable = checklist.items.filter(function (i) { return i.type !== 'section'; });
  var answered = answerable.filter(isItemAnswered).length;
  return { answered: answered, total: answerable.length };
}

var TYPE_META_LABEL = { checkbox: 'CHECK', text: 'TEXT', photo: 'PHOTO', signoff: 'SIGN-OFF' };

function itemMenuHtml(item, idx, itemsLen) {
  var open = openItemMenuId === item.id;
  var deleteArmed = itemDeleteArmedId === item.id;
  return (
    '<div class="item-menu-wrap">' +
      '<button type="button" class="item-menu" data-action="open-item-menu" data-id="' + item.id + '" aria-label="Item actions" aria-haspopup="true" aria-expanded="' + open + '">⋮</button>' +
      '<div class="item-popover" role="menu"' + (open ? '' : ' hidden') + '>' +
        '<button type="button" role="menuitem" data-action="move-up" data-id="' + item.id + '"' + (idx === 0 ? ' disabled' : '') + '>Move up</button>' +
        '<button type="button" role="menuitem" data-action="move-down" data-id="' + item.id + '"' + (idx === itemsLen - 1 ? ' disabled' : '') + '>Move down</button>' +
        '<button type="button" role="menuitem" data-action="duplicate-item" data-id="' + item.id + '">Duplicate</button>' +
        '<button type="button" role="menuitem" class="item-popover-delete ' + (deleteArmed ? 'confirm-pending' : '') + '" data-action="delete" data-id="' + item.id + '">' +
          (deleteArmed ? 'Click again to delete' : 'Delete') +
        '</button>' +
      '</div>' +
    '</div>'
  );
}

function sectionTemplate(item, idx, itemsLen, sectionCount) {
  return (
    '<li class="section-head" data-id="' + item.id + '" role="presentation">' +
      '<span class="section-label">' + escapeHtml(item.label) + '</span>' +
      '<span class="section-rule"></span>' +
      '<span class="section-count">' + sectionCount + (sectionCount === 1 ? ' item' : ' items') + '</span>' +
      '<span class="drag-handle" title="Drag to reorder">' + GRIP_SVG + '</span>' +
      itemMenuHtml(item, idx, itemsLen) +
    '</li>'
  );
}

function itemTemplate(item, num, idx, itemsLen) {
  var numStr = String(num).padStart(2, '0');
  var answered = isItemAnswered(item);
  var metaLabel = numStr + ' · ' + (TYPE_META_LABEL[item.type] || item.type.toUpperCase());

  var toggleHtml;
  if (item.type === 'checkbox') {
    toggleHtml =
      '<button type="button" class="check-toggle ' + (item.checked ? 'checked' : '') + '" ' +
      'data-action="toggle" data-id="' + item.id + '" aria-pressed="' + !!item.checked + '" aria-labelledby="item-label-' + item.id + '">' +
      '<svg viewBox="0 0 24 24" class="check-mark"><path d="M4 12.5 L9.5 18 L20 5" /></svg>' +
      '</button>';
  } else {
    // Read-only completion indicator for non-checkbox rows — not interactive,
    // the item's own response (text/photo/signature) is what's answered.
    toggleHtml =
      '<span class="check-toggle ' + (answered ? 'checked' : '') + '" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" class="check-mark"><path d="M4 12.5 L9.5 18 L20 5" /></svg>' +
      '</span>';
  }

  var responseHtml = '';
  if (item.type === 'text') {
    responseHtml =
      '<div class="item-response">' +
      '<input type="text" class="response-text" data-action="text" data-id="' + item.id + '" ' +
      'value="' + escapeHtml(item.text || '') + '" placeholder="Response">' +
      '</div>';
  } else if (item.type === 'photo') {
    if (item.photo) {
      responseHtml =
        '<div class="item-response"><div class="photo-row"><div class="photo-wrap">' +
        '<img src="' + item.photo.dataUrl + '" class="photo-thumb" alt="Attached photo">' +
        '<button type="button" class="photo-remove" data-action="remove-photo" data-id="' + item.id + '" aria-label="Remove photo">×</button>' +
        '</div></div></div>';
    } else {
      responseHtml =
        '<div class="item-response"><div class="photo-row">' +
        '<button type="button" class="photo-btn" data-action="photo" data-id="' + item.id + '">＋ Add photo</button>' +
        '</div></div>';
    }
  } else if (item.type === 'signoff') {
    var isSigned = answered;
    var showEditing = !isSigned || signoffEditingIds.has(item.id);
    if (showEditing) {
      var isDraw = item.mode !== 'type';
      responseHtml =
        '<div class="item-response"><div class="signoff-panel">' +
          '<div class="signoff-toggle" role="group" aria-label="Sign-off input mode">' +
            '<button type="button" class="mode-btn ' + (isDraw ? 'active' : '') + '" data-action="mode" data-mode="draw" data-id="' + item.id + '">Draw</button>' +
            '<button type="button" class="mode-btn ' + (!isDraw ? 'active' : '') + '" data-action="mode" data-mode="type" data-id="' + item.id + '">Type</button>' +
          '</div>' +
          (isDraw
            ? '<div class="signoff-draw-wrap">' +
                '<canvas class="signature-canvas" data-id="' + item.id + '"></canvas>' +
                '<button type="button" class="signoff-clear" data-action="clear-signature" data-id="' + item.id + '">Clear</button>' +
              '</div>'
            : '<input type="text" class="signoff-name-input" data-action="signoff-name" data-id="' + item.id + '" ' +
              'value="' + escapeHtml(item.name || '') + '" placeholder="Type your name">'
          ) +
          '<label class="meta-field signoff-date-field">Date' +
            '<input type="date" class="signoff-date-input" data-action="signoff-date" data-id="' + item.id + '" value="' + escapeHtml(item.date || '') + '">' +
          '</label>' +
        '</div></div>';
    } else {
      var signedMark = item.mode !== 'type'
        ? '<span class="signoff-signed-mark"><img src="' + item.signature + '" alt="Signature"></span>'
        : '<span class="signoff-signed-mark signoff-signed-name">' + escapeHtml(item.name) + '</span>';
      responseHtml =
        '<div class="item-response"><div class="signoff-signed-card">' +
          signedMark +
          '<div class="signoff-signed-rule"></div>' +
          '<div class="signoff-signed-meta"><span>Signed</span><span>' + (item.date ? escapeHtml(item.date) : '') + '</span></div>' +
          '<button type="button" class="signoff-edit-btn" data-action="edit-signoff" data-id="' + item.id + '">Edit</button>' +
        '</div></div>';
    }
  }

  var bodyToggleAttrs = item.type === 'checkbox' ? ' data-action="toggle" data-id="' + item.id + '"' : '';
  return (
    '<li class="item" data-id="' + item.id + '" data-type="' + item.type + '">' +
    toggleHtml +
    '<div class="item-body"' + bodyToggleAttrs + '>' +
      '<div class="item-label" id="item-label-' + item.id + '">' + escapeHtml(item.label) + '</div>' +
      '<div class="item-meta">' + metaLabel + '</div>' +
      responseHtml +
    '</div>' +
    '<span class="drag-handle" title="Drag to reorder">' + GRIP_SVG + '</span>' +
    itemMenuHtml(item, idx, itemsLen) +
    '</li>'
  );
}

function renderTabs() {
  var tabsHtml = state.checklists.map(function (c) {
    var active = c.id === state.activeId;
    var closeBtn = state.checklists.length > 1
      ? '<button type="button" class="tab-close ' + (tabDeleteArmedId === c.id ? 'confirm-pending' : '') + '" ' +
        'data-action="delete-tab" data-id="' + c.id + '" aria-label="Remove checklist" ' +
        'title="' + (tabDeleteArmedId === c.id ? 'Click again to remove' : 'Remove checklist') + '">×</button>'
      : '';
    var lockBadge = c.locked ? '<span class="tab-lock" title="Locked — item list can\'t be changed">' + LOCK_SVG + '</span>' : '';
    var progress = checklistProgress(c);
    var countHtml = progress.total
      ? '<span class="tab-count' + (progress.answered === progress.total ? ' complete' : '') + '">' + progress.answered + '/' + progress.total + '</span>'
      : '';
    return (
      '<div class="tab-btn ' + (active ? 'active' : '') + '" style="border-bottom-color:' + tabColorVarForId(c.id) + '" role="tab" aria-selected="' + active + '">' +
      '<span class="tab-label" data-action="switch-tab" data-id="' + c.id + '">' + lockBadge + escapeHtml(c.title || 'Untitled Checklist') + '</span>' +
      countHtml +
      closeBtn +
      '</div>'
    );
  }).join('');
  tabBarEl.innerHTML = tabsHtml + '<button type="button" id="addTabBtn" class="tab-add" aria-label="Add checklist" title="Add checklist">+</button>';
}

function render() {
  collectionTitleInput.value = state.collectionTitle;
  document.title = state.collectionTitle || 'Checklist Collection';

  renderTabs();

  var active = getActive();
  checklistTitleInput.value = active.title;
  inspectorInput.value = active.inspector;
  dateInput.value = active.date;

  var items = active.items;
  if (items.length === 0) {
    itemListEl.innerHTML = '<li class="empty-note">No items yet — add one below.</li>';
  } else {
    var counter = 0;
    itemListEl.innerHTML = items.map(function (item, idx) {
      if (item.type === 'section') {
        var sectionCount = 0;
        for (var j = idx + 1; j < items.length && items[j].type !== 'section'; j++) sectionCount++;
        return sectionTemplate(item, idx, items.length, sectionCount);
      }
      counter++;
      return itemTemplate(item, counter, idx, items.length);
    }).join('');
  }
  itemListEl.classList.toggle('locked', !!active.locked);
  if (dragState) {
    var draggedEl = itemListEl.querySelector('[data-id="' + dragState.id + '"]');
    if (draggedEl) draggedEl.classList.add('dragging');
  }
  setupSignatureCanvases();
  updateLockUI(active);
  updateProgressUI(active);
  deleteChecklistBtn.disabled = state.checklists.length <= 1;
}

function updateProgressUI(active) {
  var progress = checklistProgress(active);
  progressCountEl.textContent = progress.answered + ' / ' + progress.total;
  var pct = progress.total ? Math.round((progress.answered / progress.total) * 100) : 0;
  progressFillEl.style.width = pct + '%';
  progressFillEl.setAttribute('aria-valuemax', String(progress.total));
  progressFillEl.setAttribute('aria-valuenow', String(progress.answered));
  progressSrEl.textContent = progress.answered + ' of ' + progress.total + ' items answered';
  var remaining = progress.total - progress.answered;
  remainingCountEl.textContent = progress.total ? (remaining + (remaining === 1 ? ' item remaining' : ' items remaining')) : '';
}

// Add-item controls get disabled while the active checklist is locked; the lock
// toggle button's own label/color reflects the current state. The item list's own
// drag/menu controls are handled via the #itemList.locked CSS rule plus guards in
// their click/pointerdown handlers.
function updateLockUI(active) {
  var locked = !!active.locked;
  newItemLabelEl.disabled = locked;
  typeButtons.forEach(function (b) { b.disabled = locked; });
  document.querySelector('.add-row').classList.toggle('locked', locked);
  lockChecklistBtn.textContent = locked ? 'Unlock checklist' : 'Lock checklist';
  lockChecklistBtn.classList.toggle('is-locked', locked);
}

function setupSignatureCanvases() {
  var canvases = itemListEl.querySelectorAll('.signature-canvas');
  var items = getActive().items;
  canvases.forEach(function (canvas) {
    var id = canvas.dataset.id;
    var item = items.find(function (i) { return i.id === id; });
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    if (item && item.signature) {
      var img = new Image();
      img.onload = function () { ctx.drawImage(img, 0, 0, w, h); };
      img.src = item.signature;
    }
  });
}

collectionTitleInput.addEventListener('input', function () {
  state.collectionTitle = collectionTitleInput.value;
  document.title = state.collectionTitle || 'Checklist Collection';
  saveState();
});
checklistTitleInput.addEventListener('input', function () {
  var active = getActive();
  active.title = checklistTitleInput.value;
  saveState();
  var tabLabel = tabBarEl.querySelector('.tab-label[data-id="' + active.id + '"]');
  if (tabLabel) tabLabel.textContent = active.title || 'Untitled Checklist';
});
inspectorInput.addEventListener('input', function () { getActive().inspector = inspectorInput.value; saveState(); });
dateInput.addEventListener('input', function () { getActive().date = dateInput.value; saveState(); });

tabBarEl.addEventListener('click', function (e) {
  if (e.target.closest('#addTabBtn')) {
    var c = newChecklist();
    state.checklists.push(c);
    state.activeId = c.id;
    saveState(); render();
    checklistTitleInput.focus();
    checklistTitleInput.select();
    return;
  }
  var closeBtn = e.target.closest('.tab-close');
  if (closeBtn) {
    var id = closeBtn.dataset.id;
    if (tabDeleteArmedId !== id) {
      tabDeleteArmedId = id;
      clearTimeout(tabDeleteTimer);
      tabDeleteTimer = setTimeout(function () { tabDeleteArmedId = null; renderTabs(); }, 4000);
      renderTabs();
      return;
    }
    clearTimeout(tabDeleteTimer);
    tabDeleteArmedId = null;
    var idx = state.checklists.findIndex(function (c) { return c.id === id; });
    state.checklists = state.checklists.filter(function (c) { return c.id !== id; });
    if (state.activeId === id) {
      var nextIdx = Math.min(Math.max(0, idx - 1), state.checklists.length - 1);
      state.activeId = state.checklists[nextIdx].id;
    }
    saveState(); render();
    return;
  }
  var label = e.target.closest('[data-action="switch-tab"]');
  if (label && label.dataset.id !== state.activeId) {
    state.activeId = label.dataset.id;
    saveState(); render();
  }
});

itemListEl.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) {
    if (openItemMenuId) { openItemMenuId = null; render(); }
    return;
  }
  var id = btn.dataset.id;
  var action = btn.dataset.action;
  var active = getActive();
  var items = active.items;
  var idx = items.findIndex(function (i) { return i.id === id; });
  var item = idx === -1 ? null : items[idx];

  if (action === 'toggle' && item) {
    item.checked = !item.checked;
    saveState(); render();
  } else if (action === 'remove-photo' && item) {
    item.photo = null;
    saveState(); render();
  } else if (action === 'mode' && item) {
    item.mode = btn.dataset.mode;
    saveState(); render();
  } else if (action === 'clear-signature' && item) {
    item.signature = null;
    saveState(); render();
  } else if (action === 'photo' && item) {
    addPhotoToItem(item);
  } else if (action === 'edit-signoff' && item) {
    signoffEditingIds.add(id);
    render();
  } else if (action === 'open-item-menu') {
    openItemMenuId = openItemMenuId === id ? null : id;
    itemDeleteArmedId = null;
    render();
  } else if (action === 'move-up') {
    if (active.locked || idx <= 0) return;
    moveItem(idx, idx - 1);
    openItemMenuId = null;
    saveState(); render();
  } else if (action === 'move-down') {
    if (active.locked || idx === -1 || idx >= items.length - 1) return;
    moveItem(idx, idx + 1);
    openItemMenuId = null;
    saveState(); render();
  } else if (action === 'duplicate-item' && item) {
    if (active.locked) return;
    items.splice(idx + 1, 0, Object.assign({}, item, { id: uid() }));
    openItemMenuId = null;
    saveState(); render();
  } else if (action === 'delete') {
    if (active.locked) return;
    if (itemDeleteArmedId !== id) {
      itemDeleteArmedId = id;
      clearTimeout(itemDeleteTimer);
      itemDeleteTimer = setTimeout(function () { itemDeleteArmedId = null; render(); }, 4000);
      render();
      return;
    }
    clearTimeout(itemDeleteTimer);
    itemDeleteArmedId = null;
    openItemMenuId = null;
    active.items = active.items.filter(function (i) { return i.id !== id; });
    saveState(); render();
  }
});

// Closes an open item-actions popover on any click outside the item list, and
// collapses a sign-off that just became signed back to its compact "signed" card
// once the user clicks away from that specific row — never mid-stroke/mid-typing,
// since a click landing back inside the same <li> (drawing, toggling Draw/Type,
// clicking Clear) doesn't count as "away". Registered on the CAPTURE phase and
// deliberately not just delegated through itemListEl's own bubble-phase click
// handler: that handler calls render(), which replaces #itemList's children —
// detaching e.target — so a bubble-phase check running afterward would see a
// detached node whose closest('#itemList') always comes back null, making every
// click look like it happened outside the list and re-closing what was just opened.
document.addEventListener('click', function (e) {
  var needsRender = false;
  if (openItemMenuId && !e.target.closest('#itemList')) {
    openItemMenuId = null;
    clearTimeout(itemDeleteTimer);
    itemDeleteArmedId = null;
    needsRender = true;
  }

  if (signoffEditingIds.size) {
    var active = getActive();
    var clickedLi = e.target.closest('.item');
    var clickedId = clickedLi ? clickedLi.dataset.id : null;
    signoffEditingIds.forEach(function (id) {
      if (id === clickedId) return; // still interacting with this item's own row
      var item = active.items.find(function (i) { return i.id === id; });
      if (item && isItemAnswered(item)) { signoffEditingIds.delete(id); needsRender = true; }
    });
  }

  if (needsRender) render();
}, true);

itemListEl.addEventListener('input', function (e) {
  var action = e.target.dataset.action;
  var active = getActive();
  var item = active.items.find(function (i) { return i.id === e.target.dataset.id; });
  if (!item) return;
  if (action === 'text') { item.text = e.target.value; saveState(); }
  else if (action === 'signoff-name') { item.name = e.target.value; saveState(); }
  else if (action === 'signoff-date') { item.date = e.target.value; saveState(); }
});

var photoFileInput = document.getElementById('photoFileInput');
var pendingPhotoItemId = null;

function addPhotoToItem(item) {
  if (Capacitor.isNativePlatform()) {
    capturePhotoNative(item.id).catch(function (e) {
      var msg = e && e.message ? e.message : String(e);
      if (/cancel/i.test(msg)) return; // user backed out of the camera/library picker
      alert('Could not capture photo: ' + msg);
    });
  } else {
    pendingPhotoItemId = item.id;
    photoFileInput.click();
  }
}

// The native Camera plugin already downsizes via `width`; we still need the
// actual pixel dimensions for the PDF layout, so load the result once to read them.
function loadImageDimensions(dataUrl) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () { resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function capturePhotoNative(id) {
  var photo = await Camera.getPhoto({
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Prompt,
    quality: 82,
    width: 1600,
    correctOrientation: true
  });
  var dims = await loadImageDimensions(photo.dataUrl);
  var active = getActive();
  var item = active.items.find(function (i) { return i.id === id; });
  if (!item) return;
  item.photo = { dataUrl: photo.dataUrl, width: dims.width, height: dims.height };
  saveState(); render();
}

function resizePhotoFile(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var MAX_DIM = 1600;
        var srcW = img.naturalWidth, srcH = img.naturalHeight;
        var scale = Math.min(1, MAX_DIM / Math.max(srcW, srcH));
        var outW = Math.max(1, Math.round(srcW * scale));
        var outH = Math.max(1, Math.round(srcH * scale));
        var dataUrl = reader.result;
        try {
          var canvas = document.createElement('canvas');
          canvas.width = outW; canvas.height = outH;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, outW, outH);
          ctx.drawImage(img, 0, 0, outW, outH);
          dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        } catch (err) {
          outW = srcW; outH = srcH;
        }
        resolve({ dataUrl: dataUrl, width: outW, height: outH });
      };
      img.onerror = function () { reject(new Error('Could not read that photo. Try a different file.')); };
      img.src = reader.result;
    };
    reader.onerror = function () { reject(new Error('Could not read that photo. Try a different file.')); };
    reader.readAsDataURL(file);
  });
}

photoFileInput.addEventListener('change', async function () {
  var file = photoFileInput.files && photoFileInput.files[0];
  var id = pendingPhotoItemId;
  photoFileInput.value = '';
  pendingPhotoItemId = null;
  if (!file || !id) return;
  try {
    var photo = await resizePhotoFile(file);
    var active = getActive();
    var item = active.items.find(function (i) { return i.id === id; });
    if (!item) return;
    item.photo = photo;
    saveState(); render();
  } catch (e) {
    alert(e && e.message ? e.message : 'Could not read that photo.');
  }
});

function moveItem(fromIndex, toIndex) {
  var arr = getActive().items;
  var moved = arr.splice(fromIndex, 1)[0];
  arr.splice(toIndex, 0, moved);
}

function onDragMove(e) {
  if (!dragState) return;
  var items = getActive().items;
  var fromIndex = items.findIndex(function (i) { return i.id === dragState.id; });
  if (fromIndex === -1) return;
  var rows = itemListEl.querySelectorAll('.item, .section-head');
  for (var k = 0; k < rows.length; k++) {
    var row = rows[k];
    var overId = row.dataset.id;
    if (overId === dragState.id) continue;
    var overIndex = items.findIndex(function (i) { return i.id === overId; });
    if (overIndex === -1) continue;
    var rect = row.getBoundingClientRect();
    var mid = rect.top + rect.height / 2;
    if ((e.clientY < mid && fromIndex > overIndex) || (e.clientY > mid && fromIndex < overIndex)) {
      moveItem(fromIndex, overIndex);
      render();
      return;
    }
  }
}

function onDragEnd() {
  if (!dragState) return;
  dragState = null;
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragEnd);
  saveState();
  render();
}

function startDrag(li) {
  if (getActive().locked || !li) return;
  dragState = { id: li.dataset.id };
  li.classList.add('dragging');
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragEnd);
}

itemListEl.addEventListener('pointerdown', function (e) {
  var handle = e.target.closest('.drag-handle');
  if (!handle) return;
  var li = handle.closest('.item, .section-head');
  if (!li) return;
  e.preventDefault();
  startDrag(li);
});

// Touch has no hover-revealed drag handle, so a 400ms press-and-hold anywhere on
// the row starts the same drag — cancelled by releasing early or by moving the
// finger more than 8px (a scroll or a tap), so it doesn't hijack normal taps on
// the checkbox, response controls, or the item menu.
itemListEl.addEventListener('pointerdown', function (e) {
  if (e.pointerType !== 'touch') return;
  if (e.target.closest('.drag-handle, .item-menu-wrap, button, input, textarea, a, .signature-canvas')) return;
  var li = e.target.closest('.item, .section-head');
  if (!li || getActive().locked) return;
  var startX = e.clientX, startY = e.clientY;
  clearTimeout(longPressTimer);
  var moved = false;
  function onMove(ev) {
    if (Math.abs(ev.clientX - startX) > 8 || Math.abs(ev.clientY - startY) > 8) {
      moved = true;
      cancel();
    }
  }
  function cancel() {
    clearTimeout(longPressTimer);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', cancel);
    document.removeEventListener('pointercancel', cancel);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  longPressTimer = setTimeout(function () {
    cancel();
    if (!moved) startDrag(li);
  }, 400);
});

var activeStroke = null;
var signoffCollapseTimer = null;

itemListEl.addEventListener('pointerdown', function (e) {
  var canvas = e.target.closest('.signature-canvas');
  if (!canvas) return;
  e.preventDefault();
  clearTimeout(signoffCollapseTimer); // a new stroke means they're still signing
  var ctx = canvas.getContext('2d');
  var rect = canvas.getBoundingClientRect();
  activeStroke = { id: canvas.dataset.id, canvas: canvas, ctx: ctx };
  ctx.strokeStyle = '#1b1f24';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});

itemListEl.addEventListener('pointermove', function (e) {
  if (!activeStroke) return;
  var rect = activeStroke.canvas.getBoundingClientRect();
  activeStroke.ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
  activeStroke.ctx.stroke();
});

// A signature can take several separate strokes (dotting an i, crossing a t), so
// this doesn't collapse to the signed card the instant one stroke ends — that
// would yank the canvas away mid-signature. Instead it waits a beat for another
// stroke to start; startSignatureStroke() above cancels this timer when one does.
function endSignatureStroke() {
  if (!activeStroke) return;
  var canvas = activeStroke.canvas;
  var id = activeStroke.id;
  activeStroke = null;
  var item = getActive().items.find(function (i) { return i.id === id; });
  if (item) {
    try { item.signature = canvas.toDataURL('image/png'); } catch (err) { /* ignore */ }
    saveState();
    clearTimeout(signoffCollapseTimer);
    signoffCollapseTimer = setTimeout(function () {
      var stillActive = getActive().items.find(function (i) { return i.id === id; });
      if (stillActive && isItemAnswered(stillActive) && !signoffEditingIds.has(id)) render();
    }, 900);
  }
}
itemListEl.addEventListener('pointerup', endSignatureStroke);
itemListEl.addEventListener('pointercancel', endSignatureStroke);

// The typed-name path has a single clean "done" signal — leaving the field —
// unlike a multi-stroke signature, so it collapses to the signed card right away.
itemListEl.addEventListener('focusout', function (e) {
  if (!e.target.classList.contains('signoff-name-input')) return;
  var id = e.target.dataset.id;
  var item = getActive().items.find(function (i) { return i.id === id; });
  if (item && isItemAnswered(item) && !signoffEditingIds.has(id)) render();
});

var PLACEHOLDERS = { section: 'Section heading', signoff: 'Sign-off label' };
var DEFAULT_ADD_PLACEHOLDER = '＋ Add item';
typeButtons.forEach(function (b) {
  b.addEventListener('click', function () {
    selectedType = b.dataset.type;
    typeButtons.forEach(function (x) { x.classList.toggle('active', x.dataset.type === selectedType); });
    newItemLabelEl.placeholder = PLACEHOLDERS[selectedType] || DEFAULT_ADD_PLACEHOLDER;
  });
});
newItemLabelEl.placeholder = DEFAULT_ADD_PLACEHOLDER;

function addItem(labelInputEl) {
  if (getActive().locked) return;
  var label = labelInputEl.value.trim();
  if (!label) { labelInputEl.focus(); return; }
  var item = Object.assign({ id: uid(), label: label, type: selectedType }, defaultResponseFields(selectedType));
  getActive().items.push(item);
  labelInputEl.value = '';
  saveState(); render();
}

newItemLabelEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') addItem(newItemLabelEl); });

var lockChecklistBtn = document.getElementById('lockChecklistBtn');

function toggleLock() {
  var active = getActive();
  active.locked = !active.locked;
  saveState(); render();
}
lockChecklistBtn.addEventListener('click', toggleLock);

// Wires up the "click once to arm, click again within 4s to confirm" pattern used for
// destructive actions elsewhere (tab close, template delete). Each button tracked
// independently, so the footer and header copies don't interfere with each other.
function wireClearResponsesButton(btn, onConfirmed) {
  var armed = false;
  var timer = null;
  var originalText = btn.textContent;
  btn.addEventListener('click', function () {
    if (!armed) {
      armed = true;
      btn.textContent = 'Click again to confirm';
      btn.classList.add('confirm-pending');
      timer = setTimeout(function () {
        armed = false;
        btn.textContent = originalText;
        btn.classList.remove('confirm-pending');
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    btn.textContent = originalText;
    btn.classList.remove('confirm-pending');
    getActive().items.forEach(function (i) {
      if (i.type === 'checkbox') i.checked = false;
      if (i.type === 'text') i.text = '';
      if (i.type === 'photo') i.photo = null;
      if (i.type === 'signoff') { i.signature = null; i.name = ''; i.date = ''; }
    });
    saveState(); render();
    if (onConfirmed) onConfirmed();
  });
}

wireClearResponsesButton(document.getElementById('resetBtn'));

var themeToggle = document.getElementById('themeToggle');
function currentTheme() {
  var attr = document.documentElement.getAttribute('data-theme');
  if (attr) return attr;
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function updateToggleLabel() { themeToggle.textContent = currentTheme() === 'dark' ? 'Page' : 'Instrument'; }
Preferences.get({ key: THEME_KEY }).then(function (res) {
  if (res.value) document.documentElement.setAttribute('data-theme', res.value);
  updateToggleLabel();
}).catch(function () { updateToggleLabel(); });
themeToggle.addEventListener('click', function () {
  var next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  Preferences.set({ key: THEME_KEY, value: next }).catch(function () { /* ignore */ });
  updateToggleLabel();
});

function imageFormatFromDataUrl(dataUrl) {
  var m = /^data:image\/(png|jpe?g|webp)/i.exec(dataUrl || '');
  if (!m) return 'JPEG';
  var ext = m[1].toLowerCase();
  if (ext === 'png') return 'PNG';
  if (ext === 'webp') return 'WEBP';
  return 'JPEG';
}

function drawPdfCheckbox(doc, rightEdgeX, yBaseline, checked) {
  var size = 10;
  var boxX = rightEdgeX - size;
  var boxY = yBaseline - size + 2;
  if (checked) {
    doc.setDrawColor(10, 145, 66);
    doc.setFillColor(224, 243, 231);
    doc.roundedRect(boxX, boxY, size, size, 1.2, 1.2, 'FD');
    doc.setDrawColor(10, 145, 66);
    doc.setLineWidth(1.3);
    doc.line(boxX + size * 0.18, boxY + size * 0.52, boxX + size * 0.40, boxY + size * 0.76);
    doc.line(boxX + size * 0.40, boxY + size * 0.76, boxX + size * 0.85, boxY + size * 0.22);
    doc.setLineWidth(0.5);
  } else {
    doc.setDrawColor(176, 183, 191);
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(boxX, boxY, size, size, 1.2, 1.2, 'FD');
  }
  doc.setDrawColor(0, 0, 0);
}

var logoDataPromise = null;
function loadPdfLogo() {
  if (!logoDataPromise) {
    logoDataPromise = new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          resolve({ dataUrl: canvas.toDataURL('image/png'), width: img.naturalWidth, height: img.naturalHeight });
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = '/assets/logo-light.png';
    });
  }
  return logoDataPromise;
}

async function buildPdfBlob() {
  var active = getActive();
  var doc = new jsPDF({ unit: 'pt', format: 'letter' });
  var marginX = 48;
  var pageWidth = doc.internal.pageSize.getWidth();
  var pageHeight = doc.internal.pageSize.getHeight();
  var maxWidth = pageWidth - marginX * 2;
  var y = 56;

  function ensureSpace(h) { if (y + h > pageHeight - 56) { doc.addPage(); y = 56; } }

  var logo = await loadPdfLogo();
  if (logo) {
    var logoH = 30;
    var logoW = logoH * (logo.width / logo.height);
    doc.addImage(logo.dataUrl, 'PNG', marginX, y - 20, logoW, logoH);
    y += logoH + 4;
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(216, 48, 42);
    doc.text('CYPRESS IN-LINE INSPECTION', marginX, y);
    doc.setTextColor(20, 20, 20);
    y += 16;
  }

  if (state.collectionTitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(108, 116, 128);
    doc.text(state.collectionTitle, marginX, y);
    doc.setTextColor(20, 20, 20);
    y += 16;
  } else {
    y += 4;
  }

  y += 12; // blank line between the collection name and the checklist name

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.text(active.title || 'Untitled Checklist', marginX, y);
  y += 20;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  var metaParts = [];
  if (active.inspector) metaParts.push('Inspector: ' + active.inspector);
  if (active.date) metaParts.push('Date: ' + active.date);
  metaParts.push('Generated: ' + new Date().toLocaleString());
  doc.setTextColor(108, 116, 128);
  doc.text(metaParts.join('     '), marginX, y);
  doc.setTextColor(20, 20, 20);
  y += 12;

  doc.setDrawColor(15, 111, 175);
  doc.setLineWidth(1.2);
  doc.line(marginX, y, pageWidth - marginX, y);
  doc.setLineWidth(0.5);
  y += 22;

  var itemCounter = 0;
  active.items.forEach(function (item, i) {
    if (item.type === 'section') {
      ensureSpace(36);
      if (i !== 0) y += 8;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(15, 111, 175);
      doc.text(item.label || 'Section', marginX, y);
      doc.setTextColor(20, 20, 20);
      y += 9;
      doc.setDrawColor(15, 111, 175);
      doc.setLineWidth(1);
      doc.line(marginX, y, pageWidth - marginX, y);
      doc.setLineWidth(0.5);
      y += 18;
      return;
    }

    itemCounter++;
    var num = String(itemCounter).padStart(2, '0') + '.';
    ensureSpace(20);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(num, marginX, y);

    var labelX = marginX + 24;
    var responseColW = item.type === 'checkbox' ? 36 : 0;
    doc.setFont('helvetica', 'normal');
    var labelLines = doc.splitTextToSize(item.label || '(untitled item)', maxWidth - 24 - responseColW);
    doc.text(labelLines, labelX, y);

    if (item.type === 'checkbox') {
      drawPdfCheckbox(doc, pageWidth - marginX - 22, y, !!item.checked);
    }
    y += labelLines.length * 13 + 6;

    if (item.type === 'text') {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      var respLines = doc.splitTextToSize(item.text ? item.text : '(no response)', maxWidth - 24);
      ensureSpace(respLines.length * 12 + 8);
      if (!item.text) doc.setTextColor(138, 146, 155);
      doc.text(respLines, labelX, y);
      doc.setTextColor(20, 20, 20);
      y += respLines.length * 12 + 10;
    } else if (item.type === 'photo' && item.photo) {
      var maxImgWidth = 160;
      var ratio = item.photo.height / item.photo.width;
      var imgW = Math.min(maxImgWidth, maxWidth - 24);
      var imgH = imgW * ratio;
      ensureSpace(imgH + 10);
      try {
        doc.addImage(item.photo.dataUrl, imageFormatFromDataUrl(item.photo.dataUrl), labelX, y, imgW, imgH);
      } catch (e) { /* skip image if it can't be embedded */ }
      y += imgH + 14;
    } else if (item.type === 'photo' && !item.photo) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(10);
      doc.setTextColor(138, 146, 155);
      doc.text('(no photo attached)', labelX, y);
      doc.setTextColor(20, 20, 20);
      y += 16;
    } else if (item.type === 'signoff') {
      var sigBoxW = Math.min(260, maxWidth - 24);
      var hasDrawn = item.mode !== 'type' && !!item.signature;
      var hasTyped = item.mode === 'type' && !!(item.name && item.name.trim());

      if (hasDrawn) {
        var sigH = 54;
        ensureSpace(sigH + 34);
        try { doc.addImage(item.signature, 'PNG', labelX, y, sigBoxW, sigH); } catch (e) { /* skip */ }
        y += sigH + 4;
      } else if (hasTyped) {
        ensureSpace(48);
        doc.setFont('times', 'italic');
        doc.setFontSize(17);
        doc.text(item.name, labelX + 4, y + 26);
        doc.setFont('helvetica', 'normal');
        y += 34;
      } else {
        ensureSpace(34);
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(10);
        doc.setTextColor(138, 146, 155);
        doc.text('(not signed)', labelX, y + 14);
        doc.setTextColor(20, 20, 20);
        y += 22;
      }

      doc.setDrawColor(176, 183, 191);
      doc.line(labelX, y, labelX + sigBoxW, y);
      y += 10;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(108, 116, 128);
      doc.text('Signature', labelX, y);
      var dateLabel = 'Date: ' + (item.date || '______________');
      doc.text(dateLabel, labelX + sigBoxW - doc.getTextWidth(dateLabel), y);
      doc.setTextColor(20, 20, 20);
      y += 12;
    } else {
      y += 6;
    }

    doc.setDrawColor(230, 233, 236);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 14;
  });

  if (active.items.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(11);
    doc.setTextColor(150, 150, 150);
    doc.text('No items on this checklist yet.', marginX, y);
  }

  return doc.output('blob');
}

function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onloadend = function () { resolve(String(reader.result).split(',')[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function browserDownload(blob, filename) {
  try {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  } catch (e) { alert('Could not save the file in this view.'); }
}

async function savePdf(blob, filename) {
  if (isTauri()) {
    var path = await saveFileDialog({
      defaultPath: filename,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (!path) return; // user cancelled the dialog
    var bytes = new Uint8Array(await blob.arrayBuffer());
    await writeTauriFile(path, bytes);
  } else if (Capacitor.isNativePlatform()) {
    var base64 = await blobToBase64(blob);
    var written = await Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Cache });
    await Share.share({ title: filename, url: written.uri });
  } else {
    browserDownload(blob, filename);
  }
}

async function saveJsonFile(filename, text, dialogFilterName) {
  if (isTauri()) {
    var path = await saveFileDialog({
      defaultPath: filename,
      filters: [{ name: dialogFilterName, extensions: ['checklist'] }]
    });
    if (!path) return; // user cancelled the dialog
    await writeTauriFile(path, new TextEncoder().encode(text));
  } else if (Capacitor.isNativePlatform()) {
    var written = await Filesystem.writeFile({
      path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8
    });
    await Share.share({ title: filename, url: written.uri });
  } else if (typeof window.showSaveFilePicker === 'function') {
    // Lets the user pick the destination folder instead of always landing in Downloads.
    var handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: dialogFilterName, accept: { 'application/json': ['.checklist'] } }]
      });
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled the picker
      browserDownload(new Blob([text], { type: 'application/json' }), filename);
      return;
    }
    var writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  } else {
    browserDownload(new Blob([text], { type: 'application/json' }), filename);
  }
}

async function exportTemplateFile(template) {
  await saveJsonFile(templateFilename(template), templateToFileText(template), 'Checklist Template');
}

async function exportTemplatePackFile(templateList) {
  await saveJsonFile(templatePackFilename(), templatePackToFileText(templateList), 'Checklist Template Pack');
}

async function exportCollectionFile() {
  await saveJsonFile(collectionFilename(), collectionToFileText(), 'Checklist Collection');
}

async function exportPdfFromButton(btn) {
  btn.disabled = true;
  var original = btn.textContent;
  btn.textContent = 'Building PDF…';
  try {
    var blob = await buildPdfBlob();
    var active = getActive();
    var filename = ((active.title || 'checklist').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') || 'checklist') + '.pdf';
    await savePdf(blob, filename);
  } catch (e) {
    alert('Could not build the PDF: ' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

var exportBtn = document.getElementById('exportPdfBtn');
exportBtn.addEventListener('click', function () { exportPdfFromButton(exportBtn); });

var saveTemplateBtn = document.getElementById('saveTemplateBtn');
var importTemplateInput = document.getElementById('importTemplateInput');
var openTemplateLibraryBtn = document.getElementById('openTemplateLibraryBtn');
var closeTemplateLibraryBtn = document.getElementById('closeTemplateLibraryBtn');
var templateLibraryOverlay = document.getElementById('templateLibraryOverlay');
var templateLibraryList = document.getElementById('templateLibraryList');
var templateDeleteArmedId = null;
var templateDeleteTimer = null;

saveTemplateBtn.addEventListener('click', function () {
  closeAllMenus();
  var active = getActive();
  var name = window.prompt('Save as template — name:', active.title || 'Untitled Template');
  if (name === null) return; // cancelled
  name = name.trim();
  if (!name) return;
  templates.push(createTemplateFromChecklist(active, name));
  saveTemplates();
});

var importTemplateLabel = importTemplateInput.closest('label');
importTemplateLabel.addEventListener('click', closeAllMenus);
importTemplateInput.addEventListener('change', function () {
  var file = importTemplateInput.files && importTemplateInput.files[0];
  importTemplateInput.value = '';
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var imported;
    try {
      imported = templatesFromFileText(String(reader.result)); // one file, one or many templates
    } catch (e) {
      alert(e && e.message ? e.message : 'Could not import that file.');
      return;
    }
    templates = templates.concat(imported);
    saveTemplates();
    if (!templateLibraryOverlay.hidden) renderTemplateLibrary();
    if (imported.length > 1) alert('Imported ' + imported.length + ' templates.');
  };
  reader.onerror = function () { alert('Could not read that file.'); };
  reader.readAsText(file);
});

var exportAllTemplatesBtn = document.getElementById('exportAllTemplatesBtn');
exportAllTemplatesBtn.addEventListener('click', async function () {
  if (templates.length === 0) { alert('No saved templates to export yet.'); return; }
  exportAllTemplatesBtn.disabled = true;
  try {
    await exportTemplatePackFile(templates);
  } catch (e) {
    alert('Could not export templates: ' + (e && e.message ? e.message : e));
  } finally {
    exportAllTemplatesBtn.disabled = false;
  }
});

var exportCollectionBtn = document.getElementById('exportCollectionBtn');
var importCollectionInput = document.getElementById('importCollectionInput');

exportCollectionBtn.addEventListener('click', async function () {
  closeAllMenus();
  exportCollectionBtn.disabled = true;
  try {
    await exportCollectionFile();
  } catch (e) {
    alert('Could not export the collection: ' + (e && e.message ? e.message : e));
  } finally {
    exportCollectionBtn.disabled = false;
  }
});

var importCollectionLabel = importCollectionInput.closest('label');
importCollectionLabel.addEventListener('click', closeAllMenus);

importCollectionInput.addEventListener('change', function () {
  var file = importCollectionInput.files && importCollectionInput.files[0];
  importCollectionInput.value = '';
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var imported;
    try {
      imported = collectionFromFileText(String(reader.result));
    } catch (e) {
      alert(e && e.message ? e.message : 'Could not import that file.');
      return;
    }
    var proceed = window.confirm(
      'Importing "' + imported.collectionTitle + '" will replace everything currently open ' +
      '(all checklist tabs and their responses). This cannot be undone. Continue?'
    );
    if (!proceed) return;
    state = imported;
    saveState();
    render();
  };
  reader.onerror = function () { alert('Could not read that file.'); };
  reader.readAsText(file);
});

function templateCardHtml(t) {
  var count = t.items.length;
  var deleteArmed = templateDeleteArmedId === t.id;
  var lockBadge = t.locked ? '<span class="tab-lock" title="Locked — checklists made from this template start locked">' + LOCK_SVG + '</span>' : '';
  return (
    '<div class="template-card" data-id="' + t.id + '">' +
      '<div class="template-card-main">' +
        '<div class="template-card-title">' + lockBadge + escapeHtml(t.title || 'Untitled Template') + '</div>' +
        (t.description ? '<div class="template-card-desc">' + escapeHtml(t.description) + '</div>' : '') +
        '<div class="template-card-meta">' + count + (count === 1 ? ' item' : ' items') + '</div>' +
      '</div>' +
      '<div class="template-card-actions">' +
        '<button type="button" class="btn-add" data-action="new-checklist" data-id="' + t.id + '">New checklist</button>' +
        '<button type="button" class="btn-ghost ' + (t.locked ? 'is-locked' : '') + '" data-action="toggle-lock" data-id="' + t.id + '">' +
          (t.locked ? 'Unlock template' : 'Lock template') +
        '</button>' +
        '<button type="button" class="btn-ghost" data-action="export" data-id="' + t.id + '">Export…</button>' +
        '<button type="button" class="btn-ghost" data-action="rename" data-id="' + t.id + '">Rename</button>' +
        '<button type="button" class="btn-ghost" data-action="edit-description" data-id="' + t.id + '">' +
          (t.description ? 'Edit description' : 'Add description') +
        '</button>' +
        '<button type="button" class="btn-ghost template-delete-btn ' + (deleteArmed ? 'confirm-pending' : '') + '" data-action="delete" data-id="' + t.id + '">' +
          (deleteArmed ? 'Click again to delete' : 'Delete') +
        '</button>' +
      '</div>' +
    '</div>'
  );
}

function renderTemplateLibrary() {
  if (templates.length === 0) {
    templateLibraryList.innerHTML = '<p class="template-library-empty">No saved templates yet — use "Save as template" on a checklist, or import a template file.</p>';
    return;
  }
  templateLibraryList.innerHTML = templates.map(templateCardHtml).join('');
}

function openTemplateLibrary() {
  closeAllMenus();
  renderTemplateLibrary();
  templateLibraryOverlay.hidden = false;
}

function closeTemplateLibrary() {
  templateLibraryOverlay.hidden = true;
  clearTimeout(templateDeleteTimer);
  templateDeleteArmedId = null;
}

openTemplateLibraryBtn.addEventListener('click', openTemplateLibrary);
closeTemplateLibraryBtn.addEventListener('click', closeTemplateLibrary);
templateLibraryOverlay.addEventListener('click', function (e) {
  if (e.target === templateLibraryOverlay) closeTemplateLibrary();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !templateLibraryOverlay.hidden) closeTemplateLibrary();
});

templateLibraryList.addEventListener('click', async function (e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var id = btn.dataset.id;
  var action = btn.dataset.action;
  var template = templates.find(function (t) { return t.id === id; });
  if (!template) return;

  if (action === 'new-checklist') {
    var checklist = checklistFromTemplate(template);
    state.checklists.push(checklist);
    state.activeId = checklist.id;
    saveState(); render();
    closeTemplateLibrary();
  } else if (action === 'toggle-lock') {
    template.locked = !template.locked;
    saveTemplates();
    renderTemplateLibrary();
  } else if (action === 'export') {
    btn.disabled = true;
    try {
      await exportTemplateFile(template);
    } catch (err) {
      alert('Could not export the template: ' + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = false;
    }
  } else if (action === 'rename') {
    var name = window.prompt('Rename template:', template.title || 'Untitled Template');
    if (name === null) return;
    name = name.trim();
    if (!name) return;
    template.title = name;
    saveTemplates();
    renderTemplateLibrary();
  } else if (action === 'edit-description') {
    var desc = window.prompt('Template description:', template.description || '');
    if (desc === null) return;
    template.description = desc.trim();
    saveTemplates();
    renderTemplateLibrary();
  } else if (action === 'delete') {
    if (templateDeleteArmedId !== id) {
      templateDeleteArmedId = id;
      clearTimeout(templateDeleteTimer);
      templateDeleteTimer = setTimeout(function () { templateDeleteArmedId = null; renderTemplateLibrary(); }, 4000);
      renderTemplateLibrary();
      return;
    }
    clearTimeout(templateDeleteTimer);
    templateDeleteArmedId = null;
    templates = templates.filter(function (t) { return t.id !== id; });
    saveTemplates();
    renderTemplateLibrary();
  }
});

var renameChecklistBtn = document.getElementById('renameChecklistBtn');
var duplicateChecklistBtn = document.getElementById('duplicateChecklistBtn');
var deleteChecklistBtn = document.getElementById('deleteChecklistBtn');

renameChecklistBtn.addEventListener('click', function () {
  closeAllMenus();
  checklistTitleInput.focus();
  checklistTitleInput.select();
});

duplicateChecklistBtn.addEventListener('click', function () {
  closeAllMenus();
  var active = getActive();
  var copy = {
    id: uid(),
    title: (active.title || 'Untitled Checklist') + ' Copy',
    inspector: active.inspector,
    date: active.date,
    items: active.items.map(function (item) { return Object.assign({}, item, { id: uid() }); }),
    locked: false
  };
  state.checklists.push(copy);
  state.activeId = copy.id;
  saveState(); render();
});

deleteChecklistBtn.addEventListener('click', function () {
  if (state.checklists.length <= 1) return;
  var id = state.activeId;
  if (!deleteChecklistArmed) {
    deleteChecklistArmed = true;
    deleteChecklistBtn.textContent = 'Click again to delete';
    deleteChecklistBtn.classList.add('confirm-pending');
    clearTimeout(deleteChecklistTimer);
    deleteChecklistTimer = setTimeout(function () {
      deleteChecklistArmed = false;
      deleteChecklistBtn.textContent = 'Delete checklist';
      deleteChecklistBtn.classList.remove('confirm-pending');
    }, 4000);
    return;
  }
  clearTimeout(deleteChecklistTimer);
  deleteChecklistArmed = false;
  deleteChecklistBtn.textContent = 'Delete checklist';
  deleteChecklistBtn.classList.remove('confirm-pending');
  var idx = state.checklists.findIndex(function (c) { return c.id === id; });
  state.checklists = state.checklists.filter(function (c) { return c.id !== id; });
  var nextIdx = Math.min(Math.max(0, idx - 1), state.checklists.length - 1);
  state.activeId = state.checklists[nextIdx].id;
  saveState(); render();
  closeAllMenus();
});

var menuTriggers = document.querySelectorAll('.menu-trigger');

function closeAllMenus() {
  document.querySelectorAll('.menu-dropdown').forEach(function (dd) { dd.hidden = true; });
  menuTriggers.forEach(function (t) { t.setAttribute('aria-expanded', 'false'); });
}

menuTriggers.forEach(function (trigger) {
  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    var panel = trigger.parentElement.querySelector('.menu-dropdown');
    var wasOpen = !panel.hidden;
    closeAllMenus();
    if (!wasOpen) {
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    }
  });
});

// Clicks inside a dropdown never bubble to the document-level close-on-outside-click
// handler below — otherwise picking a response type, or arming the two-click "Clear
// responses" confirm, would immediately close the menu. Actions that should close their
// menu after running (Export collection, Save as template, etc.) call closeAllMenus()
// themselves.
document.querySelectorAll('.menu-dropdown').forEach(function (dd) {
  dd.addEventListener('click', function (e) { e.stopPropagation(); });
});

document.addEventListener('click', closeAllMenus);
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  closeAllMenus();
  if (openItemMenuId) {
    openItemMenuId = null;
    clearTimeout(itemDeleteTimer);
    itemDeleteArmedId = null;
    render();
  }
});

async function init() {
  state = await loadState();
  templates = await loadTemplates();
  render();
}

init();
