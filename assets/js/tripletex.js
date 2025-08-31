document.addEventListener('DOMContentLoaded', async () => {
  const el = document.getElementById('beer-sales');
  if (!el) return;
  try {
    const res = await fetch('/.netlify/functions/tripletex?from=2025-01-01&to=2025-12-31');
    if (!res.ok) throw new Error('Request failed');
    const data = await res.json();
    const total = Number(data.totalBeerSales) || 0;
    el.textContent = `${total.toFixed(2)} NOK`;
  } catch (e) {
    el.textContent = 'Error fetching beer sales';
  }
});
