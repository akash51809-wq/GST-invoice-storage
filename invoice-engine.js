const zlib = require('node:zlib');

const INVOICE_FIELDS = [
  { key: 'invoiceNumber', label: 'Invoice Number', required: true },
  { key: 'invoiceDate', label: 'Invoice Date', required: true },
  { key: 'sellerName', label: 'Seller Name', required: true },
  { key: 'sellerGSTIN', label: 'Seller GSTIN', required: false },
  { key: 'sellerAddress', label: 'Seller Address', required: false },
  { key: 'buyerName', label: 'Buyer Name', required: true },
  { key: 'buyerGSTIN', label: 'Buyer GSTIN', required: false },
  { key: 'buyerAddress', label: 'Buyer Address', required: false },
  { key: 'placeOfSupply', label: 'Place of Supply', required: false },
  { key: 'taxableAmount', label: 'Taxable Amount', required: false },
  { key: 'cgst', label: 'CGST', required: false },
  { key: 'sgst', label: 'SGST', required: false },
  { key: 'igst', label: 'IGST', required: false },
  { key: 'totalTax', label: 'Total Tax', required: false },
  { key: 'grandTotal', label: 'Grand Total', required: true },
];

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function normalize(value) { return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function extractPdfText(buffer) {
  const source = Buffer.from(buffer);
  const pages = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRe.exec(source.toString('latin1')))) {
    let data = Buffer.from(match[1], 'latin1');
    try { data = zlib.inflateSync(data); } catch (_) { try { data = zlib.inflateRawSync(data); } catch (_) {} }
    const text = extractPdfOperators(data.toString('latin1'));
    if (text) pages.push(text);
  }
  return pages.length ? pages.map((text, i) => ({ page: i + 1, text: clean(text) })) : [{ page: 1, text: '' }];
}

function extractPdfOperators(content) {
  const out = [];
  let match;
  const literal = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  while ((match = literal.exec(content))) out.push(decodePdfLiteral(match[0].replace(/\)\s*Tj$/, '').replace(/^\(/, '')));
  const arrays = /\[(.*?)\]\s*TJ/gs;
  while ((match = arrays.exec(content))) {
    const parts = match[1].match(/\((?:\\.|[^\\)])*\)|<[^>]*>/g) || [];
    out.push(parts.map((part) => part.startsWith('<') ? decodePdfHex(part) : decodePdfLiteral(part.slice(1, -1))).join(''));
  }
  return out.join(' ');
}
function decodePdfLiteral(value) { return value.replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ').replace(/\\([\\()])/g, '$1').replace(/\\[0-7]{1,3}/g, ' '); }
function decodePdfHex(value) { const hex = value.slice(1, -1).replace(/[^0-9a-f]/gi, ''); try { return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('utf8'); } catch (_) { return ''; } }

function extractTextPages(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'application/pdf' || /\.pdf$/i.test(file.originalname)) return extractPdfText(file.buffer);
  return [{ page: 1, text: '' }];
}

const RULES = {
  invoiceNumber: [/(?:invoice\s*(?:no|number|#)|inv\.?\s*(?:no|number|#)|tax\s*invoice)\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})/i],
  invoiceDate: [/(?:invoice\s*date|date\s*of\s*invoice)\s*[:#-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/i],
  sellerGSTIN: [/(?:seller\s*)?(?:gstin|gst\s*(?:no|number))\s*[:#-]?\s*([0-9A-Z]{15})/i],
  buyerGSTIN: [/(?:buyer\s*)?(?:gstin|gst\s*(?:no|number))\s*[:#-]?\s*([0-9A-Z]{15})/i],
  taxableAmount: [/(?:taxable\s*(?:value|amount)|taxable\s*value)\s*[:#-]?\s*[₹$]?\s*([0-9,]+(?:\.\d{1,2})?)/i],
  cgst: [/(?:central\s*gst|cgst)\s*[:@#-]?\s*[₹$]?\s*([0-9,]+(?:\.\d{1,2})?)/i],
  sgst: [/(?:state\s*gst|sgst)\s*[:@#-]?\s*[₹$]?\s*([0-9,]+(?:\.\d{1,2})?)/i],
  igst: [/(?:integrated\s*gst|igst)\s*[:@#-]?\s*[₹$]?\s*([0-9,]+(?:\.\d{1,2})?)/i],
  totalTax: [/(?:total\s*(?:tax|gst)|tax\s*total)\s*[:#-]?\s*[₹$]?\s*([0-9,]+(?:\.\d{1,2})?)/i],
  grandTotal: [/(?:grand\s*total|invoice\s*total|total\s*(?:amount|payable)|net\s*amount)\s*[:#-]?\s*[₹$]?\s*([0-9,]+(?:\.\d{1,2})?)/i],
  placeOfSupply: [/(?:place\s*of\s*supply|pos)\s*[:#-]?\s*([^\n|]{2,80})/i],
  sellerName: [/(?:seller|sold\s*by|from)\s*[:#-]?\s*([^\n|]{2,100})/i],
  buyerName: [/(?:buyer|billed\s*to|bill\s*to|customer)\s*[:#-]?\s*([^\n|]{2,100})/i],
  sellerAddress: [/(?:seller\s*)?address\s*[:#-]?\s*([^\n|]{5,180})/i],
  buyerAddress: [/(?:buyer\s*)?address\s*[:#-]?\s*([^\n|]{5,180})/i],
};

const LABELS = {
  invoiceNumber: 'Invoice No', invoiceDate: 'Invoice Date', sellerName: 'Seller', sellerGSTIN: 'Seller GSTIN', sellerAddress: 'Seller Address',
  buyerName: 'Buyer', buyerGSTIN: 'Buyer GSTIN', buyerAddress: 'Buyer Address', placeOfSupply: 'Place of Supply', taxableAmount: 'Taxable Amount',
  cgst: 'CGST', sgst: 'SGST', igst: 'IGST', totalTax: 'Total Tax', grandTotal: 'Grand Total'
};

function firstMatch(text, patterns) {
  for (const pattern of patterns || []) { const match = text.match(pattern); if (match?.[1]) return clean(match[1]); }
  return '';
}

function autoExtract(text, mapping = null) {
  const values = {};
  const sources = {};
  for (const field of INVOICE_FIELDS) {
    const saved = mapping?.fields?.[field.key];
    const savedValue = saved?.sourceLabel ? locateValue(text, saved.sourceLabel) : '';
    const patterns = RULES[field.key] || [];
    values[field.key] = savedValue || firstMatch(text, patterns);
    sources[field.key] = saved?.sourceLabel || (values[field.key] ? LABELS[field.key] : '');
  }
  // When seller/buyer are not explicitly labelled, use the first company-like lines around GSTINs.
  if (!values.sellerName) {
    const lines = text.split(/\n|\r/).map(clean).filter(Boolean);
    values.sellerName = lines.find((x) => !/invoice|tax|gstin|gst|address|date|bill|buyer|customer|amount|total/i.test(x) && x.length > 2 && x.length < 100) || '';
    if (values.sellerName) sources.sellerName = 'Auto detected company line';
  }
  return { values, sources };
}

function locateValue(text, label) {
  const source = clean(label);
  if (!source) return '';
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*[:#-]?\\s*([^\\n|]{1,180})`, 'i'));
  return match ? clean(match[1]) : '';
}

function findInvoiceNumbers(pages, sourceText) {
  const numbers = [];
  for (const page of pages) {
    const value = firstMatch(page.text, RULES.invoiceNumber);
    if (value) numbers.push(value);
  }
  if (numbers.length) return [...new Set(numbers)];
  const fallback = clean(sourceText).match(/\b[A-Z]{1,8}[-/][A-Z0-9-]{3,}\b/i);
  return fallback ? [fallback[0]] : [];
}

function formatFingerprint(text, values) {
  const sellerGSTIN = normalize(values.sellerGSTIN);
  const sellerName = normalize(values.sellerName);
  const stableLabels = ['invoice','invoice no','invoice number','invoice date','gstin','taxable value','taxable amount','cgst','sgst','igst','grand total','total amount','place of supply','billed to','bill to'];
  const found = stableLabels.filter((label) => normalize(text).includes(normalize(label))).map(normalize).sort().join('|');
  if (sellerGSTIN) return `v2|gstin:${sellerGSTIN}|labels:${found}`;
  if (sellerName) return `v2|seller:${sellerName}|labels:${found}`;
  return `v2|labels:${found}`;
}

function signatureFromText(text) {
  const probe = autoExtract(clean(text), null);
  return formatFingerprint(text, probe.values);
}

function classifyInvoice(values) {
  const buyer = normalize(values.buyerName), seller = normalize(values.sellerName), company = normalize('EASY RECHARGE SOLUTION');
  if (buyer && buyer.includes(company)) return 'buy';
  if (seller && seller.includes(company)) return 'sell';
  return 'review';
}
function mergeValues(target, source) { for (const field of INVOICE_FIELDS) if (!clean(target[field.key]) && clean(source[field.key])) target[field.key] = source[field.key]; return target; }

function processInvoice(file, mapping = null) {
  const pages = extractTextPages(file);
  const text = pages.map((page) => page.text).join('\n');
  const probe = autoExtract(text, null);
  const signature = formatFingerprint(text, probe.values);
  const invoiceNumbers = findInvoiceNumbers(pages, text);
  if (!mapping) {
    return { mode: 'mapping-required', signature, pages, invoiceNumbers, values: probe.values, sources: probe.sources, fields: INVOICE_FIELDS, suggestedMapping: { signature, fields: Object.fromEntries(INVOICE_FIELDS.map((field) => ({ [field.key]: { label: LABELS[field.key], sourceLabel: probe.sources[field.key] || LABELS[field.key], page: 1 } }))) } };
  }
  const groups = new Map();
  pages.forEach((page) => {
    const extracted = autoExtract(page.text, mapping);
    const pageNumber = extracted.values.invoiceNumber || invoiceNumbers.find((n) => page.text.includes(n)) || invoiceNumbers[0] || `PAGE-${page.page}`;
    const current = groups.get(pageNumber) || { ...extracted.values, pages: [] };
    mergeValues(current, extracted.values);
    current.pages.push(page.page);
    groups.set(pageNumber, current);
  });
  if (!groups.size) groups.set(invoiceNumbers[0] || 'UNKNOWN', probe.values);
  const invoices = [...groups.entries()].map(([invoiceNumber, values]) => ({ ...values, invoiceNumber, classification: classifyInvoice(values), sourcePages: values.pages || pages.map((page) => page.page) }));
  return { mode: 'auto', signature, pages, invoices, fields: INVOICE_FIELDS };
}

module.exports = { INVOICE_FIELDS, clean, normalize, signatureFromText, processInvoice, autoExtract, classifyInvoice, mergeValues, formatFingerprint };
