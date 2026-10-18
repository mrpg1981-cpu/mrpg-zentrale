// Kleiner, sicherer Markdown-Renderer für KI-Antworten (Codeblöcke, Überschriften, Listen, fett/kursiv, Links)
window.renderMarkdown = function (src) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const out = [];
  const parts = String(src).split(/^```/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const lang = nl > -1 ? part.slice(0, nl).trim() : '';
      const code = nl > -1 ? part.slice(nl + 1) : part;
      out.push(`<div class="md-code"><div class="md-code-head"><span>${esc(lang)}</span><button class="btn sm md-copy">Kopieren</button></div><pre><code>${esc(code.replace(/\n$/, ''))}</code></pre></div>`);
      return;
    }
    let list = null;
    const flush = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of part.split('\n')) {
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flush(); out.push(`<h${m[1].length + 2} class="md-h">${inline(m[2])}</h${m[1].length + 2}>`); }
      else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { flush(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { flush(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (!line.trim()) { flush(); out.push('<div class="md-gap"></div>'); }
      else { flush(); out.push(`<div>${inline(line)}</div>`); }
    }
    flush();
  });
  return out.join('');
};

// Kopieren-Knöpfe in Codeblöcken
document.addEventListener('click', (e) => {
  const b = e.target.closest('.md-copy');
  if (!b) return;
  const code = b.closest('.md-code').querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(() => { b.textContent = '✓'; setTimeout(() => (b.textContent = 'Kopieren'), 1200); });
});

document.head.insertAdjacentHTML('beforeend', `<style>
  .md ul, .md ol { margin: 4px 0; padding-left: 22px; }
  .md .md-gap { height: 8px; }
  .md .md-h { margin: 10px 0 4px; color: var(--cyan); font-size: 14px; }
  .md-code { margin: 8px 0; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .md-code-head { display: flex; justify-content: space-between; align-items: center; padding: 3px 8px; background: var(--panel); font: 11px var(--mono); color: var(--muted); }
  .md-code pre { margin: 0; padding: 10px 12px; overflow: auto; background: var(--bg-term); color: #d6dde6; font: 12.5px/1.5 var(--mono); }
  .md-code code { background: none; padding: 0; }
</style>`);
