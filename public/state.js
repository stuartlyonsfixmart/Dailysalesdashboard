// Shared filter state across tabs, persisted in the URL query string.
// Fresh open (no params) => MTD. Changing the range updates the URL so the
// nav links to the other tab carry the same selection.
(function () {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function mtd() {
    const now = new Date();
    return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
  }
  function paramsOf(s) {
    const p = new URLSearchParams();
    p.set('from', s.from); p.set('to', s.to);
    if (s.rep && s.rep !== 'all') p.set('rep', s.rep);
    if (s.smooth) p.set('smooth', '1');
    return p;
  }
  window.FilterState = {
    mtd,
    get() {
      const p = new URLSearchParams(location.search);
      let from = p.get('from'), to = p.get('to');
      const rep = p.get('rep') || 'all';
      const smooth = p.get('smooth') === '1';
      if (!from || !to) { const m = mtd(); from = m.from; to = m.to; }
      return { from, to, rep, smooth };
    },
    set(partial) {
      const s = { ...window.FilterState.get(), ...partial };
      history.replaceState(null, '', location.pathname + '?' + paramsOf(s).toString());
      return s;
    },
    href(page) { return page + '?' + paramsOf(window.FilterState.get()).toString(); },
    isMTD() { const s = window.FilterState.get(), m = mtd(); return s.from === m.from && s.to === m.to; }
  };
})();
