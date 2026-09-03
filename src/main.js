import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { isTauri } from '@tauri-apps/api/core';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { writeFile as writeTauriFile } from '@tauri-apps/plugin-fs';
import { jsPDF } from 'jspdf';

var STORAGE_KEY = 'checklist-collection-state-v1';
var TEMPLATES_KEY = 'checklist-collection-templates-v1';
var THEME_KEY = 'checklist-collection-theme';

function uid() { return Math.random().toString(36).slice(2, 10); }

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
    items: (seed && seed.items) || []
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
    .catch(function () { /* storage full or unavailable; edits stay in-memory only */ });
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
    items: checklist.items.map(templateItemFromItem)
  };
}

function checklistFromTemplate(template) {
  return newChecklist({
    title: template.title,
    items: template.items.map(function (templateItem) {
      return Object.assign(
        { id: uid(), label: templateItem.label, type: templateItem.type },
        defaultResponseFields(templateItem.type)
      );
    })
  });
}

// File format for sharing a single template with someone else, e.g. by email or
// AirDrop: a small JSON file they can import into their own copy of the app.
var TEMPLATE_FILE_TYPE = 'checklist-collection-template';
var TEMPLATE_FILE_VERSION = 1;

function templateToFileText(template) {
  return JSON.stringify({
    type: TEMPLATE_FILE_TYPE,
    version: TEMPLATE_FILE_VERSION,
    template: {
      title: template.title,
      description: template.description || '',
      items: template.items.map(templateItemFromItem)
    }
  }, null, 2);
}

function templateFilename(template) {
  var slug = (template.title || 'checklist_template').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_');
  return (slug || 'checklist_template') + '.json';
}

// Throws a descriptive Error if the text isn't a template file this app can read.
function templateFromFileText(text) {
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || parsed.type !== TEMPLATE_FILE_TYPE || !parsed.template || !Array.isArray(parsed.template.items)) {
    throw new Error('That file is not a checklist template.');
  }
  var raw = parsed.template;
  return {
    id: uid(),
    title: (raw.title && String(raw.title)) || 'Untitled Template',
    description: (raw.description && String(raw.description)) || '',
    items: raw.items
      .filter(function (item) { return item && typeof item.label === 'string' && typeof item.type === 'string'; })
      .map(function (item) { return { id: uid(), label: item.label, type: item.type }; })
  };
}

var itemListEl = document.getElementById('itemList');
var tabBarEl = document.getElementById('tabBar');
var collectionTitleInput = document.getElementById('collectionTitleInput');
var collectionDescInput = document.getElementById('collectionDescInput');
var checklistTitleInput = document.getElementById('checklistTitleInput');
var inspectorInput = document.getElementById('inspectorInput');
var dateInput = document.getElementById('dateInput');
var newItemLabelEl = document.getElementById('newItemLabel');
var typeButtons = document.querySelectorAll('.type-btn');
var selectedType = 'checkbox';
var dragState = null;
var tabDeleteArmedId = null;
var tabDeleteTimer = null;
var GRIP_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><circle cx="6" cy="4" r="1.6"/><circle cx="14" cy="4" r="1.6"/><circle cx="6" cy="10" r="1.6"/><circle cx="14" cy="10" r="1.6"/><circle cx="6" cy="16" r="1.6"/><circle cx="14" cy="16" r="1.6"/></svg>';

function itemTemplate(item, num) {
  if (item.type === 'section') {
    return (
      '<li class="item item-section" data-id="' + item.id + '">' +
      '<span class="drag-handle" title="Drag to reorder">' + GRIP_SVG + '</span>' +
      '<span class="section-label">' + escapeHtml(item.label) + '</span>' +
      '<button type="button" class="item-remove" data-action="delete" data-id="' + item.id + '" aria-label="Remove section">×</button>' +
      '</li>'
    );
  }
  var numStr = String(num).padStart(2, '0');
  var responseHtml = '';
  if (item.type === 'checkbox') {
    responseHtml =
      '<button type="button" class="check-toggle ' + (item.checked ? 'checked' : '') + '" ' +
      'data-action="toggle" data-id="' + item.id + '" aria-pressed="' + !!item.checked + '" aria-label="Mark checked">' +
      '<svg viewBox="0 0 24 24" class="check-mark"><path d="M4 12.5 L9.5 18 L20 5" /></svg>' +
      '</button>';
  } else if (item.type === 'text') {
    responseHtml =
      '<input type="text" class="response-text" data-action="text" data-id="' + item.id + '" ' +
      'value="' + escapeHtml(item.text || '') + '" placeholder="Response">';
  } else if (item.type === 'photo') {
    if (item.photo) {
      responseHtml =
        '<div class="photo-wrap">' +
        '<img src="' + item.photo.dataUrl + '" class="photo-thumb" alt="Attached photo">' +
        '<button type="button" class="photo-remove" data-action="remove-photo" data-id="' + item.id + '" aria-label="Remove photo">×</button>' +
        '</div>';
    } else {
      responseHtml =
        '<button type="button" class="photo-btn" data-action="photo" data-id="' + item.id + '">Add photo</button>';
    }
  } else if (item.type === 'signoff') {
    var isDraw = item.mode !== 'type';
    responseHtml =
      '<div class="signoff-panel">' +
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
      '</div>';
  }
  return (
    '<li class="item' + (item.type === 'signoff' ? ' item-signoff' : '') + '" data-id="' + item.id + '">' +
    '<span class="drag-handle" title="Drag to reorder">' + GRIP_SVG + '</span>' +
    '<span class="item-num">' + numStr + '</span>' +
    '<span class="item-label">' + escapeHtml(item.label) + '</span>' +
    '<span class="item-response">' + responseHtml + '</span>' +
    '<button type="button" class="item-remove" data-action="delete" data-id="' + item.id + '" aria-label="Remove item">×</button>' +
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
    return (
      '<div class="tab-btn ' + (active ? 'active' : '') + '" role="tab" aria-selected="' + active + '">' +
      '<span class="tab-label" data-action="switch-tab" data-id="' + c.id + '">' + escapeHtml(c.title || 'Untitled Checklist') + '</span>' +
      closeBtn +
      '</div>'
    );
  }).join('');
  tabBarEl.innerHTML = tabsHtml + '<button type="button" id="addTabBtn" class="tab-add" aria-label="Add checklist" title="Add checklist">+</button>';
}

function render() {
  collectionTitleInput.value = state.collectionTitle;
  collectionDescInput.value = state.collectionDescription;
  document.title = state.collectionTitle || 'Checklist Collection';

  renderTabs();

  var active = getActive();
  checklistTitleInput.value = active.title;
  inspectorInput.value = active.inspector;
  dateInput.value = active.date;

  if (active.items.length === 0) {
    itemListEl.innerHTML = '<li class="empty-note">No items yet — add one below.</li>';
  } else {
    var counter = 0;
    itemListEl.innerHTML = active.items.map(function (item) {
      if (item.type !== 'section') counter++;
      return itemTemplate(item, counter);
    }).join('');
  }
  if (dragState) {
    var draggedEl = itemListEl.querySelector('[data-id="' + dragState.id + '"]');
    if (draggedEl) draggedEl.classList.add('dragging');
  }
  setupSignatureCanvases();
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
collectionDescInput.addEventListener('input', function () {
  state.collectionDescription = collectionDescInput.value;
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
  if (!btn) return;
  var id = btn.dataset.id;
  var action = btn.dataset.action;
  var active = getActive();
  var item = active.items.find(function (i) { return i.id === id; });
  if (action === 'toggle' && item) {
    item.checked = !item.checked;
    saveState(); render();
  } else if (action === 'delete') {
    active.items = active.items.filter(function (i) { return i.id !== id; });
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
  }
});

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
  var rows = itemListEl.querySelectorAll('.item');
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

itemListEl.addEventListener('pointerdown', function (e) {
  var handle = e.target.closest('.drag-handle');
  if (!handle) return;
  var li = handle.closest('.item');
  if (!li) return;
  e.preventDefault();
  dragState = { id: li.dataset.id };
  li.classList.add('dragging');
  document.addEventListener('pointermove', onDragMove);
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragEnd);
});

var activeStroke = null;

itemListEl.addEventListener('pointerdown', function (e) {
  var canvas = e.target.closest('.signature-canvas');
  if (!canvas) return;
  e.preventDefault();
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

function endSignatureStroke() {
  if (!activeStroke) return;
  var canvas = activeStroke.canvas;
  var id = activeStroke.id;
  activeStroke = null;
  var item = getActive().items.find(function (i) { return i.id === id; });
  if (item) {
    try { item.signature = canvas.toDataURL('image/png'); } catch (err) { /* ignore */ }
    saveState();
  }
}
itemListEl.addEventListener('pointerup', endSignatureStroke);
itemListEl.addEventListener('pointercancel', endSignatureStroke);

var PLACEHOLDERS = { section: 'Section heading', signoff: 'Sign-off label' };
typeButtons.forEach(function (b) {
  b.addEventListener('click', function () {
    typeButtons.forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    selectedType = b.dataset.type;
    newItemLabelEl.placeholder = PLACEHOLDERS[selectedType] || 'New item label';
  });
});

function addItem() {
  var label = newItemLabelEl.value.trim();
  if (!label) { newItemLabelEl.focus(); return; }
  var item = Object.assign({ id: uid(), label: label, type: selectedType }, defaultResponseFields(selectedType));
  getActive().items.push(item);
  newItemLabelEl.value = '';
  saveState(); render();
}

document.getElementById('addItemBtn').addEventListener('click', addItem);
newItemLabelEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') addItem(); });

var resetBtn = document.getElementById('resetBtn');
var resetConfirmTimer = null;
var resetPendingConfirm = false;

resetBtn.addEventListener('click', function () {
  if (!resetPendingConfirm) {
    resetPendingConfirm = true;
    resetBtn.textContent = 'Click again to confirm';
    resetBtn.classList.add('confirm-pending');
    resetConfirmTimer = setTimeout(function () {
      resetPendingConfirm = false;
      resetBtn.textContent = 'Clear responses';
      resetBtn.classList.remove('confirm-pending');
    }, 4000);
    return;
  }
  clearTimeout(resetConfirmTimer);
  resetPendingConfirm = false;
  resetBtn.textContent = 'Clear responses';
  resetBtn.classList.remove('confirm-pending');
  getActive().items.forEach(function (i) {
    if (i.type === 'checkbox') i.checked = false;
    if (i.type === 'text') i.text = '';
    if (i.type === 'photo') i.photo = null;
    if (i.type === 'signoff') { i.signature = null; i.name = ''; i.date = ''; }
  });
  saveState(); render();
});

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

async function exportTemplateFile(template) {
  var filename = templateFilename(template);
  var text = templateToFileText(template);
  if (isTauri()) {
    var path = await saveFileDialog({
      defaultPath: filename,
      filters: [{ name: 'Checklist Template', extensions: ['json'] }]
    });
    if (!path) return; // user cancelled the dialog
    await writeTauriFile(path, new TextEncoder().encode(text));
  } else if (Capacitor.isNativePlatform()) {
    var written = await Filesystem.writeFile({
      path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8
    });
    await Share.share({ title: filename, url: written.uri });
  } else {
    browserDownload(new Blob([text], { type: 'application/json' }), filename);
  }
}

var exportBtn = document.getElementById('exportPdfBtn');
exportBtn.addEventListener('click', async function () {
  exportBtn.disabled = true;
  var original = exportBtn.textContent;
  exportBtn.textContent = 'Building PDF…';
  try {
    var blob = await buildPdfBlob();
    var active = getActive();
    var filename = ((active.title || 'checklist').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') || 'checklist') + '.pdf';
    await savePdf(blob, filename);
  } catch (e) {
    alert('Could not build the PDF: ' + (e && e.message ? e.message : e));
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = original;
  }
});

var saveTemplateBtn = document.getElementById('saveTemplateBtn');
var importTemplateInput = document.getElementById('importTemplateInput');
var openTemplateLibraryBtn = document.getElementById('openTemplateLibraryBtn');
var closeTemplateLibraryBtn = document.getElementById('closeTemplateLibraryBtn');
var templateLibraryOverlay = document.getElementById('templateLibraryOverlay');
var templateLibraryList = document.getElementById('templateLibraryList');
var templateDeleteArmedId = null;
var templateDeleteTimer = null;

saveTemplateBtn.addEventListener('click', function () {
  var active = getActive();
  var name = window.prompt('Save as template — name:', active.title || 'Untitled Template');
  if (name === null) return; // cancelled
  name = name.trim();
  if (!name) return;
  templates.push(createTemplateFromChecklist(active, name));
  saveTemplates();
});

importTemplateInput.addEventListener('change', function () {
  var file = importTemplateInput.files && importTemplateInput.files[0];
  importTemplateInput.value = '';
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var template;
    try {
      template = templateFromFileText(String(reader.result));
    } catch (e) {
      alert(e && e.message ? e.message : 'Could not import that file.');
      return;
    }
    templates.push(template);
    saveTemplates();
    if (!templateLibraryOverlay.hidden) renderTemplateLibrary();
  };
  reader.onerror = function () { alert('Could not read that file.'); };
  reader.readAsText(file);
});

function templateCardHtml(t) {
  var count = t.items.length;
  var deleteArmed = templateDeleteArmedId === t.id;
  return (
    '<div class="template-card" data-id="' + t.id + '">' +
      '<div class="template-card-main">' +
        '<div class="template-card-title">' + escapeHtml(t.title || 'Untitled Template') + '</div>' +
        (t.description ? '<div class="template-card-desc">' + escapeHtml(t.description) + '</div>' : '') +
        '<div class="template-card-meta">' + count + (count === 1 ? ' item' : ' items') + '</div>' +
      '</div>' +
      '<div class="template-card-actions">' +
        '<button type="button" class="btn-add" data-action="new-checklist" data-id="' + t.id + '">New checklist</button>' +
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

async function init() {
  state = await loadState();
  templates = await loadTemplates();
  render();
}

init();
