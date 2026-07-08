"""Proxima — Universal Web Extraction.
Site-agnostic structured data and readability extraction engine injected via CDP.
"""

EXTRACTOR_JS = r"""
(function () {
  if (window.__proximaExtract && window.__proximaExtract.__v >= 1) return;

  var NL = '\n';
  var FENCE = '```';

  function isHidden(el) {
    if (!el || el.nodeType !== 1) return true;
    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    if (parseFloat(cs.opacity || '1') === 0) return true;
    return false;
  }

  var NOISE_TAGS = { SCRIPT:1, STYLE:1, NOSCRIPT:1, SVG:1, NAV:1, HEADER:1,
                     FOOTER:1, ASIDE:1, IFRAME:1, TEMPLATE:1 };
  var NOISE_RE = /(^|[-_ ])(nav|menu|sidebar|footer|header|cookie|consent|banner|advert|ads?|promo|popup|modal|subscribe|newsletter|breadcrumb|pagination|social|share|related|recommend|comment)([-_ ]|$)/i;

  function looksLikeNoise(el) {
    if (NOISE_TAGS[el.tagName]) return true;
    var id = (el.id || '') + ' ' + (el.className && el.className.toString ? el.className.toString() : '');
    if (NOISE_RE.test(id)) return true;
    var role = el.getAttribute && el.getAttribute('role');
    if (role && /(navigation|banner|complementary|contentinfo|search)/i.test(role)) return true;
    return false;
  }

  function getInputLabel(el) {
    var label = '';
    if (el.id) {
      var lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl) label = lbl.textContent.trim();
    }
    if (!label) {
      var parent = el.parentElement;
      while (parent) {
        if (parent.tagName === 'LABEL') {
          label = parent.textContent.trim();
          break;
        }
        parent = parent.parentElement;
      }
    }
    if (!label) label = el.placeholder || el.getAttribute('aria-label') || el.name || el.type || 'input';
    return label.trim().replace(/\s+/g, ' ');
  }

  function md(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    if (isHidden(node) || NOISE_TAGS[node.tagName]) return '';
    var tag = node.tagName.toLowerCase();
    var ch = '';
    for (var i = 0; i < node.childNodes.length; i++) ch += md(node.childNodes[i]);
    if (tag === 'pre') {
      var codeEl = node.querySelector('code');
      var lang = '';
      if (codeEl) { var m = (codeEl.className || '').match(/language-(\w+)/); if (m) lang = m[1]; ch = codeEl.innerText; }
      return NL + NL + FENCE + lang + NL + ch.trim() + NL + FENCE + NL + NL;
    }
    if (tag === 'code' && node.parentElement && node.parentElement.tagName !== 'PRE') return '`' + ch + '`';
    if (tag === 'strong' || tag === 'b') return '**' + ch.trim() + '**';
    if (tag === 'em' || tag === 'i') return '*' + ch.trim() + '*';
    if (tag === 'h1') return NL + NL + '# ' + ch.trim() + NL + NL;
    if (tag === 'h2') return NL + NL + '## ' + ch.trim() + NL + NL;
    if (tag === 'h3') return NL + NL + '### ' + ch.trim() + NL + NL;
    if (tag === 'h4' || tag === 'h5' || tag === 'h6') return NL + NL + '#### ' + ch.trim() + NL + NL;
    if (tag === 'p') return NL + NL + ch.trim() + NL + NL;
    if (tag === 'br') return NL;
    if (tag === 'li') {
      var p = node.parentElement;
      if (p && p.tagName === 'OL') {
        var idx = Array.prototype.indexOf.call(p.children, node) + 1;
        return idx + '. ' + ch.trim() + NL;
      }
      return '- ' + ch.trim() + NL;
    }
    if (tag === 'ul' || tag === 'ol') return NL + ch + NL;
    if (tag === 'button') {
      var lbl = node.textContent || node.value || node.getAttribute('aria-label') || node.name || 'button';
      return ' [Button: ' + lbl.trim().replace(/\s+/g, ' ') + '] ';
    }
    if (tag === 'input') {
      var type = (node.type || '').toLowerCase();
      if (type === 'checkbox') {
        return ' [Checkbox: ' + getInputLabel(node) + ' = ' + (node.checked ? 'checked' : 'unchecked') + '] ';
      }
      if (type === 'radio') {
        return ' [Radio: ' + getInputLabel(node) + ' = ' + (node.checked ? 'selected' : 'unselected') + '] ';
      }
      if (type === 'button' || type === 'submit') {
        var lbl = node.value || node.getAttribute('aria-label') || node.name || 'button';
        return ' [Button: ' + lbl.trim().replace(/\s+/g, ' ') + '] ';
      }
      if (type === 'hidden') return '';
      var val = node.value || '';
      var lbl = getInputLabel(node);
      return ' [Input: ' + lbl + (val ? ': ' + val : '') + '] ';
    }
    if (tag === 'textarea') {
      var val = node.value || '';
      var lbl = getInputLabel(node);
      return '\n[Textarea: ' + lbl + (val ? ': ' + val : '') + ']\n';
    }
    if (tag === 'select') {
      var opt = node.options[node.selectedIndex];
      var val = opt ? opt.text : '';
      var lbl = getInputLabel(node);
      return ' [Dropdown: ' + lbl + ' = ' + (val || '...') + '] ';
    }
    if (tag === 'a') {
      var txt = ch.trim();
      var href = node.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || /^(javascript:|data:)/i.test(href)) {
        return txt;
      }
      var abs = node.href || href;
      if (!txt) return '[' + abs + '](' + abs + ')';
      return '[' + txt + '](' + abs + ')';
    }
    if (tag === 'blockquote') return NL + '> ' + ch.trim().split(NL).join(NL + '> ') + NL;
    if (tag === 'table') {
      var rows = node.querySelectorAll('tr'), out = NL;
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('th, td'), line = '|';
        for (var c = 0; c < cells.length; c++) line += ' ' + cells[c].textContent.trim().replace(/\s+/g,' ') + ' |';
        out += line + NL;
        if (r === 0) { var sep = '|'; for (var c2 = 0; c2 < cells.length; c2++) sep += ' --- |'; out += sep + NL; }
      }
      return out + NL;
    }
    return ch;
  }

  function clean(s) {
    while (s.indexOf(NL + NL + NL) !== -1) s = s.split(NL + NL + NL).join(NL + NL);
    return s.replace(/[ \t]+\n/g, '\n').trim();
  }

  function textLen(el) {
    try { return (el.innerText || '').replace(/\s+/g, ' ').trim().length; } catch (e) { return 0; }
  }

  function pickMain() {
    var cands = [];
    ['main', 'article', '[role="main"]'].forEach(function (sel) {
      try { Array.prototype.push.apply(cands, document.querySelectorAll(sel)); } catch (e) {}
    });
    if (!cands.length) {
      var blocks = document.querySelectorAll('div, section');
      var best = null, bestScore = 0;
      for (var i = 0; i < blocks.length && i < 4000; i++) {
        var b = blocks[i];
        if (isHidden(b) || looksLikeNoise(b)) continue;
        var tl = textLen(b);
        if (tl < 200) continue;
        var links = b.querySelectorAll('a').length;
        var linkText = 0, la = b.querySelectorAll('a');
        for (var k = 0; k < la.length; k++) linkText += textLen(la[k]);
        var linkRatio = tl > 0 ? linkText / tl : 1;
        var paras = b.querySelectorAll('p').length;
        var score = tl * (1 - linkRatio) + paras * 30 - links * 5;
        if (score > bestScore) { bestScore = score; best = b; }
      }
      if (best) cands = [best];
    }
    if (!cands.length) cands = [document.body];
    var chosen = cands[0], cl = textLen(cands[0]);
    for (var j = 1; j < cands.length; j++) { var t = textLen(cands[j]); if (t > cl) { cl = t; chosen = cands[j]; } }
    return chosen;
  }

  function content(maxChars) {
    maxChars = maxChars || 20000;
    var main = pickMain();
    var out = clean(md(main));
    if (out.length < 40) out = (document.body.innerText || '').trim();
    if (out.length > maxChars) out = out.slice(0, maxChars) + '\n... [truncated]';
    return {
      title: (document.title || '').trim(),
      url: location.href,
      content: out,
      chars: out.length
    };
  }

  function recordFromEl(el) {
    var text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    var rec = { text: text.slice(0, 400) };
    var h = el.querySelector('h1,h2,h3,h4,[role="heading"]');
    if (h && h.innerText.trim()) rec.title = h.innerText.trim().slice(0, 200);
    else {
      var a0 = el.querySelector('a');
      if (a0 && a0.innerText.trim()) rec.title = a0.innerText.trim().slice(0, 200);
    }
    var a = el.querySelector('a[href]');
    if (a) { try { rec.url = a.href; } catch (e) {} }
    var img = el.querySelector('img[src]');
    if (img) { try { rec.image = img.src; } catch (e) {} }
    return rec;
  }

  function records(limit) {
    limit = limit || 60;

    var tables = document.querySelectorAll('table');
    for (var t = 0; t < tables.length; t++) {
      var tbl = tables[t];
      if (isHidden(tbl)) continue;
      var trs = tbl.querySelectorAll('tr');
      if (trs.length < 3) continue;
      var headers = [];
      var ths = trs[0].querySelectorAll('th');
      for (var hi = 0; hi < ths.length; hi++) headers.push(ths[hi].textContent.trim());
      var rows = [];
      for (var ri = (ths.length ? 1 : 0); ri < trs.length && rows.length < limit; ri++) {
        var tds = trs[ri].querySelectorAll('td');
        if (!tds.length) continue;
        var row = {};
        for (var ci = 0; ci < tds.length; ci++) {
          var key = headers[ci] || ('col' + (ci + 1));
          row[key] = tds[ci].textContent.trim().replace(/\s+/g, ' ');
        }
        rows.push(row);
      }
      if (rows.length >= 3) return { kind: 'table', count: rows.length, records: rows };
    }

    var containers = document.querySelectorAll('ul, ol, div, section, main, tbody');
    var best = null, bestScore = 0;
    for (var i = 0; i < containers.length && i < 5000; i++) {
      var cont = containers[i];
      if (isHidden(cont) || looksLikeNoise(cont)) continue;
      var kids = cont.children;
      if (!kids || kids.length < 4) continue;
      var sig = {};
      for (var k = 0; k < kids.length; k++) {
        var kid = kids[k];
        if (kid.nodeType !== 1) continue;
        var cls = (kid.className && kid.className.toString) ? kid.className.toString().split(/\s+/).slice(0, 2).join('.') : '';
        var s = kid.tagName + '|' + cls;
        sig[s] = (sig[s] || 0) + 1;
      }
      var topKey = null, topCount = 0;
      for (var key in sig) if (sig[key] > topCount) { topCount = sig[key]; topKey = key; }
      if (topCount < 4) continue;
      var sampleText = 0, sampled = 0;
      for (var k2 = 0; k2 < kids.length && sampled < 5; k2++) {
        var kk = kids[k2];
        if (kk.nodeType !== 1) continue;
        var clsk = (kk.className && kk.className.toString) ? kk.className.toString().split(/\s+/).slice(0, 2).join('.') : '';
        if (kk.tagName + '|' + clsk !== topKey) continue;
        sampleText += textLen(kk); sampled++;
      }
      var avgText = sampled ? sampleText / sampled : 0;
      if (avgText < 8) continue;
      var score = topCount * Math.min(avgText, 300);
      if (score > bestScore) { bestScore = score; best = { cont: cont, key: topKey, count: topCount }; }
    }

    if (best) {
      var recs = [];
      var children = best.cont.children;
      for (var c = 0; c < children.length && recs.length < limit; c++) {
        var kid2 = children[c];
        if (kid2.nodeType !== 1 || isHidden(kid2)) continue;
        var clsc = (kid2.className && kid2.className.toString) ? kid2.className.toString().split(/\s+/).slice(0, 2).join('.') : '';
        if (kid2.tagName + '|' + clsc !== best.key) continue;
        var rec = recordFromEl(kid2);
        if (rec && rec.text) recs.push(rec);
      }
      if (recs.length >= 3) return { kind: 'list', count: recs.length, records: recs };
    }

    var c = content(20000);
    return { kind: 'text', count: 0, content: c.content, records: [] };
  }

  window.__proximaExtract = { __v: 1, content: content, records: records };
})();
"""
