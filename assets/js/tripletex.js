/* assets/js/tripletex.js */
document.addEventListener('DOMContentLoaded', async () => {
  const el = document.getElementById('beer-sales');
  if (!el) return;
  try {
    const url = new URL('/.netlify/functions/tripletex', location.origin);
    // Optional custom range:
    // url.searchParams.set('from','2025-01-01');
    // url.searchParams.set('to','2025-12-31');

    const res = await fetch(url.href);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || JSON.stringify(data));
    const total = Number(data.totalBeerSales || 0);
    el.textContent = `${total.toFixed(2)} NOK`;
  } catch (e) {
    el.textContent = `Error: ${e.message}`;
    console.error('Tripletex fetch error:', e);
  }
});
