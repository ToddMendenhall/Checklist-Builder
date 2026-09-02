import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isTauri } from '@tauri-apps/api/core';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { writeFile as writeTauriFile } from '@tauri-apps/plugin-fs';
import { jsPDF } from 'jspdf';

var STORAGE_KEY = 'checklist-collection-state-v1';
var THEME_KEY = 'checklist-collection-theme';

function uid() { return Math.random().toString(36).slice(2, 10); }

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
        '<label class="photo-btn">' +
        '<input type="file" accept="image/*" capture="environment" data-action="photo" data-id="' + item.id + '" hidden>' +
        '<span>Add photo</span>' +
        '</label>';
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

itemListEl.addEventListener('change', function (e) {
  if (e.target.dataset.action !== 'photo') return;
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var id = e.target.dataset.id;
  var reader = new FileReader();
  reader.onload = function () {
    var img = new Image();
    img.onload = function () {
      var active = getActive();
      var item = active.items.find(function (i) { return i.id === id; });
      if (!item) return;
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
      item.photo = { dataUrl: dataUrl, width: outW, height: outH };
      saveState(); render();
    };
    img.onerror = function () { alert('Could not read that photo. Try a different file.'); };
    img.src = reader.result;
  };
  reader.onerror = function () { alert('Could not read that photo. Try a different file.'); };
  reader.readAsDataURL(file);
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
  var item = { id: uid(), label: label, type: selectedType };
  if (selectedType === 'checkbox') item.checked = false;
  if (selectedType === 'text') item.text = '';
  if (selectedType === 'photo') item.photo = null;
  if (selectedType === 'signoff') {
    var supportsTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    item.mode = supportsTouch ? 'draw' : 'type';
    item.signature = null;
    item.name = '';
    item.date = '';
  }
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

function buildPdfBlob() {
  var active = getActive();
  var doc = new jsPDF({ unit: 'pt', format: 'letter' });
  var marginX = 48;
  var pageWidth = doc.internal.pageSize.getWidth();
  var pageHeight = doc.internal.pageSize.getHeight();
  var maxWidth = pageWidth - marginX * 2;
  var y = 56;

  function ensureSpace(h) { if (y + h > pageHeight - 56) { doc.addPage(); y = 56; } }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(216, 48, 42);
  doc.text('CYPRESS IN-LINE INSPECTION', marginX, y);
  doc.setTextColor(20, 20, 20);
  y += 16;

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
  } catch (e) { alert('Could not save the PDF in this view.'); }
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

var exportBtn = document.getElementById('exportPdfBtn');
exportBtn.addEventListener('click', async function () {
  exportBtn.disabled = true;
  var original = exportBtn.textContent;
  exportBtn.textContent = 'Building PDF…';
  try {
    var blob = buildPdfBlob();
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

async function init() {
  state = await loadState();
  render();
}

init();
