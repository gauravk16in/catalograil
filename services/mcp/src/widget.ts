/**
 * The interactive surface: an HTML widget an assistant renders instead of reciting prose.
 *
 * A tool that returns only a text block leaves the model to describe what it read, and a
 * description of a product is a worse thing than the product — no image, no price the buyer
 * can act on, nothing to click. The catalogue already carries `image_url` and `product_url`;
 * this gives them somewhere to go.
 *
 * Two clients, one renderer:
 *
 * - **ChatGPT (Apps SDK)** reads a *static* template resource named by the tool's
 *   `openai/outputTemplate` meta, then hands it the tool's `structuredContent` on
 *   `window.openai.toolOutput`.
 * - **MCP-UI clients** get the HTML *with the data already in it*, embedded in the tool
 *   result as a `resource` content block.
 *
 * So `renderWidget` takes the data or `null` and the difference is one `<script>` tag.
 * A client that supports neither still gets the full JSON text block, which is why every
 * tool returns both — the widget is an enhancement, never the only copy of a fact.
 */

export const PRODUCT_WIDGET_URI = 'ui://widget/products.html';

export interface WidgetResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export function widgetResources(): WidgetResource[] {
  return [
    {
      uri: PRODUCT_WIDGET_URI,
      name: 'Product results',
      description:
        'Renders search results and product detail as cards with image, live price, stock, ' +
        'delivery estimate and a buy action.',
      mimeType: 'text/html+skybridge',
    },
  ];
}

/**
 * The widget itself.
 *
 * Written as one self-contained document with no external requests beyond the product
 * images: a widget iframe is a hostile environment for a CDN — offline, sandboxed, or behind
 * a policy that blocks it — and a card that renders as a blank rectangle is worse than text.
 */
export function renderWidget(data: unknown | null): string {
  const inlined =
    data === null
      ? ''
      : `<script id="seed" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    color-scheme: light dark;
    --bg: transparent;
    --card: #ffffff;
    --ink: #16161a;
    --muted: #6b6b76;
    --line: #e6e6ec;
    --accent: #1a1a1f;
    --accent-ink: #ffffff;
    --ok: #0f7b4f;
    --warn: #a1451b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --card: #1b1b20;
      --ink: #f2f2f5;
      --muted: #9a9aa6;
      --line: #2e2e36;
      --accent: #f2f2f5;
      --accent-ink: #16161a;
      --ok: #4ade80;
      --warn: #fbbf24;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.45 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  .card {
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  }
  .shot { aspect-ratio: 4 / 3; background: var(--line); position: relative; }
  .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
  /* A missing image must not collapse the card into a differently-shaped one. */
  .shot .none {
    position: absolute; inset: 0; display: grid; place-items: center;
    color: var(--muted); font-size: 12px; letter-spacing: .04em; text-transform: uppercase;
  }
  .body { padding: 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .name { font-weight: 600; line-height: 1.3; }
  .brand { color: var(--muted); font-size: 12px; }
  .price { font-size: 18px; font-weight: 650; letter-spacing: -.01em; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag {
    font-size: 11px; padding: 2px 7px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
  }
  .tag.ok { color: var(--ok); border-color: currentColor; }
  .tag.warn { color: var(--warn); border-color: currentColor; }
  .why { color: var(--muted); font-size: 12px; }
  .foot { margin-top: auto; display: flex; gap: 8px; align-items: center; padding-top: 4px; }
  button.buy {
    flex: 1; cursor: pointer; font: inherit; font-weight: 600;
    background: var(--accent); color: var(--accent-ink);
    border: 0; border-radius: 9px; padding: 9px 12px;
  }
  button.buy:disabled { opacity: .5; cursor: default; }
  a.open { color: var(--muted); font-size: 12px; text-decoration: none; border-bottom: 1px solid var(--line); }
  .asof { color: var(--muted); font-size: 11px; margin-top: 10px; }
  .empty { padding: 16px; border: 1px dashed var(--line); border-radius: 12px; color: var(--muted); }
</style>
<div id="root"></div>
${inlined}
<script>
(function () {
  var root = document.getElementById('root');

  function payload() {
    var seed = document.getElementById('seed');
    if (seed) { try { return JSON.parse(seed.textContent); } catch (e) {} }
    // ChatGPT hands the tool's structuredContent over on this global.
    var api = window.openai;
    if (api && api.toolOutput) return api.toolOutput;
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /**
   * Buying, in order of what the host actually supports: ask the assistant to call the
   * checkout tool, fall back to the MCP-UI intent message, fall back to opening the page.
   * A card whose button silently does nothing is the worst of the three.
   */
  function buy(item, button) {
    var args = { product_id: item.product_id, variant_id: item.id };
    var api = window.openai;
    if (api && typeof api.callTool === 'function') {
      button.disabled = true;
      button.textContent = 'Starting checkout…';
      api.callTool('create_checkout', args).catch(function () {
        button.disabled = false;
        button.textContent = 'Buy';
      });
      return;
    }
    if (window.parent !== window) {
      window.parent.postMessage(
        { type: 'tool', payload: { toolName: 'create_checkout', params: args } },
        '*'
      );
      button.textContent = 'Starting checkout…';
      return;
    }
    if (item.product_url) window.open(item.product_url, '_blank', 'noopener');
  }

  function card(item) {
    var el = document.createElement('div');
    el.className = 'card';

    var stock = String(item.availability || '').toLowerCase();
    var out = stock.indexOf('out') === 0 || stock.indexOf('unavailable') === 0;
    var trust = (item.merchant && item.merchant.trust) || {};

    el.innerHTML =
      '<div class="shot">' +
        (item.image_url
          ? '<img loading="lazy" alt="" src="' + esc(item.image_url) + '" ' +
            'onerror="this.remove()">'
          : '') +
        '<div class="none">no image</div>' +
      '</div>' +
      '<div class="body">' +
        '<div>' +
          '<div class="name">' + esc(item.name) + '</div>' +
          (item.brand ? '<div class="brand">' + esc(item.brand) + '</div>' : '') +
        '</div>' +
        '<div class="price">' + esc(item.display_price || 'Price on request') + '</div>' +
        '<div class="row">' +
          '<span class="tag ' + (out ? 'warn' : 'ok') + '">' + esc(item.availability || 'unknown') + '</span>' +
          (item.delivery_estimate ? '<span class="tag">' + esc(item.delivery_estimate) + '</span>' : '') +
          (item.merchant ? '<span class="tag">' + esc(item.merchant.name) +
            (trust.new_merchant ? ' · new' : '') + '</span>' : '') +
        '</div>' +
        (item.why_this_matched ? '<div class="why">' + esc(item.why_this_matched) + '</div>' : '') +
        '<div class="foot">' +
          '<button class="buy"' + (out ? ' disabled' : '') + '>' + (out ? 'Out of stock' : 'Buy') + '</button>' +
          (item.product_url ? '<a class="open" target="_blank" rel="noopener" href="' +
            esc(item.product_url) + '">Details</a>' : '') +
        '</div>' +
      '</div>';

    var button = el.querySelector('button.buy');
    if (!out) button.addEventListener('click', function () { buy(item, button); });
    return el;
  }

  function render() {
    var data = payload();
    root.textContent = '';
    if (!data) return;

    var items = data.results || data.items || (data.product ? [data.product] : []);
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      // Rule 8: the server's own sentence, not one composed here.
      empty.textContent = data.no_results_reason || 'Nothing matched.';
      root.appendChild(empty);
      return;
    }

    var grid = document.createElement('div');
    grid.className = 'grid';
    items.forEach(function (item) { grid.appendChild(card(item)); });
    root.appendChild(grid);

    // Rule 7: no price on screen without the moment it was true.
    if (items[0] && items[0].price_as_of) {
      var asof = document.createElement('div');
      asof.className = 'asof';
      asof.textContent = 'Prices and stock as of ' + items[0].price_as_of;
      root.appendChild(asof);
    }
  }

  render();
  // ChatGPT re-renders the same iframe when the tool is called again.
  window.addEventListener('openai:set_globals', render);
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (d && d.type === 'ui-lifecycle-iframe-render-data' && d.payload) {
      var seed = document.getElementById('seed');
      if (seed) seed.textContent = JSON.stringify(d.payload.renderData || d.payload);
      render();
    }
  });
})();
</script>`;
}
