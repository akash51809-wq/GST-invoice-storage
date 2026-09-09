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
  if (!pages.length) return [{ page: 1, text: '' }];
  return pages.map((text, index) => ({ page: index + 1, text: clean(text) }));
}

function extractPdfOperators(content) {
  const out = [];
  const literal = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  let match;
  while ((match = literal.exec(content))) {
    const token = match[0].replace(/\)\s*Tj$/, '').replace(/^\(/, '');
    out.push(decodePdfLiteral(token));
  }
  const arrays = /\[(.*?)\]\s*TJ/gs;
  while ((match = arrays.exec(content))) {
    const parts = match[1].match(/\((?:\\.|[^\\)])*\)|<[^>]*>/g) || [];
    out.push(parts.map((part) => part.startsWith('<') ? decodePdfHex(part) : decodePdfLiteral(part.slice(1, -1))).join(''));
  }
  return out.join(' ');
}

function decodePdfLiteral(value) {
  return value.replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ').replace(/\\([\\()])/g, '$1').replace(/\\[0-7]{1,3}/g, ' ');
}
function decodePdfHex(value) {
  const hex = value.slice(1, -1).replace(/[^0-9a-f]/gi, '');
  const padded = hex.length % 2 ? `${hex}0` : hex;
  try { return Buffer.from(padded, 'hex').toString('utf8'); } catch (_) { return ''; }
}

function extractTextPages(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'application/pdf' || /\.pdf$/i.test(file.originalname)) return extractPdfText(file.buffer);
  return [{ page: 1, text: '' }];
}

function signatureFromText(text) {
  const normalized = clean(text).toLowerCase()
    .replace(/\b\d{1,4}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' DATE ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' NUM ')
    .replace(/\s+/g, ' ').trim();
  return normalized.split(' ').filter(Boolean).slice(0, 80).join(' ').slice(0, 900);
}

function findInvoiceNumbers(pages, sourceText) {
  const all = pages.map((page) => page.text).join('\n');
  const candidates = [];
  const patterns = [
    /(?:invoice\s*(?:no|number|#)|inv\.?\s*(?:no|number|#))\s*[:\-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})/ig,
    /(?:tax\s*invoice)\s*[:\-]?\s*([A-Z0-9][A-Z0-9./_-]{2,})/ig,
  ];
  for (const pattern of patterns) { let match; while ((match = pattern.exec(all))) candidates.push(clean(match[1])); }
  if (candidates.length) return [...new Set(candidates)];
  const fallback = clean(sourceText).match(/\b[A-Z]{1,6}[-/][A-Z0-9-]{3,}\b/i);
  return fallback ? [fallback[0]] : [];
}

function locateValue(text, rule) {
  if (!rule) return '';
  const label = clean(rule.label || rule.sourceLabel || '');
  if (!label) return '';
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}\\s*[:#-]?\\s*([^\\n|]{1,180})`, 'i');
  const match = text.match(pattern);
  return match ? clean(match[1]) : '';
}

function autoExtract(text, mapping) {
  const values = {};
  for (const field of INVOICE_FIELDS) values[field.key] = locateValue(text, mapping?.fields?.[field.key]);
  const fallbackPatterns = {
    invoiceNumber: /(?:invoice\s*(?:no|number|#)|inv\.?\s*(?:no|number|#))\s*[:#-]?\s*([A-Z0-9./_-]{3,})/i,
    invoiceDate: /(?:invoice\s*date|date)\s*[:#-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    sellerGSTIN: /(?:seller\s*)?(?:gstin|gst\s*no)\s*[:#-]?\s*([0-9A-Z]{15})/i,
    buyerGSTIN: /(?:buyer\s*)?(?:gstin|gst\s*no)\s*[:#-]?\s*([0-9A-Z]{15})/i,
    grandTotal: /(?:grand\s*total|invoice\s*total|total\s*amount|net\s*amount)\s*[:#-]?\s*[₹$]?\s*([0-9,]+(?:\.\d{1,2})?)/i,
  };
  for (const [key, pattern] of Object.entries(fallbackPatterns)) if (!values[key]) values[key] = clean(text.match(pattern)?.[1] || '');
  return values;
}

function classifyInvoice(values) {
  const buyer = normalize(values.buyerName);
  const seller = normalize(values.sellerName);
  const company = normalize('EASY RECHARGE SOLUTION');
  if (buyer && buyer.includes(company)) return 'buy';
  if (seller && seller.includes(company)) return 'sell';
  return 'review';
}

function mergeValues(target, source) {
  for (const field of INVOICE_FIELDS) if (!clean(target[field.key]) && clean(source[field.key])) target[field.key] = source[field.key];
  return target;
}

function processInvoice(file, mapping = null) {
  const pages = extractTextPages(file);
  const text = pages.map((page) => page.text).join('\n');
  const signature = signatureFromText(text || file.originalname);
  const invoiceNumbers = findInvoiceNumbers(pages, text);
  if (!mapping) return { mode: 'mapping-required', signature, pages, invoiceNumbers, values: autoExtract(text, null), fields: INVOICE_FIELDS };

  const groups = new Map();
  pages.forEach((page) => {
    const values = autoExtract(page.text, mapping);
    const number = values.invoiceNumber || invoiceNumbers[0] || `PAGE-${page.page}`;
    const current = groups.get(number) || { ...values, pages: [] };
    mergeValues(current, values);
    current.pages.push(page.page);
    groups.set(number, current);
  });
  if (!groups.size) groups.set(invoiceNumbers[0] || 'UNKNOWN', autoExtract(text, mapping));
  const invoices = [...groups.entries()].map(([invoiceNumber, values]) => ({ ...values, invoiceNumber, classification: classifyInvoice(values), sourcePages: values.pages || pages.map((page) => page.page) }));
  return { mode: 'auto', signature, pages, invoices, fields: INVOICE_FIELDS };
}

module.exports = { INVOICE_FIELDS, clean, normalize, signatureFromText, processInvoice, autoExtract, classifyInvoice, mergeValues };
